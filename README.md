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

## Governance Boundary
- Internal generation may be autonomous for research synthesis, dataset builds, Phase 20 validation/dedupe/provenance/scoring/license classification, packaging, store copy, and submission-pack preparation.
- Final release approval remains human-only.
- External publishing, uploads, marketplace submissions, customer delivery, login automation, and browser automation remain manual-only.
- Phase 19 release bundles are packaging artifacts, not proof of publication.

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
  --confirm
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
- `release-approval.json` only after manual approval

Dataset-backed offer behavior:
- default dataset resolution uses the latest commercialization-ready build from `workspace/datasets/index/datasets-index.json`
- `review_required` builds require explicit `--build-id` selection and remain warning-bearing/manual-review artifacts
- `blocked` builds do not flow into normal dataset packaging
- external publication/submission remains manual-only even when a build is commercialization-ready

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

## Validation Commands
```bash
npm run phase2:gates
bash scripts/verify-phase18-policy.sh
bash scripts/verify-monetization-policy.sh
bash scripts/verify-phase19-policy.sh
bash scripts/verify-phase20-policy.sh
npm run monetization:verify
npm run phase19:verify
npm run phase20:verify
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
