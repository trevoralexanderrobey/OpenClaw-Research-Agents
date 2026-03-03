# MCP Contracts (Phase 3)

## Active contract scaffolds
- `arxiv-scholar-mcp`
- `semantic-scholar-mcp`

## Stub-only contracts
- `newsletter-publisher-mcp`
- `notion-sync-mcp`

## Validation requirements
- Strict Zod object schemas.
- Unknown fields rejected.
- Bounded pagination/depth.
- Deterministic canonical record schema with version-salted hash.

## Runtime boundary
Publisher/sync MCPs are non-operational and must return `MCP_NOT_IMPLEMENTED`.
