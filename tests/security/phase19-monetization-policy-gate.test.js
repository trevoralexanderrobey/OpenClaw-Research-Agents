"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-monetization-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "config/monetization-map.json",
  "config/platform-targets.json",
  "openclaw-bridge/monetization/offer-schema.js",
  "openclaw-bridge/monetization/offer-builder.js",
  "openclaw-bridge/monetization/deliverable-packager.js",
  "openclaw-bridge/monetization/submission-pack-generator.js",
  "openclaw-bridge/monetization/release-approval-manager.js",
  "scripts/_monetization-runtime.js",
  "scripts/generate-offer.js",
  "scripts/approve-release.js",
  "scripts/export-release.js",
  "scripts/verify-monetization-policy.sh",
  "README.md",
  "docs/attack-surface.md"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase19-monetization-policy-"));
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

test("phase19 monetization policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 19 monetization policy verification passed/);
});

test("phase19 monetization policy gate fails when a platform target is no longer manual-only", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "config", "platform-targets.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.platform_targets.kaggle.manual_only = false;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE19_MONETIZATION_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /manual_only/);
});

