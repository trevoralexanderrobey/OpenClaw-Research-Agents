"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createQualityScoreEngine } = require("../../analytics/rlhf-quality/quality-score-engine.js");
const { createMonetizationEngine } = require("../../analytics/monetization-engine.js");
const { computeDraftContentHash } = require("../../workflows/rlhf-generator/rlhf-schema.js");
const { attachOutcomeHashes, CHAIN_ZERO_HASH } = require("../../workflows/rlhf-outcomes/outcome-schema.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase6-quality-"));
}

async function seedState(governance) {
  await governance.withGovernanceTransaction(async (tx) => {
    const draftA = {
      sequence: 1,
      sourcePaperId: "paper-q-1",
      sourceHash: "a".repeat(64),
      domainTag: "security",
      complexityScore: 80,
      monetizationScore: 50,
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
      sourcePaperId: "paper-q-2",
      sourceHash: "b".repeat(64),
      domainTag: "distributed-systems",
      complexityScore: 65,
      monetizationScore: 40,
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
      idempotencyKey: "q-1",
      enteredAt: "2026-03-04T03:00:00.000Z",
      enteredBy: "op-1",
      aiAssisted: true,
      manualSubmissionConfirmed: true,
      result: "accepted",
      score: 92,
      feedbackTags: [],
      notes: "",
      evidenceHash: "",
      outcomeVersion: "v1"
    }, CHAIN_ZERO_HASH);
    const outcomeB = attachOutcomeHashes({
      sequence: 2,
      draftSequence: 2,
      idempotencyKey: "q-2",
      enteredAt: "2026-03-04T04:00:00.000Z",
      enteredBy: "op-1",
      aiAssisted: true,
      manualSubmissionConfirmed: true,
      result: "rejected",
      score: 35,
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

test("quality scoring output is deterministic and replay-safe", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });
  await seedState(governance);

  const monetizationEngine = createMonetizationEngine({ apiGovernance: governance });
  const qualityEngine = createQualityScoreEngine({
    apiGovernance: governance,
    monetizationEngine
  });

  const first = await qualityEngine.computeQualitySnapshot({ asOfIso: "2026-03-04T10:00:00.000Z" });
  const second = await qualityEngine.computeQualitySnapshot({ asOfIso: "2026-03-04T10:00:00.000Z" });

  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.totals.draftCount, 2);
  assert.equal(first.totals.finalizedCount, 2);
  assert.equal(first.perDraft.length, 2);
});
