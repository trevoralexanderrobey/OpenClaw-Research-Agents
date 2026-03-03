"use strict";

const { z } = require("zod");

const { BaseMcp, MCP_ERROR_CODES } = require("./base-mcp.js");

const NewsletterInputSchema = z
  .object({
    action: z.enum(["draft", "schedule", "publish"]),
    content: z.string().max(5000).optional()
  })
  .strict();

class NewsletterMcpStub extends BaseMcp {
  constructor(options = {}) {
    super({
      ...options,
      mcpSlug: "newsletter-publisher-mcp",
      source: "newsletter",
      inputSchema: NewsletterInputSchema
    });
  }

  async execute() {
    const error = new Error("Newsletter publishing is disabled in Phase 3");
    error.code = MCP_ERROR_CODES.NOT_IMPLEMENTED;
    throw error;
  }
}

function createNewsletterMcpStub(options) {
  return new NewsletterMcpStub(options);
}

module.exports = {
  NewsletterInputSchema,
  NewsletterMcpStub,
  createNewsletterMcpStub
};
