"use strict";

const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA = "phase21-publisher-adapter-manifest-v1";
const PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA = "phase21-publisher-adapter-snapshot-v1";
const PHASE21_RELEASE_APPROVAL_SCHEMA = "phase21-release-approval-v1";
const PHASE21_RELEASE_METADATA_SCHEMA = "phase21-release-metadata-v1";

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function normalizeRelativePath(inputPath) {
  const raw = safeString(inputPath).replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || raw.startsWith("../") || raw.includes("/../") || raw === "..") {
    const error = new Error(`invalid relative path '${raw || "(empty)"}'`);
    error.code = "PHASE21_ADAPTER_RELATIVE_PATH_INVALID";
    throw error;
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    const error = new Error(`invalid normalized relative path '${normalized || "(empty)"}'`);
    error.code = "PHASE21_ADAPTER_RELATIVE_PATH_INVALID";
    throw error;
  }
  return normalized;
}

function normalizeBundleSubmissionPath(platformTarget, inputPath) {
  const normalizedPlatform = safeString(platformTarget);
  const relative = normalizeRelativePath(inputPath);
  const full = path.posix.normalize(`submission/${normalizedPlatform}/${relative}`);
  const expectedPrefix = `submission/${normalizedPlatform}/`;
  if (!full.startsWith(expectedPrefix)) {
    const error = new Error(`adapter file must stay under ${expectedPrefix}: ${full}`);
    error.code = "PHASE21_ADAPTER_PATH_ESCAPE";
    throw error;
  }
  return full;
}

function sortedUniqueStrings(values) {
  return Array.from(new Set(asStringArray(values))).sort((left, right) => left.localeCompare(right));
}

function buildDeterministicHash(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function createInputSnapshotSeed(options = {}) {
  const offer = asPlainObject(options.offer);
  const sourceContext = asPlainObject(options.source_context || options.sourceContext);
  const targetConfig = asPlainObject(options.target_config || options.targetConfig);
  return canonicalize({
    adapter: {
      adapter_id: safeString(options.adapter_id || options.adapterId),
      adapter_version: safeString(options.adapter_version || options.adapterVersion),
      platform_target: safeString(options.platform_target || options.platformTarget)
    },
    offer: {
      offer_id: safeString(offer.offer_id),
      offer_title: safeString(offer.offer_title),
      product_line: safeString(offer.product_line),
      tier: safeString(offer.tier),
      source_kind: safeString(offer.source_kind),
      source_id: safeString(offer.source_id),
      build_id: safeString(offer.build_id),
      platform_targets: sortedUniqueStrings(offer.platform_targets)
    },
    source_context: {
      source_kind: safeString(sourceContext.source_kind),
      source_id: safeString(sourceContext.source_id),
      build_id: safeString(sourceContext.build_id),
      description: safeString(sourceContext.description),
      metadata: canonicalize(asPlainObject(sourceContext.metadata)),
      phase20_status: canonicalize(asPlainObject(sourceContext.phase20_status)),
      warnings: sortedUniqueStrings(sourceContext.warnings)
    },
    target_config: {
      manual_only: targetConfig.manual_only === true,
      required_artifact_placeholders: sortedUniqueStrings(targetConfig.required_artifact_placeholders),
      checklist_requirements: sortedUniqueStrings(targetConfig.checklist_requirements),
      copy_block_requirements: sortedUniqueStrings(targetConfig.copy_block_requirements)
    }
  });
}

function buildInputSnapshotHash(options = {}) {
  return buildDeterministicHash(createInputSnapshotSeed(options));
}

function buildPublisherAdapterSnapshotHash(summary = {}) {
  return buildDeterministicHash(summary);
}

module.exports = {
  PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA,
  PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
  PHASE21_RELEASE_APPROVAL_SCHEMA,
  PHASE21_RELEASE_METADATA_SCHEMA,
  buildDeterministicHash,
  buildInputSnapshotHash,
  buildPublisherAdapterSnapshotHash,
  createInputSnapshotSeed,
  normalizeBundleSubmissionPath,
  normalizeRelativePath,
  sortedUniqueStrings
};
