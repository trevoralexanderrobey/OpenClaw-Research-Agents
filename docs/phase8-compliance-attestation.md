# Phase 8 Compliance Attestation and Release Gating

## Scope
Phase 8 introduces deterministic internal compliance governance for runtime attestation, evidence bundle generation, and operator-governed release decisions.

Phase 9 dependency note:
- Phase 8 contracts and evidence outputs are frozen inputs to Phase 9 compliance monitoring and drift detection.
- Phase 8 release-gate evaluation/decision artifacts feed the Phase 9 compliance scanner and phase completeness reconciliation checks.

Phase 10 cross-reference:
- Phase 8 evidence bundles may be used as optional input artifacts for Phase 10 external attestation anchoring.
- External anchoring remains operator-initiated, token-scoped, and blocked-by-default.

Boundaries:
- No autonomous external execution.
- No automated login/browser/submission behavior.
- No new outbound domains.
- No dynamic endpoint/domain configuration.
- Supervisor remains non-mutation and orchestration-only.

## Baseline Compatibility
Phase 8 is additive to the certified Cline supervisor baseline:
- Cline allowlist semantics are unchanged.
- `verify-cline-supervisor-policy.sh` remains unconditional and blocking in CI/build chains.
- Protected mutation boundaries remain operator-only with scoped approval tokens.

## State Contract (Schema v8)
Top-level additive block in `workspace/runtime/state.json`:

```json
"complianceGovernance": {
  "policyVersion": "v1",
  "attestationSnapshots": [],
  "evidenceBundles": [],
  "releaseGates": [],
  "activeReleasePolicy": {
    "version": "v1",
    "updatedAt": "",
    "updatedBy": "",
    "requiredChecks": ["phase2-gates", "mcp-policy", "phase6-policy", "phase7-policy"],
    "minEvidenceFreshnessHours": 24
  },
  "decisionLedger": {
    "records": [],
    "nextSequence": 0,
    "chainHead": ""
  },
  "nextAttestationSequence": 0,
  "nextEvidenceBundleSequence": 0,
  "nextReleaseGateSequence": 0
}
```

## Public Interfaces
- `createRuntimeAttestationEngine({ apiGovernance, operatorAuthorization, timeProvider, logger })`
- `captureRuntimeAttestation(input, context)`
- `createEvidenceBundleBuilder({ apiGovernance, operatorAuthorization, timeProvider, logger })`
- `buildEvidenceBundle(input, context)`
- `verifyEvidenceBundleIntegrity(input)`
- `createReleaseGateGovernor({ apiGovernance, operatorAuthorization, timeProvider, logger })`
- `evaluateReleaseGate(input)`
- `applyReleaseGateDecision(input, context)`
- `repairComplianceLedgerTail(input, context)`
- `verifyPhase8StartupIntegrity({ apiGovernance, logger })`

## Mutation Contract
Protected mutations are:
- Operator-only (`role=operator`), supervisor-denied.
- Approval-token scoped per action.
- Kill-switch gated (`state.outboundMutation.killSwitch` must be false).
- Transaction-bound (`apiGovernance.withGovernanceTransaction(...)`).
- Idempotency-key enforced where applicable.

Scope mapping:
- `compliance.attest.capture`
- `compliance.bundle.build`
- `compliance.release.apply`
- `compliance.release.repair`

## Deterministic Formulas
- `attestationHash = SHA256("phase8-attestation-v1|" + canonical(attestationWithoutHash))`
- `bundleHash = SHA256("phase8-bundle-v1|" + canonical(bundleWithoutHash))`
- `decisionHash = SHA256("phase8-decision-v1|" + canonical(decisionWithoutHash))`
- `chainHash = SHA256(prevDecisionHash + "|" + decisionHash)`

Policy snapshot hash:
- `policySnapshotHash = SHA256("phase8-policy-snapshot-v1|" + canonical({version, requiredChecks, minEvidenceFreshnessHours}))`

## Idempotency Rules
- Same idempotency key + same canonical payload -> prior result returned (`idempotent: true`).
- Same idempotency key + divergent canonical payload -> fail closed.

### Frozen Release-Gate Fingerprint
Implemented by `buildReleaseGateIdempotencyFingerprint(...)` in `workflows/compliance-governance/compliance-validator.js`.

Frozen field list (do not change unless schema version changes):
- `targetRef`
- `targetSha`
- `decision`
- `reasonCode`
- `asOfIso` (normalize absent to `""`)
- `policySnapshotHash`

Explicitly excluded from fingerprint:
- `sequence`
- `decidedAt`
- `decidedBy`
- `approvalToken`
- `decisionHash`
- `prevDecisionHash`

## Startup Integrity
`verifyPhase8StartupIntegrity(...)` executes before MCP service method handling.

Checks:
- Release decision hash chain integrity.
- Ledger chain and chain-head anchor integrity.
- Evidence bundle hash integrity.

Any mismatch fails closed.

## Repair Workflow
Allowed repair is truncated-tail ledger restoration only.

Requirements:
- Operator role.
- Scope `compliance.release.repair` approval token.
- Kill-switch open.
- Governance transaction wrapper.

Rejected:
- Divergence before tail.
- Extra-record/non-truncated corruption.

## Explainability and Evidence Artifacts
Generated under `audit/evidence/phase8/`:
- `runtime-attestation.json`
- `compliance-bundle.json`
- `release-gate-evaluation.json`
- `release-gate-decisions.json`
- `compliance-ledger-chain.json`
- `compliance-explainability-report.md`
- `phase8-hash-manifest.json`

All JSON outputs are canonicalized and deterministic for equal inputs.

## Operator Runbook
1. Capture attestation with operator token (`compliance.attest.capture`).
2. Build evidence bundle with operator token (`compliance.bundle.build`).
3. Evaluate release gate (read-only recommendation).
4. Apply decision only with operator token (`compliance.release.apply`).
5. If ledger tail truncation is detected, run explicit repair (`compliance.release.repair`).
6. Run policy/build gates and CI health micro-check before merge.
