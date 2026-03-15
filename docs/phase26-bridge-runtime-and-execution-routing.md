# Phase 26A Bridge Runtime and Execution Routing (Prerequisite Slice)

Phase 26A is the minimal bridge/auth/principal prerequisite slice required for Phase 27.
It is not full Phase 26 consolidation.

## Scope
- Add MCP Streamable HTTP support at `/mcp` (GET/POST).
- Add shared bearer-token principal resolution for:
  - `/mcp`
  - `/mcp/sse`
  - `/mcp/events`
  - `/mcp/messages`
  - `/operator/mcp/messages`
  - `/jobs*`
- Keep `/health` unauthenticated.
- Enforce principal lane separation:
  - `supervisor`
  - `operator`
  - `integration_hatchify`

## Stop Condition
- `/mcp` Streamable HTTP is operational.
- Shared auth/principal resolution is in place on all required routes.
- Legacy MCP route auth coverage is enforced.
- `integration_hatchify` cannot enter operator/supervisor-only lanes.
- Proving tests pass.

## Non-goals
- No Sider export/re-entry implementation.
- No browser automation.
- No login automation.
- No background sync.
- No bidirectional integration.
