"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const INDEX_SCHEMA_VERSION = "phase19-datasets-index-v1";

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

function normalizeBuildRecord(input = {}) {
  return canonicalize({
    dataset_id: safeString(input.dataset_id),
    build_id: safeString(input.build_id),
    dataset_type: safeString(input.dataset_type),
    target_schema: safeString(input.target_schema),
    status: safeString(input.status) || "completed",
    row_count: Math.max(0, Number.parseInt(String(input.row_count || 0), 10) || 0),
    source_task_ids: Array.isArray(input.source_task_ids) ? input.source_task_ids.map((entry) => safeString(entry)).filter(Boolean).sort() : [],
    source_mission_ids: Array.isArray(input.source_mission_ids) ? input.source_mission_ids.map((entry) => safeString(entry)).filter(Boolean).sort() : [],
    build_started_at: normalizeIso(input.build_started_at),
    build_completed_at: normalizeIso(input.build_completed_at),
    dataset_path: safeString(input.dataset_path),
    metadata_path: safeString(input.metadata_path),
    manifest_path: safeString(input.manifest_path),
    schema_path: safeString(input.schema_path),
    build_report_path: safeString(input.build_report_path)
  });
}

function normalizeDatasetRecord(input = {}) {
  return canonicalize({
    dataset_id: safeString(input.dataset_id),
    dataset_type: safeString(input.dataset_type),
    latest_build_id: safeString(input.latest_build_id),
    latest_successful_build_id: safeString(input.latest_successful_build_id),
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

    const datasetPath = path.join(stagedBuildDir, "dataset.jsonl");
    const metadataPath = path.join(stagedBuildDir, "metadata.json");
    const schemaPath = path.join(stagedBuildDir, "schema.json");
    const buildReportPath = path.join(stagedBuildDir, "build-report.json");
    const rawSnapshotPath = path.join(rawDatasetDir, `source-${buildId}.json`);

    writeDatasetJsonl(datasetPath, rows);
    writeJson(schemaPath, schema);
    writeJson(buildReportPath, buildReport);
    writeJson(rawSnapshotPath, rawSnapshot);

    const metadata = canonicalize({
      dataset_id: datasetId,
      build_id: buildId,
      dataset_type: safeString(input.dataset_type || input.datasetType),
      schema_version: safeString(schema.schema_version),
      target_schema: targetSchema,
      quality_threshold: Math.max(0, Number.parseInt(String(input.quality_threshold || input.qualityThreshold || 0), 10) || 0),
      provenance_required: input.provenance_required === true,
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
      dataset_path: relativeFrom(baseDir, datasetPath),
      schema_path: relativeFrom(baseDir, schemaPath),
      build_report_path: relativeFrom(baseDir, buildReportPath),
      raw_snapshot_path: relativeFrom(baseDir, rawSnapshotPath)
    });
    writeJson(metadataPath, metadata);

    const manifestPath = path.join(stagedBuildDir, "manifest.json");
    const manifest = canonicalize({
      schema_version: "phase19-dataset-manifest-v1",
      dataset_id: datasetId,
      build_id: buildId,
      files: [
        { file: "build-report.json", sha256: hashFile(buildReportPath) },
        { file: "dataset.jsonl", sha256: hashFile(datasetPath) },
        { file: "metadata.json", sha256: hashFile(metadataPath) },
        { file: "schema.json", sha256: hashFile(schemaPath) }
      ]
    });
    writeJson(manifestPath, manifest);

    const index = loadIndex();
    const buildRecord = normalizeBuildRecord({
      dataset_id: datasetId,
      build_id: buildId,
      dataset_type: metadata.dataset_type,
      target_schema: targetSchema,
      status: metadata.status,
      row_count: metadata.row_count,
      source_task_ids: metadata.source_task_ids,
      source_mission_ids: metadata.source_mission_ids,
      build_started_at: buildStartedAt,
      build_completed_at: buildCompletedAt,
      dataset_path: relativeFrom(baseDir, datasetPath),
      metadata_path: relativeFrom(baseDir, metadataPath),
      manifest_path: relativeFrom(baseDir, manifestPath),
      schema_path: relativeFrom(baseDir, schemaPath),
      build_report_path: relativeFrom(baseDir, buildReportPath)
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
    const latestBuild = datasetBuilds.slice().sort((left, right) => right.build_completed_at.localeCompare(left.build_completed_at) || right.build_id.localeCompare(left.build_id))[0] || buildRecord;
    const latestSuccessfulBuild = successfulBuilds.slice().sort((left, right) => right.build_completed_at.localeCompare(left.build_completed_at) || right.build_id.localeCompare(left.build_id))[0] || null;

    const datasetRecord = normalizeDatasetRecord({
      dataset_id: datasetId,
      dataset_type: metadata.dataset_type,
      latest_build_id: latestBuild.build_id,
      latest_successful_build_id: latestSuccessfulBuild ? latestSuccessfulBuild.build_id : "",
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
      raw_snapshot_path: rawSnapshotPath
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
    return canonicalize({
      ...match,
      dataset_dir: path.dirname(datasetDir),
      metadata: readJson(metadataPath, {}),
      manifest: readJson(manifestPath, {})
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

  function generateOutputManifest() {
    const index = loadIndex();
    const files = [];
    for (const build of index.builds) {
      for (const rel of [build.dataset_path, build.metadata_path, build.manifest_path, build.schema_path, build.build_report_path]) {
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
      schema_version: "phase19-dataset-catalog-v1",
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
