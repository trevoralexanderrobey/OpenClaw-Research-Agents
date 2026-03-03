"use strict";

const crypto = require("node:crypto");

function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
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

function canonicalStringify(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

const RUNTIME_POLICY = deepFreeze({
  schemaVersion: 2,
  gateway: {
    host: "127.0.0.1",
    port: 18789,
    allowDynamicPort: false,
    allowNonLocalhostBind: false,
    corsAllowlist: ["http://127.0.0.1:18789"],
    wsOriginAllowlist: ["http://127.0.0.1:18789"],
  },
  supplyChain: {
    requiredInstallCommand: "npm ci --offline --ignore-scripts",
    pinnedRegistryUrl: "https://registry.npmjs.org/",
    forbiddenLifecycleHooks: ["preinstall", "install", "postinstall", "prepare"],
    verifyCacheChecksumManifest: true,
  },
  supervisor: {
    allowToolExecution: false,
  },
  toolRegistry: {
    requireImmutableChecksumLock: true,
    requireDigestPinnedImages: true,
    rejectTaggedImages: true,
  },
  container: {
    requireNonRootUser: true,
    forbidPrivileged: true,
    forbidHostNetwork: true,
    forbidHostPid: true,
    forbidHostMounts: true,
    requireReadonlyRootfs: true,
    requiredCapDrop: ["ALL"],
    allowedWritableVolumes: ["scratch"],
    egressPolicy: {
      defaultAction: "deny",
      allowedHosts: [],
      allowedCIDR: [],
    },
  },
  runtimeConfig: {
    immutableAfterBoot: true,
    rejectDynamicEnvReRead: true,
  },
  determinism: {
    useCanonicalJsonSerialization: true,
    prohibitDirectGlobalTime: true,
    prohibitDirectGlobalRandomness: true,
    runtimeStateSchemaVersion: 5,
    ndjsonOrderingAuthority: "sequence",
  },
  researchMcp: {
    allowDynamicDomainConfiguration: false,
    allowOutboundMutationMethods: true,
    allowedReadDomains: ["api.semanticscholar.org", "export.arxiv.org"],
  },
  mutationMcp: {
    allowedWriteDomains: ["api.beehiiv.com", "api.notion.com"],
    allowDynamicDomainConfiguration: false,
    requireTwoPhaseCommit: true,
    requireOperatorAuthorization: true,
    requireKillSwitchCheck: true,
    requireIdempotencyKey: true,
  },
  logging: {
    format: "json",
    maskSensitiveData: true,
    stripControlChars: true,
    maxPayloadBytes: 16384,
    correlationIdPattern: "^[a-f0-9-]{16,64}$",
  },
});

function validateRuntimePolicy(policyInput = RUNTIME_POLICY) {
  const errors = [];
  const policy = policyInput;

  if (!isPlainObject(policy)) {
    return { valid: false, errors: ["policy must be an object"] };
  }

  if (policy.schemaVersion !== 2) {
    errors.push("schemaVersion must be 2");
  }

  if (!isPlainObject(policy.gateway)) {
    errors.push("gateway policy missing");
  } else {
    if (policy.gateway.host !== "127.0.0.1") errors.push("gateway.host must be 127.0.0.1");
    if (policy.gateway.port !== 18789) errors.push("gateway.port must be 18789");
    if (policy.gateway.allowDynamicPort !== false) errors.push("dynamic port override must be disabled");
    if (policy.gateway.allowNonLocalhostBind !== false) errors.push("non-localhost bind must be disabled");
  }

  if (!isPlainObject(policy.supervisor) || policy.supervisor.allowToolExecution !== false) {
    errors.push("supervisor tool execution must be disabled");
  }

  if (!isPlainObject(policy.container)) {
    errors.push("container policy missing");
  } else {
    if (policy.container.forbidPrivileged !== true) errors.push("containers must forbid privileged mode");
    if (policy.container.forbidHostNetwork !== true) errors.push("containers must forbid host network");
    if (policy.container.requireReadonlyRootfs !== true) errors.push("containers must enforce read-only rootfs");
    if (!isPlainObject(policy.container.egressPolicy) || policy.container.egressPolicy.defaultAction !== "deny") {
      errors.push("container egress default action must be deny");
    }
  }

  if (!isPlainObject(policy.supplyChain)) {
    errors.push("supplyChain policy missing");
  } else {
    if (policy.supplyChain.requiredInstallCommand !== "npm ci --offline --ignore-scripts") {
      errors.push("supply-chain install command mismatch");
    }
    if (policy.supplyChain.pinnedRegistryUrl !== "https://registry.npmjs.org/") {
      errors.push("registry URL pin mismatch");
    }
  }

  if (!isPlainObject(policy.determinism)) {
    errors.push("determinism policy missing");
  } else {
    if (policy.determinism.runtimeStateSchemaVersion !== 5) {
      errors.push("runtime state schemaVersion must be 5 in Phase 5");
    }
    if (policy.determinism.ndjsonOrderingAuthority !== "sequence") {
      errors.push("ndjson ordering authority must be sequence");
    }
  }

  if (!isPlainObject(policy.researchMcp)) {
    errors.push("researchMcp policy missing");
  } else {
    if (policy.researchMcp.allowDynamicDomainConfiguration !== false) {
      errors.push("researchMcp must disable dynamic domain configuration");
    }
    if (policy.researchMcp.allowOutboundMutationMethods !== true) {
      errors.push("researchMcp must enable controlled outbound mutation methods in Phase 5");
    }
    const allowed = Array.isArray(policy.researchMcp.allowedReadDomains) ? policy.researchMcp.allowedReadDomains : [];
    const sorted = [...allowed].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(["api.semanticscholar.org", "export.arxiv.org"])) {
      errors.push("researchMcp allowedReadDomains mismatch");
    }
  }

  if (!isPlainObject(policy.mutationMcp)) {
    errors.push("mutationMcp policy missing");
  } else {
    const writeDomains = Array.isArray(policy.mutationMcp.allowedWriteDomains) ? policy.mutationMcp.allowedWriteDomains : [];
    const sortedWriteDomains = [...writeDomains].sort();
    if (JSON.stringify(sortedWriteDomains) !== JSON.stringify(["api.beehiiv.com", "api.notion.com"])) {
      errors.push("mutationMcp allowedWriteDomains mismatch");
    }
    if (policy.mutationMcp.allowDynamicDomainConfiguration !== false) {
      errors.push("mutationMcp must disable dynamic domain configuration");
    }
    if (policy.mutationMcp.requireTwoPhaseCommit !== true) {
      errors.push("mutationMcp must require two-phase commit");
    }
    if (policy.mutationMcp.requireOperatorAuthorization !== true) {
      errors.push("mutationMcp must require operator authorization");
    }
    if (policy.mutationMcp.requireKillSwitchCheck !== true) {
      errors.push("mutationMcp must require kill-switch checks");
    }
    if (policy.mutationMcp.requireIdempotencyKey !== true) {
      errors.push("mutationMcp must require idempotency keys");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function assertSupervisorBoundary(role, toolName) {
  if (String(role || "") === "supervisor") {
    const error = new Error("Supervisor cannot execute tools in Phase 2");
    error.code = "SUPERVISOR_EXECUTION_DENIED";
    error.details = { role: "supervisor", toolName: String(toolName || "") };
    throw error;
  }
}

function assertGatewayBinding(host, port) {
  if (host !== RUNTIME_POLICY.gateway.host || Number(port) !== RUNTIME_POLICY.gateway.port) {
    const error = new Error("Gateway binding violates fixed runtime policy");
    error.code = "GATEWAY_BINDING_POLICY_VIOLATION";
    error.details = {
      expectedHost: RUNTIME_POLICY.gateway.host,
      expectedPort: RUNTIME_POLICY.gateway.port,
      host,
      port,
    };
    throw error;
  }
}

function assertContainerSecurityConfig(config) {
  const source = isPlainObject(config) ? config : {};
  const checks = [
    [source.runAsNonRoot === true, "runAsNonRoot must be true"],
    [source.privileged === false, "privileged must be false"],
    [source.hostNetwork === false, "hostNetwork must be false"],
    [source.hostPID === false, "hostPID must be false"],
    [source.hostMounts === false, "hostMounts must be false"],
    [source.readOnlyRootFilesystem === true, "readOnlyRootFilesystem must be true"],
  ];
  for (const [ok, message] of checks) {
    if (!ok) {
      const error = new Error(String(message));
      error.code = "SANDBOX_POLICY_VIOLATION";
      throw error;
    }
  }
}

function assertDigestPinnedImageReference(imageRef) {
  const ref = String(imageRef || "").trim();
  if (!/^[^\s:@/]+(?:\/[^\s:@/]+)+@sha256:[a-f0-9]{64}$/.test(ref)) {
    const error = new Error("Image reference must be digest pinned (name@sha256:...) and tag-free");
    error.code = "IMAGE_DIGEST_REQUIRED";
    error.details = { imageRef: ref };
    throw error;
  }
  const digestIndex = ref.indexOf("@sha256:");
  const withoutDigest = digestIndex === -1 ? ref : ref.slice(0, digestIndex);
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  if (/:latest(?:@|$)/i.test(ref) || hasTag) {
    const error = new Error("Tagged image references are forbidden");
    error.code = "IMAGE_TAG_FORBIDDEN";
    error.details = { imageRef: ref };
    throw error;
  }
}

function calculatePolicyChecksum(policyInput = RUNTIME_POLICY) {
  return crypto.createHash("sha256").update(canonicalStringify(policyInput)).digest("hex");
}

module.exports = {
  RUNTIME_POLICY,
  canonicalStringify,
  calculatePolicyChecksum,
  validateRuntimePolicy,
  assertSupervisorBoundary,
  assertGatewayBinding,
  assertContainerSecurityConfig,
  assertDigestPinnedImageReference,
};
