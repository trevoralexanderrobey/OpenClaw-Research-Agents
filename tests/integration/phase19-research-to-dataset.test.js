"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createSchemaEngine } = require(path.join(root, "openclaw-bridge", "dataset", "schema-engine.js"));
const { createDatasetBuilder } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-builder.js"));
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeTaskOutput(rootDir, taskId, fixtureName) {
  const taskDir = path.join(rootDir, "workspace", "research-output", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "output.md"),
    fs.readFileSync(path.join(root, "tests", "fixtures", "phase19", fixtureName), "utf8"),
    "utf8"
  );
  writeJson(path.join(taskDir, "metadata.json"), { task_id: taskId, status: "completed" });
  writeJson(path.join(taskDir, "manifest.json"), { task_id: taskId, files: [] });
  return path.join(taskDir, "output.md");
}

test("phase19 research mission outputs can be transformed into a staged dataset build", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-research-to-dataset-"));
  const missionId = "mission-research-to-dataset-demo";
  const firstOutput = writeTaskOutput(tmp, "task-research-to-dataset-1", "sample-research-output.md");
  const secondOutput = writeTaskOutput(tmp, "task-research-to-dataset-2", "sample-research-output-2.md");

  const missionRoot = path.join(tmp, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "status.json"), {
    mission_id: missionId,
    status: "completed",
    dataset_id: "dataset-research-to-dataset-demo"
  });
  writeJson(path.join(missionRoot, "artifacts", "mission-summary.json"), {
    mission_id: missionId,
    subtask_results: [
      { subtask_id: "step-1", output_path: firstOutput, status: "completed" },
      { subtask_id: "step-2", output_path: secondOutput, status: "completed" }
    ]
  });

  const outputManager = createDatasetOutputManager({ rootDir: tmp });
  const builder = createDatasetBuilder({
    rootDir: tmp,
    schemaEngine: createSchemaEngine({ rootDir: root }),
    outputManager,
    timeProvider: { nowIso: () => "2026-03-06T00:00:00.000Z" }
  });

  const result = builder.buildDatasetFromSources({
    mission_id: missionId,
    dataset_type: "retrieval_qa"
  });

  assert.equal(result.ok, true);
  assert.equal(result.dataset_id, "dataset-research-to-dataset-demo");
  assert.ok(result.row_count > 0);
  assert.ok(fs.existsSync(result.dataset_path));

  const latest = outputManager.resolveLatestSuccessfulBuild(result.dataset_id);
  assert.equal(latest.build_id, result.build_id);
});

