#!/usr/bin/env node
"use strict";

const { buildPhase13Runtime } = require("./_phase13-access-utils.js");

function parseArgs(argv) {
  const out = { tokenId: "", action: "", resource: "", scope: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--token-id") {
      out.tokenId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--action") {
      out.action = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--resource") {
      out.resource = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--scope") {
      out.scope = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tokenId || !args.action || !args.resource) {
    process.stderr.write("Usage: node scripts/check-access.js --token-id <id> --action <action> --resource <resource> [--scope <scope>]\n");
    process.exit(1);
  }

  const runtime = buildPhase13Runtime();
  const result = await runtime.permissionEnforcer.evaluateAccess({
    token_id: args.tokenId,
    action: args.action,
    resource: args.resource,
    scope: args.scope
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.allowed) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
