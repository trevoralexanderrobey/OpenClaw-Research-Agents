"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSchemaEngine } = require(path.join(root, "openclaw-bridge", "dataset", "schema-engine.js"));
const { createDatasetScorer } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-scorer.js"));

test("phase20 dataset scorer produces deterministic row and build scores", () => {
  const scorer = createDatasetScorer({
    schemaEngine: createSchemaEngine({ rootDir: root })
  });
  const input = {
    dataset_type: "instruction_qa",
    metadata: {
      dataset_id: "dataset-scorer-demo",
      build_id: "build-0001",
      dataset_type: "instruction_qa",
      target_schema: "phase19-instruction-qa-v1"
    },
    validation_result: {
      row_results: [
        {
          completeness_ratio: 1,
          ok: true,
          row_hash: "row-hash-1",
          row_number: 1
        },
        {
          completeness_ratio: 0.6667,
          ok: true,
          row_hash: "row-hash-2",
          row_number: 2
        }
      ]
    },
    provenance_result: {
      row_records: [
        {
          ok: true,
          row_hash: "row-hash-1",
          row_number: 1,
          source_artifacts: [{ output_path: "workspace/research-output/task-1/output.md" }],
          source_task_ids: ["task-1"]
        },
        {
          ok: true,
          row_hash: "row-hash-2",
          row_number: 2,
          source_artifacts: [{ output_path: "workspace/research-output/task-2/output.md" }],
          source_task_ids: ["task-1", "task-2"]
        }
      ]
    },
    dedupe_result: {
      rows: [
        { row_hash: "row-hash-1", row_number: 1 },
        { row_hash: "row-hash-2", row_number: 2 }
      ]
    }
  };

  const first = scorer.scoreBuild(input);
  const second = scorer.scoreBuild(input);

  assert.deepEqual(first, second);
  assert.equal(first.quality_status, "passed");
  assert.equal(first.row_scores.length, 2);
  assert.ok(first.build_score >= 78);
});

test("phase20 dataset scorer honors deterministic build threshold overrides from metadata", () => {
  const scorer = createDatasetScorer({
    schemaEngine: createSchemaEngine({ rootDir: root })
  });

  const result = scorer.scoreBuild({
    dataset_type: "instruction_qa",
    metadata: {
      dataset_id: "dataset-scorer-demo",
      build_id: "build-0002",
      dataset_type: "instruction_qa",
      quality_threshold: 101,
      target_schema: "phase19-instruction-qa-v1"
    },
    validation_result: {
      row_results: [
        {
          completeness_ratio: 1,
          ok: true,
          row_hash: "row-hash-1",
          row_number: 1
        }
      ]
    },
    provenance_result: {
      row_records: [
        {
          ok: true,
          row_hash: "row-hash-1",
          row_number: 1,
          source_artifacts: [{ output_path: "workspace/research-output/task-1/output.md" }],
          source_task_ids: ["task-1"]
        }
      ]
    },
    dedupe_result: {
      rows: [
        { row_hash: "row-hash-1", row_number: 1 }
      ]
    }
  });

  assert.equal(result.quality_status, "failed");
  assert.equal(result.quality_report.build_summary.threshold, 101);
  assert.equal(result.quality_report.build_threshold_evaluation.build_passes_threshold, false);
});
