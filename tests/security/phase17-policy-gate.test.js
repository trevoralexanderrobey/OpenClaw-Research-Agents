"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase17-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "openclaw-bridge/execution/tool-image-catalog.js",
  "openclaw-bridge/execution/container-runtime.js",
  "openclaw-bridge/state/persistent-store.js",
  "openclaw-bridge/state/state-hydrator.js",
  "openclaw-bridge/state/open-loop-manager.js",
  "openclaw-bridge/core/restart-resume-orchestrator.js",
  "state/runtime/state.sample.json",
  "scripts/verify-phase17-policy.sh",
  "tests/security/phase17-policy-gate.test.js"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase17-policy-"));
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

test("phase17 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 17 policy verification passed/);
});

test("phase17 policy gate fails when runtime isolation marker is removed", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "execution", "container-runtime.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/assertContainerSecurityConfig/g, "runtimeSecurityMarkerRemoved"), "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /runtime isolation marker/);
});

test("phase17 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE17_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "openclaw-bridge", "execution", "container-runtime.js");
  fs.appendFileSync(file, "\nconst _unsafe = child_process.exec('docker run bad');\n", "utf8");
  const failRun = runPolicy(fixture, { PHASE17_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /unsafe container shell execution/);
});
