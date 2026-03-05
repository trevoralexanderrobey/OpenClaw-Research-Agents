"use strict";

const { canonicalize } = require("../governance-automation/common.js");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function computeCitationVelocity(recordSet) {
  const records = asArray(recordSet);
  if (records.length === 0) {
    return 0;
  }
  const total = records.reduce((sum, record) => sum + Math.max(0, Number(record.citationCount || 0)), 0);
  return Math.floor(total / records.length);
}

function computeNormalizedScore(recordSet) {
  const records = asArray(recordSet);
  if (records.length === 0) {
    return canonicalize({ citationVelocity: 0, normalizedScore: 0 });
  }

  const velocity = computeCitationVelocity(records);
  const uniqueSources = [...new Set(records.map((record) => String(record.source || "").trim()).filter(Boolean))].length;
  const score = Math.max(0, Math.min(100, Math.floor((velocity / 10) + (uniqueSources * 5))));

  return canonicalize({
    citationVelocity: velocity,
    normalizedScore: score
  });
}

module.exports = {
  computeCitationVelocity,
  computeNormalizedScore
};
