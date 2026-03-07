"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptPath = path.join(root, "scripts", "verify-cline-supervisor-policy.sh");

const REQUIRED_FIXTURE_FILES = [
  "README.md",
  "docs/attack-surface.md",
  "docs/failure-modes.md",
  "docs/supervisor-architecture.md",
  "security/mutation-control.js",
  "security/operator-authorization.js",
  "openclaw-bridge/src/core/execution-router.ts",
  "openclaw-bridge/mcp/mcp-service.js",
  "scripts/build-verify.sh",
  "package.json"
];

const OPTIONAL_FIXTURE_FILES = [
  ".vscode/extensions.json",
  ".vscode/settings.json",
  ".clinerules",
  "security/cline-extension-allowlist.json"
];

async function createFixture({ withOptional = false } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-cline-policy-"));
  const files = withOptional
    ? [...REQUIRED_FIXTURE_FILES, ...OPTIONAL_FIXTURE_FILES]
    : REQUIRED_FIXTURE_FILES;
  for (const rel of files) {
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

test("cline policy gate passes for valid repository layout", async () => {
  const fixture = await createFixture();
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Cline supervisor policy verification passed/);
});

test("cline policy gate passes when optional Cline workspace artifacts are present", async () => {
  const fixture = await createFixture({ withOptional: true });
  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test("cline policy gate fails when allowlisted recommendation is removed", async () => {
  const fixture = await createFixture({ withOptional: true });
  const extensionsPath = path.join(fixture, ".vscode", "extensions.json");
  fs.writeFileSync(extensionsPath, JSON.stringify({ recommendations: ["ms-python.python"] }, null, 2));

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must recommend at least one allowlisted Cline extension ID/);
});

test("cline policy gate fails when unknown Cline ID is recommended", async () => {
  const fixture = await createFixture({ withOptional: true });
  const extensionsPath = path.join(fixture, ".vscode", "extensions.json");
  fs.writeFileSync(
    extensionsPath,
    JSON.stringify({ recommendations: ["saoudrizwan.claude-dev", "cline.cline"] }, null, 2)
  );

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Cline-related extension recommendation is not allowlisted/);
});

test("cline policy gate fails when required contract clause is missing", async () => {
  const fixture = await createFixture();
  const docPath = path.join(fixture, "docs", "supervisor-architecture.md");
  const current = fs.readFileSync(docPath, "utf8");
  const updated = current.replace("Cline (Plan/Act) is a recommended outer operator workflow for this repository.", "");
  fs.writeFileSync(docPath, updated);

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing outer Cline workflow declaration/);
});

test("cline policy gate allows missing optional .clinerules file", async () => {
  const fixture = await createFixture({ withOptional: true });
  await fsp.unlink(path.join(fixture, ".clinerules"));

  const run = runPolicy(fixture);
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test("cline policy gate is deterministic when rg is unavailable", async () => {
  const fixture = await createFixture();

  const passRun = runPolicy(fixture, { CLINE_POLICY_FORCE_NO_RG: "1" });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);

  const optionalFixture = await createFixture({ withOptional: true });
  const extensionsPath = path.join(optionalFixture, ".vscode", "extensions.json");
  fs.writeFileSync(
    extensionsPath,
    JSON.stringify({ recommendations: ["saoudrizwan.claude-dev", "cline.cline"] }, null, 2)
  );

  const failRun = runPolicy(optionalFixture, { CLINE_POLICY_FORCE_NO_RG: "1" });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /not allowlisted/);
});

test("cline policy gate fails if settings file exists without extensions recommendations", async () => {
  const fixture = await createFixture({ withOptional: true });
  await fsp.unlink(path.join(fixture, ".vscode", "extensions.json"));

  const run = runPolicy(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /settings\.json exists without \.vscode\/extensions\.json/);
});
