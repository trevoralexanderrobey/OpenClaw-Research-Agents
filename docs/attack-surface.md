# Attack Surface Enumeration (Phase 5)

## Open Ports
- `127.0.0.1:18789` (bridge control plane)
- No non-localhost bind allowed.

## MCP Routing Surface
- `GET /mcp/sse` and `POST /mcp/messages` for supervisor research/analytics methods.
- `POST /operator/mcp/messages` for operator-only mutation control methods.

Mitigation:
- Strict JSON-RPC schema validation.
- Batch requests rejected.
- 32KB body cap.
- Method allowlists split by route.
- Supervisor route has no mutation methods.

## Outbound Read Surface
- Static read hosts:
  - `api.semanticscholar.org`
  - `export.arxiv.org`

## Outbound Mutation Surface
- Static write hosts:
  - `api.beehiiv.com`
  - `api.notion.com`

## RLHF Internal Workflow Surface
- Internal modules only:
  - `workflows/rlhf-generator/*`
  - `workflows/rlhf-review.js`
- No external submission endpoints are defined.
- No browser, login, or credential automation exists in RLHF modules.
- Draft generation, linting, persistence, review queueing, and package export are local-only operations.

Mitigation:
- Default egress deny-all.
- HTTPS required.
- Raw IP literals denied.
- DNS resolved once per request and pinned for request lifetime.
- Post-resolution IP safety checks deny RFC1918/loopback/link-local/ULA ranges.
- Method allowlist enforced per domain.
- TLS is explicit and non-overridable:
  - `rejectUnauthorized: true`
  - hostname verification against original allowlisted hostname
  - no custom CA/cert/key/agent injection
  - `NODE_TLS_REJECT_UNAUTHORIZED=0` forbidden for mutation requests

## Mutation Control Surface
- Mutation requires explicit operator approval tokens.
- Kill-switch is global and fail-closed.
- `enabled` must be true at both prepare and commit.
- Two-phase commit only (`prepare` then `commit`).
- Replay protection prevents duplicate external side effects.

## Audit Surface
- Mutation attempts logged to `workspace/memory/mutation-attempts.ndjson`.
- Each entry includes hash chain fields (`entryHash`, `prevChainHash`, `chainHash`).
- State stores log tip hash (`outboundMutation.mutationLogTipHash`) and startup verifies chain.
- RLHF drafts may be mirrored in deterministic artifact store `workspace/memory/rlhf-drafts.ndjson`.
- RLHF manual package output is local-only at `workspace/memory/rlhf-manual-packages/`.

## Container/Credential Boundaries
- Non-root, non-privileged, no host-network, read-only rootfs.
- Per-MCP credential handle isolation and writable namespace isolation.
- No raw API keys in env or logs.
