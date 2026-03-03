"use strict";

const { z } = require("zod");

const { BaseMcp } = require("./base-mcp.js");
const { assertAllowedDatabaseId, assertAllowedProperties } = require("../../security/notion-policy.js");

const PrepareNotionSchema = z.object({
  databaseId: z.string().min(1).max(128),
  properties: z.record(z.any()),
  content: z.array(z.record(z.any())).max(50).optional(),
  approvalToken: z.string().min(8).max(256)
}).strict();

const SequenceActionSchema = z.object({
  sequence: z.number().int().min(1),
  approvalToken: z.string().min(8).max(256),
  provider: z.literal("notion").optional(),
  externalId: z.string().min(1).max(256).optional(),
  action: z.enum(["confirm_committed", "confirm_not_committed", "abandon"]).optional()
}).strict();

class NotionMcp extends BaseMcp {
  constructor(options = {}) {
    super({
      ...options,
      mcpSlug: "notion-sync-mcp",
      source: "notion",
      inputSchema: z.object({ noop: z.boolean().optional() }).strict()
    });
    this.mutationControl = options.mutationControl;
    this.notionApiBase = "https://api.notion.com/v1";
    if (!this.mutationControl) {
      const error = new Error("mutationControl is required");
      error.code = "NOTION_MCP_CONFIG_INVALID";
      throw error;
    }
  }

  async preparePublish(input, context = {}) {
    const parsed = PrepareNotionSchema.parse(input || {});
    const databaseId = assertAllowedDatabaseId(parsed.databaseId);
    assertAllowedProperties(parsed.properties);

    const payload = {
      parent: {
        database_id: databaseId
      },
      properties: parsed.properties,
      children: parsed.content || []
    };

    return this.mutationControl.preparePublication({
      provider: "notion",
      method: "POST",
      url: `${this.notionApiBase}/pages`,
      payload,
      approvalToken: parsed.approvalToken
    }, context);
  }

  async commitPublish(input, context = {}) {
    const parsed = SequenceActionSchema.parse({ ...input, provider: "notion" });
    return this.mutationControl.commitPublication(parsed, context);
  }

  async retryPublish(input, context = {}) {
    const parsed = SequenceActionSchema.parse({ ...input, provider: "notion" });
    return this.mutationControl.retryPublication(parsed, context);
  }

  async reconcilePublish(input, context = {}) {
    const parsed = SequenceActionSchema.parse({ ...input, provider: "notion" });
    return this.mutationControl.reconcilePublication(parsed, context);
  }

  execute() {
    const error = new Error("Notion mutation MCP does not support research execute() flow");
    error.code = "MCP_NOT_IMPLEMENTED";
    throw error;
  }
}

function createNotionMcp(options) {
  return new NotionMcp(options);
}

module.exports = {
  NotionMcp,
  createNotionMcp,
  PrepareNotionSchema,
  SequenceActionSchema
};
