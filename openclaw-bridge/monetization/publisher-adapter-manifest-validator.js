"use strict";

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const {
  PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA,
  normalizeRelativePath
} = require("./publisher-adapter-contract.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateSha(value, code) {
  const normalized = safeString(value);
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    const error = new Error("publisher adapter manifest requires sha256 values");
    error.code = code;
    throw error;
  }
  return normalized.toLowerCase();
}

function validatePathUnderTarget(filePath, platformTarget, code) {
  const normalized = normalizeRelativePath(filePath);
  const expectedPrefix = `submission/${platformTarget}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    const error = new Error(`publisher adapter file must stay under ${expectedPrefix}`);
    error.code = code;
    throw error;
  }
  return normalized;
}

function assertSortedUnique(values, code) {
  const sorted = values.slice().sort((left, right) => left.localeCompare(right));
  const unique = Array.from(new Set(sorted));
  if (JSON.stringify(values) !== JSON.stringify(sorted) || JSON.stringify(values) !== JSON.stringify(unique)) {
    const error = new Error("publisher adapter manifest file arrays must be sorted and unique");
    error.code = code;
    throw error;
  }
}

function validatePublisherAdapterManifest(input = {}, options = {}) {
  const manifest = asPlainObject(input);
  const expectedPlatform = safeString(options.platform_target || options.platformTarget);
  if (safeString(manifest.schema_version) !== PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA) {
    const error = new Error(`publisher adapter manifest schema_version must be ${PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA}`);
    error.code = "PHASE21_ADAPTER_MANIFEST_SCHEMA_INVALID";
    throw error;
  }
  const platformTarget = safeString(manifest.platform_target);
  if (!platformTarget) {
    const error = new Error("publisher adapter manifest requires platform_target");
    error.code = "PHASE21_ADAPTER_MANIFEST_TARGET_REQUIRED";
    throw error;
  }
  if (expectedPlatform && expectedPlatform !== platformTarget) {
    const error = new Error(`publisher adapter manifest target mismatch: expected '${expectedPlatform}' got '${platformTarget}'`);
    error.code = "PHASE21_ADAPTER_MANIFEST_TARGET_MISMATCH";
    throw error;
  }
  if (!safeString(manifest.adapter_id) || !safeString(manifest.adapter_version)) {
    const error = new Error("publisher adapter manifest requires adapter_id and adapter_version");
    error.code = "PHASE21_ADAPTER_MANIFEST_ADAPTER_FIELDS_REQUIRED";
    throw error;
  }
  if (manifest.manual_only !== true) {
    const error = new Error("publisher adapter manifest manual_only must be true");
    error.code = "PHASE21_ADAPTER_MANIFEST_MANUAL_ONLY_REQUIRED";
    throw error;
  }

  const generatedFiles = asArray(manifest.generated_files).map((entry) => validatePathUnderTarget(entry, platformTarget, "PHASE21_ADAPTER_MANIFEST_GENERATED_FILE_INVALID"));
  if (generatedFiles.length === 0) {
    const error = new Error("publisher adapter manifest requires generated_files");
    error.code = "PHASE21_ADAPTER_MANIFEST_GENERATED_FILES_REQUIRED";
    throw error;
  }
  assertSortedUnique(generatedFiles, "PHASE21_ADAPTER_MANIFEST_GENERATED_FILES_ORDER");

  const generatedHashes = asArray(manifest.generated_files_sha256).map((entry) => {
    const item = asPlainObject(entry);
    return canonicalize({
      file: validatePathUnderTarget(item.file, platformTarget, "PHASE21_ADAPTER_MANIFEST_HASH_FILE_INVALID"),
      sha256: validateSha(item.sha256, "PHASE21_ADAPTER_MANIFEST_HASH_INVALID")
    });
  });
  if (generatedHashes.length !== generatedFiles.length) {
    const error = new Error("publisher adapter manifest generated_files_sha256 must match generated_files");
    error.code = "PHASE21_ADAPTER_MANIFEST_HASH_COUNT_MISMATCH";
    throw error;
  }
  const hashFiles = generatedHashes.map((entry) => entry.file);
  assertSortedUnique(hashFiles, "PHASE21_ADAPTER_MANIFEST_HASH_ORDER");
  if (JSON.stringify(generatedFiles) !== JSON.stringify(hashFiles)) {
    const error = new Error("publisher adapter manifest generated_files and generated_files_sha256 files must match exactly");
    error.code = "PHASE21_ADAPTER_MANIFEST_HASH_FILESET_MISMATCH";
    throw error;
  }

  return canonicalize({
    adapter_id: safeString(manifest.adapter_id),
    adapter_version: safeString(manifest.adapter_version),
    generated_files: generatedFiles,
    generated_files_sha256: generatedHashes,
    input_snapshot_hash: validateSha(manifest.input_snapshot_hash, "PHASE21_ADAPTER_MANIFEST_SNAPSHOT_HASH_INVALID"),
    manual_only: true,
    platform_target: platformTarget,
    schema_version: PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA
  });
}

module.exports = {
  validatePublisherAdapterManifest
};
