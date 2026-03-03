"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateEgressPolicy,
  assertOutboundMethodAllowed,
  preparePinnedEgressTarget,
  TOOL_EGRESS_POLICIES
} = require("../../openclaw-bridge/execution/egress-policy.js");

test("mutation egress policy allows only configured methods for beehiiv and notion", () => {
  const beehiiv = validateEgressPolicy("newsletter-publisher-mcp", TOOL_EGRESS_POLICIES, { allowDefault: false });
  assert.equal(beehiiv.valid, true);
  assert.doesNotThrow(() => assertOutboundMethodAllowed("api.beehiiv.com", "POST", beehiiv.policy));
  assert.doesNotThrow(() => assertOutboundMethodAllowed("api.beehiiv.com", "PATCH", beehiiv.policy));
  assert.throws(() => assertOutboundMethodAllowed("api.beehiiv.com", "DELETE", beehiiv.policy), (error) => error && error.code === "EGRESS_METHOD_DENIED");

  const notion = validateEgressPolicy("notion-sync-mcp", TOOL_EGRESS_POLICIES, { allowDefault: false });
  assert.equal(notion.valid, true);
  assert.doesNotThrow(() => assertOutboundMethodAllowed("api.notion.com", "POST", notion.policy));
  assert.throws(() => assertOutboundMethodAllowed("api.notion.com", "GET", notion.policy), (error) => error && error.code === "EGRESS_METHOD_DENIED");
});

test("mutation egress blocks raw IP and DNS rebind on write domains", async () => {
  const policy = TOOL_EGRESS_POLICIES["newsletter-publisher-mcp"];

  assert.throws(
    () => preparePinnedEgressTarget("https://8.8.8.8/v2/publications/test/posts", policy, {
      resolver: {
        async resolve4() { return ["8.8.8.8"]; },
        async resolve6() { return []; }
      }
    }),
    (error) => error && error.code === "EGRESS_IP_LITERAL_DENIED"
  );

  await assert.rejects(
    () => preparePinnedEgressTarget("https://api.beehiiv.com/v2/publications/test/posts", policy, {
      resolver: {
        async resolve4() { return ["127.0.0.1"]; },
        async resolve6() { return []; }
      }
    }),
    (error) => error && error.code === "EGRESS_DNS_REBINDING_DENIED"
  );
});
