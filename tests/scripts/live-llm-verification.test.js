"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyOverallStatus,
  isRetryableLlmError,
  parseArgs,
  probeProvider
} = require("../../scripts/run-live-llm-verification.js");

test("live LLM harness parses provider CLI options deterministically", () => {
  const args = parseArgs(["--providers", "local,openai", "--timeout-ms", "1234", "--max-attempts", "3"]);
  assert.deepEqual(args.providers, ["local", "openai"]);
  assert.equal(args.timeoutMs, 1234);
  assert.equal(args.maxAttempts, 3);
});

test("live LLM harness blocks cloud providers when credentials are missing", async () => {
  delete process.env.OPENAI_API_KEY;
  const result = await probeProvider("openai", {
    maxAttempts: 2,
    prompt: "verification"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.blocker.code, "PHASE14_LLM_MISSING_API_KEY");
  assert.equal(result.blocker.missing_prerequisite, "OPENAI_API_KEY");
  assert.deepEqual(result.attempts, []);
});

test("live LLM harness retry classifier distinguishes configuration failures from transport failures", () => {
  const timeoutError = new Error("timed out");
  timeoutError.code = "ETIMEDOUT";
  assert.equal(isRetryableLlmError(timeoutError), true);

  const configError = new Error("missing key");
  configError.code = "PHASE14_LLM_MISSING_API_KEY";
  assert.equal(isRetryableLlmError(configError), false);
});

test("live LLM harness summary status remains needs_verification without a live success", () => {
  const status = classifyOverallStatus([
    { status: "failed" },
    { status: "blocked" }
  ]);
  assert.equal(status, "needs_verification");
});
