# Phase 2 Change-Control Guard

## Default controls
1. Feature flags default to `OFF`.
2. Outbound mutation remains disabled in Phase 2.
3. Registry modifications require a policy update and checksum lock update.
4. Lockfile and npm cache checksum changes require explicit review documentation.

## PR governance
1. CODEOWNERS approval is required for `security/*`, `.github/workflows/*`, `openclaw-bridge/execution/*`, and lock files.
2. `security/dependency-review.md` must be updated when `package-lock.json` changes.
3. `security/dependency-review.md` must include cache rebuild rationale when `security/npm-cache.lock.json` changes.

## Freeze rule
Phase 2 runtime hardening scope is frozen to governance/security enforcement. No feature expansion beyond approved scope is permitted.
