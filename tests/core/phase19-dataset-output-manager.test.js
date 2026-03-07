"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));

test("phase19 dataset output manager indexes dataset_id and build_id and resolves latest successful build", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-dataset-output-"));
  const manager = createDatasetOutputManager({ rootDir: tmp });

  manager.saveBuild({
    dataset_id: "dataset-output-demo",
    build_id: "build-0001",
    dataset_type: "instruction_qa",
    target_schema: "phase19-dataset-schema-v1",
    rows: [{ instruction: "A", context: "B", answer: "C", row_hash: "1" }],
    schema: { schema_version: "phase19-dataset-schema-v1" },
    build_report: { ok: true },
    source_task_ids: ["task-1"],
    build_started_at: "2026-03-06T00:00:00.000Z",
    build_completed_at: "2026-03-06T00:00:00.000Z"
  });
  manager.saveBuild({
    dataset_id: "dataset-output-demo",
    build_id: "build-0002",
    dataset_type: "instruction_qa",
    target_schema: "phase19-dataset-schema-v1",
    status: "failed",
    rows: [{ instruction: "D", context: "E", answer: "F", row_hash: "2" }],
    schema: { schema_version: "phase19-dataset-schema-v1" },
    build_report: { ok: false },
    source_task_ids: ["task-2"],
    build_started_at: "2026-03-06T01:00:00.000Z",
    build_completed_at: "2026-03-06T01:00:00.000Z"
  });

  const index = manager.loadIndex();
  assert.equal(index.datasets[0].dataset_id, "dataset-output-demo");
  assert.equal(index.builds[0].dataset_id, "dataset-output-demo");
  assert.equal(index.builds[0].build_id, "build-0001");
  assert.equal(index.datasets[0].latest_successful_build_id, "build-0001");

  const latestSuccessful = manager.resolveLatestSuccessfulBuild("dataset-output-demo");
  assert.equal(latestSuccessful.build_id, "build-0001");

  const manifest = manager.generateOutputManifest();
  assert.ok(fs.existsSync(manifest.path));
});
