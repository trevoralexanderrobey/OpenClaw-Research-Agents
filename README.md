# OpenClaw Research Agents

Governed, local-first research, dataset, and release-packaging system built on OpenClaw patterns.

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

## Governance Boundary
- Internal generation may be autonomous for research synthesis, dataset builds, packaging, store copy, and submission-pack preparation.
- Final release approval remains human-only.
- External publishing, uploads, marketplace submissions, customer delivery, login automation, and browser automation remain manual-only.
- Phase 19 release bundles are packaging artifacts, not proof of publication.

## Supervisor Model (Cline)
- Cline is the supervisor interface for governed local operations in this repository.
- Supervisor activity is orchestration and approval facing only; protected mutations still require explicit operator approval.
- External submission and platform interaction remain manual-only.

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

## Dataset Foundation

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

Phase 19 does not yet implement full provenance, licensing review, dataset scoring, dedupe, or publisher adapters.

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

Phase 19 dataset runtime:
- `openclaw-bridge/dataset/schema-engine.js`
- `openclaw-bridge/dataset/dataset-builder.js`
- `openclaw-bridge/dataset/dataset-output-manager.js`
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
npm run monetization:verify
npm run phase19:verify
node --test tests/**/*.test.js
npm run build:verify
```

GitHub Actions workflows are archived under `.github/archived-workflows/` so validation stays local-only and uses the script/package command chain instead of cloud runners.

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
