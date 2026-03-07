"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const { createDatasetOutputManager } = require(path.join(root, "openclaw-bridge", "dataset", "dataset-output-manager.js"));
const { createDatasetBuildInput } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

async function createRepoFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-dataset-offer-"));
  for (const rel of ["config/monetization-map.json", "config/platform-targets.json"]) {
    const source = path.join(root, rel);
    const target = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
  }
  return tmp;
}

function runNode(scriptRelPath, args, cwd) {
  return spawnSync("node", [path.join(root, scriptRelPath), ...args], {
    cwd,
    encoding: "utf8"
  });
}

test("phase19 dataset release flow generates, approves, and exports a deterministic bundle", async () => {
  const fixtureRoot = await createRepoFixture();
  const outputManager = createDatasetOutputManager({ rootDir: fixtureRoot });
  outputManager.saveBuild(createDatasetBuildInput({
    dataset_id: "dataset-offer-export-demo",
    build_id: "build-0001",
    rows: [
      {
        instruction: "Explain the market shift",
        context: "A sample context",
        answer: "A sample answer with enough length.",
        row_hash: "fixed-row-hash"
      }
    ],
    source_task_ids: ["task-1"],
    build_started_at: "2026-03-06T00:00:00.000Z",
    build_completed_at: "2026-03-06T00:00:00.000Z"
  }));

  const generated = runNode("scripts/generate-offer.js", [
    "--source", "dataset-offer-export-demo",
    "--product-line", "dataset_packs",
    "--tier", "standard",
    "--targets", "kaggle",
    "--confirm"
  ], fixtureRoot);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const generatedBody = JSON.parse(generated.stdout);
  assert.equal(generatedBody.ok, true);
  assert.equal(generatedBody.source_status.commercialization_ready, true);
  assert.equal(generatedBody.source_status.license_state, "allowed");

  const approved = runNode("scripts/approve-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--confirm"
  ], fixtureRoot);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--format", "zip",
    "--confirm"
  ], fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);
  const exportBody = JSON.parse(exported.stdout);
  assert.equal(exportBody.format, "zip");
  assert.ok(fs.existsSync(exportBody.export_path));
  assert.equal(exportBody.dataset_phase20_status.commercialization_ready, true);
  assert.equal(exportBody.dataset_phase20_status.license_state, "allowed");
});
