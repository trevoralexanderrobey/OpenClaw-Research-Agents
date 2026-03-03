# Phase 1 Hard Freeze Policy

Phase 1 prohibits enabling outbound mutation paths.

## Freeze rules
1. `ENABLE_OPERATOR_MUTATIONS=false`
2. `ENABLE_EXTERNAL_POST_PUT_DELETE=false`
3. Publisher and sync MCPs remain stub-only.

## Change-control requirement
Any request to enable POST/PUT/DELETE paths requires:
1. Security architecture review.
2. Threat-model update.
3. Test and evidence update.
4. Auditor-visible approval record.
