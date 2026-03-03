"use strict";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function dayKeyFromIso(value) {
  const iso = normalizeString(value);
  if (!iso) {
    return "";
  }
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function withinRange(dayKey, fromDayKey, toDayKey) {
  if (!dayKey) {
    return false;
  }
  if (fromDayKey && dayKey < fromDayKey) {
    return false;
  }
  if (toDayKey && dayKey > toDayKey) {
    return false;
  }
  return true;
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjectKeys(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortObjectKeys(value[key]);
  }
  return out;
}

function createMonetizationEngine(options = {}) {
  const apiGovernance = options.apiGovernance;
  if (!apiGovernance || typeof apiGovernance.loadResearchRecords !== "function" || typeof apiGovernance.readState !== "function") {
    const error = new Error("apiGovernance with loadResearchRecords/readState is required");
    error.code = "MONETIZATION_ENGINE_CONFIG_INVALID";
    throw error;
  }

  async function computeMonetizationScore(input = {}) {
    const fromDayKey = normalizeString(input.fromDayKey);
    const toDayKey = normalizeString(input.toDayKey);

    const records = await apiGovernance.loadResearchRecords();
    const state = await apiGovernance.readState();
    const committed = Array.isArray(state && state.outboundMutation && state.outboundMutation.committedPublications)
      ? state.outboundMutation.committedPublications
      : [];

    const filteredRecords = records.filter((record) => withinRange(dayKeyFromIso(record.retrieved_at), fromDayKey, toDayKey));
    const filteredPublishes = committed.filter((record) => withinRange(dayKeyFromIso(record.committedAt), fromDayKey, toDayKey));

    const totalCitationVelocity = filteredRecords.reduce((acc, record) => acc + Number(record && record.citation_velocity ? record.citation_velocity : 0), 0);
    const totalResearchRecords = filteredRecords.length;
    const totalPublishes = filteredPublishes.length;

    // Deterministic bounded scoring model.
    const researchSignal = Math.min(100, Math.floor(totalCitationVelocity / 10) + totalResearchRecords);
    const distributionSignal = Math.min(100, totalPublishes * 10);
    const monetizationScore = Math.min(100, Math.floor((researchSignal * 0.6) + (distributionSignal * 0.4)));

    return sortObjectKeys({
      ok: true,
      fromDayKey: fromDayKey || null,
      toDayKey: toDayKey || null,
      metrics: {
        totalCitationVelocity,
        totalResearchRecords,
        totalPublishes,
        researchSignal,
        distributionSignal
      },
      score: monetizationScore
    });
  }

  return Object.freeze({
    computeMonetizationScore
  });
}

module.exports = {
  createMonetizationEngine
};
