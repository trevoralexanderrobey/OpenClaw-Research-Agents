"use strict";

const crypto = require("node:crypto");
const { z } = require("zod");

const EXPERIMENT_STATUS_VALUES = Object.freeze([
  "draft",
  "approved",
  "running",
  "paused",
  "completed",
  "archived"
]);

const ROLLOUT_DECISION_VALUES = Object.freeze(["adopt", "hold", "rollback"]);
const ROLLOUT_REASON_CODE_VALUES = Object.freeze([
  "uplift_positive",
  "insufficient_power",
  "guardrail_breach",
  "operator_override"
]);

const DECISION_HASH_PREFIX = "phase7-decision-v1|";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
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
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 7 schema validation error"));
  error.code = String(code || "PHASE7_SCHEMA_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

const CalibrationWeightsSchema = z.object({
  complexity: z.number().min(0).max(1),
  monetization: z.number().min(0).max(1),
  qualitySignal: z.number().min(0).max(1)
}).strict().superRefine((value, ctx) => {
  const sum = Number(value.complexity) + Number(value.monetization) + Number(value.qualitySignal);
  if (Math.abs(sum - 1) > 0.000001) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "calibrationWeights must sum to 1"
    });
  }
});

const ExperimentArmSchema = z.object({
  templateVersion: z.string().min(1).max(32),
  calibrationWeights: CalibrationWeightsSchema
}).strict();

const ExperimentWindowSchema = z.object({
  startIso: z.string().min(1).max(64),
  endIso: z.string().min(1).max(64),
  minFinalizedOutcomes: z.number().int().min(1)
}).strict();

const ExperimentGuardrailsSchema = z.object({
  maxRejectRateDelta: z.number().min(0).max(1),
  minQualityScore: z.number().int().min(0).max(100)
}).strict();

const ExperimentRecordSchema = z.object({
  sequence: z.number().int().min(1),
  createdAt: z.string().min(1).max(64),
  createdBy: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  status: z.enum(EXPERIMENT_STATUS_VALUES),
  objective: z.string().min(1).max(2000),
  treatment: ExperimentArmSchema,
  control: ExperimentArmSchema,
  window: ExperimentWindowSchema,
  guardrails: ExperimentGuardrailsSchema,
  analysisPlanVersion: z.string().min(1).max(32),
  notes: z.string().max(8000),
  splitBasisPoints: z.object({
    control: z.number().int().min(0).max(10000),
    treatment: z.number().int().min(0).max(10000)
  }).strict().superRefine((value, ctx) => {
    if ((Number(value.control) + Number(value.treatment)) !== 10000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "splitBasisPoints must sum to 10000"
      });
    }
  }),
  preRegistrationLockHash: z.string().regex(/^$|^[a-f0-9]{64}$/)
}).strict();

const ExperimentAssignmentRecordSchema = z.object({
  sequence: z.number().int().min(1),
  experimentSequence: z.number().int().min(1),
  draftSequence: z.number().int().min(1),
  assignedAt: z.string().min(1).max(64),
  assignedBy: z.string().min(1).max(128),
  bucket: z.number().int().min(0).max(9999),
  cohort: z.enum(["control", "treatment"]),
  idempotencyKey: z.string().min(1).max(256)
}).strict();

const DomainUpliftSchema = z.record(z.string(), z.number().finite()).default({});

const ExperimentAnalysisMetricsSchema = z.object({
  acceptanceRateDelta: z.number().finite(),
  reviseRequestRateDelta: z.number().finite(),
  meanQualityScoreDelta: z.number().finite(),
  medianQualityScoreDelta: z.number().finite(),
  domainUplift: DomainUpliftSchema
}).strict();

const ExperimentAnalysisSnapshotSchema = z.object({
  sequence: z.number().int().min(1),
  experimentSequence: z.number().int().min(1),
  capturedAt: z.string().min(1).max(64),
  capturedBy: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(256),
  sampleSize: z.number().int().min(0),
  treatmentSampleSize: z.number().int().min(0),
  controlSampleSize: z.number().int().min(0),
  metrics: ExperimentAnalysisMetricsSchema,
  recommendation: z.enum(["adopt", "hold", "rollback"]),
  reasonCode: z.enum(ROLLOUT_REASON_CODE_VALUES),
  guardrailBreaches: z.array(z.string().min(1).max(128)).max(32),
  analysisPlanVersion: z.string().min(1).max(32)
}).strict();

const RolloutDecisionRecordWithoutHashSchema = z.object({
  sequence: z.number().int().min(1),
  experimentSequence: z.number().int().min(1),
  decidedAt: z.string().min(1).max(64),
  decidedBy: z.string().min(1).max(128),
  decision: z.enum(ROLLOUT_DECISION_VALUES),
  reasonCode: z.enum(ROLLOUT_REASON_CODE_VALUES),
  approvalToken: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(256),
  prevDecisionHash: z.string().regex(/^$|^[a-f0-9]{64}$/)
}).strict();

const RolloutDecisionRecordSchema = RolloutDecisionRecordWithoutHashSchema.extend({
  decisionHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

const DecisionLedgerRecordSchema = z.object({
  sequence: z.number().int().min(1),
  decisionSequence: z.number().int().min(1),
  recordedAt: z.string().min(1).max(64),
  prevDecisionHash: z.string().regex(/^$|^[a-f0-9]{64}$/),
  decisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  chainHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

function computeDecisionHash(decisionWithoutHash) {
  const parsed = RolloutDecisionRecordWithoutHashSchema.parse(decisionWithoutHash);
  return sha256(`${DECISION_HASH_PREFIX}${canonicalStringify(parsed)}`);
}

function computeDecisionChainHash(prevDecisionHash, decisionHash) {
  const prev = typeof prevDecisionHash === "string" && /^[a-f0-9]{64}$/.test(prevDecisionHash)
    ? prevDecisionHash
    : "";
  const current = typeof decisionHash === "string" && /^[a-f0-9]{64}$/.test(decisionHash)
    ? decisionHash
    : null;
  if (!current) {
    throw makeError("PHASE7_DECISION_HASH_INVALID", "decisionHash must be a 64-char sha256 hex string");
  }
  return sha256(`${prev}|${current}`);
}

module.exports = {
  EXPERIMENT_STATUS_VALUES,
  ROLLOUT_DECISION_VALUES,
  ROLLOUT_REASON_CODE_VALUES,
  DECISION_HASH_PREFIX,
  CalibrationWeightsSchema,
  ExperimentArmSchema,
  ExperimentWindowSchema,
  ExperimentGuardrailsSchema,
  ExperimentRecordSchema,
  ExperimentAssignmentRecordSchema,
  ExperimentAnalysisMetricsSchema,
  ExperimentAnalysisSnapshotSchema,
  RolloutDecisionRecordWithoutHashSchema,
  RolloutDecisionRecordSchema,
  DecisionLedgerRecordSchema,
  canonicalize,
  canonicalStringify,
  sha256,
  makeError,
  computeDecisionHash,
  computeDecisionChainHash
};
