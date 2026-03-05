"use strict";

const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");

const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");

async function makeTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-phase11-"));
}

function fixedTimeProvider() {
  let current = Date.parse("2026-03-05T00:00:00.000Z");
  return {
    nowMs() {
      const value = current;
      current += 1000;
      return value;
    },
    nowIso() {
      return new Date(this.nowMs()).toISOString();
    }
  };
}

async function setupPhase11Harness() {
  const dir = await makeTmpDir();
  const timeProvider = fixedTimeProvider();

  const governance = createApiGovernance({
    statePath: path.join(dir, "state.json"),
    researchNdjsonPath: path.join(dir, "research.ndjson"),
    timeProvider
  });

  const authorization = createOperatorAuthorization({
    nowMs: () => Date.parse("2026-03-05T00:00:00.000Z")
  });

  return {
    dir,
    timeProvider,
    governance,
    authorization
  };
}

function issueToken(authorization, scope) {
  return authorization.issueApprovalToken({
    operatorId: "op-1",
    scope
  }).token;
}

module.exports = {
  makeTmpDir,
  fixedTimeProvider,
  setupPhase11Harness,
  issueToken
};
