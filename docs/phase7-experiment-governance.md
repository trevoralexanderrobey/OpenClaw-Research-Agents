# Phase 7 Experiment Governance

## Scope
Phase 7 adds deterministic internal experiment governance and rollout control.

Boundaries:
- Internal-only analysis and recommendation logic.
- No autonomous external submission.
- No browser/login/credential automation.
- No dynamic endpoint/domain expansion.
- Existing manual external submission boundary remains unchanged.

## Invariants
1. All protected mutations are operator-only (`role=operator`) and explicitly deny supervisor.
2. All protected mutations require scoped `approvalToken` consumption.
3. All protected mutations run inside `apiGovernance.withGovernanceTransaction(...)`.
4. All protected mutations are kill-switch gated.
5. Deterministic serialization and replay safety are preserved.
6. Decision-ledger hash chain and anchor mismatch fails closed.
7. Startup integrity checks run before MCP service begins serving requests.

## Module Layout
- `workflows/experiment-governance/experiment-schema.js`
- `workflows/experiment-governance/experiment-validator.js`
- `workflows/experiment-governance/pre-registration-lock.js`
- `workflows/experiment-governance/experiment-manager.js`
- `workflows/experiment-governance/deterministic-assignment-engine.js`
- `workflows/experiment-governance/experiment-analysis-engine.js`
- `workflows/experiment-governance/decision-ledger.js`
- `workflows/experiment-governance/rollout-governor.js`
- `security/phase7-startup-integrity.js`
- `analytics/experiment-explainability/*`

## State Contract (Schema v7)
`workspace/runtime/state.json` includes:
- `schemaVersion: 7`
- `experimentGovernance`:
  - `policyVersion`
  - `experiments[]`
  - `assignments[]`
  - `analysisSnapshots[]`
  - `rolloutDecisions[]`
  - `activeRolloutProfile`
  - `decisionLedger`
  - `nextExperimentSequence`
  - `nextAssignmentSequence`
  - `nextAnalysisSequence`
  - `nextRolloutDecisionSequence`

Experiment records include `preRegistrationLockHash` and `splitBasisPoints`.

## Allowed Transitions
Experiment lifecycle:
- `draft -> approved -> running -> paused -> completed -> archived`
- `running -> paused`
- `paused -> completed`

Protected mutation interfaces:
- `createExperiment` scope: `experiment.create`
- `approveExperiment` scope: `experiment.approve`
- `startExperiment` scope: `experiment.start`
- `pauseExperiment` scope: `experiment.pause`
- `completeExperiment` scope: `experiment.complete`
- `archiveExperiment` scope: `experiment.archive`
- `assignDraftToExperiment` scope: `experiment.assign`
- `captureAnalysisSnapshot` scope: `experiment.analyze`
- `applyRolloutDecision` scope: `experiment.rollout.apply`
- `repairDecisionLedgerTail` scope: `experiment.rollout.repair`

Read-only interfaces:
- `computeAnalysisSnapshot`
- `recommendRolloutDecision`
- `buildDecisionExplanation`
- `buildRecommendationRationale`

## Deterministic Formulas
Assignment bucket:
- `bucket = uint32(SHA256("phase7-bucket-v1|" + experimentSequence + "|" + draftSequence)[0..7]) % 10000`

Pre-registration lock:
- `preRegistrationLockHash = SHA256("phase7-prereg-v1|" + canonical({ treatment, control, guardrails, window, analysisPlanVersion }))`

Decision hash:
- `decisionHash = SHA256("phase7-decision-v1|" + canonical(decisionWithoutHash))`

Decision chain hash:
- `chainHash = SHA256(prevDecisionHash + "|" + decisionHash)`

## Pre-Registration Lock
After start (`running|paused|completed|archived`), these fields are immutable:
- `treatment`
- `control`
- `guardrails`
- `window`
- `analysisPlanVersion`

Lock mismatches throw `EXPERIMENT_PREREG_LOCK_BREACH`.

## Idempotency Rules
- Assignment, analysis snapshot, and rollout apply require `idempotencyKey`.
- Same key + same canonical payload -> return persisted prior result (`idempotent: true`).
- Same key + different canonical payload -> fail closed.
- Assignment `(experimentSequence, draftSequence)` is immutable after first write.

## Startup Integrity Runbook
Boot sequence:
1. `mcp-service.initialize()` runs once.
2. Startup verifies stored replay integrity.
3. Startup runs `verifyPhase7StartupIntegrity(...)`.
4. `bridge/server.ts` awaits `mcpService.initialize()` before listeners are opened.

Startup checks:
- Decision hash chain integrity.
- Decision ledger chain + chain-head anchor integrity.
- Pre-registration lock integrity for locked-status experiments.

Failure handling:
- Any mismatch fails closed; service initialization rejects.

## Repair Workflows
Allowed repair:
- Truncated-tail decision ledger repair only (`repairDecisionLedgerTail`).
- Requires operator role + `experiment.rollout.repair` approval token.
- Kill-switch gated.
- Repair is rejected for non-truncated divergence.

Repair auditability:
- Repair actions execute transactionally.
- Ledger is re-verified immediately post-repair.

## Explainability and Evidence
Deterministic explainability output:
- `analytics/experiment-explainability/decision-explainer.js`
- `analytics/experiment-explainability/recommendation-rationale.js`

Artifact generation:
- `scripts/generate-phase7-artifacts.js`
- Output path: `audit/evidence/phase7/`
  - `experiment-catalog.json`
  - `assignment-snapshot.json`
  - `analysis-snapshot.json`
  - `rollout-decisions.json`
  - `decision-ledger-chain.json`
  - `explainability-report.md`
  - `phase7-hash-manifest.json`

## CI Policy Gates
- `scripts/verify-phase7-policy.sh`
- Wired into:
  - `scripts/build-verify.sh`
  - `.github/archived-workflows/phase2-security.yml.disabled`
  - `package.json` (`phase7:verify`, `phase2:gates`)
