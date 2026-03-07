"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createProvenanceTracker } = require(path.join(root, "openclaw-bridge", "dataset", "provenance-tracker.js"));

test("phase20 provenance tracker emits deterministic row and build lineage records", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase20-provenance-"));
  const firstOutput = path.join(tmp, "workspace", "research-output", "task-1", "output.md");
  const secondOutput = path.join(tmp, "workspace", "research-output", "task-2", "output.md");
  fs.mkdirSync(path.dirname(firstOutput), { recursive: true });
  fs.mkdirSync(path.dirname(secondOutput), { recursive: true });
  fs.writeFileSync(firstOutput, "Task one output\n", "utf8");
  fs.writeFileSync(secondOutput, "Task two output\n", "utf8");

  const tracker = createProvenanceTracker({ rootDir: tmp });
  const result = tracker.trackBuild({
    dedupe_result: {
      rows: [
        {
          duplicate_row_numbers: [1, 2],
          row_hash: "row-hash-1",
          row_number: 1,
          source_entries: [
            {
              block_index: 1,
              label: "Buyer signals",
              row_number: 1,
              task_id: "task-1"
            },
            {
              block_index: 2,
              label: "Buyer signals duplicate",
              row_number: 2,
              task_id: "task-2"
            }
          ]
        }
      ]
    },
    source_artifacts: [
      {
        metadata: {
          source_domain: "approved.example"
        },
        output_path: firstOutput,
        task_id: "task-1"
      },
      {
        metadata: {
          source_domain: "approved.example"
        },
        output_path: secondOutput,
        task_id: "task-2"
      }
    ],
    source_mission_ids: ["mission-phase20-demo"],
    transformation_steps: ["resolve_sources", "dedupe_rows", "attach_provenance"]
  });

  assert.equal(result.ok, true);
  assert.equal(result.row_records.length, 1);
  assert.deepEqual(result.row_records[0].source_task_ids, ["task-1", "task-2"]);
  assert.deepEqual(result.row_records[0].duplicate_row_numbers, [1, 2]);
  assert.deepEqual(result.row_records[0].source_artifacts.map((entry) => entry.output_path), [
    "workspace/research-output/task-1/output.md",
    "workspace/research-output/task-2/output.md"
  ]);
  assert.equal(result.provenance.build_summary.provenance_hash.length, 64);
});

test("phase20 provenance tracker rejects rows without deterministic lineage", () => {
  const tracker = createProvenanceTracker({ rootDir: root });
  const result = tracker.trackBuild({
    dedupe_result: {
      rows: [
        {
          row_hash: "row-hash-1",
          row_number: 1
        }
      ]
    },
    source_artifacts: [],
    source_mission_ids: [],
    transformation_steps: ["attach_provenance"]
  });

  assert.equal(result.ok, false);
  assert.equal(result.invalid_rows.length, 1);
  assert.match(JSON.stringify(result.invalid_rows[0].reason_codes), /PHASE20_PROVENANCE_TASK_REQUIRED/);
  assert.match(JSON.stringify(result.invalid_rows[0].reason_codes), /PHASE20_PROVENANCE_ARTIFACT_REQUIRED/);
  assert.match(JSON.stringify(result.invalid_rows[0].reason_codes), /PHASE20_PROVENANCE_SEGMENT_REQUIRED/);
});
