"use strict";

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function classifyDomainTag(record = {}) {
  const text = `${normalizeText(record.title)} ${normalizeText(record.abstract)}`;

  const taxonomies = [
    ["security", ["vulnerability", "exploit", "cve", "threat", "sandbox", "privilege", "malware", "security"]],
    ["machine-learning", ["llm", "transformer", "reinforcement", "alignment", "model", "neural", "language model"]],
    ["distributed-systems", ["consensus", "replication", "fault tolerance", "distributed", "throughput", "latency", "raft", "paxos"]],
    ["mathematics", ["theorem", "proof", "lemma", "topology", "algebra", "analysis", "probability"]],
    ["economics", ["market", "incentive", "economics", "pricing", "auction", "utility", "monetization"]]
  ];

  for (const [domainTag, keywords] of taxonomies) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return domainTag;
    }
  }

  return "general-research";
}

function computeComplexityScore(record = {}) {
  const abstractLength = String(record.abstract || "").trim().length;
  const titleLength = String(record.title || "").trim().length;
  const authorsCount = Array.isArray(record.authors) ? record.authors.length : 0;
  const citationVelocity = Number.isFinite(Number(record.citation_velocity))
    ? Math.max(0, Math.floor(Number(record.citation_velocity)))
    : 0;

  const lengthSignal = Math.min(35, Math.floor((abstractLength + titleLength) / 220));
  const authorSignal = Math.min(15, authorsCount);
  const citationSignal = Math.min(50, Math.floor(citationVelocity / 20));

  return Math.max(0, Math.min(100, lengthSignal + authorSignal + citationSignal));
}

function computeMonetizationScore(record = {}, monetizationSnapshot = {}) {
  const globalScore = Number.isFinite(Number(monetizationSnapshot.score))
    ? Math.max(0, Math.floor(Number(monetizationSnapshot.score)))
    : 0;
  const citationVelocity = Number.isFinite(Number(record.citation_velocity))
    ? Math.max(0, Math.floor(Number(record.citation_velocity)))
    : 0;

  const localSignal = Math.min(40, Math.floor(citationVelocity / 25));
  const blended = Math.floor((globalScore * 0.6) + (localSignal * 0.4));
  return Math.max(0, Math.min(100, blended));
}

module.exports = {
  classifyDomainTag,
  computeComplexityScore,
  computeMonetizationScore
};
