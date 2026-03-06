"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase18-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  ".gitignore",
  "config/agent-spawner.json",
  "config/mission-templates.json",
  "security/skill-registry.lock.json",
  "openclaw-bridge/core/mission-envelope-schema.js",
  "openclaw-bridge/core/agent-engine.js",
  "openclaw-bridge/core/agent-spawner.js",
  "openclaw-bridge/core/spawn-planner.js",
  "openclaw-bridge/core/spawn-orchestrator.js",
  "openclaw-bridge/core/skill-provider.js",
  "openclaw-bridge/core/skill-providers/openclaw-skill-provider.js",
  "openclaw-bridge/core/skill-providers/openai-skill-provider.js",
  "scripts/_research-runtime.js",
  "scripts/run-research-task.js",
  "scripts/verify-phase18-policy.sh",
  "tests/core/phase18-agent-spawner.test.js",
  "tests/core/phase18-skill-provider.test.js",
  "tests/core/phase18-runtime-compat.test.js",
  "tests/security/phase18-policy-gate.test.js",
  "docs/phase18-agent-spawner.md",
  "audit/evidence/mission-orchestration/mission-sample.json",
  "audit/evidence/mission-orchestration/hash-manifest.json",
  "workspace/missions/.gitkeep"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase18-policy-"));
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

test("phase18 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 18 policy verification passed/);
});

test("phase18 policy gate fails when phase18 modules gain direct network execution", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "core", "spawn-orchestrator.js");
  fs.appendFileSync(file, "\nconst _bad = fetch('http://127.0.0.1');\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must remain free of direct network/);
});

test("phase18 policy gate blocks enablement before Stage A live evidence is green", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "config", "agent-spawner.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  current.enabled = true;
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE18_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /cannot be enabled before a live MCP service-path success is recorded|cannot be enabled before live evidence summaries exist/);
});
