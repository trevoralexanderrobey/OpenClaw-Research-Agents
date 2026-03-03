"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { TOOL_EGRESS_POLICIES } = require("../../openclaw-bridge/execution/egress-policy.js");
const { SemanticScholarMcp } = require("../../openclaw-bridge/mcp/semantic-scholar-mcp.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase3-mcp-base-"));
}

test("semantic scholar MCP uses base protections and returns canonical records", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    perMcpRequestsPerMinute: 100,
    globalRequestsPerMinute: 100,
    dailyTokenBudget: 100000,
    dailyRequestLimit: 1000
  });

  const mcp = new SemanticScholarMcp({
    apiGovernance: governance,
    egressPolicies: TOOL_EGRESS_POLICIES,
    resolver: {
      async resolve4() {
        return ["34.120.0.1"];
      },
      async resolve6() {
        return [];
      }
    },
    httpGet: async () => ({
      statusCode: 200,
      body: JSON.stringify({
        data: [
          {
            paperId: "abc123",
            title: "Deterministic Agent Runtime",
            abstract: "<b>Abstract</b>",
            authors: [{ name: "Alice" }, { name: "Bob" }],
            citationCount: 17,
            publicationDate: "2024-01-01T00:00:00.000Z"
          }
        ]
      })
    })
  });

  const result = await mcp.run(
    {
      action: "search",
      query: "deterministic runtime",
      limit: 1
    },
    {
      correlationId: "abcdabcdabcdabcd"
    }
  );

  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result.records), true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].source, "semantic-scholar");
  assert.equal(result.records[0].sequence, 1);
  assert.equal(result.records[0].hash.length, 64);
});

test("base MCP blocks TLS override attempts in request context", async () => {
  const dir = await makeTmpDir();
  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson")
  });

  const mcp = new SemanticScholarMcp({
    apiGovernance: governance,
    egressPolicies: TOOL_EGRESS_POLICIES,
    resolver: {
      async resolve4() {
        return ["34.120.0.1"];
      },
      async resolve6() {
        return [];
      }
    },
    httpGet: async () => ({
      statusCode: 200,
      body: JSON.stringify({ data: [] })
    })
  });

  await assert.rejects(
    () =>
      mcp.policyValidatedGet("https://api.semanticscholar.org/graph/v1/paper/search?query=test", {
        rejectUnauthorized: false
      }),
    (error) => error && error.code === "MCP_TLS_OVERRIDE_FORBIDDEN"
  );
});
