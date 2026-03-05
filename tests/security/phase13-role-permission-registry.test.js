"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createRolePermissionRegistry } = require("../../workflows/access-control/role-permission-registry.js");
const { root } = require("./_phase13-helpers.js");

function makeRegistry() {
  return createRolePermissionRegistry({
    policyPath: path.join(root, "security", "rbac-policy.json")
  });
}

test("phase13 role registry returns canonical role definitions", () => {
  const registry = makeRegistry();
  const role = registry.getRole("operator_standard");

  assert.ok(role);
  assert.equal(role.role_id, "operator_standard");
  assert.ok(Array.isArray(role.permissions));
  assert.ok(Array.isArray(role.scopes));
});

test("phase13 role registry enforces deterministic permission checks", () => {
  const registry = makeRegistry();

  const first = registry.hasPermission("operator_standard", "generate", "governance.sbom");
  const second = registry.hasPermission("operator_standard", "generate", "governance.sbom");

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(registry.hasPermission("operator_standard", "execute", "governance.recovery"), false);
  assert.equal(registry.hasPermission("unknown", "read", "*"), false);
});

test("phase13 role registry lists roles and permissions deterministically", () => {
  const registry = makeRegistry();

  const firstRoles = registry.listRoles();
  const secondRoles = registry.listRoles();
  assert.deepEqual(secondRoles, firstRoles);

  const firstPerms = registry.listPermissions("operator_admin");
  const secondPerms = registry.listPermissions("operator_admin");
  assert.deepEqual(secondPerms, firstPerms);
});
