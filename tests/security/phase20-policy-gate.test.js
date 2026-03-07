"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase20-policy.sh");
const { copyRepoFiles } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

const REQUIRED_FIXTURE_FILES = [
  "config/dataset-schemas.json",
  "config/dataset-quality-rules.json",
  "config/dataset-license-rules.json",
  "README.md",
  "docs/attack-surface.md",
  "docs/supervisor-architecture.md",
  "openclaw-bridge/dataset/dataset-builder.js",
  "openclaw-bridge/dataset/dataset-output-manager.js",
  "openclaw-bridge/dataset/dataset-validator.js",
  "openclaw-bridge/dataset/dataset-deduper.js",
  "openclaw-bridge/dataset/dataset-scorer.js",
  "openclaw-bridge/dataset/license-review.js",
  "openclaw-bridge/dataset/provenance-tracker.js",
  "openclaw-bridge/monetization/offer-builder.js",
  "openclaw-bridge/monetization/deliverable-packager.js",
  "openclaw-bridge/monetization/release-approval-manager.js",
  "scripts/build-verify.sh",
  "scripts/generate-offer.js",
  "scripts/approve-release.js",
  "scripts/export-release.js",
  "scripts/verify-phase20-policy.sh",
  "package.json"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase20-policy-"));
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

test("phase20 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 20 dataset commercialization policy verification passed/);
});

test("phase20 policy gate fails when unknown license state is no longer fail-closed", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "config", "dataset-license-rules.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.default_unknown_state = "allowed";
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE20_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /default_unknown_state=blocked|default_unknown_state/);
});

test("phase20 policy gate fails when unsafe network logic is introduced into dataset commercialization modules", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "openclaw-bridge", "dataset", "license-review.js");
  fs.appendFileSync(file, "\nfetch('https://example.com/should-not-exist');\n", "utf8");

  const run = runPolicy(fixture, { PHASE20_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /direct network or browser automation paths/);
});
