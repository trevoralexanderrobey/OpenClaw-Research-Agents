"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const crypto = require("node:crypto");

const { createApiGovernance } = require("../../security/api-governance.js");
const { computeDraftContentHash } = require("../../workflows/rlhf-generator/rlhf-schema.js");
const { attachOutcomeHashes, CHAIN_ZERO_HASH } = require("../../workflows/rlhf-outcomes/outcome-schema.js");
const { createMonetizationEngine } = require("../../analytics/monetization-engine.js");
const { createQualityScoreEngine } = require("../../analytics/rlhf-quality/quality-score-engine.js");
const { createPortfolioPlanner } = require("../../analytics/portfolio-intelligence/portfolio-planner.js");
const { createWeeklyReportBuilder } = require("../../analytics/portfolio-intelligence/weekly-report-builder.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase6-portfolio-"));
}

function hashFile(filePath) {
  const body = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function seedState(governance) {
  await governance.withGovernanceTransaction(async (tx) => {
    const draftA = {
      sequence: 1,
      sourcePaperId: "paper-p-1",
      sourceHash: "a".repeat(64),
      domainTag: "security",
      complexityScore: 80,
      monetizationScore: 55,
      generatedAt: "2026-03-04T00:00:00.000Z",
      generatorVersion: "v1",
      status: "approved_for_manual_submission",
      aiAssisted: true,
      reviewedBy: "op-1",
      reviewedAt: "2026-03-04T00:00:00.000Z",
      notes: "",
      manualSubmissionRequired: true
    };
    const draftB = {
      sequence: 2,
      sourcePaperId: "paper-p-2",
      sourceHash: "b".repeat(64),
      domainTag: "distributed-systems",
      complexityScore: 60,
      monetizationScore: 45,
      generatedAt: "2026-03-04T01:00:00.000Z",
      generatorVersion: "v1",
      status: "approved_for_manual_submission",
      aiAssisted: true,
      reviewedBy: "op-1",
      reviewedAt: "2026-03-04T01:00:00.000Z",
      notes: "",
      manualSubmissionRequired: true
    };
    tx.state.rlhfWorkflows.drafts.push({
      ...draftA,
      contentHash: computeDraftContentHash(draftA)
    });
    tx.state.rlhfWorkflows.drafts.push({
      ...draftB,
      contentHash: computeDraftContentHash(draftB)
    });
    tx.state.rlhfWorkflows.nextDraftSequence = 2;

    const outcomeA = attachOutcomeHashes({
      sequence: 1,
      draftSequence: 1,
      idempotencyKey: "p-1",
      enteredAt: "2026-03-04T02:00:00.000Z",
      enteredBy: "op-1",
      aiAssisted: true,
      manualSubmissionConfirmed: true,
      result: "accepted",
      score: 90,
      feedbackTags: [],
      notes: "",
      evidenceHash: "",
      outcomeVersion: "v1"
    }, CHAIN_ZERO_HASH);
    const outcomeB = attachOutcomeHashes({
      sequence: 2,
      draftSequence: 2,
      idempotencyKey: "p-2",
      enteredAt: "2026-03-04T03:00:00.000Z",
      enteredBy: "op-1",
      aiAssisted: true,
      manualSubmissionConfirmed: true,
      result: "revise_requested",
      score: 65,
      feedbackTags: [],
      notes: "",
      evidenceHash: "",
      outcomeVersion: "v1"
    }, outcomeA.chainHash);
    tx.state.rlhfOutcomes.records.push(outcomeA, outcomeB);
    tx.state.rlhfOutcomes.nextOutcomeSequence = 2;
    tx.state.rlhfOutcomes.chainHeadHash = outcomeB.chainHash;
    tx.state.rlhfOutcomes.chainHeadSequence = 2;
  });
}

test("portfolio priority recommendations are deterministic", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await seedState(governance);

  const qualityEngine = createQualityScoreEngine({
    apiGovernance: governance,
    monetizationEngine: createMonetizationEngine({ apiGovernance: governance })
  });
  const planner = createPortfolioPlanner({
    apiGovernance: governance,
    qualityScoreEngine: qualityEngine
  });

  const first = await planner.buildPortfolioPlan({ asOfIso: "2026-03-04T12:00:00.000Z" });
  const second = await planner.buildPortfolioPlan({ asOfIso: "2026-03-04T12:00:00.000Z" });
  assert.deepEqual(first, second);
  assert.equal(first.noOp, false);
  assert.equal(first.priorities.length > 0, true);
});

test("empty report windows are deterministic no-op without state drift", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  const governance = createApiGovernance({
    statePath,
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await governance.withGovernanceTransaction(async () => {});

  const qualityEngine = createQualityScoreEngine({
    apiGovernance: governance,
    monetizationEngine: createMonetizationEngine({ apiGovernance: governance })
  });
  const planner = createPortfolioPlanner({
    apiGovernance: governance,
    qualityScoreEngine: qualityEngine
  });
  const reportBuilder = createWeeklyReportBuilder({
    apiGovernance: governance,
    portfolioPlanner: planner,
    outDir: path.join(dir, "phase6")
  });

  const beforeHash = hashFile(statePath);
  const first = await reportBuilder.buildWeeklyIntelReport({ asOfIso: "2026-03-04T12:00:00.000Z" });
  const second = await reportBuilder.buildWeeklyIntelReport({ asOfIso: "2026-03-04T12:00:00.000Z" });
  const afterHash = hashFile(statePath);

  assert.deepEqual(first, second);
  assert.equal(first.noOp, true);
  assert.equal(beforeHash, afterHash);
});
