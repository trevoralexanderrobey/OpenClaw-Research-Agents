"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const INDEX_SCHEMA_VERSION = "phase20-datasets-index-v1";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function hashText(text) {
  return sha256(String(text || ""));
}

function hashFile(filePath) {
  return hashText(fs.readFileSync(filePath, "utf8"));
}

function relativeFrom(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join("/");
}

function normalizeIso(value) {
  const text = safeString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : "1970-01-01T00:00:00.000Z";
}

function writeDatasetJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const body = Array.isArray(rows)
    ? rows.map((row) => JSON.stringify(canonicalize(row))).join("\n")
    : "";
  fs.writeFileSync(filePath, body ? `${body}\n` : "", "utf8");
}

function normalizeValidationStatus(value, fallback = "failed") {
  const status = safeString(value);
  return ["failed", "passed"].includes(status) ? status : fallback;
}

function normalizeLicenseState(value, fallback = "blocked") {
  const state = safeString(value);
  return ["allowed", "blocked", "review_required"].includes(state) ? state : fallback;
}

function normalizeBuildRecord(input = {}) {
  return canonicalize({
    dataset_id: safeString(input.dataset_id),
    build_id: safeString(input.build_id),
    dataset_type: safeString(input.dataset_type),
    commercialization_ready: input.commercialization_ready === true,
    target_schema: safeString(input.target_schema),
    dedupe_report_path: safeString(input.dedupe_report_path),
    license_report_path: safeString(input.license_report_path),
    license_state: normalizeLicenseState(input.license_state),
    status: safeString(input.status) || "completed",
    row_count: Math.max(0, Number.parseInt(String(input.row_count || 0), 10) || 0),
    source_task_ids: Array.isArray(input.source_task_ids) ? input.source_task_ids.map((entry) => safeString(entry)).filter(Boolean).sort() : [],
    source_mission_ids: Array.isArray(input.source_mission_ids) ? input.source_mission_ids.map((entry) => safeString(entry)).filter(Boolean).sort() : [],
    build_started_at: normalizeIso(input.build_started_at),
    build_completed_at: normalizeIso(input.build_completed_at),
    dataset_path: safeString(input.dataset_path),
    metadata_path: safeString(input.metadata_path),
    manifest_path: safeString(input.manifest_path),
    provenance_path: safeString(input.provenance_path),
    quality_report_path: safeString(input.quality_report_path),
    quality_status: normalizeValidationStatus(input.quality_status),
    schema_path: safeString(input.schema_path),
    build_report_path: safeString(input.build_report_path),
    validation_report_path: safeString(input.validation_report_path),
    validation_status: normalizeValidationStatus(input.validation_status, safeString(input.status) === "completed" ? "passed" : "failed")
  });
}

function normalizeDatasetRecord(input = {}) {
  return canonicalize({
    dataset_id: safeString(input.dataset_id),
    dataset_type: safeString(input.dataset_type),
    latest_build_id: safeString(input.latest_build_id),
    latest_commercialization_ready_build_id: safeString(input.latest_commercialization_ready_build_id),
    latest_successful_build_id: safeString(input.latest_successful_build_id),
    latest_review_required_build_id: safeString(input.latest_review_required_build_id),
    latest_validated_build_id: safeString(input.latest_validated_build_id),
    latest_build_completed_at: normalizeIso(input.latest_build_completed_at),
    build_count: Math.max(0, Number.parseInt(String(input.build_count || 0), 10) || 0)
  });
}

function createDatasetOutputManager(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const baseDir = path.resolve(safeString(options.baseDir) || path.join(rootDir, "workspace", "datasets"));
  const rawDir = path.resolve(safeString(options.rawDir) || path.join(baseDir, "raw"));
  const stagedDir = path.resolve(safeString(options.stagedDir) || path.join(baseDir, "staged"));
  const indexDir = path.resolve(safeString(options.indexDir) || path.join(baseDir, "index"));
  const indexPath = path.join(indexDir, "datasets-index.json");
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  function loadIndex() {
    const state = readJson(indexPath, {
      schema_version: INDEX_SCHEMA_VERSION,
      datasets: [],
      builds: []
    });
    return canonicalize({
      schema_version: INDEX_SCHEMA_VERSION,
      datasets: Array.isArray(state.datasets) ? state.datasets.map((entry) => normalizeDatasetRecord(entry)).sort((left, right) => left.dataset_id.localeCompare(right.dataset_id)) : [],
      builds: Array.isArray(state.builds) ? state.builds.map((entry) => normalizeBuildRecord(entry)).sort((left, right) => {
        const datasetCompare = left.dataset_id.localeCompare(right.dataset_id);
        if (datasetCompare !== 0) {
          return datasetCompare;
        }
        return left.build_id.localeCompare(right.build_id);
      }) : []
    });
  }

  function persistIndex(index) {
    writeJson(indexPath, index);
  }

  function saveBuild(input = {}) {
    const datasetId = safeString(input.dataset_id || input.datasetId);
    const buildId = safeString(input.build_id || input.buildId);
    if (!datasetId) {
      const error = new Error("dataset_id is required");
      error.code = "PHASE19_DATASET_ID_REQUIRED";
      throw error;
    }
    if (!buildId) {
      const error = new Error("build_id is required");
      error.code = "PHASE19_BUILD_ID_REQUIRED";
      throw error;
    }

    const rawDatasetDir = path.join(rawDir, datasetId);
    const stagedBuildDir = path.join(stagedDir, datasetId, buildId);
    ensureDir(rawDatasetDir);
    ensureDir(stagedBuildDir);
    ensureDir(indexDir);

    const rows = Array.isArray(input.rows) ? input.rows.map((row) => canonicalize(row)) : [];
    const schema = canonicalize(input.schema || {});
    const buildReport = canonicalize(input.build_report || input.buildReport || {});
    const rawSnapshot = canonicalize(input.raw_snapshot || input.rawSnapshot || {});
    const buildStartedAt = normalizeIso(input.build_started_at || input.buildStartedAt || timeProvider.nowIso());
    const buildCompletedAt = normalizeIso(input.build_completed_at || input.buildCompletedAt || timeProvider.nowIso());
    const targetSchema = safeString(input.target_schema || input.targetSchema) || safeString(schema.schema_version);
    const validationReport = canonicalize(input.validation_report || input.validationReport || {});
    const dedupeReport = canonicalize(input.dedupe_report || input.dedupeReport || {});
    const provenance = canonicalize(input.provenance || {});
    const qualityReport = canonicalize(input.quality_report || input.qualityReport || {});
    const licenseReport = canonicalize(input.license_report || input.licenseReport || {});

    const datasetPath = path.join(stagedBuildDir, "dataset.jsonl");
    const metadataPath = path.join(stagedBuildDir, "metadata.json");
    const schemaPath = path.join(stagedBuildDir, "schema.json");
    const buildReportPath = path.join(stagedBuildDir, "build-report.json");
    const validationReportPath = path.join(stagedBuildDir, "validation-report.json");
    const dedupeReportPath = path.join(stagedBuildDir, "dedupe-report.json");
    const provenancePath = path.join(stagedBuildDir, "provenance.json");
    const qualityReportPath = path.join(stagedBuildDir, "quality-report.json");
    const licenseReportPath = path.join(stagedBuildDir, "license-report.json");
    const rawSnapshotPath = path.join(rawDatasetDir, `source-${buildId}.json`);

    writeDatasetJsonl(datasetPath, rows);
    writeJson(schemaPath, schema);
    writeJson(buildReportPath, buildReport);
    writeJson(validationReportPath, validationReport);
    writeJson(dedupeReportPath, dedupeReport);
    writeJson(provenancePath, provenance);
    writeJson(qualityReportPath, qualityReport);
    writeJson(licenseReportPath, licenseReport);
    writeJson(rawSnapshotPath, rawSnapshot);

    const metadata = canonicalize({
      dataset_id: datasetId,
      build_id: buildId,
      dataset_type: safeString(input.dataset_type || input.datasetType),
      schema_version: safeString(schema.schema_version),
      target_schema: targetSchema,
      commercialization_ready: input.commercialization_ready === true,
      dedupe_report_path: relativeFrom(baseDir, dedupeReportPath),
      license_report_path: relativeFrom(baseDir, licenseReportPath),
      license_state: normalizeLicenseState(input.license_state),
      quality_threshold: Math.max(0, Number.parseInt(String(input.quality_threshold || input.qualityThreshold || 0), 10) || 0),
      quality_report_path: relativeFrom(baseDir, qualityReportPath),
      quality_status: normalizeValidationStatus(input.quality_status),
      provenance_required: input.provenance_required === true,
      provenance_path: relativeFrom(baseDir, provenancePath),
      packaging_formats: Array.isArray(input.packaging_formats || input.packagingFormats)
        ? (input.packaging_formats || input.packagingFormats).map((entry) => safeString(entry)).filter(Boolean).sort()
        : ["jsonl"],
      row_count: rows.length,
      source_task_ids: Array.isArray(input.source_task_ids) ? input.source_task_ids.map((entry) => safeString(entry)).filter(Boolean).sort() : [],
      source_mission_ids: Array.isArray(input.source_mission_ids) ? input.source_mission_ids.map((entry) => safeString(entry)).filter(Boolean).sort() : [],
      build_started_at: buildStartedAt,
      build_completed_at: buildCompletedAt,
      output_format: "jsonl",
      status: safeString(input.status) || "completed",
      validation_report_path: relativeFrom(baseDir, validationReportPath),
      validation_status: normalizeValidationStatus(input.validation_status, safeString(input.status) === "completed" ? "passed" : "failed"),
      dataset_path: relativeFrom(baseDir, datasetPath),
      schema_path: relativeFrom(baseDir, schemaPath),
      build_report_path: relativeFrom(baseDir, buildReportPath),
      raw_snapshot_path: relativeFrom(baseDir, rawSnapshotPath)
    });
    writeJson(metadataPath, metadata);

    const manifestPath = path.join(stagedBuildDir, "manifest.json");
    const manifest = canonicalize({
      schema_version: "phase20-dataset-manifest-v1",
      dataset_id: datasetId,
      build_id: buildId,
      files: [
        { file: "build-report.json", sha256: hashFile(buildReportPath) },
        { file: "dataset.jsonl", sha256: hashFile(datasetPath) },
        { file: "dedupe-report.json", sha256: hashFile(dedupeReportPath) },
        { file: "license-report.json", sha256: hashFile(licenseReportPath) },
        { file: "metadata.json", sha256: hashFile(metadataPath) },
        { file: "provenance.json", sha256: hashFile(provenancePath) },
        { file: "quality-report.json", sha256: hashFile(qualityReportPath) },
        { file: "schema.json", sha256: hashFile(schemaPath) },
        { file: "validation-report.json", sha256: hashFile(validationReportPath) }
      ]
    });
    writeJson(manifestPath, manifest);

    const index = loadIndex();
    const buildRecord = normalizeBuildRecord({
      dataset_id: datasetId,
      build_id: buildId,
      dataset_type: metadata.dataset_type,
      commercialization_ready: metadata.commercialization_ready,
      target_schema: targetSchema,
      dedupe_report_path: relativeFrom(baseDir, dedupeReportPath),
      license_report_path: relativeFrom(baseDir, licenseReportPath),
      license_state: metadata.license_state,
      status: metadata.status,
      row_count: metadata.row_count,
      source_task_ids: metadata.source_task_ids,
      source_mission_ids: metadata.source_mission_ids,
      build_started_at: buildStartedAt,
      build_completed_at: buildCompletedAt,
      dataset_path: relativeFrom(baseDir, datasetPath),
      metadata_path: relativeFrom(baseDir, metadataPath),
      manifest_path: relativeFrom(baseDir, manifestPath),
      provenance_path: relativeFrom(baseDir, provenancePath),
      quality_report_path: relativeFrom(baseDir, qualityReportPath),
      quality_status: metadata.quality_status,
      schema_path: relativeFrom(baseDir, schemaPath),
      build_report_path: relativeFrom(baseDir, buildReportPath),
      validation_report_path: relativeFrom(baseDir, validationReportPath),
      validation_status: metadata.validation_status
    });

    index.builds = index.builds.filter((entry) => !(entry.dataset_id === datasetId && entry.build_id === buildId));
    index.builds.push(buildRecord);
    index.builds.sort((left, right) => {
      const datasetCompare = left.dataset_id.localeCompare(right.dataset_id);
      if (datasetCompare !== 0) {
        return datasetCompare;
      }
      return left.build_id.localeCompare(right.build_id);
    });

    const datasetBuilds = index.builds.filter((entry) => entry.dataset_id === datasetId);
    const successfulBuilds = datasetBuilds.filter((entry) => entry.status === "completed");
    const validatedBuilds = datasetBuilds.filter((entry) => entry.validation_status === "passed");
    const commercializationReadyBuilds = datasetBuilds.filter((entry) => entry.commercialization_ready === true);
    const reviewRequiredBuilds = datasetBuilds.filter((entry) => entry.status === "completed"
      && entry.validation_status === "passed"
      && entry.quality_status === "passed"
      && entry.license_state === "review_required");
    const latestBuild = datasetBuilds.slice().sort((left, right) => right.build_completed_at.localeCompare(left.build_completed_at) || right.build_id.localeCompare(left.build_id))[0] || buildRecord;
    const latestSuccessfulBuild = successfulBuilds.slice().sort((left, right) => right.build_completed_at.localeCompare(left.build_completed_at) || right.build_id.localeCompare(left.build_id))[0] || null;
    const latestValidatedBuild = validatedBuilds.slice().sort((left, right) => right.build_completed_at.localeCompare(left.build_completed_at) || right.build_id.localeCompare(left.build_id))[0] || null;
    const latestCommercializationReadyBuild = commercializationReadyBuilds.slice().sort((left, right) => right.build_completed_at.localeCompare(left.build_completed_at) || right.build_id.localeCompare(left.build_id))[0] || null;
    const latestReviewRequiredBuild = reviewRequiredBuilds.slice().sort((left, right) => right.build_completed_at.localeCompare(left.build_completed_at) || right.build_id.localeCompare(left.build_id))[0] || null;

    const datasetRecord = normalizeDatasetRecord({
      dataset_id: datasetId,
      dataset_type: metadata.dataset_type,
      latest_build_id: latestBuild.build_id,
      latest_commercialization_ready_build_id: latestCommercializationReadyBuild ? latestCommercializationReadyBuild.build_id : "",
      latest_successful_build_id: latestSuccessfulBuild ? latestSuccessfulBuild.build_id : "",
      latest_review_required_build_id: latestReviewRequiredBuild ? latestReviewRequiredBuild.build_id : "",
      latest_validated_build_id: latestValidatedBuild ? latestValidatedBuild.build_id : "",
      latest_build_completed_at: latestBuild.build_completed_at,
      build_count: datasetBuilds.length
    });

    index.datasets = index.datasets.filter((entry) => entry.dataset_id !== datasetId);
    index.datasets.push(datasetRecord);
    index.datasets.sort((left, right) => left.dataset_id.localeCompare(right.dataset_id));
    persistIndex(index);

    return canonicalize({
      dataset_id: datasetId,
      build_id: buildId,
      dataset_dir: stagedBuildDir,
      dataset_path: datasetPath,
      metadata_path: metadataPath,
      manifest_path: manifestPath,
      schema_path: schemaPath,
      build_report_path: buildReportPath,
      dedupe_report_path: dedupeReportPath,
      license_report_path: licenseReportPath,
      provenance_path: provenancePath,
      quality_report_path: qualityReportPath,
      raw_snapshot_path: rawSnapshotPath,
      validation_report_path: validationReportPath
    });
  }

  function getBuild(datasetId, buildId = "") {
    const normalizedDatasetId = safeString(datasetId);
    const normalizedBuildId = safeString(buildId);
    const index = loadIndex();
    const match = index.builds.find((entry) => entry.dataset_id === normalizedDatasetId && (!normalizedBuildId || entry.build_id === normalizedBuildId));
    if (!match) {
      return null;
    }
    const datasetDir = path.join(baseDir, match.dataset_path);
    const metadataPath = path.join(baseDir, match.metadata_path);
    const manifestPath = path.join(baseDir, match.manifest_path);
    const readOptionalArtifact = (relPath) => {
      const normalizedRel = safeString(relPath);
      return normalizedRel ? readJson(path.join(baseDir, normalizedRel), {}) : {};
    };
    return canonicalize({
      ...match,
      build_report: readOptionalArtifact(match.build_report_path),
      dedupe_report: readOptionalArtifact(match.dedupe_report_path),
      dataset_dir: path.dirname(datasetDir),
      license_report: readOptionalArtifact(match.license_report_path),
      metadata: readJson(metadataPath, {}),
      manifest: readJson(manifestPath, {}),
      provenance: readOptionalArtifact(match.provenance_path),
      quality_report: readOptionalArtifact(match.quality_report_path),
      validation_report: readOptionalArtifact(match.validation_report_path)
    });
  }

  function listBuilds(datasetId = "") {
    const normalizedDatasetId = safeString(datasetId);
    const index = loadIndex();
    return canonicalize(index.builds.filter((entry) => !normalizedDatasetId || entry.dataset_id === normalizedDatasetId));
  }

  function resolveLatestSuccessfulBuild(datasetId) {
    const normalizedDatasetId = safeString(datasetId);
    const index = loadIndex();
    const dataset = index.datasets.find((entry) => entry.dataset_id === normalizedDatasetId);
    if (!dataset || !dataset.latest_successful_build_id) {
      return null;
    }
    return getBuild(normalizedDatasetId, dataset.latest_successful_build_id);
  }

  function resolveLatestCommercializationReadyBuild(datasetId) {
    const normalizedDatasetId = safeString(datasetId);
    const index = loadIndex();
    const dataset = index.datasets.find((entry) => entry.dataset_id === normalizedDatasetId);
    if (!dataset || !dataset.latest_commercialization_ready_build_id) {
      return null;
    }
    return getBuild(normalizedDatasetId, dataset.latest_commercialization_ready_build_id);
  }

  function generateOutputManifest() {
    const index = loadIndex();
    const files = [];
    for (const build of index.builds) {
      for (const rel of [
        build.dataset_path,
        build.metadata_path,
        build.manifest_path,
        build.schema_path,
        build.build_report_path,
        build.validation_report_path,
        build.dedupe_report_path,
        build.provenance_path,
        build.quality_report_path,
        build.license_report_path
      ]) {
        const filePath = path.join(baseDir, rel);
        if (rel && fs.existsSync(filePath)) {
          files.push(canonicalize({
            file: rel,
            sha256: hashFile(filePath)
          }));
        }
      }
    }
    files.sort((left, right) => left.file.localeCompare(right.file));
    const manifest = canonicalize({
      schema_version: "phase20-dataset-catalog-v1",
      files
    });
    const manifestPath = path.join(indexDir, "hash-manifest.json");
    writeJson(manifestPath, manifest);
    return canonicalize({
      path: manifestPath,
      files
    });
  }

  return Object.freeze({
    saveBuild,
    getBuild,
    listBuilds,
    resolveLatestCommercializationReadyBuild,
    resolveLatestSuccessfulBuild,
    generateOutputManifest,
    loadIndex,
    baseDir,
    rawDir,
    stagedDir,
    indexDir,
    indexPath
  });
}

module.exports = {
  createDatasetOutputManager
};
