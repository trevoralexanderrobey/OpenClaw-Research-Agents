"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { verifyPhase14StartupIntegrity } = require("../../security/phase14-startup-integrity.js");

const root = path.resolve(__dirname, "../..");

const REQUIRED_FILES = [
  "openclaw-bridge/core/agent-engine.js",
  "openclaw-bridge/core/governance-bridge.js",
  "openclaw-bridge/core/supervisor-authority.js",
  "openclaw-bridge/core/llm-adapter.js",
  "openclaw-bridge/core/interaction-log.js",
  "openclaw-bridge/core/task-definition-schema.js",
  "openclaw-bridge/core/research-output-manager.js",
  "scripts/run-research-task.js",
  "scripts/verify-phase14-policy.sh",
  "config/agent-config.json",
  "config/llm-providers.json"
];

async function makeFixtureRoot() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase14-startup-"));
  for (const rel of REQUIRED_FILES) {
    const src = path.join(root, rel);
    const dst = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }
  return tmp;
}

test("phase14 startup integrity succeeds when required modules are present", async () => {
  const result = await verifyPhase14StartupIntegrity({ rootDir: root, provider: "mock" });
  assert.equal(result.healthy, true, JSON.stringify(result.failures, null, 2));
});

test("phase14 startup integrity fails closed when required module is missing", async () => {
  const fixtureRoot = await makeFixtureRoot();
  await fsp.unlink(path.join(fixtureRoot, "openclaw-bridge", "core", "agent-engine.js"));

  const result = await verifyPhase14StartupIntegrity({ rootDir: fixtureRoot, provider: "mock" });
  assert.equal(result.healthy, false);
  assert.ok(result.failures.some((entry) => entry.file === "openclaw-bridge/core/agent-engine.js"));
});
