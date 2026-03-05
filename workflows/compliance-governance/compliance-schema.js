"use strict";

const crypto = require("node:crypto");
const { z } = require("zod");

const RELEASE_GATE_DECISION_VALUES = Object.freeze(["allow", "block", "hold"]);
const RELEASE_GATE_REASON_CODE_VALUES = Object.freeze([
  "all_checks_passed",
  "missing_evidence",
  "integrity_mismatch",
  "policy_violation",
  "operator_override"
]);

const CHECK_STATUS_VALUES = Object.freeze(["pass", "fail", "unknown"]);

const ATTESTATION_HASH_PREFIX = "phase8-attestation-v1|";
const BUNDLE_HASH_PREFIX = "phase8-bundle-v1|";
const DECISION_HASH_PREFIX = "phase8-decision-v1|";

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
  const error = new Error(String(message || "Phase 8 schema validation error"));
  error.code = String(code || "PHASE8_SCHEMA_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

const HashHex64Schema = z.string().regex(/^[a-f0-9]{64}$/);
const OptionalHashHex64Schema = z.string().regex(/^$|^[a-f0-9]{64}$/);

const GateScriptDigestSchema = z.object({
  name: z.string().min(1).max(256),
  sha256: HashHex64Schema
}).strict();

const ModuleDigestManifestSchema = z.record(z.string().min(1).max(512), HashHex64Schema);

const AttestationSnapshotWithoutHashSchema = z.object({
  sequence: z.number().int().min(1),
  capturedAt: z.string().min(1).max(64),
  capturedBy: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(256),
  runtimePolicyVersion: z.string().min(1).max(32),
  runtimeStateSchemaVersion: z.number().int().min(1),
  enabledGateScripts: z.array(GateScriptDigestSchema).max(256),
  egressAllowlistHash: HashHex64Schema,
  killSwitchState: z.boolean(),
  criticalModuleHashManifest: ModuleDigestManifestSchema,
  policySnapshotHash: HashHex64Schema
}).strict();

const AttestationSnapshotRecordSchema = AttestationSnapshotWithoutHashSchema.extend({
  attestationHash: HashHex64Schema
}).strict();

const EvidenceArtifactSchema = z.object({
  file: z.string().min(1).max(512),
  sha256: HashHex64Schema
}).strict();

const EvidenceBundleWithoutHashSchema = z.object({
  sequence: z.number().int().min(1),
  builtAt: z.string().min(1).max(64),
  builtBy: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(256),
  asOfIso: z.string().min(1).max(64),
  attestationSequence: z.number().int().min(1),
  attestationHash: HashHex64Schema,
  policySnapshotHash: HashHex64Schema,
  requiredChecks: z.array(z.string().min(1).max(128)).max(32),
  checkResults: z.record(z.string().min(1).max(128), z.enum(CHECK_STATUS_VALUES)),
  artifactManifest: z.array(EvidenceArtifactSchema).max(1024),
  freshnessHours: z.number().min(0),
  bundleVersion: z.literal("v1")
}).strict();

const EvidenceBundleRecordSchema = EvidenceBundleWithoutHashSchema.extend({
  bundleHash: HashHex64Schema
}).strict();

const ReleaseGateDecisionRecordWithoutHashSchema = z.object({
  sequence: z.number().int().min(1),
  decidedAt: z.string().min(1).max(64),
  decidedBy: z.string().min(1).max(128),
  targetRef: z.string().min(1).max(512),
  targetSha: HashHex64Schema,
  decision: z.enum(RELEASE_GATE_DECISION_VALUES),
  reasonCode: z.enum(RELEASE_GATE_REASON_CODE_VALUES),
  approvalToken: z.string().min(1).max(256),
  idempotencyKey: z.string().min(1).max(256),
  prevDecisionHash: OptionalHashHex64Schema,
  asOfIso: z.string().max(64).default(""),
  policySnapshotHash: HashHex64Schema
}).strict();

const ReleaseGateDecisionRecordSchema = ReleaseGateDecisionRecordWithoutHashSchema.extend({
  decisionHash: HashHex64Schema
}).strict();

const ComplianceDecisionLedgerRecordSchema = z.object({
  sequence: z.number().int().min(1),
  decisionSequence: z.number().int().min(1),
  recordedAt: z.string().min(1).max(64),
  prevDecisionHash: OptionalHashHex64Schema,
  decisionHash: HashHex64Schema,
  chainHash: HashHex64Schema
}).strict();

function computeAttestationHash(attestationWithoutHash) {
  const parsed = AttestationSnapshotWithoutHashSchema.parse(attestationWithoutHash);
  return sha256(`${ATTESTATION_HASH_PREFIX}${canonicalStringify(parsed)}`);
}

function computeBundleHash(bundleWithoutHash) {
  const parsed = EvidenceBundleWithoutHashSchema.parse(bundleWithoutHash);
  return sha256(`${BUNDLE_HASH_PREFIX}${canonicalStringify(parsed)}`);
}

function computeReleaseDecisionHash(decisionWithoutHash) {
  const parsed = ReleaseGateDecisionRecordWithoutHashSchema.parse(decisionWithoutHash);
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
    throw makeError("PHASE8_DECISION_HASH_INVALID", "decisionHash must be a 64-char sha256 hex string");
  }
  return sha256(`${prev}|${current}`);
}

module.exports = {
  RELEASE_GATE_DECISION_VALUES,
  RELEASE_GATE_REASON_CODE_VALUES,
  CHECK_STATUS_VALUES,
  ATTESTATION_HASH_PREFIX,
  BUNDLE_HASH_PREFIX,
  DECISION_HASH_PREFIX,
  GateScriptDigestSchema,
  ModuleDigestManifestSchema,
  AttestationSnapshotWithoutHashSchema,
  AttestationSnapshotRecordSchema,
  EvidenceArtifactSchema,
  EvidenceBundleWithoutHashSchema,
  EvidenceBundleRecordSchema,
  ReleaseGateDecisionRecordWithoutHashSchema,
  ReleaseGateDecisionRecordSchema,
  ComplianceDecisionLedgerRecordSchema,
  canonicalize,
  canonicalStringify,
  sha256,
  makeError,
  computeAttestationHash,
  computeBundleHash,
  computeReleaseDecisionHash,
  computeDecisionChainHash
};
