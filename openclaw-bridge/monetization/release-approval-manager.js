"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");
const {
  PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
  PHASE21_RELEASE_METADATA_SCHEMA,
  buildPublisherAdapterSnapshotHash,
  normalizeRelativePath
} = require("./publisher-adapter-contract.js");
const { validatePublisherAdapterManifest } = require("./publisher-adapter-manifest-validator.js");
const { validatePublisherAdapterSnapshot } = require("./publisher-adapter-snapshot-validator.js");
const {
  PHASE21_PUBLISHER_ADAPTER_STATUS_SCHEMA,
  validatePhase21ReleaseApproval
} = require("./phase21-release-approval-validator.js");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function relativeFrom(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];
}

function collectBundleFiles(bundleDir) {
  const files = [];
  const stack = [bundleDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const rel = relativeFrom(bundleDir, fullPath);
      if (["manifest.json", "checksums.txt", "release-approval.json"].includes(rel)) {
        continue;
      }
      files.push(canonicalize({
        file: rel,
        sha256: hashFile(fullPath)
      }));
    }
  }
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

function computeBundleHash(bundleDir) {
  const files = collectBundleFiles(bundleDir);
  return sha256(`phase19-release-bundle-v1|${JSON.stringify(canonicalize(files))}`);
}

function validateDatasetPhase20State(offer = {}) {
  const sourceStatus = asPlainObject(offer.source_status);
  const validationStatus = safeString(sourceStatus.validation_status || offer.validation_status) || "failed";
  const qualityStatus = safeString(sourceStatus.quality_status || offer.quality_status) || "failed";
  const licenseState = safeString(sourceStatus.license_state || offer.license_state) || "blocked";
  const commercializationReady = sourceStatus.commercialization_ready === true || offer.commercialization_ready === true;
  if (safeString(offer.source_kind) !== "dataset") {
    return canonicalize({
      commercialization_ready: commercializationReady,
      license_state: licenseState,
      quality_status: qualityStatus,
      validation_status: validationStatus
    });
  }
  if (validationStatus !== "passed") {
    const error = new Error("Dataset bundle cannot be approved because validation_status is not passed");
    error.code = "PHASE20_RELEASE_DATASET_VALIDATION_FAILED";
    throw error;
  }
  if (qualityStatus !== "passed") {
    const error = new Error("Dataset bundle cannot be approved because quality_status is not passed");
    error.code = "PHASE20_RELEASE_DATASET_QUALITY_FAILED";
    throw error;
  }
  if (!licenseState || licenseState === "blocked") {
    const error = new Error("Dataset bundle cannot be approved because license review is blocked");
    error.code = "PHASE20_RELEASE_DATASET_LICENSE_BLOCKED";
    throw error;
  }
  if (licenseState === "review_required" && offer.explicit_build_selected !== true) {
    const error = new Error("Dataset bundle requires explicit build selection for review_required datasets");
    error.code = "PHASE20_RELEASE_DATASET_REVIEW_REQUIRED_EXPLICIT";
    throw error;
  }
  if (commercializationReady !== true && licenseState !== "review_required") {
    const error = new Error("Dataset bundle is not commercialization-ready");
    error.code = "PHASE20_RELEASE_DATASET_NOT_COMMERCIALIZATION_READY";
    throw error;
  }
  return canonicalize({
    commercialization_ready: commercializationReady,
    license_state: licenseState,
    quality_status: qualityStatus,
    validation_status: validationStatus
  });
}

function validateManifest(bundleDir) {
  const manifestPath = path.join(bundleDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const expected = Array.isArray(manifest.files) ? manifest.files.map((entry) => canonicalize({
    file: safeString(entry.file),
    sha256: safeString(entry.sha256)
  })).sort((left, right) => left.file.localeCompare(right.file)) : [];
  const current = collectBundleFiles(bundleDir);
  if (JSON.stringify(expected) !== JSON.stringify(current)) {
    const error = new Error("Release bundle no longer matches manifest.json");
    error.code = "PHASE19_RELEASE_MANIFEST_MISMATCH";
    throw error;
  }
  return expected;
}

function isPhase21Bundle(metadata = {}) {
  const normalized = asPlainObject(metadata);
  return safeString(normalized.schema_version) === PHASE21_RELEASE_METADATA_SCHEMA
    || normalized.publisher_adapter_required === true;
}

function buildValidatedAdapterStatus(bundleDir, offer, metadata, platformTargets) {
  const offerTargets = asStringArray(offer.platform_targets);
  const snapshot = validatePublisherAdapterSnapshot(asPlainObject(metadata.publisher_adapter_snapshot), {
    expected_targets: offerTargets
  });
  const metadataSnapshotHash = safeString(metadata.publisher_adapter_snapshot_hash);
  if (metadataSnapshotHash && metadataSnapshotHash !== safeString(snapshot.publisher_adapter_snapshot_hash)) {
    const error = new Error("metadata publisher_adapter_snapshot_hash does not match publisher_adapter_snapshot");
    error.code = "PHASE21_RELEASE_ADAPTER_SNAPSHOT_METADATA_HASH_MISMATCH";
    throw error;
  }

  const platformConfig = asPlainObject(asPlainObject(platformTargets).platform_targets);
  const recomputedTargets = [];
  for (const targetName of offerTargets) {
    const summary = snapshot.targets.find((entry) => safeString(entry.platform_target) === targetName);
    if (!summary) {
      const error = new Error(`publisher adapter snapshot is missing target '${targetName}'`);
      error.code = "PHASE21_RELEASE_ADAPTER_TARGET_SUMMARY_MISSING";
      throw error;
    }
    const manifestPath = path.join(bundleDir, normalizeRelativePath(summary.adapter_manifest).split("/").join(path.sep));
    if (!fs.existsSync(manifestPath)) {
      const error = new Error(`publisher adapter manifest missing for target '${targetName}'`);
      error.code = "PHASE21_RELEASE_ADAPTER_MANIFEST_MISSING";
      throw error;
    }
    const manifest = validatePublisherAdapterManifest(readJson(manifestPath), {
      platform_target: targetName
    });
    if (safeString(summary.adapter_id) !== safeString(manifest.adapter_id)
      || safeString(summary.adapter_version) !== safeString(manifest.adapter_version)
      || safeString(summary.input_snapshot_hash) !== safeString(manifest.input_snapshot_hash)) {
      const error = new Error(`publisher adapter summary mismatch for target '${targetName}'`);
      error.code = "PHASE21_RELEASE_ADAPTER_SUMMARY_MISMATCH";
      throw error;
    }

    for (const fileHash of manifest.generated_files_sha256) {
      const filePath = path.join(bundleDir, normalizeRelativePath(fileHash.file).split("/").join(path.sep));
      if (!fs.existsSync(filePath)) {
        const error = new Error(`publisher adapter generated file missing for target '${targetName}': ${fileHash.file}`);
        error.code = "PHASE21_RELEASE_ADAPTER_GENERATED_FILE_MISSING";
        throw error;
      }
      const actualSha = hashFile(filePath);
      if (actualSha !== safeString(fileHash.sha256)) {
        const error = new Error(`publisher adapter generated file hash mismatch for target '${targetName}': ${fileHash.file}`);
        error.code = "PHASE21_RELEASE_ADAPTER_GENERATED_FILE_HASH_MISMATCH";
        throw error;
      }
    }
    if (safeString(summary.manifest_sha256) !== hashFile(manifestPath)) {
      const error = new Error(`publisher adapter manifest hash mismatch for target '${targetName}'`);
      error.code = "PHASE21_RELEASE_ADAPTER_MANIFEST_HASH_MISMATCH";
      throw error;
    }
    const requiredPlaceholders = asStringArray(asPlainObject(platformConfig[targetName]).required_artifact_placeholders);
    for (const placeholder of requiredPlaceholders) {
      const expectedPath = normalizeRelativePath(`submission/${targetName}/${placeholder}`);
      if (!manifest.generated_files.includes(expectedPath)) {
        const error = new Error(`publisher adapter output for '${targetName}' is missing required placeholder '${placeholder}'`);
        error.code = "PHASE21_RELEASE_ADAPTER_PLACEHOLDER_MISSING";
        throw error;
      }
    }

    recomputedTargets.push(canonicalize({
      adapter_id: manifest.adapter_id,
      adapter_manifest: normalizeRelativePath(summary.adapter_manifest),
      adapter_version: manifest.adapter_version,
      generated_files_sha256: manifest.generated_files_sha256,
      input_snapshot_hash: manifest.input_snapshot_hash,
      manifest_sha256: hashFile(manifestPath),
      manual_only: true,
      platform_target: targetName
    }));
  }

  const snapshotBase = canonicalize({
    schema_version: PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
    targets: recomputedTargets.sort((left, right) => left.platform_target.localeCompare(right.platform_target))
  });
  const recomputedSnapshotHash = buildPublisherAdapterSnapshotHash(snapshotBase);
  if (safeString(snapshot.publisher_adapter_snapshot_hash) !== recomputedSnapshotHash) {
    const error = new Error("publisher adapter snapshot hash mismatch");
    error.code = "PHASE21_RELEASE_ADAPTER_SNAPSHOT_HASH_MISMATCH";
    throw error;
  }
  return canonicalize({
    publisher_adapter_snapshot_hash: recomputedSnapshotHash,
    schema_version: PHASE21_PUBLISHER_ADAPTER_STATUS_SCHEMA,
    validated_targets: offerTargets,
    validation_result: "passed"
  });
}

function createReleaseApprovalManager(options = {}) {
  const releasesDir = path.resolve(safeString(options.releasesDir) || path.join(process.cwd(), "workspace", "releases"));
  const platformTargets = asPlainObject(options.platformTargets);
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  function getBundleDir(offerId) {
    return path.join(releasesDir, safeString(offerId));
  }

  function approveRelease(input = {}) {
    const offerId = safeString(input.offer_id || input.offerId);
    const approver = safeString(input.approver) || "operator-cli";
    const bundleDir = getBundleDir(offerId);
    const offerPath = path.join(bundleDir, "offer.json");
    const manifestPath = path.join(bundleDir, "manifest.json");
    const metadataPath = path.join(bundleDir, "metadata.json");
    if (!offerId || !fs.existsSync(offerPath) || !fs.existsSync(manifestPath) || !fs.existsSync(metadataPath)) {
      const error = new Error(`Release bundle '${offerId}' not found`);
      error.code = "PHASE19_RELEASE_BUNDLE_NOT_FOUND";
      throw error;
    }
    const offer = readJson(offerPath);
    const metadata = readJson(metadataPath);
    validateManifest(bundleDir);
    const datasetPhase20Status = validateDatasetPhase20State(offer);
    const bundleHash = computeBundleHash(bundleDir);
    const approvedTargets = Array.isArray(input.approved_platform_targets || input.approvedPlatformTargets)
      ? (input.approved_platform_targets || input.approvedPlatformTargets).map((entry) => safeString(entry)).filter(Boolean).sort()
      : Array.isArray(offer.platform_targets) ? offer.platform_targets.slice().sort() : [];
    const currentTargets = Array.isArray(offer.platform_targets) ? offer.platform_targets.slice().sort() : [];
    if (JSON.stringify(approvedTargets) !== JSON.stringify(currentTargets)) {
      const error = new Error("approved_platform_targets must match packaged offer platform_targets");
      error.code = "PHASE19_RELEASE_TARGETS_MISMATCH";
      throw error;
    }
    let approval = canonicalize({
      offer_id: offerId,
      approved_at: safeString(timeProvider.nowIso()),
      approver,
      hash_of_release_bundle: bundleHash,
      approved_platform_targets: approvedTargets,
      dataset_phase20_status: safeString(offer.source_kind) === "dataset" ? datasetPhase20Status : {}
    });
    if (isPhase21Bundle(metadata)) {
      const publisherAdapterStatus = buildValidatedAdapterStatus(bundleDir, offer, metadata, platformTargets);
      approval = validatePhase21ReleaseApproval({
        ...approval,
        schema_version: "phase21-release-approval-v1",
        publisher_adapter_status: publisherAdapterStatus
      }, {
        expected_targets: approvedTargets
      });
    }
    writeJson(path.join(bundleDir, "release-approval.json"), approval);
    return approval;
  }

  function validateApprovedRelease(offerId) {
    const bundleDir = getBundleDir(offerId);
    const approvalPath = path.join(bundleDir, "release-approval.json");
    const offerPath = path.join(bundleDir, "offer.json");
    const metadataPath = path.join(bundleDir, "metadata.json");
    if (!fs.existsSync(approvalPath)) {
      const error = new Error(`Release approval missing for '${offerId}'`);
      error.code = "PHASE19_RELEASE_APPROVAL_REQUIRED";
      throw error;
    }
    const approval = readJson(approvalPath);
    const offer = readJson(offerPath);
    const metadata = fs.existsSync(metadataPath) ? readJson(metadataPath) : {};
    validateManifest(bundleDir);
    const datasetPhase20Status = validateDatasetPhase20State(offer);
    const expectedHash = computeBundleHash(bundleDir);
    if (safeString(approval.hash_of_release_bundle) !== expectedHash) {
      const error = new Error("Release approval hash does not match current bundle");
      error.code = "PHASE19_RELEASE_APPROVAL_HASH_MISMATCH";
      throw error;
    }
    const approvedTargets = Array.isArray(approval.approved_platform_targets) ? approval.approved_platform_targets.slice().sort() : [];
    const offerTargets = Array.isArray(offer.platform_targets) ? offer.platform_targets.slice().sort() : [];
    if (JSON.stringify(approvedTargets) !== JSON.stringify(offerTargets)) {
      const error = new Error("Approved platform targets no longer match packaged offer");
      error.code = "PHASE19_RELEASE_APPROVAL_TARGETS_MISMATCH";
      throw error;
    }

    let publisherAdapterStatus = {};
    if (isPhase21Bundle(metadata)) {
      publisherAdapterStatus = buildValidatedAdapterStatus(bundleDir, offer, metadata, platformTargets);
      const validatedApproval = validatePhase21ReleaseApproval(approval, {
        expected_targets: offerTargets
      });
      if (safeString(validatedApproval.publisher_adapter_status.publisher_adapter_snapshot_hash)
        !== safeString(publisherAdapterStatus.publisher_adapter_snapshot_hash)) {
        const error = new Error("Release approval adapter snapshot hash does not match current bundle");
        error.code = "PHASE21_RELEASE_APPROVAL_ADAPTER_HASH_MISMATCH";
        throw error;
      }
    }

    return canonicalize({
      ok: true,
      offer_id: safeString(approval.offer_id),
      bundle_dir: bundleDir,
      approval,
      dataset_phase20_status: safeString(offer.source_kind) === "dataset" ? datasetPhase20Status : {},
      publisher_adapter_status: publisherAdapterStatus
    });
  }

  return Object.freeze({
    approveRelease,
    computeBundleHash,
    validateApprovedRelease
  });
}

module.exports = {
  createReleaseApprovalManager
};
