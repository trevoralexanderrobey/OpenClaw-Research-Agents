"use strict";

const path = require("node:path");

const { asArray, canonicalize, safeString } = require("../governance-automation/common.js");
const {
  ACCESS_CONTROL_SCHEMA_VERSION,
  readJsonFileIfExists,
  roleAlias
} = require("./access-control-common.js");

function normalizeScope(entry = {}) {
  return canonicalize({
    scope_id: safeString(entry.scope_id),
    phase: safeString(entry.phase) || "",
    description: safeString(entry.description),
    required_role: roleAlias(entry.required_role),
    allowed_roles: asArray(entry.allowed_roles)
      .map((role) => roleAlias(role))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
    action: safeString(entry.action) || "governance.execute",
    resource: safeString(entry.resource) || safeString(entry.scope_id)
  });
}

function createScopeRegistry(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const registryPath = path.resolve(safeString(options.registryPath) || path.join(process.cwd(), "security", "scope-registry.json"));

  const raw = readJsonFileIfExists(registryPath, null);
  if (!raw || typeof raw !== "object") {
    const error = new Error(`Scope registry missing or invalid at ${registryPath}`);
    error.code = "PHASE13_SCOPE_REGISTRY_MISSING";
    throw error;
  }

  const schemaVersion = safeString(raw.schema_version) || ACCESS_CONTROL_SCHEMA_VERSION;
  const scopes = asArray(raw.scopes)
    .map((entry) => normalizeScope(entry))
    .filter((entry) => entry.scope_id)
    .sort((left, right) => left.scope_id.localeCompare(right.scope_id));

  const scopesById = new Map();
  for (const scope of scopes) {
    scopesById.set(scope.scope_id, scope);
  }

  function validateScope(scopeId) {
    const normalizedScope = safeString(scopeId);
    const entry = scopesById.get(normalizedScope);
    if (!entry) {
      return canonicalize({
        valid: false,
        required_role: "",
        phase: "",
        description: "",
        allowed_roles: [],
        action: "",
        resource: ""
      });
    }

    return canonicalize({
      valid: true,
      required_role: entry.required_role,
      phase: entry.phase,
      description: entry.description,
      allowed_roles: entry.allowed_roles,
      action: entry.action,
      resource: entry.resource
    });
  }

  function getScopesForRole(roleId) {
    const normalizedRole = roleAlias(roleId);
    if (!normalizedRole) {
      return [];
    }
    return canonicalize(
      scopes.filter((scope) => (
        normalizedRole === "operator_admin"
        || scope.required_role === normalizedRole
        || scope.allowed_roles.includes(normalizedRole)
      ))
    );
  }

  function listAllScopes() {
    return canonicalize(scopes);
  }

  logger.info({
    event: "phase13_scope_registry_loaded",
    registry_path: registryPath,
    scope_count: scopesById.size,
    schema_version: schemaVersion
  });

  return Object.freeze({
    registryPath,
    schema_version: schemaVersion,
    validateScope,
    getScopesForRole,
    listAllScopes
  });
}

module.exports = {
  createScopeRegistry
};
