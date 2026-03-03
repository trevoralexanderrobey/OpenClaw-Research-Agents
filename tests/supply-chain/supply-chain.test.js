"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");

function runScript(cmd, args = [], env = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
  return result;
}

test("lifecycle hook and cache checksum checks pass", () => {
  const lifecycle = runScript("bash", ["scripts/verify-no-lifecycle-hooks.sh"]);
  assert.equal(lifecycle.status, 0, lifecycle.stderr || lifecycle.stdout);

  const cache = runScript("bash", ["scripts/verify-npm-cache-checksum.sh"]);
  assert.equal(cache.status, 0, cache.stderr || cache.stdout);
});

test("tampering npm cache is detected", () => {
  const lockPath = path.join(root, "security", "npm-cache.lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.ok(lock.files.length > 0, "cache lock has no files");

  const first = lock.files[0];
  const target = path.resolve(path.dirname(lockPath), first.path);
  const original = fs.readFileSync(target);

  try {
    fs.appendFileSync(target, "tamper");
    const verify = runScript("bash", ["scripts/verify-npm-cache-checksum.sh"]);
    assert.notEqual(verify.status, 0, "tampering was not detected");
  } finally {
    fs.writeFileSync(target, original);
  }

  const verifyRestored = runScript("bash", ["scripts/verify-npm-cache-checksum.sh"]);
  assert.equal(verifyRestored.status, 0, verifyRestored.stderr || verifyRestored.stdout);
});

test("cache change requires dependency-review cache reason", () => {
  const reviewPath = path.join(root, "security", "dependency-review.md");
  const backup = fs.readFileSync(reviewPath, "utf8");

  try {
    fs.writeFileSync(
      reviewPath,
      [
        "# Dependency Review",
        "",
        "Lockfile-Review: approved",
        "Reviewer: test",
      ].join("\n") + "\n",
      "utf8"
    );

    const run = runScript("bash", ["scripts/verify-lockfile-review.sh"], {
      FORCE_CACHE_LOCK_CHANGED: "1",
    });
    assert.notEqual(run.status, 0, "cache-lock governance check should fail without cache reason");
  } finally {
    fs.writeFileSync(reviewPath, backup, "utf8");
  }
});
