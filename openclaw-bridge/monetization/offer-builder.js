"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");
const {
  computeOfferId,
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
  const datasetOutputManager = options.datasetOutputManager;

  if (!datasetOutputManager || typeof datasetOutputManager.resolveLatestSuccessfulBuild !== "function") {
    throw new Error("datasetOutputManager.resolveLatestSuccessfulBuild is required");
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
    const build = buildId
      ? datasetOutputManager.getBuild(datasetId, buildId)
      : datasetOutputManager.resolveLatestSuccessfulBuild(datasetId);
    if (!build) {
      const error = new Error(`Dataset source '${datasetId}'${buildId ? ` build '${buildId}'` : ""} not found in dataset index`);
      error.code = "PHASE19_DATASET_BUILD_NOT_FOUND";
      throw error;
    }
    const metadata = asPlainObject(build.metadata);
    if (safeString(metadata.status) && safeString(metadata.status) !== "completed") {
      const error = new Error(`Dataset build '${safeString(build.build_id)}' must be completed before offer generation`);
      error.code = "PHASE19_DATASET_BUILD_INCOMPLETE";
      throw error;
    }

    const datasetPath = path.join(datasetOutputManager.baseDir, safeString(build.dataset_path));
    const schemaPath = path.join(datasetOutputManager.baseDir, safeString(build.schema_path));
    const buildReportPath = path.join(datasetOutputManager.baseDir, safeString(build.build_report_path));
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
      dataset_path: datasetPath,
      schema_path: schemaPath,
      build_report_path: buildReportPath
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
    const allowedTargets = new Set(asStringArray(tier.allowed_platform_targets));
    const platformConfig = asPlainObject(platformTargets.platform_targets);
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

    const offerSeed = canonicalize({
      source_kind: sourceContext.source_kind,
      source_id: sourceContext.source_id,
      build_id: safeString(sourceContext.build_id),
      product_line: productLineName,
      tier: tierName,
      platform_targets: effectiveTargets,
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
      release_status: "packaged",
      artifact_slots: asStringArray(tier.required_artifact_slots),
      required_metadata_fields: asStringArray(tier.required_metadata_fields),
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
