"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const { createRemediationRecommender } = require("../../workflows/governance-automation/remediation-recommender.js");

const root = path.resolve(__dirname, "../..");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase9-remediation-"));
}

test("phase9 remediation recommender generates deterministic minimal deltas", async () => {
  const dir = await makeTmpDir();
  const outputPath = path.join(dir, "remediation-request.json");
  const driftOutput = {
    drifts: [
      {
        id: "operator-approval-token-required",
        severity: "critical",
        file: "docs/supervisor-architecture.md",
        line: 10,
        violation_clause: "Operator approval token requirement",
        recommended_fix: "Restore operator approval-token requirement clause"
      }
    ]
  };

  const recommender = createRemediationRecommender({
    driftDetectionOutput: driftOutput,
    phaseContracts: { baselineCommit: "c006a0925840d24f7eac02d414a66ce254e98419" }
  });

  const first = recommender.recommendRemediationDelta({ rootDir: root, outputPath });
  const second = recommender.recommendRemediationDelta({ rootDir: root, outputPath });

  assert.equal(first.operator_approval_required, true);
  assert.deepEqual(second, first);
  assert.equal(first.recommendation.recommendations.length, 1);
  assert.equal(first.recommendation.recommendations[0].operator_approval_token_required, true);
  assert.equal(first.recommendation.recommendations[0].governance_transaction_wrapper_required, true);
});

test("phase9 remediation recommender is output-only and does not mutate target files", async () => {
  const dir = await makeTmpDir();
  const outputPath = path.join(dir, "remediation-request.json");
  const filePath = path.join(root, "docs/supervisor-architecture.md");
  const before = fs.readFileSync(filePath, "utf8");

  const recommender = createRemediationRecommender({
    driftDetectionOutput: {
      drifts: [
        {
          id: "supervisor-non-mutation-boundary",
          severity: "critical",
          file: "docs/supervisor-architecture.md",
          line: 1,
          violation_clause: "Supervisor boundary",
          recommended_fix: "Restore boundary"
        }
      ]
    }
  });

  recommender.recommendRemediationDelta({ rootDir: root, outputPath });

  const after = fs.readFileSync(filePath, "utf8");
  assert.equal(after, before);
  assert.equal(fs.existsSync(outputPath), true);
});
