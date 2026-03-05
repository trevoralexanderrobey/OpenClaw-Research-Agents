"use strict";

const { safeString, canonicalize } = require("../governance-automation/common.js");
const { RECOVERY_SCHEMA_VERSION, validateRecoveryPayload } = require("./recovery-schema.js");
const {
  canonicalHash,
  computeChainHash,
  deriveDeterministicId,
  normalizeArtifacts,
  summarizeArtifacts
} = require("./recovery-common.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 11 backup manifest manager error"));
  error.code = String(code || "PHASE11_MANIFEST_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function createBackupManifestManager(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function buildBackupManifest(checkpointInput = {}) {
    const checkpoint = checkpointInput && checkpointInput.checkpoint && typeof checkpointInput.checkpoint === "object"
      ? checkpointInput.checkpoint
      : checkpointInput;

    const checkpointId = safeString(checkpoint.checkpoint_id);
    const checkpointHash = safeString(checkpoint.checkpoint_hash);
    if (!checkpointId || !checkpointHash) {
      throw makeError("PHASE11_MANIFEST_CHECKPOINT_REQUIRED", "checkpoint_id and checkpoint_hash are required");
    }

    const artifacts = normalizeArtifacts(checkpoint.artifacts || []);
    const timestamp = safeString(checkpoint.timestamp) || "1970-01-01T00:00:00.000Z";
    const previousManifestHash = safeString(checkpointInput.prev_manifest_hash || checkpointInput.previous_manifest_hash);

    const baseManifest = canonicalize({
      schema_version: RECOVERY_SCHEMA_VERSION,
      manifest_id: "",
      manifest_hash: "",
      chain_hash: "",
      timestamp,
      checkpoint_id: checkpointId,
      checkpoint_hash: checkpointHash,
      prev_manifest_hash: previousManifestHash,
      policy_version: safeString(checkpointInput.policy_version) || "phase11-policy-v1",
      provenance: canonicalize({
        source: "phase11.recovery-assurance",
        generated_without_external_egress: true,
        generated_without_autonomous_execution: true
      }),
      artifacts,
      artifact_summary: summarizeArtifacts(artifacts),
      chain_references: canonicalize({
        prev_checkpoint_hash: safeString(checkpoint.prev_checkpoint_hash),
        checkpoint_chain_hash: safeString(checkpoint.chain_hash)
      })
    });

    const manifestHash = canonicalHash(baseManifest);
    const manifestId = deriveDeterministicId("MAN", timestamp, manifestHash, 12);
    const chainHash = computeChainHash(previousManifestHash, manifestHash);

    const manifest = canonicalize({
      ...baseManifest,
      manifest_id: manifestId,
      manifest_hash: manifestHash,
      chain_hash: chainHash
    });

    const validation = validateRecoveryPayload("backup_manifest", manifest);
    if (!validation.valid) {
      throw makeError("PHASE11_MANIFEST_SCHEMA_INVALID", "backup manifest failed schema validation", {
        violations: validation.violations
      });
    }

    logger.info({
      event: "phase11_backup_manifest_built",
      manifest_id: manifestId,
      checkpoint_id: checkpointId,
      artifacts: artifacts.length
    });

    return canonicalize({
      manifest,
      manifest_hash: manifestHash
    });
  }

  return Object.freeze({
    buildBackupManifest
  });
}

module.exports = {
  createBackupManifestManager
};
