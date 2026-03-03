"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createMonetizationEngine } = require("../../analytics/monetization-engine.js");
const { BaseMcp } = require("../../openclaw-bridge/mcp/base-mcp.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase4-monetization-"));
}

test("monetization engine computes deterministic score from ingestion and committed publications", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await governance.withGovernanceTransaction(async (tx) => {
    tx.applyUsage({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
    const sequence = tx.allocateSequence();
    const base = {
      source: "semantic-scholar",
      paper_id: "paper-1",
      title: "Deterministic",
      abstract: "Stable abstract",
      authors: ["Alice"],
      citation_velocity: 50,
      published_at: "2024-01-01T00:00:00.000Z",
      retrieved_at: "2026-03-03T00:00:00.000Z"
    };
    tx.appendResearchRecord({
      ...base,
      hash: BaseMcp.computeRecordHash(base),
      sequence
    });

    tx.state.outboundMutation.committedPublications.push({
      sequence: 1,
      provider: "newsletter",
      payloadHash: "a".repeat(64),
      idempotencyKey: "b".repeat(64),
      externalId: "post-1",
      committedAt: "2026-03-03T12:00:00.000Z",
      latencyMs: 10,
      status: "committed",
      irreversible: true
    });
  });

  const engine = createMonetizationEngine({ apiGovernance: governance });
  const scoreA = await engine.computeMonetizationScore({ fromDayKey: "2026-03-01", toDayKey: "2026-03-04" });
  const scoreB = await engine.computeMonetizationScore({ fromDayKey: "2026-03-01", toDayKey: "2026-03-04" });

  assert.deepEqual(scoreA, scoreB);
  assert.equal(scoreA.ok, true);
  assert.equal(scoreA.metrics.totalResearchRecords, 1);
  assert.equal(scoreA.metrics.totalPublishes, 1);
  assert.equal(typeof scoreA.score, "number");
});
