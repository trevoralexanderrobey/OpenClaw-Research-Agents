# Phase 28 Direct-Delivery Governance

## Scope
- Phase 28 adds deterministic, local-only direct-delivery packaging and post-export delivery evidence governance.
- Phase 28 is separate from Phase 22 platform submission evidence and does not modify Phase 22 semantics.

## Contracts
- Direct-delivery target config:
  - `config/direct-delivery-targets.json`
  - `schema_version: phase28-direct-delivery-targets-v1`
- Offer contract adds `direct_delivery_targets`.
- Delivery packaging contract artifacts:
  - `delivery/<target>/delivery-contract.json`
  - `delivery/<target>/checklist.md`
  - `delivery/<target>/handoff-note.md`
  - `delivery/direct-delivery-targets.json`

## Authoritative Stores
- Per-offer delivery evidence root:
  - `workspace/releases/<offerId>/delivery-evidence/`
- Authoritative stores:
  - `workspace/releases/<offerId>/delivery-evidence/export-events.json`
  - `workspace/releases/<offerId>/delivery-evidence/ledger.json`
- Derived stores:
  - `workspace/releases/<offerId>/delivery-evidence/<deliveryTarget>/delivery-evidence.json`
  - `workspace/releases/index/delivery-evidence-index.json`

## Eligibility and State
- Delivery evidence recording requires:
  - approved release validation
  - export event coverage for the same `delivery_target`
- Initial derived state for a delivery target is:
  - `ready_for_manual_delivery` when first qualifying export event exists
- Allowed states:
  - `ready_for_manual_delivery`
  - `delivery_in_progress`
  - `delivery_completed`
  - `delivery_failed`
  - `needs_redelivery`
  - `withdrawn`

## Manual-Only Boundary
- No API publishing, browser automation, login automation, background sync, or autonomous delivery is added.
- External delivery remains operator-executed manual action.
- Evidence input is operator-supplied local input only.

## Integrity Model
- Authoritative stores are append-only, sequence-numbered, and chain-hashed.
- Authoritative writes use per-offer lock + atomic `temp + fsync + rename`.
- Attachment staging must succeed before event append.
- Idempotency keys are mandatory for delivery evidence events.
- Verification is fail-closed and separate from release approval/hash validity.
