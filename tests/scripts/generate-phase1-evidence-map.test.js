"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TARGETS,
  buildEvidenceMap,
  fileExistsOnMain,
  firstIntroducingCommit
} = require("../../scripts/generate-phase1-evidence-map.js");

test("phase1 evidence map reconstructs the first scaffold bundle commit", () => {
  const map = buildEvidenceMap();

  assert.equal(map.historical_reconstruction, true);
  assert.equal(map.phase1_repo_seed_commit.sha, "ae1e51aaa3818f99b6461c6029d7dc817e9dfcf9");
  assert.equal(map.summary.first_phase1_bundle_commit.sha, "a050721b98a7e2eda91c29f527bcd417fd3cbccb");
  assert.equal(Array.isArray(map.targets), true);
  assert.equal(map.targets.length, TARGETS.length);
  assert.ok(map.targets.some((entry) => entry.kind === "implemented"));
  assert.ok(map.targets.some((entry) => entry.kind === "scaffolded"));
});

test("phase1 evidence helpers distinguish current and historical-only files", () => {
  assert.equal(fileExistsOnMain("audit/phase1-checklist.md"), true);
  assert.equal(fileExistsOnMain("PHASE1_ARCHITECTURAL_BLUEPRINT.md"), false);

  const blueprint = firstIntroducingCommit("PHASE1_ARCHITECTURAL_BLUEPRINT.md");
  assert.equal(blueprint.sha, "a050721b98a7e2eda91c29f527bcd417fd3cbccb");
});
