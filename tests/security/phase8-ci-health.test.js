"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  evaluateCiHealth
} = require("../../scripts/verify-phase8-ci-health.js");

function readFixture(name) {
  const filePath = path.join(__dirname, "../fixtures/phase8-ci", name);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("ci health evaluation passes when merge SHA run is green and historical failure is superseded", () => {
  const result = evaluateCiHealth({
    runsPayload: readFixture("runs-superseded-failure-then-success.json"),
    jobsPayload: { jobs: [] },
    mergeSha: "de825fadcbe4e70eba604e0f497b2df48f9eda8f",
    workflowName: "phase2-security",
    historicalRunId: "22658655231"
  });

  assert.equal(result.ok, true);
  assert.equal(result.latestMergeRun.conclusion, "success");
  assert.equal(result.historical.classification, "EXPECTED_SUPERSEDED");
});

test("ci health evaluation blocks when merge SHA run is failing", () => {
  const result = evaluateCiHealth({
    runsPayload: readFixture("runs-merge-sha-blocking.json"),
    jobsPayload: readFixture("jobs-blocking.json"),
    mergeSha: "de825fadcbe4e70eba604e0f497b2df48f9eda8f",
    workflowName: "phase2-security",
    historicalRunId: "22658655231"
  });

  assert.equal(result.ok, false);
  assert.equal(result.latestMergeRun.conclusion, "failure");
  assert.equal(result.failedJobs.length, 1);
  assert.equal(result.failedJobs[0].failedSteps[0], "Phase 8 policy verification");
});

test("ci health script runs in fixture mode", () => {
  const root = path.resolve(__dirname, "../..");
  const run = spawnSync("node", [
    "scripts/verify-phase8-ci-health.js",
    "--merge-sha", "de825fadcbe4e70eba604e0f497b2df48f9eda8f",
    "--workflow-name", "phase2-security",
    "--historical-run-id", "22658655231",
    "--fixture-runs", "tests/fixtures/phase8-ci/runs-merge-sha-success.json",
    "--fixture-jobs", "tests/fixtures/phase8-ci/jobs-blocking.json"
  ], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /"verdict": "PASS"/);
});
