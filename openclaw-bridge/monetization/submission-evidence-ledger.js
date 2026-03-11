"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { canonicalize, canonicalJson, safeString } = require("../../workflows/governance-automation/common.js");
const {
  attachEvidenceEventHashes,
  attachExportEventHashes,
  createEmptyEvidenceLedgerStore,
  createEmptyExportEventsStore,
  normalizeRelativePath,
  validateEvidenceLedgerStore,
  validateExportEventsStore
} = require("./submission-evidence-schema.js");

let tempNonceCounter = 0;

function normalizeOfferId(value) {
  const normalized = safeString(value);
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    const error = new Error("offer_id must match [A-Za-z0-9._-]+");
    error.code = "PHASE22_OFFER_ID_INVALID";
    throw error;
  }
  return normalized;
}

function normalizePlatformTarget(value) {
  const normalized = safeString(value);
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    const error = new Error("platform_target must match [A-Za-z0-9._-]+");
    error.code = "PHASE22_PLATFORM_TARGET_INVALID";
    throw error;
  }
  return normalized;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
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

function writeCanonicalJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  tempNonceCounter += 1;
  const tmpPath = `${filePath}.tmp-${process.pid}-${tempNonceCounter}`;
  const body = canonicalJson(canonicalize(value));
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  fsyncFilePath(filePath);
  fsyncDirPath(path.dirname(filePath));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath, options = {}) {
  const timeoutMs = Math.max(100, Number(options.timeout_ms || options.timeoutMs || 10000));
  const pollMs = Math.max(10, Number(options.poll_ms || options.pollMs || 25));
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  const startedAtNs = process.hrtime.bigint();

  while (true) {
    try {
      ensureDir(path.dirname(lockPath));
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, `${process.pid}\nlock-acquired\n`, "utf8");
      fs.fsyncSync(fd);
      return fd;
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
      if (process.hrtime.bigint() - startedAtNs >= timeoutNs) {
        const timeoutError = new Error(`timed out waiting for lock '${lockPath}'`);
        timeoutError.code = "PHASE22_LOCK_TIMEOUT";
        throw timeoutError;
      }
      await sleep(pollMs);
    }
  }
}

function releaseLock(lockPath, fd) {
  try {
    if (typeof fd === "number") {
      fs.closeSync(fd);
    }
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function createSubmissionEvidenceLedger(options = {}) {
  const rootDir = path.resolve(safeString(options.rootDir) || process.cwd());
  const releasesDir = path.resolve(safeString(options.releasesDir) || path.join(rootDir, "workspace", "releases"));
  const lockTimeoutMs = Math.max(100, Number(options.lockTimeoutMs || options.lock_timeout_ms || 10000));
  const lockPollMs = Math.max(10, Number(options.lockPollMs || options.lock_poll_ms || 25));

  function getOfferDir(offerId) {
    return path.join(releasesDir, normalizeOfferId(offerId));
  }

  function getSubmissionEvidenceRoot(offerId) {
    return path.join(getOfferDir(offerId), "submission-evidence");
  }

  function getExportEventsPath(offerId) {
    return path.join(getSubmissionEvidenceRoot(offerId), "export-events.json");
  }

  function getEvidenceLedgerPath(offerId) {
    return path.join(getSubmissionEvidenceRoot(offerId), "ledger.json");
  }

  function getPlatformRootPath(offerId, platformTarget) {
    return path.join(getSubmissionEvidenceRoot(offerId), normalizePlatformTarget(platformTarget));
  }

  function getPlatformEvidenceDirPath(offerId, platformTarget) {
    return path.join(getPlatformRootPath(offerId, platformTarget), "evidence");
  }

  function getPlatformSnapshotPath(offerId, platformTarget) {
    return path.join(getPlatformRootPath(offerId, platformTarget), "submission-evidence.json");
  }

  function getVerifyStatusPath(offerId) {
    return path.join(getSubmissionEvidenceRoot(offerId), "verify-status.json");
  }

  function getOfferLockPath(offerId) {
    return path.join(getSubmissionEvidenceRoot(offerId), ".phase22.lock");
  }

  function getRepoIndexPath() {
    return path.join(releasesDir, "index", "submission-evidence-index.json");
  }

  async function withOfferLock(offerId, fn) {
    const normalizedOfferId = normalizeOfferId(offerId);
    const evidenceRoot = getSubmissionEvidenceRoot(normalizedOfferId);
    ensureDir(evidenceRoot);
    const lockPath = getOfferLockPath(normalizedOfferId);
    const lockFd = await acquireLock(lockPath, {
      timeoutMs: lockTimeoutMs,
      pollMs: lockPollMs
    });
    try {
      return await fn();
    } finally {
      releaseLock(lockPath, lockFd);
    }
  }

  function readExportEventsStore(offerId) {
    const storePath = getExportEventsPath(offerId);
    const raw = readJsonIfExists(storePath, createEmptyExportEventsStore());
    return validateExportEventsStore(raw);
  }

  function readEvidenceLedgerStore(offerId) {
    const storePath = getEvidenceLedgerPath(offerId);
    const raw = readJsonIfExists(storePath, createEmptyEvidenceLedgerStore());
    return validateEvidenceLedgerStore(raw);
  }

  function writeExportEventsStore(offerId, store) {
    const normalized = validateExportEventsStore(store);
    writeCanonicalJsonAtomic(getExportEventsPath(offerId), normalized);
    return normalized;
  }

  function writeEvidenceLedgerStore(offerId, store) {
    const normalized = validateEvidenceLedgerStore(store);
    writeCanonicalJsonAtomic(getEvidenceLedgerPath(offerId), normalized);
    return normalized;
  }

  async function appendExportEvent(offerId, baseEvent) {
    return withOfferLock(offerId, async () => {
      const store = readExportEventsStore(offerId);
      const sequence = Number(store.next_sequence || 0) + 1;
      const prevHash = store.chain_head || "0".repeat(64);
      const event = attachExportEventHashes(baseEvent, sequence, prevHash);
      const nextStore = canonicalize({
        schema_version: store.schema_version,
        next_sequence: sequence,
        chain_head: event.event_hash,
        events: store.events.concat([event])
      });
      writeExportEventsStore(offerId, nextStore);
      return canonicalize({
        event,
        next_store: nextStore
      });
    });
  }

  async function appendEvidenceEvent(offerId, baseEvent) {
    return withOfferLock(offerId, async () => {
      const store = readEvidenceLedgerStore(offerId);
      const sequence = Number(store.next_sequence || 0) + 1;
      const prevHash = store.chain_head || "0".repeat(64);
      const event = attachEvidenceEventHashes(baseEvent, sequence, prevHash);
      const nextStore = canonicalize({
        schema_version: store.schema_version,
        next_sequence: sequence,
        chain_head: event.event_hash,
        events: store.events.concat([event])
      });
      writeEvidenceLedgerStore(offerId, nextStore);
      return canonicalize({
        event,
        next_store: nextStore
      });
    });
  }

  function writeDerivedJson(filePath, value) {
    const normalized = canonicalize(value);
    writeCanonicalJsonAtomic(filePath, normalized);
    return normalized;
  }

  async function listOfferIds() {
    ensureDir(releasesDir);
    const entries = await fsp.readdir(releasesDir, { withFileTypes: true });
    const offerIds = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const offerId = safeString(entry.name);
      if (!offerId || offerId === "index") {
        continue;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(offerId)) {
        continue;
      }
      const offerDir = path.join(releasesDir, offerId);
      if (!fs.existsSync(path.join(offerDir, "release-approval.json"))) {
        continue;
      }
      offerIds.push(offerId);
    }
    return offerIds.sort((left, right) => left.localeCompare(right));
  }

  function buildStoredEvidencePath(platformTarget, fileName) {
    const target = normalizePlatformTarget(platformTarget);
    const name = normalizeRelativePath(fileName, "PHASE22_EVIDENCE_FILENAME_INVALID");
    if (name.includes("/")) {
      const error = new Error("evidence filename must not include path separators");
      error.code = "PHASE22_EVIDENCE_FILENAME_INVALID";
      throw error;
    }
    return `submission-evidence/${target}/evidence/${name}`;
  }

  return Object.freeze({
    rootDir,
    releasesDir,
    appendEvidenceEvent,
    appendExportEvent,
    buildStoredEvidencePath,
    getEvidenceLedgerPath,
    getExportEventsPath,
    getOfferDir,
    getPlatformEvidenceDirPath,
    getPlatformSnapshotPath,
    getRepoIndexPath,
    getSubmissionEvidenceRoot,
    getVerifyStatusPath,
    listOfferIds,
    readEvidenceLedgerStore,
    readExportEventsStore,
    withOfferLock,
    writeDerivedJson,
    writeEvidenceLedgerStore,
    writeExportEventsStore
  });
}

module.exports = {
  createSubmissionEvidenceLedger,
  normalizeOfferId,
  normalizePlatformTarget
};
