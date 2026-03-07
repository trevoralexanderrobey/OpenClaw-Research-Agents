"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createDatasetDeduper } = require("./dataset-deduper.js");
const { createDatasetScorer } = require("./dataset-scorer.js");
const { createDatasetValidator } = require("./dataset-validator.js");
const { createLicenseReview } = require("./license-review.js");
const { createProvenanceTracker } = require("./provenance-tracker.js");
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

function relativeFromRoot(rootDir, filePath) {
  const rawPath = safeString(filePath);
  if (!rawPath) {
    return "";
  }
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(rawPath);
  if (!resolvedFile.startsWith(resolvedRoot)) {
    return rawPath;
  }
  return path.relative(resolvedRoot, resolvedFile).split(path.sep).join("/");
}

function stableReasonCodes(groups = []) {
  return Array.from(new Set((Array.isArray(groups) ? groups : [])
    .flatMap((group) => Array.isArray(group) ? group : [group])
    .map((entry) => {
      if (typeof entry === "string") {
        return safeString(entry);
      }
      return safeString(entry && (entry.code || entry.reason_code));
    })
    .filter(Boolean))).sort((left, right) => left.localeCompare(right));
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
  const validator = options.validator || createDatasetValidator({
    rootDir,
    schemaEngine
  });
  const deduper = options.deduper || createDatasetDeduper({
    rootDir
  });
  const provenanceTracker = options.provenanceTracker || createProvenanceTracker({
    rootDir
  });
  const scorer = options.scorer || createDatasetScorer({
    rootDir,
    schemaEngine
  });
  const licenseReview = options.licenseReview || createLicenseReview({
    rootDir
  });
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  if (!schemaEngine || typeof schemaEngine.validateRows !== "function") {
    throw new Error("schemaEngine.validateRows is required");
  }
  if (!outputManager || typeof outputManager.saveBuild !== "function") {
    throw new Error("outputManager.saveBuild is required");
  }
  if (!validator || typeof validator.validateBuild !== "function") {
    throw new Error("validator.validateBuild is required");
  }
  if (!deduper || typeof deduper.dedupeRows !== "function") {
    throw new Error("deduper.dedupeRows is required");
  }
  if (!provenanceTracker || typeof provenanceTracker.trackBuild !== "function") {
    throw new Error("provenanceTracker.trackBuild is required");
  }
  if (!scorer || typeof scorer.scoreBuild !== "function") {
    throw new Error("scorer.scoreBuild is required");
  }
  if (!licenseReview || typeof licenseReview.classifyBuild !== "function") {
    throw new Error("licenseReview.classifyBuild is required");
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
    const validatorConfigHash = typeof validator.getConfigSnapshotHash === "function"
      ? validator.getConfigSnapshotHash(datasetType)
      : "";
    const qualityRulesSnapshot = typeof validator.getQualityRules === "function"
      ? validator.getQualityRules(datasetType)
      : {};
    const configSnapshotHash = sha256(JSON.stringify(canonicalize({
      base_schema: schemaEngine.getConfigSnapshotHash(datasetType),
      dedupe: typeof deduper.getConfigSnapshotHash === "function"
        ? deduper.getConfigSnapshotHash(qualityRulesSnapshot && qualityRulesSnapshot.dedupe)
        : "",
      license: typeof licenseReview.getConfigSnapshotHash === "function"
        ? licenseReview.getConfigSnapshotHash()
        : "",
      provenance: typeof provenanceTracker.getConfigSnapshotHash === "function"
        ? provenanceTracker.getConfigSnapshotHash()
        : "",
      scorer: typeof scorer.getConfigSnapshotHash === "function"
        ? scorer.getConfigSnapshotHash(datasetType)
        : "",
      validator: validatorConfigHash
    })));
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
    const validationMetadata = canonicalize({
      build_id: buildId,
      dataset_id: datasetId,
      dataset_type: datasetType,
      quality_threshold: Math.max(0, Number.parseInt(String(input.quality_threshold || input.qualityThreshold || 0), 10) || 0),
      source_mission_ids: missionId ? [missionId] : [],
      source_task_ids: sourceTaskIds,
      target_schema: targetSchema
    });
    const validation = validator.validateBuild({
      dataset_type: datasetType,
      metadata: validationMetadata,
      rows: rawRows
    });
    const candidateRows = validation.row_results
      .filter((entry) => entry.ok === true)
      .map((entry) => {
        const segment = segments[Math.max(0, Number(entry.row_number || 1) - 1)] || {};
        return canonicalize({
          block_index: Number(segment.block_index || 0),
          label: safeString(segment.label),
          row: canonicalize(entry.normalized_row),
          row_hash: safeString(entry.row_hash),
          row_number: Number(entry.row_number || 0),
          task_id: safeString(segment.task_id)
        });
      });
    const dedupe = deduper.dedupeRows({
      dedupe: validation.quality_rules && validation.quality_rules.dedupe,
      rows: candidateRows
    });
    const provenance = provenanceTracker.trackBuild({
      dedupe_result: dedupe.ok ? dedupe : { rows: [] },
      source_artifacts: taskArtifacts.map((artifact) => canonicalize({
        metadata: canonicalize(artifact.metadata || {}),
        output_path: safeString(artifact.output_path),
        task_id: safeString(artifact.task_id)
      })),
      source_mission_ids: missionId ? [missionId] : [],
      transformation_steps: [
        "resolve_sources",
        "segment_source_artifacts",
        "map_segments_to_rows",
        "validate_rows",
        "dedupe_rows",
        "attach_provenance"
      ]
    });
    const score = scorer.scoreBuild({
      dataset_type: datasetType,
      dedupe_result: dedupe.ok ? dedupe : { rows: [] },
      metadata: validationMetadata,
      provenance_result: provenance,
      validation_result: validation
    });
    const license = licenseReview.classifyBuild({
      provenance_result: provenance,
      source_artifacts: taskArtifacts.map((artifact) => canonicalize({
        metadata: canonicalize(artifact.metadata || {}),
        output_path: safeString(artifact.output_path),
        task_id: safeString(artifact.task_id)
      }))
    });
    const finalRows = dedupe.ok
      ? dedupe.rows.map((entry) => canonicalize(entry.row))
      : [];
    const pipelineCompleted = validation.ok === true
      && dedupe.ok === true
      && provenance.ok === true
      && score.ok === true
      && license.ok === true;
    const validationStatus = safeString(validation.validation_status) || "failed";
    const qualityStatus = safeString(score.quality_status) || "failed";
    const licenseState = safeString(license.license_state) || "blocked";
    const commercializationReady = pipelineCompleted
      && validationStatus === "passed"
      && qualityStatus === "passed"
      && licenseState === "allowed";
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
      commercialization_ready: commercializationReady,
      dedupe_report: dedupe.report,
      license_report: license.license_report,
      license_state: licenseState,
      provenance: provenance.provenance,
      quality_report: score.quality_report,
      quality_status: qualityStatus,
      rows: finalRows,
      schema: validation.schema,
      status: pipelineCompleted ? "completed" : "failed",
      validation_report: validation.report,
      validation_status: validationStatus,
      build_report: {
        build_stage_status: pipelineCompleted ? "completed" : "failed",
        commercialization_ready: commercializationReady,
        dedupe_summary: canonicalize(dedupe.report && dedupe.report.build_summary ? dedupe.report.build_summary : {}),
        dataset_id: datasetId,
        build_id: buildId,
        dataset_type: datasetType,
        license_state: licenseState,
        license_summary: canonicalize(license.license_report && license.license_report.build_summary ? license.license_report.build_summary : {}),
        target_schema: targetSchema,
        quality_status: qualityStatus,
        quality_summary: canonicalize(score.quality_report && score.quality_report.build_summary ? score.quality_report.build_summary : {}),
        reason_codes: stableReasonCodes([
          validation.report && validation.report.build_summary ? validation.report.build_summary.reason_codes : [],
          dedupe.collision_report,
          Array.isArray(provenance.invalid_rows)
            ? provenance.invalid_rows.flatMap((entry) => Array.isArray(entry.reason_codes) ? entry.reason_codes : [])
            : [],
          score.quality_report && score.quality_report.build_summary ? score.quality_report.build_summary.reason_codes : [],
          license.license_report && license.license_report.build_summary
            ? [
              ...(license.license_report.build_summary.blocked_reason_codes || []),
              ...(license.license_report.build_summary.review_required_reason_codes || [])
            ]
            : []
        ]),
        row_count: finalRows.length,
        source_task_ids: sourceTaskIds,
        source_mission_ids: missionId ? [missionId] : [],
        config_snapshot_hash: configSnapshotHash,
        validation_status: validationStatus,
        validation_summary: canonicalize(validation.report && validation.report.build_summary ? validation.report.build_summary : {})
      },
      raw_snapshot: {
        dataset_id: datasetId,
        build_id: buildId,
        dataset_type: datasetType,
        source_task_ids: sourceTaskIds,
        source_mission_ids: missionId ? [missionId] : [],
        source_artifacts: taskArtifacts.map((artifact) => canonicalize({
          output_ref: relativeFromRoot(rootDir, safeString(artifact.output_path)),
          task_id: safeString(artifact.task_id),
          output_path: safeString(artifact.output_path),
          metadata: canonicalize(artifact.metadata || {})
        })),
        segments,
        validation_candidates: validation.row_results.map((entry) => canonicalize({
          ok: entry.ok === true,
          row_hash: safeString(entry.row_hash),
          row_number: Number(entry.row_number || 0)
        }))
      },
      source_task_ids: sourceTaskIds,
      source_mission_ids: missionId ? [missionId] : [],
      build_started_at: normalizeIso(input.build_started_at || input.buildStartedAt || nowIso),
      build_completed_at: nowIso
    });

    return canonicalize({
      commercialization_ready: commercializationReady,
      dataset_id: datasetId,
      build_id: buildId,
      dataset_type: datasetType,
      license_state: licenseState,
      ok: pipelineCompleted,
      quality_status: qualityStatus,
      target_schema: targetSchema,
      row_count: finalRows.length,
      source_task_ids: sourceTaskIds,
      source_mission_ids: missionId ? [missionId] : [],
      validation_status: validationStatus,
      dataset_path: saved.dataset_path,
      metadata_path: saved.metadata_path,
      manifest_path: saved.manifest_path,
      schema_path: saved.schema_path,
      build_report_path: saved.build_report_path,
      dedupe_report_path: saved.dedupe_report_path,
      license_report_path: saved.license_report_path,
      provenance_path: saved.provenance_path,
      quality_report_path: saved.quality_report_path,
      raw_snapshot_path: saved.raw_snapshot_path,
      validation_report_path: saved.validation_report_path
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
