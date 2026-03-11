"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase22-policy.sh");
const { copyRepoFiles } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

const REQUIRED_FIXTURE_FILES = [
  ".github/workflows/ci-enforcement.yml",
  "README.md",
  "docs/attack-surface.md",
  "docs/supervisor-architecture.md",
  "openclaw-bridge/monetization/submission-evidence-schema.js",
  "openclaw-bridge/monetization/manual-fulfillment-state-machine.js",
  "openclaw-bridge/monetization/submission-evidence-ledger.js",
  "openclaw-bridge/monetization/submission-evidence-manager.js",
  "scripts/_monetization-runtime.js",
  "scripts/export-release.js",
  "scripts/record-submission-outcome.js",
  "scripts/verify-submission-evidence.js",
  "scripts/build-verify.sh",
  "scripts/verify-phase22-policy.sh",
  "package.json"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase22-policy-"));
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

test("phase22 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 22 submission evidence policy verification passed/);
});

test("phase22 policy gate fails when phase22 script wiring is removed from package.json", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(file, "utf8"));
  delete packageJson.scripts["phase22:verify"];
  fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE22_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /phase22:verify/);
});

test("phase22 policy gate fails when unsafe network logic is introduced into phase22 evidence paths", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "monetization", "submission-evidence-manager.js");
  fs.appendFileSync(file, "\nfetch('https://example.com/should-not-exist');\n", "utf8");

  const run = runPolicy(fixture, { PHASE22_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /network\/browser\/login automation logic/);
});
