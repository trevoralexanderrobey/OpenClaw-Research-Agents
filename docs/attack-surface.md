# Attack Surface Enumeration (Phase 8)

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

## Cline supervisor boundary
- Cline supervisor boundary is enforced as orchestration-only interface behavior.
- Cline supervisor traffic is non-mutation by default and cannot bypass operator mutation boundaries.
- Cline supervisor policy verification is a blocking CI gate.

## Outbound Read Surface
- Static read hosts:
  - `api.semanticscholar.org`
  - `export.arxiv.org`

## Outbound Mutation Surface
- Static write hosts:
  - `api.beehiiv.com`
  - `api.notion.com`
- No additional outbound hosts are introduced by Phase 6.
- No additional outbound hosts are introduced by Phase 7.
- No new egress domains or dynamic endpoint expansion is permitted by Cline supervisor hardening.

## RLHF Internal Workflow Surface
- Internal modules only:
  - `workflows/rlhf-generator/*`
  - `workflows/rlhf-review.js`
- No external submission endpoints are defined.
- No browser, login, or credential automation exists in RLHF modules.
- Draft generation, linting, persistence, review queueing, and package export are local-only operations.

## Phase 6 Outcome Intelligence Surface
- Internal-only modules:
  - `workflows/rlhf-outcomes/*`
  - `analytics/rlhf-quality/*`
  - `analytics/portfolio-intelligence/*`
- Outcome ingestion is operator-entered only with explicit idempotency keys.
- Outcome artifact stream (`workspace/memory/rlhf-outcomes.ndjson`) is append-only with outcome and chain hashes.
- Canonical state anchors (`rlhfOutcomes.chainHeadHash`, `rlhfOutcomes.chainHeadSequence`) are cross-checked at startup; mismatch fails closed.
- Calibration and outcome write paths are kill-switch-gated and operator-only.
- Portfolio planning/reporting is read-only and does not trigger external actions.

## Phase 7 Experiment Governance Surface
- Internal-only modules:
  - `workflows/experiment-governance/*`
  - `analytics/experiment-explainability/*`
  - `security/phase7-startup-integrity.js`
- No external submission methods are added.
- No browser/login automation, credential automation, or anti-detection behavior is added.
- No new egress domains or dynamic endpoint expansion is introduced.
- Protected mutation paths are operator-only, approval-token-scoped, transaction-bound, and kill-switch-gated:
  - lifecycle (`create`, `approve`, `start`, `pause`, `complete`, `archive`)
  - assignment (`assignDraftToExperiment`)
  - analysis snapshot capture (`captureAnalysisSnapshot`)
  - rollout apply (`applyRolloutDecision`)
  - ledger tail repair (`repairDecisionLedgerTail`)
- Startup performs mandatory fail-closed Phase 7 integrity checks before MCP method handling.

## Phase 8 Compliance Governance Surface
- Internal-only modules:
  - `workflows/compliance-governance/*`
  - `analytics/compliance-explainability/*`
  - `security/phase8-startup-integrity.js`
- No external submission methods are added.
- No browser/login automation, credential automation, or anti-detection behavior is added.
- No new egress domains or dynamic endpoint expansion is introduced.
- No new outbound mutation surface is introduced by Phase 8.
- Protected mutation paths are operator-only, approval-token-scoped, transaction-bound, and kill-switch-gated:
  - runtime attestation capture (`captureRuntimeAttestation`)
  - evidence bundle build (`buildEvidenceBundle`)
  - release gate apply (`applyReleaseGateDecision`)
  - compliance ledger tail repair (`repairComplianceLedgerTail`)
- Startup performs mandatory fail-closed Phase 8 integrity checks before MCP method handling.

## Phase 9 Governance Automation & Escalation Surface
- Internal-only modules:
  - `workflows/governance-automation/*`
  - `security/phase9-startup-integrity.js`
- Monitoring and drift detection paths are read-only and do not execute external actions.
- Remediation recommender is output-only; it generates operator review artifacts and does not apply changes automatically.
- Override execution remains operator-only, approval-token-scoped, transaction-bound, and kill-switch-gated.
- No browser/login automation, credential automation, or autonomous external submission is introduced.
- No new egress domains or dynamic endpoint expansion is introduced.
- Startup performs mandatory fail-closed Phase 9 integrity checks before MCP method handling.

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
