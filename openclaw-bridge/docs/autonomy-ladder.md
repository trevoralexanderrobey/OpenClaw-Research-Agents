# Autonomy Ladder (Phase 1)

## Levels
- `L1` Supervisor: orchestration only, no direct external tool execution.
- `L2` Scout/Analyst/Synthesizer: bounded role execution in scoped workspaces.
- `L3` Operator: policy-defined external mutation role, but mutation disabled in Phase 1.

## Enforcement
- Supervisor boundary enforced in execution router: non-`supervisor.*` tools denied.
- Outbound mutation flags are hard-disabled in Phase 1.
- File-system scope constrained to role subdirectories and `workspace/comms/`.
