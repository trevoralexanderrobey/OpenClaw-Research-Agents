# Phase 2 Security Checklist

- [ ] Purge validation passes (`scripts/cleanroom-purge-validate.sh`)
- [ ] Secret scan passes (`scripts/verify-secrets.sh`)
- [ ] Lifecycle scripts prohibited (`scripts/verify-no-lifecycle-hooks.sh`)
- [ ] Offline install enforced (`npm ci --offline --ignore-scripts`)
- [ ] npm cache checksum lock verified (`scripts/verify-npm-cache-checksum.sh`)
- [ ] Runtime policy validated (`scripts/validate-runtime-policy.js`)
- [ ] Tool registry checksum verified (`scripts/verify-tool-registry-checksum.sh`)
- [ ] Container digest-only policy verified (`scripts/verify-container-digest.sh`)
- [ ] Supervisor no-exec boundary test passes
- [ ] State schema and determinism tests pass
- [ ] Gateway fixed localhost:18789 enforcement test passes
- [ ] Restricted globals lint passes (`scripts/lint-restricted-globals.sh`)
- [ ] Reproducible build verification passes (`scripts/build-verify.sh`)
- [ ] SBOM generated (`audit/evidence/phase2/sbom.cyclonedx.json`)
- [ ] Attack surface and failure mode docs present
