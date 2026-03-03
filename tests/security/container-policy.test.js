"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createContainerRuntime } = require("../../openclaw-bridge/execution/container-runtime.js");
const { DEFAULT_SANDBOX_POLICY } = require("../../openclaw-bridge/execution/sandbox-policy.js");
const { BUILTIN_TOOL_IMAGES } = require("../../openclaw-bridge/execution/tool-image-catalog.js");

function baseInput() {
  return {
    image: BUILTIN_TOOL_IMAGES["research-fetch-tool"],
    args: ["--noop"],
    env: {},
    resourceLimits: {
      cpuShares: 256,
      memoryLimitMb: 256,
      maxRuntimeSeconds: 60,
      maxOutputBytes: 1024 * 1024,
    },
    toolSlug: "research-fetch-tool",
    sandboxConfig: {
      ...DEFAULT_SANDBOX_POLICY,
    },
    signatureVerified: true,
  };
}

function runtime() {
  return createContainerRuntime({
    containerRuntimeEnabled: true,
  });
}

test("container runtime accepts policy-compliant input", async () => {
  const result = await runtime().runContainer(baseInput());
  assert.equal(result.exitCode, 0);
  assert.equal(result.rawResult.code, "PHASE2_MOCK_EXECUTION");
});

test("attempt privileged container is rejected", async () => {
  const input = baseInput();
  input.sandboxConfig.privileged = true;
  await assert.rejects(runtime().runContainer(input), (error) => error.code === "SANDBOX_POLICY_VIOLATION");
});

test("attempt root container is rejected", async () => {
  const input = baseInput();
  input.sandboxConfig.runAsNonRoot = false;
  await assert.rejects(runtime().runContainer(input), (error) => error.code === "SANDBOX_POLICY_VIOLATION");
});

test("attempt host network mode is rejected", async () => {
  const input = baseInput();
  input.sandboxConfig.hostNetwork = true;
  await assert.rejects(runtime().runContainer(input), (error) => error.code === "SANDBOX_POLICY_VIOLATION");
});

test("attempt outbound connection under deny-all policy is rejected", async () => {
  await assert.rejects(runtime().runContainer(baseInput(), { outboundTargetHost: "example.com" }), (error) => {
    return error.code === "EGRESS_DENY_DEFAULT";
  });
});

test("attempt tag-based image reference is rejected", async () => {
  const input = baseInput();
  input.image = "ghcr.io/openclaw-research/research-fetch-tool:1.0.0";
  await assert.rejects(runtime().runContainer(input), (error) => error.code === "IMAGE_DIGEST_REQUIRED");
});
