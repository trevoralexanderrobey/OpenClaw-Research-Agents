#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function buildDefaultComplianceGovernanceState() {
  return {
    policyVersion: "v1",
    attestationSnapshots: [],
    evidenceBundles: [],
    releaseGates: [],
    activeReleasePolicy: {
      version: "v1",
      updatedAt: "",
      updatedBy: "",
      requiredChecks: ["phase2-gates", "mcp-policy", "phase6-policy", "phase7-policy"],
      minEvidenceFreshnessHours: 24
    },
    decisionLedger: {
      records: [],
      nextSequence: 0,
      chainHead: ""
    },
    nextAttestationSequence: 0,
    nextEvidenceBundleSequence: 0,
    nextReleaseGateSequence: 0
  };
}

function applyMigration(input) {
  const schemaVersion = Number(input && input.schemaVersion);
  if (!Number.isFinite(schemaVersion)) {
    fail("State file is missing numeric schemaVersion");
  }
  if (schemaVersion === 8) {
    return {
      migrated: false,
      state: input
    };
  }
  if (schemaVersion !== 7) {
    fail(`Unsupported source schemaVersion: ${schemaVersion}`);
  }

  const nextState = {
    ...input,
    schemaVersion: 8,
    complianceGovernance: buildDefaultComplianceGovernanceState()
  };

  return {
    migrated: true,
    state: nextState
  };
}

const filePath = path.resolve(process.argv[2] || path.join(process.cwd(), "workspace", "runtime", "state.json"));
if (!fs.existsSync(filePath)) {
  fail(`State file not found: ${filePath}`);
}

let current;
try {
  current = JSON.parse(fs.readFileSync(filePath, "utf8"));
} catch (error) {
  fail(`Failed to parse state JSON: ${error && error.message ? error.message : String(error)}`);
}

const firstPass = applyMigration(current);
if (!firstPass.migrated) {
  process.stdout.write(`State already schemaVersion 8: ${filePath}\n`);
  process.exit(0);
}

const secondPass = applyMigration(firstPass.state);
const firstHash = canonicalHash(firstPass.state);
const secondHash = canonicalHash(secondPass.state);
if (firstHash !== secondHash) {
  fail("Migration is not idempotent under canonical hashing");
}

const payload = `${JSON.stringify(canonicalize(firstPass.state), null, 2)}\n`;
fs.writeFileSync(filePath, payload, "utf8");
process.stdout.write(`Migrated state to schemaVersion 8: ${filePath}\n`);
