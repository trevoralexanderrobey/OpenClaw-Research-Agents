"use strict";

const { z } = require("zod");

const { BaseMcp, normalizeAuthors, normalizeText, stripHtml } = require("./base-mcp.js");

const SemanticScholarInputSchema = z
  .object({
    action: z.enum(["search", "getPaper"]),
    query: z.string().min(3).max(512).optional(),
    paper_id: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(50).default(10)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "search" && !value.query) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "query is required for search" });
    }
    if (value.action === "getPaper" && !value.paper_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "paper_id is required for getPaper" });
    }
  });

class SemanticScholarMcp extends BaseMcp {
  constructor(options = {}) {
    super({
      ...options,
      mcpSlug: "semantic-scholar-mcp",
      source: "semantic-scholar",
      inputSchema: SemanticScholarInputSchema
    });
  }

  async execute(input, context) {
    if (input.action === "search") {
      const fields = ["paperId", "title", "abstract", "authors", "citationCount", "year", "publicationDate"].join(",");
      const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
      url.searchParams.set("query", input.query);
      url.searchParams.set("limit", String(input.limit || 10));
      url.searchParams.set("fields", fields);
      const payload = await this.policyValidatedGetJson(url.toString(), context);
      return Array.isArray(payload && payload.data) ? payload.data : [];
    }

    const fields = ["paperId", "title", "abstract", "authors", "citationCount", "year", "publicationDate"].join(",");
    const paperUrl = new URL(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(input.paper_id)}`);
    paperUrl.searchParams.set("fields", fields);
    const payload = await this.policyValidatedGetJson(paperUrl.toString(), context);
    return payload ? [payload] : [];
  }

  normalizeRecord(rawRecord, context) {
    const abstract = stripHtml(rawRecord && rawRecord.abstract);
    if (abstract.length > this.maxAbstractChars) {
      const error = new Error(`abstract exceeds max length (${this.maxAbstractChars})`);
      error.code = "MCP_OUTPUT_SCHEMA_INVALID";
      throw error;
    }
    const normalized = {
      source: "semantic-scholar",
      paper_id: normalizeText(rawRecord && rawRecord.paperId ? rawRecord.paperId : rawRecord && rawRecord.paper_id, 256),
      title: normalizeText(rawRecord && rawRecord.title, 2000),
      abstract,
      authors: normalizeAuthors(rawRecord && rawRecord.authors),
      citation_velocity: Number.isFinite(Number(rawRecord && rawRecord.citationCount))
        ? Math.max(0, Math.floor(Number(rawRecord.citationCount)))
        : 0,
      published_at: normalizeText(rawRecord && (rawRecord.publicationDate || rawRecord.year), 64) || "1970-01-01T00:00:00.000Z",
      retrieved_at: this.timeProvider.nowIso()
    };

    return {
      ...normalized,
      hash: this.constructor.computeRecordHash(normalized)
    };
  }
}

function createSemanticScholarMcp(options) {
  return new SemanticScholarMcp(options);
}

module.exports = {
  SemanticScholarInputSchema,
  SemanticScholarMcp,
  createSemanticScholarMcp
};
