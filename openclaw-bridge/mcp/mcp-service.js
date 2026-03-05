"use strict";

const { z } = require("zod");

const { createPromptSanitizer } = require("../../security/prompt-sanitizer.js");
const { createApiGovernance } = require("../../security/api-governance.js");
const { createOperatorAuthorization } = require("../../security/operator-authorization.js");
const { createMutationControl } = require("../../security/mutation-control.js");
const { verifyPhase7StartupIntegrity } = require("../../security/phase7-startup-integrity.js");
const { verifyPhase8StartupIntegrity } = require("../../security/phase8-startup-integrity.js");
const { createMonetizationEngine } = require("../../analytics/monetization-engine.js");
const { createSemanticScholarMcp } = require("./semantic-scholar-mcp.js");
const { createArxivMcp } = require("./arxiv-mcp.js");
const { createNewsletterMcpStub } = require("./newsletter-mcp.stub.js");
const { createNotionMcpStub } = require("./notion-mcp.stub.js");
const { createNewsletterMcp } = require("./newsletter-mcp.js");
const { createNotionMcp } = require("./notion-mcp.js");
const { BaseMcp } = require("./base-mcp.js");
const {
  MCP_METHODS,
  normalizeMcpMethodName
} = require("../bridge/mcp-method-registry.js");

const RESEARCH_PROVIDERS = Object.freeze(["semantic-scholar", "arxiv", "newsletter", "notion"]);

const SearchParamsSchema = z.object({
  provider: z.enum(RESEARCH_PROVIDERS),
  query: z.string().min(3).max(512),
  limit: z.number().int().min(1).max(50).default(10)
}).strict();

const GetPaperParamsSchema = z.object({
  provider: z.enum(RESEARCH_PROVIDERS),
  paper_id: z.string().min(1).max(256)
}).strict();

const MonetizationParamsSchema = z.object({
  fromDayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
}).strict().default({});

const SetMutationEnabledSchema = z.object({
  enabled: z.boolean(),
  approvalToken: z.string().min(8).max(256)
}).strict();

const SetKillSwitchSchema = z.object({
  killSwitch: z.boolean(),
  approvalToken: z.string().min(8).max(256)
}).strict();

const MutationSequenceSchema = z.object({
  sequence: z.number().int().min(1),
  approvalToken: z.string().min(8).max(256)
}).strict();

const MutationReconcileSchema = MutationSequenceSchema.extend({
  action: z.enum(["confirm_committed", "confirm_not_committed", "abandon"]),
  externalId: z.string().min(1).max(256).optional()
}).strict();

const MutationPrepareNewsletterSchema = z.object({
  provider: z.literal("newsletter"),
  publicationId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  html: z.string().min(1).max(50000),
  slug: z.string().min(1).max(128).optional(),
  tags: z.array(z.string().min(1).max(32)).max(20).optional(),
  approvalToken: z.string().min(8).max(256)
}).strict();

const MutationPrepareNotionSchema = z.object({
  provider: z.literal("notion"),
  databaseId: z.string().min(1).max(128),
  properties: z.record(z.any()),
  content: z.array(z.record(z.any())).max(50).optional(),
  approvalToken: z.string().min(8).max(256)
}).strict();

const FORBIDDEN_OVERRIDE_FIELDS = Object.freeze([
  "override_rate_limit",
  "override_policy",
  "egressPolicy",
  "apiGovernance",
  "credential",
  "credentialHandle",
  "domain",
  "host",
  "rejectUnauthorized",
  "ca",
  "cert",
  "key",
  "agent",
  "checkServerIdentity",
  "servername",
  "insecureSkipTlsVerify",
  "tls",
  "tlsOptions"
]);

function createMcpError(code, message, details) {
  const error = new Error(String(message || "MCP service error"));
  error.code = String(code || "MCP_SERVICE_ERROR");
  if (typeof details !== "undefined") {
    error.details = details;
  }
  return error;
}

function assertNoForbiddenOverrides(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return;
  }
  for (const field of FORBIDDEN_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(params, field)) {
      throw createMcpError("MCP_OVERRIDE_FORBIDDEN", `Field '${field}' is not allowed`);
    }
  }
}

function selectResearchModule(modules, provider) {
  if (provider === "semantic-scholar") return modules.semantic;
  if (provider === "arxiv") return modules.arxiv;
  if (provider === "newsletter") return modules.newsletterStub;
  if (provider === "notion") return modules.notionStub;
  throw createMcpError("MCP_PROVIDER_UNSUPPORTED", `Unsupported provider '${provider}'`);
}

function normalizeRole(context) {
  return typeof context.role === "string" ? context.role.trim().toLowerCase() : "supervisor";
}

function assertOperatorRole(context) {
  if (normalizeRole(context) !== "operator") {
    throw createMcpError("MUTATION_ROLE_DENIED", "Mutation methods require operator role");
  }
}

function createMcpService(options = {}) {
  const logger = options.logger && typeof options.logger === "object" ? options.logger : { info() {}, warn() {}, error() {} };
  const promptSanitizer = options.promptSanitizer || createPromptSanitizer({ logger });
  const apiGovernance = options.apiGovernance || createApiGovernance({ logger });
  const operatorAuthorization = options.operatorAuthorization || createOperatorAuthorization({ logger });
  const mutationControl = options.mutationControl || createMutationControl({
    logger,
    apiGovernance,
    operatorAuthorization,
    egressPolicies: options.egressPolicies,
    timeProvider: options.timeProvider,
    mutationLogPath: options.mutationLogPath
  });

  const modules = {
    semantic: createSemanticScholarMcp({
      logger,
      promptSanitizer,
      apiGovernance,
      egressPolicies: options.egressPolicies
    }),
    arxiv: createArxivMcp({
      logger,
      promptSanitizer,
      apiGovernance,
      egressPolicies: options.egressPolicies
    }),
    newsletterStub: createNewsletterMcpStub({
      logger,
      promptSanitizer,
      apiGovernance,
      egressPolicies: options.egressPolicies
    }),
    notionStub: createNotionMcpStub({
      logger,
      promptSanitizer,
      apiGovernance,
      egressPolicies: options.egressPolicies
    }),
    newsletterMutation: createNewsletterMcp({
      logger,
      mutationControl,
      egressPolicies: options.egressPolicies,
      beehiivApiBase: options.beehiivApiBase,
      allowedExternalHosts: options.allowedExternalHosts
    }),
    notionMutation: createNotionMcp({
      logger,
      mutationControl,
      egressPolicies: options.egressPolicies
    })
  };

  const monetizationEngine = createMonetizationEngine({ apiGovernance });
  let mutationHydrationPromise = null;
  let initializePromise = null;

  async function ensureMutationHydrated() {
    if (!mutationHydrationPromise) {
      mutationHydrationPromise = mutationControl.hydrateReplayProtection().catch((error) => {
        mutationHydrationPromise = null;
        throw error;
      });
    }
    return mutationHydrationPromise;
  }

  async function initialize() {
    if (!initializePromise) {
      initializePromise = (async () => {
        await verifyStoredReplay();
        await verifyPhase7StartupIntegrity({ apiGovernance, logger });
        await verifyPhase8StartupIntegrity({ apiGovernance, logger });
        return { ok: true };
      })().catch((error) => {
        initializePromise = null;
        throw error;
      });
    }
    return initializePromise;
  }

  async function handle(method, params, context = {}) {
    await initialize();
    const correlationId = typeof context.correlationId === "string" ? context.correlationId : "";
    const normalizedMethod = normalizeMcpMethodName(method);
    assertNoForbiddenOverrides(params);

    if (normalizedMethod === MCP_METHODS.RESEARCH_SEARCH) {
      const parsed = SearchParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for research.search", { issues: parsed.error.issues });
      }
      if (parsed.data.provider === "newsletter" || parsed.data.provider === "notion") {
        throw createMcpError("MCP_NOT_IMPLEMENTED", `${parsed.data.provider} provider is stub-only in research methods`);
      }
      const providerModule = selectResearchModule(modules, parsed.data.provider);
      const result = await providerModule.run(
        {
          action: "search",
          query: parsed.data.query,
          limit: parsed.data.limit
        },
        {
          correlationId,
          requester: context.requester || "supervisor",
          role: context.role || "supervisor"
        }
      );
      return {
        provider: parsed.data.provider,
        records: result.records
      };
    }

    if (normalizedMethod === MCP_METHODS.RESEARCH_GET_PAPER) {
      const parsed = GetPaperParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for research.getPaper", { issues: parsed.error.issues });
      }
      if (parsed.data.provider === "newsletter" || parsed.data.provider === "notion") {
        throw createMcpError("MCP_NOT_IMPLEMENTED", `${parsed.data.provider} provider is stub-only in research methods`);
      }
      const providerModule = selectResearchModule(modules, parsed.data.provider);
      const result = await providerModule.run(
        {
          action: "getPaper",
          paper_id: parsed.data.paper_id
        },
        {
          correlationId,
          requester: context.requester || "supervisor",
          role: context.role || "supervisor"
        }
      );
      return {
        provider: parsed.data.provider,
        records: result.records
      };
    }

    if (normalizedMethod === MCP_METHODS.ANALYTICS_MONETIZATION_SCORE) {
      const parsed = MonetizationParamsSchema.safeParse(params || {});
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for analytics.monetizationScore", { issues: parsed.error.issues });
      }
      const score = await monetizationEngine.computeMonetizationScore(parsed.data);
      return {
        analytics: score
      };
    }

    if (normalizedMethod === MCP_METHODS.MUTATION_SET_MUTATION_ENABLED) {
      assertOperatorRole(context);
      await ensureMutationHydrated();
      const parsed = SetMutationEnabledSchema.safeParse(params);
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for mutation.setMutationEnabled", { issues: parsed.error.issues });
      }
      return mutationControl.setMutationEnabled(parsed.data, { correlationId });
    }

    if (normalizedMethod === MCP_METHODS.MUTATION_SET_KILL_SWITCH) {
      assertOperatorRole(context);
      await ensureMutationHydrated();
      const parsed = SetKillSwitchSchema.safeParse(params);
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for mutation.setKillSwitch", { issues: parsed.error.issues });
      }
      return mutationControl.setKillSwitch(parsed.data, { correlationId });
    }

    if (normalizedMethod === MCP_METHODS.MUTATION_PREPARE_PUBLICATION) {
      assertOperatorRole(context);
      await ensureMutationHydrated();
      const newsletterParsed = MutationPrepareNewsletterSchema.safeParse(params);
      if (newsletterParsed.success) {
        return modules.newsletterMutation.preparePublish(newsletterParsed.data, { correlationId });
      }
      const notionParsed = MutationPrepareNotionSchema.safeParse(params);
      if (notionParsed.success) {
        return modules.notionMutation.preparePublish(notionParsed.data, { correlationId });
      }
      throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for mutation.preparePublication", {
        newsletterIssues: newsletterParsed.error.issues,
        notionIssues: notionParsed.error.issues
      });
    }

    if (normalizedMethod === MCP_METHODS.MUTATION_COMMIT_PUBLICATION) {
      assertOperatorRole(context);
      await ensureMutationHydrated();
      const parsed = MutationSequenceSchema.safeParse(params);
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for mutation.commitPublication", { issues: parsed.error.issues });
      }
      return mutationControl.commitPublication(parsed.data, { correlationId });
    }

    if (normalizedMethod === MCP_METHODS.MUTATION_RETRY_PUBLICATION) {
      assertOperatorRole(context);
      await ensureMutationHydrated();
      const parsed = MutationSequenceSchema.safeParse(params);
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for mutation.retryPublication", { issues: parsed.error.issues });
      }
      return mutationControl.retryPublication(parsed.data, { correlationId });
    }

    if (normalizedMethod === MCP_METHODS.MUTATION_RECONCILE_PUBLICATION) {
      assertOperatorRole(context);
      await ensureMutationHydrated();
      const parsed = MutationReconcileSchema.safeParse(params);
      if (!parsed.success) {
        throw createMcpError("MCP_INVALID_PARAMS", "Invalid params for mutation.reconcilePublication", { issues: parsed.error.issues });
      }
      return mutationControl.reconcilePublication(parsed.data, { correlationId });
    }

    throw createMcpError("MCP_METHOD_NOT_ALLOWED", `Unsupported MCP method '${String(method || "").trim()}'`);
  }

  async function verifyStoredReplay() {
    const records = await apiGovernance.loadResearchRecords();
    let expectedSequence = 1;
    for (const record of records) {
      if (Number(record.sequence) !== expectedSequence) {
        throw createMcpError("MCP_SEQUENCE_NON_DETERMINISTIC", "Stored record sequence is non-contiguous", {
          expectedSequence,
          actual: record.sequence
        });
      }
      BaseMcp.verifyRecordHash(record);
      expectedSequence += 1;
    }
    return {
      ok: true,
      count: records.length
    };
  }

  return Object.freeze({
    initialize,
    handle,
    verifyStoredReplay,
    apiGovernance,
    operatorAuthorization,
    mutationControl,
    modules
  });
}

module.exports = {
  createMcpService,
  SearchParamsSchema,
  GetPaperParamsSchema,
  FORBIDDEN_OVERRIDE_FIELDS
};
