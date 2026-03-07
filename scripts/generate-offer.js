#!/usr/bin/env node
"use strict";

const { buildMonetizationRuntime } = require("./_monetization-runtime.js");
const { safeString } = require("../workflows/governance-automation/common.js");

function parseArgs(argv) {
  const out = {
    source: "",
    productLine: "",
    tier: "",
    buildId: "",
    targets: "",
    confirm: false,
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--source") { out.source = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--product-line") { out.productLine = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--tier") { out.tier = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--build-id") { out.buildId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--targets") { out.targets = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/generate-offer.js --source <mission_id|dataset_id> --product-line <product_line> --tier <tier>",
    "    [--build-id <build_id>] [--targets a,b,c] --confirm"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.source || !args.productLine || !args.tier) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }
  if (!args.confirm) {
    process.stderr.write("Offer generation rejected: --confirm is required\n");
    process.exit(1);
  }

  const runtime = buildMonetizationRuntime();
  const built = runtime.offerBuilder.buildOffer({
    source: safeString(args.source),
    product_line: safeString(args.productLine),
    tier: safeString(args.tier),
    build_id: safeString(args.buildId),
    targets: safeString(args.targets).split(",").map((entry) => safeString(entry)).filter(Boolean)
  });

  const tempBundleDir = runtime.deliverablePackager.createBundleWorkspace(built.offer.offer_id);
  const artifactRefs = runtime.deliverablePackager.writeDeliverables(tempBundleDir, built.offer, built.source_context);
  const submissionRefs = runtime.submissionPackGenerator.generateSubmissionPacks(tempBundleDir, built.offer, built.source_context);
  runtime.deliverablePackager.writeBundleRoot(tempBundleDir, built.offer, built.source_context, artifactRefs, submissionRefs);
  const finalized = runtime.deliverablePackager.finalizeBundle(tempBundleDir);
  const bundleDir = runtime.deliverablePackager.commitBundle(tempBundleDir, built.offer.offer_id);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    offer_id: built.offer.offer_id,
    bundle_dir: bundleDir,
    manifest_path: finalized.manifest_path.replace(tempBundleDir, bundleDir),
    checksums_path: finalized.checksums_path.replace(tempBundleDir, bundleDir),
    platform_targets: built.offer.platform_targets,
    source_status: built.offer.source_status || {},
    warnings: Array.isArray(built.offer.warnings) ? built.offer.warnings : []
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
