# Phase 13 Access Control & Identity Governance

## Scope
Phase 13 adds deterministic local-only access control and identity governance across Phase 2-12 operator-gated workflows.

Non-negotiable boundaries:
- No autonomous token issuance, rotation, revocation, or session creation.
- No external identity provider integration (OAuth/LDAP/SAML/IdP).
- No network-based authentication.
- Unknown role/scope/token paths fail closed.
- Escalation detection is advisory-only and cannot auto-revoke.

## Role Definitions And Permission Matrix
Source of truth:
- `security/rbac-policy.json`

Canonical roles:
- `operator_admin`: full governance access across phases.
- `operator_standard`: scoped operations for compliance/drift scan, runbooks, checkpoints, drills, SBOM generation, vulnerability scanning, and read paths.
- `operator_readonly`: read-only access to reports/evidence/metrics.
- `system_automated`: system read-only telemetry/compliance reads only.

Runtime registry:
- `workflows/access-control/role-permission-registry.js`

## Scope Registry Reference
Source of truth:
- `security/scope-registry.json`

Runtime registry:
- `workflows/access-control/scope-registry.js`

Coverage:
- Governance scopes from Phase 8-13 (attestation, remediation, release, restore, supply chain, token/session lifecycle).
- Legacy operator-gated scopes from earlier phases (mutation, experiment, RLHF, compliance).
- Unknown scopes are rejected deterministically.

## Token Lifecycle Procedures
Module:
- `workflows/access-control/token-lifecycle-manager.js`

Runtime store:
- `security/token-store.json` (gitignored)
- Template: `security/token-store.sample.json`

Procedures:
1. Issue token (`issueToken` / `scripts/issue-token.js`): requires `--role`, `--scopes`, `--expires-in`, `--confirm`.
2. Rotate token (`rotateToken` / `scripts/rotate-token.js`): requires `--token-id`, `--confirm`.
3. Revoke token (`revokeToken` / `scripts/revoke-token.js`): requires `--token-id`, `--reason`, `--confirm`.
4. Validate/list (`scripts/validate-token.js`, `scripts/list-active-tokens.js`).

All mutation operations are operator-initiated, transaction-wrapped, and immutably logged.

## Session Management Procedures
Module:
- `workflows/access-control/session-governance-manager.js`

Runtime store:
- `security/session-store.json` (gitignored)

Procedures:
1. Create (`createSession` / `scripts/create-session.js`): operator-only, explicit confirm required.
2. Validate (`validateSession` / `scripts/validate-session.js`): fails when session expired or token invalid.
3. Invalidate (`invalidateSession`): operator-initiated explicit invalidation path.

Sessions are deterministically derived from token + timestamp inputs.

## Permission Boundary Enforcement Model
Module:
- `workflows/access-control/permission-boundary-enforcer.js`

Behavior:
- Evaluates token, role, scope, action, and resource.
- Fail-closed decisions for unknown role/scope/token and expired/revoked token.
- Deterministic output (`allowed`, `reason`) for identical inputs.
- Every decision is recorded in Phase 13 access decision ledger.

CLI:
- `scripts/check-access.js`

## Privilege Escalation Detection And Response
Module:
- `workflows/access-control/privilege-escalation-detector.js`

Patterns:
- Insufficient role attempts.
- Scope not granted attempts.
- Repeated denied access attempts.
- Revoked/expired token usage.

Response contract:
- `advisory_only: true`
- `auto_revoke_blocked: true`

CLI:
- `scripts/detect-escalation.js`

## Access Decision Audit Trail Interpretation
Module:
- `workflows/access-control/access-decision-ledger.js`

Runtime store:
- `security/access-decision-ledger.json` (gitignored)

Entry model:
- Sequence + canonical decision payload + `prev_chain_hash` + `entry_hash` + `chain_hash`.

Integrity:
- Chain verification detects sequence/hash/tip tampering.
- Rapid append path is serialized for deterministic ordering.

## Backward Compatibility Notes
- Existing Phase 2-12 approval-token interfaces remain unchanged.
- Legacy compatibility bridge (`workflows/access-control/legacy-access-bridge.js`) wraps approved legacy token-consumption call paths.
- `operator_admin` fallback is restricted to known legacy call paths with approval-token presence; no-token/no-role paths are denied.
- New Phase 13 CLIs do not use legacy fallback and require explicit Phase 13 token/session inputs.

## Token Store Maintenance Procedures
1. Keep runtime stores untracked (`security/token-store.json`, `security/access-decision-ledger.json`, `security/session-store.json`).
2. Never commit real token/session/ledger runtime files.
3. Use `scripts/verify-phase13-policy.sh` to enforce gitignore and non-commit controls.
4. Regenerate deterministic evidence with `scripts/generate-phase13-artifacts.js` after policy or runtime model changes.
