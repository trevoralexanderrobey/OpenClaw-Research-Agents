"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createMcpService } = require("../../openclaw-bridge/mcp/mcp-service.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase3-routing-"));
}

test("mcp routing denies policy/governance override fields", async () => {
  const dir = await makeTmpDir();
  const service = createMcpService({
    apiGovernance: createApiGovernance({
      statePath: path.join(dir, "state.json"),
      researchNdjsonPath: path.join(dir, "research.ndjson")
    })
  });

  await assert.rejects(
    () =>
      service.handle(
        "research.search",
        {
          provider: "semantic-scholar",
          query: "deterministic runtime",
          override_policy: true
        },
        { correlationId: "abcdabcdabcdabcd" }
      ),
    (error) => error && error.code === "MCP_OVERRIDE_FORBIDDEN"
  );
});

test("mcp routing rejects unknown methods", async () => {
  const dir = await makeTmpDir();
  const service = createMcpService({
    apiGovernance: createApiGovernance({
      statePath: path.join(dir, "state.json"),
      researchNdjsonPath: path.join(dir, "research.ndjson")
    })
  });

  await assert.rejects(
    () => service.handle("research.delete", { provider: "semantic-scholar" }, { correlationId: "abcdabcdabcdabcd" }),
    (error) => error && error.code === "MCP_METHOD_NOT_ALLOWED"
  );
});

test("mcp routing denies TLS override fields", async () => {
  const dir = await makeTmpDir();
  const service = createMcpService({
    apiGovernance: createApiGovernance({
      statePath: path.join(dir, "state.json"),
      researchNdjsonPath: path.join(dir, "research.ndjson")
    })
  });

  await assert.rejects(
    () =>
      service.handle(
        "research.search",
        {
          provider: "semantic-scholar",
          query: "deterministic runtime",
          rejectUnauthorized: false
        },
        { correlationId: "abcdabcdabcdabcd" }
      ),
    (error) => error && error.code === "MCP_OVERRIDE_FORBIDDEN"
  );
});

test("stub providers remain non-operational", async () => {
  const dir = await makeTmpDir();
  const service = createMcpService({
    apiGovernance: createApiGovernance({
      statePath: path.join(dir, "state.json"),
      researchNdjsonPath: path.join(dir, "research.ndjson")
    })
  });

  await assert.rejects(
    () =>
      service.handle(
        "research.search",
        {
          provider: "newsletter",
          query: "phase3 digest",
          limit: 1
        },
        { correlationId: "abcdabcdabcdabcd" }
      ),
    (error) => error && error.code === "MCP_NOT_IMPLEMENTED"
  );
});

test("supervisor cannot self-trigger mutation methods", async () => {
  const dir = await makeTmpDir();
  const service = createMcpService({
    apiGovernance: createApiGovernance({
      statePath: path.join(dir, "state.json"),
      researchNdjsonPath: path.join(dir, "research.ndjson")
    })
  });

  await assert.rejects(
    () =>
      service.handle(
        "mutation.setKillSwitch",
        {
          killSwitch: true,
          approvalToken: "cred_test_token_1234"
        },
        { correlationId: "abcdabcdabcdabcd", role: "supervisor" }
      ),
    (error) => error && error.code === "MUTATION_ROLE_DENIED"
  );
});
