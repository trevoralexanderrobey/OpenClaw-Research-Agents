"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { safeString, canonicalize, canonicalJson, sha256 } = require("../../workflows/governance-automation/common.js");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeAtomic(filePath, body) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, body, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function nextSequence(indexPath) {
  const index = readJson(indexPath, { next_sequence: 0 });
  const next = Math.max(0, Number(index.next_sequence || 0)) + 1;
  writeAtomic(indexPath, canonicalJson({ next_sequence: next }));
  return next;
}

function createCommsBus(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const timeProvider = options.timeProvider && typeof options.timeProvider.nowIso === "function"
    ? options.timeProvider
    : { nowIso: () => "1970-01-01T00:00:00.000Z" };
  const basePath = path.resolve(safeString(options.basePath) || path.join(process.cwd(), "workspace", "comms"));

  const inboxPath = path.join(basePath, "inbox");
  const outboxPath = path.join(basePath, "outbox");
  const blackboardPath = path.join(basePath, "blackboard");
  const eventPath = path.join(basePath, "events");

  for (const dirPath of [inboxPath, outboxPath, blackboardPath, eventPath]) {
    ensureDir(dirPath);
  }

  function writeMessage(targetDir, role, envelope = {}) {
    const normalizedRole = safeString(role).toLowerCase() || "unknown";
    const roleDir = path.join(targetDir, normalizedRole);
    ensureDir(roleDir);

    const seq = nextSequence(path.join(roleDir, "index.json"));
    const payload = canonicalize({
      sequence: seq,
      role: normalizedRole,
      timestamp: safeString(timeProvider.nowIso()),
      envelope: canonicalize(envelope)
    });
    payload.envelope_hash = sha256(JSON.stringify(payload.envelope));

    const filePath = path.join(roleDir, `${String(seq).padStart(8, "0")}.json`);
    writeAtomic(filePath, canonicalJson(payload));

    return canonicalize({ sequence: seq, path: filePath, payload });
  }

  function writeInboxMessage(role, envelope = {}) {
    const written = writeMessage(inboxPath, role, envelope);
    logger.info({ event: "phase15_comms_inbox_write", role: safeString(role), sequence: written.sequence });
    return written;
  }

  function writeOutboxMessage(role, envelope = {}) {
    const written = writeMessage(outboxPath, role, envelope);
    logger.info({ event: "phase15_comms_outbox_write", role: safeString(role), sequence: written.sequence });
    return written;
  }

  function appendBlackboard(entry = {}) {
    const seq = nextSequence(path.join(blackboardPath, "index.json"));
    const prevPath = seq > 1 ? path.join(blackboardPath, `${String(seq - 1).padStart(8, "0")}.json`) : "";
    const prevHash = prevPath && fs.existsSync(prevPath) ? sha256(fs.readFileSync(prevPath, "utf8")) : "";

    const payload = canonicalize({
      sequence: seq,
      timestamp: safeString(timeProvider.nowIso()),
      entry: canonicalize(entry),
      prev_chain_hash: prevHash
    });
    payload.chain_hash = sha256(`${payload.prev_chain_hash}|${JSON.stringify(payload.entry)}`);

    const filePath = path.join(blackboardPath, `${String(seq).padStart(8, "0")}.json`);
    writeAtomic(filePath, canonicalJson(payload));
    logger.info({ event: "phase15_blackboard_append", sequence: seq });
    return canonicalize({ sequence: seq, path: filePath, payload });
  }

  function readMessages(filter = {}) {
    const scope = safeString(filter.scope).toLowerCase();
    const role = safeString(filter.role).toLowerCase();

    const roots = [];
    if (!scope || scope === "inbox") roots.push(inboxPath);
    if (!scope || scope === "outbox") roots.push(outboxPath);
    if (!scope || scope === "blackboard") roots.push(blackboardPath);

    const out = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (role && entry.name !== role) continue;
          const files = fs.readdirSync(path.join(root, entry.name)).filter((name) => name.endsWith(".json") && name !== "index.json");
          for (const file of files.sort((a, b) => a.localeCompare(b))) {
            const record = readJson(path.join(root, entry.name, file), null);
            if (record) out.push(record);
          }
          continue;
        }

        if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json") {
          const record = readJson(path.join(root, entry.name), null);
          if (record) out.push(record);
        }
      }
    }

    out.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    return canonicalize(out);
  }

  function detectTamper(filter = {}) {
    const records = readMessages(filter);
    const findings = [];

    for (const record of records) {
      if (record && typeof record === "object" && record.envelope && typeof record.envelope_hash === "string") {
        const expectedEnvelopeHash = sha256(JSON.stringify(canonicalize(record.envelope)));
        if (record.envelope_hash !== expectedEnvelopeHash) {
          findings.push(canonicalize({
            type: "envelope_hash_mismatch",
            sequence: Number(record.sequence || 0),
            role: safeString(record.role),
            expected: expectedEnvelopeHash,
            actual: safeString(record.envelope_hash)
          }));
        }
      }
    }

    const blackboard = records
      .filter((record) => record && typeof record === "object" && Object.prototype.hasOwnProperty.call(record, "prev_chain_hash"))
      .slice()
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    let prevHash = "";

    for (const record of blackboard) {
      const expectedChain = sha256(`${safeString(record.prev_chain_hash)}|${JSON.stringify(canonicalize(record.entry || {}))}`);
      if (safeString(record.chain_hash) !== expectedChain) {
        findings.push(canonicalize({
          type: "blackboard_chain_hash_mismatch",
          sequence: Number(record.sequence || 0),
          expected: expectedChain,
          actual: safeString(record.chain_hash)
        }));
      }
      if (safeString(record.prev_chain_hash) !== prevHash) {
        findings.push(canonicalize({
          type: "blackboard_prev_chain_mismatch",
          sequence: Number(record.sequence || 0),
          expected_prev_chain_hash: prevHash,
          actual_prev_chain_hash: safeString(record.prev_chain_hash)
        }));
      }
      prevHash = safeString(record.chain_hash);
    }

    return canonicalize({
      valid: findings.length === 0,
      findings
    });
  }

  return Object.freeze({
    writeInboxMessage,
    writeOutboxMessage,
    appendBlackboard,
    readMessages,
    detectTamper,
    basePath
  });
}

module.exports = {
  createCommsBus
};
