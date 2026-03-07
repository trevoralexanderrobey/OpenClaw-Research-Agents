"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function detectTaskOutputFile(taskDir) {
  for (const candidate of ["output.md", "output.json", "output.txt"]) {
    const filePath = path.join(taskDir, candidate);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return "";
}

function normalizeIso(value) {
  const text = safeString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : "1970-01-01T00:00:00.000Z";
}

function shortText(value, fallback) {
  const text = safeString(String(value || ""));
  if (!text) {
    return safeString(fallback);
  }
  const firstLine = text.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) || text;
  return firstLine.slice(0, 160);
}

function splitIntoBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTaskIdFromOutputPath(filePath) {
  if (!safeString(filePath)) {
    return "";
  }
  return path.basename(path.dirname(path.resolve(filePath)));
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function buildDeterministicDatasetId(input = {}) {
  const datasetType = safeString(input.dataset_type || input.datasetType);
  const sourceTaskIds = asStringArray(input.source_task_ids || input.sourceTaskIds).sort();
  const sourceMissionIds = asStringArray(input.source_mission_ids || input.sourceMissionIds).sort();
  const seed = canonicalize({
    dataset_type: datasetType,
    source_task_ids: sourceTaskIds,
    source_mission_ids: sourceMissionIds
  });
  return `dataset-${sha256(JSON.stringify(seed)).slice(0, 16)}`;
}

function createDatasetBuilder(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const schemaEngine = options.schemaEngine;
  const outputManager = options.outputManager;
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  if (!schemaEngine || typeof schemaEngine.validateRows !== "function") {
    throw new Error("schemaEngine.validateRows is required");
  }
  if (!outputManager || typeof outputManager.saveBuild !== "function") {
    throw new Error("outputManager.saveBuild is required");
  }

  function resolveTaskSource(taskId) {
    const normalizedTaskId = safeString(taskId);
    const taskDir = path.join(rootDir, "workspace", "research-output", normalizedTaskId);
    const outputPath = detectTaskOutputFile(taskDir);
    if (!normalizedTaskId || !outputPath || !fs.existsSync(outputPath)) {
      const error = new Error(`Task output '${normalizedTaskId}' not found`);
      error.code = "PHASE19_SOURCE_TASK_NOT_FOUND";
      throw error;
    }
    const metadataPath = path.join(taskDir, "metadata.json");
    const manifestPath = path.join(taskDir, "manifest.json");
    const content = readText(outputPath);
    return canonicalize({
      source_kind: "task",
      task_id: normalizedTaskId,
      output_path: outputPath,
      content,
      metadata: fs.existsSync(metadataPath) ? readJson(metadataPath) : {},
      manifest: fs.existsSync(manifestPath) ? readJson(manifestPath) : {}
    });
  }

  function resolveMissionSources(missionId) {
    const normalizedMissionId = safeString(missionId);
    const missionRoot = path.join(rootDir, "workspace", "missions", normalizedMissionId);
    const summaryPath = path.join(missionRoot, "artifacts", "mission-summary.json");
    const statusPath = path.join(missionRoot, "status.json");
    if (!normalizedMissionId || !fs.existsSync(summaryPath)) {
      const error = new Error(`Mission '${normalizedMissionId}' summary not found`);
      error.code = "PHASE19_SOURCE_MISSION_NOT_FOUND";
      throw error;
    }
    const summary = readJson(summaryPath);
    const status = fs.existsSync(statusPath) ? readJson(statusPath) : {};
    const sourceTaskIds = [];
    const artifacts = [];

    for (const entry of Array.isArray(summary.subtask_results) ? summary.subtask_results : []) {
      const outputPath = safeString(entry.output_path);
      if (!outputPath) {
        continue;
      }
      const taskId = parseTaskIdFromOutputPath(outputPath);
      if (!taskId) {
        continue;
      }
      sourceTaskIds.push(taskId);
      artifacts.push(resolveTaskSource(taskId));
    }

    return canonicalize({
      mission_id: normalizedMissionId,
      source_task_ids: sourceTaskIds.sort(),
      mission_summary: summary,
      mission_status: status,
      artifacts
    });
  }

  function buildSegmentsFromArtifacts(artifacts = []) {
    const segments = [];
    for (const artifact of artifacts) {
      const content = safeString(artifact.content);
      const blocks = splitIntoBlocks(content);
      if (blocks.length === 0) {
        continue;
      }
      blocks.forEach((block, index) => {
        segments.push(canonicalize({
          task_id: safeString(artifact.task_id),
          block_index: index + 1,
          label: shortText(block, artifact.task_id),
          block
        }));
      });
    }
    return canonicalize(segments);
  }

  function mapSegmentsToRows(datasetType, segments = []) {
    return canonicalize(segments.map((segment, index) => {
      const prompt = shortText(segment.block, `${segment.task_id} block ${segment.block_index}`);
      if (datasetType === "instruction_qa") {
        return {
          instruction: `Explain ${prompt}`,
          context: segment.block,
          answer: segment.block
        };
      }
      if (datasetType === "retrieval_qa") {
        return {
          query: `What does ${prompt} describe?`,
          context: segment.block,
          answer: segment.block
        };
      }
      if (datasetType === "benchmark_eval") {
        return {
          prompt: segment.block,
          expected_answer: segment.block,
          evaluation_criteria: "Check completeness, factual consistency, and direct grounding in the source block."
        };
      }
      if (datasetType === "classification") {
        return {
          text: segment.block,
          label: safeString(segment.task_id) || `segment-${index + 1}`,
          label_rationale: `Derived deterministically from source task ${safeString(segment.task_id) || "unknown"}.`
        };
      }
      if (datasetType === "knowledge_graph") {
        return {
          subject: safeString(segment.task_id) || `source-${index + 1}`,
          predicate: "contains_statement",
          object: prompt,
          context: segment.block
        };
      }
      const error = new Error(`Unsupported dataset type '${safeString(datasetType)}'`);
      error.code = "PHASE19_DATASET_TYPE_UNKNOWN";
      throw error;
    }));
  }

  function computeBuildId(input = {}) {
    const datasetId = safeString(input.dataset_id || input.datasetId);
    const datasetType = safeString(input.dataset_type || input.datasetType);
    const targetSchema = safeString(input.target_schema || input.targetSchema);
    const qualityThreshold = Math.max(0, Number.parseInt(String(input.quality_threshold || input.qualityThreshold || 0), 10) || 0);
    const sourceTaskIds = asStringArray(input.source_task_ids || input.sourceTaskIds).sort();
    const sourceMissionIds = asStringArray(input.source_mission_ids || input.sourceMissionIds).sort();
    const sourceHashes = Array.isArray(input.source_hashes) ? input.source_hashes.map((entry) => safeString(entry)).filter(Boolean).sort() : [];
    const configSnapshotHash = safeString(input.config_snapshot_hash || input.configSnapshotHash);
    const seed = canonicalize({
      dataset_id: datasetId,
      dataset_type: datasetType,
      target_schema: targetSchema,
      quality_threshold: qualityThreshold,
      source_task_ids: sourceTaskIds,
      source_mission_ids: sourceMissionIds,
      source_hashes: sourceHashes,
      config_snapshot_hash: configSnapshotHash
    });
    return `build-${sha256(JSON.stringify(seed)).slice(0, 16)}`;
  }

  function buildDatasetFromSources(input = {}) {
    const datasetType = safeString(input.dataset_type || input.datasetType);
    const targetSchema = safeString(input.target_schema || input.targetSchema) || safeString(schemaEngine.getDatasetSchema(datasetType).schema_version);
    const taskIds = asStringArray(input.task_ids || input.taskIds).sort();
    const missionId = safeString(input.mission_id || input.missionId);
    const missionSources = missionId ? resolveMissionSources(missionId) : null;
    const taskArtifacts = missionSources ? missionSources.artifacts : taskIds.map((taskId) => resolveTaskSource(taskId));
    const sourceTaskIds = missionSources ? missionSources.source_task_ids : taskArtifacts.map((artifact) => safeString(artifact.task_id)).filter(Boolean).sort();
    const datasetId = safeString(input.dataset_id || input.datasetId)
      || (missionSources && safeString(missionSources.mission_status.dataset_id))
      || buildDeterministicDatasetId({
        dataset_type: datasetType,
        source_task_ids: sourceTaskIds,
        source_mission_ids: missionId ? [missionId] : []
      });
    const configSnapshotHash = schemaEngine.getConfigSnapshotHash(datasetType);
    const sourceHashes = taskArtifacts.map((artifact) => sha256(`${artifact.task_id}|${artifact.content}`)).sort();
    const buildId = safeString(input.build_id || input.buildId) || computeBuildId({
      dataset_id: datasetId,
      dataset_type: datasetType,
      target_schema: targetSchema,
      quality_threshold: input.quality_threshold,
      source_task_ids: sourceTaskIds,
      source_mission_ids: missionId ? [missionId] : [],
      source_hashes: sourceHashes,
      config_snapshot_hash: configSnapshotHash
    });
    const segments = buildSegmentsFromArtifacts(taskArtifacts);
    const rawRows = mapSegmentsToRows(datasetType, segments);
    const validation = schemaEngine.validateRows(datasetType, rawRows);
    const nowIso = normalizeIso(timeProvider.nowIso());
    const saved = outputManager.saveBuild({
      dataset_id: datasetId,
      build_id: buildId,
      dataset_type: datasetType,
      target_schema: targetSchema,
      quality_threshold: Math.max(0, Number.parseInt(String(input.quality_threshold || input.qualityThreshold || 0), 10) || 0),
      provenance_required: input.provenance_required === true,
      packaging_formats: Array.isArray(input.packaging_formats || input.packagingFormats)
        ? (input.packaging_formats || input.packagingFormats)
        : ["jsonl"],
      status: validation.ok ? "completed" : "failed",
      rows: validation.rows,
      schema: validation.schema,
      build_report: {
        ok: validation.ok,
        dataset_id: datasetId,
        build_id: buildId,
        dataset_type: datasetType,
        target_schema: targetSchema,
        row_count: validation.row_count,
        source_task_ids: sourceTaskIds,
        source_mission_ids: missionId ? [missionId] : [],
        config_snapshot_hash: configSnapshotHash,
        violations: validation.violations
      },
      raw_snapshot: {
        dataset_id: datasetId,
        build_id: buildId,
        dataset_type: datasetType,
        source_task_ids: sourceTaskIds,
        source_mission_ids: missionId ? [missionId] : [],
        source_artifacts: taskArtifacts.map((artifact) => canonicalize({
          task_id: safeString(artifact.task_id),
          output_path: safeString(artifact.output_path),
          metadata: canonicalize(artifact.metadata || {})
        })),
        segments
      },
      source_task_ids: sourceTaskIds,
      source_mission_ids: missionId ? [missionId] : [],
      build_started_at: normalizeIso(input.build_started_at || input.buildStartedAt || nowIso),
      build_completed_at: nowIso
    });

    return canonicalize({
      ok: validation.ok,
      dataset_id: datasetId,
      build_id: buildId,
      dataset_type: datasetType,
      target_schema: targetSchema,
      row_count: validation.row_count,
      source_task_ids: sourceTaskIds,
      source_mission_ids: missionId ? [missionId] : [],
      violations: validation.violations,
      dataset_path: saved.dataset_path,
      metadata_path: saved.metadata_path,
      manifest_path: saved.manifest_path,
      schema_path: saved.schema_path,
      build_report_path: saved.build_report_path,
      raw_snapshot_path: saved.raw_snapshot_path
    });
  }

  return Object.freeze({
    buildDatasetFromSources,
    resolveTaskSource,
    resolveMissionSources,
    computeBuildId,
    buildDeterministicDatasetId
  });
}

module.exports = {
  createDatasetBuilder
};
