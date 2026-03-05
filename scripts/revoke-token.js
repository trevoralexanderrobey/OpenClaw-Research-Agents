#!/usr/bin/env node
"use strict";

const { buildPhase13Runtime, logCliRejection } = require("./_phase13-access-utils.js");

function parseArgs(argv) {
  const out = {
    tokenId: "",
    reason: "",
    confirm: false,
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    unknown: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--token-id") {
      out.tokenId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--reason") {
      out.reason = String(argv[i + 1] || "").trim();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = buildPhase13Runtime();
  const missing = [];
  if (!args.tokenId) missing.push("--token-id");
  if (!args.reason) missing.push("--reason");
  if (!args.confirm) missing.push("--confirm");

  if (args.unknown.length > 0 || missing.length > 0) {
    await logCliRejection(runtime, {
      actor: args.operatorId,
      action: "revoke_token",
      resource: "phase13.token",
      scope: "governance.token.revoke",
      reason: "missing_required_args",
      metadata: { missing, unknown: args.unknown }
    });
    process.stderr.write("Usage: node scripts/revoke-token.js --token-id <id> --reason <reason> --confirm\n");
    process.exit(1);
  }

  const result = await runtime.tokenManager.revokeToken(args.tokenId, args.reason, {
    role: "operator",
    requester: args.operatorId,
    confirm: true,
    correlationId: `phase13-revoke-token-${args.operatorId}`
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.rejected) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
