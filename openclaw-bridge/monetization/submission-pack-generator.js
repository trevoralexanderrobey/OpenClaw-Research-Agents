"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString, sha256 } = require("../../workflows/governance-automation/common.js");
const {
  PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA,
  PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
  buildInputSnapshotHash,
  buildPublisherAdapterSnapshotHash,
  normalizeBundleSubmissionPath,
  normalizeRelativePath
} = require("./publisher-adapter-contract.js");
const { validatePublisherAdapterManifest } = require("./publisher-adapter-manifest-validator.js");
const { validatePublisherAdapterSnapshot } = require("./publisher-adapter-snapshot-validator.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, body) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(body || ""), "utf8");
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, canonicalJson(canonicalize(value)), "utf8");
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath, "utf8"));
}

function relativeFrom(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => safeString(entry)).filter(Boolean)
    : [];
}

function normalizeDeclaredBundlePath(platformTarget, filePath) {
  const normalized = normalizeRelativePath(filePath);
  const expectedPrefix = `submission/${platformTarget}/`;
  if (normalized.startsWith("submission/")) {
    if (!normalized.startsWith(expectedPrefix)) {
      const error = new Error(`adapter file declaration must stay under ${expectedPrefix}`);
      error.code = "PHASE21_ADAPTER_DECLARED_FILE_ESCAPE";
      throw error;
    }
    return normalized;
  }
  return normalizeBundleSubmissionPath(platformTarget, normalized);
}

function assertSortedUnique(values, code) {
  const sorted = values.slice().sort((left, right) => left.localeCompare(right));
  const unique = Array.from(new Set(sorted));
  if (JSON.stringify(values) !== JSON.stringify(sorted) || JSON.stringify(values) !== JSON.stringify(unique)) {
    const error = new Error("adapter generated file arrays must be sorted and unique");
    error.code = code;
    throw error;
  }
}

function createSubmissionPackGenerator(options = {}) {
  const platformTargets = options.platformTargets && typeof options.platformTargets === "object"
    ? options.platformTargets
    : { platform_targets: {} };
  const publisherAdapterRegistry = options.publisherAdapterRegistry;
  if (!publisherAdapterRegistry || typeof publisherAdapterRegistry.resolve !== "function") {
    const error = new Error("submission pack generator requires a publisherAdapterRegistry");
    error.code = "PHASE21_ADAPTER_REGISTRY_REQUIRED";
    throw error;
  }

  function resolveTargetConfig(platformName) {
    return platformTargets.platform_targets && platformTargets.platform_targets[platformName]
      ? platformTargets.platform_targets[platformName]
      : null;
  }

  function assertRequiredPlaceholders(platformDir, platformName, refs) {
    const targetConfig = resolveTargetConfig(platformName) || {};
    const required = asStringArray(targetConfig.required_artifact_placeholders);
    for (const fileName of required) {
      const filePath = path.join(platformDir, fileName);
      if (!fs.existsSync(filePath)) {
        const error = new Error(`submission pack '${platformName}' is missing required placeholder '${fileName}'`);
        error.code = "PHASE19_SUBMISSION_PLACEHOLDER_MISSING";
        throw error;
      }
    }
    return canonicalize(refs);
  }

  function createEmitter(bundleDir, platformTarget) {
    const emitted = new Set();
    function emit(fileName, writeFn, body) {
      const bundleRel = normalizeBundleSubmissionPath(platformTarget, fileName);
      const absPath = path.join(bundleDir, bundleRel.split("/").join(path.sep));
      writeFn(absPath, body);
      emitted.add(bundleRel);
      return bundleRel;
    }
    return {
      emitJson(fileName, value) {
        return emit(fileName, writeJson, value);
      },
      emitText(fileName, body) {
        return emit(fileName, writeText, body);
      },
      listEmitted() {
        return Array.from(emitted).sort((left, right) => left.localeCompare(right));
      }
    };
  }

  function generatePlatformPlaceholders(platformName, bundleDir, offer, sourceContext) {
    const targetConfig = resolveTargetConfig(platformName);
    if (!targetConfig) {
      const error = new Error(`Unknown platform target '${platformName}' in submission pack generation`);
      error.code = "PHASE21_ADAPTER_UNKNOWN_TARGET";
      throw error;
    }
    if (targetConfig.manual_only !== true) {
      const error = new Error(`Platform target '${platformName}' must remain manual_only`);
      error.code = "PHASE21_ADAPTER_TARGET_MANUAL_ONLY_REQUIRED";
      throw error;
    }
    const adapter = publisherAdapterRegistry.resolve(platformName);
    const platformDir = path.join(bundleDir, "submission", platformName);
    ensureDir(platformDir);
    const emitter = createEmitter(bundleDir, platformName);
    const inputSnapshotHash = buildInputSnapshotHash({
      adapter_id: adapter.adapter_id,
      adapter_version: adapter.adapter_version,
      platform_target: platformName,
      offer,
      source_context: sourceContext,
      target_config: targetConfig
    });

    const generated = adapter.generateArtifacts({
      emitJson: emitter.emitJson,
      emitText: emitter.emitText,
      offer: canonicalize(offer),
      source_context: canonicalize(sourceContext),
      target_config: canonicalize(targetConfig)
    });
    const normalized = asPlainObject(generated);
    const refs = asPlainObject(normalized.refs);
    const declaredFiles = asStringArray(normalized.generated_files).map((entry) => normalizeDeclaredBundlePath(platformName, entry));
    const actualFiles = emitter.listEmitted();
    assertSortedUnique(declaredFiles, "PHASE21_ADAPTER_DECLARED_FILES_ORDER");
    assertSortedUnique(actualFiles, "PHASE21_ADAPTER_ACTUAL_FILES_ORDER");
    if (JSON.stringify(declaredFiles) !== JSON.stringify(actualFiles)) {
      const error = new Error(`adapter '${safeString(adapter.adapter_id)}' declared files do not match emitted files for '${platformName}'`);
      error.code = "PHASE21_ADAPTER_OUTPUT_DECLARATION_MISMATCH";
      throw error;
    }

    const generatedFilesSha = actualFiles.map((file) => canonicalize({
      file,
      sha256: hashFile(path.join(bundleDir, file.split("/").join(path.sep)))
    }));

    const manifestPath = path.join(platformDir, "adapter-manifest.json");
    const manifestBundleRel = relativeFrom(bundleDir, manifestPath);
    const manifest = validatePublisherAdapterManifest({
      schema_version: PHASE21_PUBLISHER_ADAPTER_MANIFEST_SCHEMA,
      platform_target: platformName,
      adapter_id: safeString(adapter.adapter_id),
      adapter_version: safeString(adapter.adapter_version),
      input_snapshot_hash: inputSnapshotHash,
      generated_files: actualFiles,
      generated_files_sha256: generatedFilesSha,
      manual_only: true
    }, {
      platform_target: platformName
    });
    writeJson(manifestPath, manifest);

    const normalizedRefs = {};
    for (const [key, value] of Object.entries(refs)) {
      normalizedRefs[safeString(key)] = normalizeDeclaredBundlePath(platformName, value);
    }
    normalizedRefs.adapter_manifest = manifestBundleRel;
    const placeholderRefs = assertRequiredPlaceholders(platformDir, platformName, normalizedRefs);
    return canonicalize({
      adapter_summary: {
        adapter_id: manifest.adapter_id,
        adapter_manifest: manifestBundleRel,
        adapter_version: manifest.adapter_version,
        generated_files_sha256: manifest.generated_files_sha256,
        input_snapshot_hash: manifest.input_snapshot_hash,
        manifest_sha256: hashFile(manifestPath),
        manual_only: true,
        platform_target: platformName
      },
      refs: placeholderRefs
    });
  }

  function generateSubmissionPacks(bundleDir, offer, sourceContext) {
    const targetNames = asStringArray(offer && offer.platform_targets).sort((left, right) => left.localeCompare(right));
    const submissionRefs = {};
    const targetSummaries = [];
    for (const platformName of targetNames) {
      const generated = generatePlatformPlaceholders(platformName, bundleDir, offer, sourceContext);
      submissionRefs[platformName] = generated.refs;
      targetSummaries.push(generated.adapter_summary);
    }
    const snapshotBase = canonicalize({
      schema_version: PHASE21_PUBLISHER_ADAPTER_SNAPSHOT_SCHEMA,
      targets: targetSummaries.slice().sort((left, right) => left.platform_target.localeCompare(right.platform_target))
    });
    const snapshot = validatePublisherAdapterSnapshot({
      ...snapshotBase,
      publisher_adapter_snapshot_hash: buildPublisherAdapterSnapshotHash(snapshotBase)
    }, {
      expected_targets: targetNames
    });
    return canonicalize({
      publisher_adapter_snapshot: snapshot,
      submission_refs: submissionRefs
    });
  }

  return Object.freeze({
    generateSubmissionPacks
  });
}

module.exports = {
  createSubmissionPackGenerator
};
