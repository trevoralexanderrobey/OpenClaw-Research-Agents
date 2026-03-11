"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { nowIso } = require("../core/time-provider.js");
const { canonicalize, safeString } = require("../../workflows/governance-automation/common.js");
const {
  ALLOWED_EVIDENCE_EXTENSIONS,
  DEFAULT_MAX_BYTES_PER_FILE,
  DEFAULT_MAX_EVENTS_PER_OFFER,
  DEFAULT_MAX_FILES_PER_EVENT,
  DEFAULT_MAX_TOTAL_BYTES_PER_OFFER,
  EVIDENCE_EVENT_TYPES,
  PHASE22_EVIDENCE_INDEX_SCHEMA,
  PHASE22_EVIDENCE_SNAPSHOT_SCHEMA,
  PHASE22_VERIFY_STATUS_SCHEMA,
  attachEvidenceEventHashes,
  buildEvidenceEventBase,
  buildEvidenceIdempotencyComparable,
  buildExportEventBase,
  normalizeFileExtension,
  normalizeRelativePath,
  validateSha
} = require("./submission-evidence-schema.js");
const {
  ALLOWED_TRANSITIONS,
  READY_FOR_MANUAL_SUBMISSION,
  assertValidTransition,
  deriveCurrentStateForTarget,
  deriveStatesForTargets,
  getExportCoverageForTarget,
  isTerminalState
} = require("./manual-fulfillment-state-machine.js");
const { createSubmissionEvidenceLedger } = require("./submission-evidence-ledger.js");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortByStoredPath(refs) {
  return refs.slice().sort((left, right) => left.stored_path.localeCompare(right.stored_path));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fsyncFilePath(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirPath(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!error || (error.code !== "EINVAL" && error.code !== "EPERM" && error.code !== "ENOTSUP")) {
      throw error;
    }
  } finally {
    if (typeof fd === "number") {
      fs.closeSync(fd);
    }
  }
}

function ensurePathInside(baseDir, candidatePath, code) {
  const rel = path.relative(baseDir, candidatePath);
  if (!rel || rel === ".") {
    return;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const error = new Error(`path '${candidatePath}' escapes base '${baseDir}'`);
    error.code = code;
    throw error;
  }
}

function parseEvidenceFiles(value) {
  return asArray(value)
    .map((entry) => safeString(entry))
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

async function hashFileMetadata(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    const error = new Error(`evidence file is not a regular file: ${filePath}`);
    error.code = "PHASE22_EVIDENCE_FILE_TYPE_INVALID";
    throw error;
  }
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
    byteSize += chunk.length;
  }
  return {
    sha256: hash.digest("hex"),
    byte_size: byteSize
  };
}

async function copyFileWithHash(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  const hasher = new Transform({
    transform(chunk, enc, callback) {
      hash.update(chunk);
      byteSize += chunk.length;
      callback(null, chunk);
    }
  });
  await pipeline(
    fs.createReadStream(sourcePath),
    hasher,
    fs.createWriteStream(targetPath, { flags: "wx" })
  );
  fsyncFilePath(targetPath);
  fsyncDirPath(path.dirname(targetPath));
  return {
    sha256: hash.digest("hex"),
    byte_size: byteSize
  };
}

function computeDirectoryHash(directoryPath) {
  const files = [];
  const stack = [directoryPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const rel = path.relative(directoryPath, fullPath).split(path.sep).join("/");
      const hash = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
      files.push(canonicalize({
        file: rel,
        sha256: hash
      }));
    }
  }
  files.sort((left, right) => left.file.localeCompare(right.file));
  return crypto.createHash("sha256").update(`phase22-export-folder-v1|${JSON.stringify(canonicalize(files))}`).digest("hex");
}

function findEventByIdempotency(events, idempotencyKey) {
  const target = safeString(idempotencyKey);
  return asArray(events).find((event) => safeString(event.idempotency_key) === target) || null;
}

function compareIdempotencyPayload(existingComparable, incomingComparable) {
  return JSON.stringify(canonicalize(existingComparable)) === JSON.stringify(canonicalize(incomingComparable));
}

function summarizeEvidenceBytes(events) {
  let totalBytes = 0;
  for (const event of asArray(events)) {
    for (const ref of asArray(event && event.evidence_refs)) {
      totalBytes += Math.max(0, Number(ref.byte_size || 0));
    }
  }
  return totalBytes;
}

function buildExistingComparable(event) {
  return buildEvidenceIdempotencyComparable({
    event_type: safeString(event.event_type),
    offer_id: safeString(event.offer_id),
    platform_target: safeString(event.platform_target),
    operator_id: safeString(event.operator_id),
    state_transition: {
      to: safeString(event.state_transition && event.state_transition.to)
    },
    approved_bundle_hash: safeString(event.approved_bundle_hash),
    external_ref: safeString(event.external_ref),
    notes: safeString(event.notes),
    evidence_refs: asArray(event.evidence_refs).map((ref) => ({
      byte_size: Number(ref.byte_size || 0),
      file_type: safeString(ref.file_type),
      original_filename: safeString(ref.original_filename),
      sha256: safeString(ref.sha256)
    }))
  });
}

function createSubmissionEvidenceManager(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const releaseApprovalManager = options.releaseApprovalManager;
  if (!releaseApprovalManager || typeof releaseApprovalManager.validateApprovedRelease !== "function") {
    const error = new Error("submission evidence manager requires releaseApprovalManager.validateApprovedRelease");
    error.code = "PHASE22_APPROVAL_MANAGER_REQUIRED";
    throw error;
  }

  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso };

  const quotas = canonicalize({
    max_bytes_per_file: Math.max(1, Number(options.maxBytesPerFile || options.max_bytes_per_file || DEFAULT_MAX_BYTES_PER_FILE)),
    max_files_per_event: Math.max(1, Number(options.maxFilesPerEvent || options.max_files_per_event || DEFAULT_MAX_FILES_PER_EVENT)),
    max_total_evidence_bytes_per_offer: Math.max(1, Number(options.maxTotalEvidenceBytesPerOffer || options.max_total_evidence_bytes_per_offer || DEFAULT_MAX_TOTAL_BYTES_PER_OFFER)),
    max_total_evidence_events_per_offer: Math.max(1, Number(options.maxTotalEvidenceEventsPerOffer || options.max_total_evidence_events_per_offer || DEFAULT_MAX_EVENTS_PER_OFFER))
  });

  const ledger = createSubmissionEvidenceLedger({
    rootDir,
    releasesDir: options.releasesDir,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollMs: options.lockPollMs
  });

  function resolveApprovalContext(offerId) {
    const validated = releaseApprovalManager.validateApprovedRelease(offerId);
    const approval = asPlainObject(validated.approval);
    const approvedBundleHash = validateSha(
      approval.hash_of_release_bundle,
      "PHASE22_APPROVED_BUNDLE_HASH_INVALID",
      "release-approval hash_of_release_bundle must be valid"
    );
    const approvedTargets = asArray(approval.approved_platform_targets)
      .map((entry) => safeString(entry))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    return {
      validated,
      approval,
      approved_bundle_hash: approvedBundleHash,
      approved_platform_targets: approvedTargets,
      offer_id: safeString(approval.offer_id) || safeString(offerId)
    };
  }

  function ensureApprovedTarget(approvedTargets, platformTarget) {
    const target = safeString(platformTarget);
    if (!approvedTargets.includes(target)) {
      const error = new Error(`platform_target '${target}' is not approved for this bundle`);
      error.code = "PHASE22_PLATFORM_TARGET_NOT_APPROVED";
      throw error;
    }
    return target;
  }

  function ensureExportCoverage(exportStore, target, approvedBundleHash) {
    const coverage = getExportCoverageForTarget(exportStore, target)
      .filter((event) => safeString(event.approved_bundle_hash) === approvedBundleHash);
    if (coverage.length < 1) {
      const error = new Error(`platform_target '${target}' is not export-eligible`);
      error.code = "PHASE22_EXPORT_ELIGIBILITY_REQUIRED";
      throw error;
    }
    return coverage;
  }

  async function collectIncomingEvidenceMeta(files) {
    const collected = [];
    for (const filePath of files) {
      const absPath = path.resolve(filePath);
      const originalFileName = path.basename(absPath);
      const extension = normalizeFileExtension(originalFileName);
      if (!ALLOWED_EVIDENCE_EXTENSIONS.includes(extension)) {
        const error = new Error(`unsupported evidence file extension '${extension || "(none)"}'`);
        error.code = "PHASE22_EVIDENCE_FILE_EXTENSION_INVALID";
        throw error;
      }
      const digest = await hashFileMetadata(absPath);
      collected.push(canonicalize({
        source_path: absPath,
        original_filename: originalFileName,
        file_type: extension,
        sha256: digest.sha256,
        byte_size: digest.byte_size
      }));
    }
    return collected.sort((left, right) => left.source_path.localeCompare(right.source_path));
  }

function ensureEventPayloadNotEmpty(incomingEvidenceRefs, externalRef, notes) {
  if (incomingEvidenceRefs.length < 1 && !safeString(externalRef) && !safeString(notes)) {
    const error = new Error("submission outcome requires at least one payload element: evidence files, external_ref, or notes");
    error.code = "PHASE22_EVIDENCE_PAYLOAD_EMPTY";
    throw error;
  }
}

  function ensureAttachmentQuotas(incomingEvidenceRefs) {
    if (incomingEvidenceRefs.length > quotas.max_files_per_event) {
      const error = new Error(`evidence file count exceeds limit (${quotas.max_files_per_event})`);
      error.code = "PHASE22_EVENT_FILE_COUNT_EXCEEDED";
      throw error;
    }
    for (const ref of incomingEvidenceRefs) {
      if (Number(ref.byte_size || 0) > quotas.max_bytes_per_file) {
        const error = new Error(`evidence file '${ref.original_filename}' exceeds max size`);
        error.code = "PHASE22_FILE_SIZE_EXCEEDED";
        throw error;
      }
    }
  }

  function buildIncomingComparable(input = {}) {
    const source = asPlainObject(input);
    return buildEvidenceIdempotencyComparable({
      event_type: source.event_type,
      offer_id: source.offer_id,
      platform_target: source.platform_target,
      operator_id: source.operator_id,
      state_transition: {
        to: source.outcome_state
      },
      approved_bundle_hash: source.approved_bundle_hash,
      external_ref: source.external_ref,
      notes: source.notes,
      evidence_refs: source.evidence_refs
    });
  }

  async function stageAttachments(input = {}) {
    const source = asPlainObject(input);
    const offerDir = safeString(source.offer_dir);
    const evidenceDir = safeString(source.evidence_dir);
    const sequence = Number(source.sequence || 0);
    const platformTarget = safeString(source.platform_target);
    const incomingRefs = asArray(source.incoming_refs);

    ensureDir(evidenceDir);
    ensurePathInside(offerDir, evidenceDir, "PHASE22_EVIDENCE_PATH_ESCAPE");

    const created = [];
    const staged = [];

    try {
      for (let index = 0; index < incomingRefs.length; index += 1) {
        const ref = incomingRefs[index];
        const ordinal = index + 1;
        const fileName = `${sequence}-${ordinal}-${safeString(ref.sha256).slice(0, 16)}${safeString(ref.file_type)}`;
        const storedPath = ledger.buildStoredEvidencePath(platformTarget, fileName);
        const absoluteTarget = path.join(offerDir, normalizeRelativePath(storedPath).split("/").join(path.sep));
        ensurePathInside(offerDir, absoluteTarget, "PHASE22_EVIDENCE_PATH_ESCAPE");

        const copied = await copyFileWithHash(ref.source_path, absoluteTarget);
        if (copied.sha256 !== ref.sha256 || copied.byte_size !== Number(ref.byte_size || 0)) {
          const error = new Error(`evidence file changed during staging: ${ref.original_filename}`);
          error.code = "PHASE22_EVIDENCE_STAGING_HASH_MISMATCH";
          throw error;
        }

        created.push(absoluteTarget);
        staged.push(canonicalize({
          stored_path: storedPath,
          original_filename: ref.original_filename,
          sha256: ref.sha256,
          byte_size: Number(ref.byte_size || 0),
          file_type: ref.file_type
        }));
      }
    } catch (error) {
      for (const filePath of created) {
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkError) {
          if (!unlinkError || unlinkError.code !== "ENOENT") {
            throw unlinkError;
          }
        }
      }
      if (error && !error.code) {
        error.code = "PHASE22_ATTACHMENT_STAGING_FAILED";
      }
      throw error;
    }

    return sortByStoredPath(staged);
  }

  async function recordExportEvent(input = {}) {
    const source = asPlainObject(input);
    const offerId = safeString(source.offer_id || source.offerId);
    const operatorId = safeString(source.operator_id || source.operatorId || "operator-cli");
    const exportFormat = safeString(source.export_format || source.exportFormat || "folder");

    const approvalContext = resolveApprovalContext(offerId);
    const exportedTargets = asArray(source.exported_platform_targets || source.exportedPlatformTargets)
      .map((entry) => safeString(entry))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));

    if (exportedTargets.length < 1) {
      const error = new Error("exported_platform_targets is required");
      error.code = "PHASE22_EXPORT_TARGETS_REQUIRED";
      throw error;
    }

    for (const target of exportedTargets) {
      ensureApprovedTarget(approvalContext.approved_platform_targets, target);
    }

    const eventBase = buildExportEventBase({
      schema_version: "phase22-export-event-v1",
      event_type: "bundle_exported",
      offer_id: offerId,
      approved_bundle_hash: approvalContext.approved_bundle_hash,
      exported_at: safeString(source.exported_at || source.exportedAt || timeProvider.nowIso()),
      export_format: exportFormat,
      operator_id: operatorId,
      exported_platform_targets: exportedTargets,
      export_artifact_refs: source.export_artifact_refs || source.exportArtifactRefs || []
    });

    const appended = await ledger.appendExportEvent(offerId, eventBase);
    await ledger.withOfferLock(offerId, async () => {
      const evidenceStorePath = ledger.getEvidenceLedgerPath(offerId);
      if (!fs.existsSync(evidenceStorePath)) {
        const emptyEvidenceStore = ledger.readEvidenceLedgerStore(offerId);
        ledger.writeEvidenceLedgerStore(offerId, emptyEvidenceStore);
      }
    });
    await rebuildDerivedForOffer(offerId);

    return canonicalize({
      ok: true,
      event: appended.event,
      export_store_chain_head: appended.next_store.chain_head
    });
  }

  async function recordSubmissionOutcome(input = {}) {
    const source = asPlainObject(input);
    const offerId = safeString(source.offer_id || source.offerId);
    const operatorId = safeString(source.operator_id || source.operatorId);
    const platformTarget = safeString(source.platform_target || source.platformTarget);
    const outcomeState = safeString(source.outcome_state || source.outcomeState);
    const idempotencyKey = safeString(source.idempotency_key || source.idempotencyKey);
    const externalRef = safeString(source.external_ref || source.externalRef);
    const notes = safeString(source.notes);
    const evidenceFiles = parseEvidenceFiles(source.evidence_files || source.evidenceFiles);
    const eventType = safeString(source.event_type || source.eventType || "submission_outcome_recorded");

    if (!offerId) {
      const error = new Error("offer_id is required");
      error.code = "PHASE22_OFFER_ID_REQUIRED";
      throw error;
    }
    if (!operatorId) {
      const error = new Error("operator_id is required");
      error.code = "PHASE22_OPERATOR_ID_REQUIRED";
      throw error;
    }
    if (!platformTarget) {
      const error = new Error("platform_target is required");
      error.code = "PHASE22_PLATFORM_TARGET_REQUIRED";
      throw error;
    }
    if (!outcomeState) {
      const error = new Error("outcome_state is required");
      error.code = "PHASE22_OUTCOME_STATE_REQUIRED";
      throw error;
    }
    if (!idempotencyKey) {
      const error = new Error("idempotency_key is required");
      error.code = "PHASE22_IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }
    if (!EVIDENCE_EVENT_TYPES.includes(eventType)) {
      const error = new Error(`event_type '${eventType}' is invalid`);
      error.code = "PHASE22_EVIDENCE_EVENT_TYPE_INVALID";
      throw error;
    }

    const incomingEvidenceRefs = await collectIncomingEvidenceMeta(evidenceFiles);
    ensureAttachmentQuotas(incomingEvidenceRefs);
    ensureEventPayloadNotEmpty(incomingEvidenceRefs, externalRef, notes);

    const approvalContext = resolveApprovalContext(offerId);
    ensureApprovedTarget(approvalContext.approved_platform_targets, platformTarget);

    const comparableInput = buildIncomingComparable({
      event_type: eventType,
      offer_id: offerId,
      platform_target: platformTarget,
      operator_id: operatorId,
      outcome_state: outcomeState,
      approved_bundle_hash: approvalContext.approved_bundle_hash,
      external_ref: externalRef,
      notes,
      evidence_refs: incomingEvidenceRefs
    });

    return ledger.withOfferLock(offerId, async () => {
      const exportStore = ledger.readExportEventsStore(offerId);
      const evidenceStore = ledger.readEvidenceLedgerStore(offerId);

      ensureExportCoverage(exportStore, platformTarget, approvalContext.approved_bundle_hash);

      const current = deriveCurrentStateForTarget({
        platform_target: platformTarget,
        export_events_store: exportStore,
        evidence_ledger_store: evidenceStore
      });

      const existing = findEventByIdempotency(evidenceStore.events, idempotencyKey);
      if (existing) {
        const existingComparable = buildExistingComparable(existing);
        if (!compareIdempotencyPayload(existingComparable, comparableInput)) {
          const error = new Error("idempotency_key was reused with a different payload");
          error.code = "PHASE22_IDEMPOTENCY_CONFLICT";
          throw error;
        }
        return canonicalize({
          ok: true,
          idempotent: true,
          event: existing,
          current_state: current.current_state
        });
      }

      const fromState = current.current_state || READY_FOR_MANUAL_SUBMISSION;
      assertValidTransition(fromState, outcomeState);

      if (evidenceStore.events.length >= quotas.max_total_evidence_events_per_offer) {
        const error = new Error("evidence event quota exceeded for offer");
        error.code = "PHASE22_OFFER_EVENT_QUOTA_EXCEEDED";
        throw error;
      }

      const existingEvidenceBytes = summarizeEvidenceBytes(evidenceStore.events);
      const incomingBytes = incomingEvidenceRefs.reduce((sum, ref) => sum + Number(ref.byte_size || 0), 0);
      if (existingEvidenceBytes + incomingBytes > quotas.max_total_evidence_bytes_per_offer) {
        const error = new Error("cumulative evidence byte quota exceeded for offer");
        error.code = "PHASE22_OFFER_EVIDENCE_BYTES_QUOTA_EXCEEDED";
        throw error;
      }

      const nextSequence = Number(evidenceStore.next_sequence || 0) + 1;
      const offerDir = ledger.getOfferDir(offerId);
      const evidenceDir = ledger.getPlatformEvidenceDirPath(offerId, platformTarget);

      const stagedEvidenceRefs = await stageAttachments({
        offer_dir: offerDir,
        evidence_dir: evidenceDir,
        sequence: nextSequence,
        platform_target: platformTarget,
        incoming_refs: incomingEvidenceRefs
      });

      const baseEvent = buildEvidenceEventBase({
        schema_version: "phase22-submission-evidence-event-v1",
        recorded_at: safeString(source.recorded_at || source.recordedAt || timeProvider.nowIso()),
        event_type: eventType,
        offer_id: offerId,
        platform_target: platformTarget,
        operator_id: operatorId,
        state_transition: {
          from: fromState,
          to: outcomeState
        },
        approved_bundle_hash: approvalContext.approved_bundle_hash,
        external_ref: externalRef,
        notes,
        evidence_refs: stagedEvidenceRefs,
        idempotency_key: idempotencyKey
      });

      const prevHash = safeString(evidenceStore.chain_head) || "0".repeat(64);
      const event = attachEvidenceEventHashes(baseEvent, nextSequence, prevHash);
      const nextStore = canonicalize({
        schema_version: evidenceStore.schema_version,
        next_sequence: nextSequence,
        chain_head: event.event_hash,
        events: evidenceStore.events.concat([event])
      });

      ledger.writeEvidenceLedgerStore(offerId, nextStore);
      await rebuildDerivedForOffer(offerId);

      return canonicalize({
        ok: true,
        idempotent: false,
        event,
        current_state: fromState,
        next_state: outcomeState
      });
    });
  }

  async function verifyOfferEvidence(input = {}) {
    const source = asPlainObject(input);
    const offerId = safeString(source.offer_id || source.offerId);
    const mode = safeString(source.mode || "full") || "full";
    const rebuildDerived = source.rebuild_derived === true || source.rebuildDerived === true;

    if (!offerId) {
      const error = new Error("offer_id is required");
      error.code = "PHASE22_OFFER_ID_REQUIRED";
      throw error;
    }

    const approvalContext = resolveApprovalContext(offerId);
    const exportStore = ledger.readExportEventsStore(offerId);
    const evidenceStore = ledger.readEvidenceLedgerStore(offerId);

    const verifyStatusPath = ledger.getVerifyStatusPath(offerId);
    const priorStatus = asPlainObject((() => {
      try {
        return JSON.parse(fs.readFileSync(verifyStatusPath, "utf8"));
      } catch (error) {
        if (error && error.code === "ENOENT") {
          return {};
        }
        throw error;
      }
    })());

    if (
      mode === "incremental"
      && safeString(priorStatus.schema_version) === PHASE22_VERIFY_STATUS_SCHEMA
      && Number(priorStatus.last_verified_sequence || 0) === Number(evidenceStore.next_sequence || 0)
      && safeString(priorStatus.evidence_chain_head) === safeString(evidenceStore.chain_head)
      && safeString(priorStatus.export_chain_head) === safeString(exportStore.chain_head)
    ) {
      return canonicalize({
        ok: true,
        mode,
        offer_id: offerId,
        skipped: true,
        reason: "no_new_events",
        last_verified_sequence: Number(priorStatus.last_verified_sequence || 0)
      });
    }

    for (const event of exportStore.events) {
      if (safeString(event.offer_id) !== offerId) {
        const error = new Error("export event offer_id mismatch");
        error.code = "PHASE22_EXPORT_EVENT_OFFER_MISMATCH";
        throw error;
      }
      if (safeString(event.approved_bundle_hash) !== approvalContext.approved_bundle_hash) {
        const error = new Error("export event approved_bundle_hash does not match release approval");
        error.code = "PHASE22_EXPORT_EVENT_APPROVED_HASH_MISMATCH";
        throw error;
      }
      for (const target of asArray(event.exported_platform_targets)) {
        ensureApprovedTarget(approvalContext.approved_platform_targets, target);
      }
    }

    for (const event of evidenceStore.events) {
      if (safeString(event.offer_id) !== offerId) {
        const error = new Error("evidence event offer_id mismatch");
        error.code = "PHASE22_EVIDENCE_EVENT_OFFER_MISMATCH";
        throw error;
      }
      if (safeString(event.approved_bundle_hash) !== approvalContext.approved_bundle_hash) {
        const error = new Error("evidence event approved_bundle_hash does not match release approval");
        error.code = "PHASE22_EVIDENCE_EVENT_APPROVED_HASH_MISMATCH";
        throw error;
      }
      ensureApprovedTarget(approvalContext.approved_platform_targets, event.platform_target);
      ensureExportCoverage(exportStore, event.platform_target, approvalContext.approved_bundle_hash);
    }

    for (const target of approvalContext.approved_platform_targets) {
      deriveCurrentStateForTarget({
        platform_target: target,
        export_events_store: exportStore,
        evidence_ledger_store: evidenceStore
      });
    }

    const offerDir = ledger.getOfferDir(offerId);
    for (const event of evidenceStore.events) {
      for (const ref of asArray(event.evidence_refs)) {
        const normalizedStoredPath = normalizeRelativePath(ref.stored_path, "PHASE22_EVIDENCE_REF_STORED_PATH_INVALID");
        const absolutePath = path.join(offerDir, normalizedStoredPath.split("/").join(path.sep));
        ensurePathInside(offerDir, absolutePath, "PHASE22_EVIDENCE_PATH_ESCAPE");
        if (!fs.existsSync(absolutePath)) {
          const error = new Error(`referenced evidence attachment is missing: ${normalizedStoredPath}`);
          error.code = "PHASE22_EVIDENCE_REF_MISSING";
          throw error;
        }
        const digest = await hashFileMetadata(absolutePath);
        if (safeString(ref.sha256) !== digest.sha256 || Number(ref.byte_size || 0) !== digest.byte_size) {
          const error = new Error(`referenced evidence attachment digest mismatch: ${normalizedStoredPath}`);
          error.code = "PHASE22_EVIDENCE_REF_HASH_MISMATCH";
          throw error;
        }
      }
    }

    const status = canonicalize({
      schema_version: PHASE22_VERIFY_STATUS_SCHEMA,
      verified_at: timeProvider.nowIso(),
      mode,
      offer_id: offerId,
      last_verified_sequence: Number(evidenceStore.next_sequence || 0),
      evidence_chain_head: safeString(evidenceStore.chain_head),
      export_chain_head: safeString(exportStore.chain_head)
    });
    ledger.writeDerivedJson(verifyStatusPath, status);

    if (rebuildDerived) {
      await rebuildDerivedForOffer(offerId);
    }

    return canonicalize({
      ok: true,
      mode,
      offer_id: offerId,
      skipped: false,
      export_event_count: exportStore.events.length,
      evidence_event_count: evidenceStore.events.length,
      evidence_chain_head: evidenceStore.chain_head,
      export_chain_head: exportStore.chain_head
    });
  }

  async function rebuildDerivedForOffer(offerId) {
    const context = resolveApprovalContext(offerId);
    const exportStore = ledger.readExportEventsStore(offerId);
    const evidenceStore = ledger.readEvidenceLedgerStore(offerId);

    const states = deriveStatesForTargets({
      platform_targets: context.approved_platform_targets,
      export_events_store: exportStore,
      evidence_ledger_store: evidenceStore
    });

    const snapshots = [];
    for (const state of states) {
      const platformTarget = safeString(state.platform_target);
      const snapshot = canonicalize({
        schema_version: PHASE22_EVIDENCE_SNAPSHOT_SCHEMA,
        generated_at: timeProvider.nowIso(),
        offer_id: offerId,
        platform_target: platformTarget,
        approved_bundle_hash: context.approved_bundle_hash,
        eligible_for_recording: state.eligible === true,
        current_state: state.eligible === true ? safeString(state.current_state || READY_FOR_MANUAL_SUBMISSION) : "",
        initialized_by_export_sequence: Number(state.initialized_by_export_sequence || 0),
        initialized_by_export_hash: safeString(state.initialized_by_export_hash),
        latest_sequence: Number(state.latest_sequence || 0),
        latest_event_hash: safeString(state.latest_event_hash),
        evidence_event_count: Number(state.evidence_event_count || 0),
        authoritative_sources: canonicalize({
          export_events: "submission-evidence/export-events.json",
          evidence_ledger: "submission-evidence/ledger.json"
        })
      });
      const snapshotPath = ledger.getPlatformSnapshotPath(offerId, platformTarget);
      ledger.writeDerivedJson(snapshotPath, snapshot);
      snapshots.push(snapshot);
    }

    await rebuildRepoIndex();

    return canonicalize({
      ok: true,
      offer_id: offerId,
      snapshots
    });
  }

  async function rebuildRepoIndex() {
    const offerIds = await ledger.listOfferIds();
    const offers = [];

    for (const offerId of offerIds) {
      const approvalPath = path.join(ledger.getOfferDir(offerId), "release-approval.json");
      let approval;
      try {
        approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
      } catch {
        continue;
      }

      const approvedBundleHash = safeString(approval.hash_of_release_bundle);
      const approvedTargets = asArray(approval.approved_platform_targets)
        .map((entry) => safeString(entry))
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));

      const exportStore = ledger.readExportEventsStore(offerId);
      const evidenceStore = ledger.readEvidenceLedgerStore(offerId);
      const states = deriveStatesForTargets({
        platform_targets: approvedTargets,
        export_events_store: exportStore,
        evidence_ledger_store: evidenceStore
      });

      offers.push(canonicalize({
        offer_id: offerId,
        approved_bundle_hash: approvedBundleHash,
        export_event_count: exportStore.events.length,
        export_chain_head: safeString(exportStore.chain_head),
        evidence_event_count: evidenceStore.events.length,
        evidence_chain_head: safeString(evidenceStore.chain_head),
        platform_targets: states.map((state) => canonicalize({
          platform_target: state.platform_target,
          eligible_for_recording: state.eligible === true,
          current_state: state.eligible === true ? safeString(state.current_state || READY_FOR_MANUAL_SUBMISSION) : "",
          latest_sequence: Number(state.latest_sequence || 0),
          latest_event_hash: safeString(state.latest_event_hash)
        }))
      }));
    }

    offers.sort((left, right) => left.offer_id.localeCompare(right.offer_id));
    for (const offer of offers) {
      offer.platform_targets.sort((left, right) => left.platform_target.localeCompare(right.platform_target));
    }

    const indexBody = canonicalize({
      schema_version: PHASE22_EVIDENCE_INDEX_SCHEMA,
      generated_at: timeProvider.nowIso(),
      authoritative_source: "workspace/releases/<offerId>/submission-evidence/export-events.json + ledger.json",
      offers
    });

    ledger.writeDerivedJson(ledger.getRepoIndexPath(), indexBody);
    return indexBody;
  }

  async function verifyAllOffers(input = {}) {
    const source = asPlainObject(input);
    const mode = safeString(source.mode || "full") || "full";
    const rebuildDerived = source.rebuild_derived === true || source.rebuildDerived === true;
    const offerIds = await ledger.listOfferIds();
    const results = [];

    for (const offerId of offerIds) {
      results.push(await verifyOfferEvidence({
        offer_id: offerId,
        mode,
        rebuild_derived: rebuildDerived
      }));
    }

    if (rebuildDerived) {
      await rebuildRepoIndex();
    }

    return canonicalize({
      ok: true,
      mode,
      verified_offers: results.length,
      results
    });
  }

  async function buildExportArtifactRef(input = {}) {
    const source = asPlainObject(input);
    const exportPath = path.resolve(safeString(source.export_path || source.exportPath));
    if (!exportPath || !fs.existsSync(exportPath)) {
      const error = new Error("export path does not exist");
      error.code = "PHASE22_EXPORT_ARTIFACT_MISSING";
      throw error;
    }
    const relPath = path.relative(rootDir, exportPath).split(path.sep).join("/");
    if (!relPath || relPath.startsWith("..")) {
      const error = new Error("export artifact path must be inside repository root");
      error.code = "PHASE22_EXPORT_ARTIFACT_PATH_INVALID";
      throw error;
    }

    const stat = fs.statSync(exportPath);
    if (stat.isDirectory()) {
      return canonicalize({
        path: relPath,
        file_type: "folder",
        byte_size: 0,
        sha256: computeDirectoryHash(exportPath)
      });
    }

    const digest = await hashFileMetadata(exportPath);
    return canonicalize({
      path: relPath,
      file_type: normalizeFileExtension(exportPath) || "file",
      byte_size: digest.byte_size,
      sha256: digest.sha256
    });
  }

  return Object.freeze({
    ALLOWED_TRANSITIONS,
    ledger,
    quotas,
    buildExportArtifactRef,
    rebuildDerivedForOffer,
    rebuildRepoIndex,
    recordExportEvent,
    recordSubmissionOutcome,
    resolveApprovalContext,
    verifyAllOffers,
    verifyOfferEvidence
  });
}

module.exports = {
  createSubmissionEvidenceManager,
  computeDirectoryHash
};
