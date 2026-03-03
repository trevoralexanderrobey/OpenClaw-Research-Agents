"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateEgressPolicy,
  assertOutboundTargetAllowed,
  preparePinnedEgressTarget,
  isForbiddenResolvedIp,
  TOOL_EGRESS_POLICIES
} = require("../../openclaw-bridge/execution/egress-policy.js");

test("egress denies outbound google.com for semantic MCP", () => {
  const policy = validateEgressPolicy("semantic-scholar-mcp", TOOL_EGRESS_POLICIES, { allowDefault: false });
  assert.equal(policy.valid, true);
  assert.throws(() => assertOutboundTargetAllowed("google.com", policy.policy), (error) => error && error.code === "EGRESS_DENY_DEFAULT");
});

test("egress denies raw IP literal target", () => {
  const policy = validateEgressPolicy("semantic-scholar-mcp", TOOL_EGRESS_POLICIES, { allowDefault: false });
  assert.throws(() => assertOutboundTargetAllowed("8.8.8.8", policy.policy), (error) => error && error.code === "EGRESS_IP_LITERAL_DENIED");
});

test("egress allows approved host and returns pinned lookup", async () => {
  let resolve4Calls = 0;
  const target = await preparePinnedEgressTarget("https://api.semanticscholar.org/graph/v1/paper/search?query=test", TOOL_EGRESS_POLICIES["semantic-scholar-mcp"], {
    resolver: {
      async resolve4() {
        resolve4Calls += 1;
        return ["34.120.0.1"];
      },
      async resolve6() {
        return [];
      }
    }
  });

  assert.equal(target.hostname, "api.semanticscholar.org");
  assert.equal(target.resolvedIp, "34.120.0.1");
  assert.equal(resolve4Calls, 1);

  await new Promise((resolve, reject) => {
    target.lookup("api.semanticscholar.org", {}, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        assert.equal(address, "34.120.0.1");
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});

test("egress blocks DNS rebinding to loopback/private addresses", async () => {
  await assert.rejects(
    () =>
      preparePinnedEgressTarget("https://api.semanticscholar.org/graph/v1/paper/search?query=test", TOOL_EGRESS_POLICIES["semantic-scholar-mcp"], {
        resolver: {
          async resolve4() {
            return ["127.0.0.1"];
          },
          async resolve6() {
            return ["::1"];
          }
        }
      }),
    (error) => error && error.code === "EGRESS_DNS_REBINDING_DENIED"
  );
});

test("forbidden IP helper covers private and loopback ranges", () => {
  assert.equal(isForbiddenResolvedIp("127.0.0.1"), true);
  assert.equal(isForbiddenResolvedIp("10.1.2.3"), true);
  assert.equal(isForbiddenResolvedIp("169.254.10.20"), true);
  assert.equal(isForbiddenResolvedIp("::1"), true);
  assert.equal(isForbiddenResolvedIp("fc00::1234"), true);
  assert.equal(isForbiddenResolvedIp("8.8.8.8"), false);
});
