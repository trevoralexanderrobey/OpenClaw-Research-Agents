# Failure Modes (Phase 5)

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
