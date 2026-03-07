"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const scriptSource = path.join(root, "scripts", "cleanroom-purge-validate.sh");

async function createFixture(runtimeContent) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanroom-policy-"));
  const scriptDir = path.join(tmp, "scripts");
  const bridgeDir = path.join(tmp, "openclaw-bridge");
  await fsp.mkdir(scriptDir, { recursive: true });
  await fsp.mkdir(bridgeDir, { recursive: true });

  const scriptPath = path.join(scriptDir, "cleanroom-purge-validate.sh");
  await fsp.copyFile(scriptSource, scriptPath);
  await fsp.chmod(scriptPath, 0o755);

  fs.writeFileSync(path.join(bridgeDir, "runtime.js"), runtimeContent, "utf8");
  return { tmp, scriptPath };
}

function runPolicy(scriptPath, cwd) {
  return spawnSync("bash", [scriptPath], {
    cwd,
    encoding: "utf8"
  });
}

test("cleanroom purge gate does not false-positive on monetizationMap", async () => {
  const fixture = await createFixture("const monetizationMap = { product: 'dataset' };\n");
  const run = runPolicy(fixture.scriptPath, fixture.tmp);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Clean-room purge validation passed/);
});

test("cleanroom purge gate still fails on true banned token", async () => {
  const fixture = await createFixture("const forbidden = 'run nmap scan';\n");
  const run = runPolicy(fixture.scriptPath, fixture.tmp);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Forbidden offensive capability identifiers detected/);
});

test("cleanroom purge gate still fails on banned phrase", async () => {
  const fixture = await createFixture("const forbidden = 'this enables network scanning';\n");
  const run = runPolicy(fixture.scriptPath, fixture.tmp);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Forbidden offensive capability identifiers detected/);
});
