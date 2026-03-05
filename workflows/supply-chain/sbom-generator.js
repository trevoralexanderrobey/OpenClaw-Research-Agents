"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
  safeString,
  stableSortStrings
} = require("../governance-automation/common.js");
const {
  canonicalHash,
  dependencyDepthFromPath,
  normalizeIso,
  packageDescriptorHash
} = require("./supply-chain-common.js");
const {
  SUPPLY_CHAIN_SCHEMA_VERSION,
  validateSupplyChainPayload
} = require("./supply-chain-schema.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 12 SBOM generator error"));
  error.code = String(code || "PHASE12_SBOM_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toPurlName(name) {
  const normalized = safeString(name);
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("@")) {
    return encodeURIComponent(normalized);
  }
  const segments = normalized.split("/");
  const scope = encodeURIComponent(segments[0] || "");
  const pkg = encodeURIComponent(segments[1] || "");
  return `${scope}/${pkg}`;
}

function collectDirectDependencies(lockRoot = {}) {
  const names = [
    ...Object.keys(lockRoot.dependencies || {}),
    ...Object.keys(lockRoot.optionalDependencies || {}),
    ...Object.keys(lockRoot.devDependencies || {})
  ];
  return stableSortStrings(names);
}

function normalizeComponent(lockPath, entry, directDependencies) {
  const source = entry && typeof entry === "object" ? entry : {};
  const normalizedPath = safeString(lockPath).split(path.sep).join("/");
  const name = normalizedPath.replace(/^node_modules\//, "");
  const version = safeString(source.version);

  if (!name || !version) {
    return null;
  }

  const dependencyDepth = dependencyDepthFromPath(normalizedPath);
  const purlName = toPurlName(name);

  return canonicalize({
    type: "library",
    name,
    version,
    purl: `pkg:npm/${purlName}@${encodeURIComponent(version)}`,
    license: safeString(source.license) || "UNKNOWN",
    package_hash_sha256: packageDescriptorHash(name, source),
    dependency_depth: dependencyDepth,
    direct_dependency: directDependencies.includes(name),
    resolved: safeString(source.resolved),
    integrity: safeString(source.integrity)
  });
}

function buildComponents(lock = {}) {
  const packages = lock && lock.packages && typeof lock.packages === "object" ? lock.packages : {};
  const lockRoot = packages[""] && typeof packages[""] === "object" ? packages[""] : {};
  const directDependencies = collectDirectDependencies(lockRoot);

  const components = [];
  for (const [lockPath, entry] of Object.entries(packages)) {
    if (!safeString(lockPath)) {
      continue;
    }
    const component = normalizeComponent(lockPath, entry, directDependencies);
    if (component) {
      components.push(component);
    }
  }

  return components.sort((left, right) => {
    if (left.name !== right.name) {
      return left.name.localeCompare(right.name);
    }
    return left.version.localeCompare(right.version);
  });
}

function createSbomGenerator(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };

  function generateSbom() {
    const packageJsonPath = path.join(rootDir, "package.json");
    const lockPath = path.join(rootDir, "package-lock.json");

    if (!fs.existsSync(packageJsonPath)) {
      throw makeError("PHASE12_SBOM_PACKAGE_JSON_MISSING", "package.json not found", { packageJsonPath });
    }
    if (!fs.existsSync(lockPath)) {
      throw makeError("PHASE12_SBOM_LOCKFILE_MISSING", "package-lock.json not found", { lockPath });
    }

    const pkg = readJson(packageJsonPath);
    const lock = readJson(lockPath);
    const generatedAt = normalizeIso(safeString(options.generatedAt) || safeString(timeProvider.nowIso()));
    const components = buildComponents(lock);

    const sbom = canonicalize({
      schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber: "urn:uuid:00000000-0000-0000-0000-000000000012",
      version: 1,
      metadata: {
        timestamp: generatedAt,
        component: {
          type: "application",
          name: safeString(pkg.name),
          version: safeString(pkg.version),
          license: safeString(pkg.license) || "UNKNOWN"
        },
        tools: [{
          vendor: "OpenClaw",
          name: "phase12-sbom-generator",
          version: "1.0.0"
        }]
      },
      components
    });

    const validation = validateSupplyChainPayload("sbom", sbom);
    if (!validation.valid) {
      throw makeError("PHASE12_SBOM_SCHEMA_INVALID", "Generated SBOM failed schema validation", {
        violations: validation.violations
      });
    }

    const sbomHash = canonicalHash(sbom);

    const result = canonicalize({
      sbom,
      sbom_hash: sbomHash,
      component_count: sbom.components.length,
      generated_at: generatedAt
    });

    logger.info({
      event: "phase12_sbom_generated",
      component_count: result.component_count,
      sbom_hash: result.sbom_hash
    });

    return result;
  }

  return Object.freeze({
    generateSbom
  });
}

module.exports = {
  createSbomGenerator,
  buildComponents,
  normalizeComponent,
  collectDirectDependencies
};
