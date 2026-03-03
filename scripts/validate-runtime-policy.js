#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const openclawPath = path.join(root, "openclaw-bridge", "openclaw.json");
const npmrcPath = path.join(root, ".npmrc");
const runtimeStatePath = path.join(root, "workspace", "runtime", "state.json");
const {
  RUNTIME_POLICY,
  validateRuntimePolicy,
  calculatePolicyChecksum,
} = require(path.join(root, "security", "runtime-policy.js"));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const policyValidation = validateRuntimePolicy(RUNTIME_POLICY);
if (!policyValidation.valid) {
  fail(`Runtime policy invalid: ${policyValidation.errors.join("; ")}`);
}

if (!fs.existsSync(openclawPath)) {
  fail("openclaw.json not found");
}

const openclawConfig = JSON.parse(fs.readFileSync(openclawPath, "utf8"));
if (!openclawConfig.gateway || openclawConfig.gateway.host !== "127.0.0.1" || Number(openclawConfig.gateway.port) !== 18789) {
  fail("openclaw.json gateway binding must be fixed to 127.0.0.1:18789");
}

if (!openclawConfig.execution || openclawConfig.execution.allowLegacyExternalTools !== false) {
  fail("openclaw.json must disable legacy external tools");
}

if (!fs.existsSync(npmrcPath)) {
  fail(".npmrc not found");
}

const npmrc = fs.readFileSync(npmrcPath, "utf8");
if (!/^registry=https:\/\/registry\.npmjs\.org\/$/m.test(npmrc)) {
  fail(".npmrc must pin registry to https://registry.npmjs.org/");
}
if (!/^ignore-scripts=true$/m.test(npmrc)) {
  fail(".npmrc must enforce ignore-scripts=true");
}

if (!fs.existsSync(runtimeStatePath)) {
  fail("workspace/runtime/state.json not found");
}
const runtimeState = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
if (Number(runtimeState.schemaVersion) !== 4) {
  fail("workspace/runtime/state.json schemaVersion must be 4");
}

process.stdout.write(`Runtime policy validation passed (sha256=${calculatePolicyChecksum()})\n`);
