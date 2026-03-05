"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-phase13-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  ".gitignore",
  "openclaw-bridge/mcp/mcp-service.js",
  "workflows/access-control/access-control-schema.js",
  "workflows/access-control/access-control-common.js",
  "workflows/access-control/role-permission-registry.js",
  "workflows/access-control/scope-registry.js",
  "workflows/access-control/token-lifecycle-manager.js",
  "workflows/access-control/access-decision-ledger.js",
  "workflows/access-control/permission-boundary-enforcer.js",
  "workflows/access-control/privilege-escalation-detector.js",
  "workflows/access-control/session-governance-manager.js",
  "workflows/access-control/legacy-access-bridge.js",
  "security/phase13-startup-integrity.js",
  "security/rbac-policy.json",
  "security/scope-registry.json",
  "security/token-store.sample.json",
  "scripts/_phase13-access-utils.js",
  "scripts/issue-token.js",
  "scripts/rotate-token.js",
  "scripts/revoke-token.js",
  "scripts/validate-token.js",
  "scripts/list-active-tokens.js",
  "scripts/create-session.js",
  "scripts/validate-session.js",
  "scripts/check-access.js",
  "scripts/detect-escalation.js",
  "scripts/generate-phase13-artifacts.js",
  "scripts/verify-phase13-policy.sh",
  "tests/security/phase13-access-control-schema.test.js",
  "tests/security/phase13-role-permission-registry.test.js",
  "tests/security/phase13-scope-registry.test.js",
  "tests/security/phase13-token-lifecycle-manager.test.js",
  "tests/security/phase13-permission-boundary-enforcer.test.js",
  "tests/security/phase13-privilege-escalation-detector.test.js",
  "tests/security/phase13-access-decision-ledger.test.js",
  "tests/security/phase13-session-governance-manager.test.js",
  "tests/security/phase13-policy-gate.test.js",
  "tests/security/phase13-startup-integrity.test.js"
];

async function createFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase13-policy-"));
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

test("phase13 policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Phase 13 policy verification passed/);
});

test("phase13 policy gate fails on explicit network marker", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "access-control", "permission-boundary-enforcer.js");
  fs.appendFileSync(file, "\nconst _badNetwork = fetch(\"http://127.0.0.1\");\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must not include network clients or sockets/);
});

test("phase13 policy gate fails on restricted globals in phase13 modules", async () => {
  const fixture = await createFixture();
  const file = path.join(fixture, "workflows", "access-control", "access-control-common.js");
  fs.appendFileSync(file, "\nconst _badGlobal = Date.now();\n", "utf8");

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Determinism violation/);
});

test("phase13 policy gate deterministic fallback works without rg", async () => {
  const fixture = await createFixture();
  const passRun = runPolicy(fixture, { PHASE13_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const file = path.join(fixture, "workflows", "access-control", "access-decision-ledger.js");
  fs.appendFileSync(file, "\nconst _bad = Math.random();\n", "utf8");
  const failRun = runPolicy(fixture, { PHASE13_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /Determinism violation/);
});

test("phase13 policy gate fails when runtime persistence files are not gitignored", async () => {
  const fixture = await createFixture();
  const gitignorePath = path.join(fixture, ".gitignore");
  const current = fs.readFileSync(gitignorePath, "utf8");
  fs.writeFileSync(
    gitignorePath,
    current.replace(/^security\/token-store\.json\n?/m, ""),
    "utf8"
  );

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Runtime file must be gitignored: security\/token-store\.json/);
});
