"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase27-policy.sh");
const { copyRepoFiles } = require(path.join(root, "tests", "helpers", "phase20-fixtures.js"));

const REQUIRED_FIXTURE_FILES = [
  ".github/workflows/ci-enforcement.yml",
  "README.md",
  "docs/attack-surface.md",
  "docs/supervisor-architecture.md",
  "docs/phase27-sider-hatchify-integration.md",
  "openclaw-bridge/bridge/sider-handoff-manager.js",
  "scripts/export-sider-brief.js",
  "scripts/import-sider-response.js",
  "security/rbac-policy.json",
  "security/scope-registry.json",
  "scripts/verify-phase27-policy.sh",
  "tests/core/phase27-sider-handoff-manager.test.js",
  "tests/security/phase27-policy-gate.test.js",
  "scripts/build-verify.sh",
  "package.json"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase27-policy-"));
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

test("phase27 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 27 Sider\/Hatchify policy verification passed/);
});

test("phase27 policy gate fails when phase27 script wiring is removed from package.json", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(file, "utf8"));
  delete packageJson.scripts["phase27:verify"];
  fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE27_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /phase27:verify/);
});

test("phase27 policy gate fails when integration role is removed", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "security", "rbac-policy.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  current.roles = current.roles.filter((entry) => entry.role_id !== "integration_hatchify");
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");

  const run = runPolicy(fixture, { PHASE27_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /integration_hatchify role/);
});
