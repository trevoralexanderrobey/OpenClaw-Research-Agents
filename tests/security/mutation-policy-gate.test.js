"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

test("mutation policy verification script passes", () => {
  const run = spawnSync("bash", ["scripts/verify-mutation-policy.sh"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
