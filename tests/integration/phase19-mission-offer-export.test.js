"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createRepoFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-mission-offer-"));
  for (const rel of ["config/monetization-map.json", "config/platform-targets.json"]) {
    const source = path.join(root, rel);
    const target = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
  }
  return tmp;
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

function runNode(scriptRelPath, args, cwd) {
  return spawnSync("node", [path.join(root, scriptRelPath), ...args], {
    cwd,
    encoding: "utf8"
  });
}

test("phase19 mission release flow generates, approves, and exports a bundle", async () => {
  const fixtureRoot = await createRepoFixture();
  const missionId = "mission-offer-export-demo";
  const outputPath = writeTaskOutput(fixtureRoot, "task-offer-export-1", "sample-research-output.md");
  const missionRoot = path.join(fixtureRoot, "workspace", "missions", missionId);
  fs.mkdirSync(path.join(missionRoot, "artifacts"), { recursive: true });
  writeJson(path.join(missionRoot, "mission.json"), {
    mission_id: missionId,
    description: "Mission offer export demo"
  });
  writeJson(path.join(missionRoot, "status.json"), {
    mission_id: missionId,
    status: "completed"
  });
  writeJson(path.join(missionRoot, "artifacts", "mission-summary.json"), {
    mission_id: missionId,
    subtask_results: [
      { subtask_id: "step-1", output_path: outputPath, status: "completed" }
    ]
  });

  const generated = runNode("scripts/generate-offer.js", [
    "--source", missionId,
    "--product-line", "research_packs",
    "--tier", "standard",
    "--targets", "gumroad",
    "--confirm"
  ], fixtureRoot);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const generatedBody = JSON.parse(generated.stdout);
  assert.equal(generatedBody.ok, true);
  assert.ok(fs.existsSync(generatedBody.bundle_dir));

  const approved = runNode("scripts/approve-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--operator-id", "operator-test",
    "--confirm"
  ], fixtureRoot);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  assert.ok(fs.existsSync(path.join(generatedBody.bundle_dir, "release-approval.json")));

  const exported = runNode("scripts/export-release.js", [
    "--offer-id", generatedBody.offer_id,
    "--format", "folder",
    "--confirm"
  ], fixtureRoot);
  assert.equal(exported.status, 0, exported.stderr || exported.stdout);
  const exportBody = JSON.parse(exported.stdout);
  assert.equal(exportBody.format, "folder");
  assert.ok(fs.existsSync(exportBody.export_path));
});

