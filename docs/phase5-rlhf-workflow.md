# Phase 5 RLHF Workflow

## Boundary Model
Phase 5 automates internal RLHF draft preparation only.

Automated scope:
- Candidate selection from normalized research records.
- Deterministic ranking by complexity and monetization signals.
- RLHF draft generation and formatting.
- Compliance linting prior to persistence.
- Internal queue management and replay-safe hashing.
- Deterministic manual package generation.

Manual-only scope:
- Final editorial judgment.
- Platform login.
- Compliance attestation required by platforms.
- Final submission action.
- Identity and ownership declarations.

## Deterministic Dataflow
1. Read normalized records via `apiGovernance.loadResearchRecords()`.
2. Compute candidate ranking with deterministic scoring and ordering.
3. Build deterministic draft payload and markdown template.
4. Run compliance linter as pre-persist gate.
5. Persist valid drafts and review queue updates in governance transaction.
6. Optionally append deterministic NDJSON draft artifacts.
7. Transition review statuses through operator-only workflow.
8. Generate deterministic manual submission package when approved.

## Invariants Preserved
- State writes occur only inside governance transactions.
- No new egress domains or outbound submission paths.
- No browser automation, login automation, or credential storage.
- No runtime randomness in workflow modules.
- Supervisor cannot mutate RLHF review status.
- All drafts are `aiAssisted=true` and `manualSubmissionRequired=true`.

## Review State Machine
- `draft -> reviewed`
- `reviewed -> approved_for_manual_submission`
- `approved_for_manual_submission -> archived`

Any other transition is rejected.

## Manual Package Contents
- `draft.md`
- `source-summary.json`
- `review-checklist.md`
- `compliance-manifest.json`

The package does not include credential material, submission endpoints, or automated submission instructions.
