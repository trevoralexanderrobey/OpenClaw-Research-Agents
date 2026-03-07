"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createDatasetDeduper } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-deduper.js"));

test("phase20 dataset deduper removes exact duplicates and preserves aggregated lineage inputs", () => {
  const deduper = createDatasetDeduper();
  const canonicalRow = {
    instruction: "Explain the buyer signal.",
    context: "Enterprise buyers prioritize integration depth and auditability.",
    answer: "Enterprise buyers prioritize integration depth and auditability.",
    row_hash: "row-hash-1"
  };

  const result = deduper.dedupeRows({
    dedupe: {
      mode: "hook_only",
      semantic_threshold: 0.98
    },
    rows: [
      {
        block_index: 1,
        label: "Buyer signals",
        row: canonicalRow,
        row_hash: "row-hash-1",
        row_number: 1,
        task_id: "task-1"
      },
      {
        block_index: 2,
        label: "Buyer signals duplicate",
        row: canonicalRow,
        row_hash: "row-hash-1",
        row_number: 2,
        task_id: "task-2"
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.removed_rows.length, 1);
  assert.deepEqual(result.rows[0].duplicate_row_numbers, [1, 2]);
  assert.deepEqual(result.rows[0].source_entries.map((entry) => entry.task_id), ["task-1", "task-2"]);
});

test("phase20 dataset deduper fails closed on row-hash collisions with non-identical canonical rows", () => {
  const deduper = createDatasetDeduper();

  const result = deduper.dedupeRows({
    rows: [
      {
        row: {
          instruction: "Explain the buyer signal.",
          context: "Context A",
          answer: "Answer A",
          row_hash: "row-hash-1"
        },
        row_hash: "row-hash-1",
        row_number: 1,
        task_id: "task-1"
      },
      {
        row: {
          instruction: "Explain the buyer signal differently.",
          context: "Context B",
          answer: "Answer B",
          row_hash: "row-hash-1"
        },
        row_hash: "row-hash-1",
        row_number: 2,
        task_id: "task-2"
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.collision_report.length, 1);
  assert.equal(result.collision_report[0].code, "PHASE20_ROW_HASH_COLLISION");
});

test("phase20 dataset deduper exposes a deterministic semantic dedupe hook without forcing decisions", () => {
  const deduper = createDatasetDeduper({
    semanticComparator(left, right, context) {
      return {
        decision: "observe_only",
        semantic_threshold: context.semantic_threshold,
        similarity_basis: `${left.instruction}|${right.instruction}`
      };
    }
  });

  const result = deduper.dedupeRows({
    dedupe: {
      mode: "hook_only",
      semantic_threshold: 0.95
    },
    rows: [
      {
        row: {
          instruction: "Explain the buyer signal.",
          context: "Context A",
          answer: "Answer A",
          row_hash: "row-hash-1"
        },
        row_hash: "row-hash-1",
        row_number: 1,
        task_id: "task-1"
      },
      {
        row: {
          instruction: "Explain the market signal.",
          context: "Context B",
          answer: "Answer B",
          row_hash: "row-hash-2"
        },
        row_hash: "row-hash-2",
        row_number: 2,
        task_id: "task-2"
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.report.semantic_near_duplicates.mode, "hook_only");
  assert.equal(result.threshold_metadata.semantic_hook_status, "configured");
  assert.equal(result.report.semantic_near_duplicates.evaluated_pairs.length, 1);
});
