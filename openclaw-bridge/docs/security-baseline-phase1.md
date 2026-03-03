# Security Baseline (Phase 1)

## Container isolation baseline
- Non-root user
- Read-only root filesystem
- Capabilities dropped (`ALL`)
- `Privileged=false`
- No host PID/network
- No host bind mounts
- Writable `/scratch` only
- Deterministic runtime and output bounds

## Policy authorities
- `execution/tool-image-catalog.js`
- `execution/sandbox-policy.js`
- `execution/resource-policy.js`
- `execution/egress-policy.js`
- `execution/image-policy.js`
- `execution/container-runtime.js`

## Supervisor boundary
- Supervisor role cannot invoke non-`supervisor.*` tools in execution router.
- Legacy external tool fallback is disabled for supervisor role.

## Freeze controls
- Outbound mutation feature flags disabled by default in `openclaw.json`.

## Workload integrity
- SBOM artifacts generated for supply-chain provenance.
- Lockfile, cache, and code registry checksums formally verified.
- Container digests validated before any runtime action.
