"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { NewsletterMcp } = require("../../openclaw-bridge/mcp/newsletter-mcp.js");

test("newsletter MCP prepare enforces html/link guards and uses preparePublication", async () => {
  let called = null;
  const mcp = new NewsletterMcp({
    mutationControl: {
      async preparePublication(input) {
        called = input;
        return { ok: true, sequence: 1 };
      },
      async commitPublication() { return { ok: true }; },
      async retryPublication() { return { ok: true }; },
      async reconcilePublication() { return { ok: true }; }
    },
    allowedExternalHosts: ["example.com"]
  });

  await assert.rejects(
    () =>
      mcp.preparePublish({
        publicationId: "pub",
        title: "title",
        html: "<script>alert(1)</script>",
        approvalToken: "cred_token_123456"
      }),
    (error) => error && error.code === "NEWSLETTER_HTML_INJECTION_DETECTED"
  );

  await assert.rejects(
    () =>
      mcp.preparePublish({
        publicationId: "pub",
        title: "title",
        html: "<p>go https://evil.example</p>",
        approvalToken: "cred_token_123456"
      }),
    (error) => error && error.code === "NEWSLETTER_EXTERNAL_LINK_NOT_ALLOWLISTED"
  );

  const prepared = await mcp.preparePublish({
    publicationId: "pub",
    title: "title",
    html: "<p>go https://example.com/path</p>",
    approvalToken: "cred_token_123456"
  });

  assert.equal(prepared.ok, true);
  assert.equal(Boolean(called), true);
  assert.equal(called.provider, "newsletter");
  assert.equal(called.method, "POST");
});
