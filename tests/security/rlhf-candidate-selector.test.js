"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { BaseMcp } = require("../../openclaw-bridge/mcp/base-mcp.js");
const { createRlhfPipelineRunner } = require("../../workflows/rlhf-generator/pipeline-runner.js");
const { selectCandidates } = require("../../workflows/rlhf-generator/candidate-selector.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase5-candidates-"));
}

async function appendResearchRecord(governance, input = {}) {
  await governance.withGovernanceTransaction(async (tx) => {
    tx.applyUsage({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: `corr-${input.paperId}` });
    const sequence = tx.allocateSequence();
    const base = {
      source: "semantic-scholar",
      paper_id: input.paperId,
      title: input.title,
      abstract: input.abstract,
      authors: ["Alice", "Bob"],
      citation_velocity: Number(input.citationVelocity || 0),
      published_at: "2025-01-01T00:00:00.000Z",
      retrieved_at: "2026-03-03T00:00:00.000Z"
    };
    tx.appendResearchRecord({
      ...base,
      hash: BaseMcp.computeRecordHash(base),
      sequence
    });
  });
}

test("candidate ranking is deterministic for identical inputs", () => {
  const records = [
    {
      sequence: 1,
      paper_id: "paper-sec-1",
      hash: "a".repeat(64),
      title: "Security threat model for deterministic sandbox",
      abstract: "This paper studies exploit resistance in distributed systems.",
      authors: ["A", "B"],
      citation_velocity: 240,
      published_at: "2025-01-01T00:00:00.000Z",
      retrieved_at: "2026-03-03T00:00:00.000Z"
    },
    {
      sequence: 2,
      paper_id: "paper-dist-1",
      hash: "b".repeat(64),
      title: "Distributed consensus throughput under network partitions",
      abstract: "A consensus and replication study with latency tradeoffs.",
      authors: ["A"],
      citation_velocity: 120,
      published_at: "2025-01-01T00:00:00.000Z",
      retrieved_at: "2026-03-03T00:00:00.000Z"
    }
  ];

  const first = selectCandidates({ records, existingDrafts: [], domainAllowlist: [], monetizationSnapshot: { score: 50 }, limit: 20 });
  const second = selectCandidates({ records, existingDrafts: [], domainAllowlist: [], monetizationSnapshot: { score: 50 }, limit: 20 });

  assert.deepEqual(first, second);
});

test("queue sequence remains monotonic under concurrent pipeline runs", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await appendResearchRecord(governance, {
    paperId: "paper-sec-concurrent",
    title: "Security exploit detection in sandboxed runtimes",
    abstract: "Threat and vulnerability analysis for deterministic runtimes.",
    citationVelocity: 200
  });

  await appendResearchRecord(governance, {
    paperId: "paper-dist-concurrent",
    title: "Distributed consensus and replication consistency",
    abstract: "Consensus protocols with failure handling and throughput tuning.",
    citationVelocity: 180
  });

  let fixedNowMs = 1710000000000;
  const timeProvider = {
    nowMs() {
      const out = fixedNowMs;
      fixedNowMs += 1000;
      return out;
    },
    nowIso() {
      const out = this.nowMs();
      return new Date(out).toISOString();
    }
  };

  const runner = createRlhfPipelineRunner({
    apiGovernance: governance,
    monetizationEngine: { computeMonetizationScore: async () => ({ ok: true, score: 60, metrics: {} }) },
    timeProvider,
    draftArtifactPath: path.join(dir, "rlhf-drafts.ndjson")
  });

  await Promise.all([
    runner.run({ maxCandidates: 1, domainAllowlist: ["security"], correlationId: "aaaa1111aaaa1111" }),
    runner.run({ maxCandidates: 1, domainAllowlist: ["distributed-systems"], correlationId: "bbbb2222bbbb2222" })
  ]);

  const state = await governance.readState();
  const queue = state.rlhfWorkflows.candidateQueue.concat(state.rlhfWorkflows.reviewQueue);
  const sequences = queue.map((item) => Number(item.queueSequence || 0)).sort((a, b) => a - b);

  assert.equal(sequences.length >= 2, true);
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1)
  );
});
