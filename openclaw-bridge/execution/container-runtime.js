"use strict";

const { validateImageReference } = require("./image-policy.js");
const { validateSandboxConfig } = require("./sandbox-policy.js");
const { resolveResourceLimits, validateResourceLimitsObject } = require("./resource-policy.js");
const { validateEgressPolicy, assertOutboundTargetAllowed } = require("./egress-policy.js");
const { createContainerAudit } = require("./container-audit.js");
const { resolveMcpContainerProfile, assertCredentialIsolation } = require("./mcp-container-profiles.js");
const {
  RUNTIME_POLICY,
  assertContainerSecurityConfig,
  assertDigestPinnedImageReference
} = require("../../security/runtime-policy.js");
const { nowMs, nowIso } = require("../core/time-provider.js");
const { randomUuid } = require("../core/entropy-provider.js");

const RUN_CONTAINER_REQUIRED_KEYS = Object.freeze([
  "image",
  "args",
  "env",
  "resourceLimits",
  "toolSlug",
  "sandboxConfig",
  "signatureVerified"
]);

const RUN_CONTAINER_OPTIONAL_KEYS = Object.freeze([
  "inputArtifacts",
  "requestId",
  "principalHash",
  "policySnapshot",
  "credentialHandle",
  "mcpVolumeNamespace"
]);

const RUN_CONTAINER_KEYS = Object.freeze([...RUN_CONTAINER_REQUIRED_KEYS, ...RUN_CONTAINER_OPTIONAL_KEYS]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function makeFailure(code, message, details) {
  const error = new Error(String(message || "Container runtime error"));
  error.code = String(code || "CONTAINER_RUNTIME_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function createNoopMetrics() {
  return {
    increment: () => {},
    observe: () => {},
    gauge: () => {}
  };
}

function createSafeLogger(rawLogger) {
  const source = rawLogger && typeof rawLogger === "object" ? rawLogger : {};
  return {
    info: typeof source.info === "function" ? source.info.bind(source) : () => {},
    warn: typeof source.warn === "function" ? source.warn.bind(source) : () => {},
    error: typeof source.error === "function" ? source.error.bind(source) : () => {}
  };
}

function validateRunContainerInputShape(input) {
  if (!isPlainObject(input)) {
    throw makeFailure("INVALID_CONTAINER_REQUEST", "runContainer input must be an object");
  }

  for (const key of Object.keys(input)) {
    if (!RUN_CONTAINER_KEYS.includes(key)) {
      throw makeFailure("INVALID_CONTAINER_REQUEST", `runContainer input contains unknown field '${key}'`);
    }
  }

  for (const key of RUN_CONTAINER_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      throw makeFailure("INVALID_CONTAINER_REQUEST", `runContainer input is missing required field '${key}'`);
    }
  }

  if (typeof input.image !== "string" || input.image.trim().length === 0) {
    throw makeFailure("INVALID_CONTAINER_REQUEST", "image must be a non-empty string");
  }

  if (!Array.isArray(input.args) || input.args.some((item) => typeof item !== "string")) {
    throw makeFailure("INVALID_CONTAINER_REQUEST", "args must be an array of strings");
  }

  if (!isPlainObject(input.env)) {
    throw makeFailure("INVALID_CONTAINER_REQUEST", "env must be an object");
  }

  if (!isPlainObject(input.resourceLimits)) {
    throw makeFailure("INVALID_CONTAINER_REQUEST", "resourceLimits must be an object");
  }

  if (!isPlainObject(input.sandboxConfig)) {
    throw makeFailure("INVALID_CONTAINER_REQUEST", "sandboxConfig must be an object");
  }

  if (typeof input.signatureVerified !== "boolean") {
    throw makeFailure("INVALID_CONTAINER_REQUEST", "signatureVerified must be a boolean");
  }
}

function createContainerRuntime(options = {}) {
  const runtimeEnabled = Boolean(
    Object.prototype.hasOwnProperty.call(options, "containerRuntimeEnabled")
      ? options.containerRuntimeEnabled
      : options.execution && options.execution.containerRuntimeEnabled
  );
  const production = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const metrics = options.metrics && typeof options.metrics === "object" ? options.metrics : createNoopMetrics();
  const logger = createSafeLogger(options.logger || options.auditLogger);
  const audit = createContainerAudit({ logger: options.auditLogger || logger, metrics });
  const activeExecutions = new Map();

  function ensureRuntimeEnabled() {
    if (!runtimeEnabled) {
      throw makeFailure("CONTAINER_RUNTIME_DISABLED", "Container runtime is disabled; set execution.containerRuntimeEnabled=true");
    }
  }

  async function runContainer(input = {}, context = {}) {
    ensureRuntimeEnabled();
    validateRunContainerInputShape(input);

    const toolSlug = normalizeString(input.toolSlug).toLowerCase();
    const mcpProfile = resolveMcpContainerProfile(toolSlug);

    const resourceValidation = validateResourceLimitsObject(input.resourceLimits, {
      rejectUnknown: true,
      label: "resourceLimits"
    });
    if (!resourceValidation.valid) {
      throw makeFailure("RESOURCE_LIMITS_REQUIRED", resourceValidation.errors.join("; "), { errors: resourceValidation.errors });
    }

    const policyLimits = resolveResourceLimits(toolSlug, {
      policies: options.resourcePolicies,
      allowDefault: false
    });

    for (const key of ["cpuShares", "memoryLimitMb", "maxRuntimeSeconds", "maxOutputBytes"]) {
      if (resourceValidation.limits[key] > policyLimits[key]) {
        throw makeFailure("RESOURCE_LIMIT_EXCEEDED", `resourceLimits.${key} exceeds policy limit`, {
          requested: resourceValidation.limits[key],
          policy: policyLimits[key],
          key
        });
      }
    }

    const sandboxValidation = validateSandboxConfig(input.sandboxConfig);
    if (!sandboxValidation.valid) {
      throw makeFailure("SANDBOX_POLICY_VIOLATION", sandboxValidation.errors.join("; "), {
        errors: sandboxValidation.errors
      });
    }

    assertContainerSecurityConfig(sandboxValidation.policy);

    const egressValidation = validateEgressPolicy(toolSlug, options.egressPolicies, {
      allowDefault: !mcpProfile
    });
    if (!egressValidation.valid) {
      throw makeFailure("EGRESS_POLICY_UNDEFINED", egressValidation.errors.join("; "), {
        errors: egressValidation.errors
      });
    }

    if (context && typeof context.outboundTargetHost === "string") {
      assertOutboundTargetAllowed(context.outboundTargetHost, egressValidation.policy);
    }

    if (mcpProfile) {
      assertCredentialIsolation(toolSlug, input.credentialHandle);
      const requestedNamespace = normalizeString(input.mcpVolumeNamespace);
      if (!requestedNamespace || requestedNamespace !== mcpProfile.writableVolumeNamespace) {
        throw makeFailure("MCP_VOLUME_ISOLATION_VIOLATION", "MCP volume namespace mismatch", {
          toolSlug,
          expected: mcpProfile.writableVolumeNamespace,
          provided: requestedNamespace || ""
        });
      }

      const policyHosts = Array.isArray(egressValidation.policy && egressValidation.policy.allowedHosts)
        ? egressValidation.policy.allowedHosts.slice().sort()
        : [];
      const profileHosts = mcpProfile.allowedHosts.slice().sort();
      if (JSON.stringify(policyHosts) !== JSON.stringify(profileHosts)) {
        throw makeFailure("MCP_EGRESS_SCOPE_VIOLATION", "MCP egress scope does not match profile allowlist", {
          toolSlug,
          policyHosts,
          profileHosts
        });
      }

      for (const key of Object.keys(input.env || {})) {
        if (/(token|secret|api[_-]?key|authorization|credential)/i.test(key)) {
          throw makeFailure("MCP_RAW_SECRET_ENV_FORBIDDEN", "Raw credential env vars are forbidden for MCP containers", {
            toolSlug,
            key
          });
        }
      }
    }

    if (egressValidation.policy.defaultAction !== RUNTIME_POLICY.container.egressPolicy.defaultAction) {
      throw makeFailure("EGRESS_POLICY_VIOLATION", "Runtime egress policy must default to deny");
    }

    assertDigestPinnedImageReference(input.image);

    const imageValidation = validateImageReference(input.image, {
      production,
      requireDigestPinning: true,
      requireSignatureVerification: production,
      signatureVerified: input.signatureVerified
    });

    if (!imageValidation.valid) {
      throw makeFailure("IMAGE_POLICY_VIOLATION", imageValidation.errors.join("; "), {
        errors: imageValidation.errors
      });
    }

    const startedAt = nowMs();
    const executionId = randomUuid();
    const requestId = normalizeString(input.requestId) || executionId;

    audit.recordStart({
      executionId,
      requestId,
      toolSlug,
      image: input.image,
      startTime: startedAt,
      resourceLimits: resourceValidation.limits
    });

    const resultEnvelope = {
      ok: true,
      code: "PHASE2_MOCK_EXECUTION",
      message: "Phase 2 hardened runtime validation passed (mock execution)",
      execution_id: executionId,
      request_id: requestId,
      tool: toolSlug,
      started_at: startedAt,
      stopped_at: nowMs()
    };

    activeExecutions.set(executionId, {
      containerId: executionId,
      createdAt: startedAt,
      toolSlug,
      requestId
    });

    metrics.increment("tool.container.executions", { tool: toolSlug });
    metrics.gauge("tool.container.exit_code", 0, { tool: toolSlug });

    audit.recordStop({
      executionId,
      requestId,
      toolSlug,
      stopTime: resultEnvelope.stopped_at,
      exitCode: 0
    });

    activeExecutions.delete(executionId);

    return {
      containerId: executionId,
      exitCode: 0,
      stdout: JSON.stringify(resultEnvelope),
      stderr: "",
      stats: {
        memoryUsageBytes: 0,
        cpuUsageNano: 0
      },
      rawResult: resultEnvelope
    };
  }

  async function stopContainer(containerId) {
    const id = normalizeString(containerId);
    if (!id) {
      throw makeFailure("INVALID_CONTAINER_ID", "containerId is required");
    }
    activeExecutions.delete(id);
    return { ok: true, containerId: id, stoppedAt: nowMs() };
  }

  async function inspectContainer(containerId) {
    const id = normalizeString(containerId);
    if (!id) {
      throw makeFailure("INVALID_CONTAINER_ID", "containerId is required");
    }
    const record = activeExecutions.get(id);
    return {
      containerId: id,
      running: Boolean(record),
      record: record || null
    };
  }

  async function listActiveExecutions() {
    return Array.from(activeExecutions.values()).map((value) => ({ ...value }));
  }

  async function sweepOrphans() {
    return {
      removedContainers: 0,
      removedVolumes: 0,
      timestamp: nowIso()
    };
  }

  async function runToolInContainer(toolSlug, payload = {}, runtimeContext = {}) {
    const slug = normalizeString(toolSlug).toLowerCase();
    if (!slug) {
      throw makeFailure("INVALID_CONTAINER_REQUEST", "toolSlug is required");
    }
    if (!isPlainObject(payload)) {
      throw makeFailure("INVALID_CONTAINER_REQUEST", "payload must be an object");
    }

    const modelInput = {
      image: payload.image,
      args: Array.isArray(payload.args) ? payload.args : [],
      env: isPlainObject(payload.env) ? payload.env : {},
      resourceLimits: isPlainObject(payload.resourceLimits) ? payload.resourceLimits : resolveResourceLimits(slug, {
        policies: options.resourcePolicies,
        allowDefault: true
      }),
      toolSlug: slug,
      sandboxConfig: isPlainObject(payload.sandboxConfig) ? payload.sandboxConfig : {
        runAsNonRoot: true,
        privileged: false,
        hostNetwork: false,
        hostPID: false,
        hostMounts: false,
        readOnlyRootFilesystem: true,
        capabilitiesDrop: ["ALL"],
        writableVolumes: ["scratch"]
      },
      signatureVerified: payload.signatureVerified === true,
      inputArtifacts: Array.isArray(payload.inputArtifacts) ? payload.inputArtifacts : [],
      requestId: payload.requestId,
      principalHash: payload.principalHash,
      policySnapshot: payload.policySnapshot,
      credentialHandle: payload.credentialHandle,
      mcpVolumeNamespace: payload.mcpVolumeNamespace
    };

    return runContainer(modelInput, runtimeContext);
  }

  function getRuntimePolicy(toolSlug) {
    const slug = normalizeString(toolSlug).toLowerCase();
    if (!slug) {
      throw makeFailure("INVALID_CONTAINER_REQUEST", "toolSlug is required");
    }
    const resourceLimits = resolveResourceLimits(slug, {
      policies: options.resourcePolicies,
      allowDefault: true
    });
    const egress = validateEgressPolicy(slug, options.egressPolicies, { allowDefault: true });
    return {
      toolSlug: slug,
      resourceLimits,
      egressPolicy: egress.policy || null,
      runtimePolicyVersion: RUNTIME_POLICY.schemaVersion
    };
  }

  return {
    runContainer,
    runToolInContainer,
    getRuntimePolicy,
    stopContainer,
    inspectContainer,
    listActiveExecutions,
    sweepOrphans
  };
}

module.exports = {
  createContainerRuntime
};
