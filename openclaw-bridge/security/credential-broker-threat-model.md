# Credential Broker Threat Model (Phase 1)

## Threats
- Credential exfiltration through logs.
- Handle forgery and replay.
- Unauthorized broker access.

## Phase 1 controls
- Handle-only request interface.
- Structured audit logging with redaction.
- Broker identity separation from agent runtime.
- No plaintext secret persistence in tracked files.

## Deferred hardening
- Topology-level isolation decision via ADR in Phase 2.
- mTLS/service identity hardening for broker API.
