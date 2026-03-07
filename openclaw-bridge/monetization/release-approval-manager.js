"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

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

function createReleaseApprovalManager(options = {}) {
  const releasesDir = path.resolve(safeString(options.releasesDir) || path.join(process.cwd(), "workspace", "releases"));
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
    if (!offerId || !fs.existsSync(offerPath) || !fs.existsSync(manifestPath)) {
      const error = new Error(`Release bundle '${offerId}' not found`);
      error.code = "PHASE19_RELEASE_BUNDLE_NOT_FOUND";
      throw error;
    }
    const offer = readJson(offerPath);
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
    const approval = canonicalize({
      offer_id: offerId,
      approved_at: safeString(timeProvider.nowIso()),
      approver,
      hash_of_release_bundle: bundleHash,
      approved_platform_targets: approvedTargets,
      dataset_phase20_status: safeString(offer.source_kind) === "dataset" ? datasetPhase20Status : {}
    });
    writeJson(path.join(bundleDir, "release-approval.json"), approval);
    return approval;
  }

  function validateApprovedRelease(offerId) {
    const bundleDir = getBundleDir(offerId);
    const approvalPath = path.join(bundleDir, "release-approval.json");
    const offerPath = path.join(bundleDir, "offer.json");
    if (!fs.existsSync(approvalPath)) {
      const error = new Error(`Release approval missing for '${offerId}'`);
      error.code = "PHASE19_RELEASE_APPROVAL_REQUIRED";
      throw error;
    }
    const approval = readJson(approvalPath);
    const offer = readJson(offerPath);
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
    return canonicalize({
      ok: true,
      offer_id: safeString(approval.offer_id),
      bundle_dir: bundleDir,
      approval,
      dataset_phase20_status: safeString(offer.source_kind) === "dataset" ? datasetPhase20Status : {}
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
