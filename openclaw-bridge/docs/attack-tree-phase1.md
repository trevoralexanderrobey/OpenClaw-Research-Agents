# Attack Tree (Phase 1)

## Root: compromise research runtime integrity

### A. Gain unauthorized execution capability
- A1: invoke external tools as supervisor
- A2: bypass mutation freeze flags

### B. Escape runtime isolation
- B1: exploit privileged container flags
- B2: exploit writable root filesystem

### C. Exfiltrate credentials
- C1: leak keys via logs/errors
- C2: bypass credential broker boundaries

### D. Corrupt deterministic state
- D1: non-atomic state write race
- D2: malformed reinjection ordering

All nodes must be mapped in `threat-traceability-matrix.md`.
