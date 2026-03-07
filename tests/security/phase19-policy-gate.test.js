"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase19-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "config/dataset-schemas.json",
  "config/dataset-quality-rules.json",
  "config/mission-templates.json",
  "config/autonomy-ladder.json",
  "README.md",
  "docs/attack-surface.md",
  "docs/supervisor-architecture.md",
  "openclaw-bridge/core/mission-envelope-schema.js",
  "openclaw-bridge/dataset/schema-engine.js",
  "openclaw-bridge/dataset/dataset-builder.js",
  "openclaw-bridge/dataset/dataset-output-manager.js",
  "openclaw-bridge/monetization/offer-builder.js",
  "scripts/build-dataset-from-task.js",
  "scripts/run-dataset-mission.js",
  "scripts/verify-phase19-policy.sh",
  "workspace/datasets/raw/.gitkeep",
  "workspace/datasets/staged/.gitkeep",
  "workspace/datasets/index/.gitkeep",
  "package.json"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-policy-"));
  for (const rel of REQUIRED_FIXTURE_FILES) {
    const src = path.join(root, rel);
    const dst = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }
  return tmp;
}

function runPolicy(rootDir, env = {}) {
  return spawnSync("bash", [scriptPath, "--root", rootDir], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

test("phase19 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 19 dataset policy verification passed/);
});

test("phase19 policy gate fails when latest-build logic drifts into filesystem timestamp scanning", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "dataset", "dataset-output-manager.js");
  fs.appendFileSync(file, "\nconst _badTimestampScan = fs.statSync('bad').mtimeMs;\n", "utf8");

  const run = runPolicy(fixture, { PHASE19_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /timestamp scanning/);
});
