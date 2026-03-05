"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const fs = require("node:fs");

const { createPhaseCompletenessValidator } = require("../../workflows/governance-automation/phase-completeness-validator.js");

const root = path.resolve(__dirname, "../..");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase9-completeness-"));
}

test("phase9 completeness validator passes when repository is complete", () => {
  const validator = createPhaseCompletenessValidator({
    allPhaseBaselines: { baselineCommit: "c006a0925840d24f7eac02d414a66ce254e98419" }
  });
  const result = validator.validatePhaseCompleteness({ rootDir: root });
  assert.equal(result.compliant, true, JSON.stringify(result, null, 2));
});

test("phase9 completeness validator detects missing artifacts", async () => {
  const dir = await makeTmpDir();
  const validator = createPhaseCompletenessValidator();
  const result = validator.validatePhaseCompleteness({ rootDir: dir });
  assert.equal(result.compliant, false);
  assert.ok(result.missing_artifacts.length > 0);
});

test("phase9 completeness validator detects cross-phase contradiction language", async () => {
  const dir = await makeTmpDir();
  await fsp.mkdir(path.join(dir, "docs"), { recursive: true });
  await fsp.writeFile(path.join(dir, "docs/supervisor-architecture.md"), "supervisor may execute protected mutations\n", "utf8");
  await fsp.writeFile(path.join(dir, "docs/failure-modes.md"), "kill-switch bypass\n", "utf8");

  const validator = createPhaseCompletenessValidator();
  const result = validator.validatePhaseCompleteness({ rootDir: dir });
  assert.equal(result.compliant, false);
  assert.ok(result.contradictions.some((entry) => entry.id === "supervisor-boundary-contradiction"));
  assert.ok(result.contradictions.some((entry) => entry.id === "kill-switch-bypass-language"));
});

test("phase9 completeness validator is deterministic", () => {
  const validator = createPhaseCompletenessValidator();
  const first = validator.validatePhaseCompleteness({ rootDir: root });
  const second = validator.validatePhaseCompleteness({ rootDir: root });
  assert.deepEqual(second, first);
});
