"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
  safeString
} = require("../governance-automation/common.js");
const {
  stableComponentKey
} = require("./supply-chain-common.js");
const {
  validateSupplyChainPayload
} = require("./supply-chain-schema.js");

function normalizeComponent(component = {}) {
  const source = component && typeof component === "object" ? component : {};
  return canonicalize({
    name: safeString(source.name),
    version: safeString(source.version),
    purl: safeString(source.purl),
    license: safeString(source.license),
    package_hash_sha256: safeString(source.package_hash_sha256).replace(/^sha256:/i, "").toLowerCase(),
    dependency_depth: Number.parseInt(String(source.dependency_depth || 0), 10) || 0,
    direct_dependency: source.direct_dependency === true
  });
}

function sortStrings(values) {
  return values.slice().sort((left, right) => left.localeCompare(right));
}

function normalizeComponentList(components) {
  const list = Array.isArray(components) ? components : [];
  return list
    .map((entry) => normalizeComponent(entry))
    .filter((entry) => safeString(entry.name) && safeString(entry.version))
    .sort((left, right) => {
      const leftKey = stableComponentKey(left);
      const rightKey = stableComponentKey(right);
      return leftKey.localeCompare(rightKey);
    });
}

function toMapByKey(components) {
  const map = new Map();
  for (const component of normalizeComponentList(components)) {
    map.set(stableComponentKey(component), component);
  }
  return map;
}

function loadKnownGoodManifest(knownGoodPath) {
  const resolved = path.resolve(safeString(knownGoodPath));
  if (!fs.existsSync(resolved)) {
    return {
      valid: false,
      manifest: null,
      violations: [{
        code: "known_good_manifest_missing",
        message: `Known-good dependency manifest is missing: ${resolved}`
      }]
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const validation = validateSupplyChainPayload("dependency_manifest", parsed);
    if (!validation.valid) {
      return {
        valid: false,
        manifest: parsed,
        violations: validation.violations.map((entry) => canonicalize({
          code: "known_good_manifest_schema_invalid",
          message: safeString(entry.message) || "Known-good manifest schema violation",
          field: safeString(entry.field)
        }))
      };
    }

    return {
      valid: true,
      manifest: parsed,
      violations: []
    };
  } catch (error) {
    return {
      valid: false,
      manifest: null,
      violations: [{
        code: "known_good_manifest_parse_error",
        message: error && error.message ? error.message : "Known-good manifest JSON parse failed"
      }]
    };
  }
}

function normalizeCurrentSbom(currentSbom) {
  const source = currentSbom && typeof currentSbom === "object" ? currentSbom : {};
  if (Array.isArray(source.components)) {
    return normalizeComponentList(source.components);
  }
  if (source.sbom && Array.isArray(source.sbom.components)) {
    return normalizeComponentList(source.sbom.components);
  }
  return [];
}

function createDependencyIntegrityVerifier(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const knownGoodPath = path.resolve(safeString(options.knownGoodPath) || path.join(process.cwd(), "security", "known-good-dependencies.json"));

  function verifyDependencyIntegrity(currentSbom) {
    const knownGoodState = loadKnownGoodManifest(knownGoodPath);
    if (!knownGoodState.valid) {
      return canonicalize({
        valid: false,
        added: [],
        removed: [],
        modified: [],
        hash_mismatches: [],
        violations: knownGoodState.violations
      });
    }

    const currentComponents = normalizeCurrentSbom(currentSbom);
    const knownComponents = normalizeComponentList(knownGoodState.manifest.components);

    const currentMap = toMapByKey(currentComponents);
    const knownMap = toMapByKey(knownComponents);

    const added = [];
    const removed = [];
    const modified = [];
    const hashMismatches = [];
    const violations = [];

    for (const key of currentMap.keys()) {
      if (!knownMap.has(key)) {
        added.push(key);
      }
    }

    for (const key of knownMap.keys()) {
      if (!currentMap.has(key)) {
        removed.push(key);
      }
    }

    for (const key of currentMap.keys()) {
      if (!knownMap.has(key)) {
        continue;
      }
      const current = currentMap.get(key);
      const known = knownMap.get(key);
      if (JSON.stringify(current) !== JSON.stringify(known)) {
        modified.push(key);
        if (safeString(current.package_hash_sha256) !== safeString(known.package_hash_sha256)) {
          hashMismatches.push(key);
        }
      }
    }

    for (const key of sortStrings(added)) {
      violations.push(canonicalize({
        code: "dependency_added",
        dependency: key,
        message: `Dependency present in current SBOM but absent in known-good manifest: ${key}`
      }));
    }

    for (const key of sortStrings(removed)) {
      violations.push(canonicalize({
        code: "dependency_removed",
        dependency: key,
        message: `Dependency missing from current SBOM but present in known-good manifest: ${key}`
      }));
    }

    for (const key of sortStrings(modified)) {
      violations.push(canonicalize({
        code: "dependency_modified",
        dependency: key,
        message: `Dependency metadata changed from known-good manifest: ${key}`
      }));
    }

    for (const key of sortStrings(hashMismatches)) {
      violations.push(canonicalize({
        code: "dependency_hash_mismatch",
        dependency: key,
        message: `Dependency package hash mismatch for ${key}`
      }));
    }

    const result = canonicalize({
      valid: violations.length === 0,
      added: sortStrings(added),
      removed: sortStrings(removed),
      modified: sortStrings(modified),
      hash_mismatches: sortStrings(hashMismatches),
      violations
    });

    if (result.valid) {
      logger.info({
        event: "phase12_dependency_integrity_verified",
        valid: true,
        dependency_count: currentComponents.length
      });
    } else {
      logger.warn({
        event: "phase12_dependency_integrity_failed",
        violations: result.violations.length
      });
    }

    return result;
  }

  return Object.freeze({
    verifyDependencyIntegrity
  });
}

module.exports = {
  createDependencyIntegrityVerifier,
  normalizeComponent,
  normalizeComponentList,
  loadKnownGoodManifest
};
