#!/usr/bin/env node
"use strict";

const { buildMonetizationRuntime } = require("./_monetization-runtime.js");

function parseArgs(argv) {
  const out = {
    offerId: "",
    platformTarget: "",
    operatorId: "",
    outcomeState: "",
    idempotencyKey: "",
    externalRef: "",
    notes: "",
    evidenceFiles: [],
    eventType: "submission_outcome_recorded",
    confirm: false,
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--offer-id") { out.offerId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--platform-target") { out.platformTarget = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--operator-id") { out.operatorId = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--outcome-state") { out.outcomeState = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--idempotency-key") { out.idempotencyKey = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--external-ref") { out.externalRef = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--notes") { out.notes = String(argv[index + 1] || "").trim(); index += 1; continue; }
    if (token === "--evidence-file") {
      const next = String(argv[index + 1] || "").trim();
      if (next) {
        out.evidenceFiles.push(next);
      }
      index += 1;
      continue;
    }
    if (token === "--event-type") { out.eventType = String(argv[index + 1] || "").trim() || out.eventType; index += 1; continue; }
    if (token === "--confirm") { out.confirm = true; continue; }
    out.unknown.push(token);
  }

  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/record-submission-outcome.js --offer-id <offer_id> --platform-target <platform_target>",
    "    --operator-id <operator_id> --outcome-state <state> --idempotency-key <key> [--evidence-file <path>]",
    "    [--external-ref <value>] [--notes <text>] --confirm"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (
    args.unknown.length > 0
    || !args.offerId
    || !args.platformTarget
    || !args.operatorId
    || !args.outcomeState
    || !args.idempotencyKey
  ) {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }

  if (!args.confirm) {
    process.stderr.write("Submission outcome recording rejected: --confirm is required\n");
    process.exit(1);
  }

  const runtime = buildMonetizationRuntime();
  const result = await runtime.submissionEvidenceManager.recordSubmissionOutcome({
    offer_id: args.offerId,
    platform_target: args.platformTarget,
    operator_id: args.operatorId,
    outcome_state: args.outcomeState,
    idempotency_key: args.idempotencyKey,
    event_type: args.eventType,
    external_ref: args.externalRef,
    notes: args.notes,
    evidence_files: args.evidenceFiles
  });

  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
