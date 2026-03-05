# Phase 12 Supply Chain Security & Artifact Provenance

## Scope
Phase 12 extends Phase 11 recovery assurance with deterministic supply-chain controls for SBOM generation, dependency integrity verification, provenance attestation, operator-gated dependency governance, advisory-only vulnerability reporting, policy enforcement, and artifact signing.

Non-negotiable boundaries:
- No autonomous dependency update, patch, install, or registry interaction.
- Dependency updates require operator role, scoped approval token (`governance.supply_chain.update`), and explicit `--confirm`.
- Vulnerability reporting is advisory-only.
- SBOM/provenance/signing modules are local-filesystem-only and deterministic.
- All dependency update decisions are immutably logged in Phase 9 override and Phase 10 operational decision ledgers.

## SBOM Generation Workflow
Module: `workflows/supply-chain/sbom-generator.js`  
CLI: `scripts/generate-sbom.js`

Inputs:
- `package.json`
- `package-lock.json`

Output:
- Canonical CycloneDX-compatible JSON with sorted components and deterministic hash.
- Component fields include `name`, `version`, `purl`, `license`, `package_hash_sha256`, `dependency_depth`.

Interpretation:
- `sbom_hash` is the canonical hash used by provenance and signing workflows.
- `dependency_depth` and `direct_dependency` support policy thresholds.

## Dependency Integrity Verification Procedures
Module: `workflows/supply-chain/dependency-integrity-verifier.js`  
CLI: `scripts/verify-dependency-integrity.js`

Known-good source:
- `security/known-good-dependencies.json`

Verifier behavior:
- Detects `added`, `removed`, `modified`, and `hash_mismatches`.
- Fails closed (`valid: false`) for any mismatch or malformed manifest.

## Build Provenance Attestation Workflow
Module: `workflows/supply-chain/build-provenance-attestor.js`  
CLI: `scripts/generate-build-provenance.js`

Required operator-provided inputs:
- `commit_sha`
- `builder_identity`
- `sbom_hash`
- artifact hashes/paths

Output:
- Deterministic SLSA-compatible provenance subset with canonical `provenance_hash`.

## Dependency Update Governance Procedures
Module: `workflows/supply-chain/dependency-update-governor.js`  
CLI: `scripts/approve-dependency-update.js`

Required CLI flags:
- `--approval-token`
- `--update-request`
- `--confirm`

Execution model:
1. `presentUpdatePlan` provides deterministic plan/risk/acceptance criteria.
2. `approveUpdate` enforces operator role + scoped token + confirm.
3. Only `security/known-good-dependencies.json` is updated; package installation remains manual.
4. Approval/rejection decisions are immutably logged.

Phase 13 cross-reference:
- Scope governance for dependency updates is centralized in `security/scope-registry.json` via `governance.supply_chain.update`.
- Role authorization for this scope is governed by `security/rbac-policy.json` and evaluated by the Phase 13 permission boundary model.

## Vulnerability Scanning & Advisory Interpretation
Module: `workflows/supply-chain/vulnerability-reporter.js`  
CLI: `scripts/scan-vulnerabilities.js`

Advisory source:
- `security/vulnerability-advisories.json` (operator-maintained, no auto-download).

Output contract:
- `advisory_only: true`
- `auto_patch_blocked: true`
- deterministic vulnerability list with severity and recommended action.

## Supply Chain Policy Configuration Guide
Module: `workflows/supply-chain/supply-chain-policy-engine.js`

Default policy file:
- `security/supply-chain-policy.json`

Default controls:
- license allowlist
- direct/total dependency bounds
- critical vulnerability threshold
- known-good manifest freshness threshold

Evaluation output is deterministic with canonical violations and score.

## Artifact Signing & Verification Procedures
Module: `workflows/supply-chain/artifact-signing-manager.js`  
CLIs: `scripts/sign-artifact.js`, `scripts/verify-artifact-signature.js`

Key material:
- Template: `security/artifact-signing-key.sample.json`
- Operator key: `security/artifact-signing-key.json` (gitignored)

Signing behavior:
- HMAC-SHA256 over canonical signature seed including artifact hash + SBOM hash + provenance hash.
- Verification recomputes artifact hash and signature deterministically.

## Known-Good Manifest Maintenance
1. Generate current SBOM and review integrity delta.
2. Prepare update request with explicit package/version/hash changes.
3. Execute `approve-dependency-update.js` with scoped token and confirm.
4. Review immutable ledger entries for approval decision traceability.

## Advisory Database Maintenance (Manual Operator-Driven)
1. Update `security/vulnerability-advisories.json` manually from vetted internal process.
2. Keep advisory entries deterministic (`purl` or exact `name + version` matching).
3. Re-run vulnerability scan and policy evaluation after updates.
4. Regenerate Phase 12 evidence artifacts.

## Startup Integrity & Policy Gates
Startup gate:
- `security/phase12-startup-integrity.js`
- Wired in MCP initialization immediately after Phase 11 startup integrity.

Policy gate:
- `scripts/verify-phase12-policy.sh`
- Unconditional in CI/build gating chain.
- Enforces no autonomous update/patch/install, no network clients in Phase 12 modules, and deterministic restricted-global bans.
