# State Schema (Phase 4)

Canonical file: `workspace/runtime/state.json`

Required fields:
- `schemaVersion`
- `activeInitiatives`
- `openLoops`
- `agentHealth`
- `circuitBreakerState`
- `dailyTokenUsage`
- `hydrationTimestamp`
- `apiGovernance`
- `researchIngestion`
- `outboundMutation`

## Reinjection sequence
1. Validate `schemaVersion` (`4` in Phase 4).
2. Load unresolved `openLoops`.
3. Rebuild context from `workspace/memory/YYYY-MM-DD.md` and `workspace/MEMORY.md`.
4. Sort unresolved loops by `nextRetryAt`, `retryCount`, `createdAt`, `loopId`.
5. Reinject sorted loops at queue head preserving `idempotencyKey`.
6. Persist hydrated state atomically before resuming queue processing.
