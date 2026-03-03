# Credential Broker Boundary (Phase 1)

Trust boundary:

`[Agent/Container] -> opaque credential handle -> [Credential Broker] -> secret injection -> [External API]`

## Isolation baseline
1. Broker runs under separate process/service identity.
2. Broker does not share writable workspace with role agents.
3. Broker accepts only token-handle requests, not raw key write operations.
4. Broker emits structured access logs with request ID and principal hash.
5. Broker never writes plaintext secrets to repo-tracked files.

## Phase 2 hardening gate
Before enabling outbound mutation flags, broker deployment topology must be approved via ADR:
- same host process
- separate container
- separate VM
- separate network namespace
