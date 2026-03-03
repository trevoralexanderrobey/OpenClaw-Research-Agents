"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createContainerRuntime } = require("../../openclaw-bridge/execution/container-runtime.js");
const { DEFAULT_SANDBOX_POLICY } = require("../../openclaw-bridge/execution/sandbox-policy.js");
const { BUILTIN_TOOL_IMAGES } = require("../../openclaw-bridge/execution/tool-image-catalog.js");
const { MCP_CONTAINER_PROFILES } = require("../../openclaw-bridge/execution/mcp-container-profiles.js");

function mcpInput() {
  return {
    image: BUILTIN_TOOL_IMAGES["semantic-scholar-mcp"],
    args: ["--search"],
    env: {
      REQUEST_MODE: "read"
    },
    resourceLimits: {
      cpuShares: 128,
      memoryLimitMb: 128,
      maxRuntimeSeconds: 30,
      maxOutputBytes: 1024 * 1024
    },
    toolSlug: "semantic-scholar-mcp",
    sandboxConfig: {
      ...DEFAULT_SANDBOX_POLICY
    },
    signatureVerified: true,
    credentialHandle: "semantic_scholar_api_key",
    mcpVolumeNamespace: "scratch-semantic-scholar"
  };
}

test("MCP profiles define isolated credentials and writable namespaces", () => {
  const credentialHandles = new Set();
  const namespaces = new Set();

  for (const profile of Object.values(MCP_CONTAINER_PROFILES)) {
    assert.equal(credentialHandles.has(profile.credentialHandle), false);
    assert.equal(namespaces.has(profile.writableVolumeNamespace), false);
    credentialHandles.add(profile.credentialHandle);
    namespaces.add(profile.writableVolumeNamespace);
  }
});

test("container runtime rejects cross-MCP credential handle", async () => {
  const runtime = createContainerRuntime({ containerRuntimeEnabled: true });
  const input = mcpInput();
  input.credentialHandle = "notion_api_key";
  await assert.rejects(runtime.runContainer(input), (error) => error && error.code === "MCP_CREDENTIAL_ISOLATION_VIOLATION");
});

test("container runtime accepts MCP profile with isolated credential and namespace", async () => {
  const runtime = createContainerRuntime({ containerRuntimeEnabled: true });
  const result = await runtime.runContainer(mcpInput());
  assert.equal(result.exitCode, 0);
  assert.equal(result.rawResult.code, "PHASE2_MOCK_EXECUTION");
});
