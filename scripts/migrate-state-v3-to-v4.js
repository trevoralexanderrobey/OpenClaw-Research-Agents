#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

if (schemaVersion === 4) {
  process.stdout.write(`State already schemaVersion 4: ${filePath}\n`);
  process.exit(0);
}

if (schemaVersion !== 3) {
  fail(`Unsupported source schemaVersion: ${schemaVersion}`);
}

const migrated = {
  ...current,
  schemaVersion: 4,
  apiGovernance: {
    ...(current.apiGovernance && typeof current.apiGovernance === "object" ? current.apiGovernance : {}),
    mutation: {
      hourWindow: {
        hourEpoch: 0,
        publishes: 0
      },
      dayWindow: {
        dayKey: "1970-01-01",
        publishes: 0,
        writeTokens: 0
      },
      controlWindow: {
        minuteEpoch: 0,
        toggles: 0
      },
      accountedAttemptIds: {}
    }
  },
  outboundMutation: {
    enabled: false,
    killSwitch: false,
    pendingPublications: [],
    committedPublications: [],
    lastMutationSequence: 0,
    lastControlToggleAt: null,
    lastControlSequence: 0,
    mutationLogTipHash: "0000000000000000000000000000000000000000000000000000000000000000"
  }
};

const payload = `${JSON.stringify(canonicalize(migrated), null, 2)}\n`;
fs.writeFileSync(filePath, payload, "utf8");
process.stdout.write(`Migrated state to schemaVersion 4: ${filePath}\n`);
