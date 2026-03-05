#!/usr/bin/env node
"use strict";

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const { createOperatorOverrideLedger } = require("../workflows/governance-automation/operator-override-ledger.js");

function parseArgs(argv) {
  const out = {
    approvalToken: "",
    scope: "",
    reason: "",
    phaseImpact: "",
    overridePolicy: "",
    operatorId: process.env.OPERATOR_ID || "operator-cli"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--approval-token") {
      out.approvalToken = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--scope") {
      out.scope = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--reason") {
      out.reason = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--phase-impact") {
      out.phaseImpact = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--override-policy") {
      out.overridePolicy = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--operator-id") {
      out.operatorId = String(argv[index + 1] || "").trim() || out.operatorId;
      index += 1;
      continue;
    }
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-operator-override.js \\",
    "    --approval-token <token> \\",
    "    --scope <phase> \\",
    "    --reason \"<explicit reason>\" \\",
    "    --phase-impact \"<impact statement>\" \\",
    "    --override-policy \"<policy clause being overridden>\""
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.approvalToken || !args.scope || !args.reason || !args.phaseImpact || !args.overridePolicy) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  const apiGovernance = createApiGovernance();
  const operatorAuthorization = createOperatorAuthorization();
  const overrideLedger = createOperatorOverrideLedger({
    apiGovernance,
    operatorAuthorization,
    logger: { info() {}, warn() {}, error() {} }
  });

  const result = await overrideLedger.recordOverride({
    approvalToken: args.approvalToken,
    approval_scope: "governance.override.apply",
    scope: args.scope,
    reason: args.reason,
    phase_impact: args.phaseImpact,
    override_policy: args.overridePolicy,
    operator_id: args.operatorId
  }, {
    role: "operator",
    requester: args.operatorId,
    correlationId: `phase9-override-${args.scope}`
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
