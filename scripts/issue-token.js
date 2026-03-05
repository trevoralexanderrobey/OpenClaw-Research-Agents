#!/usr/bin/env node
"use strict";

const { buildPhase13Runtime, logCliRejection, parseCsv } = require("./_phase13-access-utils.js");

function parseArgs(argv) {
  const out = {
    role: "",
    scopes: "",
    expiresIn: "",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    unknown: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--role") {
      out.role = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--scopes") {
      out.scopes = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--expires-in") {
      out.expiresIn = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--confirm") {
      out.confirm = true;
      continue;
    }
    if (token === "--operator-id") {
      out.operatorId = String(argv[i + 1] || "").trim() || out.operatorId;
      i += 1;
      continue;
    }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/issue-token.js --role <role_id> --scopes <scope_a,scope_b> --expires-in <hours> --confirm"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = buildPhase13Runtime();

  const missing = [];
  if (!args.role) missing.push("--role");
  if (!args.scopes) missing.push("--scopes");
  if (!args.expiresIn) missing.push("--expires-in");
  if (!args.confirm) missing.push("--confirm");

  if (args.unknown.length > 0 || missing.length > 0) {
    await logCliRejection(runtime, {
      actor: args.operatorId,
      action: "issue_token",
      resource: "phase13.token",
      scope: "governance.token.issue",
      reason: "missing_required_args",
      metadata: { missing, unknown: args.unknown }
    });
    process.stderr.write(`${usage()}\n`);
    if (missing.length > 0) process.stderr.write(`Missing: ${missing.join(", ")}\n`);
    if (args.unknown.length > 0) process.stderr.write(`Unknown: ${args.unknown.join(", ")}\n`);
    process.exit(1);
  }

  const result = await runtime.tokenManager.issueToken({
    role: args.role,
    scopes: parseCsv(args.scopes),
    expiresInHours: Number(args.expiresIn),
    confirm: true
  }, {
    role: "operator",
    requester: args.operatorId,
    confirm: true,
    correlationId: `phase13-issue-token-${args.operatorId}`
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.rejected) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
