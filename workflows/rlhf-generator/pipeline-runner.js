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

const NOOP_ERROR_CODE = "RLHF_PIPELINE_NOOP";

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function parseDraftArtifactNdjson(raw, options = {}) {
  const source = String(raw || "");
  const lines = source.split("\n");
  const records = [];

  const nonEmptyIndexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().length > 0) {
      nonEmptyIndexes.push(i);
    }
  }

  const lastNonEmptyIndex = nonEmptyIndexes.length > 0 ? nonEmptyIndexes[nonEmptyIndexes.length - 1] : -1;
  const allowRecoverTrailingLine = Boolean(options.allowRecoverTrailingLine);
  let recoveredTrailingLine = false;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      continue;
    }

    try {
      records.push(JSON.parse(trimmed));
    } catch {
      const isTrailing = i === lastNonEmptyIndex;
      if (allowRecoverTrailingLine && isTrailing) {
        recoveredTrailingLine = true;
        break;
      }
      const error = new Error(`Invalid RLHF artifact NDJSON record at line ${i + 1}`);
      error.code = "RLHF_ARTIFACT_STORE_CORRUPTED";
      error.details = { line: i + 1 };
      throw error;
    }
  }

  return {
    records,
    recoveredTrailingLine
  };
}

async function writeAtomic(filePath, body) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${process.hrtime.bigint().toString()}`;
  await fs.writeFile(tmpPath, body, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function ensureDraftArtifactIntegrity(filePath) {
  const target = path.resolve(filePath);
  let raw = "";
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        repaired: false,
        recoveredTrailingLine: false,
        count: 0,
        path: target
      };
    }
    throw error;
  }

  const parsed = parseDraftArtifactNdjson(raw, { allowRecoverTrailingLine: true });
  if (!parsed.recoveredTrailingLine) {
    return {
      repaired: false,
      recoveredTrailingLine: false,
      count: parsed.records.length,
      path: target
    };
  }

  const lines = parsed.records.map((record) => JSON.stringify(canonicalize(record))).join("\n");
  const payload = lines.length > 0 ? `${lines}\n` : "";
  await writeAtomic(target, payload);

  return {
    repaired: true,
    recoveredTrailingLine: true,
    count: parsed.records.length,
    path: target
  };
}

function buildDraftArtifactRecordsFromState(state) {
  const workflows = isPlainObject(state && state.rlhfWorkflows) ? state.rlhfWorkflows : {};
  const drafts = asArray(workflows.drafts)
    .slice()
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));

  return drafts.map((draft) => canonicalize({
    sequence: Number(draft.sequence || 0),
    sourcePaperId: String(draft.sourcePaperId || ""),
    sourceHash: String(draft.sourceHash || ""),
    generatedAt: String(draft.generatedAt || ""),
    contentHash: String(draft.contentHash || ""),
    status: String(draft.status || ""),
    generatorVersion: String(draft.generatorVersion || "v1"),
    aiAssisted: Boolean(draft.aiAssisted),
    manualSubmissionRequired: Boolean(draft.manualSubmissionRequired)
  }));
}

async function reconcileDraftArtifactStoreFromState(filePath, state) {
  const target = path.resolve(filePath);
  const records = buildDraftArtifactRecordsFromState(state);
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  const payload = lines.length > 0 ? `${lines}\n` : "";
  await writeAtomic(target, payload);
  return {
    wrote: records.length,
    path: target,
    mode: "state_first_reconciliation"
  };
}

function readCalibrationWeightsFromState(state) {
  const weights = state
    && state.rlhfOutcomes
    && state.rlhfOutcomes.calibration
    && isPlainObject(state.rlhfOutcomes.calibration.weights)
    ? state.rlhfOutcomes.calibration.weights
    : null;
  const fallback = { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 };
  if (!weights) {
    return fallback;
  }
  const complexity = Number(weights.complexity);
  const monetization = Number(weights.monetization);
  const qualitySignal = Number(weights.qualitySignal);
  const sum = complexity + monetization + qualitySignal;
  if (
    !Number.isFinite(complexity) || !Number.isFinite(monetization) || !Number.isFinite(qualitySignal)
    || complexity < 0 || monetization < 0 || qualitySignal < 0
    || Math.abs(sum - 1) > 0.000001
  ) {
    return fallback;
  }
  return { complexity, monetization, qualitySignal };
}

function buildQualityPriorByDomainFromState(state) {
  const drafts = isPlainObject(state && state.rlhfWorkflows) && Array.isArray(state.rlhfWorkflows.drafts)
    ? state.rlhfWorkflows.drafts
    : [];
  const outcomes = isPlainObject(state && state.rlhfOutcomes) && Array.isArray(state.rlhfOutcomes.records)
    ? state.rlhfOutcomes.records
    : [];
  const draftDomainBySequence = new Map();
  for (const draft of drafts) {
    const sequence = Number(draft.sequence || 0);
    if (sequence <= 0) continue;
    const domainTag = safeString(draft.domainTag) || "general-research";
    draftDomainBySequence.set(sequence, domainTag);
  }

  const byDomain = new Map();
  for (const outcome of outcomes) {
    if (!outcome || outcome.result === "pending") {
      continue;
    }
    const draftSequence = Number(outcome.draftSequence || 0);
    const domainTag = draftDomainBySequence.get(draftSequence);
    if (!domainTag) {
      continue;
    }
    const score = Math.max(0, Math.min(100, Number.parseInt(String(outcome.score || "0"), 10) || 0));
    const current = byDomain.get(domainTag) || { total: 0, count: 0 };
    current.total += score;
    current.count += 1;
    byDomain.set(domainTag, current);
  }

  return Object.fromEntries(
    [...byDomain.entries()]
      .map(([domainTag, stats]) => [domainTag, stats.count === 0 ? 0 : Math.floor(stats.total / stats.count)])
      .sort((left, right) => left[0].localeCompare(right[0]))
  );
}

function createNoopResult(input = {}) {
  return {
    ok: true,
    noOp: true,
    stateMutated: false,
    candidateCount: 0,
    draftedCount: 0,
    lintRejectedCount: 0,
    draftedSequences: [],
    lintFailures: [],
    ...input
  };
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

  async function reconcileDraftArtifacts() {
    const snapshot = await apiGovernance.readState();
    verifyExistingDraftReplay(snapshot);
    const repaired = await ensureDraftArtifactIntegrity(draftArtifactPath);
    const artifactStore = await reconcileDraftArtifactStoreFromState(draftArtifactPath, snapshot);
    return {
      ok: true,
      repaired,
      artifactStore
    };
  }

  async function run(input = {}) {
    const correlationId = safeString(input.correlationId);
    const domainAllowlist = asArray(input.domainAllowlist).map((item) => String(item || "").trim()).filter(Boolean);
    const candidateLimit = maxCandidates(input.maxCandidates);

    const records = await apiGovernance.loadResearchRecords();
    const snapshot = await apiGovernance.readState();
    verifyExistingDraftReplay(snapshot);
    const repairedAtStart = await ensureDraftArtifactIntegrity(draftArtifactPath);

    const monetizationSnapshot = monetizationEngine && typeof monetizationEngine.computeMonetizationScore === "function"
      ? await monetizationEngine.computeMonetizationScore({})
      : { ok: true, score: 0, metrics: {} };

    const selectedCandidates = selectCandidates({
      records,
      existingDrafts: snapshot.rlhfWorkflows && Array.isArray(snapshot.rlhfWorkflows.drafts) ? snapshot.rlhfWorkflows.drafts : [],
      domainAllowlist,
      monetizationSnapshot,
      calibrationWeights: readCalibrationWeightsFromState(snapshot),
      qualityPriorByDomain: buildQualityPriorByDomainFromState(snapshot),
      limit: candidateLimit
    });

    if (selectedCandidates.length === 0) {
      const artifactStore = await reconcileDraftArtifactStoreFromState(draftArtifactPath, snapshot);
      return createNoopResult({
        correlationId,
        artifactStore,
        artifactRepair: repairedAtStart
      });
    }

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

    let runResult;
    try {
      runResult = await apiGovernance.withGovernanceTransaction(async (tx) => {
        const state = tx.state;
        const workflows = state.rlhfWorkflows;
        const drafts = asArray(workflows.drafts);
        const existingSourceKeys = new Set(drafts.map((draft) => sourceKeyFromPaper(draft.sourcePaperId, draft.sourceHash)));

        const persistedDrafts = [];
        const queueRecords = [];
        const lintFailures = [];
        let stateMutated = false;

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
            stateMutated = true;
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
          existingSourceKeys.add(sourceKey);
          stateMutated = true;
        }

        if (!stateMutated) {
          const noopError = new Error("No eligible candidates after transactional dedupe");
          noopError.code = NOOP_ERROR_CODE;
          noopError.details = {
            persistedDrafts: [],
            queueRecords: [],
            lintFailures: []
          };
          throw noopError;
        }

        workflows.lastAutomationRunAt = String(timeProvider.nowIso());
        workflows.generatorVersion = generatorVersion;

        return {
          persistedDrafts,
          queueRecords,
          lintFailures,
          stateMutated: true
        };
      }, { correlationId });
    } catch (error) {
      if (error && error.code === NOOP_ERROR_CODE) {
        runResult = {
          persistedDrafts: [],
          queueRecords: [],
          lintFailures: [],
          stateMutated: false,
          noOp: true
        };
      } else {
        throw error;
      }
    }

    const refreshedState = await apiGovernance.readState();
    verifyExistingDraftReplay(refreshedState);
    const artifactStore = await reconcileDraftArtifactStoreFromState(draftArtifactPath, refreshedState);

    logger.info({
      correlationId,
      event: "rlhf_pipeline_completed",
      candidateCount: selectedCandidates.length,
      draftedCount: runResult.persistedDrafts.length,
      lintRejectedCount: runResult.lintFailures.length,
      stateMutated: Boolean(runResult.stateMutated)
    });

    return {
      ok: true,
      noOp: Boolean(runResult.noOp),
      stateMutated: Boolean(runResult.stateMutated),
      correlationId,
      candidateCount: selectedCandidates.length,
      draftedCount: runResult.persistedDrafts.length,
      lintRejectedCount: runResult.lintFailures.length,
      draftedSequences: runResult.persistedDrafts.map((draft) => draft.sequence),
      lintFailures: runResult.lintFailures,
      artifactStore,
      artifactRepair: repairedAtStart
    };
  }

  return Object.freeze({
    run,
    reconcileDraftArtifacts,
    verifyExistingDraftReplay,
    ensureDraftArtifactIntegrity: () => ensureDraftArtifactIntegrity(draftArtifactPath),
    draftArtifactPath
  });
}

module.exports = {
  createRlhfPipelineRunner,
  verifyExistingDraftReplay,
  ensureDraftArtifactIntegrity,
  reconcileDraftArtifactStoreFromState
};
