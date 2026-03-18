# OpenClaw Research Agents

Governed, local-first research, dataset, and release-packaging system built on OpenClaw patterns.

Runtime requirement:
- Node `22.13.1` is required and enforced through `engines`, `devEngines`, `.npmrc` `engine-strict=true`, and `scripts/verify-node-runtime.js`.

## Local Setup
```bash
nvm install 22.13.1
nvm use 22.13.1
node -v
npm ci
npm run phase20:verify
npm run phase21:verify
npm run phase22:verify
npm run phase26:verify
npm run monetization:verify
npm run build:verify
```

## Secret Scanning
```bash
bash scripts/install-ggshield.sh
export GITGUARDIAN_API_KEY='<load from your shell secret store>'
npm run secrets:verify
```

- `scripts/verify-secrets.sh` prefers authenticated `ggshield` scans and falls back to the legacy regex scan when a token is not configured yet.
- CI can enforce authenticated scanning by setting the `GITGUARDIAN_API_KEY` repository secret.
- Do not store GitGuardian API keys in `.gitguardian.yaml`, tracked `.env` files, or workflow YAML.

## Current Baseline
- Operator-initiated research tasks run through supervisor and governance approval.
- Phase 18 mission orchestration is already in place:
  - bounded concurrent dispatch
  - dependency-aware scheduling
  - deterministic orchestrator-owned synthesis
  - timeout, stall, resume, and checkpoint controls
  - bounded deterministic lane scaling
- Phase 19 adds:
  - deterministic dataset foundation under `workspace/datasets/`
  - deterministic monetization and release packaging under `workspace/releases/`
- Phase 20 adds deterministic dataset commercialization gates:
  - row validation and minimum completeness enforcement
  - exact dedupe with stable near-duplicate hook points
  - row-level and build-level provenance artifacts
  - deterministic quality scoring and threshold evaluation
  - fail-closed licensing classification with commercialization gating
- Phase 21 adds deterministic publisher adapter boundaries for submission-pack generation and release approval:
  - one adapter registry entry per configured platform target
  - deterministic per-target `adapter-manifest.json` contracts
  - fail-closed approval validation for adapter manifest/snapshot integrity
- Phase 22 adds deterministic post-export manual submission evidence governance:
  - authoritative append-only chain-hashed `export-events.json` and `ledger.json`
  - platform-target eligibility derived from export events (`ready_for_manual_submission` initialization)
  - operator-only submission outcome recording with idempotency and fail-closed transition validation
  - derived per-target snapshots and repo index rebuilt only from authoritative stores
- Phase 26A adds the minimal bridge/auth/principal prerequisite substrate for future integration work:
  - Streamable HTTP support at `/mcp` (with legacy compatibility routes retained)
  - shared token-to-principal resolution across MCP and jobs routes
  - explicit lane separation for `supervisor`, `operator`, and `integration_hatchify`
  - fail-closed denial of Hatchify access to operator mutation routes
- Phase 27 adds governed Sider + Hatchify integration:
  - integration role/scope lane (`integration_hatchify` + `integration.hatchify.readonly`) via existing Phase 13 token lifecycle
  - server-enforced read-only integration allowlist
  - manual-only redacted Sider export + deterministic manual re-entry artifacts

## Governance Boundary
- Internal generation may be autonomous for research synthesis, dataset builds, Phase 20 validation/dedupe/provenance/scoring/license classification, packaging, store copy, and submission-pack preparation.
- Final release approval remains human-only.
- External publishing, uploads, marketplace submissions, customer delivery, login automation, and browser automation remain manual-only.
- Phase 19 release bundles are packaging artifacts, not proof of publication.
- Phase 22 evidence verification is separate from release bundle approval/hash validity; it governs post-export integrity only.

## Outer Operator Workflow (Cline-compatible)
- Cline (Plan/Act) is a recommended outer human-operated workflow for this repository.
- Use Plan mode first for repo assessment and architecture decisions, then switch to Act mode after review/approval.
- Use conservative Auto Approve settings for internal read/edit/safe local command work only.
- Do not use YOLO mode for governed workflows in this repository.
- The repository remains tool-agnostic and local-first; no runtime dependency on Cline is required.
- Repo runtime authority remains in-repo through `supervisor-authority` plus governance pathways.
- Final release approval and all external submission/publication actions remain manual-only.

## Key Paths
- `workspace/research-output/` research task outputs and manifests
- `workspace/missions/` mission-local orchestration state
- `workspace/datasets/raw/<datasetId>/` raw dataset source snapshots
- `workspace/datasets/staged/<datasetId>/<buildId>/` deterministic staged dataset builds
- `workspace/datasets/index/datasets-index.json` canonical dataset/build index and latest-build lookup
- `workspace/releases/<offerId>/` deterministic release bundles
- `workspace/releases/<offerId>/submission-evidence/` authoritative post-export evidence stores

## Dataset Identity
- `dataset_id` is the stable dataset identity.
- `build_id` is the specific deterministic dataset build identity.
- Latest-build lookup comes from `workspace/datasets/index/datasets-index.json`, not filesystem timestamps.

## Quick Start

1. Install dependencies:
```bash
npm ci --offline --ignore-scripts --cache ./.ci/npm-cache
```

2. Run a mock research task:
```bash
node scripts/run-research-task.js \
  --task "Summarize the sample input documents" \
  --type summarize \
  --input workspace/research-input/sample/ \
  --output workspace/research-output/ \
  --provider mock \
  --confirm
```

3. Build a dataset from an existing research task:
```bash
node scripts/build-dataset-from-task.js \
  --task-id task-EXAMPLE \
  --dataset-type instruction_qa \
  --confirm
```

4. Run a first `research_to_dataset` mission:
```bash
node scripts/run-dataset-mission.js \
  --task "Build a dataset-ready mission artifact from the sample corpus" \
  --dataset-type retrieval_qa \
  --input workspace/research-input/sample/ \
  --confirm
```

5. Generate a release bundle from a completed mission:
```bash
node scripts/generate-offer.js \
  --source mission-EXAMPLE \
  --product-line research_packs \
  --tier standard \
  --targets gumroad,lemon_squeezy \
  --confirm
```

6. Generate a release bundle from a completed dataset:
```bash
node scripts/generate-offer.js \
  --source dataset-EXAMPLE \
  --product-line dataset_packs \
  --tier premium \
  --targets hugging_face,kaggle \
  --confirm
```

7. Approve the exact packaged bundle for export:
```bash
node scripts/approve-release.js \
  --offer-id offer-EXAMPLE \
  --operator-id operator-cli \
  --confirm
```

8. Export for manual upload or manual delivery:
```bash
node scripts/export-release.js \
  --offer-id offer-EXAMPLE \
  --format zip \
  --operator-id operator-cli \
  --confirm
```

9. Record platform submission outcome evidence (post-export):
```bash
node scripts/record-submission-outcome.js \
  --offer-id offer-EXAMPLE \
  --platform-target gumroad \
  --operator-id operator-cli \
  --outcome-state submitted_pending_review \
  --idempotency-key phase22-demo-001 \
  --notes "Submitted manually in seller portal" \
  --confirm
```

10. Verify Phase 22 evidence integrity:
```bash
node scripts/verify-submission-evidence.js --offer-id offer-EXAMPLE --mode full
node scripts/verify-submission-evidence.js --offer-id offer-EXAMPLE --mode incremental
node scripts/verify-submission-evidence.js --mode rebuild
```

## Dataset Foundation and Commercialization Gates

Supported Phase 19 dataset types:
- `instruction_qa`
- `retrieval_qa`
- `benchmark_eval`
- `classification`
- `knowledge_graph`

Dataset builds write deterministic artifacts:
- `dataset.jsonl`
- `metadata.json`
- `manifest.json`
- `schema.json`
- `build-report.json`
- `validation-report.json`
- `dedupe-report.json`
- `provenance.json`
- `quality-report.json`
- `license-report.json`

Dataset index records now distinguish:
- `latest_build_id`
- `latest_validated_build_id`
- `latest_commercialization_ready_build_id`
- `latest_review_required_build_id`

Deterministic dataset states:
- `allowed`
- `review_required`
- `blocked`

A dataset build is commercialization-ready only when:
- row validation passes
- build-quality thresholds pass
- provenance is present for produced rows
- license review resolves to `allowed`

Unknown rights state is fail-closed and never treated as `allowed`.

## Monetization and Release Packaging

Supported product lines:
- `research_retainers`
- `research_subscriptions`
- `research_packs`
- `dataset_samples`
- `dataset_packs`
- `dataset_subscriptions`
- `custom_dataset_services`
- `enterprise_private_delivery`
- `sponsorship_assets`

Supported tiers:
- `sample`
- `standard`
- `premium`
- `enterprise`

Release bundles write deterministic local artifacts:
- `offer.json`
- `metadata.json`
- `manifest.json`
- `checksums.txt`
- `release-notes.md`
- `deliverables/`
- `submission/<platform>/`
- `submission/<platform>/adapter-manifest.json`
- `release-approval.json` only after manual approval

Dataset-backed offer behavior:
- default dataset resolution uses the latest commercialization-ready build from `workspace/datasets/index/datasets-index.json`
- `review_required` builds require explicit `--build-id` selection and remain warning-bearing/manual-review artifacts
- `blocked` builds do not flow into normal dataset packaging
- external publication/submission remains manual-only even when a build is commercialization-ready

## Phase 21 Publisher Adapter Boundary

- Submission pack generation is adapter-driven with deterministic manifests:
  - `schema_version: phase21-publisher-adapter-manifest-v1`
  - `adapter_id` / `adapter_version`
  - `input_snapshot_hash`
  - `generated_files`
  - `generated_files_sha256`
  - `manual_only: true`
- Adapters are local artifact generators only:
  - no network calls
  - no login or browser automation
  - writes confined to `submission/<platform>/...`
- Runtime fails closed if adapter registry coverage does not match configured `platform_targets`.
- Phase 21 approvals are versioned (`phase21-release-approval-v1`) and validate adapter contracts before export.

Supported platform submission packs remain manual-only:
- `hugging_face`
- `kaggle`
- `gumroad`
- `lemon_squeezy`
- `aws_data_exchange`
- `snowflake_marketplace`
- `google_cloud_marketplace_bigquery`
- `datarade`
- `github_sponsors`

## Phase 22 Post-Export Manual Submission Evidence Ledger

- Scope is local-only, platform-only, post-export governance.
- Phase 22 does not add live publishing, browser automation, login automation, or outbound submission.
- Eligibility to record evidence for `platform_target = X` requires:
  - `validateApprovedRelease(offerId)` success
  - authoritative `submission-evidence/export-events.json` has `bundle_exported` covering `X`
- Authoritative per-offer stores:
  - `workspace/releases/<offerId>/submission-evidence/export-events.json`
  - `workspace/releases/<offerId>/submission-evidence/ledger.json`
- Derived artifacts:
  - `workspace/releases/<offerId>/submission-evidence/<platform>/submission-evidence.json`
  - `workspace/releases/index/submission-evidence-index.json`
- Initial state is derived only from export history:
  - first qualifying export event for a target initializes `ready_for_manual_submission`
  - no synthetic evidence event is created for initialization
- Submission states:
  - `ready_for_manual_submission`
  - `submitted_pending_review`
  - `published_confirmed`
  - `rejected`
  - `needs_revision`
  - `withdrawn`
- Terminal states:
  - `published_confirmed`
  - `withdrawn`
- Evidence events require non-empty operator payload:
  - at least one of attachment files, `external_ref`, or `notes`
- `approved_bundle_hash` is manager-resolved from `release-approval.json.hash_of_release_bundle` and is never operator-supplied.
- Evidence attachments are constrained by deterministic policy:
  - allowed extensions `.json,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.pdf`
  - max 25 MiB per file
  - max 20 files per event
  - deterministic stored names `<sequence>-<ordinal>-<sha16>.<ext>`
  - refs include `stored_path`, `original_filename`, `sha256`, `byte_size`, `file_type`
- Authoritative writes are append-only with per-offer file lock and atomic `temp + fsync + rename`.
- Corrections are new append-only events only; no in-place history rewrites.

## Architecture

Core research runtime:
- `scripts/run-research-task.js`
- `scripts/_research-runtime.js`
- `openclaw-bridge/core/agent-engine.js`
- `openclaw-bridge/core/research-output-manager.js`
- `openclaw-bridge/core/mission-envelope-schema.js`
- `openclaw-bridge/core/agent-spawner.js`
- `openclaw-bridge/core/spawn-planner.js`
- `openclaw-bridge/core/spawn-orchestrator.js`

Phase 19/20 dataset runtime:
- `openclaw-bridge/dataset/schema-engine.js`
- `openclaw-bridge/dataset/dataset-builder.js`
- `openclaw-bridge/dataset/dataset-output-manager.js`
- `openclaw-bridge/dataset/provenance-tracker.js`
- `openclaw-bridge/dataset/dataset-validator.js`
- `openclaw-bridge/dataset/dataset-deduper.js`
- `openclaw-bridge/dataset/dataset-scorer.js`
- `openclaw-bridge/dataset/license-review.js`
- `scripts/build-dataset-from-task.js`
- `scripts/run-dataset-mission.js`

Phase 19 monetization runtime:
- `scripts/_monetization-runtime.js`
- `openclaw-bridge/monetization/offer-schema.js`
- `openclaw-bridge/monetization/offer-builder.js`
- `openclaw-bridge/monetization/deliverable-packager.js`
- `openclaw-bridge/monetization/submission-pack-generator.js`
- `openclaw-bridge/monetization/release-approval-manager.js`
- `openclaw-bridge/monetization/submission-evidence-schema.js`
- `openclaw-bridge/monetization/manual-fulfillment-state-machine.js`
- `openclaw-bridge/monetization/submission-evidence-ledger.js`
- `openclaw-bridge/monetization/submission-evidence-manager.js`

## Validation Commands
```bash
npm run phase2:gates
bash scripts/verify-phase18-policy.sh
bash scripts/verify-monetization-policy.sh
bash scripts/verify-phase19-policy.sh
bash scripts/verify-phase20-policy.sh
bash scripts/verify-phase21-policy.sh
bash scripts/verify-phase22-policy.sh
npm run monetization:verify
npm run phase19:verify
npm run phase20:verify
npm run phase21:verify
npm run phase22:verify
node --test tests/**/*.test.js
npm run build:verify
```

## CI Enforcement (Primary)
GitHub Actions is the primary enforcement path for this public repository, using standard GitHub-hosted runners.

Workflow:
- `OpenClaw-Research-Agents-CI` (`.github/workflows/ci-enforcement.yml`)

Recommended branch ruleset:
- `ORA Branch Protection` on `main` with pull request required and minimum 1 approval.

Required status check names for branch protection/rulesets:
- `OpenClaw-Research-Agents-CI / policy-and-tests`
- `OpenClaw-Research-Agents-CI / deterministic-build-verify`

Local hooks are optional developer convenience only and are not the canonical enforcement boundary.

### Optional Local Hook Cleanup
If this clone still points `core.hooksPath` at repo-managed hooks, inspect or unset it locally:
```bash
git config --local --get core.hooksPath
git config --local --unset core.hooksPath
```

## Phase Status

| Phase | Focus | Status |
|---|---|---|
| 2-13 | Governance and security foundation | Complete |
| 14 | Core research execution | Implemented |
| 15 | Multi-agent topology and comms | Implemented |
| 16 | MCP ingestion and normalization | Implemented |
| 17 | Runtime hardening and resume | Implemented |
| 18 | Mission orchestration | Implemented |
| 19A | Monetization and release packaging | Implemented |
| 19B | Dataset foundation | Implemented |
| 20 | Quality, provenance, and licensing commercialization gates | Implemented |
| 21 | Publisher adapter boundaries and release approval/export validation | Implemented |
| 22 | Post-export manual submission evidence ledger and verification | Implemented |
| 26A | Bridge streamable/auth principal prerequisite slice | Implemented |
| 27 | Sider + Hatchify governed integration boundary | Implemented |

## Future Roadmap

Planned post-Phase 22 work is tracked in `future openclaw research agents phases to be implemented.` at the repository root.

Current planned implementation wave:
- Phase 23: portfolio intelligence and submission outcome analysis
- Phase 24: operator sync and briefing MCP activation
- Phase 25: credential broker and delegated session governance
- Phase 26: bridge runtime and execution-router consolidation
- Phase 27: Sider + Hatchify governed integration
- Phase 28: direct-delivery channels and manual fulfillment evidence

Current dependency-ordered execution lock for the Sider + Hatchify objective:
- PR 1: roadmap/docs lock
- PR 2: Phase 26A minimal prerequisite slice only
- PR 3: Phase 27 implementation
- PR 4: Phase 28 implementation

Phase 26A is a minimal prerequisite subset of Phase 26, not full consolidation. Phase 23 remains portfolio intelligence and is not renumbered.
