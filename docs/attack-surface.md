# Attack Surface Enumeration (Phase 17)

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
- No new global outbound hosts are introduced by Phase 10 observability/incident workflows.
- Phase 10 optional external attestation anchoring uses a dedicated static allowlist (`security/phase10-attestation-egress-allowlist.json`) and is operator-initiated only.

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

## Phase 10 Operational Resilience & Response Surface
- Internal-only modules:
  - `workflows/observability/*`
  - `workflows/runbook-automation/*`
  - `workflows/incident-management/*`
  - `security/phase10-startup-integrity.js`
- Alerting is advisory-only; alerts never trigger automatic remediation.
- Runbook orchestration is operator-approved only (`approval token + confirm`) and does not auto-execute on timers.
- Incident artifacts are deterministic JSON records and do not mutate protected runtime mutation state.
- Escalation is notification-only by severity tier; no mutation execution path exists.
- Optional external attestation anchoring:
  - requires explicit operator role
  - requires scoped token `governance.attestation.anchor`
  - requires explicit `--external-service` URL
  - enforces static host allowlist and blocked-by-default egress
  - is never auto-triggered by alerts/runbooks
- Startup performs mandatory fail-closed Phase 10 integrity checks before MCP method handling.

## Phase 11 Recovery Assurance & Continuity Surface
- Internal-only modules:
  - `workflows/recovery-assurance/*`
  - `security/phase11-startup-integrity.js`
- Deterministic checkpoint and backup manifest pipeline is local-only and does not egress/upload.
- Backup integrity verification is read-only and fails closed on hash-chain/artifact mismatches.
- Restore orchestration is operator-only and requires:
  - scope `governance.recovery.restore`
  - approval token consumption
  - explicit confirmation
  - immutable override + operational decision ledger entries
- Default restore execution mode is simulation (fail-closed) unless an explicit restore executor is injected.
- Continuity SLO evaluation, tabletop drills, and failover readiness outputs are advisory-only and cannot trigger restore/failover automatically.
- No browser/login/credential automation, autonomous restore/failover, or dynamic endpoint expansion is introduced.
- Startup performs mandatory fail-closed Phase 11 integrity checks before MCP method handling.

## Phase 12 Supply Chain Security & Provenance Surface
- Internal-only modules:
  - `workflows/supply-chain/*`
  - `security/phase12-startup-integrity.js`
- SBOM generation is local-only from `package.json` and `package-lock.json`; no registry lookups or feed downloads.
- Dependency integrity verification is local-only against committed known-good manifest:
  - `security/known-good-dependencies.json`
- Vulnerability scanning is advisory-only from committed local advisory DB:
  - `security/vulnerability-advisories.json`
- Dependency update governance is operator-only and requires:
  - scope `governance.supply_chain.update`
  - approval token consumption
  - explicit confirmation
  - immutable override + operational decision ledger entries
- Update apply path modifies known-good manifest only; package installation remains manual operator action.
- Build provenance and artifact signing are local-only deterministic workflows.
- Artifact signing uses local HMAC key material (`security/artifact-signing-key.json`) with committed template (`security/artifact-signing-key.sample.json`).
- No browser/login/credential automation, autonomous update/patch/install, external KMS/CA, or dynamic endpoint expansion is introduced.
- Startup performs mandatory fail-closed Phase 12 integrity checks before MCP method handling.

## Phase 13 Access Control & Identity Governance Surface
- Internal-only modules:
  - `workflows/access-control/*`
  - `security/phase13-startup-integrity.js`
- Identity and access state is local filesystem only:
  - `security/rbac-policy.json`
  - `security/scope-registry.json`
  - runtime stores (`security/token-store.json`, `security/access-decision-ledger.json`, `security/session-store.json`) are gitignored.
- No external identity providers, OAuth/LDAP/SAML flows, remote auth services, or browser login automation are introduced.
- Token lifecycle operations (`issue`, `rotate`, `revoke`) are operator-initiated only and require explicit confirmation.
- Permission boundary enforcement is fail-closed for unknown role/scope/token and expired/revoked token paths.
- Legacy admin fallback is constrained to approved legacy token-consumption call paths with approval token presence; no-token/no-role paths are denied.
- Access decisions are immutably chain-hashed in a dedicated Phase 13 access decision ledger.
- Privilege escalation detection is advisory-only (`advisory_only: true`, `auto_revoke_blocked: true`) and cannot auto-revoke tokens/sessions.
- Session governance binds sessions to tokens deterministically; revoked/expired tokens invalidate session validity.

## Phase 14 Core Agent Engine Surface
- New local execution surface:
  - `scripts/run-research-task.js`
  - `openclaw-bridge/core/*` Phase 14 modules
- LLM interaction surface is explicitly constrained:
  - network allowed only in `openclaw-bridge/core/llm-adapter.js`
  - providers are operator-configured, default `mock`
- Supervisor approval receipt is mandatory before execution.
- Governance approval is mandatory after supervisor approval.
- Interaction log (`security/interaction-log.json`) is append-only and chain-hashed.
- Output artifacts are local-only under `workspace/research-output/`.

## Phase 15 Multi-Agent Topology Surface
- Local file comms surface:
  - `workspace/comms/inbox`
  - `workspace/comms/outbox`
  - `workspace/comms/blackboard`
  - `workspace/comms/events`
- Role dispatch surface remains supervisor-gated.
- Autonomy ladder policies constrain role/action execution and optional human approval requirements.
- Comms envelopes include deterministic hashes; tamper detection is available.

## Phase 16 MCP Ingestion Surface
- New ingestion network surface:
  - `integrations/mcp/mcp-client.js`
  - `integrations/mcp/arxiv-client.js`
  - `integrations/mcp/semantic-scholar-client.js`
- Ingestion normalization and indexing paths remain local-only:
  - `workspace/research-raw`
  - `workspace/research-normalized`
  - `workspace/research-index`
- Source ledger is append-only chain-hashed for tamper evidence.

## Phase 17 Runtime Resume Surface
- New runtime state surface:
  - `state/runtime/state.json` (gitignored runtime)
  - `state/runtime/state.sample.json` (template)
- Resume orchestrator requeues pending loops from local state only.
- Resumed execution path requires renewed supervisor and governance approvals.
- Tool image allowlist and digest-pinning policy gate runtime execution.

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

## Phase 18 Mission Orchestration Surface
- Mission execution remains local-first under `workspace/missions/`.
- Mission templates remain constrained to `research_only` and `draft_artifact` classes when enabled.
- External action templates remain disabled stubs only.
- Mission orchestration does not add browser automation, login automation, shell execution, container launch, or direct external submission paths.

## Phase 19 Dataset Foundation Surface
- New local dataset surface:
  - `workspace/datasets/raw/<datasetId>/`
  - `workspace/datasets/staged/<datasetId>/<buildId>/`
  - `workspace/datasets/index/datasets-index.json`
- Dataset builds are derived from existing local research outputs or mission artifacts.
- Latest-build lookup is index-based, not filesystem timestamp-based.
- Dataset generation remains local-only and does not add outbound publish, upload, or marketplace submission paths.
- Phase 19 does not add full provenance, licensing review, dataset scoring, dedupe, or publisher adapters.

## Phase 19 Monetization and Release Packaging Surface
- New local packaging surface:
  - `workspace/releases/<offerId>/`
  - `workspace/releases/<offerId>/submission/<platform>/`
- Submission packs are manual-only preparation artifacts.
- Release bundles are packaging artifacts, not proof of publication.
- Final release approval is a human-only local sign-off before export.
- Export remains local-only; external publishing, upload, delivery, and marketplace submission remain manual-only.
- No new outbound hosts are introduced by Phase 19 monetization or release packaging.

## Container/Credential Boundaries
- Non-root, non-privileged, no host-network, read-only rootfs.
- Per-MCP credential handle isolation and writable namespace isolation.
- No raw API keys in env or logs.
