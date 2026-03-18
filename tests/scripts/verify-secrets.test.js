"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "verify-secrets.sh");

async function createFixture() {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), "verify-secrets-"));
  await fsp.mkdir(path.join(fixture, ".ci", "npm-cache"), { recursive: true });
  await fsp.mkdir(path.join(fixture, "audit", "evidence"), { recursive: true });
  await fsp.writeFile(path.join(fixture, ".gitguardian.yaml"), [
    "version: 2",
    "exit_zero: false",
    "verbose: false",
    "instance: https://dashboard.gitguardian.com",
    "max_commits_for_hook: 50",
    "insecure: false",
    "",
    "secret:",
    "  ignored_paths:",
    "    - \".ci/npm-cache/**\"",
    "    - \"audit/evidence/**\"",
    "  show_secrets: false",
    "  ignore_known_secrets: false",
    ""
  ].join("\n"), "utf8");
  await fsp.writeFile(path.join(fixture, "README.md"), "clean fixture\n", "utf8");
  return fixture;
}

function runScan(rootDir, env = {}) {
  return spawnSync("/bin/bash", [scriptPath, "--root", rootDir], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

test("verify-secrets falls back to regex scanning when ggshield is unavailable", async () => {
  const fixture = await createFixture();
  const run = runScan(fixture, {
    PATH: "/usr/bin:/bin"
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stderr, /regex fallback/);
  assert.match(run.stdout, /Secret scan passed via regex fallback/);
});

test("verify-secrets fails on regex-detected secrets when ggshield is unavailable", async () => {
  const fixture = await createFixture();
  const fakeSecret = ["SUPER", "SECRET", "KEYVALUE123456"].join("");
  await fsp.writeFile(path.join(fixture, "secret.txt"), `api_key = ${fakeSecret}\n`, "utf8");

  const run = runScan(fixture, {
    PATH: "/usr/bin:/bin"
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Potential secrets detected in repository/);
});

test("verify-secrets prefers ggshield when auth is configured", async () => {
  const fixture = await createFixture();
  const binDir = path.join(fixture, "bin");
  const argsLog = path.join(fixture, "ggshield-args.log");

  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(path.join(binDir, "ggshield"), [
    "#!/usr/bin/env bash",
    "printf '%s\\n' \"$@\" > \"$GGSHIELD_ARGS_LOG\"",
    "exit 0",
    ""
  ].join("\n"), "utf8");
  fs.chmodSync(path.join(binDir, "ggshield"), 0o755);

  const run = runScan(fixture, {
    GITGUARDIAN_API_KEY: "test-token",
    GGSHIELD_ARGS_LOG: argsLog,
    PATH: `${binDir}:/usr/bin:/bin`
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Secret scan passed via ggshield/);

  const loggedArgs = fs.readFileSync(argsLog, "utf8");
  assert.match(loggedArgs, /--config-path/);
  assert.match(loggedArgs, /\.gitguardian\.yaml/);
  assert.match(loggedArgs, /secret/);
  assert.match(loggedArgs, /scan/);
  assert.match(loggedArgs, /path/);
  assert.match(loggedArgs, /--use-gitignore/);
});

test("verify-secrets can require ggshield explicitly", async () => {
  const fixture = await createFixture();
  const run = runScan(fixture, {
    PATH: "/usr/bin:/bin",
    VERIFY_SECRETS_REQUIRE_GGSHIELD: "1"
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /ggshield authenticated scanning is required and prerequisites were not met/);
});
