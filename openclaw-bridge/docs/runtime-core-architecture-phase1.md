# Runtime Core Architecture (Phase 1)

## Control-plane responsibilities
- Gateway ingress and transport multiplexing.
- Bridge route normalization.
- Lane Queue sequencing.
- Deterministic state persistence and hydration.

## Queue model
- Per-session FIFO lane semantics.
- State persisted on enqueue/dequeue transitions.
- Restart reinjection from unresolved open loops.

## Failure recovery
- Circuit breaker gates repeated failures.
- Unresolved work remains in `openLoops`.
- Hydration reconstructs context from state + memory logs.

## Preflight validation
- Payload sizes and structures are enforced ahead of execution.
- Prevents egress policy violations by rejecting out-of-bounds requests before the mutation queue.

## RLHF Review Pipeline
- Automates internal draft preparation, formatting, and compliance linting.
- Output explicitly constrained to deterministic manual-handoff packaging; absolutely no automated external submission.

## Outcome Intelligence Pipeline
- Computes deterministic quality scoring and calibration from operator-entered feedback.
- Generates weekly/monthly intelligence artifacts without autonomous external side effects.

## Experiment Governance Pipeline
- Internal deterministic assignment engine, rollout controls, and analysis snapshot generation.
- Validates pre-registration hash locks and applies startup integrity checks before processing requests.
