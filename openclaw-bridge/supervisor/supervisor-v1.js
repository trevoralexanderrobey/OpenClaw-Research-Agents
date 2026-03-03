const { CONTROL_PLANE_STATE_VERSION } = require("../state/persistent-store.js");
const { createStateManager } = require("../state/state-manager.js");
const { createCircuitBreaker } = require("./circuit-breaker.js");
const { RequestQueue } = require("./request-queue.js");
const { nowMs } = require("../core/time-provider.js");
const { randomUuid } = require("../core/entropy-provider.js");

const SKILL_CONFIG = Object.freeze({
  "research-fetch-tool": Object.freeze({
    maxInstances: 5,
    idleTTLms: 60000,
  }),
  "pdf-extractor-tool": Object.freeze({
    maxInstances: 3,
    idleTTLms: 60000,
  }),
  "latex-compiler-tool": Object.freeze({
    maxInstances: 3,
    idleTTLms: 60000,
  }),
  "operator-stub-tool": Object.freeze({
    maxInstances: 1,
    idleTTLms: 60000,
  }),
});

const ALLOWED_METHODS = new Set([
  "run",
  "health",
  "read_output_chunk",
  "search_output",
  "semantic_summary",
  "anomaly_summary",
  "anomaly_diff",
  "tag_baseline",
  "list_baselines",
  "diff_against_baseline",
]);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeSlug(rawSlug) {
  return typeof rawSlug === "string" ? rawSlug.trim().toLowerCase() : "";
}

function normalizeMethod(rawMethod) {
  return typeof rawMethod === "string" ? rawMethod.trim() : "";
}

function resolveRequestId(requestContext) {
  const explicit = requestContext && typeof requestContext.requestId === "string" ? requestContext.requestId.trim() : "";
  if (explicit && explicit.length <= 128) {
    return explicit;
  }
  return randomUuid();
}

function makeFailure(code, message, details) {
  const error = new Error(String(message || "Unexpected supervisor error"));
  error.code = String(code || "SUPERVISOR_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function createSupervisorV1(options = {}) {
  const queueEnabled = Boolean(options.queue && options.queue.enabled);
  const queueMaxLength = parsePositiveInt(options.queue && options.queue.maxLength, 100);
  const queuePollIntervalMs = parsePositiveInt(options.queue && options.queue.pollIntervalMs, 250);
  const handlers = options.handlers && typeof options.handlers === "object" ? options.handlers : {};

  const requestQueue = new RequestQueue(queueMaxLength);
  const circuitBreaker = createCircuitBreaker({
    enabled: Boolean(options.circuitBreaker && options.circuitBreaker.enabled),
    failureThreshold: options.circuitBreaker && options.circuitBreaker.failureThreshold,
    successThreshold: options.circuitBreaker && options.circuitBreaker.successThreshold,
    timeout: options.circuitBreaker && options.circuitBreaker.timeout,
  });

  const stateManager = createStateManager({
    version: CONTROL_PLANE_STATE_VERSION,
    path: options.state && options.state.path,
    debounceMs: options.state && options.state.debounceMs,
    buildState: buildPersistentStatePayload,
    applyState: restorePersistentState,
    onError: options.onStateError,
  });

  let initialized = false;
  let isShuttingDown = false;
  let queueTimer = null;
  let queueProcessorActive = false;

  const metrics = {
    counters: {
      executionsTotal: 0,
      executionsFailed: 0,
      queueEnqueued: 0,
      queueDequeued: 0,
    },
  };

  function buildPersistentStatePayload() {
    const queueItems = requestQueue.toArray().map((item) => ({
      slug: item.slug,
      method: item.method,
      params: item.params,
      requestContext: item.requestContext,
      enqueuedAt: Number(item.enqueuedAt || nowMs()),
      nextExecutionTime: Number(item.nextExecutionTime || nowMs()),
    }));

    return {
      requestQueue: {
        maxLength: queueMaxLength,
        items: queueItems,
      },
      circuitBreakerState: circuitBreaker.exportState(),
    };
  }

  async function restorePersistentState(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object") {
      return;
    }

    const queueItems = Array.isArray(rawPayload.requestQueue && rawPayload.requestQueue.items)
      ? rawPayload.requestQueue.items
      : [];
    const recoveredQueue = [];

    const now = nowMs();
    for (const item of queueItems) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const slug = normalizeSlug(item.slug);
      const method = normalizeMethod(item.method);
      if (!slug || !method) {
        continue;
      }
      recoveredQueue.push({
        slug,
        method,
        params: item.params || {},
        requestContext: item.requestContext || {},
        enqueuedAt: Number(item.enqueuedAt || now),
        nextExecutionTime: Math.max(now, Number(item.nextExecutionTime || now)),
      });
    }

    requestQueue.fromArray(recoveredQueue);
    circuitBreaker.importState(rawPayload.circuitBreakerState, {
      resetHalfOpenToOpen: true,
    });
  }

  function scheduleStatePersist(reason = "update") {
    if (!initialized || isShuttingDown) {
      return;
    }
    stateManager.schedulePersist(reason);
  }

  function validateExecutionRequest(slug, method) {
    const normalizedSlug = normalizeSlug(slug);
    const normalizedMethod = normalizeMethod(method);
    if (!normalizedSlug || !Object.prototype.hasOwnProperty.call(SKILL_CONFIG, normalizedSlug)) {
      throw makeFailure("INVALID_SLUG", "Unknown skill slug", { slug: normalizedSlug });
    }
    if (!normalizedMethod || !ALLOWED_METHODS.has(normalizedMethod)) {
      throw makeFailure("INVALID_METHOD", "Unsupported method", { method: normalizedMethod });
    }
    return { slug: normalizedSlug, method: normalizedMethod };
  }

  async function execute(slug, method, params = {}, requestContext = {}) {
    if (isShuttingDown) {
      throw makeFailure("SUPERVISOR_SHUTTING_DOWN", "Supervisor is shutting down");
    }

    const normalized = validateExecutionRequest(slug, method);
    const requestId = resolveRequestId(requestContext);

    if (circuitBreaker.enabled) {
      const gate = circuitBreaker.checkBeforeRequest(normalized.slug);
      if (!gate.allowed) {
        throw makeFailure("CIRCUIT_BREAKER_OPEN", "Skill circuit breaker is open", {
          slug: normalized.slug,
          request_id: requestId,
        });
      }
    }

    metrics.counters.executionsTotal += 1;

    try {
      const handler = typeof handlers[normalized.slug] === "function" ? handlers[normalized.slug] : null;
      const result = handler
        ? await handler({ method: normalized.method, params, requestContext: { ...requestContext, requestId } })
        : {
            ok: true,
            code: "PHASE1_SUPERVISOR_STUB",
            message: "Phase 1 supervisor executed scaffold handler",
            slug: normalized.slug,
            method: normalized.method,
            request_id: requestId,
          };

      if (circuitBreaker.enabled) {
        const transition = circuitBreaker.recordSuccess(normalized.slug);
        if (transition.transitioned) {
          scheduleStatePersist("circuit_success");
        }
      }

      return result;
    } catch (error) {
      metrics.counters.executionsFailed += 1;
      if (circuitBreaker.enabled) {
        const transition = circuitBreaker.recordFailure(normalized.slug);
        if (transition.transitioned) {
          scheduleStatePersist("circuit_failure");
        }
      }
      throw error;
    }
  }

  function enqueue(request) {
    if (!queueEnabled) {
      return { queued: false, reason: "queue_disabled" };
    }
    const slug = normalizeSlug(request && request.slug);
    const method = normalizeMethod(request && request.method);
    validateExecutionRequest(slug, method);

    const now = nowMs();
    const queued = requestQueue.enqueue({
      slug,
      method,
      params: request && request.params ? request.params : {},
      requestContext: request && request.requestContext ? request.requestContext : {},
      enqueuedAt: now,
      nextExecutionTime: now,
    });

    if (!queued) {
      return { queued: false, reason: "queue_full" };
    }

    metrics.counters.queueEnqueued += 1;
    scheduleStatePersist("queue_enqueue");
    return { queued: true };
  }

  async function processQueue() {
    if (!queueEnabled || queueProcessorActive || isShuttingDown) {
      return;
    }
    queueProcessorActive = true;
    try {
      const queued = requestQueue.peek();
      if (!queued) {
        return;
      }

      const now = nowMs();
      if (now < Number(queued.nextExecutionTime || now)) {
        return;
      }

      const item = requestQueue.dequeue();
      if (!item) {
        return;
      }

      metrics.counters.queueDequeued += 1;
      scheduleStatePersist("queue_dequeue");

      try {
        await execute(item.slug, item.method, item.params, {
          ...item.requestContext,
          __queueExecution: true,
        });
      } catch {
        // queue mode intentionally swallows execution errors after state accounting
      }
    } finally {
      queueProcessorActive = false;
    }
  }

  function startQueueProcessor() {
    if (!queueEnabled || queueTimer) {
      return;
    }
    queueTimer = setInterval(() => {
      processQueue().catch(() => {});
    }, queuePollIntervalMs);
    if (queueTimer && typeof queueTimer.unref === "function") {
      queueTimer.unref();
    }
  }

  function stopQueueProcessor() {
    if (!queueTimer) {
      return;
    }
    clearInterval(queueTimer);
    queueTimer = null;
  }

  async function initialize() {
    if (initialized) {
      return { ok: true, initialized: true, alreadyInitialized: true };
    }

    await stateManager.initialize();
    initialized = true;
    startQueueProcessor();

    return {
      ok: true,
      initialized: true,
      queueEnabled,
      statePath: stateManager.getPath(),
    };
  }

  function getStatus() {
    return {
      ok: true,
      isShuttingDown,
      queue: {
        enabled: queueEnabled,
        length: requestQueue.length,
        maxLength: queueMaxLength,
      },
      skills: Object.keys(SKILL_CONFIG).map((slug) => ({
        slug,
        ...SKILL_CONFIG[slug],
        circuit: circuitBreaker.getSnapshot(slug),
      })),
    };
  }

  async function shutdown() {
    isShuttingDown = true;
    stopQueueProcessor();
    requestQueue.clear();

    const flush = await stateManager.shutdown();
    return {
      ok: true,
      flushed: flush,
    };
  }

  function getMetrics() {
    return {
      counters: [{ name: "supervisor.executions.total", value: metrics.counters.executionsTotal }],
      histograms: [],
      gauges: [
        { name: "supervisor.queue.length", value: requestQueue.length },
        { name: "supervisor.executions.failed", value: metrics.counters.executionsFailed },
      ],
    };
  }

  return {
    initialize,
    execute,
    enqueue,
    processQueue,
    getStatus,
    getMetrics,
    shutdown,
  };
}

module.exports = {
  createSupervisorV1,
};
