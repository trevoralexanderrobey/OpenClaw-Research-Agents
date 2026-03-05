"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalize,
  safeString
} = require("../governance-automation/common.js");
const {
  canonicalHash,
  canonicalStringify,
  normalizeIso,
  sha256File,
  stripHashPrefix
} = require("./supply-chain-common.js");
const {
  SUPPLY_CHAIN_SCHEMA_VERSION,
  validateSupplyChainPayload
} = require("./supply-chain-schema.js");

function makeError(code, message, details) {
  const error = new Error(String(message || "Phase 12 artifact signing manager error"));
  error.code = String(code || "PHASE12_ARTIFACT_SIGNING_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function loadSigningKey(keyPath) {
  const resolved = path.resolve(safeString(keyPath));
  if (!fs.existsSync(resolved)) {
    throw makeError("PHASE12_SIGNING_KEY_MISSING", `Signing key file not found: ${resolved}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const keyId = safeString(parsed.key_id || parsed.keyId);
  const secret = safeString(parsed.hmac_secret || parsed.hmacSecret);

  if (!keyId) {
    throw makeError("PHASE12_SIGNING_KEY_INVALID", "Signing key is missing key_id");
  }
  if (!secret) {
    throw makeError("PHASE12_SIGNING_KEY_INVALID", "Signing key is missing hmac_secret");
  }

  return {
    key_id: keyId,
    hmac_secret: secret
  };
}

function signatureSeed(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  return canonicalize({
    artifact_path: safeString(source.artifact_path),
    artifact_hash: stripHashPrefix(source.artifact_hash),
    sbom_hash: safeString(source.sbom_hash),
    provenance_hash: safeString(source.provenance_hash),
    signer_key_id: safeString(source.signer_key_id),
    timestamp: normalizeIso(source.timestamp)
  });
}

function computeSignature(seed, secret) {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(canonicalStringify(seed))
    .digest("hex");
}

function createArtifactSigningManager(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const defaultKeyPath = path.resolve(safeString(options.keyPath) || path.join(process.cwd(), "security", "artifact-signing-key.json"));

  function signArtifact(input = {}) {
    const artifactPath = path.resolve(safeString(input.artifact_path || input.artifactPath));
    if (!safeString(artifactPath) || !fs.existsSync(artifactPath)) {
      throw makeError("PHASE12_SIGN_ARTIFACT_MISSING", `Artifact not found: ${artifactPath || "(empty)"}`);
    }

    const key = loadSigningKey(safeString(input.keyPath) || defaultKeyPath);
    const timestamp = normalizeIso(safeString(input.timestamp) || safeString(timeProvider.nowIso()));

    const seed = signatureSeed({
      artifact_path: artifactPath,
      artifact_hash: safeString(input.artifact_hash) || sha256File(artifactPath),
      sbom_hash: safeString(input.sbom_hash || input.sbomHash),
      provenance_hash: safeString(input.provenance_hash || input.provenanceHash),
      signer_key_id: key.key_id,
      timestamp
    });

    if (!seed.sbom_hash || !seed.provenance_hash) {
      throw makeError("PHASE12_SIGN_ARTIFACT_INPUT_INVALID", "sbom_hash and provenance_hash are required");
    }

    const signature = computeSignature(seed, key.hmac_secret);
    const signatureRecord = canonicalize({
      schema_version: SUPPLY_CHAIN_SCHEMA_VERSION,
      artifact_path: seed.artifact_path,
      artifact_hash: seed.artifact_hash,
      sbom_hash: seed.sbom_hash,
      provenance_hash: seed.provenance_hash,
      signer_key_id: seed.signer_key_id,
      timestamp: seed.timestamp,
      signature
    });

    const validation = validateSupplyChainPayload("signature_record", signatureRecord);
    if (!validation.valid) {
      throw makeError("PHASE12_SIGNATURE_RECORD_INVALID", "Signature record failed schema validation", {
        violations: validation.violations
      });
    }

    const signatureHash = canonicalHash(signatureRecord);

    logger.info({
      event: "phase12_artifact_signed",
      artifact_path: signatureRecord.artifact_path,
      signer_key_id: signatureRecord.signer_key_id
    });

    return canonicalize({
      signature_record: signatureRecord,
      signature_hash: signatureHash
    });
  }

  function verifySignature(signatureRecord, keyPath) {
    const record = signatureRecord && typeof signatureRecord === "object" ? signatureRecord : {};
    const resolvedKeyPath = safeString(keyPath) || defaultKeyPath;

    try {
      const key = loadSigningKey(resolvedKeyPath);
      const artifactPath = path.resolve(safeString(record.artifact_path));
      const details = [];

      if (!fs.existsSync(artifactPath)) {
        details.push("artifact_missing");
      }

      const actualArtifactHash = fs.existsSync(artifactPath) ? sha256File(artifactPath) : "";
      if (actualArtifactHash && stripHashPrefix(record.artifact_hash) !== actualArtifactHash) {
        details.push("artifact_hash_mismatch");
      }

      const seed = signatureSeed({
        artifact_path: artifactPath,
        artifact_hash: record.artifact_hash,
        sbom_hash: record.sbom_hash,
        provenance_hash: record.provenance_hash,
        signer_key_id: record.signer_key_id,
        timestamp: record.timestamp
      });
      const expectedSignature = computeSignature(seed, key.hmac_secret);

      if (safeString(record.signer_key_id) !== key.key_id) {
        details.push("signer_key_id_mismatch");
      }
      if (safeString(record.signature) !== expectedSignature) {
        details.push("signature_mismatch");
      }

      const valid = details.length === 0;
      return canonicalize({
        valid,
        verification_details: {
          artifact_path: artifactPath,
          expected_signature: expectedSignature,
          actual_signature: safeString(record.signature),
          details
        }
      });
    } catch (error) {
      return canonicalize({
        valid: false,
        verification_details: {
          details: ["verification_error"],
          message: error && error.message ? error.message : String(error)
        }
      });
    }
  }

  return Object.freeze({
    signArtifact,
    verifySignature
  });
}

module.exports = {
  createArtifactSigningManager,
  loadSigningKey,
  computeSignature,
  signatureSeed
};
