"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSchemaEngine } = require(path.join(root, "openclaw-bridge", "dataset", "schema-engine.js"));
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));
const { createDatasetBuilder } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-builder.js"));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeTask(rootDir, taskId) {
  const taskDir = path.join(rootDir, "workspace", "research-output", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "output.md"),
    fs.readFileSync(path.join(root, "tests", "fixtures", "phase19", "sample-research-output.md"), "utf8"),
    "utf8"
  );
  writeJson(path.join(taskDir, "metadata.json"), { task_id: taskId, status: "completed" });
  writeJson(path.join(taskDir, "manifest.json"), { task_id: taskId, files: [] });
}

test("phase19 dataset builder produces deterministic dataset_id and build_id from task outputs", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-dataset-builder-"));
  writeTask(tmp, "task-dataset-builder-1");

  const schemaEngine = createSchemaEngine({ rootDir: root });
  const outputManager = createDatasetOutputManager({ rootDir: tmp });
  const builder = createDatasetBuilder({
    rootDir: tmp,
    schemaEngine,
    outputManager,
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" }
  });

  const first = builder.buildDatasetFromSources({
    task_ids: ["task-dataset-builder-1"],
    dataset_type: "instruction_qa"
  });
  const second = builder.buildDatasetFromSources({
    task_ids: ["task-dataset-builder-1"],
    dataset_type: "instruction_qa"
  });

  assert.equal(first.dataset_id, second.dataset_id);
  assert.equal(first.build_id, second.build_id);
  const metadata = JSON.parse(fs.readFileSync(first.metadata_path, "utf8"));
  assert.equal(metadata.dataset_id, first.dataset_id);
  assert.equal(metadata.build_id, first.build_id);
});

