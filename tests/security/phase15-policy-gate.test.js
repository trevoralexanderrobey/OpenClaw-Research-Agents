"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase15-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "config/agent-topology.json",
  "config/autonomy-ladder.json",
  "openclaw-bridge/core/agent-registry.js",
  "openclaw-bridge/core/role-router.js",
  "openclaw-bridge/core/lane-queue.js",
  "openclaw-bridge/core/comms-bus.js",
  "openclaw-bridge/core/autonomy-ladder.js",
  "openclaw-bridge/core/heartbeat-state.js",
  "scripts/verify-phase15-policy.sh",
  "tests/security/phase15-policy-gate.test.js"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase15-policy-"));
  for (const rel of REQUIRED_FIXTURE_FILES) {
    const src = path.join(root, rel);
    const dst = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }

  for (const dirRel of ["workspace/comms/inbox", "workspace/comms/outbox", "workspace/comms/blackboard", "workspace/comms/events"]) {
    await fsp.mkdir(path.join(tmp, dirRel), { recursive: true });
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

test("phase15 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 15 policy verification passed/);
});

test("phase15 policy gate fails when supervisor mediation marker is removed", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "core", "role-router.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/SUPERVISOR_APPROVAL_REQUIRED/g, "SUPERVISOR_APPROVAL_MARKER_REMOVED"), "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /role-router missing fail-closed supervisor denial marker/);
});

test("phase15 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE15_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "openclaw-bridge", "core", "comms-bus.js");
  fs.appendFileSync(file, "\nconst _bad = fetch('http://127.0.0.1');\n", "utf8");
  const failRun = runPolicy(fixture, { PHASE15_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /must remain network-free/);
});
