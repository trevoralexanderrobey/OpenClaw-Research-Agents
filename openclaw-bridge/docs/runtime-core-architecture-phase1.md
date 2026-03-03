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
