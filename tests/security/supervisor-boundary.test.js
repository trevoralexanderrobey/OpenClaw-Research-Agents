"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("supervisor execution path is hard denied in router source", () => {
  const filePath = path.join(root, "openclaw-bridge", "src", "core", "execution-router.ts");
  const source = fs.readFileSync(filePath, "utf8");

  assert.match(source, /supervisor:\s*\{\s*canExecuteTools:\s*false/);
  assert.match(source, /SUPERVISOR_EXECUTION_DENIED/);
});

test("supervisor registry contains no supervisor role grants", () => {
  const registryPath = path.join(root, "openclaw-bridge", "supervisor", "supervisor-registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));

  for (const entry of registry) {
    assert.ok(Array.isArray(entry.roles));
    assert.equal(entry.roles.includes("supervisor"), false, `supervisor role found in ${entry.name}`);
  }
});
