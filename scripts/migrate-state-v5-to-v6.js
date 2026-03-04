#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EMPTY_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
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

const schemaVersion = Number(current.schemaVersion);
if (!Number.isFinite(schemaVersion)) {
  fail("State file is missing numeric schemaVersion");
}

if (schemaVersion === 6) {
  process.stdout.write(`State already schemaVersion 6: ${filePath}\n`);
  process.exit(0);
}

if (schemaVersion !== 5) {
  fail(`Unsupported source schemaVersion: ${schemaVersion}`);
}

const migrated = {
  ...current,
  schemaVersion: 6,
  rlhfOutcomes: {
    records: [],
    nextOutcomeSequence: 0,
    calibration: {
      version: "v1",
      lastCalibratedAt: "",
      weights: {
        complexity: 0.35,
        monetization: 0.35,
        qualitySignal: 0.30
      }
    },
    portfolioSnapshots: [],
    nextSnapshotSequence: 0,
    chainHeadHash: EMPTY_HASH,
    chainHeadSequence: 0
  }
};

const payload = `${JSON.stringify(canonicalize(migrated), null, 2)}\n`;
fs.writeFileSync(filePath, payload, "utf8");
process.stdout.write(`Migrated state to schemaVersion 6: ${filePath}\n`);
