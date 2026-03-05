"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { nowIso, nowMs } = require("../../openclaw-bridge/core/time-provider.js");
const {
  CHAIN_ZERO_HASH,
  OutcomeRecordWithoutHashesSchema,
  OutcomeRecordSchema,
  attachOutcomeHashes,
  canonicalize,
  normalizeOutcomeInput,
  makeError
} = require("./outcome-schema.js");
const {
  parseNdjson,
  assertIdempotencyReplay,
  verifyOutcomeChain,
  verifyStateChainAnchor
} = require("./outcome-validator.js");
const { getLegacyAccessBridge } = require("../access-control/legacy-access-bridge.js");

function createNoopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function normalizeRole(context = {}) {
  return typeof context.role === "string" ? context.role.trim().toLowerCase() : "supervisor";
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function ensureOutcomesState(state) {
  if (!state.rlhfOutcomes || typeof state.rlhfOutcomes !== "object") {
    state.rlhfOutcomes = {
      records: [],
      nextOutcomeSequence: 0,
      calibration: {
        version: "v1",
        lastCalibratedAt: "",
        weights: {
          complexity: 0.35,
          monetization: 0.35,
          qualitySignal: 0.30
        }
      },
      portfolioSnapshots: [],
      nextSnapshotSequence: 0,
      chainHeadHash: CHAIN_ZERO_HASH,
      chainHeadSequence: 0
    };
  }
  if (!Array.isArray(state.rlhfOutcomes.records)) {
    state.rlhfOutcomes.records = [];
  }
  if (!Array.isArray(state.rlhfOutcomes.portfolioSnapshots)) {
    state.rlhfOutcomes.portfolioSnapshots = [];
  }
}

function ensureDependencies(apiGovernance, operatorAuthorization) {
  if (!apiGovernance || typeof apiGovernance.withGovernanceTransaction !== "function" || typeof apiGovernance.readState !== "function") {
    throw makeError("RLHF_OUTCOME_CAPTURE_CONFIG_INVALID", "apiGovernance must provide withGovernanceTransaction/readState");
  }
  if (!operatorAuthorization || typeof operatorAuthorization.consumeApprovalToken !== "function") {
    throw makeError("RLHF_OUTCOME_CAPTURE_CONFIG_INVALID", "operatorAuthorization.consumeApprovalToken is required");
  }
}

async function writeAtomic(filePath, body, timeProvider) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${String(timeProvider.nowMs())}`;
  await fs.writeFile(tmpPath, body, "utf8");
  await fs.rename(tmpPath, filePath);
}

function buildOutcomeArtifactBody(records) {
  const lines = records.map((record) => JSON.stringify(canonicalize(record))).join("\n");
  return lines.length > 0 ? `${lines}\n` : "";
}

async function loadArtifactRecordsStrict(artifactPath) {
  try {
    const raw = await fs.readFile(artifactPath, "utf8");
    return parseNdjson(raw, { allowRecoverTrailingLine: false }).records;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function findByIdempotency(records, idempotencyKey) {
  return (Array.isArray(records) ? records : []).find((record) => safeString(record.idempotencyKey) === idempotencyKey) || null;
}

function assertOperatorRole(context = {}) {
  const role = normalizeRole(context);
  if (role === "supervisor") {
    throw makeError("RLHF_OUTCOME_ROLE_DENIED", "Supervisor cannot mutate outcome records");
  }
  if (role !== "operator") {
    throw makeError("RLHF_OUTCOME_ROLE_DENIED", "Only operator role can mutate outcome records");
  }
}

function assertKillSwitchOpen(state) {
  if (state && state.outboundMutation && state.outboundMutation.killSwitch === true) {
    throw makeError("RLHF_OUTCOME_KILL_SWITCH_ACTIVE", "Outcome mutations are blocked while kill-switch is active");
  }
}

function buildWithoutHashes(input, sequence, operatorId, enteredAt) {
  const normalized = normalizeOutcomeInput(input);
  const parsed = OutcomeRecordWithoutHashesSchema.parse({
    sequence,
    draftSequence: normalized.draftSequence,
    idempotencyKey: normalized.idempotencyKey,
    enteredAt,
    enteredBy: operatorId,
    aiAssisted: true,
    manualSubmissionConfirmed: normalized.manualSubmissionConfirmed,
    result: normalized.result,
    score: normalized.result === "pending" ? 0 : normalized.score,
    feedbackTags: normalized.feedbackTags,
    notes: normalized.notes,
    evidenceHash: normalized.evidenceHash,
    outcomeVersion: "v1"
  });
  return parsed;
}

function assertDraftExists(state, draftSequence) {
  const drafts = state && state.rlhfWorkflows && Array.isArray(state.rlhfWorkflows.drafts)
    ? state.rlhfWorkflows.drafts
    : [];
  const exists = drafts.some((draft) => Number(draft.sequence) === Number(draftSequence));
  if (!exists) {
    throw makeError("RLHF_OUTCOME_DRAFT_NOT_FOUND", `Draft sequence '${draftSequence}' not found`);
  }
}

function createOutcomeCaptureWorkflow(options = {}) {
  const apiGovernance = options.apiGovernance;
  const operatorAuthorization = options.operatorAuthorization;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : createNoopLogger();
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function" && typeof options.timeProvider.nowMs === "function"
    ? options.timeProvider
    : { nowIso, nowMs };
  const artifactPath = path.resolve(options.artifactPath || path.join(process.cwd(), "workspace", "memory", "rlhf-outcomes.ndjson"));

  ensureDependencies(apiGovernance, operatorAuthorization);
  let startupIntegrityChecked = false;

  async function reconcileArtifactFromState(stateSnapshot) {
    ensureOutcomesState(stateSnapshot);
    const records = stateSnapshot.rlhfOutcomes.records
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
      .map((record) => OutcomeRecordSchema.parse(record));
    const payload = buildOutcomeArtifactBody(records);
    await writeAtomic(artifactPath, payload, timeProvider);
    return { ok: true, path: artifactPath, count: records.length };
  }

  async function verifyOutcomeChainIntegrity() {
    const stateSnapshot = await apiGovernance.readState();
    ensureOutcomesState(stateSnapshot);
    const stateRecords = stateSnapshot.rlhfOutcomes.records
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
      .map((record) => OutcomeRecordSchema.parse(record));
    const stateChain = verifyOutcomeChain(stateRecords);
    if (
      safeString(stateSnapshot.rlhfOutcomes.chainHeadHash).toLowerCase() !== stateChain.headHash
      || Number.parseInt(String(stateSnapshot.rlhfOutcomes.chainHeadSequence ?? "0"), 10) !== stateChain.headSequence
    ) {
      throw makeError("RLHF_OUTCOME_STATE_CHAIN_INVALID", "Canonical state chain anchor does not match state outcomes");
    }

    const artifactRecords = await loadArtifactRecordsStrict(artifactPath);
    verifyStateChainAnchor(artifactRecords, {
      chainHeadHash: stateSnapshot.rlhfOutcomes.chainHeadHash,
      chainHeadSequence: stateSnapshot.rlhfOutcomes.chainHeadSequence
    });

    return {
      ok: true,
      stateCount: stateRecords.length,
      artifactCount: artifactRecords.length,
      chainHeadHash: stateChain.headHash,
      chainHeadSequence: stateChain.headSequence
    };
  }

  async function ensureStartupIntegrity() {
    if (startupIntegrityChecked) {
      return;
    }
    await verifyOutcomeChainIntegrity();
    startupIntegrityChecked = true;
  }

  async function repairOutcomeArtifactTail(input = {}, context = {}) {
    assertOperatorRole(context);
    const correlationId = safeString(context.correlationId);
    if (safeString(input.approvalToken)) {
      const legacyBridge = getLegacyAccessBridge();
      const legacyAccess = legacyBridge.evaluateLegacyAccess({
        approvalToken: input.approvalToken,
        scope: "rlhf.outcomes.repair",
        role: normalizeRole(context),
        action: "legacy.execute",
        resource: "rlhf.outcomes",
        caller: "legacy.rlhf.outcomes.repair",
        correlationId
      });
      if (!legacyAccess.allowed) {
        throw makeError("RLHF_OUTCOME_ACCESS_DENIED", "Phase 13 boundary denied legacy outcome repair access", {
          reason: legacyAccess.reason
        });
      }
    }
    const tokenResult = operatorAuthorization.consumeApprovalToken(input.approvalToken, "rlhf.outcomes.repair", {
      correlationId
    });

    const stateSnapshot = await apiGovernance.readState();
    assertKillSwitchOpen(stateSnapshot);

    let raw = "";
    try {
      raw = await fs.readFile(artifactPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        await reconcileArtifactFromState(stateSnapshot);
        startupIntegrityChecked = true;
        return {
          ok: true,
          repaired: true,
          reason: "artifact_missing_reconciled",
          operatorId: tokenResult.operatorId
        };
      }
      throw error;
    }

    const parsed = parseNdjson(raw, { allowRecoverTrailingLine: true });
    if (!parsed.recoveredTrailingLine) {
      await verifyOutcomeChainIntegrity();
      startupIntegrityChecked = true;
      return {
        ok: true,
        repaired: false,
        reason: "no_trailing_repair_needed",
        operatorId: tokenResult.operatorId
      };
    }

    const payload = buildOutcomeArtifactBody(parsed.records.map((record) => OutcomeRecordSchema.parse(record)));
    await writeAtomic(artifactPath, payload, timeProvider);
    await verifyOutcomeChainIntegrity();
    startupIntegrityChecked = true;
    return {
      ok: true,
      repaired: true,
      reason: "truncated_trailing_record_removed",
      operatorId: tokenResult.operatorId
    };
  }

  async function recordOutcome(input = {}, context = {}) {
    assertOperatorRole(context);
    await ensureStartupIntegrity();

    const correlationId = safeString(context.correlationId);
    const normalizedInput = normalizeOutcomeInput(input);
    if (!normalizedInput.idempotencyKey) {
      throw makeError("RLHF_OUTCOME_IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey is required");
    }
    if (safeString(input.approvalToken)) {
      const legacyBridge = getLegacyAccessBridge();
      const legacyAccess = legacyBridge.evaluateLegacyAccess({
        approvalToken: input.approvalToken,
        scope: "rlhf.outcomes.record",
        role: normalizeRole(context),
        action: "legacy.execute",
        resource: "rlhf.outcomes",
        caller: "legacy.rlhf.outcomes.record",
        correlationId
      });
      if (!legacyAccess.allowed) {
        throw makeError("RLHF_OUTCOME_ACCESS_DENIED", "Phase 13 boundary denied legacy outcome record access", {
          reason: legacyAccess.reason
        });
      }
    }
    const tokenResult = operatorAuthorization.consumeApprovalToken(input.approvalToken, "rlhf.outcomes.record", { correlationId });

    const snapshot = await apiGovernance.readState();
    ensureOutcomesState(snapshot);
    assertKillSwitchOpen(snapshot);
    assertDraftExists(snapshot, normalizedInput.draftSequence);

    const prior = findByIdempotency(snapshot.rlhfOutcomes.records, normalizedInput.idempotencyKey);
    if (prior) {
      assertIdempotencyReplay(prior, normalizedInput);
      return {
        ok: true,
        idempotent: true,
        record: OutcomeRecordSchema.parse(prior)
      };
    }

    const result = await apiGovernance.withGovernanceTransaction(async (tx) => {
      const state = tx.state;
      ensureOutcomesState(state);
      assertKillSwitchOpen(state);
      assertDraftExists(state, normalizedInput.draftSequence);

      const existing = findByIdempotency(state.rlhfOutcomes.records, normalizedInput.idempotencyKey);
      if (existing) {
        assertIdempotencyReplay(existing, normalizedInput);
        return {
          idempotent: true,
          record: OutcomeRecordSchema.parse(existing)
        };
      }

      state.rlhfOutcomes.nextOutcomeSequence = Math.max(
        parsePositiveInteger(state.rlhfOutcomes.nextOutcomeSequence, 0),
        state.rlhfOutcomes.records.reduce((max, record) => Math.max(max, Number(record.sequence || 0)), 0)
      ) + 1;
      const sequence = Number(state.rlhfOutcomes.nextOutcomeSequence);
      const enteredAt = String(timeProvider.nowIso());
      const enteredBy = safeString(tokenResult.operatorId) || safeString(context.requester) || "operator";
      const prevChainHash = safeString(state.rlhfOutcomes.chainHeadHash).toLowerCase() || CHAIN_ZERO_HASH;

      const withoutHashes = buildWithoutHashes(normalizedInput, sequence, enteredBy, enteredAt);
      const record = attachOutcomeHashes(withoutHashes, prevChainHash);
      state.rlhfOutcomes.records.push(record);
      state.rlhfOutcomes.records.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
      state.rlhfOutcomes.chainHeadHash = record.chainHash;
      state.rlhfOutcomes.chainHeadSequence = record.sequence;

      return {
        idempotent: false,
        record
      };
    }, { correlationId });

    const refreshed = await apiGovernance.readState();
    await reconcileArtifactFromState(refreshed);
    await verifyOutcomeChainIntegrity();

    logger.info({
      correlationId,
      event: "rlhf_outcome_recorded",
      idempotent: result.idempotent,
      sequence: result.record.sequence,
      draftSequence: result.record.draftSequence
    });

    return {
      ok: true,
      idempotent: Boolean(result.idempotent),
      record: result.record
    };
  }

  return Object.freeze({
    artifactPath,
    recordOutcome,
    verifyOutcomeChainIntegrity,
    repairOutcomeArtifactTail,
    reconcileArtifactFromState
  });
}

module.exports = {
  createOutcomeCaptureWorkflow
};
