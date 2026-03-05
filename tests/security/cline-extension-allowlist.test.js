"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function normalizeId(value) {
  return String(value || "").trim();
}

test("cline extension allowlist schema and deterministic union are valid", () => {
  const allowlistPath = path.join(root, "security", "cline-extension-allowlist.json");
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));

  assert.equal(allowlist.schemaVersion, 1);
  assert.ok(Array.isArray(allowlist.officialIds));
  assert.ok(Array.isArray(allowlist.approvedAliasIds));
  assert.ok(Array.isArray(allowlist.allowedIds));
  assert.ok(allowlist.officialIds.length > 0);

  const official = allowlist.officialIds.map(normalizeId);
  const alias = allowlist.approvedAliasIds.map(normalizeId);
  const allowed = allowlist.allowedIds.map(normalizeId);

  assert.ok(official.every(Boolean));
  assert.ok(alias.every(Boolean) || alias.length === 0);
  assert.ok(allowed.every(Boolean));

  const expected = [...new Set([...official, ...alias])].sort();
  const actual = [...new Set(allowed)].sort();
  assert.deepEqual(actual, expected);
});

test("extensions recommendations include allowlisted Cline ID and no unknown Cline ID", () => {
  const allowlistPath = path.join(root, "security", "cline-extension-allowlist.json");
  const extensionsPath = path.join(root, ".vscode", "extensions.json");

  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const extensions = JSON.parse(fs.readFileSync(extensionsPath, "utf8"));

  const allowed = new Set((allowlist.allowedIds || []).map(normalizeId));
  const recommendations = Array.isArray(extensions.recommendations)
    ? extensions.recommendations.map(normalizeId).filter(Boolean)
    : [];

  assert.ok(recommendations.length > 0);
  assert.ok(recommendations.some((id) => allowed.has(id)));

  for (const id of recommendations) {
    if (/(cline|claude-dev)/i.test(id)) {
      assert.equal(allowed.has(id), true, `Cline-related recommendation must be allowlisted: ${id}`);
    }
  }
});
