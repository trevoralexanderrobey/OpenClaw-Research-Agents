"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase16-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "openclaw-bridge/core/llm-adapter.js",
  "integrations/mcp/mcp-client.js",
  "integrations/mcp/arxiv-client.js",
  "integrations/mcp/semantic-scholar-client.js",
  "workflows/research-ingestion/ingestion-pipeline.js",
  "workflows/research-ingestion/normalizer.js",
  "workflows/research-ingestion/citation-metrics.js",
  "workflows/research-ingestion/source-ledger.js",
  "scripts/verify-phase16-policy.sh",
  "tests/security/phase16-policy-gate.test.js"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase16-policy-"));
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

test("phase16 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 16 policy verification passed/);
});

test("phase16 policy gate fails when network call appears outside whitelist", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "research-ingestion", "normalizer.js");
  fs.appendFileSync(file, "\nconst _bad = fetch('http://127.0.0.1');\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /network isolation violation/);
});

test("phase16 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE16_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "integrations", "mcp", "mcp-client.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/fetch\(/g, "fetchRemoved("), "utf8");
  const secondPass = runPolicy(fixture, { PHASE16_POLICY_FORCE_NO_RG: "1" });
  assert.equal(secondPass.status, 0, secondPass.stderr || secondPass.stdout);
});
