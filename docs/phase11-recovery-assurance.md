# Phase 11 Recovery Assurance & Continuity

## Scope
Phase 11 extends Phase 10 operational resilience with deterministic recovery checkpointing, backup integrity verification, operator-gated restore orchestration, continuity SLO evaluation, tabletop recovery drills, and failover readiness validation.

Non-negotiable boundaries:
- No autonomous restore or failover.
- Restore execution requires operator role, scoped approval token (`governance.recovery.restore`), and explicit `--confirm`.
- Continuity, drill, and readiness outputs are advisory-only.
- All restore decisions are immutably logged in operator override and operational decision ledgers.
- No dynamic endpoint expansion or external login/submission automation.

## Recovery Schema
Canonical schema module: `workflows/recovery-assurance/recovery-schema.js`

Entity contracts:
- `checkpoint`
- `backup_manifest`
- `restore_request`
- `restore_result`
- `drill_result`
- `readiness_report`

All artifacts use canonical JSON and deterministic hashing.

## Checkpoint + Manifest Pipeline
Modules:
- `workflows/recovery-assurance/checkpoint-coordinator.js`
- `workflows/recovery-assurance/backup-manifest-manager.js`
- `workflows/recovery-assurance/backup-integrity-verifier.js`

Flow:
1. Build deterministic checkpoint from Phase 8/9/10 evidence and runtime summary.
2. Build deterministic backup manifest from checkpoint artifact inventory.
3. Verify manifest hash/chain continuity and artifact integrity.
4. Fail closed on missing/tampered artifacts.

## Restore Orchestration (Human-Gated)
Module: `workflows/recovery-assurance/restore-orchestrator.js`  
CLI: `scripts/execute-restore.js`

Required execution flags:
- `--approval-token <token>`
- `--restore-request <path>`
- `--scope governance.recovery.restore`
- `--confirm`

Behavior:
- `presentRestorePlan` is advisory and read-only.
- `executeRestore` rejects missing confirm/token paths and records immutable ledger entries.
- Default execution mode is simulation (fail-closed) unless an explicit restore executor is injected.

## Continuity SLO Evaluation
Module: `workflows/recovery-assurance/continuity-slo-engine.js`

Default continuity targets:
- `rto_target_minutes <= 30`
- `rpo_target_minutes <= 15`
- `backup_integrity_success_rate >= 99.9%`
- `restore_drill_success_rate >= 99%`

Breach alerts are always:
- `advisory_only: true`
- `auto_remediation_blocked: true`

## Tabletop Drills + Failover Readiness
Modules:
- `workflows/recovery-assurance/chaos-drill-simulator.js`
- `workflows/recovery-assurance/failover-readiness-validator.js`

Supported deterministic drill scenarios:
- `component_failure`
- `integrity_drift`
- `checkpoint_rollback`

Readiness validator output:
- `ready`
- `score`
- `blockers`
- `recommendations`

No drill or readiness path can trigger restore/failover automatically.

## Startup Integrity + Policy Gates
Startup gate:
- `security/phase11-startup-integrity.js`
- Wired in MCP initialization immediately after Phase 10 startup integrity.

Policy gate:
- `scripts/verify-phase11-policy.sh`
- Unconditional in CI/build gating chain.
- Enforces no autonomous restore/failover/network/browser/login automation.
- Enforces restricted-global bans in Phase 11 modules.

## Operator Runbook
1. Create checkpoint: `node scripts/create-recovery-checkpoint.js --out <checkpoint.json>`
2. Build/verify backup manifest integrity:
   - `node scripts/verify-backup-integrity.js --manifest <manifest.json>`
3. Run recovery drill:
   - `node scripts/run-recovery-drill.js --scenario integrity_drift --out <drill.json>`
4. Evaluate continuity SLOs from deterministic metrics input.
5. Execute restore only with explicit scope/token/confirm and operator review.
6. Regenerate deterministic Phase 11 evidence artifacts.

## Deterministic Evidence Artifacts
Generated under `audit/evidence/recovery-assurance/`:
- `recovery-schema.json`
- `checkpoint-sample.json`
- `backup-manifest-sample.json`
- `backup-integrity-results.json`
- `restore-plan-sample.json`
- `restore-execution-sample.json`
- `continuity-slo-results.json`
- `chaos-drill-results.json`
- `failover-readiness-report.json`
- `phase11-policy-gate-results.json`
- `hash-manifest.json`

## Phase 12 Cross-Reference
- Recovery artifact trust can be strengthened by Phase 12 provenance + signature workflows:
  - generate deterministic SBOM and provenance for recovery-related artifacts
  - sign recovery evidence artifacts with local operator-managed key material
  - verify signatures before restore-plan approval and before post-incident evidence publication
- See `docs/phase12-supply-chain-security.md` for operator procedures.
