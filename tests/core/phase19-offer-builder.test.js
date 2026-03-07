"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const { createOfferBuilder } = require(path.join(root, "openclaw-bridge", "monetization", "offer-builder.js"));
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeTaskOutput(rootDir, taskId, sourceFileName) {
  const taskDir = path.join(rootDir, "workspace", "research-output", taskId);
  const fixtureText = fs.readFileSync(path.join(root, "tests", "fixtures", "phase19", sourceFileName), "utf8");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "output.md"), fixtureText, "utf8");
  writeJson(path.join(taskDir, "metadata.json"), {
    task_id: taskId,
    status: "completed",
    type: "extract",
    output_format: "markdown"
  });
  writeJson(path.join(taskDir, "manifest.json"), {
    schema_version: "phase14-output-manifest-v1",
    task_id: taskId,
    files: [
      { file: "metadata.json", sha256: "meta" },
      { file: "output.md", sha256: "body" }
    ]
  });
  return path.join(taskDir, "output.md");
}

test("phase19 offer builder creates deterministic mission-backed offers", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-offer-builder-"));
  const missionId = "mission-offer-builder-demo";
  const outputPath = writeTaskOutput(tmp, "task-offer-builder-1", "sample-research-output.md");
  const missionRoot = path.join(tmp, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Research pack mission"
  });
  writeJson(path.join(missionRoot, "status.json"), {
    mission_id: missionId,
    status: "completed"
  });
  writeJson(path.join(missionRoot, "artifacts", "mission-summary.json"), {
    mission_id: missionId,
    subtask_results: [
      {
        subtask_id: "step-1",
        output_path: outputPath,
        status: "completed"
      }
    ]
  });

  const builder = createOfferBuilder({
    rootDir: tmp,
    monetizationMap: readJson("config/monetization-map.json"),
    platformTargets: readJson("config/platform-targets.json"),
    datasetOutputManager: createDatasetOutputManager({ rootDir: tmp })
  });

  const first = builder.buildOffer({
    source: missionId,
    product_line: "research_packs",
    tier: "standard",
    targets: ["gumroad"]
  });
  const second = builder.buildOffer({
    source: missionId,
    product_line: "research_packs",
    tier: "standard",
    targets: ["gumroad"]
  });

  assert.equal(first.offer.offer_id, second.offer.offer_id);
  assert.equal(first.offer.source_kind, "mission");
  assert.equal(first.source_context.source_id, missionId);
});

test("phase19 offer builder resolves dataset offers from latest successful build in the index", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-offer-builder-dataset-"));
  const outputManager = createDatasetOutputManager({ rootDir: tmp });
  outputManager.saveBuild({
    dataset_id: "dataset-offer-builder-demo",
    build_id: "build-0001",
    dataset_type: "instruction_qa",
    target_schema: "phase19-dataset-schema-v1",
    rows: [{ answer: "A", context: "B", instruction: "C", row_hash: "1" }],
    schema: { schema_version: "phase19-dataset-schema-v1" },
    build_report: { ok: true },
    source_task_ids: ["task-1"],
    build_started_at: "2026-03-06T00:00:00.000Z",
    build_completed_at: "2026-03-06T00:00:00.000Z"
  });
  outputManager.saveBuild({
    dataset_id: "dataset-offer-builder-demo",
    build_id: "build-0002",
    dataset_type: "instruction_qa",
    target_schema: "phase19-dataset-schema-v1",
    status: "failed",
    rows: [{ answer: "X", context: "Y", instruction: "Z", row_hash: "2" }],
    schema: { schema_version: "phase19-dataset-schema-v1" },
    build_report: { ok: false },
    source_task_ids: ["task-1"],
    build_started_at: "2026-03-06T01:00:00.000Z",
    build_completed_at: "2026-03-06T01:00:00.000Z"
  });

  const builder = createOfferBuilder({
    rootDir: tmp,
    monetizationMap: readJson("config/monetization-map.json"),
    platformTargets: readJson("config/platform-targets.json"),
    datasetOutputManager: outputManager
  });

  const result = builder.buildOffer({
    source: "dataset-offer-builder-demo",
    product_line: "dataset_packs",
    tier: "standard",
    targets: ["kaggle"]
  });

  assert.equal(result.offer.source_kind, "dataset");
  assert.equal(result.offer.build_id, "build-0001");
  assert.equal(result.source_context.build_id, "build-0001");
});

