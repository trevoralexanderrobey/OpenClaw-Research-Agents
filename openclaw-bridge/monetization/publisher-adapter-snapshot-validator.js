"use strict";

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const {
  PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
  normalizeRelativePath
} = require("./publisher-adapter-contract.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function validateSha(value, code) {
  const normalized = safeString(value);
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    const error = new Error("publisher adapter snapshot requires sha256 values");
    error.code = code;
    throw error;
  }
  return normalized.toLowerCase();
}

function validatePathUnderTarget(filePath, platformTarget, code) {
  const normalized = normalizeRelativePath(filePath);
  const expectedPrefix = `submission/${platformTarget}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    const error = new Error(`publisher adapter path must stay under ${expectedPrefix}`);
    error.code = code;
    throw error;
  }
  return normalized;
}

function assertSortedUnique(values, code) {
  const sorted = values.slice().sort((left, right) => left.localeCompare(right));
  const unique = Array.from(new Set(sorted));
  if (JSON.stringify(values) !== JSON.stringify(sorted) || JSON.stringify(values) !== JSON.stringify(unique)) {
    const error = new Error("publisher adapter snapshot arrays must be sorted and unique");
    error.code = code;
    throw error;
  }
}

function validateTargetSummary(entry = {}) {
  const summary = asPlainObject(entry);
  const platformTarget = safeString(summary.platform_target);
  if (!platformTarget) {
    const error = new Error("publisher adapter snapshot target entries require platform_target");
    error.code = "PHASE21_ADAPTER_SNAPSHOT_TARGET_REQUIRED";
    throw error;
  }
  if (summary.manual_only !== true) {
    const error = new Error(`publisher adapter snapshot target '${platformTarget}' must keep manual_only=true`);
    error.code = "PHASE21_ADAPTER_SNAPSHOT_MANUAL_ONLY_REQUIRED";
    throw error;
  }
  const generatedHashes = asArray(summary.generated_files_sha256).map((item) => {
    const normalized = asPlainObject(item);
    return canonicalize({
      file: validatePathUnderTarget(normalized.file, platformTarget, "PHASE21_ADAPTER_SNAPSHOT_FILE_INVALID"),
      sha256: validateSha(normalized.sha256, "PHASE21_ADAPTER_SNAPSHOT_FILE_HASH_INVALID")
    });
  });
  if (generatedHashes.length === 0) {
    const error = new Error(`publisher adapter snapshot target '${platformTarget}' requires generated_files_sha256`);
    error.code = "PHASE21_ADAPTER_SNAPSHOT_FILESET_REQUIRED";
    throw error;
  }
  const files = generatedHashes.map((item) => item.file);
  assertSortedUnique(files, "PHASE21_ADAPTER_SNAPSHOT_FILESET_ORDER");
  return canonicalize({
    adapter_id: safeString(summary.adapter_id),
    adapter_manifest: validatePathUnderTarget(summary.adapter_manifest, platformTarget, "PHASE21_ADAPTER_SNAPSHOT_MANIFEST_PATH_INVALID"),
    adapter_version: safeString(summary.adapter_version),
    generated_files_sha256: generatedHashes,
    input_snapshot_hash: validateSha(summary.input_snapshot_hash, "PHASE21_ADAPTER_SNAPSHOT_INPUT_HASH_INVALID"),
    manifest_sha256: validateSha(summary.manifest_sha256, "PHASE21_ADAPTER_SNAPSHOT_MANIFEST_HASH_INVALID"),
    manual_only: true,
    platform_target: platformTarget
  });
}

function validatePublisherAdapterSnapshot(input = {}, options = {}) {
  const snapshot = asPlainObject(input);
  if (safeString(snapshot.schema_version) !== PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA) {
    const error = new Error(`publisher adapter snapshot schema_version must be ${PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA}`);
    error.code = "PHASE21_ADAPTER_SNAPSHOT_SCHEMA_INVALID";
    throw error;
  }
  const targets = asArray(snapshot.targets).map((entry) => validateTargetSummary(entry));
  if (targets.length === 0) {
    const error = new Error("publisher adapter snapshot requires targets");
    error.code = "PHASE21_ADAPTER_SNAPSHOT_TARGETS_REQUIRED";
    throw error;
  }
  const targetNames = targets.map((entry) => entry.platform_target);
  assertSortedUnique(targetNames, "PHASE21_ADAPTER_SNAPSHOT_TARGETS_ORDER");

  const expectedTargets = asStringArray(options.expected_targets || options.expectedTargets).sort((left, right) => left.localeCompare(right));
  if (expectedTargets.length > 0 && JSON.stringify(targetNames) !== JSON.stringify(expectedTargets)) {
    const error = new Error("publisher adapter snapshot targets do not match expected platform targets");
    error.code = "PHASE21_ADAPTER_SNAPSHOT_TARGETS_MISMATCH";
    throw error;
  }
  return canonicalize({
    publisher_adapter_snapshot_hash: validateSha(snapshot.publisher_adapter_snapshot_hash, "PHASE21_ADAPTER_SNAPSHOT_HASH_INVALID"),
    schema_version: PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
    targets
  });
}

module.exports = {
  validatePublisherAdapterSnapshot
};
