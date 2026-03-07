"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createDatasetOutputManager } = require("../openclaw-bridge/dataset/dataset-output-manager.js");
const { createOfferBuilder } = require("../openclaw-bridge/monetization/offer-builder.js");
const { createDeliverablePackager } = require("../openclaw-bridge/monetization/deliverable-packager.js");
const { createSubmissionPackGenerator } = require("../openclaw-bridge/monetization/submission-pack-generator.js");
const { createReleaseApprovalManager } = require("../openclaw-bridge/monetization/release-approval-manager.js");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildMonetizationRuntime(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const monetizationMap = readJson(path.join(rootDir, "config", "monetization-map.json"));
  const platformTargets = readJson(path.join(rootDir, "config", "platform-targets.json"));
  const datasetOutputManager = createDatasetOutputManager({ rootDir });
  const offerBuilder = createOfferBuilder({
    rootDir,
    monetizationMap,
    platformTargets,
    datasetOutputManager
  });
  const deliverablePackager = createDeliverablePackager({ rootDir });
  const submissionPackGenerator = createSubmissionPackGenerator({ platformTargets });
  const releaseApprovalManager = createReleaseApprovalManager({
    releasesDir: path.join(rootDir, "workspace", "releases")
  });

  return {
    rootDir,
    monetizationMap,
    platformTargets,
    datasetOutputManager,
    offerBuilder,
    deliverablePackager,
    submissionPackGenerator,
    releaseApprovalManager
  };
}

module.exports = {
  buildMonetizationRuntime,
  readJson
};
