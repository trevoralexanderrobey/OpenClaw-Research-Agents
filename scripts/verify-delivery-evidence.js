#!/usr/bin/env node
"use strict";

const { buildMonetizationRuntime } = require("./_monetization-runtime.js");

function parseArgs(argv) {
  const out = {
    offerId: "",
    mode: "full",
    rebuildDerived: false,
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--offer-id") { out.offerId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--mode") { out.mode = String(argv[index + 1] || "").trim() || out.mode; index += 1; continue; }
    if (token === "--incremental") { out.mode = "incremental"; continue; }
    if (token === "--rebuild-derived") { out.rebuildDerived = true; continue; }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/verify-delivery-evidence.js [--offer-id <offer_id>] [--mode full|incremental|rebuild] [--rebuild-derived]",
    "",
    "Modes:",
    "  full         full authoritative verification",
    "  incremental  optimization mode; falls back to full when new events exist",
    "  rebuild      rebuild derived snapshots/index from authoritative stores"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !["full", "incremental", "rebuild"].includes(args.mode)) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  const runtime = buildMonetizationRuntime();
  const manager = runtime.deliveryEvidenceManager;

  if (args.mode === "rebuild") {
    if (args.offerId) {
      const rebuilt = await manager.rebuildDerivedForOffer(args.offerId);
      process.stdout.write(`${JSON.stringify({ ok: true, mode: "rebuild", offer_id: args.offerId, rebuilt }, null, 2)}\n`);
      return;
    }
    const verified = await manager.verifyAllOffers({
      mode: "full",
      rebuild_derived: true
    });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "rebuild", verified }, null, 2)}\n`);
    return;
  }

  if (args.offerId) {
    const result = await manager.verifyOfferDeliveryEvidence({
      offer_id: args.offerId,
      mode: args.mode,
      rebuild_derived: args.rebuildDerived
    });
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    return;
  }

  const result = await manager.verifyAllOffers({
    mode: args.mode,
    rebuild_derived: args.rebuildDerived
  });
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
