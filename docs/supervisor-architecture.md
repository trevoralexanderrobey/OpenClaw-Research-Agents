# Supervisor Architecture (Cline)

## Scope and Authority
- Cline (VSCode Insiders extension) is the supervisor interface for this repository.
- Supervisor is orchestration/approval-facing only and is not a privileged mutation executor.
- Supervisor direct tool execution remains blocked.
- Supervisor cannot bypass operator authorization, approval token scopes, governance transaction controls, or kill-switch protections.

## Mandatory Security Invariants
1. No autonomous external submission.
2. No automated login, credential, or browser submission flows.
3. No bypass of operator approval for protected mutations.
4. No bypass of governance transaction wrappers.
5. No bypass or weakening of kill-switch behavior.
6. No supervisor direct-mutation privilege escalation.
7. No dynamic endpoint/domain expansion.
8. No nondeterministic policy checks.
9. CI policy gates are release-blocking.
10. Backward compatibility of existing phase controls is preserved.

## Protected Mutation Contract
- Protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state.
- Mutation calls must continue using operator-scoped pathways and token consumption enforcement.
- Any attempt to execute protected mutations from supervisor context is denied.

## Manual-Only Boundary
- External submission, platform login, attestation, and final submission actions are manual-only.
- Cline supervision may prepare artifacts, but final external actions remain human-operated.

## Trust Boundaries
- Supervisor boundary: Cline orchestrates and requests approvals but does not obtain privileged mutation authority.
- Operator boundary: Operator role is the only role allowed to execute protected mutation methods.
- Governance boundary: All protected writes run within `apiGovernance.withGovernanceTransaction(...)`.
- Runtime boundary: Kill-switch gates mutation pathways and fails closed when active.

## Threat Model Summary
- Elevation of privilege attempt by supervisor role.
- Unauthorized mutation attempts without operator scope/token.
- Policy drift that weakens kill-switch or governance wrappers.
- Misconfigured local developer environment that omits Cline policy artifacts.
- CI misconfiguration that silently skips required policy gates.

## Denial Paths
- Supervisor mutation attempts are denied at role checks and supervisor execution boundaries.
- Missing or invalid scoped approval tokens are denied before mutation writes.
- Kill-switch active state denies prepare/commit mutation paths.
- Policy contradiction or missing Cline contract artifacts fails CI.

## Failure Mode Behavior
- Missing Cline supervisor contract/config files: fail closed in `scripts/verify-cline-supervisor-policy.sh`.
- Contradictory supervisor/mutation language in docs/rules: fail closed in policy gate.
- Missing required verification scripts in CI: hard error and pipeline failure.
- Cross-repo parity path unavailable: classification is `UNAVAILABLE_NON_BLOCKING` and does not block certification.
