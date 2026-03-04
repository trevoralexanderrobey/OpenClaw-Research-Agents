"use strict";

const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const { createExperimentManager } = require("../../workflows/experiment-governance/experiment-manager.js");
const { createDeterministicAssignmentEngine } = require("../../workflows/experiment-governance/deterministic-assignment-engine.js");
const { createExperimentAnalysisEngine } = require("../../workflows/experiment-governance/experiment-analysis-engine.js");
const { createRolloutGovernor } = require("../../workflows/experiment-governance/rollout-governor.js");
const { verifyPhase7StartupIntegrity } = require("../../security/phase7-startup-integrity.js");
const { computeDraftContentHash } = require("../../workflows/rlhf-generator/rlhf-schema.js");
const { attachOutcomeHashes, CHAIN_ZERO_HASH } = require("../../workflows/rlhf-outcomes/outcome-schema.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase7-"));
}

function fixedTimeProvider() {
  let current = Date.parse("2026-03-04T00:00:00.000Z");
  return {
    nowMs() {
      const value = current;
      current += 1000;
      return value;
    },
    nowIso() {
      return new Date(this.nowMs()).toISOString();
    }
  };
}

async function setupPhase7Harness() {
  const dir = await makeTmpDir();
  const timeProvider = fixedTimeProvider();

  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    timeProvider
  });
  const authorization = createOperatorAuthorization({
    nowMs: () => Date.parse("2026-03-04T00:00:00.000Z")
  });

  const analysisEngine = createExperimentAnalysisEngine({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    timeProvider
  });

  const manager = createExperimentManager({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    timeProvider
  });

  const assignmentEngine = createDeterministicAssignmentEngine({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    timeProvider
  });

  const governor = createRolloutGovernor({
    apiGovernance: governance,
    operatorAuthorization: authorization,
    analysisEngine,
    timeProvider
  });

  return {
    dir,
    timeProvider,
    governance,
    authorization,
    manager,
    assignmentEngine,
    analysisEngine,
    governor,
    verifyPhase7StartupIntegrity
  };
}

function issueToken(authorization, scope) {
  return authorization.issueApprovalToken({
    operatorId: "op-1",
    scope
  }).token;
}

async function seedDrafts(governance, count = 4) {
  await governance.withGovernanceTransaction(async (tx) => {
    for (let index = 0; index < count; index += 1) {
      const sequence = index + 1;
      const withoutHash = {
        sequence,
        sourcePaperId: `paper-phase7-${sequence}`,
        sourceHash: `${String(sequence).repeat(64)}`.slice(0, 64),
        domainTag: (index % 2 === 0) ? "security" : "distributed-systems",
        complexityScore: 40 + (index * 5),
        monetizationScore: 40 + (index * 5),
        generatedAt: `2026-03-04T00:00:0${index}.000Z`,
        generatorVersion: "v1",
        status: "approved_for_manual_submission",
        aiAssisted: true,
        reviewedBy: "op-1",
        reviewedAt: `2026-03-04T00:00:0${index}.000Z`,
        notes: "",
        manualSubmissionRequired: true
      };
      tx.state.rlhfWorkflows.drafts.push({
        ...withoutHash,
        contentHash: computeDraftContentHash(withoutHash)
      });
      tx.state.rlhfWorkflows.nextDraftSequence = sequence;
    }
  });
}

async function seedOutcomeSet(governance, records) {
  await governance.withGovernanceTransaction(async (tx) => {
    let prev = CHAIN_ZERO_HASH;
    const out = [];
    let sequence = 0;
    for (const row of records) {
      sequence += 1;
      const withHashes = attachOutcomeHashes({
        sequence,
        draftSequence: Number(row.draftSequence),
        idempotencyKey: `outcome-${sequence}`,
        enteredAt: row.enteredAt,
        enteredBy: "op-1",
        aiAssisted: true,
        manualSubmissionConfirmed: true,
        result: row.result,
        score: Number(row.score),
        feedbackTags: [],
        notes: "",
        evidenceHash: "",
        outcomeVersion: "v1"
      }, prev);
      prev = withHashes.chainHash;
      out.push(withHashes);
    }

    tx.state.rlhfOutcomes.records = out;
    tx.state.rlhfOutcomes.nextOutcomeSequence = out.length;
    tx.state.rlhfOutcomes.chainHeadHash = prev;
    tx.state.rlhfOutcomes.chainHeadSequence = out.length;
  });
}

async function createAndStartExperiment(harness, override = {}) {
  const { manager, authorization } = harness;

  const treatment = override.treatment && typeof override.treatment === "object"
    ? override.treatment
    : {
      templateVersion: "v1",
      calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 }
    };
  const control = override.control && typeof override.control === "object"
    ? override.control
    : {
      templateVersion: "v1",
      calibrationWeights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 }
    };
  const window = override.window && typeof override.window === "object"
    ? override.window
    : {
      startIso: "2026-03-04T00:00:00.000Z",
      endIso: "2026-03-30T00:00:00.000Z",
      minFinalizedOutcomes: 4
    };
  const guardrails = override.guardrails && typeof override.guardrails === "object"
    ? override.guardrails
    : {
      maxRejectRateDelta: 0.10,
      minQualityScore: 60
    };

  const created = await manager.createExperiment({
    approvalToken: issueToken(authorization, "experiment.create"),
    name: override.name || "Phase 7 Experiment",
    objective: override.objective || "Improve acceptance without breaching guardrails",
    treatment,
    control,
    window,
    guardrails,
    analysisPlanVersion: override.analysisPlanVersion || "v1",
    notes: typeof override.notes === "string" ? override.notes : "",
    splitBasisPoints: override.splitBasisPoints && typeof override.splitBasisPoints === "object"
      ? override.splitBasisPoints
      : { control: 5000, treatment: 5000 }
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "corr-create"
  });

  const experimentSequence = Number(created.experiment.sequence);

  await manager.approveExperiment({
    approvalToken: issueToken(authorization, "experiment.approve"),
    experimentSequence
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "corr-approve"
  });

  const started = await manager.startExperiment({
    approvalToken: issueToken(authorization, "experiment.start"),
    experimentSequence
  }, {
    role: "operator",
    requester: "op-1",
    correlationId: "corr-start"
  });

  return started.experiment;
}

module.exports = {
  setupPhase7Harness,
  issueToken,
  seedDrafts,
  seedOutcomeSet,
  createAndStartExperiment
};
