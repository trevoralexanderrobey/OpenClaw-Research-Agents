"use strict";

const path = require("node:path");

const { canonicalize, safeString, sha256 } = require("../../workflows/governance-automation/common.js");

const PHASE22_EXPORT_EVENTS_SCHEMA = "phase22-export-events-v1";
const PHASE22_EXPORT_EVENT_SCHEMA = "phase22-export-event-v1";
const PHASE22_EVIDENCE_LEDGER_SCHEMA = "phase22-submission-evidence-ledger-v1";
const PHASE22_EVIDENCE_EVENT_SCHEMA = "phase22-submission-evidence-event-v1";
const PHASE22_EVIDENCE_SNAPSHOT_SCHEMA = "phase22-submission-evidence-snapshot-v1";
const PHASE22_EVIDENCE_INDEX_SCHEMA = "phase22-submission-evidence-index-v1";
const PHASE22_VERIFY_STATUS_SCHEMA = "phase22-submission-evidence-verification-status-v1";

const EXPORT_EVENT_TYPES = Object.freeze(["bundle_exported"]);
const EVIDENCE_EVENT_TYPES = Object.freeze(["submission_outcome_recorded", "submission_correction_recorded"]);
const SUBMISSION_STATES = Object.freeze([
  "ready_for_manual_submission",
  "submitted_pending_review",
  "published_confirmed",
  "rejected",
  "needs_revision",
  "withdrawn"
]);
const TERMINAL_SUBMISSION_STATES = Object.freeze(["published_confirmed", "withdrawn"]);

const ALLOWED_EVIDENCE_EXTENSIONS = Object.freeze([".json", ".txt", ".md", ".csv", ".png", ".jpg", ".jpeg", ".webp", ".pdf"]);

const ZERO_HASH = "0".repeat(64);

const DEFAULT_MAX_BYTES_PER_FILE = 25 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_EVENT = 20;
const DEFAULT_MAX_TOTAL_BYTES_PER_OFFER = 1024 * 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_OFFER = 10000;

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function asStringArray(value) {
  return asArray(value)
    .map((entry) => safeString(entry))
    .filter(Boolean);
}

function sortUnique(values) {
  return Array.from(new Set(asArray(values).slice().sort((left, right) => left.localeCompare(right))));
}

function validateSha(value, code, message) {
  const normalized = safeString(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    const error = new Error(message || "sha256 value must be a lowercase hex digest");
    error.code = safeString(code) || "PHASE22_SHA_INVALID";
    throw error;
  }
  return normalized;
}

function ensureAllowed(value, allowedValues, code, message) {
  const normalized = safeString(value);
  if (!allowedValues.includes(normalized)) {
    const error = new Error(message || "value is not allowed");
    error.code = safeString(code) || "PHASE22_VALUE_INVALID";
    throw error;
  }
  return normalized;
}

function normalizeIso(value, code, fieldName) {
  const normalized = safeString(value);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    const error = new Error(`${safeString(fieldName) || "timestamp"} must be a valid ISO timestamp`);
    error.code = safeString(code) || "PHASE22_TIME_INVALID";
    throw error;
  }
  return normalized;
}

function normalizeRelativePath(inputPath, code = "PHASE22_PATH_INVALID") {
  const raw = safeString(inputPath).replace(/\\/g, "/");
  if (!raw) {
    const error = new Error("path is required");
    error.code = code;
    throw error;
  }
  if (raw.startsWith("/") || raw === "." || raw === ".." || raw.startsWith("../") || raw.includes("/../")) {
    const error = new Error(`path '${raw}' escapes the repository root`);
    error.code = code;
    throw error;
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    const error = new Error(`path '${raw}' is invalid after normalization`);
    error.code = code;
    throw error;
  }
  return normalized;
}

function normalizeFileExtension(fileName) {
  return path.extname(String(fileName || "")).toLowerCase();
}

function ensureFileType(value, code, message) {
  const normalized = safeString(value).toLowerCase();
  if (!ALLOWED_EVIDENCE_EXTENSIONS.includes(normalized)) {
    const error = new Error(message || `file_type '${normalized || "(empty)"}' is not allowed`);
    error.code = safeString(code) || "PHASE22_FILE_TYPE_INVALID";
    throw error;
  }
  return normalized;
}

function normalizeExportArtifactRefs(input) {
  const refs = asArray(input).map((entry) => {
    const item = asPlainObject(entry);
    const byteSize = asInt(item.byte_size, -1);
    if (byteSize < 0) {
      const error = new Error("export artifact byte_size must be >= 0");
      error.code = "PHASE22_EXPORT_ARTIFACT_BYTE_SIZE_INVALID";
      throw error;
    }
    const artifactPath = normalizeRelativePath(item.path || item.export_path || item.file, "PHASE22_EXPORT_ARTIFACT_PATH_INVALID");
    const fileType = safeString(item.file_type || normalizeFileExtension(artifactPath) || "folder").toLowerCase();
    return canonicalize({
      byte_size: byteSize,
      file_type: fileType,
      path: artifactPath,
      sha256: validateSha(item.sha256, "PHASE22_EXPORT_ARTIFACT_SHA_INVALID", "export artifact sha256 must be valid")
    });
  });
  const sorted = refs.slice().sort((left, right) => left.path.localeCompare(right.path));
  const unique = sortUnique(sorted.map((entry) => entry.path));
  if (sorted.length !== unique.length) {
    const error = new Error("export_artifact_refs paths must be unique");
    error.code = "PHASE22_EXPORT_ARTIFACT_PATH_DUPLICATE";
    throw error;
  }
  return sorted;
}

function normalizeExportedPlatformTargets(value) {
  const targets = sortUnique(asStringArray(value));
  if (targets.length === 0) {
    const error = new Error("exported_platform_targets is required");
    error.code = "PHASE22_EXPORT_TARGETS_REQUIRED";
    throw error;
  }
  return targets;
}

function normalizeEvidenceStoredPath(inputPath, platformTarget, code = "PHASE22_EVIDENCE_STORED_PATH_INVALID") {
  const target = safeString(platformTarget);
  if (!target) {
    const error = new Error("platform_target is required");
    error.code = "PHASE22_EVIDENCE_PLATFORM_TARGET_REQUIRED";
    throw error;
  }
  const normalized = normalizeRelativePath(inputPath, code);
  const expectedPrefix = `submission-evidence/${target}/evidence/`;
  if (!normalized.startsWith(expectedPrefix)) {
    const error = new Error(`stored_path must stay under '${expectedPrefix}'`);
    error.code = code;
    throw error;
  }
  return normalized;
}

function normalizeEvidenceRefs(input, platformTarget) {
  const refs = asArray(input).map((entry) => {
    const item = asPlainObject(entry);
    const byteSize = asInt(item.byte_size, -1);
    if (byteSize < 0) {
      const error = new Error("evidence ref byte_size must be >= 0");
      error.code = "PHASE22_EVIDENCE_REF_BYTE_SIZE_INVALID";
      throw error;
    }
    const originalFileName = safeString(item.original_filename);
    if (!originalFileName) {
      const error = new Error("evidence ref original_filename is required");
      error.code = "PHASE22_EVIDENCE_REF_ORIGINAL_FILENAME_REQUIRED";
      throw error;
    }
    const storedPath = normalizeEvidenceStoredPath(item.stored_path, platformTarget, "PHASE22_EVIDENCE_REF_STORED_PATH_INVALID");
    const fileType = ensureFileType(
      item.file_type || normalizeFileExtension(originalFileName) || normalizeFileExtension(storedPath),
      "PHASE22_EVIDENCE_REF_FILE_TYPE_INVALID",
      "evidence ref file_type must be one of the allowed extensions"
    );
    return canonicalize({
      byte_size: byteSize,
      file_type: fileType,
      original_filename: originalFileName,
      sha256: validateSha(item.sha256, "PHASE22_EVIDENCE_REF_SHA_INVALID", "evidence ref sha256 must be valid"),
      stored_path: storedPath
    });
  });
  const sorted = refs.slice().sort((left, right) => left.stored_path.localeCompare(right.stored_path));
  const unique = sortUnique(sorted.map((entry) => entry.stored_path));
  if (sorted.length !== unique.length) {
    const error = new Error("evidence_refs stored_path values must be unique");
    error.code = "PHASE22_EVIDENCE_REF_PATH_DUPLICATE";
    throw error;
  }
  return sorted;
}

function normalizeStateTransition(value) {
  const transition = asPlainObject(value);
  return canonicalize({
    from: ensureAllowed(
      transition.from,
      SUBMISSION_STATES,
      "PHASE22_EVIDENCE_STATE_FROM_INVALID",
      "state_transition.from is invalid"
    ),
    to: ensureAllowed(
      transition.to,
      SUBMISSION_STATES,
      "PHASE22_EVIDENCE_STATE_TO_INVALID",
      "state_transition.to is invalid"
    )
  });
}

function assertNonEmptyPayload(payload = {}) {
  const evidenceRefs = asArray(payload.evidence_refs);
  const externalRef = safeString(payload.external_ref);
  const notes = safeString(payload.notes);
  if (evidenceRefs.length < 1 && !externalRef && !notes) {
    const error = new Error("at least one payload element is required: evidence_refs, external_ref, or notes");
    error.code = "PHASE22_EVIDENCE_PAYLOAD_EMPTY";
    throw error;
  }
}

function buildExportEventBase(input = {}) {
  const source = asPlainObject(input);
  const offerId = safeString(source.offer_id);
  if (!offerId) {
    const error = new Error("offer_id is required");
    error.code = "PHASE22_EXPORT_OFFER_ID_REQUIRED";
    throw error;
  }
  const operatorId = safeString(source.operator_id);
  if (!operatorId) {
    const error = new Error("operator_id is required");
    error.code = "PHASE22_EXPORT_OPERATOR_ID_REQUIRED";
    throw error;
  }
  return canonicalize({
    schema_version: PHASE22_EXPORT_EVENT_SCHEMA,
    event_type: ensureAllowed(
      source.event_type,
      EXPORT_EVENT_TYPES,
      "PHASE22_EXPORT_EVENT_TYPE_INVALID",
      "export event_type is invalid"
    ),
    offer_id: offerId,
    approved_bundle_hash: validateSha(source.approved_bundle_hash, "PHASE22_EXPORT_APPROVED_HASH_INVALID", "approved_bundle_hash must be valid"),
    exported_at: normalizeIso(source.exported_at, "PHASE22_EXPORT_TIME_INVALID", "exported_at"),
    export_format: ensureAllowed(source.export_format, ["folder", "zip"], "PHASE22_EXPORT_FORMAT_INVALID", "export_format must be folder or zip"),
    operator_id: operatorId,
    exported_platform_targets: normalizeExportedPlatformTargets(source.exported_platform_targets),
    export_artifact_refs: normalizeExportArtifactRefs(source.export_artifact_refs)
  });
}

function buildEvidenceEventBase(input = {}) {
  const source = asPlainObject(input);
  const offerId = safeString(source.offer_id);
  if (!offerId) {
    const error = new Error("offer_id is required");
    error.code = "PHASE22_EVIDENCE_OFFER_ID_REQUIRED";
    throw error;
  }
  const platformTarget = safeString(source.platform_target);
  if (!platformTarget) {
    const error = new Error("platform_target is required");
    error.code = "PHASE22_EVIDENCE_PLATFORM_TARGET_REQUIRED";
    throw error;
  }
  const operatorId = safeString(source.operator_id);
  if (!operatorId) {
    const error = new Error("operator_id is required");
    error.code = "PHASE22_EVIDENCE_OPERATOR_ID_REQUIRED";
    throw error;
  }
  const idempotencyKey = safeString(source.idempotency_key);
  if (!idempotencyKey) {
    const error = new Error("idempotency_key is required");
    error.code = "PHASE22_IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const base = canonicalize({
    schema_version: PHASE22_EVIDENCE_EVENT_SCHEMA,
    recorded_at: normalizeIso(source.recorded_at, "PHASE22_EVIDENCE_RECORDED_AT_INVALID", "recorded_at"),
    event_type: ensureAllowed(
      source.event_type,
      EVIDENCE_EVENT_TYPES,
      "PHASE22_EVIDENCE_EVENT_TYPE_INVALID",
      "evidence event_type is invalid"
    ),
    offer_id: offerId,
    platform_target: platformTarget,
    operator_id: operatorId,
    state_transition: normalizeStateTransition(source.state_transition),
    approved_bundle_hash: validateSha(source.approved_bundle_hash, "PHASE22_EVIDENCE_APPROVED_HASH_INVALID", "approved_bundle_hash must be valid"),
    external_ref: safeString(source.external_ref),
    notes: safeString(source.notes),
    evidence_refs: normalizeEvidenceRefs(source.evidence_refs, platformTarget),
    idempotency_key: idempotencyKey
  });
  assertNonEmptyPayload(base);
  return base;
}

function computeExportEventHash(eventWithoutEventHash = {}) {
  return sha256(`${PHASE22_EXPORT_EVENT_SCHEMA}|${JSON.stringify(canonicalize(eventWithoutEventHash))}`);
}

function computeEvidenceEventHash(eventWithoutEventHash = {}) {
  return sha256(`${PHASE22_EVIDENCE_EVENT_SCHEMA}|${JSON.stringify(canonicalize(eventWithoutEventHash))}`);
}

function attachExportEventHashes(baseEvent, sequence, prevEventHash) {
  const normalizedSequence = asInt(sequence, 0);
  if (normalizedSequence < 1) {
    const error = new Error("sequence must be >= 1");
    error.code = "PHASE22_EXPORT_SEQUENCE_INVALID";
    throw error;
  }
  const prevHash = validateSha(prevEventHash || ZERO_HASH, "PHASE22_EXPORT_PREV_HASH_INVALID", "prev_event_hash must be valid");
  const payload = canonicalize({
    ...buildExportEventBase(baseEvent),
    sequence: normalizedSequence,
    prev_event_hash: prevHash
  });
  return canonicalize({
    ...payload,
    event_hash: computeExportEventHash(payload)
  });
}

function attachEvidenceEventHashes(baseEvent, sequence, prevEventHash) {
  const normalizedSequence = asInt(sequence, 0);
  if (normalizedSequence < 1) {
    const error = new Error("sequence must be >= 1");
    error.code = "PHASE22_EVIDENCE_SEQUENCE_INVALID";
    throw error;
  }
  const prevHash = validateSha(prevEventHash || ZERO_HASH, "PHASE22_EVIDENCE_PREV_HASH_INVALID", "prev_event_hash must be valid");
  const payload = canonicalize({
    ...buildEvidenceEventBase(baseEvent),
    sequence: normalizedSequence,
    prev_event_hash: prevHash
  });
  return canonicalize({
    ...payload,
    event_hash: computeEvidenceEventHash(payload)
  });
}

function validateExportEvent(eventInput = {}) {
  const event = asPlainObject(eventInput);
  if (safeString(event.schema_version) !== PHASE22_EXPORT_EVENT_SCHEMA) {
    const error = new Error(`export event schema_version must be ${PHASE22_EXPORT_EVENT_SCHEMA}`);
    error.code = "PHASE22_EXPORT_SCHEMA_INVALID";
    throw error;
  }
  const sequence = asInt(event.sequence, 0);
  if (sequence < 1) {
    const error = new Error("export event sequence must be >= 1");
    error.code = "PHASE22_EXPORT_SEQUENCE_INVALID";
    throw error;
  }
  const prevEventHash = validateSha(event.prev_event_hash, "PHASE22_EXPORT_PREV_HASH_INVALID", "export prev_event_hash must be valid");
  const base = canonicalize({
    ...buildExportEventBase(event),
    sequence,
    prev_event_hash: prevEventHash
  });
  const expectedHash = computeExportEventHash(base);
  const eventHash = validateSha(event.event_hash, "PHASE22_EXPORT_EVENT_HASH_INVALID", "export event_hash must be valid");
  if (eventHash !== expectedHash) {
    const error = new Error("export event_hash mismatch");
    error.code = "PHASE22_EXPORT_EVENT_HASH_MISMATCH";
    throw error;
  }
  return canonicalize({
    ...base,
    event_hash: eventHash
  });
}

function validateEvidenceEvent(eventInput = {}) {
  const event = asPlainObject(eventInput);
  if (safeString(event.schema_version) !== PHASE22_EVIDENCE_EVENT_SCHEMA) {
    const error = new Error(`evidence event schema_version must be ${PHASE22_EVIDENCE_EVENT_SCHEMA}`);
    error.code = "PHASE22_EVIDENCE_SCHEMA_INVALID";
    throw error;
  }
  const sequence = asInt(event.sequence, 0);
  if (sequence < 1) {
    const error = new Error("evidence event sequence must be >= 1");
    error.code = "PHASE22_EVIDENCE_SEQUENCE_INVALID";
    throw error;
  }
  const prevEventHash = validateSha(event.prev_event_hash, "PHASE22_EVIDENCE_PREV_HASH_INVALID", "evidence prev_event_hash must be valid");
  const base = canonicalize({
    ...buildEvidenceEventBase(event),
    sequence,
    prev_event_hash: prevEventHash
  });
  const expectedHash = computeEvidenceEventHash(base);
  const eventHash = validateSha(event.event_hash, "PHASE22_EVIDENCE_EVENT_HASH_INVALID", "evidence event_hash must be valid");
  if (eventHash !== expectedHash) {
    const error = new Error("evidence event_hash mismatch");
    error.code = "PHASE22_EVIDENCE_EVENT_HASH_MISMATCH";
    throw error;
  }
  return canonicalize({
    ...base,
    event_hash: eventHash
  });
}

function validateStoreShape(storeInput, schemaVersion, codePrefix) {
  const store = asPlainObject(storeInput);
  if (safeString(store.schema_version) !== schemaVersion) {
    const error = new Error(`store schema_version must be ${schemaVersion}`);
    error.code = `${codePrefix}_SCHEMA_INVALID`;
    throw error;
  }
  const nextSequence = asInt(store.next_sequence, -1);
  if (nextSequence < 0) {
    const error = new Error("next_sequence must be >= 0");
    error.code = `${codePrefix}_NEXT_SEQUENCE_INVALID`;
    throw error;
  }
  const chainHeadRaw = safeString(store.chain_head);
  const chainHead = chainHeadRaw
    ? validateSha(chainHeadRaw, `${codePrefix}_CHAIN_HEAD_INVALID`, "chain_head must be empty or sha256")
    : "";
  return canonicalize({
    schema_version: schemaVersion,
    next_sequence: nextSequence,
    chain_head: chainHead
  });
}

function verifyEventChain(eventsInput, validateEventFn, codePrefix, eventLabel) {
  const rawEvents = asArray(eventsInput);
  const events = [];
  let expectedSequence = 1;
  let prevHash = ZERO_HASH;

  for (const rawEvent of rawEvents) {
    const event = validateEventFn(rawEvent);
    if (event.sequence !== expectedSequence) {
      const error = new Error(`${eventLabel} sequences must be contiguous starting at 1`);
      error.code = `${codePrefix}_SEQUENCE_GAP`;
      throw error;
    }
    if (event.prev_event_hash !== prevHash) {
      const error = new Error(`${eventLabel} prev_event_hash mismatch at sequence ${event.sequence}`);
      error.code = `${codePrefix}_PREV_HASH_MISMATCH`;
      throw error;
    }
    prevHash = event.event_hash;
    expectedSequence += 1;
    events.push(event);
  }

  return canonicalize({
    events,
    chain_head: events.length > 0 ? events[events.length - 1].event_hash : "",
    next_sequence: events.length
  });
}

function createEmptyExportEventsStore() {
  return canonicalize({
    schema_version: PHASE22_EXPORT_EVENTS_SCHEMA,
    next_sequence: 0,
    chain_head: "",
    events: []
  });
}

function createEmptyEvidenceLedgerStore() {
  return canonicalize({
    schema_version: PHASE22_EVIDENCE_LEDGER_SCHEMA,
    next_sequence: 0,
    chain_head: "",
    events: []
  });
}

function validateExportEventsStore(storeInput = {}) {
  const shape = validateStoreShape(storeInput, PHASE22_EXPORT_EVENTS_SCHEMA, "PHASE22_EXPORT_STORE");
  const chain = verifyEventChain(asPlainObject(storeInput).events, validateExportEvent, "PHASE22_EXPORT_STORE", "export events");

  if (shape.chain_head !== chain.chain_head) {
    const error = new Error("export store chain_head mismatch");
    error.code = "PHASE22_EXPORT_STORE_CHAIN_HEAD_MISMATCH";
    throw error;
  }
  if (shape.next_sequence !== chain.next_sequence) {
    const error = new Error("export store next_sequence mismatch");
    error.code = "PHASE22_EXPORT_STORE_NEXT_SEQUENCE_MISMATCH";
    throw error;
  }

  return canonicalize({
    schema_version: PHASE22_EXPORT_EVENTS_SCHEMA,
    next_sequence: chain.next_sequence,
    chain_head: chain.chain_head,
    events: chain.events
  });
}

function validateEvidenceLedgerStore(storeInput = {}) {
  const shape = validateStoreShape(storeInput, PHASE22_EVIDENCE_LEDGER_SCHEMA, "PHASE22_EVIDENCE_STORE");
  const chain = verifyEventChain(asPlainObject(storeInput).events, validateEvidenceEvent, "PHASE22_EVIDENCE_STORE", "evidence events");

  if (shape.chain_head !== chain.chain_head) {
    const error = new Error("evidence store chain_head mismatch");
    error.code = "PHASE22_EVIDENCE_STORE_CHAIN_HEAD_MISMATCH";
    throw error;
  }
  if (shape.next_sequence !== chain.next_sequence) {
    const error = new Error("evidence store next_sequence mismatch");
    error.code = "PHASE22_EVIDENCE_STORE_NEXT_SEQUENCE_MISMATCH";
    throw error;
  }

  return canonicalize({
    schema_version: PHASE22_EVIDENCE_LEDGER_SCHEMA,
    next_sequence: chain.next_sequence,
    chain_head: chain.chain_head,
    events: chain.events
  });
}

function buildEvidenceIdempotencyComparable(input = {}) {
  const source = asPlainObject(input);
  const evidenceRefs = asArray(source.evidence_refs).map((entry) => {
    const item = asPlainObject(entry);
    return canonicalize({
      byte_size: asInt(item.byte_size, 0),
      file_type: safeString(item.file_type).toLowerCase(),
      original_filename: safeString(item.original_filename),
      sha256: validateSha(item.sha256, "PHASE22_EVIDENCE_REF_SHA_INVALID", "evidence_ref sha256 must be valid")
    });
  }).sort((left, right) => {
    if (left.original_filename !== right.original_filename) {
      return left.original_filename.localeCompare(right.original_filename);
    }
    if (left.sha256 !== right.sha256) {
      return left.sha256.localeCompare(right.sha256);
    }
    return left.file_type.localeCompare(right.file_type);
  });

  return canonicalize({
    event_type: safeString(source.event_type),
    offer_id: safeString(source.offer_id),
    platform_target: safeString(source.platform_target),
    operator_id: safeString(source.operator_id),
    state_transition: canonicalize(asPlainObject(source.state_transition)),
    approved_bundle_hash: safeString(source.approved_bundle_hash).toLowerCase(),
    external_ref: safeString(source.external_ref),
    notes: safeString(source.notes),
    evidence_refs: evidenceRefs
  });
}

module.exports = {
  ALLOWED_EVIDENCE_EXTENSIONS,
  DEFAULT_MAX_BYTES_PER_FILE,
  DEFAULT_MAX_EVENTS_PER_OFFER,
  DEFAULT_MAX_FILES_PER_EVENT,
  DEFAULT_MAX_TOTAL_BYTES_PER_OFFER,
  EVIDENCE_EVENT_TYPES,
  EXPORT_EVENT_TYPES,
  PHASE22_EVIDENCE_EVENT_SCHEMA,
  PHASE22_EVIDENCE_INDEX_SCHEMA,
  PHASE22_EVIDENCE_LEDGER_SCHEMA,
  PHASE22_EVIDENCE_SNAPSHOT_SCHEMA,
  PHASE22_EXPORT_EVENT_SCHEMA,
  PHASE22_EXPORT_EVENTS_SCHEMA,
  PHASE22_VERIFY_STATUS_SCHEMA,
  SUBMISSION_STATES,
  TERMINAL_SUBMISSION_STATES,
  ZERO_HASH,
  assertNonEmptyPayload,
  attachEvidenceEventHashes,
  attachExportEventHashes,
  buildEvidenceEventBase,
  buildEvidenceIdempotencyComparable,
  buildExportEventBase,
  computeEvidenceEventHash,
  computeExportEventHash,
  createEmptyEvidenceLedgerStore,
  createEmptyExportEventsStore,
  normalizeEvidenceRefs,
  normalizeEvidenceStoredPath,
  normalizeFileExtension,
  normalizeRelativePath,
  sortUnique,
  validateEvidenceEvent,
  validateEvidenceLedgerStore,
  validateExportEvent,
  validateExportEventsStore,
  validateSha
};
