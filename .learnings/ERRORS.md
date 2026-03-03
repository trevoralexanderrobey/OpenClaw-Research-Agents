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
