#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildPhase13Runtime } = require("./_phase13-access-utils.js");

function parseArgs(argv) {
  const out = { ledgerPath: path.resolve(process.cwd(), "security", "access-decision-ledger.json") };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--ledger") {
      out.ledgerPath = path.resolve(String(argv[i + 1] || out.ledgerPath));
      i += 1;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = buildPhase13Runtime();

  const ledger = fs.existsSync(args.ledgerPath)
    ? JSON.parse(fs.readFileSync(args.ledgerPath, "utf8"))
    : { decisions: [] };
  const decisions = Array.isArray(ledger.decisions) ? ledger.decisions : [];

  const result = runtime.escalationDetector.detectEscalation(decisions);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
