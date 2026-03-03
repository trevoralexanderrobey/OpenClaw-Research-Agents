"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { RUNTIME_POLICY, assertGatewayBinding } = require("../../security/runtime-policy.js");

let cachedConfig = null;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = deepClone(child);
  }
  return out;
}

function immutableViolation(pathname) {
  const error = new Error(`Runtime config is immutable after boot: ${pathname}`);
  error.code = "CONFIG_IMMUTABLE_VIOLATION";
  return error;
}

function deepImmutableProxy(value, basePath = "config") {
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return value;
  }

  const proxiedTarget = Array.isArray(value) ? value.slice() : { ...value };
  for (const [key, child] of Object.entries(proxiedTarget)) {
    proxiedTarget[key] = deepImmutableProxy(child, `${basePath}.${key}`);
  }

  return new Proxy(Object.freeze(proxiedTarget), {
    set() {
      throw immutableViolation(basePath);
    },
    defineProperty() {
      throw immutableViolation(basePath);
    },
    deleteProperty() {
      throw immutableViolation(basePath);
    },
  });
}

function resolveConfigPath(rootDir) {
  const direct = path.join(rootDir, "openclaw.json");
  if (fs.existsSync(direct)) {
    return direct;
  }
  return path.join(rootDir, "openclaw-bridge", "openclaw.json");
}

function readOpenClawConfig(rootDir) {
  const configPath = resolveConfigPath(rootDir);
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return parsed;
}

function assertNoDynamicGatewayOverrides() {
  const dynamicPort = process.env.BRIDGE_PORT;
  const dynamicHost = process.env.OPENCLAW_BIND_HOST;

  if (typeof dynamicPort !== "undefined" && String(dynamicPort).trim() !== String(RUNTIME_POLICY.gateway.port)) {
    throw immutableViolation("gateway.port");
  }

  if (typeof dynamicHost !== "undefined" && String(dynamicHost).trim() !== RUNTIME_POLICY.gateway.host) {
    throw immutableViolation("gateway.host");
  }
}

function loadRuntimeConfig(rootDir = process.cwd()) {
  if (cachedConfig) {
    return cachedConfig;
  }

  const source = readOpenClawConfig(rootDir);
  assertNoDynamicGatewayOverrides();

  const gatewayHost = source && source.gateway ? source.gateway.host : null;
  const gatewayPort = source && source.gateway ? source.gateway.port : null;
  assertGatewayBinding(gatewayHost, gatewayPort);

  const normalized = deepClone(source);
  cachedConfig = deepImmutableProxy(normalized);
  return cachedConfig;
}

function clearRuntimeConfigCacheForTests() {
  cachedConfig = null;
}

module.exports = {
  loadRuntimeConfig,
  clearRuntimeConfigCacheForTests,
};
