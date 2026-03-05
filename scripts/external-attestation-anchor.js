#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createApiGovernance } = require("../security/api-governance.js");
const { createOperatorAuthorization } = require("../security/operator-authorization.js");
const { createExternalAttestationAnchor } = require("../workflows/attestation/external-attestation-anchor.js");

function parseArgs(argv) {
  const out = {
    approvalToken: "",
    scope: "governance.attestation.anchor",
    externalService: "",
    evidenceBundlePath: "",
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
    if (token === "--scope") {
      out.scope = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--external-service") {
      out.externalService = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--evidence-bundle") {
      out.evidenceBundlePath = String(argv[index + 1] || "").trim();
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
    "  node scripts/external-attestation-anchor.js \\",
    "    --approval-token <token> \\",
    "    --scope governance.attestation.anchor \\",
    "    --external-service <https://service.example> \\",
    "    --evidence-bundle <path/to/bundle.json> \\",
    "    --confirm"
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length > 0 || !args.approvalToken || !args.externalService || !args.evidenceBundlePath || !args.confirm) {
    process.stderr.write(`${usage()}\n`);
    if (args.unknown.length > 0) {
      process.stderr.write(`Unknown args: ${args.unknown.join(", ")}\n`);
    }
    process.exit(1);
  }

  const resolvedEvidencePath = path.resolve(args.evidenceBundlePath);
  if (!fs.existsSync(resolvedEvidencePath)) {
    process.stderr.write(`Evidence bundle not found: ${resolvedEvidencePath}\n`);
    process.exit(1);
  }

  const apiGovernance = createApiGovernance();
  const operatorAuthorization = createOperatorAuthorization();
  const anchor = createExternalAttestationAnchor({
    apiGovernance,
    operatorAuthorization
  });

  const result = await anchor.initiateAttestationAnchor(readJson(resolvedEvidencePath), args.externalService, {
    role: "operator",
    requester: args.operatorId,
    correlationId: `phase10-attestation-cli-${args.operatorId}`,
    approvalToken: args.approvalToken,
    scope: args.scope,
    confirm: args.confirm
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidence_bundle: resolvedEvidencePath,
    result
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
