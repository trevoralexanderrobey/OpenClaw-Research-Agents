"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createScopeRegistry } = require("../../workflows/access-control/scope-registry.js");
const { root } = require("./_phase13-helpers.js");

function makeRegistry() {
  return createScopeRegistry({
    registryPath: path.join(root, "security", "scope-registry.json")
  });
}

test("phase13 scope registry validates known scope and rejects unknown scope", () => {
  const registry = makeRegistry();

  const known = registry.validateScope("governance.token.issue");
  assert.equal(known.valid, true);
  assert.equal(known.required_role, "operator_admin");

  const unknown = registry.validateScope("unknown.scope");
  assert.equal(unknown.valid, false);
});

test("phase13 scope registry lists scopes for role deterministically", () => {
  const registry = makeRegistry();

  const standardScopes = registry.getScopesForRole("operator_standard");
  assert.ok(standardScopes.some((entry) => entry.scope_id === "governance.sbom.generate"));
  assert.ok(!standardScopes.some((entry) => entry.scope_id === "governance.token.issue"));

  const first = registry.listAllScopes();
  const second = registry.listAllScopes();
  assert.deepEqual(second, first);
});
