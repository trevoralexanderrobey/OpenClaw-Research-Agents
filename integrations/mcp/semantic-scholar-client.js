"use strict";

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function normalizeRecord(record = {}) {
  return canonicalize({
    source: "semantic-scholar",
    paperId: safeString(record.paperId || record.paper_id),
    title: safeString(record.title),
    abstract: safeString(record.abstract),
    citationCount: Math.max(0, Number(record.citationCount || 0)),
    year: safeString(record.year),
    publicationDate: safeString(record.publicationDate)
  });
}

function createSemanticScholarClient(options = {}) {
  const endpoint = safeString(options.endpoint) || "https://api.semanticscholar.org/graph/v1";

  async function searchPapers(query, config = {}) {
    const url = new URL(`${endpoint}/paper/search`);
    url.searchParams.set("query", safeString(query));
    url.searchParams.set("limit", String(Math.max(1, Number(config.limit || 10))));
    url.searchParams.set("fields", "paperId,title,abstract,citationCount,year,publicationDate");

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const error = new Error(`Semantic Scholar request failed (${response.status})`);
      error.code = "PHASE16_SEMANTIC_SCHOLAR_HTTP_ERROR";
      throw error;
    }

    const payload = await response.json();
    const records = Array.isArray(payload.data) ? payload.data.map((entry) => normalizeRecord(entry)) : [];
    return canonicalize(records);
  }

  async function getPaper(paperId) {
    const url = new URL(`${endpoint}/paper/${encodeURIComponent(safeString(paperId))}`);
    url.searchParams.set("fields", "paperId,title,abstract,citationCount,year,publicationDate");

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const error = new Error(`Semantic Scholar request failed (${response.status})`);
      error.code = "PHASE16_SEMANTIC_SCHOLAR_HTTP_ERROR";
      throw error;
    }

    const payload = await response.json();
    return normalizeRecord(payload);
  }

  async function getCitationMetrics(paperId) {
    const paper = await getPaper(paperId);
    return canonicalize({
      paperId: safeString(paper.paperId),
      citationCount: Math.max(0, Number(paper.citationCount || 0)),
      timestamp: "1970-01-01T00:00:00.000Z"
    });
  }

  return Object.freeze({
    searchPapers,
    getPaper,
    getCitationMetrics
  });
}

module.exports = {
  createSemanticScholarClient
};
