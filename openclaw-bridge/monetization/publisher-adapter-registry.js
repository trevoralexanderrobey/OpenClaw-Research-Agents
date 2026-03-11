"use strict";

const path = require("node:path");

const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function createPublisherAdapterRegistry(options = {}) {
  const platformTargetsConfig = asPlainObject(options.platformTargets);
  const configuredTargets = Object.keys(asPlainObject(platformTargetsConfig.platform_targets)).sort((left, right) => left.localeCompare(right));
  if (configuredTargets.length === 0) {
    const error = new Error("platform targets config must define platform_targets for publisher adapters");
    error.code = "PHASE21_ADAPTER_TARGETS_REQUIRED";
    throw error;
  }

  const sourceAdapters = Array.isArray(options.adapters) ? options.adapters : [];
  const byTarget = new Map();
  const byAdapterId = new Map();
  for (const entry of sourceAdapters) {
    const adapter = asPlainObject(entry);
    const platformTarget = safeString(adapter.platform_target);
    const adapterId = safeString(adapter.adapter_id);
    const adapterVersion = safeString(adapter.adapter_version);
    if (!platformTarget || !adapterId || !adapterVersion || typeof adapter.generateArtifacts !== "function") {
      const error = new Error("publisher adapter entries must provide platform_target, adapter_id, adapter_version, and generateArtifacts()");
      error.code = "PHASE21_ADAPTER_ENTRY_INVALID";
      throw error;
    }
    if (!configuredTargets.includes(platformTarget)) {
      const error = new Error(`publisher adapter '${adapterId}' references unknown target '${platformTarget}'`);
      error.code = "PHASE21_ADAPTER_UNKNOWN_TARGET";
      throw error;
    }
    if (byTarget.has(platformTarget)) {
      const error = new Error(`duplicate publisher adapter registration for target '${platformTarget}'`);
      error.code = "PHASE21_ADAPTER_DUPLICATE_TARGET";
      throw error;
    }
    if (byAdapterId.has(adapterId)) {
      const error = new Error(`duplicate publisher adapter id '${adapterId}'`);
      error.code = "PHASE21_ADAPTER_DUPLICATE_ID";
      throw error;
    }
    byTarget.set(platformTarget, adapter);
    byAdapterId.set(adapterId, platformTarget);
  }

  const missingTargets = configuredTargets.filter((targetName) => !byTarget.has(targetName));
  if (missingTargets.length > 0) {
    const error = new Error(`publisher adapter registry is missing targets: ${missingTargets.join(", ")}`);
    error.code = "PHASE21_ADAPTER_MISSING_TARGETS";
    throw error;
  }

  const summaries = configuredTargets.map((targetName) => {
    const adapter = byTarget.get(targetName);
    return canonicalize({
      adapter_id: safeString(adapter.adapter_id),
      adapter_version: safeString(adapter.adapter_version),
      platform_target: safeString(adapter.platform_target)
    });
  });

  function resolve(platformTarget) {
    const normalizedTarget = safeString(platformTarget);
    const adapter = byTarget.get(normalizedTarget);
    if (!adapter) {
      const error = new Error(`publisher adapter is not registered for target '${normalizedTarget}'`);
      error.code = "PHASE21_ADAPTER_NOT_REGISTERED";
      throw error;
    }
    if (safeString(adapter.platform_target) !== normalizedTarget) {
      const error = new Error(`publisher adapter target mismatch for '${normalizedTarget}'`);
      error.code = "PHASE21_ADAPTER_TARGET_MISMATCH";
      throw error;
    }
    return adapter;
  }

  function list() {
    return summaries.slice();
  }

  return Object.freeze({
    list,
    resolve,
    configured_targets: configuredTargets.slice()
  });
}

function createDefaultPublisherAdapterRegistry(options = {}) {
  const platformTargets = asPlainObject(options.platformTargets);
  const targetNames = Object.keys(asPlainObject(platformTargets.platform_targets)).sort((left, right) => left.localeCompare(right));
  const adapters = targetNames.map((targetName) => {
    const modulePath = path.join(__dirname, "adapters", `${targetName}-manual-adapter.js`);
    let moduleExports = null;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      moduleExports = require(modulePath);
    } catch (error) {
      const wrapped = new Error(`missing default adapter module for '${targetName}'`);
      wrapped.code = "PHASE21_ADAPTER_MODULE_MISSING";
      wrapped.cause = error;
      throw wrapped;
    }
    if (!moduleExports || typeof moduleExports.createAdapter !== "function") {
      const error = new Error(`default adapter module for '${targetName}' must export createAdapter()`);
      error.code = "PHASE21_ADAPTER_FACTORY_MISSING";
      throw error;
    }
    const adapter = moduleExports.createAdapter();
    if (safeString(asPlainObject(adapter).platform_target) !== targetName) {
      const error = new Error(`default adapter for '${targetName}' returned mismatched platform_target`);
      error.code = "PHASE21_ADAPTER_TARGET_MISMATCH";
      throw error;
    }
    return adapter;
  });
  return createPublisherAdapterRegistry({
    platformTargets,
    adapters
  });
}

module.exports = {
  createDefaultPublisherAdapterRegistry,
  createPublisherAdapterRegistry
};
