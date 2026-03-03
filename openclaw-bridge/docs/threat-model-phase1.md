# Threat Model (Phase 1)

## STRIDE mapping
- Spoofing: auth token checks and role resolution.
- Tampering: atomic state writes and strict schema validation.
- Repudiation: structured audit trails and request IDs.
- Information Disclosure: token masking and credential broker boundaries.
- Denial of Service: queue caps, circuit breakers, resource policies.
- Elevation of Privilege: non-root containers, no privileged mode, supervisor boundary.

## MAESTRO-style control mapping
- Manipulation: validation + mutation guard.
- Access abuse: role-bound authority model.
- Exfiltration: broker boundary + redaction.
- Service disruption: breaker + queue + cap controls.
- Trust-boundary violation: container and WS hardening.
- Recovery failure: deterministic hydration and reinjection.
- Operational drift: freeze policy + change control.
