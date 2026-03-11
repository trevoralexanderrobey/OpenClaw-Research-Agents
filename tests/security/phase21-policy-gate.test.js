"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase21-policy.sh");
const { copyRepoFiles } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

const REQUIRED_FIXTURE_FILES = [
  ".github/workflows/ci-enforcement.yml",
  "README.md",
  "docs/attack-surface.md",
  "docs/supervisor-architecture.md",
  "config/platform-targets.json",
  "openclaw-bridge/monetization/publisher-adapter-contract.js",
  "openclaw-bridge/monetization/publisher-adapter-registry.js",
  "openclaw-bridge/monetization/publisher-adapter-manifest-validator.js",
  "openclaw-bridge/monetization/publisher-adapter-snapshot-validator.js",
  "openclaw-bridge/monetization/phase21-release-approval-validator.js",
  "openclaw-bridge/monetization/submission-pack-generator.js",
  "openclaw-bridge/monetization/deliverable-packager.js",
  "openclaw-bridge/monetization/release-approval-manager.js",
  "openclaw-bridge/monetization/adapters/manual-placeholder-adapter.js",
  "openclaw-bridge/monetization/adapters/aws_data_exchange-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/datarade-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/github_sponsors-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/google_cloud_marketplace_bigquery-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/gumroad-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/hugging_face-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/kaggle-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/lemon_squeezy-manual-adapter.js",
  "openclaw-bridge/monetization/adapters/snowflake_marketplace-manual-adapter.js",
  "scripts/_monetization-runtime.js",
  "scripts/generate-offer.js",
  "scripts/approve-release.js",
  "scripts/export-release.js",
  "scripts/build-verify.sh",
  "scripts/verify-phase21-policy.sh",
  "package.json"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase21-policy-"));
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

test("phase21 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 21 publisher adapter policy verification passed/);
});

test("phase21 policy gate fails when phase21 script wiring is removed from package.json", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(file, "utf8"));
  delete packageJson.scripts["phase21:verify"];
  fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE21_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /phase21:verify/);
});

test("phase21 policy gate fails when unsafe network logic is introduced into adapter paths", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "monetization", "adapters", "manual-placeholder-adapter.js");
  fs.appendFileSync(file, "\nfetch('https://example.com/should-not-exist');\n", "utf8");

  const run = runPolicy(fixture, { PHASE21_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /network\/browser\/login automation logic/);
});
