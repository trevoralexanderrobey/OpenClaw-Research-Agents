"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase26-policy.sh");
const { copyRepoFiles } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

const REQUIRED_FIXTURE_FILES = [
  ".github/workflows/ci-enforcement.yml",
  "README.md",
  "docs/attack-surface.md",
  "docs/supervisor-architecture.md",
  "docs/phase26-bridge-runtime-and-execution-routing.md",
  "openclaw-bridge/bridge/bridge-routing.js",
  "openclaw-bridge/bridge/bridge-auth.js",
  "openclaw-bridge/bridge/server.ts",
  "tests/security/phase26-bridge-routing.test.js",
  "tests/security/phase26-bridge-auth.test.js",
  "tests/security/phase26-policy-gate.test.js",
  "scripts/verify-phase26-policy.sh",
  "scripts/build-verify.sh",
  "package.json"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase26-policy-"));
  await copyRepoFiles(tmp, REQUIRED_FIXTURE_FILES);
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

test("phase26 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 26A bridge policy verification passed/);
});

test("phase26 policy gate fails when phase26 script wiring is removed from package.json", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(file, "utf8"));
  delete packageJson.scripts["phase26:verify"];
  fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE26_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /phase26:verify/);
});

test("phase26 policy gate fails when integration lane is removed from bridge auth", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "bridge", "bridge-auth.js");
  const current = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, current.replace(/integration_hatchify/g, "integration_removed"), "utf8");

  const run = runPolicy(fixture, { PHASE26_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /integration_hatchify lane separation/);
});
