"use strict";

const { canonicalize, safeString } = require("../../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createManualPlaceholderAdapter(options = {}) {
  const platformTarget = safeString(options.platform_target || options.platformTarget);
  const adapterId = safeString(options.adapter_id || options.adapterId) || `phase21.manual.${platformTarget || "unknown"}`;
  const adapterVersion = safeString(options.adapter_version || options.adapterVersion) || "phase21-manual-v1";
  if (!platformTarget) {
    const error = new Error("manual placeholder adapter requires platform_target");
    error.code = "PHASE21_ADAPTER_PLATFORM_TARGET_REQUIRED";
    throw error;
  }

  function generateCopyBlocks(offer, sourceContext) {
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

  function generatePlatformMetadataFile(emitText, emitJson, offer, sourceContext, copyBlocks) {
    if (platformTarget === "kaggle") {
      return emitJson("dataset-metadata.json", canonicalize({
        title: safeString(offer.offer_title),
        id: safeString(offer.offer_id),
        licenses: [{ name: "other" }],
        subtitle: copyBlocks.subtitle,
        description: copyBlocks.description
      }));
    }
    if (platformTarget === "hugging_face") {
      return emitText("dataset-card.md", `# ${safeString(offer.offer_title)}\n\nManual upload only.\n`);
    }
    if (platformTarget === "github_sponsors") {
      return emitText("tier-copy.md", `# ${safeString(offer.offer_title)}\n\nManual tier setup only.\n`);
    }
    if (platformTarget === "gumroad" || platformTarget === "lemon_squeezy") {
      return emitText("product-copy.md", `# ${safeString(offer.offer_title)}\n\n${copyBlocks.description}\n`);
    }
    return emitJson("listing-fields.json", canonicalize({
      title: safeString(offer.offer_title),
      description: copyBlocks.description,
      manual_only: true,
      source_kind: safeString(sourceContext.source_kind),
      source_id: safeString(sourceContext.source_id)
    }));
  }

  function generateArtifacts(input = {}) {
    const offer = asPlainObject(input.offer);
    const sourceContext = asPlainObject(input.source_context || input.sourceContext);
    const targetConfig = asPlainObject(input.target_config || input.targetConfig);
    if (targetConfig.manual_only !== true) {
      const error = new Error(`platform target '${platformTarget}' must remain manual_only`);
      error.code = "PHASE21_ADAPTER_MANUAL_ONLY_REQUIRED";
      throw error;
    }
    if (typeof input.emitJson !== "function" || typeof input.emitText !== "function") {
      const error = new Error("adapter context must provide emitJson and emitText");
      error.code = "PHASE21_ADAPTER_CONTEXT_INVALID";
      throw error;
    }

    const copyBlocks = generateCopyBlocks(offer, sourceContext);
    const copyBlocksFile = input.emitJson("copy-blocks.json", copyBlocks);
    const checklistFile = input.emitText("checklist.md", [
      `# ${platformTarget} Submission Checklist`,
      "",
      "This pack is for manual submission only.",
      "",
      ...(Array.isArray(targetConfig.checklist_requirements) && targetConfig.checklist_requirements.length > 0
        ? targetConfig.checklist_requirements.map((entry) => `- [ ] ${entry}`)
        : ["- [ ] Manual operator review completed"])
    ].join("\n") + "\n");
    const platformMetadataFile = generatePlatformMetadataFile(input.emitText, input.emitJson, offer, sourceContext, copyBlocks);
    return canonicalize({
      generated_files: [copyBlocksFile, checklistFile, platformMetadataFile].sort((left, right) => left.localeCompare(right)),
      refs: {
        checklist: checklistFile,
        copy_blocks: copyBlocksFile,
        platform_metadata: platformMetadataFile
      }
    });
  }

  return Object.freeze({
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    generateArtifacts,
    platform_target: platformTarget
  });
}

module.exports = {
  createManualPlaceholderAdapter
};
