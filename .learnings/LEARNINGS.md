## [LRN-20260307-001] correction

**Logged**: 2026-03-07T23:59:00-08:00
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Exact Node runtime pins need explicit enforcement, not just `package.json` `engines`

### Details
During Phase 20 verification the repo declared Node `22.13.1`, but `npm run build:verify` still executed under Node `25.3.0` with only an advisory warning. The user correctly called out that this is not sufficient runtime enforcement. The repo now needs layered enforcement through `.npmrc` `engine-strict=true`, `package.json` `devEngines`, and a repo-owned runtime verifier wired into the main verify scripts so unsupported runtimes fail early.

### Suggested Action
Preserve exact runtime enforcement whenever the repo pins Node precisely, and add policy coverage so the enforcement path cannot silently regress.

### Metadata
- Source: user_feedback
- Related Files: .npmrc, package.json, scripts/verify-node-runtime.js, scripts/build-verify.sh
- Tags: node, npm, runtime-enforcement, correction

---

## [LRN-20260308-002] correction

**Logged**: 2026-03-08T05:40:00-08:00
**Priority**: high
**Status**: pending
**Area**: docs

### Summary
Prompt-contract tasks in this workspace can imply implementation, not just a formatted answer

### Details
I treated the user's XML prompt contract as a request to draft a ggshield setup guide, but the user expected actual repo and environment changes. In this workspace, when a prompt block describes an operational setup task and does not explicitly limit the output to documentation, the safer default is to inspect the repo and implement the requested setup directly.

### Suggested Action
For future prompt-contract tasks, prefer end-to-end implementation first, then summarize what was changed and what still needs credentials or operator input.

### Metadata
- Source: user_feedback
- Related Files: scripts/install-ggshield.sh, scripts/verify-secrets.sh, .gitguardian.yaml
- Tags: correction, prompt-contract, execution, devops

---
