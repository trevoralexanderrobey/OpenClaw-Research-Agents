"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString, canonicalize, hashFile } = require("../governance-automation/common.js");
const {
  RECOVERY_SCHEMA_VERSION,
  validateRecoveryPayload
} = require("./recovery-schema.js");
const {
  canonicalHash,
  computeChainHash,
  deriveDeterministicId,
  normalizeArtifacts,
  summarizeArtifacts
} = require("./recovery-common.js");

const DEFAULT_EVIDENCE_FILES = Object.freeze([
  "audit/evidence/phase8/hash-manifest.json",
  "audit/evidence/governance-automation/hash-manifest.json",
  "audit/evidence/observability/hash-manifest.json"
]);

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 11 checkpoint coordinator error"));
  error.code = String(code || "PHASE11_CHECKPOINT_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function normalizeFileList(inputFiles = []) {
  const source = Array.isArray(inputFiles) ? inputFiles : [];
  const deduped = new Set(
    source
      .map((entry) => safeString(entry).split(path.sep).join("/"))
      .filter(Boolean)
  );
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function readArtifacts(rootDir, files) {
  const artifacts = [];

  for (const rel of files) {
    const abs = path.resolve(rootDir, rel);
    if (!fs.existsSync(abs)) {
      continue;
    }

    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      continue;
    }

    artifacts.push(canonicalize({
      file: rel,
      sha256: hashFile(abs),
      size_bytes: Number(stat.size || 0)
    }));
  }

  return normalizeArtifacts(artifacts, rootDir);
}

function summarizeRuntime(state) {
  const source = state && typeof state === "object" ? state : {};
  const compliance = source.complianceGovernance && typeof source.complianceGovernance === "object"
    ? source.complianceGovernance
    : {};

  const overrideLedger = compliance.operatorOverrideLedger && typeof compliance.operatorOverrideLedger === "object"
    ? compliance.operatorOverrideLedger
    : {};
  const operationalLedger = compliance.operationalDecisionLedger && typeof compliance.operationalDecisionLedger === "object"
    ? compliance.operationalDecisionLedger
    : {};
  const decisionLedger = compliance.decisionLedger && typeof compliance.decisionLedger === "object"
    ? compliance.decisionLedger
    : {};

  const outboundMutation = source.outboundMutation && typeof source.outboundMutation === "object"
    ? source.outboundMutation
    : {};

  return canonicalize({
    runtime_state_schema_version: Number(source.schemaVersion || 0),
    outbound_mutation: {
      enabled: outboundMutation.enabled === true,
      kill_switch: outboundMutation.killSwitch === true
    },
    compliance_ledger: {
      decision_chain_head: safeString(decisionLedger.chainHead),
      override_chain_head: safeString(overrideLedger.chainHead),
      operational_chain_head: safeString(operationalLedger.chainHead),
      decision_records: Array.isArray(decisionLedger.records) ? decisionLedger.records.length : 0,
      override_records: Array.isArray(overrideLedger.records) ? overrideLedger.records.length : 0,
      operational_records: Array.isArray(operationalLedger.records) ? operationalLedger.records.length : 0
    }
  });
}

function createCheckpointCoordinator(options = {}) {
  const apiGovernance = options.apiGovernance;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const fallbackTimeProvider = { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : fallbackTimeProvider;

  if (!apiGovernance || typeof apiGovernance.readState !== "function") {
    throw makeError("PHASE11_CHECKPOINT_CONFIG_INVALID", "apiGovernance.readState is required");
  }

  async function createCheckpoint(input = {}) {
    const rootDir = path.resolve(safeString(input.rootDir) || process.cwd());
    const timestamp = safeString(input.timestamp) || String(timeProvider.nowIso());
    const previousCheckpointHash = safeString(input.prev_checkpoint_hash || input.previous_checkpoint_hash);
    const evidenceFiles = normalizeFileList([
      ...DEFAULT_EVIDENCE_FILES,
      ...normalizeFileList(input.evidence_files)
    ]);

    const runtimeState = input.runtime_state && typeof input.runtime_state === "object"
      ? input.runtime_state
      : await apiGovernance.readState();

    const artifacts = readArtifacts(rootDir, evidenceFiles);
    const runtimeSummary = summarizeRuntime(runtimeState);

    const baseCheckpoint = canonicalize({
      schema_version: RECOVERY_SCHEMA_VERSION,
      checkpoint_id: "",
      timestamp,
      checkpoint_hash: "",
      chain_hash: "",
      prev_checkpoint_hash: previousCheckpointHash,
      manifest_ref: "",
      evidence_scope: canonicalize({
        phases: ["phase8", "phase9", "phase10"],
        root_dir: rootDir
      }),
      artifacts,
      artifact_summary: summarizeArtifacts(artifacts),
      runtime_summary: runtimeSummary
    });

    const checkpointHash = canonicalHash(baseCheckpoint);
    const checkpointId = deriveDeterministicId("CHK", timestamp, checkpointHash, 12);
    const chainHash = computeChainHash(previousCheckpointHash, checkpointHash);
    const manifestRef = `audit/evidence/recovery-assurance/${checkpointId}-manifest.json`;

    const checkpoint = canonicalize({
      ...baseCheckpoint,
      checkpoint_id: checkpointId,
      checkpoint_hash: checkpointHash,
      chain_hash: chainHash,
      manifest_ref: manifestRef
    });

    const validation = validateRecoveryPayload("checkpoint", checkpoint);
    if (!validation.valid) {
      throw makeError("PHASE11_CHECKPOINT_SCHEMA_INVALID", "checkpoint payload failed schema validation", {
        violations: validation.violations
      });
    }

    logger.info({
      event: "phase11_checkpoint_created",
      checkpoint_id: checkpointId,
      artifacts: checkpoint.artifacts.length
    });

    return canonicalize({
      checkpoint_id: checkpointId,
      checkpoint_hash: checkpointHash,
      manifest_ref: manifestRef,
      checkpoint
    });
  }

  return Object.freeze({
    createCheckpoint
  });
}

module.exports = {
  createCheckpointCoordinator,
  DEFAULT_EVIDENCE_FILES,
  summarizeRuntime
};
