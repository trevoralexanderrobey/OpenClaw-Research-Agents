"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { NotionMcp } = require("../../openclaw-bridge/mcp/notion-mcp.js");

test("notion MCP enforces database/property allowlists and uses preparePublication", async () => {
  let called = null;
  const mcp = new NotionMcp({
    mutationControl: {
      async preparePublication(input) {
        called = input;
        return { ok: true, sequence: 1 };
      },
      async commitPublication() { return { ok: true }; },
      async retryPublication() { return { ok: true }; },
      async reconcilePublication() { return { ok: true }; }
    }
  });

  await assert.rejects(
    () =>
      mcp.preparePublish({
        databaseId: "db_untrusted",
        properties: { Name: { title: [] } },
        approvalToken: "cred_token_123456"
      }),
    (error) => error && error.code === "NOTION_DATABASE_NOT_ALLOWLISTED"
  );

  await assert.rejects(
    () =>
      mcp.preparePublish({
        databaseId: "db_openclaw_publications",
        properties: { Dangerous: { rich_text: [] } },
        approvalToken: "cred_token_123456"
      }),
    (error) => error && error.code === "NOTION_PROPERTY_NOT_ALLOWLISTED"
  );

  const prepared = await mcp.preparePublish({
    databaseId: "db_openclaw_publications",
    properties: { Name: { title: [] }, Summary: { rich_text: [] } },
    content: [],
    approvalToken: "cred_token_123456"
  });

  assert.equal(prepared.ok, true);
  assert.equal(Boolean(called), true);
  assert.equal(called.provider, "notion");
  assert.equal(called.method, "POST");
});
