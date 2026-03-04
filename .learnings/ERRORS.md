# Errors Log

## [ERR-20260303-001] npm-cache-checksum volatile metadata drift

**Logged**: 2026-03-03T03:30:00-08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary
Cache checksum verification initially failed due volatile npm metadata file drift.

### Error
```
Cached file size mismatch: ../.ci/npm-cache/_update-notifier-last-checked
```

### Context
- Command: `bash scripts/verify-npm-cache-checksum.sh`
- Root cause: npm updates `_update-notifier-last-checked` independently of dependency content.

### Suggested Fix
Exclude volatile npm metadata and `_logs/` from lock manifest and enforce exact checks for deterministic cache files.

### Metadata
- Reproducible: yes
- Related Files: scripts/generate-npm-cache-lock.sh, scripts/verify-npm-cache-checksum.sh

### Resolution
- **Resolved**: 2026-03-03T03:34:00-08:00
- **Notes**: Added volatile-file exclusions and strict unexpected-file drift detection.

## [ERR-20260303-002] shell invocation mixed with status text

**Logged**: 2026-03-03T14:10:00-08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
A shell command failed because I prefixed it with human progress text.

### Error
```
zsh:1: command not found: I’m
```

### Context
- Command attempted from implementation loop while gathering references.
- Root cause: mixed natural language with shell input.

### Suggested Fix
Keep progress updates in assistant commentary only and send pure shell commands to the execution tool.

### Metadata
- Reproducible: yes
- Related Files: .learnings/ERRORS.md

### Resolution
- **Resolved**: 2026-03-03T14:10:00-08:00
- **Notes**: Split status updates from command payloads.

## [ERR-20260303-003] parallel verification raced on dependency state

**Logged**: 2026-03-03T15:44:08-08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Running `npm test` and `bash scripts/build-verify.sh` in parallel caused transient module resolution failures.

### Error
```
Error: Cannot find module 'zod'
Error: Cannot find module './helpers/errorUtil'
```

### Context
- Command pattern: concurrent execution of test and build verification in the same workspace.
- Root cause: both commands mutate/read dependency state (`node_modules`/install steps) and are not safe to run concurrently.

### Suggested Fix
Run dependency-touching verification steps serially; reserve parallel execution for read-only checks.

### Metadata
- Reproducible: yes
- Related Files: .learnings/ERRORS.md

### Resolution
- **Resolved**: 2026-03-03T15:44:08-08:00
- **Notes**: Switched to serial execution (`build-verify` then `npm test`) and suite passed cleanly.

## [ERR-20260303-004] outcome-schema strict parse rejected hashed records

**Logged**: 2026-03-04T04:40:00Z
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary
Phase 6 outcome integrity tests failed because semantic validation parsed hashed records with a strict schema that disallowed hash fields.

### Error
```
ZodError: Unrecognized key(s) in object: 'outcomeHash', 'prevChainHash', 'chainHash'
```

### Context
- Command: `node --test tests/security/state-schema-v6.test.js tests/security/rlhf-outcome-capture.test.js tests/security/rlhf-outcome-integrity.test.js ...`
- Root cause: `assertOutcomeSemantics()` used `OutcomeRecordWithoutHashesSchema.parse(record)` directly, so full records failed validation before integrity checks.

### Suggested Fix
Validate semantics on a projected subset (without hash fields) or allow passthrough parsing for full records before semantic checks.

### Metadata
- Reproducible: yes
- Related Files: workflows/rlhf-outcomes/outcome-schema.js, workflows/rlhf-outcomes/outcome-validator.js

### Resolution
- **Resolved**: 2026-03-04T04:42:00Z
- **Notes**: Updated semantic validation to parse a projected non-hash subset before strict checks; Phase 6 targeted suite now passes.

## [ERR-20260304-005] phase7 normalization dropped required split basis points

**Logged**: 2026-03-04T00:22:00-08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
Phase 7 lifecycle tests failed after `approve/start` because runtime normalization removed `splitBasisPoints` from persisted experiment records.

### Error
```
ZodError: invalid_type expected object received undefined at path splitBasisPoints
```

### Context
- Command: `node --test tests/security/experiment-*.test.js`
- Root cause: `normalizeExperimentRecord()` in `security/api-governance.js` did not preserve `splitBasisPoints`.

### Suggested Fix
Add deterministic `splitBasisPoints` normalization with strict sum=10000 fallback and keep it in canonical experiment records.

### Metadata
- Reproducible: yes
- Related Files: security/api-governance.js

### Resolution
- **Resolved**: 2026-03-04T00:24:00-08:00
- **Notes**: Added `normalizeSplitBasisPoints()` and persisted field in experiment normalization; Phase 7 tests passed.

## [ERR-20260304-006] phase7 policy grep alternation escaped incorrectly

**Logged**: 2026-03-04T00:31:00-08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
`verify-phase7-policy.sh` failed on valid code because regex alternation used escaped `\|` in ripgrep patterns.

### Error
```
Missing approval token consumption in workflows/experiment-governance/experiment-manager.js
Rollout governor missing pre-registration lock verification
```

### Context
- Command: `bash scripts/verify-phase7-policy.sh`
- Root cause: `rg` pattern used `consumeScopedApprovalToken\|consumeApprovalToken` and similar strings, matching literal `|` instead of alternation.

### Suggested Fix
Use proper alternation syntax (`a|b`) in ripgrep patterns.

### Metadata
- Reproducible: yes
- Related Files: scripts/verify-phase7-policy.sh

### Resolution
- **Resolved**: 2026-03-04T00:33:00-08:00
- **Notes**: Updated `rg` checks to use valid alternation, verification script now passes.
