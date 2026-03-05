"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  TOOL_NAME_PATTERN,
  collectDeclarations,
  validateDeclarations
} = require("../../scripts/verify-tool-name-regex.js");

const {
  sanitizeToolLikeName,
  MCP_METHOD_ALIASES
} = require("../../openclaw-bridge/bridge/mcp-method-registry.js");

test("tool name regex policy script passes", () => {
  const run = spawnSync("node", ["scripts/verify-tool-name-regex.js"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Tool name regex validation passed/);
});

test("all collected tool declarations satisfy regex", () => {
  const declarations = collectDeclarations(path.resolve(process.cwd()));
  const result = validateDeclarations(declarations);
  assert.equal(result.invalid.length, 0);
  for (const entry of declarations) {
    assert.match(entry.name, TOOL_NAME_PATTERN, `invalid tool declaration: ${entry.file} -> ${entry.name}`);
  }
});

test("legacy MCP method aliases sanitize deterministically", () => {
  const entries = Object.entries(MCP_METHOD_ALIASES);
  assert.ok(entries.length > 0);
  for (const [oldName, canonicalName] of entries) {
    const expected = sanitizeToolLikeName(oldName);
    assert.equal(canonicalName, expected, `alias mismatch for ${oldName}`);
  }
});
