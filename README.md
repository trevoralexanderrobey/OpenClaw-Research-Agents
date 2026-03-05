# OpenClaw Research Agents

Local-first, file-based, audit-oriented research orchestration scaffold built on OpenClaw architectural patterns.

## Phase 5 status
- Preflight validation implemented to enforce strict size/payload constraints and safety bounds for outbound mutations.
- Workload integrity guaranteed via SBOM generation, registry/digest verification, and lockfile/cache validation.
- Phase 2 runtime hardening controls preserved
- Controlled MCP ingestion layer remains enabled for research reads
- Controlled outbound mutation layer enabled for newsletter and Notion via operator-only two-phase commit
- Static outbound allowlists enforced for read and write providers
- Deterministic replay protections include sequence/idempotency duplicate blocking
- Mutation governance, kill-switch, and operator authorization enforcement enabled
- Internal RLHF workflow automation enabled for deterministic draft generation, linting, and manual handoff packaging
- RLHF drafts are always AI-assisted and marked human-review-required
- Phase 6 deterministic outcome feedback loop enabled (operator-entered outcomes, calibration, portfolio intelligence)
- Outcome capture enforces idempotency keys, chain-hash integrity, and chain-head state anchoring
- Calibration and outcome mutation paths are kill-switch-gated and operator-only
- Weekly/monthly intelligence artifacts are generated internally without external side effects
- Phase 7 deterministic experiment governance enabled (pre-registered experiments, deterministic assignment, deterministic analysis)
- All Phase 7 protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state
- Phase 7 startup integrity gate verifies decision-ledger chain anchor + pre-registration locks and fails closed before MCP service handling
- Rollout updates are recommendation-first and operator-approved only; no autonomous external execution is introduced
- Deterministic explainability and audit evidence artifacts are generated under `audit/evidence/phase7/`
- Phase 8 deterministic compliance governance enabled (runtime attestation, evidence bundles, release gate recommendation/apply, tamper-evident compliance decision ledger)
- All Phase 8 protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state
- Phase 8 startup integrity gate verifies compliance decision ledger anchor + evidence bundle integrity and fails closed before MCP service handling
- Phase 8 release decisions are operator-approved only and cannot autonomously trigger external actions
- Deterministic explainability and audit evidence artifacts are generated under `audit/evidence/phase8/`
- Phase 9 governance automation enabled (read-only compliance monitoring, policy drift detection, deterministic remediation recommendations, immutable override ledger, phase completeness reconciliation)
- Phase 9 drift/remediation pathways are operator-governed and non-autonomous; no automatic mutation execution is introduced
- Phase 9 startup integrity gate verifies compliance monitor, drift detector, override ledger integrity, and completeness reconciliation before MCP method handling
- Deterministic governance automation evidence artifacts are generated under `audit/evidence/governance-automation/`
- Phase 10 operational resilience enabled (canonical metrics/exporters, deterministic telemetry, advisory SLO alerting, human-gated runbook orchestration, incident artifact/escalation workflows, optional external attestation anchoring)
- Phase 10 alerting and escalation are advisory-only and never auto-execute remediation
- Phase 10 runbook execution is operator-driven only and requires scoped approval token + explicit confirmation
- Phase 10 external attestation anchoring is blocked-by-default and only allowed with explicit operator opt-in and static allowlist host validation
- Phase 10 startup integrity gate verifies observability/alerting/runbook/incident/attestation wiring before MCP method handling
- Deterministic Phase 10 observability evidence artifacts are generated under `audit/evidence/observability/`

## Key directories
- `openclaw-bridge/` runtime/control-plane scaffold
- `workspace/` deterministic runtime state, comms, and memory files
- `audit/` provenance, purge, checklist, and sign-off artifacts

## Current boundary
Automatic publishing is not enabled.
Supervisor direct tool execution remains blocked.
Mutation requires explicit operator approval and governance checks.
External RLHF submission to third-party platforms is manual-only.
Platform login, attestation, and final submission actions are always human-operated.
Outcome ingestion is operator-entered only.
Phase 7 experimentation/rollout logic is internal-only and never submits externally.
Phase 8 compliance attestation/release-gate logic is internal-only and never submits externally.
Phase 9 governance monitoring/drift/remediation logic is internal-only and never submits externally.
Phase 10 alerting/escalation workflows are advisory-only and internal; optional external attestation anchoring is strictly operator-initiated and blocked-by-default.

## Supervisor Model (Cline)
- Cline (VSCode Insiders extension) is the supervisor interface for supervised orchestration and approval-facing workflows.
- Supervisor context is orchestration-only and does not hold privileged mutation authority.
- Protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state.
- External submission, platform login, attestation, and final submission actions are manual-only and human-operated.
- Cline-related policy gates are blocking in CI and build verification.
