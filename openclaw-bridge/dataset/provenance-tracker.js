"use strict";

const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function relativeFromRoot(rootDir, filePath) {
  if (!safeString(filePath)) {
    return "";
  }
  const normalizedRoot = safeString(rootDir);
  if (!normalizedRoot) {
    return safeString(filePath);
  }
  const resolvedRoot = path.resolve(normalizedRoot);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot)) {
    return safeString(filePath);
  }
  return path.relative(resolvedRoot, resolvedFile).split(path.sep).join("/");
}

function stableReasonCodes(items) {
  return Array.from(new Set((Array.isArray(items) ? items : [])
    .map((entry) => safeString(entry.code))
    .filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function createProvenanceTracker(options = {}) {
  const rootDir = safeString(options.rootDir);

  function trackBuild(input = {}) {
    const sourceArtifacts = Array.isArray(input.source_artifacts)
      ? input.source_artifacts.map((entry) => canonicalize(entry))
      : [];
    const artifactByTaskId = new Map(sourceArtifacts.map((entry) => [safeString(entry.task_id), entry]));
    const dedupeResult = asPlainObject(input.dedupe_result);
    const dedupedRows = Array.isArray(dedupeResult.rows) ? dedupeResult.rows.map((entry) => canonicalize(entry)) : [];
    const sourceMissionIds = asStringArray(input.source_mission_ids);
    const transformationSteps = asStringArray(input.transformation_steps);
    const rowRecords = [];
    const invalidRows = [];

    for (const dedupedRow of dedupedRows) {
      const duplicateRowNumbers = Array.isArray(dedupedRow.duplicate_row_numbers)
        ? dedupedRow.duplicate_row_numbers.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry)).sort((left, right) => left - right)
        : [];
      const sourceEntries = Array.isArray(dedupedRow.source_entries) && dedupedRow.source_entries.length > 0
        ? dedupedRow.source_entries.map((entry) => canonicalize(entry))
        : [canonicalize({
          block_index: Number(dedupedRow.block_index || 0),
          label: safeString(dedupedRow.label),
          row_number: Number(dedupedRow.row_number || 0),
          task_id: safeString(dedupedRow.task_id)
        })];
      const sourceTaskIds = Array.from(new Set(sourceEntries.map((entry) => safeString(entry.task_id)).filter(Boolean))).sort((left, right) => left.localeCompare(right));
      const sourceArtifactsForRow = sourceTaskIds.map((taskId) => {
        const artifact = artifactByTaskId.get(taskId);
        if (!artifact) {
          return null;
        }
        return canonicalize({
          metadata: canonicalize(asPlainObject(artifact.metadata)),
          output_path: relativeFromRoot(rootDir, safeString(artifact.output_path)),
          task_id: taskId
        });
      }).filter(Boolean);
      const segmentRefs = sourceEntries
        .filter((entry) => safeString(entry.task_id))
        .map((entry) => canonicalize({
          block_index: Number(entry.block_index || 0),
          label: safeString(entry.label),
          task_id: safeString(entry.task_id)
        }))
        .sort((left, right) => {
          const taskCompare = safeString(left.task_id).localeCompare(safeString(right.task_id));
          if (taskCompare !== 0) {
            return taskCompare;
          }
          return Number(left.block_index || 0) - Number(right.block_index || 0);
        });
      const rowViolations = [];
      if (!safeString(dedupedRow.row_hash)) {
        rowViolations.push(canonicalize({
          code: "PHASE20_PROVENANCE_ROW_HASH_REQUIRED",
          message: "Provenance requires row_hash"
        }));
      }
      if (sourceTaskIds.length === 0) {
        rowViolations.push(canonicalize({
          code: "PHASE20_PROVENANCE_TASK_REQUIRED",
          message: `Row '${safeString(dedupedRow.row_hash)}' is missing task lineage`
        }));
      }
      if (sourceArtifactsForRow.length === 0) {
        rowViolations.push(canonicalize({
          code: "PHASE20_PROVENANCE_ARTIFACT_REQUIRED",
          message: `Row '${safeString(dedupedRow.row_hash)}' is missing a source artifact reference`
        }));
      }
      if (segmentRefs.length === 0) {
        rowViolations.push(canonicalize({
          code: "PHASE20_PROVENANCE_SEGMENT_REQUIRED",
          message: `Row '${safeString(dedupedRow.row_hash)}' is missing a source segment reference`
        }));
      }

      const record = canonicalize({
        duplicate_row_numbers: duplicateRowNumbers,
        ok: rowViolations.length === 0,
        reason_codes: stableReasonCodes(rowViolations),
        row_hash: safeString(dedupedRow.row_hash),
        row_number: Number(dedupedRow.row_number || 0),
        source_artifacts: sourceArtifactsForRow,
        source_mission_ids: sourceMissionIds,
        source_task_ids: sourceTaskIds,
        source_segment_refs: segmentRefs,
        transformation_steps: transformationSteps,
        violations: rowViolations
      });
      rowRecords.push(record);
      if (!record.ok) {
        invalidRows.push(record);
      }
    }

    const uniqueTaskIds = Array.from(new Set(rowRecords.flatMap((entry) => entry.source_task_ids))).sort((left, right) => left.localeCompare(right));
    const uniqueArtifactRefs = Array.from(new Set(rowRecords.flatMap((entry) => entry.source_artifacts.map((artifact) => safeString(artifact.output_path))))).sort((left, right) => left.localeCompare(right));
    const summary = canonicalize({
      artifact_reference_count: uniqueArtifactRefs.length,
      invalid_row_count: invalidRows.length,
      row_count: rowRecords.length,
      source_artifact_refs: uniqueArtifactRefs,
      source_mission_ids: sourceMissionIds,
      source_task_ids: uniqueTaskIds,
      transformation_steps: transformationSteps
    });

    const provenance = canonicalize({
      build_summary: {
        ...summary,
        provenance_hash: sha256(JSON.stringify(canonicalize({
          source_artifact_refs: uniqueArtifactRefs,
          source_mission_ids: sourceMissionIds,
          source_task_ids: uniqueTaskIds,
          transformation_steps: transformationSteps
        })))
      },
      row_records: rowRecords
    });

    return canonicalize({
      invalid_rows: invalidRows,
      ok: invalidRows.length === 0,
      provenance,
      row_records: rowRecords
    });
  }

  function getConfigSnapshotHash() {
    return sha256(JSON.stringify(canonicalize({
      root_dir_configured: Boolean(rootDir),
      version: "phase20-provenance-tracker-v1"
    })));
  }

  return Object.freeze({
    getConfigSnapshotHash,
    trackBuild
  });
}

module.exports = {
  createProvenanceTracker
};
