"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString } = require("../../workflows/governance-automation/common.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, body) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(body || ""), "utf8");
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function createSubmissionPackGenerator(options = {}) {
  const platformTargets = options.platformTargets && typeof options.platformTargets === "object" ? options.platformTargets : { platform_targets: {} };

  function assertRequiredPlaceholders(platformDir, platformName, refs) {
    const targetConfig = platformTargets.platform_targets && platformTargets.platform_targets[platformName]
      ? platformTargets.platform_targets[platformName]
      : {};
    const required = Array.isArray(targetConfig.required_artifact_placeholders)
      ? targetConfig.required_artifact_placeholders.map((entry) => safeString(entry)).filter(Boolean)
      : [];
    for (const fileName of required) {
      const filePath = path.join(platformDir, fileName);
      if (!fs.existsSync(filePath)) {
        const error = new Error(`submission pack '${platformName}' is missing required placeholder '${fileName}'`);
        error.code = "PHASE19_SUBMISSION_PLACEHOLDER_MISSING";
        throw error;
      }
    }
    return canonicalize(refs);
  }

  function generateCopyBlocks(offer, sourceContext, platformName) {
    return canonicalize({
      title: safeString(offer.offer_title),
      subtitle: `${safeString(offer.product_line)} / ${safeString(offer.tier)}`,
      description: `${safeString(sourceContext.description) || safeString(offer.offer_title)} Manual submission only.`,
      dataset_summary: safeString(sourceContext.metadata && sourceContext.metadata.dataset_type),
      sample_summary: `Prepared from ${safeString(sourceContext.source_kind)} ${safeString(sourceContext.source_id)}`,
      delivery_notes: "This submission pack prepares manual operator review and manual submission only.",
      tier_name: safeString(offer.tier),
      tier_summary: safeString(offer.offer_title),
      tier_description: "Prepared for manual review and manual posting only."
    });
  }

  function generatePlatformPlaceholders(platformName, bundleDir, offer, sourceContext) {
    const platformDir = path.join(bundleDir, "submission", platformName);
    ensureDir(platformDir);
    const copyBlocks = generateCopyBlocks(offer, sourceContext, platformName);
    const refs = {};

    writeJson(path.join(platformDir, "copy-blocks.json"), copyBlocks);
    refs.copy_blocks = path.relative(bundleDir, path.join(platformDir, "copy-blocks.json")).split(path.sep).join("/");

    const targetConfig = platformTargets.platform_targets && platformTargets.platform_targets[platformName]
      ? platformTargets.platform_targets[platformName]
      : {};
    writeText(path.join(platformDir, "checklist.md"), [
      `# ${platformName} Submission Checklist`,
      "",
      "This pack is for manual submission only.",
      "",
      ...(Array.isArray(targetConfig.checklist_requirements) ? targetConfig.checklist_requirements.map((entry) => `- [ ] ${entry}`) : ["- [ ] Manual operator review completed"])
    ].join("\n") + "\n");
    refs.checklist = path.relative(bundleDir, path.join(platformDir, "checklist.md")).split(path.sep).join("/");

    if (platformName === "kaggle") {
      writeJson(path.join(platformDir, "dataset-metadata.json"), canonicalize({
        title: safeString(offer.offer_title),
        id: safeString(offer.offer_id),
        licenses: [{ name: "other" }],
        subtitle: copyBlocks.subtitle,
        description: copyBlocks.description
      }));
      refs.platform_metadata = path.relative(bundleDir, path.join(platformDir, "dataset-metadata.json")).split(path.sep).join("/");
    } else if (platformName === "hugging_face") {
      writeText(path.join(platformDir, "dataset-card.md"), `# ${safeString(offer.offer_title)}\n\nManual upload only.\n`);
      refs.platform_metadata = path.relative(bundleDir, path.join(platformDir, "dataset-card.md")).split(path.sep).join("/");
    } else if (platformName === "github_sponsors") {
      writeText(path.join(platformDir, "tier-copy.md"), `# ${safeString(offer.offer_title)}\n\nManual tier setup only.\n`);
      refs.platform_metadata = path.relative(bundleDir, path.join(platformDir, "tier-copy.md")).split(path.sep).join("/");
    } else if (platformName === "gumroad" || platformName === "lemon_squeezy") {
      writeText(path.join(platformDir, "product-copy.md"), `# ${safeString(offer.offer_title)}\n\n${copyBlocks.description}\n`);
      refs.platform_metadata = path.relative(bundleDir, path.join(platformDir, "product-copy.md")).split(path.sep).join("/");
    } else {
      writeJson(path.join(platformDir, "listing-fields.json"), canonicalize({
        title: safeString(offer.offer_title),
        description: copyBlocks.description,
        manual_only: true,
        source_kind: safeString(sourceContext.source_kind),
        source_id: safeString(sourceContext.source_id)
      }));
      refs.platform_metadata = path.relative(bundleDir, path.join(platformDir, "listing-fields.json")).split(path.sep).join("/");
    }

    return assertRequiredPlaceholders(platformDir, platformName, refs);
  }

  function generateSubmissionPacks(bundleDir, offer, sourceContext) {
    const submissionRefs = {};
    for (const platformName of Array.isArray(offer.platform_targets) ? offer.platform_targets : []) {
      submissionRefs[platformName] = generatePlatformPlaceholders(platformName, bundleDir, offer, sourceContext);
    }
    return canonicalize(submissionRefs);
  }

  return Object.freeze({
    generateSubmissionPacks
  });
}

module.exports = {
  createSubmissionPackGenerator
};
