"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const {
  setupPhase7Harness,
  issueToken,
  createAndStartExperiment
} = require("./_phase7-helpers.js");

const {
  buildDecisionExplanation,
  writePhase7Artifacts
} = require("../../analytics/experiment-explainability/decision-explainer.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase7-explain-"));
}

async function readArtifactFiles(dirPath) {
  const names = (await fsp.readdir(dirPath)).sort((left, right) => left.localeCompare(right));
  const pairs = await Promise.all(names.map(async (name) => {
    const body = await fsp.readFile(path.join(dirPath, name), "utf8");
    return [name, body];
  }));
  return Object.fromEntries(pairs);
}

test("decision explanation output is deterministic and includes disclosure header", () => {
  const input = {
    asOfIso: "2026-03-04T00:00:00.000Z",
    experiment: {
      sequence: 1,
      name: "Explainability Baseline"
    },
    analysisSnapshot: {
      recommendation: "hold",
      reasonCode: "insufficient_power",
      metrics: {
        acceptanceRateDelta: 0,
        reviseRequestRateDelta: 0,
        meanQualityScoreDelta: 0,
        medianQualityScoreDelta: 0,
        domainUplift: {}
      },
      guardrailBreaches: []
    },
    decision: {
      sequence: 3,
      decision: "hold",
      decisionHash: "f".repeat(64)
    }
  };

  const first = buildDecisionExplanation(input);
  const second = buildDecisionExplanation(input);

  assert.deepEqual(first, second);
  assert.match(first.markdown, /AI-assisted analysis disclosure:/);
});

test("phase7 explainability artifacts are byte-identical for equal state and time seed", async () => {
  const harness = await setupPhase7Harness();
  const experiment = await createAndStartExperiment(harness, {
    name: "Artifact Determinism"
  });

  await harness.governor.applyRolloutDecision({
    approvalToken: issueToken(harness.authorization, "experiment.rollout.apply"),
    experimentSequence: Number(experiment.sequence),
    decision: "hold",
    reasonCode: "operator_override",
    idempotencyKey: "artifact-decision"
  }, {
    role: "operator",
    requester: "op-1"
  });

  const leftDir = await makeTmpDir();
  const rightDir = await makeTmpDir();
  const asOfIso = "2026-03-04T00:00:00.000Z";

  await writePhase7Artifacts({
    apiGovernance: harness.governance,
    outDir: leftDir,
    asOfIso
  });

  await writePhase7Artifacts({
    apiGovernance: harness.governance,
    outDir: rightDir,
    asOfIso
  });

  const left = await readArtifactFiles(leftDir);
  const right = await readArtifactFiles(rightDir);

  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
  for (const name of Object.keys(left)) {
    assert.equal(left[name], right[name], `artifact content mismatch: ${name}`);
  }
});
