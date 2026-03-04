"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { BaseMcp } = require("../../openclaw-bridge/mcp/base-mcp.js");
const { createRlhfPipelineRunner } = require("../../workflows/rlhf-generator/pipeline-runner.js");
const { selectCandidates, rankingScoreFor } = require("../../workflows/rlhf-generator/candidate-selector.js");

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

async function setCalibrationAndRolloutProfile(governance, calibrationWeights, rolloutProfile) {
  await governance.withGovernanceTransaction(async (tx) => {
    tx.state.rlhfOutcomes.calibration.weights = {
      complexity: Number(calibrationWeights.complexity),
      monetization: Number(calibrationWeights.monetization),
      qualitySignal: Number(calibrationWeights.qualitySignal)
    };
    tx.state.experimentGovernance.activeRolloutProfile = rolloutProfile;
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

test("candidate ranking consumes calibrated weights and quality priors deterministically", () => {
  const records = [
    {
      sequence: 1,
      paper_id: "paper-sec-cal",
      hash: "c".repeat(64),
      title: "Security sandbox hardening for deterministic runtime",
      abstract: "Threat model and exploit-resistant controls.",
      authors: ["A"],
      citation_velocity: 120,
      published_at: "2025-01-01T00:00:00.000Z",
      retrieved_at: "2026-03-03T00:00:00.000Z"
    },
    {
      sequence: 2,
      paper_id: "paper-dist-cal",
      hash: "d".repeat(64),
      title: "Distributed consensus tuning under failure domains",
      abstract: "Consensus protocols and replication tradeoffs.",
      authors: ["B"],
      citation_velocity: 120,
      published_at: "2025-01-01T00:00:00.000Z",
      retrieved_at: "2026-03-03T00:00:00.000Z"
    }
  ];

  const calibrationWeights = { complexity: 0.2, monetization: 0.2, qualitySignal: 0.6 };
  const qualityPriorByDomain = {
    security: 90,
    "distributed-systems": 10
  };

  const first = selectCandidates({
    records,
    existingDrafts: [],
    domainAllowlist: [],
    monetizationSnapshot: { score: 50 },
    calibrationWeights,
    qualityPriorByDomain,
    limit: 20
  });
  const second = selectCandidates({
    records,
    existingDrafts: [],
    domainAllowlist: [],
    monetizationSnapshot: { score: 50 },
    calibrationWeights,
    qualityPriorByDomain,
    limit: 20
  });

  assert.deepEqual(first, second);
  assert.equal(first[0].domainTag, "security");
});

test("candidate ranking uses valid rollout profile and falls back to calibration when rollout profile is invalid", () => {
  const candidate = {
    complexityScore: 80,
    monetizationScore: 20,
    domainTag: "security"
  };
  const calibrationWeights = {
    complexity: 1,
    monetization: 0,
    qualitySignal: 0
  };

  const scoreWithValidProfile = rankingScoreFor(candidate, {
    calibrationWeights,
    rolloutProfile: {
      version: "v1",
      weights: {
        complexity: 0,
        monetization: 1,
        qualitySignal: 0
      },
      templateBias: {}
    },
    qualityPriorByDomain: {
      security: 100
    }
  });
  const scoreWithInvalidProfile = rankingScoreFor(candidate, {
    calibrationWeights,
    rolloutProfile: {
      version: "v1",
      weights: {
        complexity: 0.8,
        monetization: 0.8,
        qualitySignal: 0
      },
      templateBias: {}
    },
    qualityPriorByDomain: {
      security: 100
    }
  });
  const scoreWithoutProfile = rankingScoreFor(candidate, {
    calibrationWeights,
    qualityPriorByDomain: {
      security: 100
    }
  });

  assert.equal(scoreWithValidProfile, 20);
  assert.equal(scoreWithInvalidProfile, 80);
  assert.equal(scoreWithoutProfile, 80);
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

test("empty candidate runs are deterministic no-op for runtime state", async () => {
  const dir = await makeTmpDir();
  const statePath = path.join(dir, "state.json");
  const governance = createApiGovernance({
    statePath,
    researchNdjsonPath: path.join(dir, "research.ndjson")
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

  const before = JSON.stringify(await governance.readState());
  const first = await runner.run({ maxCandidates: 20, correlationId: "cccc3333cccc3333" });
  const afterFirst = JSON.stringify(await governance.readState());
  const second = await runner.run({ maxCandidates: 20, correlationId: "dddd4444dddd4444" });
  const afterSecond = JSON.stringify(await governance.readState());

  assert.equal(first.noOp, true);
  assert.equal(first.stateMutated, false);
  assert.equal(second.noOp, true);
  assert.equal(second.stateMutated, false);
  assert.equal(before, afterFirst);
  assert.equal(afterFirst, afterSecond);
});

test("artifact store truncated tail line is repaired deterministically on startup path", async () => {
  const dir = await makeTmpDir();
  const artifactPath = path.join(dir, "rlhf-drafts.ndjson");
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  await appendResearchRecord(governance, {
    paperId: "paper-tail-repair",
    title: "Security exploit prevention for deterministic systems",
    abstract: "Threat model and vulnerability analysis.",
    citationVelocity: 210
  });

  const timeProvider = {
    nowMs() {
      return 1711000000000;
    },
    nowIso() {
      return "2026-03-03T00:00:00.000Z";
    }
  };

  const runner = createRlhfPipelineRunner({
    apiGovernance: governance,
    monetizationEngine: { computeMonetizationScore: async () => ({ ok: true, score: 60, metrics: {} }) },
    timeProvider,
    draftArtifactPath: artifactPath
  });

  await runner.run({ maxCandidates: 20, correlationId: "eeee5555eeee5555" });
  await fsp.appendFile(artifactPath, "{\"broken\": ", "utf8");

  const repairedRun = await runner.run({
    maxCandidates: 20,
    domainAllowlist: ["mathematics"],
    correlationId: "ffff6666ffff6666"
  });
  assert.equal(repairedRun.noOp, true);
  assert.equal(repairedRun.artifactRepair.repaired, true);

  const state = await governance.readState();
  const artifactRaw = await fsp.readFile(artifactPath, "utf8");
  const lines = artifactRaw.split("\n").filter((line) => line.trim().length > 0);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.length, state.rlhfWorkflows.drafts.length);
});

test("pipeline runner fallback preserves deterministic ranking when rollout profile is invalid", async () => {
  const calibrationWeights = { complexity: 1, monetization: 0, qualitySignal: 0 };

  const dirA = await makeTmpDir();
  const governanceA = createApiGovernance({
    statePath: path.join(dirA, "state.json"),
    researchNdjsonPath: path.join(dirA, "research.ndjson")
  });
  const dirB = await makeTmpDir();
  const governanceB = createApiGovernance({
    statePath: path.join(dirB, "state.json"),
    researchNdjsonPath: path.join(dirB, "research.ndjson")
  });

  const inputs = [
    {
      paperId: "paper-fallback-1",
      title: "Security boundary analysis in deterministic runtime",
      abstract: "Threat model for exploit containment.",
      citationVelocity: 200
    },
    {
      paperId: "paper-fallback-2",
      title: "Distributed consensus reliability under failures",
      abstract: "Consensus behavior and throughput tradeoffs.",
      citationVelocity: 120
    }
  ];

  for (const input of inputs) {
    await appendResearchRecord(governanceA, input);
    await appendResearchRecord(governanceB, input);
  }

  await setCalibrationAndRolloutProfile(governanceA, calibrationWeights, {
    version: "v1",
    updatedAt: "",
    updatedBy: "",
    weights: { complexity: 0.35, monetization: 0.35, qualitySignal: 0.30 },
    templateBias: {}
  });
  await setCalibrationAndRolloutProfile(governanceB, calibrationWeights, {
    version: "v1",
    updatedAt: "",
    updatedBy: "",
    weights: { complexity: 0.9, monetization: 0.9, qualitySignal: 0.9 },
    templateBias: {}
  });

  const timeProvider = {
    nowMs() {
      return 1712000000000;
    },
    nowIso() {
      return "2026-03-03T00:00:00.000Z";
    }
  };

  const runnerA = createRlhfPipelineRunner({
    apiGovernance: governanceA,
    monetizationEngine: { computeMonetizationScore: async () => ({ ok: true, score: 60, metrics: {} }) },
    timeProvider,
    draftArtifactPath: path.join(dirA, "rlhf-drafts.ndjson")
  });
  const runnerB = createRlhfPipelineRunner({
    apiGovernance: governanceB,
    monetizationEngine: { computeMonetizationScore: async () => ({ ok: true, score: 60, metrics: {} }) },
    timeProvider,
    draftArtifactPath: path.join(dirB, "rlhf-drafts.ndjson")
  });

  await runnerA.run({ maxCandidates: 2, correlationId: "rollout-valid-profile" });
  await runnerB.run({ maxCandidates: 2, correlationId: "rollout-invalid-profile" });

  const stateA = await governanceA.readState();
  const stateB = await governanceB.readState();
  const queueA = stateA.rlhfWorkflows.candidateQueue.map((entry) => ({
    sourcePaperId: entry.sourcePaperId,
    rankingScore: entry.rankingScore
  }));
  const queueB = stateB.rlhfWorkflows.candidateQueue.map((entry) => ({
    sourcePaperId: entry.sourcePaperId,
    rankingScore: entry.rankingScore
  }));

  assert.deepEqual(queueA, queueB);
});
