"use strict";

const { z } = require("zod");

const { BaseMcp, MCP_ERROR_CODES } = require("./base-mcp.js");

const NotionInputSchema = z
  .object({
    action: z.enum(["create_page", "update_page", "sync_database"]),
    payload: z.record(z.any()).optional()
  })
  .strict();

class NotionMcpStub extends BaseMcp {
  constructor(options = {}) {
    super({
      ...options,
      mcpSlug: "notion-sync-mcp",
      source: "notion",
      inputSchema: NotionInputSchema
    });
  }

  async execute() {
    const error = new Error("Notion sync publishing is disabled in Phase 3");
    error.code = MCP_ERROR_CODES.NOT_IMPLEMENTED;
    throw error;
  }
}

function createNotionMcpStub(options) {
  return new NotionMcpStub(options);
}

module.exports = {
  NotionInputSchema,
  NotionMcpStub,
  createNotionMcpStub
};
