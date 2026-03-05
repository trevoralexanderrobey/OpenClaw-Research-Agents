#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const {
  SUPPLY_CHAIN_UPDATE_SCOPE,
  createDependencyUpdateGovernor
} = require("../workflows/supply-chain/dependency-update-governor.js");

function parseArgs(argv) {
  const out = {
    approvalToken: "",
    updateRequestPath: "",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    knownGoodPath: path.resolve(process.cwd(), "security", "known-good-dependencies.json"),
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--approval-token") {
      out.approvalToken = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--update-request") {
      out.updateRequestPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (token === "--confirm") {
      out.confirm = true;
      continue;
    }
    if (token === "--operator-id") {
      out.operatorId = String(argv[index + 1] || "").trim() || out.operatorId;
      index += 1;
      continue;
    }
    if (token === "--known-good") {
      out.knownGoodPath = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/approve-dependency-update.js \\",
    "    --approval-token <token> \\",
    "    --update-request <path/to/update-request.json> \\",
    "    --confirm",
    "",
    `Required approval scope: ${SUPPLY_CHAIN_UPDATE_SCOPE}`
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.approvalToken || !args.updateRequestPath || !args.confirm) {
    process.stderr.write(`${usage()}\n`);
    if (args.unknown.length > 0) {
      process.stderr.write(`Unknown args: ${args.unknown.join(", ")}\n`);
    }
    process.exit(1);
  }

  if (!fs.existsSync(args.updateRequestPath)) {
    process.stderr.write(`Update request not found: ${args.updateRequestPath}\n`);
    process.exit(1);
  }

  const request = JSON.parse(fs.readFileSync(args.updateRequestPath, "utf8"));

  const apiGovernance = createApiGovernance();
  const operatorAuthorization = createOperatorAuthorization();
  const governor = createDependencyUpdateGovernor({
    apiGovernance,
    operatorAuthorization,
    knownGoodPath: args.knownGoodPath
  });

  const plan = governor.presentUpdatePlan({ updateRequest: request });
  const approval = await governor.approveUpdate({
    updateRequest: request,
    approvalToken: args.approvalToken,
    confirm: true
  }, {
    role: "operator",
    requester: args.operatorId,
    correlationId: `phase12-update-cli-${args.operatorId}`,
    approvalToken: args.approvalToken,
    confirm: true
  });

  process.stdout.write(`${JSON.stringify({
    mode: "execution",
    update_request: args.updateRequestPath,
    required_scope: SUPPLY_CHAIN_UPDATE_SCOPE,
    plan,
    approval
  }, null, 2)}\n`);

  if (approval && approval.result && approval.result.result === "rejected") {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
