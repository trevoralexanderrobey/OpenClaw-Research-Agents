"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { nowIso, nowMs } = require("../../openclaw-bridge/core/time-provider.js");
const { selectCandidates } = require("./candidate-selector.js");
const { buildDraftFromCandidate } = require("./rlhf-generator.js");
const { formatDraftMarkdown } = require("./formatting-engine.js");
const { lintDraft } = require("./compliance-linter.js");
const {
  canonicalize,
  RlhfDraftRecordSchema,
  RlhfCandidateQueueSchema,
  RlhfReviewQueueSchema,
  computeDraftContentHash,
  verifyDraftContentHash,
  sourceKeyFromPaper
} = require("./rlhf-schema.js");

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function maxCandidates(value) {
  if (!Number.isFinite(Number(value))) {
    return 20;
  }
  return Math.max(1, Math.min(200, Math.floor(Number(value))));
}

function assertApiGovernance(apiGovernance) {
  const required = ["loadResearchRecords", "readState", "withGovernanceTransaction"];
  for (const key of required) {
    if (!apiGovernance || typeof apiGovernance[key] !== "function") {
      const error = new Error(`apiGovernance missing required method '${key}'`);
      error.code = "RLHF_PIPELINE_CONFIG_INVALID";
      throw error;
    }
  }
}

function verifyExistingDraftReplay(state) {
  const workflows = state && state.rlhfWorkflows && typeof state.rlhfWorkflows === "object"
    ? state.rlhfWorkflows
    : { drafts: [] };
  const drafts = asArray(workflows.drafts);
  const seenSequences = new Set();
  const seenSourceKeys = new Set();

  for (const draft of drafts) {
    verifyDraftContentHash(draft);
    const sequence = Number(draft.sequence || 0);
    const sourceKey = sourceKeyFromPaper(draft.sourcePaperId, draft.sourceHash);
    if (seenSequences.has(sequence)) {
      const error = new Error(`Duplicate RLHF draft sequence detected: ${sequence}`);
      error.code = "RLHF_DRAFT_SEQUENCE_DUPLICATE";
      throw error;
    }
    if (seenSourceKeys.has(sourceKey)) {
      const error = new Error(`Duplicate RLHF draft source key detected: ${sourceKey}`);
      error.code = "RLHF_DRAFT_SOURCE_DUPLICATE";
      throw error;
    }
    seenSequences.add(sequence);
    seenSourceKeys.add(sourceKey);
  }
}

async function appendDraftArtifactStore(filePath, artifacts) {
  const records = asArray(artifacts);
  if (records.length === 0) {
    return { wrote: 0 };
  }
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(target, "utf8");
  } catch (error) {
    if (!(error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const lines = records
    .map((record) => JSON.stringify(canonicalize(record)))
    .join("\n");
  const payload = lines.length > 0 ? `${lines}\n` : "";
  const next = `${existing}${payload}`;
  await fs.writeFile(target, next, "utf8");
  return { wrote: records.length, path: target };
}

function createRlhfPipelineRunner(options = {}) {
  const apiGovernance = options.apiGovernance;
  const monetizationEngine = options.monetizationEngine;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function" && typeof options.timeProvider.nowMs === "function"
    ? options.timeProvider
    : { nowIso, nowMs };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();
  const generatorVersion = safeString(options.generatorVersion) || "v1";
  const draftArtifactPath = path.resolve(
    options.draftArtifactPath || path.join(process.cwd(), "workspace", "memory", "rlhf-drafts.ndjson")
  );

  assertApiGovernance(apiGovernance);

  async function run(input = {}) {
    const correlationId = safeString(input.correlationId);
    const domainAllowlist = asArray(input.domainAllowlist).map((item) => String(item || "").trim()).filter(Boolean);
    const candidateLimit = maxCandidates(input.maxCandidates);

    const records = await apiGovernance.loadResearchRecords();
    const snapshot = await apiGovernance.readState();
    verifyExistingDraftReplay(snapshot);

    const monetizationSnapshot = monetizationEngine && typeof monetizationEngine.computeMonetizationScore === "function"
      ? await monetizationEngine.computeMonetizationScore({})
      : { ok: true, score: 0, metrics: {} };

    const selectedCandidates = selectCandidates({
      records,
      existingDrafts: snapshot.rlhfWorkflows && Array.isArray(snapshot.rlhfWorkflows.drafts) ? snapshot.rlhfWorkflows.drafts : [],
      domainAllowlist,
      monetizationSnapshot,
      limit: candidateLimit
    });

    const prepared = selectedCandidates.map((candidate) => {
      const draftPayload = buildDraftFromCandidate(candidate, {
        timeProvider,
        generatorVersion
      });
      const markdown = formatDraftMarkdown(draftPayload, { templateVersion: "v1" });
      return {
        candidate,
        draftPayload,
        markdown
      };
    });

    const runResult = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      const workflows = state.rlhfWorkflows;
      const drafts = asArray(workflows.drafts);
      const existingSourceKeys = new Set(drafts.map((draft) => sourceKeyFromPaper(draft.sourcePaperId, draft.sourceHash)));

      const persistedDrafts = [];
      const artifacts = [];
      const queueRecords = [];
      const lintFailures = [];

      for (const entry of prepared) {
        const sourceKey = sourceKeyFromPaper(entry.candidate.sourcePaperId, entry.candidate.sourceHash);
        if (existingSourceKeys.has(sourceKey)) {
          continue;
        }

        workflows.nextQueueSequence += 1;
        const queueSequence = Number(workflows.nextQueueSequence);

        const queueRecord = RlhfCandidateQueueSchema.parse({
          queueSequence,
          sourcePaperId: entry.candidate.sourcePaperId,
          sourceHash: entry.candidate.sourceHash,
          domainTag: entry.candidate.domainTag,
          complexityScore: entry.candidate.complexityScore,
          monetizationScore: entry.candidate.monetizationScore,
          rankingScore: entry.candidate.rankingScore,
          enqueuedAt: entry.draftPayload.generatedAt,
          status: "queued",
          draftSequence: null
        });

        workflows.nextDraftSequence += 1;
        const draftSequence = Number(workflows.nextDraftSequence);

        const draftWithoutHash = {
          sequence: draftSequence,
          sourcePaperId: entry.candidate.sourcePaperId,
          sourceHash: entry.candidate.sourceHash,
          domainTag: entry.candidate.domainTag,
          complexityScore: entry.candidate.complexityScore,
          monetizationScore: entry.candidate.monetizationScore,
          generatedAt: entry.draftPayload.generatedAt,
          generatorVersion,
          status: "draft",
          aiAssisted: true,
          reviewedBy: null,
          reviewedAt: null,
          notes: "",
          manualSubmissionRequired: true
        };

        const contentHash = computeDraftContentHash(draftWithoutHash);
        const draftRecord = RlhfDraftRecordSchema.parse({
          ...draftWithoutHash,
          contentHash
        });

        const lint = lintDraft({
          markdown: entry.markdown,
          draftRecord,
          payload: entry.draftPayload,
          templateVersion: "v1"
        });

        if (!lint.ok) {
          queueRecord.status = "lint_rejected";
          queueRecord.draftSequence = null;
          workflows.candidateQueue.push(queueRecord);
          queueRecords.push(queueRecord);
          lintFailures.push({
            sourcePaperId: draftRecord.sourcePaperId,
            sourceHash: draftRecord.sourceHash,
            errors: lint.errors
          });
          workflows.nextDraftSequence = Math.max(0, workflows.nextDraftSequence - 1);
          continue;
        }

        queueRecord.status = "drafted";
        queueRecord.draftSequence = draftSequence;

        const reviewQueueSequence = Number(workflows.nextQueueSequence + 1);
        workflows.nextQueueSequence = reviewQueueSequence;
        const reviewQueueRecord = RlhfReviewQueueSchema.parse({
          queueSequence: reviewQueueSequence,
          draftSequence,
          status: "pending_review",
          enqueuedAt: entry.draftPayload.generatedAt,
          updatedAt: entry.draftPayload.generatedAt,
          notes: ""
        });

        workflows.drafts.push(draftRecord);
        workflows.candidateQueue.push(queueRecord);
        workflows.reviewQueue.push(reviewQueueRecord);

        persistedDrafts.push(draftRecord);
        queueRecords.push(queueRecord);
        artifacts.push({
          sequence: draftRecord.sequence,
          sourcePaperId: draftRecord.sourcePaperId,
          sourceHash: draftRecord.sourceHash,
          generatedAt: draftRecord.generatedAt,
          contentHash: draftRecord.contentHash,
          markdown: entry.markdown
        });
        existingSourceKeys.add(sourceKey);
      }

      workflows.lastAutomationRunAt = String(timeProvider.nowIso());
      workflows.generatorVersion = generatorVersion;

      return {
        persistedDrafts,
        queueRecords,
        lintFailures,
        artifacts
      };
    }, { correlationId });

    const artifactWrite = await appendDraftArtifactStore(draftArtifactPath, runResult.artifacts);

    logger.info({
      correlationId,
      event: "rlhf_pipeline_completed",
      candidateCount: selectedCandidates.length,
      draftedCount: runResult.persistedDrafts.length,
      lintRejectedCount: runResult.lintFailures.length
    });

    return {
      ok: true,
      correlationId,
      candidateCount: selectedCandidates.length,
      draftedCount: runResult.persistedDrafts.length,
      lintRejectedCount: runResult.lintFailures.length,
      draftedSequences: runResult.persistedDrafts.map((draft) => draft.sequence),
      lintFailures: runResult.lintFailures,
      artifactStore: artifactWrite
    };
  }

  return Object.freeze({
    run,
    verifyExistingDraftReplay,
    draftArtifactPath
  });
}

module.exports = {
  createRlhfPipelineRunner,
  verifyExistingDraftReplay
};
