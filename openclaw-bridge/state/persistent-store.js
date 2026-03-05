"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { nowMs, createTimeProvider } = require("../core/time-provider.js");
const { randomHex } = require("../core/entropy-provider.js");

const CONTROL_PLANE_STATE_VERSION = 2;
const DEFAULT_STORE_PATH = "./data/control-plane-state.json";
const DEFAULT_DEBOUNCE_MS = 1000;
const PHASE17_RUNTIME_STATE_VERSION = "phase17-runtime-state-v1";
const DEFAULT_PHASE17_RUNTIME_STATE_PATH = "./state/runtime/state.json";

function normalizeDebounceMs(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DEBOUNCE_MS;
  }
  return parsed;
}

function resolveStorePath(rawPath) {
  const fromEnv = typeof process.env.STATE_STORE_PATH === "string" ? process.env.STATE_STORE_PATH.trim() : "";
  const candidate = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : fromEnv || DEFAULT_STORE_PATH;
  return path.resolve(candidate);
}

function normalizeStringLineEndings(input) {
  return String(input).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isoFromNowMs(valueMs = nowMs()) {
  return createTimeProvider({ fixedNowMs: valueMs }).nowIso();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function serializeEnvelope(envelope) {
  const canonicalEnvelope = canonicalize(envelope);
  return `${normalizeStringLineEndings(JSON.stringify(canonicalEnvelope, null, 2))}\n`;
}

function createPersistentStore(options = {}) {
  const storePath = resolveStorePath(options.path);
  const debounceMs = normalizeDebounceMs(options.debounceMs);

  let pendingEnvelope = null;
  let writeTimer = null;
  let writeChain = Promise.resolve();
  let closed = false;

  async function writeAtomic(envelope) {
    const directory = path.dirname(storePath);
    await fs.mkdir(directory, { recursive: true });

    const tempPath = `${storePath}.tmp-${process.pid}-${nowMs()}-${randomHex(8)}`;
    const body = serializeEnvelope(envelope);
    await fs.writeFile(tempPath, body, { encoding: "utf8" });
    await fs.rename(tempPath, storePath);
  }

  function runExclusive(task) {
    const next = writeChain.then(task, task);
    writeChain = next.catch(() => {});
    return next;
  }

  async function load() {
    let raw = "";
    try {
      raw = await fs.readFile(storePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return {
          ok: true,
          state: null,
          exists: false,
          path: storePath,
        };
      }
      return {
        ok: false,
        code: "STATE_FILE_READ_FAILED",
        message: error && typeof error.message === "string" ? error.message : "Failed to read state file",
        state: null,
        path: storePath,
      };
    }

    const trimmed = normalizeStringLineEndings(raw).trim();
    if (!trimmed) {
      return {
        ok: true,
        state: null,
        exists: true,
        path: storePath,
      };
    }

    try {
      const parsed = JSON.parse(trimmed);
      return {
        ok: true,
        state: parsed,
        exists: true,
        path: storePath,
      };
    } catch (error) {
      return {
        ok: false,
        code: "STATE_FILE_CORRUPTED",
        message: error && typeof error.message === "string" ? error.message : "State file is corrupted",
        state: null,
        path: storePath,
      };
    }
  }

  function scheduleWrite(envelope) {
    if (closed) {
      return;
    }
    pendingEnvelope = envelope;
    if (writeTimer) {
      return;
    }
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void flush();
    }, debounceMs);
    if (writeTimer && typeof writeTimer.unref === "function") {
      writeTimer.unref();
    }
  }

  async function flush() {
    return runExclusive(async () => {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }

      let wrote = false;
      while (pendingEnvelope !== null) {
        const envelope = pendingEnvelope;
        pendingEnvelope = null;
        await writeAtomic(envelope);
        wrote = true;
      }

      return {
        ok: true,
        wrote,
      };
    }).catch((error) => ({
      ok: false,
      code: "STATE_FILE_WRITE_FAILED",
      message: error && typeof error.message === "string" ? error.message : "Failed to write state file",
    }));
  }

  async function close() {
    closed = true;
    return flush();
  }

  return {
    getPath: () => storePath,
    load,
    scheduleWrite,
    flush,
    close,
  };
}

function resolveRuntimeStatePath(rawPath) {
  const fromEnv = typeof process.env.PHASE17_RUNTIME_STATE_PATH === "string"
    ? process.env.PHASE17_RUNTIME_STATE_PATH.trim()
    : "";
  const candidate = typeof rawPath === "string" && rawPath.trim()
    ? rawPath.trim()
    : fromEnv || DEFAULT_PHASE17_RUNTIME_STATE_PATH;
  return path.resolve(candidate);
}

function defaultRuntimeState() {
  return {
    schemaVersion: PHASE17_RUNTIME_STATE_VERSION,
    lastUpdatedAt: "1970-01-01T00:00:00.000Z",
    recentDecisions: [],
    openLoops: [],
    laneSnapshots: {},
  };
}

function normalizeRuntimeState(state) {
  const source = isPlainObject(state) ? state : {};
  const recentDecisions = Array.isArray(source.recentDecisions)
    ? source.recentDecisions.map((entry) => canonicalize(entry))
    : [];
  const openLoops = Array.isArray(source.openLoops)
    ? source.openLoops.map((entry) => canonicalize(entry))
    : [];
  const laneSnapshots = isPlainObject(source.laneSnapshots)
    ? canonicalize(source.laneSnapshots)
    : {};

  recentDecisions.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  openLoops.sort((left, right) => String(left.loopId || "").localeCompare(String(right.loopId || "")));

  return canonicalize({
    schemaVersion: String(source.schemaVersion || PHASE17_RUNTIME_STATE_VERSION),
    lastUpdatedAt: String(source.lastUpdatedAt || "1970-01-01T00:00:00.000Z"),
    recentDecisions,
    openLoops,
    laneSnapshots,
  });
}

async function readRuntimeStateFile(runtimeStatePath) {
  try {
    const raw = await fs.readFile(runtimeStatePath, "utf8");
    const parsed = JSON.parse(normalizeStringLineEndings(raw));
    return normalizeRuntimeState(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return defaultRuntimeState();
    }
    if (error && error.name === "SyntaxError") {
      const malformed = new Error("Runtime state file is corrupted");
      malformed.code = "PHASE17_RUNTIME_STATE_CORRUPTED";
      throw malformed;
    }
    throw error;
  }
}

async function writeRuntimeStateFile(runtimeStatePath, state) {
  const directory = path.dirname(runtimeStatePath);
  await fs.mkdir(directory, { recursive: true });
  const normalized = normalizeRuntimeState(state);
  const tempPath = `${runtimeStatePath}.tmp-${process.pid}-${nowMs()}-${randomHex(8)}`;
  await fs.writeFile(tempPath, serializeEnvelope(normalized), { encoding: "utf8" });
  await fs.rename(tempPath, runtimeStatePath);
  return normalized;
}

async function loadRuntimeState(options = {}) {
  const runtimeStatePath = resolveRuntimeStatePath(options.path);
  const state = await readRuntimeStateFile(runtimeStatePath);
  return canonicalize({ path: runtimeStatePath, state });
}

async function saveRuntimeState(state, options = {}) {
  const runtimeStatePath = resolveRuntimeStatePath(options.path);
  const normalized = normalizeRuntimeState(state);
  normalized.lastUpdatedAt = isoFromNowMs(nowMs());
  const persisted = await writeRuntimeStateFile(runtimeStatePath, normalized);
  return canonicalize({ ok: true, path: runtimeStatePath, state: persisted });
}

async function appendRecentDecision(entry = {}, options = {}) {
  const loaded = await loadRuntimeState(options);
  const state = normalizeRuntimeState(loaded.state);
  const nextSequence = (state.recentDecisions.length > 0
    ? Math.max(...state.recentDecisions.map((record) => Number(record.sequence || 0)))
    : 0) + 1;

  const persistedEntry = canonicalize({
    sequence: nextSequence,
    decisionId: String(entry.decisionId || `rt-dec-${nextSequence}`),
    timestamp: String(entry.timestamp || isoFromNowMs(nowMs())),
    type: String(entry.type || "decision"),
    result: String(entry.result || "recorded"),
    details: isPlainObject(entry.details) ? canonicalize(entry.details) : {},
  });
  state.recentDecisions.push(persistedEntry);
  state.recentDecisions.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  await saveRuntimeState(state, options);
  return persistedEntry;
}

async function registerOpenLoop(loopEntry = {}, options = {}) {
  const loaded = await loadRuntimeState(options);
  const state = normalizeRuntimeState(loaded.state);
  const loopId = String(loopEntry.loopId || loopEntry.loop_id || `loop-${randomHex(8)}`);
  const normalizedEntry = canonicalize({
    loopId,
    sessionId: String(loopEntry.sessionId || loopEntry.session_id || "default"),
    taskEnvelope: isPlainObject(loopEntry.taskEnvelope) ? canonicalize(loopEntry.taskEnvelope) : {},
    createdAt: String(loopEntry.createdAt || isoFromNowMs(nowMs())),
    status: "open",
  });

  const withoutExisting = state.openLoops.filter((entry) => String(entry.loopId || "") !== loopId);
  withoutExisting.push(normalizedEntry);
  withoutExisting.sort((left, right) => String(left.loopId || "").localeCompare(String(right.loopId || "")));
  state.openLoops = withoutExisting;
  await saveRuntimeState(state, options);
  return normalizedEntry;
}

async function resolveOpenLoop(loopId, options = {}) {
  const normalizedLoopId = String(loopId || "").trim();
  if (!normalizedLoopId) {
    const error = new Error("loopId is required");
    error.code = "PHASE17_LOOP_ID_REQUIRED";
    throw error;
  }
  const loaded = await loadRuntimeState(options);
  const state = normalizeRuntimeState(loaded.state);
  const before = state.openLoops.length;
  state.openLoops = state.openLoops.filter((entry) => String(entry.loopId || "") !== normalizedLoopId);
  await saveRuntimeState(state, options);
  return {
    ok: true,
    resolved: before !== state.openLoops.length,
    loopId: normalizedLoopId,
  };
}

module.exports = {
  createPersistentStore,
  CONTROL_PLANE_STATE_VERSION,
  DEFAULT_STORE_PATH,
  PHASE17_RUNTIME_STATE_VERSION,
  DEFAULT_PHASE17_RUNTIME_STATE_PATH,
  resolveRuntimeStatePath,
  loadRuntimeState,
  saveRuntimeState,
  appendRecentDecision,
  registerOpenLoop,
  resolveOpenLoop,
};
