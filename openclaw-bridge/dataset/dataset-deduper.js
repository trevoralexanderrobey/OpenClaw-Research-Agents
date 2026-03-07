"use strict";

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createDatasetDeduper(options = {}) {
  const semanticComparator = typeof options.semanticComparator === "function"
    ? options.semanticComparator
    : null;

  function dedupeRows(input = {}) {
    const rows = Array.isArray(input.rows) ? input.rows.map((entry) => canonicalize(entry)) : [];
    const dedupeConfig = asPlainObject(input.dedupe || input.dedupe_config || {});
    const semanticThreshold = Math.max(0, Math.min(1, asNumber(dedupeConfig.semantic_threshold, 0)));
    const groups = new Map();
    const collisions = [];

    for (const rowEntry of rows) {
      const rowHash = safeString(rowEntry.row_hash || (rowEntry.row && rowEntry.row.row_hash));
      const normalizedRow = canonicalize(rowEntry.row || {});
      const canonicalBody = JSON.stringify(normalizedRow);
      if (!rowHash) {
        collisions.push(canonicalize({
          code: "PHASE20_ROW_HASH_REQUIRED",
          message: "Deduplication requires row_hash on every row"
        }));
        continue;
      }
      const existing = groups.get(rowHash);
      if (!existing) {
        groups.set(rowHash, {
          canonical_body: canonicalBody,
          row_hash: rowHash,
          rows: [canonicalize({
            ...rowEntry,
            row: normalizedRow
          })]
        });
        continue;
      }
      if (existing.canonical_body !== canonicalBody) {
        collisions.push(canonicalize({
          code: "PHASE20_ROW_HASH_COLLISION",
          row_hash: rowHash,
          message: `row_hash '${rowHash}' maps to inconsistent canonical rows`
        }));
        continue;
      }
      existing.rows.push(canonicalize({
        ...rowEntry,
        row: normalizedRow
      }));
    }

    const duplicateGroups = [];
    const keptRows = [];
    const removedRows = [];
    for (const group of Array.from(groups.values()).sort((left, right) => left.row_hash.localeCompare(right.row_hash))) {
      const orderedRows = group.rows.slice().sort((left, right) => {
        return Number(left.row_number || 0) - Number(right.row_number || 0);
      });
      const kept = canonicalize({
        ...orderedRows[0],
        duplicate_row_numbers: orderedRows.map((entry) => Number(entry.row_number || 0)).filter((entry) => Number.isFinite(entry)).sort((left, right) => left - right),
        source_entries: orderedRows.map((entry) => canonicalize({
          block_index: Number(entry.block_index || 0),
          label: safeString(entry.label),
          row_number: Number(entry.row_number || 0),
          task_id: safeString(entry.task_id)
        }))
      });
      keptRows.push(kept);
      if (orderedRows.length > 1) {
        duplicateGroups.push(canonicalize({
          kept_row_number: Number(kept.row_number || 0),
          removed_row_numbers: orderedRows.slice(1).map((entry) => Number(entry.row_number || 0)).filter((entry) => Number.isFinite(entry)).sort((left, right) => left - right),
          row_hash: group.row_hash,
          source_row_numbers: orderedRows.map((entry) => Number(entry.row_number || 0)).filter((entry) => Number.isFinite(entry)).sort((left, right) => left - right)
        }));
      }
      for (const removed of orderedRows.slice(1)) {
        removedRows.push(canonicalize({
          code: "PHASE20_EXACT_DUPLICATE_REMOVED",
          removed_row_number: Number(removed.row_number || 0),
          row_hash: group.row_hash
        }));
      }
    }

    const semanticPairs = [];
    if (semanticComparator) {
      for (let index = 0; index < keptRows.length; index += 1) {
        for (let compareIndex = index + 1; compareIndex < keptRows.length; compareIndex += 1) {
          const left = keptRows[index];
          const right = keptRows[compareIndex];
          const result = semanticComparator(left.row, right.row, {
            semantic_threshold: semanticThreshold
          });
          semanticPairs.push(canonicalize({
            left_row_hash: safeString(left.row_hash),
            right_row_hash: safeString(right.row_hash),
            result: canonicalize(asPlainObject(result))
          }));
        }
      }
    }

    const report = canonicalize({
      build_summary: {
        collision_count: collisions.length,
        exact_duplicate_count: removedRows.length,
        kept_row_count: keptRows.length,
        removed_row_count: removedRows.length,
        semantic_near_duplicate_status: semanticComparator ? "evaluated" : "not_configured"
      },
      collision_report: collisions,
      duplicate_groups: duplicateGroups,
      removed_rows: removedRows,
      rows_kept: keptRows.map((entry) => canonicalize({
        row_hash: safeString(entry.row_hash),
        row_number: Number(entry.row_number || 0)
      })),
      semantic_near_duplicates: {
        evaluated_pairs: semanticPairs,
        mode: safeString(dedupeConfig.mode) || "hook_only",
        threshold: semanticThreshold
      }
    });

    return canonicalize({
      collision_report: collisions,
      duplicate_groups: duplicateGroups,
      ok: collisions.length === 0,
      removed_rows: removedRows,
      report,
      rows: keptRows,
      threshold_metadata: canonicalize({
        semantic_hook_status: semanticComparator ? "configured" : "not_configured",
        semantic_threshold: semanticThreshold
      })
    });
  }

  function getConfigSnapshotHash(input = {}) {
    return sha256(JSON.stringify(canonicalize(asPlainObject(input))));
  }

  return Object.freeze({
    dedupeRows,
    getConfigSnapshotHash
  });
}

module.exports = {
  createDatasetDeduper
};
