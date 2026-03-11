"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createDatasetOutputManager } = require("../openclaw-bridge/dataset/dataset-output-manager.js");
const { createOfferBuilder } = require("../openclaw-bridge/monetization/offer-builder.js");
const { createDeliverablePackager } = require("../openclaw-bridge/monetization/deliverable-packager.js");
const { createSubmissionPackGenerator } = require("../openclaw-bridge/monetization/submission-pack-generator.js");
const { createReleaseApprovalManager } = require("../openclaw-bridge/monetization/release-approval-manager.js");
const { createDefaultPublisherAdapterRegistry } = require("../openclaw-bridge/monetization/publisher-adapter-registry.js");
const { createSubmissionEvidenceManager } = require("../openclaw-bridge/monetization/submission-evidence-manager.js");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];
}

function validateRegistryCoverage(publisherAdapterRegistry, platformTargets) {
  if (!publisherAdapterRegistry || typeof publisherAdapterRegistry.resolve !== "function" || typeof publisherAdapterRegistry.list !== "function") {
    const error = new Error("buildMonetizationRuntime requires a valid publisherAdapterRegistry");
    error.code = "PHASE21_RUNTIME_ADAPTER_REGISTRY_REQUIRED";
    throw error;
  }
  const configuredTargets = Object.keys(asPlainObject(asPlainObject(platformTargets).platform_targets)).sort((left, right) => left.localeCompare(right));
  const listedTargets = asStringArray(publisherAdapterRegistry.configured_targets);
  if (listedTargets.length > 0 && JSON.stringify(listedTargets) !== JSON.stringify(configuredTargets)) {
    const error = new Error("publisher adapter registry configured_targets does not match config/platform-targets.json");
    error.code = "PHASE21_RUNTIME_ADAPTER_REGISTRY_TARGETS_MISMATCH";
    throw error;
  }
  const resolvedTargets = asStringArray((publisherAdapterRegistry.list() || []).map((entry) => asPlainObject(entry).platform_target));
  if (JSON.stringify(resolvedTargets) !== JSON.stringify(configuredTargets)) {
    const error = new Error("publisher adapter registry entries must map exactly one adapter per configured platform target");
    error.code = "PHASE21_RUNTIME_ADAPTER_REGISTRY_TARGETS_MISMATCH";
    throw error;
  }
  for (const targetName of configuredTargets) {
    const adapter = publisherAdapterRegistry.resolve(targetName);
    if (!adapter || String(asPlainObject(adapter).platform_target || "").trim() !== targetName) {
      const error = new Error(`publisher adapter registry target mismatch for '${targetName}'`);
      error.code = "PHASE21_RUNTIME_ADAPTER_REGISTRY_TARGETS_MISMATCH";
      throw error;
    }
  }
  return publisherAdapterRegistry;
}

function buildMonetizationRuntime(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const monetizationMap = readJson(path.join(rootDir, "config", "monetization-map.json"));
  const platformTargets = readJson(path.join(rootDir, "config", "platform-targets.json"));
  const publisherAdapterRegistry = validateRegistryCoverage(
    options.publisherAdapterRegistry || createDefaultPublisherAdapterRegistry({ platformTargets }),
    platformTargets
  );
  const datasetOutputManager = createDatasetOutputManager({ rootDir });
  const offerBuilder = createOfferBuilder({
    rootDir,
    monetizationMap,
    platformTargets,
    datasetOutputManager
  });
  const deliverablePackager = createDeliverablePackager({ rootDir });
  const submissionPackGenerator = createSubmissionPackGenerator({
    platformTargets,
    publisherAdapterRegistry
  });
  const releaseApprovalManager = createReleaseApprovalManager({
    platformTargets,
    releasesDir: path.join(rootDir, "workspace", "releases")
  });
  const submissionEvidenceManager = createSubmissionEvidenceManager({
    rootDir,
    releasesDir: path.join(rootDir, "workspace", "releases"),
    releaseApprovalManager
  });

  return {
    rootDir,
    monetizationMap,
    platformTargets,
    publisherAdapterRegistry,
    datasetOutputManager,
    offerBuilder,
    deliverablePackager,
    submissionPackGenerator,
    releaseApprovalManager,
    submissionEvidenceManager
  };
}

module.exports = {
  buildMonetizationRuntime,
  readJson
};
