"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createOperatorAuthorization } = require("../../security/operator-authorization.js");

test("operator authorization validates and consumes one-time token", () => {
  let current = 1000;
  const auth = createOperatorAuthorization({
    nowMs: () => current,
    tokenTtlMs: 60_000
  });

  const issued = auth.issueApprovalToken({ operatorId: "alice", scope: "mutation.control.toggle" });
  const validated = auth.validateApprovalToken(issued.token, "mutation.control.toggle");
  assert.equal(validated.ok, true);
  assert.equal(validated.operatorId, "alice");

  const consumed = auth.consumeApprovalToken(issued.token, "mutation.control.toggle");
  assert.equal(consumed.ok, true);

  assert.throws(() => auth.validateApprovalToken(issued.token, "mutation.control.toggle"), (error) => error && error.code === "OPERATOR_TOKEN_REUSED");

  current += 120_000;
  const expired = auth.issueApprovalToken({ operatorId: "alice", scope: "mutation.commit" });
  current += 120_000;
  assert.throws(() => auth.validateApprovalToken(expired.token, "mutation.commit"), (error) => error && error.code === "OPERATOR_TOKEN_INVALID");
});
