"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyOverallStatus,
  classifyProviderStatus,
  parseArgs,
  probeControlledRetry,
  probeControlledTimeout
} = require("../../scripts/run-live-mcp-verification.js");

test("live MCP harness parses provider CLI options deterministically", () => {
  const args = parseArgs(["--providers", "arxiv", "--timeout-ms", "2222"]);
  assert.deepEqual(args.providers, ["arxiv"]);
  assert.equal(args.timeoutMs, 2222);
});

test("live MCP harness captures bounded retry behavior", async () => {
  const result = await probeControlledRetry("arxiv");
  assert.equal(result.status, "success");
  assert.equal(result.attempts_observed, 2);
  assert.equal(result.records_count, 1);
  assert.ok(result.backoff_behavior >= 0);
});

test("live MCP harness captures timeout failure path after bounded retries", async () => {
  const result = await probeControlledTimeout("semantic-scholar");
  assert.equal(result.status, "failed_as_expected");
  assert.equal(result.attempts_observed, 3);
  assert.equal(result.error.code, "MCP_OUTBOUND_REQUEST_FAILED");
});

test("live MCP harness provider and overall classification stay partial when only some evidence is live", () => {
  const providerStatus = classifyProviderStatus({
    controlled_retry: { status: "success" },
    controlled_timeout: { status: "failed_as_expected" },
    direct_client_live: { status: "failed" },
    mcp_service_live: { status: "failed" }
  });
  assert.equal(providerStatus, "partially_verified");

  const overall = classifyOverallStatus([
    {
      controlled_retry: { status: "success" },
      controlled_timeout: { status: "failed_as_expected" },
      direct_client_live: { status: "failed" },
      mcp_service_live: { status: "failed" }
    }
  ]);
  assert.equal(overall, "partially_verified");
});
