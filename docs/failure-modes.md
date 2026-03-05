# Failure Modes (Phase 11)

## Runtime Schema Mismatch
Detection:
- State schema is not v5.

Handling:
- Fail closed with `RUNTIME_STATE_SCHEMA_UNSUPPORTED`.

## RLHF Draft Hash Mismatch
Detection:
- Stored `contentHash` does not match deterministic recomputation.

Handling:
- Fail closed with `RLHF_DRAFT_HASH_MISMATCH`.
- Reject replay/transition until mismatch is remediated.

## RLHF Queue Ordering Drift
Detection:
- `nextQueueSequence` is behind observed max queue sequence.
- Duplicate queue sequence values detected during normalization/replay checks.

Handling:
- Reconcile to monotonic max sequence.
- Reject duplicate/invalid queue records.

## RLHF Compliance Linter Rejection
Detection:
- Missing required sections/disclosure or forbidden phrase match.
- Rendered markdown differs from deterministic re-render.

Handling:
- Block draft persistence for the candidate.
- Mark candidate queue entry as lint-rejected.

## Outcome Idempotency Conflict
Detection:
- `idempotencyKey` is replayed with a different normalized payload.

Handling:
- Fail closed with `RLHF_OUTCOME_IDEMPOTENCY_CONFLICT`.
- No duplicate outcome is inserted.

## Outcome Pending/Finalized Semantics Violation
Detection:
- `pending` outcome has non-zero score.
- Finalized outcome has `manualSubmissionConfirmed=false`.

Handling:
- Reject write with `RLHF_OUTCOME_PENDING_SCORE_INVALID` or `RLHF_OUTCOME_MANUAL_CONFIRMATION_REQUIRED`.

## Outcome Chain Anchor Mismatch
Detection:
- Canonical state chain anchor does not match runtime outcome stream head.

Handling:
- Fail closed with `RLHF_OUTCOME_STATE_CHAIN_INVALID` or `RLHF_OUTCOME_CHAIN_ANCHOR_MISMATCH`.
- Require operator repair workflow before writes continue.

## Outcome Artifact Corruption
Detection:
- Outcome NDJSON parse failure or chain continuity mismatch.

Handling:
- Fail closed with `RLHF_OUTCOME_ARTIFACT_CORRUPTED` / `RLHF_OUTCOME_CHAIN_CONTINUITY_INVALID`.
- Allow only explicit operator tail-repair path for truncated trailing records.

## Phase 6 Kill-Switch Denial
Detection:
- Outcome record or calibration apply attempted while kill-switch is active.

Handling:
- Reject with `RLHF_OUTCOME_KILL_SWITCH_ACTIVE` or `RLHF_CALIBRATION_KILL_SWITCH_ACTIVE`.
- No state mutation committed.

## Empty Calibration/Reporting Windows
Detection:
- Insufficient finalized outcomes for calibration or no draft/outcome activity for reporting.

Handling:
- Deterministic no-op response.
- No sequence/timestamp/calibration mutation in canonical state.

## Unauthorized RLHF Review Transition
Detection:
- Supervisor or non-operator attempts status mutation.
- Transition path violates allowed state machine.

Handling:
- Fail closed with `RLHF_REVIEW_ROLE_DENIED` or `RLHF_REVIEW_TRANSITION_INVALID`.
- No status mutation is committed.

## Mutation Disabled or Kill-Switch Active
Detection:
- `outboundMutation.enabled=false` or `outboundMutation.killSwitch=true`.

Handling:
- Prepare/commit fail closed immediately.

## Prepare/Commit Race State
Detection:
- Pending record not prepared while enabled.

Handling:
- Pending entry marked `abandoned`, retry disabled.

## Uncertain Dispatch State
Detection:
- Commit fails after outbound attempt starts.

Handling:
- Transition to `uncertain`.
- Retry uses same sequence and same idempotency key.
- Max retries = 3.
- Uncertain older than 24h requires reconcile action.

## Governance Drift / Double Counting
Detection:
- Duplicate mutation accounting attempt IDs.

Handling:
- Attempt-ID dedupe (`accountedAttemptIds`) prevents double increments.
- Accounting and state transitions are transaction-bound.

## TLS Downgrade Attempt
Detection:
- TLS override params or `NODE_TLS_REJECT_UNAUTHORIZED=0`.

Handling:
- Fail closed with mutation TLS policy errors.

## Mutation Payload Oversize/Abuse
Detection:
- Body bytes, HTML chars, external links, or embedded images exceed static caps.

Handling:
- Reject in prepare/commit preflight.

## Mutation Log Tamper
Detection:
- Hash chain or state tip mismatch in mutation attempts log.

Handling:
- Startup verification fails closed with `MUTATION_LOG_CHAIN_INVALID`.

## Replay Duplicate Side Effect Risk
Detection:
- Sequence/idempotency key already committed.

Handling:
- External call not re-executed.

## Egress Policy Violations
Detection:
- Non-allowlisted domain/method, raw IP target, DNS rebinding.

Handling:
- Deny request before outbound call.

## Phase 7 Pre-Registration Lock Breach
Detection:
- Running/paused/completed/archived experiment lock hash does not match canonical hash of locked fields:
  - `treatment`
  - `control`
  - `guardrails`
  - `window`
  - `analysisPlanVersion`

Handling:
- Fail closed with `EXPERIMENT_PREREG_LOCK_BREACH`.
- Block assignment, analysis, recommendation, rollout, repair, and startup readiness checks.

## Phase 7 Startup Integrity Failure
Detection:
- Decision ledger chain/hash/anchor mismatch, or pre-registration lock mismatch at startup verification.

Handling:
- Fail closed before MCP service starts handling requests.
- Require explicit operator repair for allowed truncated-tail cases only.

## Assignment Immutability/Idempotency Conflict (Phase 7)
Detection:
- Existing assignment for `(experimentSequence, draftSequence)` receives new write.
- Same idempotency key reused with divergent payload.

Handling:
- Reject with `EXPERIMENT_ASSIGNMENT_IMMUTABLE` or `EXPERIMENT_ASSIGNMENT_IDEMPOTENCY_CONFLICT`.
- Keep persisted assignment unchanged.

## Decision Ledger Mismatch (Phase 7)
Detection:
- `decisionHash` mismatch, `prevDecisionHash` mismatch, contiguous sequence violation, ledger chain hash mismatch, or chain-head mismatch.

Handling:
- Fail closed (`PHASE7_*` integrity errors).
- Disallow automatic repair except explicit truncated-tail operator repair path.

## Guardrail-Blocked Rollout Adoption (Phase 7)
Detection:
- Analysis guardrail breach (`maxRejectRateDelta`, `minQualityScore`) under sufficient sample window.

Handling:
- Deterministic recommendation is `hold` with `guardrail_breach`.
- Rollout apply remains operator-approved only and non-autonomous.

## Rollback Path (Phase 7)
Detection:
- Operator applies rollout `rollback` decision.

Handling:
- Active rollout profile reverts to prior adopted deterministic profile.
- Decision and ledger chain updated transactionally with tamper-evident hashes.

## Phase 8 Runtime Attestation Idempotency Conflict
Detection:
- `captureRuntimeAttestation` receives reused idempotency key with divergent canonical payload.

Handling:
- Fail closed with `COMPLIANCE_IDEMPOTENCY_CONFLICT`.
- Persisted attestation record remains unchanged.

## Phase 8 Evidence Bundle Integrity Mismatch
Detection:
- Stored `bundleHash` does not match deterministic recomputation from canonical bundle payload.

Handling:
- Fail closed with `PHASE8_BUNDLE_HASH_MISMATCH`.
- Release evaluation returns blocking integrity status until repaired.

## Phase 8 Stale Evidence Hold
Detection:
- Evidence freshness exceeds `activeReleasePolicy.minEvidenceFreshnessHours`.

Handling:
- Deterministic gate evaluation returns `hold` with `policy_violation`.
- No automatic release decision apply is performed.

## Phase 8 Compliance Ledger Chain/Anchor Mismatch
Detection:
- `decisionHash`, `prevDecisionHash`, ledger `chainHash`, or chain-head anchor mismatch.

Handling:
- Fail closed (`PHASE8_*` ledger integrity errors).
- Disallow automatic correction.
- Allow only explicit operator truncated-tail repair path.

## Phase 8 Startup Integrity Failure
Detection:
- Compliance decision ledger mismatch and/or evidence bundle integrity mismatch during startup verification.

Handling:
- Fail closed before MCP service starts handling requests.
- Require explicit operator repair/remediation workflow.

## Phase 8 Operator Override Controls
Detection:
- Operator attempts release-gate override with invalid scope token, missing token, or policy-invalid `allow`.

Handling:
- Reject with token/policy validation errors.
- Keep release decisions transaction-bound and operator-approved only.

## Phase 9 Drift Detection Alert
Detection:
- Baseline contract clause missing, contradicted, or weakened.
- Policy-gate skip logic reintroduced.
- Autonomous boundary language introduced.

Handling:
- Fail closed in startup integrity and compliance scans.
- Emit deterministic drift report for operator review.
- Do not apply remediation automatically.

## Phase 9 Override Ledger Integrity Mismatch
Detection:
- Override ledger sequence, entry hash, prev-chain hash, chain hash, or chain head mismatch.

Handling:
- Mark ledger integrity invalid (`tamper_detected=true`).
- Block startup integrity and protected override workflows until remediated.
- Require explicit operator review and approved correction.

## Phase 9 Phase Completeness Reconciliation Failure
Detection:
- Required Phase 2–8 artifact missing.
- Cross-phase contract contradiction detected.
- Blocking policy gate wiring missing from CI/build/package chains.

Handling:
- Fail closed with completeness report.
- Treat as blocking drift from frozen baseline.
- Restore missing artifacts/contracts and rerun full policy/test validation set.

## Cline supervisor policy gate failure
Detection:
- `scripts/verify-cline-supervisor-policy.sh` fails due to missing/contradictory Cline supervisor contract markers or missing config artifacts.

Handling:
- Fail closed in CI and local build verification.
- Do not bypass or skip policy checks.
- Correct the missing or contradictory contract/config artifact and rerun full policy gates.

## Cline config missing/misconfigured in developer workspace
Detection:
- Missing `.vscode/extensions.json`, `.vscode/settings.json`, `.clinerules`, or `security/cline-extension-allowlist.json`.
- Cline-related extension recommendation not in explicit allowlist.

Handling (runbook):
- Restore required files with approved content.
- Verify allowlist consistency (`officialIds + approvedAliasIds == allowedIds`).
- Run `bash scripts/verify-cline-supervisor-policy.sh`.
- Run `npm run build:verify` before merge.

## Phase 10 SLO Breach Alert
Detection:
- `workflows/observability/slo-alert-engine.js` reports one or more breaches.

Handling:
- Route advisory alert to configured operator channels.
- Require explicit operator acknowledgment before any follow-on runbook/escalation decision.
- Do not auto-trigger remediation.

## Phase 10 Runbook Execution Rejected or Failed
Detection:
- Missing `--confirm`/approval token scope, or remediation apply returns non-zero.

Handling:
- Record deterministic reject/fail decision in override and operational ledgers.
- Keep system in advisory/operator-review state.
- Require explicit re-run with valid token and confirmation.

## Phase 10 Incident Artifact Mismatch
Detection:
- Incident ID sequence discontinuity, malformed artifact structure, or missing ledger linkage.

Handling:
- Treat as integrity issue.
- Regenerate artifact from deterministic inputs.
- Reconcile via operator-reviewed ledger/event trail.

## Phase 10 External Attestation Anchor Failure
Detection:
- Missing confirm/token, invalid scope, invalid URL host, or allowlist denial.

Handling:
- Fail closed and block egress.
- Record attempt/failure context in decision trail.
- Retry only through explicit operator-initiated command with valid scope and allowlisted host.

## Phase 11 Checkpoint/Manifest Determinism Mismatch
Detection:
- Checkpoint hash or manifest hash differs from deterministic canonical recomputation.
- Checkpoint/manifest chain continuity hash mismatch.

Handling:
- Fail closed and mark recovery artifacts invalid.
- Regenerate checkpoint/manifest from canonical inputs.
- Re-run backup integrity verification and Phase 11 policy gate.

## Phase 11 Backup Artifact Tamper or Missing Artifact
Detection:
- `verifyBackupIntegrity` reports missing artifacts or artifact hash mismatch.

Handling:
- Set `tamper_detected=true` and block restore readiness.
- Require operator review and replacement of missing/corrupt artifacts.
- Re-run integrity verification before any restore decision.

## Phase 11 Restore Execution Rejected
Detection:
- Missing `--confirm`, missing approval token, or invalid token scope (`governance.recovery.restore`).

Handling:
- Reject execution and write immutable rejection entries to override + operational decision ledgers.
- Keep restore state advisory-only.
- Require explicit operator re-run with valid token/scope/confirm.

## Phase 11 Restore Executor Failure
Detection:
- Injected restore executor throws or returns failed status.

Handling:
- Fail closed and persist deterministic failure decision in ledgers.
- Do not auto-retry or auto-failover.
- Require explicit operator review and next-step decision.

## Phase 11 Continuity SLO Breach
Detection:
- RTO/RPO/backup-integrity/restore-drill metrics breach thresholds or required metrics are missing.

Handling:
- Emit advisory alerts only (`advisory_only=true`, `auto_remediation_blocked=true`).
- Do not trigger autonomous remediation, restore, or failover.
- Require operator triage and runbook decision.

## Phase 11 Drill/Readiness Safety Boundary Breach
Detection:
- Tabletop drill or readiness validation path attempts mutation/restore/failover execution.

Handling:
- Treat as policy violation and fail closed.
- Block release/merge until Phase 11 policy gate returns pass.
- Restore advisory-only behavior and re-run deterministic evidence generation.

## Phase 11 Startup Integrity Failure
Detection:
- Missing Phase 11 required modules/scripts.
- Recovery schema/module wiring bootstrap failure.
- Recovery artifact directory is not writable.

Handling:
- Fail closed before MCP service starts handling requests.
- Do not bypass startup gate.
- Restore missing wiring/artifacts and re-run startup + policy validations.
