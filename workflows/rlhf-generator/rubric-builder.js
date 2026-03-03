"use strict";

function buildRubric(candidate = {}) {
  const domainTag = String(candidate.domainTag || "general-research");
  const base = [
    {
      criterion: "Task Understanding",
      weight: 25,
      guidance: "Response directly addresses the target task and preserves stated constraints."
    },
    {
      criterion: "Technical Accuracy",
      weight: 30,
      guidance: "Claims are internally consistent and technically sound for the source domain."
    },
    {
      criterion: "Reasoning Quality",
      weight: 25,
      guidance: "Argument structure is explicit, coherent, and avoids unsupported leaps."
    },
    {
      criterion: "Compliance and Safety",
      weight: 20,
      guidance: "Output preserves disclosure language and avoids concealment or evasion instructions."
    }
  ];

  if (domainTag === "mathematics") {
    base[1].guidance = "Definitions, derivations, and conclusions remain logically valid and unambiguous.";
  } else if (domainTag === "security") {
    base[3].guidance = "Output remains policy-safe, non-evasive, and strictly bounded to authorized analysis.";
  } else if (domainTag === "distributed-systems") {
    base[2].guidance = "Reasoning includes tradeoffs around consistency, availability, and failure handling.";
  }

  return base;
}

module.exports = {
  buildRubric
};
