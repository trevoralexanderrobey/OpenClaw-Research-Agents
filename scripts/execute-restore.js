#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const { createRestoreOrchestrator, RESTORE_SCOPE } = require("../workflows/recovery-assurance/restore-orchestrator.js");

function parseArgs(argv) {
  const out = {
    approvalToken: "",
    restoreRequestPath: "",
    scope: "",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--approval-token") {
      out.approvalToken = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--restore-request") {
      out.restoreRequestPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--scope") {
      out.scope = String(argv[index + 1] || "").trim();
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
    "  node scripts/execute-restore.js \\",
    "    --approval-token <token> \\",
    "    --restore-request <path/to/restore-request.json> \\",
    "    --scope governance.recovery.restore \\",
    "    --confirm"
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.approvalToken || !args.restoreRequestPath || !args.scope || !args.confirm) {
    process.stderr.write(`${usage()}\n`);
    if (args.unknown.length > 0) {
      process.stderr.write(`Unknown args: ${args.unknown.join(", ")}\n`);
    }
    process.exit(1);
  }

  if (args.scope !== RESTORE_SCOPE) {
    process.stderr.write(`--scope must be ${RESTORE_SCOPE}\n`);
    process.exit(1);
  }

  const restoreRequestResolved = path.resolve(args.restoreRequestPath);
  if (!fs.existsSync(restoreRequestResolved)) {
    process.stderr.write(`Restore request not found: ${restoreRequestResolved}\n`);
    process.exit(1);
  }

  const apiGovernance = createApiGovernance();
  const operatorAuthorization = createOperatorAuthorization();
  const orchestrator = createRestoreOrchestrator({
    apiGovernance,
    operatorAuthorization
  });

  const restoreRequest = readJson(restoreRequestResolved);
  const presentation = orchestrator.presentRestorePlan(restoreRequest);
  const execution = await orchestrator.executeRestore({
    restoreRequest,
    approvalToken: args.approvalToken,
    confirm: true
  }, {
    role: "operator",
    requester: args.operatorId,
    correlationId: `phase11-restore-cli-${args.operatorId}`,
    approvalToken: args.approvalToken,
    confirm: true
  });

  process.stdout.write(`${JSON.stringify({
    mode: "execution",
    restore_request: restoreRequestResolved,
    presentation,
    execution
  }, null, 2)}\n`);

  if (execution && execution.result && execution.result.status === "rejected") {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
