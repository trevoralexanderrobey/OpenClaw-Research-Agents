"use strict";

const dns = require("node:dns/promises");
const net = require("node:net");

const EGRESS_POLICY_KEYS = Object.freeze([
  "defaultAction",
  "allowedHosts",
  "allowedCIDR",
  "rateLimitPerSecond",
  "allowedMethodsByHost"
]);

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

const DEFAULT_EGRESS_POLICY = deepFreeze({
  defaultAction: "deny",
  allowedHosts: [],
  allowedCIDR: [],
  rateLimitPerSecond: 1,
  allowedMethodsByHost: {}
});

const TOOL_EGRESS_POLICIES = deepFreeze({
  "research-fetch-tool": DEFAULT_EGRESS_POLICY,
  "pdf-extractor-tool": DEFAULT_EGRESS_POLICY,
  "latex-compiler-tool": DEFAULT_EGRESS_POLICY,
  "operator-stub-tool": DEFAULT_EGRESS_POLICY,
  "arxiv-scholar-mcp": deepFreeze({
    defaultAction: "deny",
    allowedHosts: ["export.arxiv.org"],
    allowedCIDR: [],
    rateLimitPerSecond: 1,
    allowedMethodsByHost: {
      "export.arxiv.org": ["GET"]
    }
  }),
  "semantic-scholar-mcp": deepFreeze({
    defaultAction: "deny",
    allowedHosts: ["api.semanticscholar.org"],
    allowedCIDR: [],
    rateLimitPerSecond: 1,
    allowedMethodsByHost: {
      "api.semanticscholar.org": ["GET"]
    }
  }),
  "newsletter-publisher-mcp": deepFreeze({
    defaultAction: "deny",
    allowedHosts: ["api.beehiiv.com"],
    allowedCIDR: [],
    rateLimitPerSecond: 1,
    allowedMethodsByHost: {
      "api.beehiiv.com": ["POST", "PATCH"]
    }
  }),
  "notion-sync-mcp": deepFreeze({
    defaultAction: "deny",
    allowedHosts: ["api.notion.com"],
    allowedCIDR: [],
    rateLimitPerSecond: 1,
    allowedMethodsByHost: {
      "api.notion.com": ["POST", "PATCH"]
    }
  })
});

function normalizeSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isValidHost(value) {
  if (typeof value !== "string") {
    return false;
  }
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253) {
    return false;
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return false;
  }
  if (host.startsWith(".") || host.endsWith(".")) {
    return false;
  }
  return true;
}

function isCidr(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  return /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(value.trim());
}

function isIpv4Literal(value) {
  return net.isIP(String(value || "")) === 4;
}

function isIpv6Literal(value) {
  return net.isIP(String(value || "")) === 6;
}

function isIpLiteral(value) {
  return net.isIP(String(value || "")) !== 0;
}

function parseIpv4(value) {
  const parts = String(value || "").split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isForbiddenResolvedIp(ip) {
  const normalized = String(ip || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (isIpv4Literal(normalized)) {
    const octets = parseIpv4(normalized);
    if (!octets) {
      return true;
    }
    const [a, b] = octets;
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  if (isIpv6Literal(normalized)) {
    if (normalized === "::1") return true; // loopback
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return true; // link-local fe80::/10
    }
    return false;
  }

  return true;
}

function validatePolicyObject(policy, label) {
  const errors = [];
  if (!isPlainObject(policy)) {
    return { valid: false, errors: [`${label} must be an object`], policy: null };
  }

  for (const key of Object.keys(policy)) {
    if (!EGRESS_POLICY_KEYS.includes(key)) {
      errors.push(`${label} contains unknown field '${key}'`);
    }
  }

  for (const key of EGRESS_POLICY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) {
      errors.push(`${label}.${key} is required`);
    }
  }

  if (policy.defaultAction !== "deny") {
    errors.push(`${label}.defaultAction must be 'deny'`);
  }

  if (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.some((host) => !isValidHost(host))) {
    errors.push(`${label}.allowedHosts must be an array of DNS hostnames`);
  }

  if (!Array.isArray(policy.allowedCIDR) || policy.allowedCIDR.some((cidr) => !isCidr(cidr))) {
    errors.push(`${label}.allowedCIDR must be an array of CIDR strings`);
  }

  if (!isPositiveInteger(policy.rateLimitPerSecond)) {
    errors.push(`${label}.rateLimitPerSecond must be a positive integer`);
  }

  const allowedMethodsByHost = isPlainObject(policy.allowedMethodsByHost) ? policy.allowedMethodsByHost : null;
  if (!allowedMethodsByHost) {
    errors.push(`${label}.allowedMethodsByHost must be an object`);
  } else {
    for (const [host, methods] of Object.entries(allowedMethodsByHost)) {
      if (!isValidHost(host)) {
        errors.push(`${label}.allowedMethodsByHost contains invalid host '${host}'`);
        continue;
      }
      if (!Array.isArray(methods) || methods.length === 0) {
        errors.push(`${label}.allowedMethodsByHost['${host}'] must be a non-empty array`);
        continue;
      }
      for (const method of methods) {
        const normalizedMethod = typeof method === "string" ? method.trim().toUpperCase() : "";
        if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(normalizedMethod)) {
          errors.push(`${label}.allowedMethodsByHost['${host}'] has unsupported method '${method}'`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, policy: null };
  }

  return {
    valid: true,
    errors: [],
    policy: {
      defaultAction: "deny",
      allowedHosts: policy.allowedHosts.map((host) => host.trim().toLowerCase()),
      allowedCIDR: policy.allowedCIDR.map((cidr) => cidr.trim()),
      rateLimitPerSecond: policy.rateLimitPerSecond,
      allowedMethodsByHost: Object.fromEntries(
        Object.entries(policy.allowedMethodsByHost).map(([host, methods]) => [
          host.trim().toLowerCase(),
          methods.map((method) => String(method).trim().toUpperCase())
        ])
      )
    }
  };
}

function validateEgressPolicy(toolSlug, policySet, options = {}) {
  const slug = normalizeSlug(toolSlug);
  const policies = isPlainObject(policySet) ? policySet : TOOL_EGRESS_POLICIES;
  const allowDefault = Object.prototype.hasOwnProperty.call(options, "allowDefault") ? Boolean(options.allowDefault) : true;

  const direct = slug && Object.prototype.hasOwnProperty.call(policies, slug) ? policies[slug] : null;
  if (direct) {
    const result = validatePolicyObject(direct, `egressPolicies.${slug}`);
    return { ...result, usedDefault: false };
  }

  if (!allowDefault) {
    return { valid: false, errors: [`Egress policy is undefined for tool '${slug || "unknown"}'`], policy: null, usedDefault: false };
  }

  const fallback = Object.prototype.hasOwnProperty.call(policies, "default") ? policies.default : DEFAULT_EGRESS_POLICY;
  const result = validatePolicyObject(fallback, "egressPolicies.default");
  return { ...result, usedDefault: true };
}

function assertOutboundTargetAllowed(targetHost, policy) {
  const host = typeof targetHost === "string" ? targetHost.trim().toLowerCase() : "";
  if (!host) {
    const error = new Error("Outbound target host is required");
    error.code = "EGRESS_TARGET_REQUIRED";
    throw error;
  }

  if (isIpLiteral(host)) {
    const error = new Error("Outbound target must be a DNS hostname, not an IP literal");
    error.code = "EGRESS_IP_LITERAL_DENIED";
    error.details = { targetHost: host };
    throw error;
  }

  if (!policy || !isPlainObject(policy)) {
    const error = new Error("Egress policy is required for outbound target checks");
    error.code = "EGRESS_POLICY_UNDEFINED";
    throw error;
  }

  const allowedHosts = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
  if (!allowedHosts.includes(host)) {
    const error = new Error(`Outbound target '${host}' is denied by default egress policy`);
    error.code = "EGRESS_DENY_DEFAULT";
    error.details = { targetHost: host };
    throw error;
  }
}

function assertOutboundMethodAllowed(targetHost, method, policy) {
  const host = typeof targetHost === "string" ? targetHost.trim().toLowerCase() : "";
  const normalizedMethod = typeof method === "string" ? method.trim().toUpperCase() : "";
  if (!host) {
    const error = new Error("Outbound method validation requires a host");
    error.code = "EGRESS_TARGET_REQUIRED";
    throw error;
  }
  if (!normalizedMethod) {
    const error = new Error("Outbound method is required");
    error.code = "EGRESS_METHOD_REQUIRED";
    throw error;
  }
  const allowedMethodsByHost = isPlainObject(policy && policy.allowedMethodsByHost) ? policy.allowedMethodsByHost : {};
  const methods = Array.isArray(allowedMethodsByHost[host]) ? allowedMethodsByHost[host] : [];
  if (!methods.includes(normalizedMethod)) {
    const error = new Error(`Outbound method '${normalizedMethod}' is not allowlisted for host '${host}'`);
    error.code = "EGRESS_METHOD_DENIED";
    error.details = { targetHost: host, method: normalizedMethod };
    throw error;
  }
}

async function resolveHostOnce(hostname, options = {}) {
  const host = String(hostname || "").trim().toLowerCase();
  const resolver = options.resolver && typeof options.resolver === "object" ? options.resolver : dns;

  const ipv4 = typeof resolver.resolve4 === "function" ? await resolver.resolve4(host).catch(() => []) : [];
  const ipv6 = typeof resolver.resolve6 === "function" ? await resolver.resolve6(host).catch(() => []) : [];
  const resolvedIps = Array.from(new Set([...(Array.isArray(ipv4) ? ipv4 : []), ...(Array.isArray(ipv6) ? ipv6 : [])]))
    .map((ip) => String(ip).trim().toLowerCase())
    .filter(Boolean)
    .sort();

  if (resolvedIps.length === 0) {
    const error = new Error(`Unable to resolve outbound host '${host}'`);
    error.code = "EGRESS_DNS_RESOLUTION_FAILED";
    error.details = { host };
    throw error;
  }

  return resolvedIps;
}

function assertResolvedIpsSafe(hostname, resolvedIps) {
  const host = String(hostname || "").trim().toLowerCase();
  for (const ip of resolvedIps) {
    if (isForbiddenResolvedIp(ip)) {
      const error = new Error(`Resolved IP '${ip}' is forbidden for outbound host '${host}'`);
      error.code = "EGRESS_DNS_REBINDING_DENIED";
      error.details = { host, ip };
      throw error;
    }
  }
}

function createPinnedLookup(resolvedIp) {
  const pinned = String(resolvedIp || "").trim();
  return function lookup(_hostname, _options, callback) {
    callback(null, pinned, net.isIP(pinned) === 6 ? 6 : 4);
  };
}

function preparePinnedEgressTarget(rawUrl, policy, options = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    const error = new Error("Outbound URL is invalid");
    error.code = "EGRESS_URL_INVALID";
    throw error;
  }

  if (url.protocol !== "https:") {
    const error = new Error("Outbound URL must use TLS (https)");
    error.code = "EGRESS_TLS_REQUIRED";
    throw error;
  }

  if (url.username || url.password) {
    const error = new Error("Outbound URL must not include credentials");
    error.code = "EGRESS_CREDENTIALS_IN_URL_FORBIDDEN";
    throw error;
  }

  const hostname = url.hostname.trim().toLowerCase();
  assertOutboundTargetAllowed(hostname, policy);

  return resolveHostOnce(hostname, options).then((resolvedIps) => {
    assertResolvedIpsSafe(hostname, resolvedIps);
    const resolvedIp = resolvedIps[0];
    return {
      url,
      hostname,
      resolvedIp,
      resolvedIps,
      lookup: createPinnedLookup(resolvedIp)
    };
  });
}

function logOutboundAttempt(logger, attempt) {
  const sink = logger && typeof logger === "object" ? logger : { info() {} };
  const fn = typeof sink.info === "function" ? sink.info.bind(sink) : () => {};
  fn({
    event: "egress_outbound_attempt",
    domain: attempt.domain || "",
    status: attempt.status || "unknown",
    latency_ms: Number(attempt.latencyMs || 0),
    correlationId: attempt.correlationId || "",
    code: attempt.code || ""
  });
}

module.exports = {
  DEFAULT_EGRESS_POLICY,
  TOOL_EGRESS_POLICIES,
  EGRESS_POLICY_KEYS,
  validateEgressPolicy,
  assertOutboundTargetAllowed,
  isForbiddenResolvedIp,
  resolveHostOnce,
  assertResolvedIpsSafe,
  preparePinnedEgressTarget,
  assertOutboundMethodAllowed,
  logOutboundAttempt
};
