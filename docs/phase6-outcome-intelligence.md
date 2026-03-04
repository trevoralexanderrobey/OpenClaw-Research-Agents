# Phase 6 Outcome Intelligence

## Scope
Phase 6 adds deterministic human outcome feedback, calibration, and portfolio planning on top of Phase 5 RLHF draft generation.

Automated (internal-only):
- Outcome ingestion validation and persistence.
- Quality scoring and calibration computation.
- Template/domain performance aggregation.
- Weekly/monthly intelligence artifact generation.

Manual-only:
- Platform login.
- External submission.
- Human attestations and final publication actions.

## Security and Governance Boundaries
- No new autonomous submission capability.
- No browser/login automation.
- No new outbound domains.
- Operator-only mutation for outcomes/calibration.
- Supervisor mutation denied for outcomes and approval states.
- Existing kill-switch gates all Phase 6 mutation paths.
- All writes remain inside `apiGovernance.withGovernanceTransaction`.

## State Model (Schema v6)
Additive block:
- `rlhfOutcomes.records[]`
- `rlhfOutcomes.nextOutcomeSequence`
- `rlhfOutcomes.calibration`
- `rlhfOutcomes.portfolioSnapshots[]`
- `rlhfOutcomes.nextSnapshotSequence`
- `rlhfOutcomes.chainHeadHash`
- `rlhfOutcomes.chainHeadSequence`

## Outcome Integrity Model
- `outcomeHash = SHA256("rlhf-outcome-v1|" + canonicalOutcomeWithoutHash)`
- `chainHash = SHA256(prevChainHash + "|" + outcomeHash)`
- Append-only NDJSON stream at `workspace/memory/rlhf-outcomes.ndjson`.
- Canonical state stores chain head anchor and is cross-checked against artifact chain at startup.
- Chain mismatch/corruption is fail-closed; truncated tail repair is explicit operator workflow.

## Result-Aware Validation
- `pending` outcomes must have `score=0`; manual confirmation may be true/false.
- Finalized outcomes (`accepted|rejected|revise_requested`) require:
  - `manualSubmissionConfirmed=true`
  - bounded integer `score` in `0..100`

## Idempotency Rules
- `idempotencyKey` required for `recordOutcome`.
- Same key + same normalized payload => idempotent success (existing record returned).
- Same key + different payload => hard fail (`RLHF_OUTCOME_IDEMPOTENCY_CONFLICT`).

## Deterministic Calibration and Planning
- Calibration version is `v1` and weights must sum to 1.
- Empty calibration window is deterministic no-op (no state/time drift).
- Portfolio/reporting empty window is deterministic no-op (no state/time drift).
- Candidate ranking can consume calibration weights and quality priors in read-only mode.

## Artifact Outputs
`audit/evidence/phase6/`:
- `outcome-summary.json`
- `calibration-snapshot.json`
- `portfolio-priorities.json`
- `weekly-intel-report.md`
- `report-hash-manifest.json`

All JSON outputs use canonical serialization for replay stability.
