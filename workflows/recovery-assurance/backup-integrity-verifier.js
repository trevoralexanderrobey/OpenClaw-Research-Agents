"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString, canonicalize, hashFile } = require("../governance-automation/common.js");
const { canonicalHash, computeChainHash, normalizeArtifacts } = require("./recovery-common.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 11 backup integrity verifier error"));
  error.code = String(code || "PHASE11_BACKUP_INTEGRITY_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function stripManifestHashes(manifest) {
  const source = manifest && typeof manifest === "object" ? manifest : {};
  return canonicalize({
    ...source,
    manifest_id: "",
    manifest_hash: "",
    chain_hash: ""
  });
}

function createBackupIntegrityVerifier(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };

  function verifyBackupIntegrity(input = {}) {
    const sourceInput = input && typeof input === "object" ? input : {};
    const rootDir = path.resolve(safeString(sourceInput.rootDir) || process.cwd());
    const manifest = sourceInput.manifest && typeof sourceInput.manifest === "object"
      ? sourceInput.manifest
      : sourceInput;

    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw makeError("PHASE11_BACKUP_INTEGRITY_INPUT_INVALID", "manifest object is required");
    }

    const violations = [];
    const missingArtifacts = [];

    const expectedManifestHash = canonicalHash(stripManifestHashes(manifest));
    const actualManifestHash = safeString(manifest.manifest_hash);
    if (actualManifestHash !== expectedManifestHash) {
      violations.push(canonicalize({
        code: "manifest_hash_mismatch",
        message: "Manifest hash does not match canonical recomputation",
        expected: expectedManifestHash,
        actual: actualManifestHash
      }));
    }

    const expectedChainHash = computeChainHash(
      safeString(manifest.prev_manifest_hash),
      expectedManifestHash
    );
    const actualChainHash = safeString(manifest.chain_hash);
    if (actualChainHash !== expectedChainHash) {
      violations.push(canonicalize({
        code: "manifest_chain_hash_mismatch",
        message: "Manifest chain hash does not match expected continuity",
        expected: expectedChainHash,
        actual: actualChainHash
      }));
    }

    if (sourceInput.checkpoint && typeof sourceInput.checkpoint === "object") {
      const checkpointHash = safeString(sourceInput.checkpoint.checkpoint_hash);
      if (checkpointHash && checkpointHash !== safeString(manifest.checkpoint_hash)) {
        violations.push(canonicalize({
          code: "checkpoint_hash_mismatch",
          message: "Manifest checkpoint hash does not match provided checkpoint",
          expected: checkpointHash,
          actual: safeString(manifest.checkpoint_hash)
        }));
      }
    }

    const artifacts = normalizeArtifacts(manifest.artifacts || []);
    for (const artifact of artifacts) {
      const file = safeString(artifact.file);
      const expected = safeString(artifact.sha256);
      const abs = path.resolve(rootDir, file);

      if (!fs.existsSync(abs)) {
        missingArtifacts.push(file);
        violations.push(canonicalize({
          code: "artifact_missing",
          file,
          message: "Manifest artifact is missing"
        }));
        continue;
      }

      const actual = hashFile(abs);
      if (safeString(actual).toLowerCase() !== expected.toLowerCase()) {
        violations.push(canonicalize({
          code: "artifact_hash_mismatch",
          file,
          message: "Artifact hash mismatch",
          expected,
          actual
        }));
      }
    }

    const sortedViolations = violations
      .slice()
      .sort((left, right) => {
        const leftCode = safeString(left.code);
        const rightCode = safeString(right.code);
        if (leftCode !== rightCode) {
          return leftCode.localeCompare(rightCode);
        }
        return safeString(left.file).localeCompare(safeString(right.file));
      });

    const result = canonicalize({
      valid: sortedViolations.length === 0,
      tamper_detected: sortedViolations.length > 0,
      missing_artifacts: missingArtifacts.slice().sort((left, right) => left.localeCompare(right)),
      violations: sortedViolations
    });

    if (!result.valid) {
      logger.warn({
        event: "phase11_backup_integrity_failed",
        violations: result.violations.length,
        missing_artifacts: result.missing_artifacts.length
      });
    } else {
      logger.info({
        event: "phase11_backup_integrity_verified",
        artifacts: artifacts.length
      });
    }

    return result;
  }

  return Object.freeze({
    verifyBackupIntegrity
  });
}

module.exports = {
  createBackupIntegrityVerifier,
  stripManifestHashes
};
