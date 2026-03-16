"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");
const {
  computeOfferId,
  validateDirectDeliveryTargets,
  validateMonetizationMap,
  validateOfferDefinition,
  validatePlatformTargets
} = require("./offer-schema.js");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function detectOutputFile(taskDir) {
  for (const candidate of ["output.md", "output.json", "output.txt"]) {
    const filePath = path.join(taskDir, candidate);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return "";
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean).sort((left, right) => left.localeCompare(right))
    : [];
}

function asBoolean(value) {
  return value === true;
}

function normalizeIso(value) {
  const text = safeString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : "1970-01-01T00:00:00.000Z";
}

function relativeFromRoot(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function resolveSourceFile(rootDir, filePath) {
  const rawPath = safeString(filePath);
  if (!rawPath) {
    return "";
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(rootDir, rawPath);
}

function createOfferBuilder(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const monetizationMap = validateMonetizationMap(options.monetizationMap || {});
  const platformTargets = validatePlatformTargets(options.platformTargets || {});
  const directDeliveryTargets = validateDirectDeliveryTargets(options.directDeliveryTargets || {});
  const datasetOutputManager = options.datasetOutputManager;

  if (!datasetOutputManager
    || typeof datasetOutputManager.resolveLatestCommercializationReadyBuild !== "function"
    || typeof datasetOutputManager.getBuild !== "function") {
    throw new Error("datasetOutputManager with resolveLatestCommercializationReadyBuild/getBuild is required");
  }

  function resolveMissionSource(sourceId) {
    const missionId = safeString(sourceId);
    if (!missionId.startsWith("mission-")) {
      const error = new Error(`Mission source ids must start with 'mission-': '${missionId || "(empty)"}'`);
      error.code = "PHASE19_MISSION_SOURCE_ID_INVALID";
      throw error;
    }
    const missionRoot = path.join(rootDir, "workspace", "missions", missionId);
    const missionPath = path.join(missionRoot, "mission.json");
    const statusPath = path.join(missionRoot, "status.json");
    const summaryPath = path.join(missionRoot, "artifacts", "mission-summary.json");
    if (!missionId || !fs.existsSync(missionPath) || !fs.existsSync(summaryPath)) {
      const error = new Error(`Mission source '${missionId}' not found`);
      error.code = "PHASE19_OFFER_SOURCE_NOT_FOUND";
      throw error;
    }
    const mission = readJson(missionPath);
    const status = fs.existsSync(statusPath) ? readJson(statusPath) : {};
    const summary = readJson(summaryPath);
    if (safeString(status.status) && safeString(status.status) !== "completed") {
      const error = new Error(`Mission '${missionId}' must be completed before offer generation`);
      error.code = "PHASE19_MISSION_NOT_COMPLETED";
      throw error;
    }
    const artifacts = [];
    for (const result of Array.isArray(summary.subtask_results) ? summary.subtask_results : []) {
      const outputPath = resolveSourceFile(rootDir, result.output_path);
      if (!outputPath || !fs.existsSync(outputPath)) {
        continue;
      }
      const taskId = path.basename(path.dirname(outputPath));
      const taskDir = path.join(rootDir, "workspace", "research-output", taskId);
      const metadataPath = path.join(taskDir, "metadata.json");
      const manifestPath = path.join(taskDir, "manifest.json");
      artifacts.push(canonicalize({
        task_id: taskId,
        output_path: outputPath,
        output_rel: relativeFromRoot(rootDir, outputPath),
        output_excerpt: readText(outputPath).slice(0, 1600),
        metadata: fs.existsSync(metadataPath) ? readJson(metadataPath) : {},
        manifest: fs.existsSync(manifestPath) ? readJson(manifestPath) : {}
      }));
    }

    return canonicalize({
      source_kind: "mission",
      source_id: missionId,
      artifact_profile: "research",
      title: safeString(mission.description) || `Mission ${missionId}`,
      description: safeString(mission.description),
      created_at: normalizeIso(mission.created_at || mission.createdAt),
      source_manifest_hash: sha256(JSON.stringify(canonicalize({
        mission,
        status,
        summary
      }))),
      mission,
      status,
      summary,
      artifacts
    });
  }

  function resolveDatasetSource(sourceId, buildId = "") {
    const datasetId = safeString(sourceId);
    if (!datasetId.startsWith("dataset-")) {
      const error = new Error(`Dataset source ids must start with 'dataset-': '${datasetId || "(empty)"}'`);
      error.code = "PHASE19_DATASET_SOURCE_ID_INVALID";
      throw error;
    }
    const explicitBuildSelected = Boolean(safeString(buildId));
    const build = explicitBuildSelected
      ? datasetOutputManager.getBuild(datasetId, buildId)
      : datasetOutputManager.resolveLatestCommercializationReadyBuild(datasetId);
    if (!build) {
      const error = new Error(explicitBuildSelected
        ? `Dataset source '${datasetId}' build '${buildId}' not found in dataset index`
        : `Dataset source '${datasetId}' does not have a commercialization-ready build in the dataset index`);
      error.code = explicitBuildSelected
        ? "PHASE19_DATASET_BUILD_NOT_FOUND"
        : "PHASE20_DATASET_BUILD_NOT_COMMERCIALIZATION_READY";
      throw error;
    }
    const metadata = asPlainObject(build.metadata);
    const phase20Status = canonicalize({
      commercialization_ready: asBoolean(metadata.commercialization_ready),
      license_state: safeString(metadata.license_state) || "blocked",
      quality_status: safeString(metadata.quality_status) || "failed",
      validation_status: safeString(metadata.validation_status) || "failed"
    });
    if (safeString(metadata.status) && safeString(metadata.status) !== "completed") {
      const error = new Error(`Dataset build '${safeString(build.build_id)}' must be completed before offer generation`);
      error.code = "PHASE19_DATASET_BUILD_INCOMPLETE";
      throw error;
    }
    if (phase20Status.validation_status !== "passed") {
      const error = new Error(`Dataset build '${safeString(build.build_id)}' failed validation and cannot be packaged`);
      error.code = "PHASE20_DATASET_BUILD_VALIDATION_FAILED";
      throw error;
    }
    if (phase20Status.quality_status !== "passed") {
      const error = new Error(`Dataset build '${safeString(build.build_id)}' failed quality thresholds and cannot be packaged`);
      error.code = "PHASE20_DATASET_BUILD_QUALITY_FAILED";
      throw error;
    }
    if (!phase20Status.license_state || phase20Status.license_state === "blocked") {
      const error = new Error(`Dataset build '${safeString(build.build_id)}' is blocked by license review`);
      error.code = "PHASE20_DATASET_BUILD_LICENSE_BLOCKED";
      throw error;
    }
    if (phase20Status.license_state === "review_required" && !explicitBuildSelected) {
      const error = new Error(`Dataset build '${safeString(build.build_id)}' requires explicit --build-id selection because it is review_required`);
      error.code = "PHASE20_DATASET_BUILD_REVIEW_REQUIRED_EXPLICIT";
      throw error;
    }
    if (phase20Status.commercialization_ready !== true && phase20Status.license_state !== "review_required") {
      const error = new Error(`Dataset build '${safeString(build.build_id)}' is not commercialization-ready`);
      error.code = "PHASE20_DATASET_BUILD_NOT_COMMERCIALIZATION_READY";
      throw error;
    }

    const datasetPath = path.join(datasetOutputManager.baseDir, safeString(build.dataset_path));
    const schemaPath = path.join(datasetOutputManager.baseDir, safeString(build.schema_path));
    const buildReportPath = path.join(datasetOutputManager.baseDir, safeString(build.build_report_path));
    const validationReportPath = path.join(datasetOutputManager.baseDir, safeString(build.validation_report_path));
    const dedupeReportPath = path.join(datasetOutputManager.baseDir, safeString(build.dedupe_report_path));
    const provenancePath = path.join(datasetOutputManager.baseDir, safeString(build.provenance_path));
    const qualityReportPath = path.join(datasetOutputManager.baseDir, safeString(build.quality_report_path));
    const licenseReportPath = path.join(datasetOutputManager.baseDir, safeString(build.license_report_path));
    const warnings = phase20Status.license_state === "review_required"
      ? [`Dataset build ${safeString(build.build_id)} is review_required and must remain manually reviewed before any submission.`]
      : [];
    return canonicalize({
      source_kind: "dataset",
      source_id: datasetId,
      build_id: safeString(build.build_id),
      artifact_profile: "dataset",
      title: `${datasetId} ${safeString(metadata.dataset_type) || "dataset"} build`,
      description: `Dataset build ${safeString(build.build_id)} for ${datasetId}`,
      created_at: normalizeIso(metadata.build_completed_at),
      source_manifest_hash: sha256(JSON.stringify(canonicalize(build.manifest || {}))),
      build,
      metadata,
      dedupe_report_path: dedupeReportPath,
      dataset_path: datasetPath,
      schema_path: schemaPath,
      build_report_path: buildReportPath,
      explicit_build_selected: explicitBuildSelected,
      license_report_path: licenseReportPath,
      phase20_status: phase20Status,
      provenance_path: provenancePath,
      quality_report_path: qualityReportPath,
      validation_report_path: validationReportPath,
      warnings
    });
  }

  function buildOffer(input = {}) {
    const productLineName = safeString(input.product_line || input.productLine);
    const tierName = safeString(input.tier);
    const sourceId = safeString(input.source || input.source_id || input.sourceId);
    const explicitBuildId = safeString(input.build_id || input.buildId);
    const productLine = asPlainObject(monetizationMap.product_lines[productLineName]);
    const tier = asPlainObject(monetizationMap.tiers[tierName]);
    if (!productLineName || !productLine.product_line) {
      const error = new Error(`Unknown product line '${productLineName || "(empty)"}'`);
      error.code = "PHASE19_PRODUCT_LINE_UNKNOWN";
      throw error;
    }
    if (!tierName || !tier.tier) {
      const error = new Error(`Unknown tier '${tierName || "(empty)"}'`);
      error.code = "PHASE19_TIER_UNKNOWN";
      throw error;
    }
    if (!sourceId || (!sourceId.startsWith("mission-") && !sourceId.startsWith("dataset-"))) {
      const error = new Error("source must be a mission-* or dataset-* identifier");
      error.code = "PHASE19_SOURCE_ID_INVALID";
      throw error;
    }

    const sourceContext = sourceId.startsWith("dataset-")
      ? resolveDatasetSource(sourceId, explicitBuildId)
      : resolveMissionSource(sourceId);
    if (!asStringArray(productLine.source_kinds).includes(sourceContext.source_kind)) {
      const error = new Error(`Product line '${productLineName}' does not support source kind '${sourceContext.source_kind}'`);
      error.code = "PHASE19_PRODUCT_LINE_SOURCE_KIND_DENIED";
      throw error;
    }
    if (!asStringArray(productLine.supported_tiers).includes(tierName)) {
      const error = new Error(`Product line '${productLineName}' does not support tier '${tierName}'`);
      error.code = "PHASE19_PRODUCT_LINE_TIER_DENIED";
      throw error;
    }

    const requestedTargets = asStringArray(input.targets);
    const effectiveTargets = requestedTargets.length > 0
      ? requestedTargets
      : asStringArray(productLine.default_platform_targets);
    const requestedDeliveryTargets = asStringArray(input.delivery_targets || input.deliveryTargets);
    const effectiveDeliveryTargets = requestedDeliveryTargets.length > 0
      ? requestedDeliveryTargets
      : asStringArray(productLine.default_delivery_targets);
    const allowedTargets = new Set(asStringArray(tier.allowed_platform_targets));
    const platformConfig = asPlainObject(platformTargets.platform_targets);
    const deliveryTargetConfig = asPlainObject(directDeliveryTargets.delivery_targets);
    for (const target of effectiveTargets) {
      if (!allowedTargets.has(target)) {
        const error = new Error(`Tier '${tierName}' does not allow platform target '${target}'`);
        error.code = "PHASE19_TIER_PLATFORM_TARGET_DENIED";
        throw error;
      }
      if (!Object.prototype.hasOwnProperty.call(platformConfig, target)) {
        const error = new Error(`Unknown platform target '${target}'`);
        error.code = "PHASE19_PLATFORM_TARGET_UNKNOWN";
        throw error;
      }
      const targetConfig = asPlainObject(platformConfig[target]);
      if (!asStringArray(targetConfig.supported_product_lines).includes(productLineName)) {
        const error = new Error(`Platform target '${target}' does not support product line '${productLineName}'`);
        error.code = "PHASE19_PLATFORM_TARGET_PRODUCT_LINE_DENIED";
        throw error;
      }
      if (!asStringArray(targetConfig.supported_tiers).includes(tierName)) {
        const error = new Error(`Platform target '${target}' does not support tier '${tierName}'`);
        error.code = "PHASE19_PLATFORM_TARGET_TIER_DENIED";
        throw error;
      }
    }
    for (const target of effectiveDeliveryTargets) {
      const definition = asPlainObject(deliveryTargetConfig[target]);
      if (!definition || Object.keys(definition).length < 1) {
        const error = new Error(`Unknown delivery target '${target}'`);
        error.code = "PHASE28_DELIVERY_TARGET_UNKNOWN";
        throw error;
      }
      if (!asStringArray(definition.supported_product_lines).includes(productLineName)) {
        const error = new Error(`Delivery target '${target}' does not support product line '${productLineName}'`);
        error.code = "PHASE28_DELIVERY_TARGET_PRODUCT_LINE_DENIED";
        throw error;
      }
      if (!asStringArray(definition.supported_tiers).includes(tierName)) {
        const error = new Error(`Delivery target '${target}' does not support tier '${tierName}'`);
        error.code = "PHASE28_DELIVERY_TARGET_TIER_DENIED";
        throw error;
      }
    }
    if (productLineName === "enterprise_private_delivery" && effectiveDeliveryTargets.length < 1) {
      const error = new Error("enterprise_private_delivery offers require at least one direct delivery target");
      error.code = "PHASE28_DELIVERY_TARGET_REQUIRED";
      throw error;
    }

    const offerSeed = canonicalize({
      source_kind: sourceContext.source_kind,
      source_id: sourceContext.source_id,
      build_id: safeString(sourceContext.build_id),
      product_line: productLineName,
      tier: tierName,
      platform_targets: effectiveTargets,
      direct_delivery_targets: effectiveDeliveryTargets,
      source_manifest_hash: safeString(sourceContext.source_manifest_hash),
      monetization_snapshot_hash: sha256(JSON.stringify(canonicalize({
        product_line: productLine,
        tier
      })))
    });

    const offer = validateOfferDefinition({
      offer_id: computeOfferId(offerSeed),
      offer_title: `${sourceContext.title} (${productLineName.replace(/_/g, " ")})`,
      product_line: productLineName,
      tier: tierName,
      source_kind: sourceContext.source_kind,
      source_id: sourceContext.source_id,
      build_id: safeString(sourceContext.build_id),
      artifact_profile: safeString(productLine.artifact_profile),
      platform_targets: effectiveTargets,
      direct_delivery_targets: effectiveDeliveryTargets,
      release_status: "packaged",
      artifact_slots: asStringArray(tier.required_artifact_slots),
      commercialization_ready: sourceContext.source_kind === "dataset" ? sourceContext.phase20_status.commercialization_ready === true : false,
      explicit_build_selected: sourceContext.explicit_build_selected === true,
      license_state: sourceContext.source_kind === "dataset" ? safeString(sourceContext.phase20_status.license_state) : "",
      quality_status: sourceContext.source_kind === "dataset" ? safeString(sourceContext.phase20_status.quality_status) : "",
      required_metadata_fields: asStringArray(tier.required_metadata_fields),
      source_status: sourceContext.source_kind === "dataset" ? canonicalize(sourceContext.phase20_status) : {},
      validation_status: sourceContext.source_kind === "dataset" ? safeString(sourceContext.phase20_status.validation_status) : "",
      warnings: asStringArray(sourceContext.warnings),
      workflow_roles: asStringArray(productLine.workflow_roles),
      source_manifest_hash: safeString(sourceContext.source_manifest_hash),
      artifact_refs: {}
    });

    return canonicalize({
      offer,
      source_context: sourceContext,
      product_line: canonicalize(productLine),
      tier: canonicalize(tier)
    });
  }

  return Object.freeze({
    buildOffer,
    resolveDatasetSource,
    resolveMissionSource
  });
}

module.exports = {
  createOfferBuilder
};
