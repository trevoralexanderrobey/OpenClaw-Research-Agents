# Security Baseline

## Container isolation baseline
- Non-root user
- Read-only root filesystem
- Capabilities dropped (`ALL`)
- `Privileged=false`
- No host PID/network
- No host bind mounts
- Writable `/scratch` only
- Deterministic runtime and output bounds

## Policy authorities
- `execution/tool-image-catalog.js`
- `execution/sandbox-policy.js`
- `execution/resource-policy.js`
- `execution/egress-policy.js`
- `execution/image-policy.js`
- `execution/container-runtime.js`

## Supervisor boundary
- Supervisor role cannot invoke non-`supervisor.*` tools in execution router.
- Legacy external tool fallback is disabled for supervisor role.

## Freeze controls
- Outbound mutation feature flags disabled by default in `openclaw.json`.

## Workload integrity
- SBOM artifacts generated for supply-chain provenance.
- Lockfile, cache, and code registry checksums formally verified.
- Container digests validated before any runtime action.

## RLHF Compliance
- All generated drafts enforced as AI-assisted with required manual review.
- Automated submission paths and credential usage strictly prohibited.
- Replay-safe internal queue management tied directly to governance transactions.

## Outcome Ingestion Boundary
- Ingestion, calibration, and portfolio planning mutations are operator-only and kill-switch gated.
- Autonomous intelligence extraction via browser or platforms is denied.
- Outcome persistence enforces idempotency keys, chain-hash integrity, and strict sequence anchoring.

## Experiment Governance Boundary
- Mutation endpoints for creation, analysis, and rollout are explicitly operator-only.
- Decision verification enforces ledger chain-hash integrity and chain-head anchoring that fail closed.
- Autonomous rollout or automatic external submission of treatments is explicitly denied.

## Compliance and Evidence Boundary
- Evidence generation and compliance attestations are entirely deterministic and internal.
- Tamper-evident governance requires operator authority for any release decision modifications.
- Autonomous attestation publishing or remote evidence submission pathways are blocked.

## Governance Automation Boundary
- Drift and Remediation output enforces operator-only approval mapping.
- Automatic baseline modifications are denied; remediation requests must remain read-only outputs until manually applied.
- All Phase checks verify and fail-closed prior to opening the execution interfaces.

## Operational Resilience Boundary
- Automated remediation and dynamic egress expansion are strictly prohibited.
- Alerting mechanisms are advisory-only; runbook execution demands operator confirmation.
- External attestation anchoring requires explicit operator opt-in and strict allowlist enforcement.

## Recovery Assurance Boundary
- Autonomous restore procedures or dynamic backup failovers are completely prohibited.
- Restore endpoints require operator scope, explicit confirmation, and immutable ledger recording.
- All tabletop drill modules operate in a strictly advisory/read-only mode.

## Supply Chain Security Boundary
- Autonomous dependency patches, resolution, and external registry downloads remain prohibited.
- Integrations require operator override roles and tokenized workflows strictly through the decision ledger.

## Access Control & Identity Governance Boundary
- Entirely local system prohibiting network IdP dependencies.
- Prevents any automated lifecycle rotation actions outside strict authorized governance token loops.

## Agent Autonomy & Ingestion Boundary (Phase 14-17)
- Direct agent automation execution paths without operator/supervisor gate approvals strictly fail.
- Re-injected resume loops cannot bypass or substitute previously completed local authorization verifications.
- Network activity is formally isolated to verified MCP endpoints and the scoped `openclaw-bridge/core/llm-adapter.js` interface.

## Live Verification & Probe Execution Boundary
- Live executing probes connecting to LLMs or valid MCP components are restricted entirely to internal read-only verifications, prohibiting external mutations or automated unapproved side-effects.

## Spawner & Orchestrator Boundary (Phase 18)
- Generated/spawned agents cannot independently escape their restricted sandbox loop to invoke actual MCP integrations, external tool bindings, or system shells. Only safe stubs (`research_only`, `draft_artifact`) are permitted live.
- All live side effects must route strictly through existing bounded worker execution paths (`role-router` -> `agent-engine`).

## Dataset & Monetization Boundary (Phase 19)
- Phase 19 release bundles act strictly as packaging artifacts and must never execute automated deployment over external web/provider portals.
- Final release approval is always a gated, manual, human-only checkpoint.
- External publishing, target upload procedures, submission pack delivery routing, web portal login automation, and customer interfacing remain unconditionally manual-only.

## Commercialization & Licensing Boundary (Phase 20)
- Provenance tracking maps ensure all data ingested is internally verified for commercial release thresholds.
- Unknown or mismatched upstream license rights are explicitly fail-closed and prohibited from commercial dataset staging.
- Automated QA (deduplication, scoring) operates on internal datasets only and cannot modify or contact external upstream source repositories directly.

## Publisher Adapter Boundary (Phase 21)
- Platform-specific submission packs are deterministically generated purely as offline artifacts governed by validated adapter manifests.
- Adapters retain exactly zero network egress rights, prohibiting browser automation, headless login flows, or active submission API usage.

## Manual Submission Evidence Boundary (Phase 22)
- Post-export deployment governance relies entirely on a deterministic, append-only cryptographic ledger tracking operator actions.
- Any recording of submission status outcomes (e.g. `manual_submission_complete`) requires explicit, operator-provided transaction updates.
- External monitoring tools or automated systems are explicitly forbidden from deriving or updating the authoritative ledger state autonomously.

## GitHub Actions CI Verification
- Cloud-hosted continuous integration (GitHub Actions) serves as the primary verification boundary for branch protection.
- The workflow enforces that policy gates (`npm run phase2:gates`) and deterministic builds (`npm run build:verify`) pass before merging.
- Local githooks are not part of the required repository boundary and may be skipped or unset by developers.

## Outer Operator Workflow Boundary (Cline-compatible)
- External operational tools (e.g., Cline via Plan/Act mode) are recommended for repo modifications but maintain no direct internal runtime permissions or hooks.
- "YOLO" execution mode is strictly prohibited for governed workflows; auto-confirmations must be conservatively scoped to local read/edit actions only.
- Core execution logic remains tool-agnostic; local enforcement (via `supervisor-authority`) isolates repo operations from outer shell extensions.
