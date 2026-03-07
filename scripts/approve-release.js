#!/usr/bin/env node
"use strict";

const { buildMonetizationRuntime } = require("./_monetization-runtime.js");

function parseArgs(argv) {
  const out = {
    offerId: "",
    operatorId: process.env.OPERATOR_ID || "operator-cli",
    confirm: false,
    unknown: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--offer-id") { out.offerId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--operator-id") { out.operatorId = String(argv[index + 1] || "").trim() || out.operatorId; index += 1; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.offerId) {
    process.stderr.write("Usage: node scripts/approve-release.js --offer-id <offer_id> [--operator-id <operator_id>] --confirm\n");
    process.exit(1);
  }
  if (!args.confirm) {
    process.stderr.write("Release approval rejected: --confirm is required\n");
    process.exit(1);
  }
  const runtime = buildMonetizationRuntime();
  const approval = runtime.releaseApprovalManager.approveRelease({
    offer_id: args.offerId,
    approver: args.operatorId
  });
  process.stdout.write(`${JSON.stringify({ ok: true, approval }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
