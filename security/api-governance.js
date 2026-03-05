"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { nowMs: runtimeNowMs, nowIso: runtimeNowIso } = require("../openclaw-bridge/core/time-provider.js");
const { randomHex } = require("../openclaw-bridge/core/entropy-provider.js");
const { createStateTransactionWrapper } = require("../openclaw-bridge/state/state-manager.js");
const { createCircuitBreaker } = require("../openclaw-bridge/supervisor/circuit-breaker.js");

const DEFAULT_LIMITS = Object.freeze({
  perMcpRequestsPerMinute: 20,
  globalRequestsPerMinute: 60,
  dailyTokenBudget: 250000,
  dailyRequestLimit: 2000,
  mutationPublishesPerHour: 5,
  mutationPublishesPerDay: 30,
  mutationWriteTokensPerDay: 100000,
  mutationControlTogglesPerMinute: 1,
  mutationAttemptIdTtlMs: 7 * 24 * 60 * 60 * 1000
});

const DEFAULT_STATE_PATH = path.resolve(process.cwd(), "workspace", "runtime", "state.json");
const DEFAULT_RESEARCH_NDJSON_PATH = path.resolve(process.cwd(), "workspace", "memory", "research-ingestion.ndjson");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalStringify(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const RLHF_DRAFT_STATUSES = Object.freeze(["draft", "reviewed", "approved_for_manual_submission", "archived"]);
const RLHF_REVIEW_STATUSES = Object.freeze(["pending_review", "reviewed", "approved_for_manual_submission", "archived"]);
const RLHF_OUTCOME_RESULTS = Object.freeze(["accepted", "rejected", "revise_requested", "pending"]);
const EXPERIMENT_STATUSES = Object.freeze(["draft", "approved", "running", "paused", "completed", "archived"]);
const ROLLOUT_DECISIONS = Object.freeze(["adopt", "hold", "rollback"]);
const ROLLOUT_REASON_CODES = Object.freeze([
  "uplift_positive",
  "insufficient_power",
  "guardrail_breach",
  "operator_override"
]);
const COMPLIANCE_RELEASE_DECISIONS = Object.freeze(["allow", "block", "hold"]);
const COMPLIANCE_RELEASE_REASON_CODES = Object.freeze([
  "all_checks_passed",
  "missing_evidence",
  "integrity_mismatch",
  "policy_violation",
  "operator_override"
]);
const EMPTY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_CALIBRATION_WEIGHTS = Object.freeze({
  complexity: 0.35,
  monetization: 0.35,
  qualitySignal: 0.30
});

function buildDefaultRlhfWorkflowsState() {
  return {
    drafts: [],
    candidateQueue: [],
    reviewQueue: [],
    nextDraftSequence: 0,
    nextQueueSequence: 0,
    lastAutomationRunAt: "",
    generatorVersion: "v1"
  };
}

function buildDefaultRlhfOutcomesState() {
  return {
    records: [],
    nextOutcomeSequence: 0,
    calibration: {
      version: "v1",
      lastCalibratedAt: "",
      weights: { ...DEFAULT_CALIBRATION_WEIGHTS }
    },
    portfolioSnapshots: [],
    nextSnapshotSequence: 0,
    chainHeadHash: EMPTY_HASH,
    chainHeadSequence: 0
  };
}

function buildDefaultExperimentGovernanceState() {
  return {
    policyVersion: "v1",
    experiments: [],
    assignments: [],
    analysisSnapshots: [],
    rolloutDecisions: [],
    activeRolloutProfile: {
      version: "v1",
      updatedAt: "",
      updatedBy: "",
      weights: { ...DEFAULT_CALIBRATION_WEIGHTS },
      templateBias: {}
    },
    decisionLedger: {
      records: [],
      nextSequence: 0,
      chainHead: ""
    },
    nextExperimentSequence: 0,
    nextAssignmentSequence: 0,
    nextAnalysisSequence: 0,
    nextRolloutDecisionSequence: 0
  };
}

function buildDefaultComplianceGovernanceState() {
  return {
    policyVersion: "v1",
    attestationSnapshots: [],
    evidenceBundles: [],
    releaseGates: [],
    activeReleasePolicy: {
      version: "v1",
      updatedAt: "",
      updatedBy: "",
      requiredChecks: ["phase2-gates", "mcp-policy", "phase6-policy", "phase7-policy"],
      minEvidenceFreshnessHours: 24
    },
    decisionLedger: {
      records: [],
      nextSequence: 0,
      chainHead: ""
    },
    operatorOverrideLedger: {
      records: [],
      nextSequence: 0,
      chainHead: ""
    },
    operationalDecisionLedger: {
      records: [],
      nextSequence: 0,
      chainHead: ""
    },
    nextAttestationSequence: 0,
    nextEvidenceBundleSequence: 0,
    nextReleaseGateSequence: 0
  };
}

function normalizeRlhfStatus(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return RLHF_DRAFT_STATUSES.includes(text) ? text : "draft";
}

function normalizeReviewQueueStatus(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return RLHF_REVIEW_STATUSES.includes(text) ? text : "pending_review";
}

function normalizeOutcomeResult(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return RLHF_OUTCOME_RESULTS.includes(text) ? text : "pending";
}

function toBoundedInt(value, min, max, fallback = min) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeHash(value, fallback = "") {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/.test(text) ? text : fallback;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const deduped = new Set(
    value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  );
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function normalizeCalibrationWeights(value) {
  const source = isPlainObject(value) ? value : {};
  const complexity = Number.parseFloat(String(source.complexity ?? DEFAULT_CALIBRATION_WEIGHTS.complexity));
  const monetization = Number.parseFloat(String(source.monetization ?? DEFAULT_CALIBRATION_WEIGHTS.monetization));
  const qualitySignal = Number.parseFloat(String(source.qualitySignal ?? DEFAULT_CALIBRATION_WEIGHTS.qualitySignal));
  const weights = { complexity, monetization, qualitySignal };
  const allFinite = Object.values(weights).every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1);
  const sum = complexity + monetization + qualitySignal;
  if (!allFinite || Math.abs(sum - 1) > 0.000001) {
    return { ...DEFAULT_CALIBRATION_WEIGHTS };
  }
  return {
    complexity: Number.parseFloat(complexity.toFixed(6)),
    monetization: Number.parseFloat(monetization.toFixed(6)),
    qualitySignal: Number.parseFloat(qualitySignal.toFixed(6))
  };
}

function normalizeCalibration(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    version: typeof source.version === "string" && source.version.trim() ? source.version.trim() : "v1",
    lastCalibratedAt: typeof source.lastCalibratedAt === "string" ? source.lastCalibratedAt : "",
    weights: normalizeCalibrationWeights(source.weights)
  });
}

function normalizePortfolioSnapshot(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    capturedAt: typeof source.capturedAt === "string" ? source.capturedAt : "",
    summary: isPlainObject(source.summary) ? canonicalize(source.summary) : {},
    reportHash: normalizeHash(source.reportHash, EMPTY_HASH)
  });
}

function normalizeRlhfDraftRecord(value) {
  const source = isPlainObject(value) ? value : {};
  const status = normalizeRlhfStatus(source.status);
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    sourcePaperId: typeof source.sourcePaperId === "string" ? source.sourcePaperId.trim() : "",
    sourceHash: typeof source.sourceHash === "string" ? source.sourceHash.trim().toLowerCase() : "",
    domainTag: typeof source.domainTag === "string" ? source.domainTag.trim() : "general-research",
    complexityScore: Math.max(0, Number.parseInt(String(source.complexityScore ?? "0"), 10) || 0),
    monetizationScore: Math.max(0, Number.parseInt(String(source.monetizationScore ?? "0"), 10) || 0),
    generatedAt: typeof source.generatedAt === "string" ? source.generatedAt : "",
    generatorVersion: typeof source.generatorVersion === "string" && source.generatorVersion.trim() ? source.generatorVersion.trim() : "v1",
    contentHash: typeof source.contentHash === "string" && /^[a-f0-9]{64}$/.test(source.contentHash) ? source.contentHash : EMPTY_HASH,
    status,
    aiAssisted: true,
    reviewedBy: status === "draft"
      ? null
      : (typeof source.reviewedBy === "string" && source.reviewedBy.trim() ? source.reviewedBy.trim() : null),
    reviewedAt: status === "draft"
      ? null
      : (typeof source.reviewedAt === "string" && source.reviewedAt.trim() ? source.reviewedAt.trim() : null),
    notes: typeof source.notes === "string" ? source.notes : "",
    manualSubmissionRequired: true
  });
}

function normalizeRlhfCandidateQueueRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    queueSequence: Math.max(1, parsePositiveInt(source.queueSequence, 1)),
    sourcePaperId: typeof source.sourcePaperId === "string" ? source.sourcePaperId.trim() : "",
    sourceHash: typeof source.sourceHash === "string" ? source.sourceHash.trim().toLowerCase() : "",
    domainTag: typeof source.domainTag === "string" ? source.domainTag.trim() : "general-research",
    complexityScore: Math.max(0, Number.parseInt(String(source.complexityScore ?? "0"), 10) || 0),
    monetizationScore: Math.max(0, Number.parseInt(String(source.monetizationScore ?? "0"), 10) || 0),
    rankingScore: Math.max(0, Number.parseInt(String(source.rankingScore ?? "0"), 10) || 0),
    enqueuedAt: typeof source.enqueuedAt === "string" ? source.enqueuedAt : "",
    status: typeof source.status === "string" && source.status.trim() ? source.status.trim() : "queued",
    draftSequence: source.draftSequence === null ? null : Math.max(0, Number.parseInt(String(source.draftSequence ?? "0"), 10) || 0)
  });
}

function normalizeRlhfReviewQueueRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    queueSequence: Math.max(1, parsePositiveInt(source.queueSequence, 1)),
    draftSequence: Math.max(1, parsePositiveInt(source.draftSequence, 1)),
    status: normalizeReviewQueueStatus(source.status),
    enqueuedAt: typeof source.enqueuedAt === "string" ? source.enqueuedAt : "",
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
    notes: typeof source.notes === "string" ? source.notes : ""
  });
}

function normalizeRlhfOutcomeRecord(value) {
  const source = isPlainObject(value) ? value : {};
  const result = normalizeOutcomeResult(source.result);
  const manualSubmissionConfirmed = Boolean(source.manualSubmissionConfirmed);
  const finalized = result !== "pending";
  let normalizedResult = result;
  let normalizedScore = toBoundedInt(source.score, 0, 100, 0);
  if (result === "pending") {
    normalizedScore = 0;
  }
  if (finalized && manualSubmissionConfirmed !== true) {
    normalizedResult = "pending";
    normalizedScore = 0;
  }

  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    draftSequence: Math.max(1, parsePositiveInt(source.draftSequence, 1)),
    idempotencyKey: typeof source.idempotencyKey === "string" ? source.idempotencyKey.trim() : "",
    enteredAt: typeof source.enteredAt === "string" ? source.enteredAt : "",
    enteredBy: typeof source.enteredBy === "string" ? source.enteredBy.trim() : "",
    aiAssisted: true,
    manualSubmissionConfirmed: normalizedResult === "pending" ? Boolean(source.manualSubmissionConfirmed) : true,
    result: normalizedResult,
    score: normalizedResult === "pending" ? 0 : normalizedScore,
    feedbackTags: normalizeTags(source.feedbackTags),
    notes: typeof source.notes === "string" ? source.notes : "",
    evidenceHash: normalizeHash(source.evidenceHash, ""),
    outcomeHash: normalizeHash(source.outcomeHash, EMPTY_HASH),
    prevChainHash: normalizeHash(source.prevChainHash, EMPTY_HASH),
    chainHash: normalizeHash(source.chainHash, EMPTY_HASH),
    outcomeVersion: typeof source.outcomeVersion === "string" && source.outcomeVersion.trim() ? source.outcomeVersion.trim() : "v1"
  });
}

function normalizeExperimentStatus(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return EXPERIMENT_STATUSES.includes(text) ? text : "draft";
}

function normalizeRolloutDecision(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return ROLLOUT_DECISIONS.includes(text) ? text : "hold";
}

function normalizeRolloutReasonCode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return ROLLOUT_REASON_CODES.includes(text) ? text : "insufficient_power";
}

function normalizeComplianceReleaseDecision(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return COMPLIANCE_RELEASE_DECISIONS.includes(text) ? text : "hold";
}

function normalizeComplianceReasonCode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return COMPLIANCE_RELEASE_REASON_CODES.includes(text) ? text : "policy_violation";
}

function normalizeSplitBasisPoints(value) {
  const source = isPlainObject(value) ? value : {};
  const control = Math.max(0, Math.min(10000, Number.parseInt(String(source.control ?? "5000"), 10) || 5000));
  const treatment = Math.max(0, Math.min(10000, Number.parseInt(String(source.treatment ?? "5000"), 10) || 5000));
  if ((control + treatment) !== 10000) {
    return { control: 5000, treatment: 5000 };
  }
  return { control, treatment };
}

function normalizeTemplateBias(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const pairs = Object.entries(value)
    .map(([key, raw]) => [String(key || "").trim(), Number(raw)])
    .filter(([key, score]) => key.length > 0 && Number.isFinite(score))
    .map(([key, score]) => [key, Number.parseFloat(Number(score).toFixed(6))]);
  pairs.sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(pairs);
}

function normalizeActiveRolloutProfile(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    version: typeof source.version === "string" && source.version.trim() ? source.version.trim() : "v1",
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy.trim() : "",
    weights: normalizeCalibrationWeights(source.weights),
    templateBias: normalizeTemplateBias(source.templateBias)
  });
}

function normalizeDecisionLedgerRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    decisionSequence: Math.max(0, Number.parseInt(String(source.decisionSequence ?? "0"), 10) || 0),
    recordedAt: typeof source.recordedAt === "string" ? source.recordedAt : "",
    decisionHash: normalizeHash(source.decisionHash, ""),
    prevDecisionHash: normalizeHash(source.prevDecisionHash, ""),
    chainHash: normalizeHash(source.chainHash, "")
  });
}

function normalizeExperimentRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    createdAt: typeof source.createdAt === "string" ? source.createdAt : "",
    createdBy: typeof source.createdBy === "string" ? source.createdBy.trim() : "",
    name: typeof source.name === "string" ? source.name : "",
    status: normalizeExperimentStatus(source.status),
    objective: typeof source.objective === "string" ? source.objective : "",
    treatment: isPlainObject(source.treatment) ? canonicalize(source.treatment) : {},
    control: isPlainObject(source.control) ? canonicalize(source.control) : {},
    window: isPlainObject(source.window) ? canonicalize(source.window) : {},
    guardrails: isPlainObject(source.guardrails) ? canonicalize(source.guardrails) : {},
    analysisPlanVersion: typeof source.analysisPlanVersion === "string" ? source.analysisPlanVersion : "v1",
    notes: typeof source.notes === "string" ? source.notes : "",
    splitBasisPoints: normalizeSplitBasisPoints(source.splitBasisPoints),
    preRegistrationLockHash: normalizeHash(source.preRegistrationLockHash, "")
  });
}

function normalizeAssignmentRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    experimentSequence: Math.max(1, parsePositiveInt(source.experimentSequence, 1)),
    draftSequence: Math.max(1, parsePositiveInt(source.draftSequence, 1)),
    assignedAt: typeof source.assignedAt === "string" ? source.assignedAt : "",
    assignedBy: typeof source.assignedBy === "string" ? source.assignedBy.trim() : "",
    bucket: Math.max(0, Math.min(9999, Number.parseInt(String(source.bucket ?? "0"), 10) || 0)),
    cohort: typeof source.cohort === "string" && source.cohort.trim() ? source.cohort.trim() : "control",
    idempotencyKey: typeof source.idempotencyKey === "string" ? source.idempotencyKey.trim() : ""
  });
}

function normalizeAnalysisSnapshotRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    experimentSequence: Math.max(1, parsePositiveInt(source.experimentSequence, 1)),
    capturedAt: typeof source.capturedAt === "string" ? source.capturedAt : "",
    capturedBy: typeof source.capturedBy === "string" ? source.capturedBy.trim() : "",
    idempotencyKey: typeof source.idempotencyKey === "string" ? source.idempotencyKey.trim() : "",
    sampleSize: Math.max(0, Number.parseInt(String(source.sampleSize ?? "0"), 10) || 0),
    treatmentSampleSize: Math.max(0, Number.parseInt(String(source.treatmentSampleSize ?? "0"), 10) || 0),
    controlSampleSize: Math.max(0, Number.parseInt(String(source.controlSampleSize ?? "0"), 10) || 0),
    metrics: isPlainObject(source.metrics) ? canonicalize(source.metrics) : {
      acceptanceRateDelta: 0,
      reviseRequestRateDelta: 0,
      meanQualityScoreDelta: 0,
      medianQualityScoreDelta: 0,
      domainUplift: {}
    },
    recommendation: normalizeRolloutDecision(source.recommendation),
    reasonCode: normalizeRolloutReasonCode(source.reasonCode),
    guardrailBreaches: Array.isArray(source.guardrailBreaches)
      ? source.guardrailBreaches.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    analysisPlanVersion: typeof source.analysisPlanVersion === "string" && source.analysisPlanVersion.trim()
      ? source.analysisPlanVersion.trim()
      : "v1"
  });
}

function normalizeRolloutDecisionRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    experimentSequence: Math.max(1, parsePositiveInt(source.experimentSequence, 1)),
    decidedAt: typeof source.decidedAt === "string" ? source.decidedAt : "",
    decidedBy: typeof source.decidedBy === "string" ? source.decidedBy.trim() : "",
    decision: normalizeRolloutDecision(source.decision),
    reasonCode: typeof source.reasonCode === "string" ? source.reasonCode : "",
    approvalToken: typeof source.approvalToken === "string" ? source.approvalToken.trim() : "",
    idempotencyKey: typeof source.idempotencyKey === "string" ? source.idempotencyKey.trim() : "",
    decisionHash: normalizeHash(source.decisionHash, ""),
    prevDecisionHash: normalizeHash(source.prevDecisionHash, "")
  });
}

function normalizeDecisionLedgerState(value) {
  const source = isPlainObject(value) ? value : {};
  const records = Array.isArray(source.records)
    ? source.records
      .map((entry) => normalizeDecisionLedgerRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const observedMaxSequence = records.reduce((max, record) => Math.max(max, Number(record.sequence || 0)), 0);
  return canonicalize({
    records,
    nextSequence: Math.max(
      observedMaxSequence,
      Math.max(0, Number.parseInt(String(source.nextSequence ?? "0"), 10) || 0)
    ),
    chainHead: normalizeHash(source.chainHead, "")
  });
}

function normalizeComplianceDecisionLedgerRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    decisionSequence: Math.max(0, Number.parseInt(String(source.decisionSequence ?? "0"), 10) || 0),
    recordedAt: typeof source.recordedAt === "string" ? source.recordedAt : "",
    decisionHash: normalizeHash(source.decisionHash, ""),
    prevDecisionHash: normalizeHash(source.prevDecisionHash, ""),
    chainHash: normalizeHash(source.chainHash, "")
  });
}

function normalizeComplianceDecisionLedgerState(value) {
  const source = isPlainObject(value) ? value : {};
  const records = Array.isArray(source.records)
    ? source.records
      .map((entry) => normalizeComplianceDecisionLedgerRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const observedMaxSequence = records.reduce((max, record) => Math.max(max, Number(record.sequence || 0)), 0);
  return canonicalize({
    records,
    nextSequence: Math.max(
      observedMaxSequence,
      Math.max(0, Number.parseInt(String(source.nextSequence ?? "0"), 10) || 0)
    ),
    chainHead: normalizeHash(source.chainHead, "")
  });
}

function normalizeOperatorOverrideLedgerRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    override_id: typeof source.override_id === "string" ? source.override_id.trim() : "",
    scope: typeof source.scope === "string" ? source.scope.trim() : "",
    timestamp: typeof source.timestamp === "string" ? source.timestamp : "",
    operator: {
      role: typeof source.operator === "object" && source.operator && typeof source.operator.role === "string"
        ? source.operator.role.trim()
        : "",
      id: typeof source.operator === "object" && source.operator && typeof source.operator.id === "string"
        ? source.operator.id.trim()
        : ""
    },
    approval_token_scope: typeof source.approval_token_scope === "string" ? source.approval_token_scope.trim() : "",
    reason: typeof source.reason === "string" ? source.reason : "",
    phase_impact: typeof source.phase_impact === "string" ? source.phase_impact : "",
    override_policy: typeof source.override_policy === "string" ? source.override_policy : "",
    governance_transaction_id: typeof source.governance_transaction_id === "string" ? source.governance_transaction_id.trim() : "",
    prev_chain_hash: normalizeHash(source.prev_chain_hash, ""),
    entry_hash: normalizeHash(source.entry_hash, ""),
    chain_hash: normalizeHash(source.chain_hash, "")
  });
}

function normalizeOperatorOverrideLedgerState(value) {
  const source = isPlainObject(value) ? value : {};
  const records = Array.isArray(source.records)
    ? source.records
      .map((entry) => normalizeOperatorOverrideLedgerRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const observedMaxSequence = records.reduce((max, record) => Math.max(max, Number(record.sequence || 0)), 0);
  return canonicalize({
    records,
    nextSequence: Math.max(
      observedMaxSequence,
      Math.max(0, Number.parseInt(String(source.nextSequence ?? "0"), 10) || 0)
    ),
    chainHead: normalizeHash(source.chainHead, "")
  });
}

function normalizeOperationalDecisionLedgerRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    decision_id: typeof source.decision_id === "string" ? source.decision_id.trim() : "",
    timestamp: typeof source.timestamp === "string" ? source.timestamp : "",
    event_type: typeof source.event_type === "string" ? source.event_type.trim() : "",
    actor: typeof source.actor === "string" ? source.actor.trim() : "",
    action: typeof source.action === "string" ? source.action.trim() : "",
    result: typeof source.result === "string" ? source.result.trim() : "",
    scope: typeof source.scope === "string" ? source.scope.trim() : "",
    details: isPlainObject(source.details) ? canonicalize(source.details) : {},
    prev_chain_hash: normalizeHash(source.prev_chain_hash, ""),
    entry_hash: normalizeHash(source.entry_hash, ""),
    chain_hash: normalizeHash(source.chain_hash, "")
  });
}

function normalizeOperationalDecisionLedgerState(value) {
  const source = isPlainObject(value) ? value : {};
  const records = Array.isArray(source.records)
    ? source.records
      .map((entry) => normalizeOperationalDecisionLedgerRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const observedMaxSequence = records.reduce((max, record) => Math.max(max, Number(record.sequence || 0)), 0);
  return canonicalize({
    records,
    nextSequence: Math.max(
      observedMaxSequence,
      Math.max(0, Number.parseInt(String(source.nextSequence ?? "0"), 10) || 0)
    ),
    chainHead: normalizeHash(source.chainHead, "")
  });
}

function normalizeComplianceActiveReleasePolicy(value) {
  const source = isPlainObject(value) ? value : {};
  const requiredChecks = Array.isArray(source.requiredChecks)
    ? source.requiredChecks
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
    : ["phase2-gates", "mcp-policy", "phase6-policy", "phase7-policy"];
  return canonicalize({
    version: typeof source.version === "string" && source.version.trim() ? source.version.trim() : "v1",
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy.trim() : "",
    requiredChecks: requiredChecks.length > 0 ? requiredChecks : ["phase2-gates", "mcp-policy", "phase6-policy", "phase7-policy"],
    minEvidenceFreshnessHours: Math.max(1, Number.parseInt(String(source.minEvidenceFreshnessHours ?? "24"), 10) || 24)
  });
}

function normalizeGateScriptDigest(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    name: typeof source.name === "string" ? source.name.trim() : "",
    sha256: normalizeHash(source.sha256, EMPTY_HASH)
  });
}

function normalizeCriticalModuleManifest(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const entries = Object.entries(value)
    .map(([name, digest]) => [String(name || "").trim(), normalizeHash(digest, "")])
    .filter(([name, digest]) => name.length > 0 && digest.length > 0)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return canonicalize(Object.fromEntries(entries));
}

function normalizeAttestationSnapshotRecord(value) {
  const source = isPlainObject(value) ? value : {};
  const enabledGateScripts = Array.isArray(source.enabledGateScripts)
    ? source.enabledGateScripts
      .map((entry) => normalizeGateScriptDigest(entry))
      .filter((entry) => entry.name && entry.sha256 !== EMPTY_HASH)
      .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    capturedAt: typeof source.capturedAt === "string" ? source.capturedAt : "",
    capturedBy: typeof source.capturedBy === "string" ? source.capturedBy.trim() : "",
    idempotencyKey: typeof source.idempotencyKey === "string" ? source.idempotencyKey.trim() : "",
    runtimePolicyVersion: typeof source.runtimePolicyVersion === "string" && source.runtimePolicyVersion.trim()
      ? source.runtimePolicyVersion.trim()
      : "v1",
    runtimeStateSchemaVersion: Math.max(1, Number.parseInt(String(source.runtimeStateSchemaVersion ?? "8"), 10) || 8),
    enabledGateScripts,
    egressAllowlistHash: normalizeHash(source.egressAllowlistHash, EMPTY_HASH),
    killSwitchState: Boolean(source.killSwitchState),
    criticalModuleHashManifest: normalizeCriticalModuleManifest(source.criticalModuleHashManifest),
    policySnapshotHash: normalizeHash(source.policySnapshotHash, EMPTY_HASH),
    attestationHash: normalizeHash(source.attestationHash, EMPTY_HASH)
  });
}

function normalizeEvidenceArtifactRecord(value) {
  const source = isPlainObject(value) ? value : {};
  return canonicalize({
    file: typeof source.file === "string" ? source.file.trim() : "",
    sha256: normalizeHash(source.sha256, EMPTY_HASH)
  });
}

function normalizeCheckResults(value, requiredChecks) {
  const source = isPlainObject(value) ? value : {};
  const out = {};
  for (const key of requiredChecks) {
    const raw = typeof source[key] === "string" ? source[key].trim().toLowerCase() : "";
    out[key] = ["pass", "fail", "unknown"].includes(raw) ? raw : "unknown";
  }
  return canonicalize(out);
}

function normalizeEvidenceBundleRecord(value, requiredChecks) {
  const source = isPlainObject(value) ? value : {};
  const required = Array.isArray(requiredChecks) ? requiredChecks : ["phase2-gates", "mcp-policy", "phase6-policy", "phase7-policy"];
  const artifactManifest = Array.isArray(source.artifactManifest)
    ? source.artifactManifest
      .map((entry) => normalizeEvidenceArtifactRecord(entry))
      .filter((entry) => entry.file && entry.sha256 !== EMPTY_HASH)
      .sort((left, right) => left.file.localeCompare(right.file))
    : [];
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    builtAt: typeof source.builtAt === "string" ? source.builtAt : "",
    builtBy: typeof source.builtBy === "string" ? source.builtBy.trim() : "",
    idempotencyKey: typeof source.idempotencyKey === "string" ? source.idempotencyKey.trim() : "",
    asOfIso: typeof source.asOfIso === "string" ? source.asOfIso : "",
    attestationSequence: Math.max(1, parsePositiveInt(source.attestationSequence, 1)),
    attestationHash: normalizeHash(source.attestationHash, EMPTY_HASH),
    policySnapshotHash: normalizeHash(source.policySnapshotHash, EMPTY_HASH),
    requiredChecks: required,
    checkResults: normalizeCheckResults(source.checkResults, required),
    artifactManifest,
    freshnessHours: Math.max(0, Number(source.freshnessHours) || 0),
    bundleVersion: typeof source.bundleVersion === "string" && source.bundleVersion.trim() ? source.bundleVersion.trim() : "v1",
    bundleHash: normalizeHash(source.bundleHash, EMPTY_HASH)
  });
}

function normalizeReleaseGateDecisionRecord(value) {
  const source = isPlainObject(value) ? value : {};
  const targetSha = normalizeHash(source.targetSha, "");
  return canonicalize({
    sequence: Math.max(1, parsePositiveInt(source.sequence, 1)),
    decidedAt: typeof source.decidedAt === "string" ? source.decidedAt : "",
    decidedBy: typeof source.decidedBy === "string" ? source.decidedBy.trim() : "",
    targetRef: typeof source.targetRef === "string" ? source.targetRef.trim() : "",
    targetSha,
    decision: normalizeComplianceReleaseDecision(source.decision),
    reasonCode: normalizeComplianceReasonCode(source.reasonCode),
    approvalToken: typeof source.approvalToken === "string" ? source.approvalToken.trim() : "",
    idempotencyKey: typeof source.idempotencyKey === "string" ? source.idempotencyKey.trim() : "",
    decisionHash: normalizeHash(source.decisionHash, EMPTY_HASH),
    prevDecisionHash: normalizeHash(source.prevDecisionHash, ""),
    asOfIso: typeof source.asOfIso === "string" ? source.asOfIso.trim() : "",
    policySnapshotHash: normalizeHash(source.policySnapshotHash, EMPTY_HASH)
  });
}

function normalizeComplianceGovernanceState(value) {
  const source = isPlainObject(value) ? value : {};
  const activeReleasePolicy = normalizeComplianceActiveReleasePolicy(source.activeReleasePolicy);
  const requiredChecks = Array.isArray(activeReleasePolicy.requiredChecks) ? activeReleasePolicy.requiredChecks : [];

  const attestationSnapshots = Array.isArray(source.attestationSnapshots)
    ? source.attestationSnapshots
      .map((entry) => normalizeAttestationSnapshotRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const evidenceBundles = Array.isArray(source.evidenceBundles)
    ? source.evidenceBundles
      .map((entry) => normalizeEvidenceBundleRecord(entry, requiredChecks))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const releaseGates = Array.isArray(source.releaseGates)
    ? source.releaseGates
      .map((entry) => normalizeReleaseGateDecisionRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];

  const observedMaxAttestationSequence = attestationSnapshots.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0);
  const observedMaxEvidenceBundleSequence = evidenceBundles.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0);
  const observedMaxReleaseGateSequence = releaseGates.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0);

  return canonicalize({
    policyVersion: typeof source.policyVersion === "string" && source.policyVersion.trim() ? source.policyVersion.trim() : "v1",
    attestationSnapshots,
    evidenceBundles,
    releaseGates,
    activeReleasePolicy,
    decisionLedger: normalizeComplianceDecisionLedgerState(source.decisionLedger),
    operatorOverrideLedger: normalizeOperatorOverrideLedgerState(source.operatorOverrideLedger),
    operationalDecisionLedger: normalizeOperationalDecisionLedgerState(source.operationalDecisionLedger),
    nextAttestationSequence: Math.max(
      observedMaxAttestationSequence,
      Math.max(0, Number.parseInt(String(source.nextAttestationSequence ?? "0"), 10) || 0)
    ),
    nextEvidenceBundleSequence: Math.max(
      observedMaxEvidenceBundleSequence,
      Math.max(0, Number.parseInt(String(source.nextEvidenceBundleSequence ?? "0"), 10) || 0)
    ),
    nextReleaseGateSequence: Math.max(
      observedMaxReleaseGateSequence,
      Math.max(0, Number.parseInt(String(source.nextReleaseGateSequence ?? "0"), 10) || 0)
    )
  });
}

function normalizeExperimentGovernanceState(value) {
  const source = isPlainObject(value) ? value : {};
  const experiments = Array.isArray(source.experiments)
    ? source.experiments
      .map((entry) => normalizeExperimentRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const assignments = Array.isArray(source.assignments)
    ? source.assignments
      .map((entry) => normalizeAssignmentRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const analysisSnapshots = Array.isArray(source.analysisSnapshots)
    ? source.analysisSnapshots
      .map((entry) => normalizeAnalysisSnapshotRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const rolloutDecisions = Array.isArray(source.rolloutDecisions)
    ? source.rolloutDecisions
      .map((entry) => normalizeRolloutDecisionRecord(entry))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0))
    : [];
  const observedMaxExperimentSequence = experiments.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0);
  const observedMaxAssignmentSequence = assignments.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0);
  const observedMaxAnalysisSequence = analysisSnapshots.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0);
  const observedMaxRolloutDecisionSequence = rolloutDecisions.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0);

  return canonicalize({
    policyVersion: typeof source.policyVersion === "string" && source.policyVersion.trim() ? source.policyVersion.trim() : "v1",
    experiments,
    assignments,
    analysisSnapshots,
    rolloutDecisions,
    activeRolloutProfile: normalizeActiveRolloutProfile(source.activeRolloutProfile),
    decisionLedger: normalizeDecisionLedgerState(source.decisionLedger),
    nextExperimentSequence: Math.max(
      observedMaxExperimentSequence,
      Math.max(0, Number.parseInt(String(source.nextExperimentSequence ?? "0"), 10) || 0)
    ),
    nextAssignmentSequence: Math.max(
      observedMaxAssignmentSequence,
      Math.max(0, Number.parseInt(String(source.nextAssignmentSequence ?? "0"), 10) || 0)
    ),
    nextAnalysisSequence: Math.max(
      observedMaxAnalysisSequence,
      Math.max(0, Number.parseInt(String(source.nextAnalysisSequence ?? "0"), 10) || 0)
    ),
    nextRolloutDecisionSequence: Math.max(
      observedMaxRolloutDecisionSequence,
      Math.max(0, Number.parseInt(String(source.nextRolloutDecisionSequence ?? "0"), 10) || 0)
    )
  });
}

function buildDefaultV8State() {
  return {
    schemaVersion: 8,
    deterministicSerialization: true,
    lastDeterministicReplayAt: null,
    activeInitiatives: [],
    openLoops: [],
    agentHealth: {},
    circuitBreakerState: {},
    dailyTokenUsage: {},
    hydrationTimestamp: "1970-01-01T00:00:00.000Z",
    apiGovernance: {
      dayKey: "1970-01-01",
      global: {
        requestsToday: 0,
        tokensToday: 0
      },
      window: {
        minuteEpoch: 0,
        globalRequests: 0,
        perMcpRequests: {}
      },
      perMcpDaily: {},
      violations: {
        count: 0,
        lastViolationAt: null,
        lastViolationCode: null
      },
      mutation: {
        hourWindow: {
          hourEpoch: 0,
          publishes: 0
        },
        dayWindow: {
          dayKey: "1970-01-01",
          publishes: 0,
          writeTokens: 0
        },
        controlWindow: {
          minuteEpoch: 0,
          toggles: 0
        },
        accountedAttemptIds: {}
      }
    },
    researchIngestion: {
      nextSequence: 1,
      lastCommittedSequence: 0,
      hashVersion: "research-record-v1"
    },
    outboundMutation: {
      enabled: false,
      killSwitch: false,
      pendingPublications: [],
      committedPublications: [],
      lastMutationSequence: 0,
      lastControlToggleAt: null,
      lastControlSequence: 0,
      mutationLogTipHash: "0000000000000000000000000000000000000000000000000000000000000000"
    },
    rlhfWorkflows: buildDefaultRlhfWorkflowsState(),
    rlhfOutcomes: buildDefaultRlhfOutcomesState(),
    experimentGovernance: buildDefaultExperimentGovernanceState(),
    complianceGovernance: buildDefaultComplianceGovernanceState()
  };
}

function normalizeRuntimeState(raw) {
  const state = isPlainObject(raw) ? raw : buildDefaultV8State();
  if (Number(state.schemaVersion) !== 8) {
    const error = new Error(`Unsupported runtime state schemaVersion: ${state.schemaVersion}`);
    error.code = "RUNTIME_STATE_SCHEMA_UNSUPPORTED";
    throw error;
  }

  if (!isPlainObject(state.apiGovernance)) {
    state.apiGovernance = buildDefaultV8State().apiGovernance;
  }
  if (!isPlainObject(state.apiGovernance.global)) {
    state.apiGovernance.global = { requestsToday: 0, tokensToday: 0 };
  }
  if (!isPlainObject(state.apiGovernance.window)) {
    state.apiGovernance.window = { minuteEpoch: 0, globalRequests: 0, perMcpRequests: {} };
  }
  if (!isPlainObject(state.apiGovernance.window.perMcpRequests)) {
    state.apiGovernance.window.perMcpRequests = {};
  }
  if (!isPlainObject(state.apiGovernance.perMcpDaily)) {
    state.apiGovernance.perMcpDaily = {};
  }
  if (!isPlainObject(state.apiGovernance.violations)) {
    state.apiGovernance.violations = { count: 0, lastViolationAt: null, lastViolationCode: null };
  }
  if (!isPlainObject(state.apiGovernance.mutation)) {
    state.apiGovernance.mutation = buildDefaultV8State().apiGovernance.mutation;
  }
  if (!isPlainObject(state.apiGovernance.mutation.hourWindow)) {
    state.apiGovernance.mutation.hourWindow = { hourEpoch: 0, publishes: 0 };
  }
  if (!isPlainObject(state.apiGovernance.mutation.dayWindow)) {
    state.apiGovernance.mutation.dayWindow = { dayKey: "1970-01-01", publishes: 0, writeTokens: 0 };
  }
  if (!isPlainObject(state.apiGovernance.mutation.controlWindow)) {
    state.apiGovernance.mutation.controlWindow = { minuteEpoch: 0, toggles: 0 };
  }
  if (!isPlainObject(state.apiGovernance.mutation.accountedAttemptIds)) {
    state.apiGovernance.mutation.accountedAttemptIds = {};
  }

  if (!isPlainObject(state.researchIngestion)) {
    state.researchIngestion = { nextSequence: 1, lastCommittedSequence: 0, hashVersion: "research-record-v1" };
  }
  state.researchIngestion.nextSequence = Math.max(1, parsePositiveInt(state.researchIngestion.nextSequence, 1));
  state.researchIngestion.lastCommittedSequence = Math.max(0, parsePositiveInt(state.researchIngestion.lastCommittedSequence, 0));
  state.researchIngestion.hashVersion = typeof state.researchIngestion.hashVersion === "string"
    ? state.researchIngestion.hashVersion
    : "research-record-v1";

  if (!isPlainObject(state.outboundMutation)) {
    state.outboundMutation = buildDefaultV8State().outboundMutation;
  }
  state.outboundMutation.enabled = Boolean(state.outboundMutation.enabled);
  state.outboundMutation.killSwitch = Boolean(state.outboundMutation.killSwitch);
  if (!Array.isArray(state.outboundMutation.pendingPublications)) {
    state.outboundMutation.pendingPublications = [];
  }
  if (!Array.isArray(state.outboundMutation.committedPublications)) {
    state.outboundMutation.committedPublications = [];
  }
  state.outboundMutation.lastMutationSequence = Math.max(0, parsePositiveInt(state.outboundMutation.lastMutationSequence, 0));
  state.outboundMutation.lastControlSequence = Math.max(0, parsePositiveInt(state.outboundMutation.lastControlSequence, 0));
  state.outboundMutation.lastControlToggleAt = typeof state.outboundMutation.lastControlToggleAt === "string"
    ? state.outboundMutation.lastControlToggleAt
    : null;
  state.outboundMutation.mutationLogTipHash = typeof state.outboundMutation.mutationLogTipHash === "string"
    && /^[a-f0-9]{64}$/.test(state.outboundMutation.mutationLogTipHash)
    ? state.outboundMutation.mutationLogTipHash
    : "0000000000000000000000000000000000000000000000000000000000000000";

  if (!isPlainObject(state.rlhfWorkflows)) {
    state.rlhfWorkflows = buildDefaultRlhfWorkflowsState();
  }
  if (!Array.isArray(state.rlhfWorkflows.drafts)) {
    state.rlhfWorkflows.drafts = [];
  }
  if (!Array.isArray(state.rlhfWorkflows.candidateQueue)) {
    state.rlhfWorkflows.candidateQueue = [];
  }
  if (!Array.isArray(state.rlhfWorkflows.reviewQueue)) {
    state.rlhfWorkflows.reviewQueue = [];
  }
  state.rlhfWorkflows.drafts = state.rlhfWorkflows.drafts
    .map((entry) => normalizeRlhfDraftRecord(entry))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  state.rlhfWorkflows.candidateQueue = state.rlhfWorkflows.candidateQueue
    .map((entry) => normalizeRlhfCandidateQueueRecord(entry))
    .sort((left, right) => Number(left.queueSequence || 0) - Number(right.queueSequence || 0));
  state.rlhfWorkflows.reviewQueue = state.rlhfWorkflows.reviewQueue
    .map((entry) => normalizeRlhfReviewQueueRecord(entry))
    .sort((left, right) => Number(left.queueSequence || 0) - Number(right.queueSequence || 0));

  const observedMaxDraftSequence = state.rlhfWorkflows.drafts.reduce(
    (max, draft) => Math.max(max, Number(draft.sequence || 0)),
    0
  );
  const observedMaxQueueSequence = [...state.rlhfWorkflows.candidateQueue, ...state.rlhfWorkflows.reviewQueue].reduce(
    (max, queueRecord) => Math.max(max, Number(queueRecord.queueSequence || 0)),
    0
  );

  state.rlhfWorkflows.nextDraftSequence = Math.max(
    observedMaxDraftSequence,
    Math.max(0, Number.parseInt(String(state.rlhfWorkflows.nextDraftSequence ?? "0"), 10) || 0)
  );
  state.rlhfWorkflows.nextQueueSequence = Math.max(
    observedMaxQueueSequence,
    Math.max(0, Number.parseInt(String(state.rlhfWorkflows.nextQueueSequence ?? "0"), 10) || 0)
  );
  state.rlhfWorkflows.lastAutomationRunAt = typeof state.rlhfWorkflows.lastAutomationRunAt === "string"
    ? state.rlhfWorkflows.lastAutomationRunAt
    : "";
  state.rlhfWorkflows.generatorVersion = typeof state.rlhfWorkflows.generatorVersion === "string"
    && state.rlhfWorkflows.generatorVersion.trim()
    ? state.rlhfWorkflows.generatorVersion.trim()
    : "v1";

  if (!isPlainObject(state.rlhfOutcomes)) {
    state.rlhfOutcomes = buildDefaultRlhfOutcomesState();
  }
  if (!Array.isArray(state.rlhfOutcomes.records)) {
    state.rlhfOutcomes.records = [];
  }
  if (!Array.isArray(state.rlhfOutcomes.portfolioSnapshots)) {
    state.rlhfOutcomes.portfolioSnapshots = [];
  }
  state.rlhfOutcomes.records = state.rlhfOutcomes.records
    .map((entry) => normalizeRlhfOutcomeRecord(entry))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  state.rlhfOutcomes.portfolioSnapshots = state.rlhfOutcomes.portfolioSnapshots
    .map((entry) => normalizePortfolioSnapshot(entry))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  state.rlhfOutcomes.calibration = normalizeCalibration(state.rlhfOutcomes.calibration);

  const observedMaxOutcomeSequence = state.rlhfOutcomes.records.reduce(
    (max, record) => Math.max(max, Number(record.sequence || 0)),
    0
  );
  const observedMaxSnapshotSequence = state.rlhfOutcomes.portfolioSnapshots.reduce(
    (max, snapshot) => Math.max(max, Number(snapshot.sequence || 0)),
    0
  );
  state.rlhfOutcomes.nextOutcomeSequence = Math.max(
    observedMaxOutcomeSequence,
    Math.max(0, Number.parseInt(String(state.rlhfOutcomes.nextOutcomeSequence ?? "0"), 10) || 0)
  );
  state.rlhfOutcomes.nextSnapshotSequence = Math.max(
    observedMaxSnapshotSequence,
    Math.max(0, Number.parseInt(String(state.rlhfOutcomes.nextSnapshotSequence ?? "0"), 10) || 0)
  );
  state.rlhfOutcomes.chainHeadHash = normalizeHash(state.rlhfOutcomes.chainHeadHash, EMPTY_HASH);
  state.rlhfOutcomes.chainHeadSequence = Math.max(
    0,
    Number.parseInt(String(state.rlhfOutcomes.chainHeadSequence ?? "0"), 10) || 0
  );

  state.experimentGovernance = normalizeExperimentGovernanceState(state.experimentGovernance);
  state.complianceGovernance = normalizeComplianceGovernanceState(state.complianceGovernance);

  return state;
}

function dayKeyFromMsUtc(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function minuteEpochFromMsUtc(epochMs) {
  return Math.floor(Number(epochMs) / 60000);
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    const body = await fs.readFile(filePath, "utf8");
    return JSON.parse(body);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function ensureDirectoryFor(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeAtomic(filePath, body, options = {}) {
  const nowMs = options.nowMs;
  const nowValue = typeof nowMs === "function" ? nowMs() : runtimeNowMs();
  await ensureDirectoryFor(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${nowValue}-${randomHex(8)}`;

  const tmpHandle = await fs.open(tmpPath, "w", 0o600);
  await tmpHandle.writeFile(body, "utf8");
  await tmpHandle.sync();
  await tmpHandle.close();

  await fs.rename(tmpPath, filePath);

  const fileHandle = await fs.open(filePath, "r");
  await fileHandle.sync();
  await fileHandle.close();

  const dirHandle = await fs.open(path.dirname(filePath), "r");
  await dirHandle.sync();
  await dirHandle.close();
}

function parseNdjsonLines(raw, options = {}) {
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
      const error = new Error(`Invalid NDJSON record at line ${i + 1}`);
      error.code = "API_GOVERNANCE_NDJSON_CORRUPTED";
      error.details = { line: i + 1 };
      throw error;
    }
  }

  return {
    records,
    recoveredTrailingLine
  };
}

async function loadNdjsonRecords(filePath, options = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseNdjsonLines(raw, options).records;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function appendNdjsonRecordsAtomic(filePath, records) {
  if (!Array.isArray(records) || records.length === 0) {
    return;
  }
  const existing = await loadNdjsonRecords(filePath);
  const merged = [...existing, ...records];
  const lines = merged.map((entry) => JSON.stringify(canonicalize(entry))).join("\n");
  const body = lines.length > 0 ? `${lines}\n` : "";
  await writeAtomic(filePath, body);
}

async function ensureNdjsonIntegrity(filePath, options = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseNdjsonLines(raw, { allowRecoverTrailingLine: true });
    if (!parsed.recoveredTrailingLine) {
      return { repaired: false };
    }

    const repairedBody = parsed.records.map((entry) => JSON.stringify(canonicalize(entry))).join("\n");
    const payload = repairedBody.length > 0 ? `${repairedBody}\n` : "";
    await writeAtomic(filePath, payload, { nowMs: options.nowMs });
    if (options.logger && typeof options.logger.warn === "function") {
      options.logger.warn({
        event: "api_governance_ndjson_repaired",
        reason: "truncated_trailing_record_removed"
      });
    }
    return { repaired: true };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { repaired: false };
    }
    throw error;
  }
}

function maxSequence(records) {
  let max = 0;
  for (const item of records) {
    const value = Number(item && item.sequence);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  return max;
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function createApiGovernance(options = {}) {
  const statePath = path.resolve(options.statePath || DEFAULT_STATE_PATH);
  const researchPath = path.resolve(options.researchNdjsonPath || DEFAULT_RESEARCH_NDJSON_PATH);
  const timeProvider =
    options.timeProvider &&
    typeof options.timeProvider === "object" &&
    typeof options.timeProvider.nowMs === "function" &&
    typeof options.timeProvider.nowIso === "function"
      ? options.timeProvider
      : { nowMs: runtimeNowMs, nowIso: runtimeNowIso };
  const limits = {
    perMcpRequestsPerMinute: parsePositiveInt(options.perMcpRequestsPerMinute, DEFAULT_LIMITS.perMcpRequestsPerMinute),
    globalRequestsPerMinute: parsePositiveInt(options.globalRequestsPerMinute, DEFAULT_LIMITS.globalRequestsPerMinute),
    dailyTokenBudget: parsePositiveInt(options.dailyTokenBudget, DEFAULT_LIMITS.dailyTokenBudget),
    dailyRequestLimit: parsePositiveInt(options.dailyRequestLimit, DEFAULT_LIMITS.dailyRequestLimit),
    mutationPublishesPerHour: parsePositiveInt(options.mutationPublishesPerHour, DEFAULT_LIMITS.mutationPublishesPerHour),
    mutationPublishesPerDay: parsePositiveInt(options.mutationPublishesPerDay, DEFAULT_LIMITS.mutationPublishesPerDay),
    mutationWriteTokensPerDay: parsePositiveInt(options.mutationWriteTokensPerDay, DEFAULT_LIMITS.mutationWriteTokensPerDay),
    mutationControlTogglesPerMinute: parsePositiveInt(options.mutationControlTogglesPerMinute, DEFAULT_LIMITS.mutationControlTogglesPerMinute),
    mutationAttemptIdTtlMs: parsePositiveInt(options.mutationAttemptIdTtlMs, DEFAULT_LIMITS.mutationAttemptIdTtlMs)
  };
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {} };
  const circuitBreaker = createCircuitBreaker({
    enabled: true,
    failureThreshold: 1,
    successThreshold: 1,
    timeout: parsePositiveInt(options.circuitTimeoutMs, 60000)
  });
  const runTransaction = createStateTransactionWrapper();

  let manualCircuitReason = "";
  let ndjsonIntegrityCheckPromise = null;

  function nowMs() {
    return Number(timeProvider.nowMs());
  }

  function nowIso() {
    return String(timeProvider.nowIso());
  }

  async function ensureNdjsonIntegrityOnce() {
    if (!ndjsonIntegrityCheckPromise) {
      ndjsonIntegrityCheckPromise = ensureNdjsonIntegrity(researchPath, {
        logger,
        nowMs
      }).catch((error) => {
        ndjsonIntegrityCheckPromise = null;
        throw error;
      });
    }
    return ndjsonIntegrityCheckPromise;
  }

  async function loadState() {
    await ensureNdjsonIntegrityOnce();

    const raw = await readJsonOrDefault(statePath, buildDefaultV8State());
    const state = normalizeRuntimeState(raw);

    // Sequence reconciliation is source-of-truth by append-only NDJSON.
    const records = await loadNdjsonRecords(researchPath);
    const observedMax = maxSequence(records);
    if (observedMax < Number(state.researchIngestion.lastCommittedSequence || 0)) {
      const error = new Error("State lastCommittedSequence is ahead of persisted NDJSON records");
      error.code = "API_GOVERNANCE_SEQUENCE_STATE_AHEAD";
      error.details = {
        lastCommittedSequence: Number(state.researchIngestion.lastCommittedSequence || 0),
        observedMax
      };
      throw error;
    }
    if (observedMax >= state.researchIngestion.nextSequence) {
      state.researchIngestion.nextSequence = observedMax + 1;
      state.researchIngestion.lastCommittedSequence = observedMax;
    }

    return state;
  }

  async function persistState(state) {
    await writeAtomic(statePath, canonicalStringify(state), { nowMs });
  }

  function recordViolation(state, code, correlationId) {
    state.apiGovernance.violations.count = parsePositiveInt(state.apiGovernance.violations.count, 0) + 1;
    state.apiGovernance.violations.lastViolationAt = nowIso();
    state.apiGovernance.violations.lastViolationCode = code;
    circuitBreaker.recordFailure("api-governance");
    logger.warn({
      correlationId,
      event: "api_governance_violation",
      code
    });
  }

  function assertLimit(state, condition, code, message, correlationId) {
    if (condition) {
      return;
    }
    recordViolation(state, code, correlationId);
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function applyUsageCounters(state, input) {
    const correlationId = typeof input.correlationId === "string" ? input.correlationId : "";
    const mcp = normalizeSlug(input.mcp);
    const tokens = parsePositiveInt(input.tokens, 0);
    if (!mcp) {
      const error = new Error("mcp is required");
      error.code = "API_GOVERNANCE_MCP_REQUIRED";
      throw error;
    }
    if (tokens < 0) {
      const error = new Error("tokens must be >= 0");
      error.code = "API_GOVERNANCE_INVALID_TOKENS";
      throw error;
    }

    if (manualCircuitReason) {
      const error = new Error("API governance circuit is manually tripped");
      error.code = "API_GOVERNANCE_CIRCUIT_OPEN";
      error.details = { reason: manualCircuitReason };
      throw error;
    }

    const gate = circuitBreaker.checkBeforeRequest("api-governance");
    if (!gate.allowed) {
      const error = new Error("API governance circuit breaker is open");
      error.code = "API_GOVERNANCE_CIRCUIT_OPEN";
      throw error;
    }

    const currentMs = nowMs();
    const currentDay = dayKeyFromMsUtc(currentMs);
    const currentMinute = minuteEpochFromMsUtc(currentMs);

    if (state.apiGovernance.dayKey !== currentDay) {
      state.apiGovernance.dayKey = currentDay;
      state.apiGovernance.global.requestsToday = 0;
      state.apiGovernance.global.tokensToday = 0;
      state.apiGovernance.perMcpDaily = {};
    }

    if (Number(state.apiGovernance.window.minuteEpoch) !== currentMinute) {
      state.apiGovernance.window.minuteEpoch = currentMinute;
      state.apiGovernance.window.globalRequests = 0;
      state.apiGovernance.window.perMcpRequests = {};
    }

    const perMcpMinuteCount = parsePositiveInt(state.apiGovernance.window.perMcpRequests[mcp], 0);
    const globalMinuteCount = parsePositiveInt(state.apiGovernance.window.globalRequests, 0);
    const currentRequestsToday = parsePositiveInt(state.apiGovernance.global.requestsToday, 0);
    const currentTokensToday = parsePositiveInt(state.apiGovernance.global.tokensToday, 0);

    assertLimit(
      state,
      perMcpMinuteCount + 1 <= limits.perMcpRequestsPerMinute,
      "API_GOVERNANCE_MCP_RPM_EXCEEDED",
      `Per-MCP RPM exceeded for ${mcp}`,
      correlationId
    );
    assertLimit(
      state,
      globalMinuteCount + 1 <= limits.globalRequestsPerMinute,
      "API_GOVERNANCE_GLOBAL_RPM_EXCEEDED",
      "Global RPM exceeded",
      correlationId
    );
    assertLimit(
      state,
      currentRequestsToday + 1 <= limits.dailyRequestLimit,
      "API_GOVERNANCE_DAILY_REQUESTS_EXCEEDED",
      "Daily request limit exceeded",
      correlationId
    );
    assertLimit(
      state,
      currentTokensToday + tokens <= limits.dailyTokenBudget,
      "API_GOVERNANCE_DAILY_TOKENS_EXCEEDED",
      "Daily token budget exceeded",
      correlationId
    );

    state.apiGovernance.window.perMcpRequests[mcp] = perMcpMinuteCount + 1;
    state.apiGovernance.window.globalRequests = globalMinuteCount + 1;
    state.apiGovernance.global.requestsToday = currentRequestsToday + 1;
    state.apiGovernance.global.tokensToday = currentTokensToday + tokens;

    const perMcpDaily = isPlainObject(state.apiGovernance.perMcpDaily[mcp]) ? state.apiGovernance.perMcpDaily[mcp] : { requests: 0, tokens: 0 };
    perMcpDaily.requests = parsePositiveInt(perMcpDaily.requests, 0) + 1;
    perMcpDaily.tokens = parsePositiveInt(perMcpDaily.tokens, 0) + tokens;
    state.apiGovernance.perMcpDaily[mcp] = perMcpDaily;

    circuitBreaker.recordSuccess("api-governance");
    return { mcp, tokens };
  }

  function pruneMutationAttemptAccounting(state, currentMs) {
    const accounted = state.apiGovernance.mutation.accountedAttemptIds;
    const ttlMs = limits.mutationAttemptIdTtlMs;
    for (const key of Object.keys(accounted)) {
      const value = Number(accounted[key]);
      if (!Number.isFinite(value) || value + ttlMs < currentMs) {
        delete accounted[key];
      }
    }
  }

  function applyMutationAccounting(state, input = {}) {
    const attemptId = typeof input.attemptId === "string" ? input.attemptId.trim() : "";
    if (!attemptId) {
      const error = new Error("mutation attemptId is required");
      error.code = "API_GOVERNANCE_MUTATION_ATTEMPT_REQUIRED";
      throw error;
    }
    const accounted = state.apiGovernance.mutation.accountedAttemptIds;
    const currentMs = nowMs();
    pruneMutationAttemptAccounting(state, currentMs);
    if (Object.prototype.hasOwnProperty.call(accounted, attemptId)) {
      return { counted: false };
    }

    const kind = typeof input.kind === "string" ? input.kind : "publish";
    const tokens = Math.max(0, parsePositiveInt(input.tokens, 0));
    const currentHour = Math.floor(currentMs / 3600000);
    const currentMinute = minuteEpochFromMsUtc(currentMs);
    const currentDay = dayKeyFromMsUtc(currentMs);

    if (kind === "publish") {
      if (Number(state.apiGovernance.mutation.hourWindow.hourEpoch) !== currentHour) {
        state.apiGovernance.mutation.hourWindow.hourEpoch = currentHour;
        state.apiGovernance.mutation.hourWindow.publishes = 0;
      }
      if (String(state.apiGovernance.mutation.dayWindow.dayKey) !== currentDay) {
        state.apiGovernance.mutation.dayWindow.dayKey = currentDay;
        state.apiGovernance.mutation.dayWindow.publishes = 0;
        state.apiGovernance.mutation.dayWindow.writeTokens = 0;
      }

      const nextHourlyPublishes = parsePositiveInt(state.apiGovernance.mutation.hourWindow.publishes, 0) + 1;
      const nextDailyPublishes = parsePositiveInt(state.apiGovernance.mutation.dayWindow.publishes, 0) + 1;
      const nextDailyWriteTokens = parsePositiveInt(state.apiGovernance.mutation.dayWindow.writeTokens, 0) + tokens;

      assertLimit(
        state,
        nextHourlyPublishes <= limits.mutationPublishesPerHour,
        "API_GOVERNANCE_MUTATION_HOURLY_PUBLISHES_EXCEEDED",
        "Mutation publishes/hour exceeded",
        input.correlationId
      );
      assertLimit(
        state,
        nextDailyPublishes <= limits.mutationPublishesPerDay,
        "API_GOVERNANCE_MUTATION_DAILY_PUBLISHES_EXCEEDED",
        "Mutation publishes/day exceeded",
        input.correlationId
      );
      assertLimit(
        state,
        nextDailyWriteTokens <= limits.mutationWriteTokensPerDay,
        "API_GOVERNANCE_MUTATION_DAILY_WRITE_TOKENS_EXCEEDED",
        "Mutation write tokens/day exceeded",
        input.correlationId
      );

      state.apiGovernance.mutation.hourWindow.publishes = nextHourlyPublishes;
      state.apiGovernance.mutation.dayWindow.publishes = nextDailyPublishes;
      state.apiGovernance.mutation.dayWindow.writeTokens = nextDailyWriteTokens;
    } else if (kind === "control_toggle") {
      if (Number(state.apiGovernance.mutation.controlWindow.minuteEpoch) !== currentMinute) {
        state.apiGovernance.mutation.controlWindow.minuteEpoch = currentMinute;
        state.apiGovernance.mutation.controlWindow.toggles = 0;
      }
      const nextToggles = parsePositiveInt(state.apiGovernance.mutation.controlWindow.toggles, 0) + 1;
      assertLimit(
        state,
        nextToggles <= limits.mutationControlTogglesPerMinute,
        "API_GOVERNANCE_MUTATION_CONTROL_TOGGLES_EXCEEDED",
        "Mutation control toggles/minute exceeded",
        input.correlationId
      );
      state.apiGovernance.mutation.controlWindow.toggles = nextToggles;
    }

    accounted[attemptId] = currentMs;
    return { counted: true };
  }

  async function withGovernanceTransaction(handler, metadata = {}) {
    return runTransaction(async () => {
      const state = await loadState();
      const pendingRecords = [];
      let highestAllocatedSequence = Number(state.researchIngestion.lastCommittedSequence || 0);

      const tx = {
        state,
        allocateSequence() {
          const next = parsePositiveInt(state.researchIngestion.nextSequence, 1);
          state.researchIngestion.nextSequence = next + 1;
          highestAllocatedSequence = Math.max(highestAllocatedSequence, next);
          return next;
        },
        appendResearchRecord(record) {
          if (!isPlainObject(record)) {
            const error = new Error("record must be an object");
            error.code = "API_GOVERNANCE_RECORD_REQUIRED";
            throw error;
          }
          pendingRecords.push(canonicalize(record));
        },
        applyUsage(input) {
          return applyUsageCounters(state, input);
        },
        applyMutationAccounting(input) {
          return applyMutationAccounting(state, input);
        }
      };

      const result = await handler(tx);

      if (pendingRecords.length > 0) {
        await appendNdjsonRecordsAtomic(researchPath, pendingRecords);
        state.researchIngestion.lastCommittedSequence = highestAllocatedSequence;
      }

      state.lastDeterministicReplayAt = nowIso();
      await persistState(state);

      logger.info({
        correlationId: typeof metadata.correlationId === "string" ? metadata.correlationId : "",
        event: "api_governance_transaction_committed",
        records: pendingRecords.length
      });

      return result;
    });
  }

  async function checkAndRecord(input = {}) {
    return withGovernanceTransaction(async (tx) => {
      const applied = tx.applyUsage(input);
      return {
        ok: true,
        mcp: applied.mcp,
        tokens: applied.tokens
      };
    }, { correlationId: input.correlationId });
  }

  async function snapshot() {
    const state = await loadState();
    const daily = {
      dayKey: state.apiGovernance.dayKey,
      global: state.apiGovernance.global,
      perMcpDaily: state.apiGovernance.perMcpDaily,
      violations: state.apiGovernance.violations,
      mutation: state.apiGovernance.mutation
    };
    return canonicalize(daily);
  }

  async function readState() {
    const state = await loadState();
    return canonicalize(state);
  }

  async function writeDailySummary(outPath) {
    const target = path.resolve(outPath || path.join(process.cwd(), "audit", "evidence", "phase4", "daily-usage-summary.json"));
    const data = await snapshot();
    const payload = {
      generatedAt: nowIso(),
      digest: sha256(JSON.stringify(data)),
      data
    };
    await writeAtomic(target, canonicalStringify(payload));
    return { ok: true, path: target };
  }

  function tripCircuit(reason) {
    manualCircuitReason = typeof reason === "string" && reason.trim() ? reason.trim() : "manual_trip";
    circuitBreaker.recordFailure("api-governance");
    return {
      ok: true,
      code: "API_GOVERNANCE_CIRCUIT_TRIPPED",
      reason: manualCircuitReason
    };
  }

  async function loadResearchRecords() {
    await ensureNdjsonIntegrityOnce();
    const records = await loadNdjsonRecords(researchPath);
    return records
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  }

  return Object.freeze({
    limits,
    statePath,
    researchPath,
    checkAndRecord,
    withGovernanceTransaction,
    tripCircuit,
    snapshot,
    readState,
    writeDailySummary,
    loadResearchRecords
  });
}

module.exports = {
  DEFAULT_LIMITS,
  createApiGovernance
};
