"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createPolicyDriftDetector, DEFAULT_REQUIRED_CLAUSES } = require("../../workflows/governance-automation/policy-drift-detector.js");

const root = path.resolve(__dirname, "../..");

test("phase9 drift detector identifies drift categories", () => {
  const detector = createPolicyDriftDetector({
    baselineContracts: {
      requiredClauses: DEFAULT_REQUIRED_CLAUSES
    },
    currentContracts: {
      "docs/supervisor-architecture.md": "supervisor may execute protected mutations\napproval token optional\n",
      "security/operator-authorization.js": "module.exports = {};\n",
      ".github/workflows/phase2-security.yml": "if [[ -f scripts/verify-phase7-policy.sh ]]; then\n",
      "security/mutation-control.js": "module.exports = {};\n",
      "docs/phase8-compliance-attestation.md": ""
    }
  });

  const result = detector.detectDrifts({ rootDir: root });
  assert.equal(result.operator_action_required, true);
  const ids = new Set(result.drifts.map((entry) => entry.id));
  assert.ok(ids.has("supervisor-non-mutation-boundary"));
  assert.ok(ids.has("operator-approval-token-required"));
  assert.ok(ids.has("kill-switch-precedence"));
  assert.ok(ids.has("autonomous-boundary-weakened"));
  assert.ok(ids.has("approval-token-scope-relaxed"));
  assert.ok(ids.has("policy-gate-skip-logic"));
  assert.ok(ids.has("evidence-integrity-claim"));
});

test("phase9 drift detector output is deterministic", () => {
  const detector = createPolicyDriftDetector({
    baselineContracts: { requiredClauses: DEFAULT_REQUIRED_CLAUSES }
  });

  const first = detector.detectDrifts({ rootDir: root });
  const second = detector.detectDrifts({ rootDir: root });
  assert.deepEqual(second, first);
});

test("phase9 drift detector returns the same output when rg fallback is forced", () => {
  const detector = createPolicyDriftDetector({
    baselineContracts: { requiredClauses: DEFAULT_REQUIRED_CLAUSES }
  });

  const before = detector.detectDrifts({ rootDir: root });
  process.env.PHASE9_POLICY_FORCE_NO_RG = "1";
  const after = detector.detectDrifts({ rootDir: root });
  delete process.env.PHASE9_POLICY_FORCE_NO_RG;
  assert.deepEqual(after, before);
});

test("phase9 drift detector is read-only", () => {
  const detector = createPolicyDriftDetector({
    baselineContracts: { requiredClauses: DEFAULT_REQUIRED_CLAUSES }
  });
  const before = require("node:fs").readFileSync(path.join(root, "workspace/runtime/state.json"), "utf8");
  detector.detectDrifts({ rootDir: root });
  const after = require("node:fs").readFileSync(path.join(root, "workspace/runtime/state.json"), "utf8");
  assert.equal(after, before);
});
