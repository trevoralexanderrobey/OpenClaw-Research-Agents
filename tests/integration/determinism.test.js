"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const {
  nowMs,
  setDeterministicTime,
  clearDeterministicTime,
} = require("../../openclaw-bridge/core/time-provider.js");
const {
  randomUuid,
  setDeterministicSeed,
  clearDeterministicSeed,
} = require("../../openclaw-bridge/core/entropy-provider.js");
const { createApiGovernance } = require("../../security/api-governance.js");
const { createMcpService } = require("../../openclaw-bridge/mcp/mcp-service.js");
const { BaseMcp } = require("../../openclaw-bridge/mcp/base-mcp.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase3-determinism-"));
}

test("time provider supports deterministic override", () => {
  setDeterministicTime(1000, 1);
  try {
    assert.equal(nowMs(), 1000);
    assert.equal(nowMs(), 1001);
  } finally {
    clearDeterministicTime();
  }
});

test("entropy provider supports deterministic seed", () => {
  setDeterministicSeed("seed-value");
  const first = randomUuid();
  clearDeterministicSeed();

  setDeterministicSeed("seed-value");
  const second = randomUuid();
  clearDeterministicSeed();

  assert.equal(first, second);
});

test("restricted globals lint passes", () => {
  const run = spawnSync("bash", ["scripts/lint-restricted-globals.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test("deterministic replay remains stable after MCP ingestion", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 1000,
    globalRequestsPerMinute: 1000,
    dailyTokenBudget: 100000,
    dailyRequestLimit: 100000
  });

  await governance.withGovernanceTransaction(async (tx) => {
    tx.applyUsage({ mcp: "semantic-scholar-mcp", tokens: 1, correlationId: "abcdabcdabcdabcd" });
    const seq = tx.allocateSequence();
    const base = {
      source: "semantic-scholar",
      paper_id: "paper-1",
      title: "Deterministic",
      abstract: "Stable abstract",
      authors: ["Alice"],
      citation_velocity: 1,
      published_at: "2024-01-01T00:00:00.000Z",
      retrieved_at: "2026-03-03T00:00:00.000Z"
    };
    tx.appendResearchRecord({
      ...base,
      hash: BaseMcp.computeRecordHash(base),
      sequence: seq
    });
  });

  const service = createMcpService({ apiGovernance: governance });
  const replay1 = await service.verifyStoredReplay();
  const replay2 = await service.verifyStoredReplay();
  assert.equal(replay1.ok, true);
  assert.equal(replay2.ok, true);
  assert.equal(replay1.count, replay2.count);
});
