"use strict";

const { z } = require("zod");

const { BaseMcp, normalizeText, stripHtml } = require("./base-mcp.js");

const ArxivInputSchema = z
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

function extractTag(entry, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = String(entry || "").match(regex);
  if (!match) {
    return "";
  }
  return normalizeText(match[1], 4000);
}

function extractAllAuthorNames(entry) {
  const names = [];
  const pattern = /<author>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi;
  let match = pattern.exec(String(entry || ""));
  while (match) {
    const name = normalizeText(match[1], 256);
    if (name) {
      names.push(name);
    }
    match = pattern.exec(String(entry || ""));
  }
  return names;
}

function parseArxivFeed(xml) {
  const source = String(xml || "");
  const entries = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/gi;
  let match = entryPattern.exec(source);
  while (match) {
    entries.push(match[1]);
    match = entryPattern.exec(source);
  }
  return entries.map((entry) => {
    const rawId = extractTag(entry, "id");
    const paperId = rawId.includes("/abs/") ? rawId.split("/abs/").pop() : rawId;
    return {
      paper_id: paperId,
      title: extractTag(entry, "title"),
      abstract: extractTag(entry, "summary"),
      authors: extractAllAuthorNames(entry),
      published_at: extractTag(entry, "published") || "1970-01-01T00:00:00.000Z"
    };
  });
}

class ArxivMcp extends BaseMcp {
  constructor(options = {}) {
    super({
      ...options,
      mcpSlug: "arxiv-scholar-mcp",
      source: "arxiv",
      inputSchema: ArxivInputSchema
    });
  }

  async execute(input, context) {
    if (input.action === "search") {
      const url = new URL("https://export.arxiv.org/api/query");
      url.searchParams.set("search_query", `all:${input.query}`);
      url.searchParams.set("start", "0");
      url.searchParams.set("max_results", String(input.limit || 10));
      const body = await this.policyValidatedGetText(url.toString(), context);
      return parseArxivFeed(body);
    }

    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("id_list", input.paper_id);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", "1");
    const body = await this.policyValidatedGetText(url.toString(), context);
    const entries = parseArxivFeed(body);
    return entries.length > 0 ? [entries[0]] : [];
  }

  normalizeRecord(rawRecord) {
    const abstract = stripHtml(rawRecord && rawRecord.abstract);
    if (abstract.length > this.maxAbstractChars) {
      const error = new Error(`abstract exceeds max length (${this.maxAbstractChars})`);
      error.code = "MCP_OUTPUT_SCHEMA_INVALID";
      throw error;
    }
    const normalized = {
      source: "arxiv",
      paper_id: normalizeText(rawRecord && rawRecord.paper_id, 256),
      title: normalizeText(rawRecord && rawRecord.title, 2000),
      abstract,
      authors: Array.isArray(rawRecord && rawRecord.authors)
        ? rawRecord.authors.map((author) => normalizeText(author, 256)).filter(Boolean)
        : [],
      citation_velocity: 0,
      published_at: normalizeText(rawRecord && rawRecord.published_at, 64) || "1970-01-01T00:00:00.000Z",
      retrieved_at: this.timeProvider.nowIso()
    };

    return {
      ...normalized,
      hash: this.constructor.computeRecordHash(normalized)
    };
  }
}

function createArxivMcp(options) {
  return new ArxivMcp(options);
}

module.exports = {
  ArxivInputSchema,
  ArxivMcp,
  createArxivMcp,
  parseArxivFeed
};
