#!/usr/bin/env node
"use strict";

const { buildPhase13Runtime } = require("./_phase13-access-utils.js");

function parseArgs(argv) {
  const out = { sessionId: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--session-id") {
      out.sessionId = String(argv[i + 1] || "").trim();
      i += 1;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sessionId) {
    process.stderr.write("Usage: node scripts/validate-session.js --session-id <id>\n");
    process.exit(1);
  }
  const runtime = buildPhase13Runtime();
  const result = runtime.sessionManager.validateSession(args.sessionId);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exit(1);
}

main();
