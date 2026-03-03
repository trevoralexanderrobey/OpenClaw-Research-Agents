"use strict";

const { z } = require("zod");

const { BaseMcp } = require("./base-mcp.js");

const DANGEROUS_HTML_PATTERN = /<\s*script\b|on\w+\s*=|javascript:/i;

const PrepareNewsletterSchema = z.object({
  publicationId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  html: z.string().min(1).max(50000),
  slug: z.string().min(1).max(128).optional(),
  tags: z.array(z.string().min(1).max(32)).max(20).optional(),
  approvalToken: z.string().min(8).max(256)
}).strict();

const SequenceActionSchema = z.object({
  sequence: z.number().int().min(1),
  approvalToken: z.string().min(8).max(256),
  provider: z.literal("newsletter").optional(),
  externalId: z.string().min(1).max(256).optional(),
  action: z.enum(["confirm_committed", "confirm_not_committed", "abandon"]).optional()
}).strict();

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractLinks(html) {
  const links = String(html || "").match(/https?:\/\/[^\s"'<>)]+/gi);
  return Array.isArray(links) ? links : [];
}

function assertAllowedExternalLinks(html, allowedHosts = []) {
  const allowlist = Array.isArray(allowedHosts) ? allowedHosts.map((host) => normalizeString(host).toLowerCase()).filter(Boolean) : [];
  const links = extractLinks(html);
  for (const link of links) {
    let host = "";
    try {
      host = new URL(link).hostname.toLowerCase();
    } catch {
      throw Object.assign(new Error(`Invalid external link '${link}'`), { code: "NEWSLETTER_EXTERNAL_LINK_INVALID" });
    }
    if (allowlist.length > 0 && !allowlist.includes(host)) {
      throw Object.assign(new Error(`External link host '${host}' is not allowlisted`), { code: "NEWSLETTER_EXTERNAL_LINK_NOT_ALLOWLISTED" });
    }
  }
}

class NewsletterMcp extends BaseMcp {
  constructor(options = {}) {
    super({
      ...options,
      mcpSlug: "newsletter-publisher-mcp",
      source: "newsletter",
      inputSchema: z.object({ noop: z.boolean().optional() }).strict()
    });
    this.mutationControl = options.mutationControl;
    this.beehiivApiBase = normalizeString(options.beehiivApiBase) || "https://api.beehiiv.com/v2";
    this.allowedExternalHosts = Array.isArray(options.allowedExternalHosts) ? options.allowedExternalHosts : [];

    if (!this.mutationControl) {
      const error = new Error("mutationControl is required");
      error.code = "NEWSLETTER_MCP_CONFIG_INVALID";
      throw error;
    }
  }

  // Mutation path intentionally bypasses BaseMcp.run() research record workflow.
  async preparePublish(input, context = {}) {
    const parsed = PrepareNewsletterSchema.parse(input || {});
    if (DANGEROUS_HTML_PATTERN.test(parsed.html)) {
      const error = new Error("Newsletter HTML contains disallowed script/injection pattern");
      error.code = "NEWSLETTER_HTML_INJECTION_DETECTED";
      throw error;
    }
    assertAllowedExternalLinks(parsed.html, this.allowedExternalHosts);

    const payload = {
      title: parsed.title,
      html: parsed.html,
      slug: parsed.slug || undefined,
      tags: parsed.tags || []
    };

    return this.mutationControl.preparePublication({
      provider: "newsletter",
      method: "POST",
      url: `${this.beehiivApiBase}/publications/${encodeURIComponent(parsed.publicationId)}/posts`,
      payload,
      approvalToken: parsed.approvalToken
    }, context);
  }

  async commitPublish(input, context = {}) {
    const parsed = SequenceActionSchema.parse({ ...input, provider: "newsletter" });
    return this.mutationControl.commitPublication(parsed, context);
  }

  async retryPublish(input, context = {}) {
    const parsed = SequenceActionSchema.parse({ ...input, provider: "newsletter" });
    return this.mutationControl.retryPublication(parsed, context);
  }

  async reconcilePublish(input, context = {}) {
    const parsed = SequenceActionSchema.parse({ ...input, provider: "newsletter" });
    return this.mutationControl.reconcilePublication(parsed, context);
  }

  execute() {
    const error = new Error("Newsletter mutation MCP does not support research execute() flow");
    error.code = "MCP_NOT_IMPLEMENTED";
    throw error;
  }
}

function createNewsletterMcp(options) {
  return new NewsletterMcp(options);
}

module.exports = {
  NewsletterMcp,
  createNewsletterMcp,
  PrepareNewsletterSchema,
  SequenceActionSchema
};
