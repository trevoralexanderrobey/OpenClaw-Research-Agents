"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("supervisor architecture doc includes required Cline contract clauses", () => {
  const source = read("docs/supervisor-architecture.md");
  assert.match(source, /Cline \(Plan\/Act\) is a recommended outer operator workflow/);
  assert.match(source, /canonical runtime supervisor\/governance authority remains in-repo/);
  assert.match(source, /Supervisor is orchestration\/approval-facing only and is not a privileged mutation executor/);
  assert.match(source, /Protected mutations require operator role, scoped approval token, governance transaction wrapper, and kill-switch-open state/);
  assert.match(source, /External submission, platform login, attestation, and final submission actions are manual-only/);
  assert.match(source, /CI policy gates are release-blocking/);
});

test("README and policy docs include supervisor model and failure-mode markers", () => {
  const readme = read("README.md");
  const attackSurface = read("docs/attack-surface.md");
  const failureModes = read("docs/failure-modes.md");

  assert.match(readme, /## Outer Operator Workflow \(Cline-compatible\)/);
  assert.match(readme, /manual-only/);

  assert.match(attackSurface, /## Outer Cline workflow boundary/);
  assert.match(attackSurface, /No new egress domains or dynamic endpoint expansion/);

  assert.match(failureModes, /## Cline supervisor policy gate failure/);
  assert.match(failureModes, /runbook/i);

  const rulesPath = path.join(root, ".clinerules");
  if (fs.existsSync(rulesPath)) {
    const rules = read(".clinerules");
    assert.match(rules, /No autonomous external submission/);
    assert.match(rules, /No automated login, browser automation/);
    assert.match(rules, /Policy gates are blocking/);
  }
});
