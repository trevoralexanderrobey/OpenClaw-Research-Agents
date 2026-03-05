#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const { createRunbookOrchestrator } = require("../workflows/runbook-automation/runbook-orchestrator.js");

function parseArgs(argv) {
  const out = {
    remediationRequestPath: "",
    approvalToken: "",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--remediation-request") {
      out.remediationRequestPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--approval-token") {
      out.approvalToken = String(argv[index + 1] || "").trim();
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
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/runbook-orchestrator.js \\",
    "    --remediation-request <path/to/remediation-request.json> \\",
    "    --approval-token <token> \\",
    "    --confirm"
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.remediationRequestPath) {
    process.stderr.write(`${usage()}\n`);
    if (args.unknown.length > 0) {
      process.stderr.write(`Unknown args: ${args.unknown.join(", ")}\n`);
    }
    process.exit(1);
  }

  const resolvedRequestPath = path.resolve(args.remediationRequestPath);
  if (!fs.existsSync(resolvedRequestPath)) {
    process.stderr.write(`Remediation request not found: ${resolvedRequestPath}\n`);
    process.exit(1);
  }

  const remediationRequest = readJson(resolvedRequestPath);
  const apiGovernance = createApiGovernance();
  const operatorAuthorization = createOperatorAuthorization();
  const orchestrator = createRunbookOrchestrator({
    apiGovernance,
    operatorAuthorization
  });

  const presentation = orchestrator.presentRunbook(remediationRequest);

  if (!args.confirm) {
    process.stdout.write(`${JSON.stringify({
      mode: "presentation",
      remediation_request: resolvedRequestPath,
      presentation,
      requires_approval_token: true,
      requires_confirm: true
    }, null, 2)}\n`);
    return;
  }

  if (!args.approvalToken) {
    process.stderr.write("--approval-token is required when --confirm is provided\n");
    process.exit(1);
  }

  const execution = await orchestrator.executeRunbookAction({
    remediation_request_path: resolvedRequestPath,
    remediationRequest,
    approvalToken: args.approvalToken,
    confirm: args.confirm,
    rootDir: process.cwd()
  }, {
    role: "operator",
    requester: args.operatorId,
    correlationId: `phase10-runbook-cli-${args.operatorId}`
  });

  process.stdout.write(`${JSON.stringify({
    mode: "execution",
    remediation_request: resolvedRequestPath,
    presentation,
    execution
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
