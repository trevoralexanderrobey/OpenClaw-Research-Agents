"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase14-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  ".gitignore",
  "openclaw-bridge/mcp/mcp-service.js",
  "config/agent-config.json",
  "config/llm-providers.json",
  "openclaw-bridge/core/agent-engine.js",
  "openclaw-bridge/core/governance-bridge.js",
  "openclaw-bridge/core/supervisor-authority.js",
  "openclaw-bridge/core/llm-adapter.js",
  "openclaw-bridge/core/interaction-log.js",
  "openclaw-bridge/core/task-definition-schema.js",
  "openclaw-bridge/core/research-output-manager.js",
  "security/phase14-startup-integrity.js",
  "scripts/run-research-task.js",
  "scripts/verify-phase14-policy.sh",
  "tests/security/phase14-policy-gate.test.js",
  "tests/security/phase14-startup-integrity.test.js"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase14-policy-"));
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

test("phase14 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 14 policy verification passed/);
});

test("phase14 policy gate fails when supervisor mediation marker is missing", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "core", "agent-engine.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/context\.supervisorDecision/g, "context.supervisorReceiptRemoved"), "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /agent-engine missing supervisor decision requirement marker/);
});

test("phase14 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE14_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "openclaw-bridge", "core", "task-definition-schema.js");
  fs.appendFileSync(file, "\nconst _bad = fetch('http://127.0.0.1');\n", "utf8");
  const failRun = runPolicy(fixture, { PHASE14_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /network isolation violation/);
});
