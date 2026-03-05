import fs from "node:fs/promises";
import path from "node:path";
import { nowMs } from "../../core/time-provider.js";

export type ExecutionRole = "supervisor" | "internal" | "admin" | "anonymous";
export type ExecutionSource = "mcp_sse" | "http_api" | "stdio_mcp" | "cli" | "job_worker" | "in_process";

type JsonObject = Record<string, unknown>;

export interface ExecutionContext {
  requestId: string;
  workspaceRoot: string;
  source: ExecutionSource;
  caller: string;
  authHeader?: string;
  internalFlagRequested?: boolean;
  internalToken?: string;
  trustedInProcessCaller?: boolean;
  trustedInProcessRole?: "internal" | "admin";
  transportMetadata?: JsonObject;
  legacyExecute?: (tool: string, args: JsonObject, context: ExecutionContext) => Promise<unknown>;
  legacyListTools?: () => Promise<ExecutionToolDescriptor[]>;
}

export interface ExecutionResult {
  ok: boolean;
  code?: string;
  message?: string;
  data?: unknown;
}

export interface ExecutionToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

interface SupervisorToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  mutationClass: "read" | "write" | "exec" | "security";
  roles: Array<"supervisor" | "internal" | "admin">;
}

interface SupervisorToolHandler {
  (args: JsonObject, context: ExecutionContext): Promise<unknown>;
}

export interface ExecutionRouterOptions {
  workspaceRoot: string;
  supervisorMode?: boolean;
  supervisorInternalToken?: string;
  registryPath?: string;
  supervisorHandlers?: Record<string, SupervisorToolHandler>;
  legacyVisibleToolsByRole?: Partial<Record<ExecutionRole, string[]>>;
}

export interface ExecutionRouterMetrics {
  counters: Record<string, number>;
}

export interface ExecutionRouter {
  execute(tool: string, args: JsonObject, context: ExecutionContext): Promise<ExecutionResult>;
  listTools(context: ExecutionContext): Promise<Array<ExecutionToolDescriptor>>;
  resolveRole(context: ExecutionContext): Promise<ExecutionRole>;
  getMetrics(): ExecutionRouterMetrics;
  getWorkloadIntegrityMetadata(): {
    nodeId: string;
    workloadManifestHash: string;
    workloadManifestLoaded: boolean;
    startupVerified: boolean;
    blocked: boolean;
    blockedReason: string;
  };
  evaluateWorkloadPeerPosture(_peers?: Array<Record<string, unknown>>): {
    ok: boolean;
    status: "aligned" | "mismatch" | "not_evaluated";
    criticalMismatches: Array<Record<string, unknown>>;
    warnings: Array<Record<string, unknown>>;
    timestamp: number;
  };
  getWorkloadAttestationMetadata(): {
    nodeId: string;
    trusted: boolean;
    blockedReason: string;
    referenceHash: string;
    lastEvidenceHash: string;
    lastVerifiedAt: number;
    peerTrustMap: Record<string, { trusted: boolean; failureReason: string; evidenceHash: string; verifiedAt: number; stickyUntrusted: boolean }>;
  };
  evaluateWorkloadAttestationPeerPosture(_peers?: Array<Record<string, unknown>>): {
    ok: boolean;
    status: "aligned" | "mismatch" | "not_evaluated";
    criticalMismatches: Array<Record<string, unknown>>;
    warnings: Array<Record<string, unknown>>;
    timestamp: number;
  };
  generateAttestationEvidence(): {
    ok: boolean;
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
  verifyPeerAttestationEvidence(): { ok: boolean; code: string; message: string; details: Record<string, unknown> };
  getWorkloadProvenanceMetadata(): {
    nodeId: string;
    trusted: boolean;
    blockedReason: string;
    provenanceHash: string;
    gitCommitSha: string;
    lastVerifiedAt: number;
    ttlMs: number;
    stale: boolean;
  };
}

const ROLE_POLICY: Record<ExecutionRole, { canExecuteTools: boolean; canSeeTools: boolean; canUseLegacy: boolean }> = {
  supervisor: { canExecuteTools: false, canSeeTools: false, canUseLegacy: false },
  internal: { canExecuteTools: true, canSeeTools: true, canUseLegacy: true },
  admin: { canExecuteTools: true, canSeeTools: true, canUseLegacy: true },
  anonymous: { canExecuteTools: false, canSeeTools: false, canUseLegacy: false },
};

const TOOL_NAME_ALIASES: Record<string, string> = Object.freeze({
  "supervisor.read_file": "supervisor_read_file",
  "supervisor.write_file": "supervisor_write_file",
  "supervisor.apply_patch": "supervisor_apply_patch",
  "supervisor.git_status": "supervisor_git_status",
  "supervisor.git_commit": "supervisor_git_commit",
  "supervisor.search": "supervisor_search",
  "supervisor.run_tests": "supervisor_run_tests",
  "supervisor.run_lint": "supervisor_run_lint",
  "supervisor.security_audit": "supervisor_security_audit",
});

function normalizeRecord(input: unknown): JsonObject {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as JsonObject) : {};
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseBearerToken(authHeader?: string): string {
  const value = normalizeString(authHeader);
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return "";
  }
  return normalizeString(match[1]);
}

function normalizeToolName(raw: string): string {
  const tool = normalizeString(raw);
  if (!tool) {
    return "";
  }
  const canonical = Object.prototype.hasOwnProperty.call(TOOL_NAME_ALIASES, tool) ? TOOL_NAME_ALIASES[tool] : tool;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(canonical)) {
    return "";
  }
  return canonical;
}

function validateSchema(schemaRaw: unknown, args: JsonObject): { ok: boolean; message?: string } {
  const schema = normalizeRecord(schemaRaw);
  if (normalizeString(schema.type) !== "object") {
    return { ok: false, message: "Tool schema must be object" };
  }

  const properties = normalizeRecord(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];

  for (const req of required) {
    if (!Object.prototype.hasOwnProperty.call(args, req)) {
      return { ok: false, message: `Missing required argument: ${req}` };
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return { ok: false, message: `Unexpected argument: ${key}` };
      }
    }
  }

  return { ok: true };
}

async function loadRegistry(pathname: string): Promise<SupervisorToolDefinition[]> {
  const raw = await fs.readFile(pathname, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => normalizeRecord(entry))
    .map((entry) => ({
      name: normalizeToolName(String(entry.name || "")),
      description: normalizeString(entry.description) || undefined,
      inputSchema: normalizeRecord(entry.inputSchema),
      mutationClass: (normalizeString(entry.mutationClass) || "read") as "read" | "write" | "exec" | "security",
      roles: Array.isArray(entry.roles)
        ? entry.roles.filter((role): role is "supervisor" | "internal" | "admin" => role === "supervisor" || role === "internal" || role === "admin")
        : [],
    }))
    .filter((entry) => Boolean(entry.name) && entry.roles.length > 0);
}

export function createExecutionRouter(options: ExecutionRouterOptions): ExecutionRouter {
  const registryPath = options.registryPath || path.resolve(process.cwd(), "supervisor", "supervisor-registry.json");
  const supervisorHandlers = options.supervisorHandlers || {};
  const supervisorInternalToken = normalizeString(options.supervisorInternalToken);

  let registryCache: SupervisorToolDefinition[] | null = null;
  const counters: Record<string, number> = {
    unauthorized_tool_attempts: 0,
    unauthorized_role_attempts: 0,
    legacy_fallback_used: 0,
  };

  async function getRegistry(): Promise<SupervisorToolDefinition[]> {
    if (registryCache) {
      return registryCache;
    }
    registryCache = await loadRegistry(registryPath);
    return registryCache;
  }

  async function resolveRole(context: ExecutionContext): Promise<ExecutionRole> {
    if (context.trustedInProcessCaller) {
      return context.trustedInProcessRole === "admin" ? "admin" : "internal";
    }

    if (context.internalFlagRequested && supervisorInternalToken) {
      const provided = normalizeString(context.internalToken);
      if (provided && provided === supervisorInternalToken) {
        return "internal";
      }
    }

    const bearer = parseBearerToken(context.authHeader);
    if (bearer) {
      return "supervisor";
    }

    return "anonymous";
  }

  async function listTools(context: ExecutionContext): Promise<Array<ExecutionToolDescriptor>> {
    const role = await resolveRole(context);
    const rolePolicy = ROLE_POLICY[role];
    if (!rolePolicy || !rolePolicy.canSeeTools) {
      return [];
    }

    const registry = await getRegistry();
    const allowed = registry
      .filter((entry) => entry.roles.includes(role as "supervisor" | "internal" | "admin"))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
      }));

    if (context.legacyListTools && rolePolicy.canUseLegacy) {
      const visible = await context.legacyListTools();
      const allowSet = new Set(Array.isArray(options.legacyVisibleToolsByRole && options.legacyVisibleToolsByRole[role])
        ? options.legacyVisibleToolsByRole[role]
        : []);
      for (const tool of visible) {
        if (!allowSet.has(tool.name)) {
          continue;
        }
        allowed.push(tool);
      }
    }

    return allowed;
  }

  async function execute(tool: string, argsInput: JsonObject, context: ExecutionContext): Promise<ExecutionResult> {
    const toolName = normalizeToolName(tool);
    if (!toolName) {
      return { ok: false, code: "INVALID_REQUEST", message: "Invalid tool name" };
    }

    const role = await resolveRole(context);
    const rolePolicy = ROLE_POLICY[role];
    if (!rolePolicy || !rolePolicy.canExecuteTools) {
      counters.unauthorized_role_attempts += 1;
      return { ok: false, code: "UNAUTHORIZED", message: "Role is not authorized" };
    }

    // Phase 2 boundary: supervisor cannot execute any tools.
    if (role === "supervisor") {
      counters.unauthorized_tool_attempts += 1;
      return { ok: false, code: "SUPERVISOR_EXECUTION_DENIED", message: "Supervisor cannot execute tools in Phase 2" };
    }

    const args = normalizeRecord(argsInput);
    const registry = await getRegistry();
    const definition = registry.find((entry) => entry.name === toolName);

    if (!definition) {
      if (context.legacyExecute && rolePolicy.canUseLegacy) {
        counters.legacy_fallback_used += 1;
        try {
          const data = await context.legacyExecute(toolName, args, context);
          return { ok: true, data };
        } catch {
          return { ok: false, code: "LEGACY_EXECUTION_FAILED", message: "Legacy tool execution failed" };
        }
      }
      counters.unauthorized_tool_attempts += 1;
      return { ok: false, code: "UNAUTHORIZED_TOOL", message: "Tool not exposed to caller role" };
    }

    if (!definition.roles.includes(role as "supervisor" | "internal" | "admin")) {
      counters.unauthorized_tool_attempts += 1;
      return { ok: false, code: "UNAUTHORIZED_TOOL", message: "Tool not exposed to caller role" };
    }

    const schemaValidation = validateSchema(definition.inputSchema, args);
    if (!schemaValidation.ok) {
      return { ok: false, code: "INVALID_ARGUMENT", message: schemaValidation.message || "Invalid tool arguments" };
    }

    const handler = supervisorHandlers[toolName];
    if (typeof handler !== "function") {
      return {
        ok: true,
        data: {
          ok: true,
          code: "PHASE1_TOOL_STUB",
          message: "No custom handler is registered in Phase 1 scaffold",
          tool: toolName,
        },
      };
    }

    try {
      const data = await handler(args, context);
      return { ok: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      return { ok: false, code: "SUPERVISOR_TOOL_FAILED", message };
    }
  }

  return {
    execute,
    listTools,
    resolveRole,
    getMetrics() {
      return { counters: { ...counters } };
    },
    getWorkloadIntegrityMetadata() {
      return {
        nodeId: "phase1-node",
        workloadManifestHash: "",
        workloadManifestLoaded: false,
        startupVerified: false,
        blocked: false,
        blockedReason: "",
      };
    },
    evaluateWorkloadPeerPosture() {
      return {
        ok: true,
        status: "not_evaluated",
        criticalMismatches: [],
        warnings: [],
        timestamp: nowMs(),
      };
    },
    getWorkloadAttestationMetadata() {
      return {
        nodeId: "phase1-node",
        trusted: false,
        blockedReason: "phase1_scaffold",
        referenceHash: "",
        lastEvidenceHash: "",
        lastVerifiedAt: 0,
        peerTrustMap: {},
      };
    },
    evaluateWorkloadAttestationPeerPosture() {
      return {
        ok: true,
        status: "not_evaluated",
        criticalMismatches: [],
        warnings: [],
        timestamp: nowMs(),
      };
    },
    generateAttestationEvidence() {
      return {
        ok: false,
        code: "NOT_IMPLEMENTED_PHASE1",
        message: "Attestation evidence generation is not implemented in Phase 1 scaffold",
        details: {},
      };
    },
    verifyPeerAttestationEvidence() {
      return {
        ok: false,
        code: "NOT_IMPLEMENTED_PHASE1",
        message: "Peer attestation verification is not implemented in Phase 1 scaffold",
        details: {},
      };
    },
    getWorkloadProvenanceMetadata() {
      return {
        nodeId: "phase1-node",
        trusted: false,
        blockedReason: "phase1_scaffold",
        provenanceHash: "",
        gitCommitSha: "",
        lastVerifiedAt: 0,
        ttlMs: 0,
        stale: true,
      };
    },
  };
}
