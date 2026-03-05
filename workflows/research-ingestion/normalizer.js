"use strict";

const { canonicalize, safeString, sha256 } = require("../governance-automation/common.js");

function normalizeRecord(rawRecord = {}) {
  const source = safeString(rawRecord.source) || "unknown";
  const title = safeString(rawRecord.title).replace(/\s+/g, " ").trim();
  const abstract = safeString(rawRecord.abstract).replace(/\s+/g, " ").trim();
  const publishedAt = safeString(rawRecord.publishedAt || rawRecord.publicationDate || rawRecord.published_at) || "1970-01-01T00:00:00.000Z";
  const paperId = safeString(rawRecord.paperId || rawRecord.paper_id || rawRecord.arxivId || rawRecord.arxiv_id);
  const citationCount = Math.max(0, Number.parseInt(String(rawRecord.citationCount || rawRecord.citation_velocity || 0), 10) || 0);

  const normalized = canonicalize({
    source,
    paperId,
    title,
    abstract,
    publishedAt,
    citationCount,
    canonicalKey: canonicalPaperKey({ source, paperId, title, publishedAt })
  });

  return normalized;
}

function canonicalPaperKey(normalizedRecord = {}) {
  const source = safeString(normalizedRecord.source);
  const paperId = safeString(normalizedRecord.paperId);
  const title = safeString(normalizedRecord.title).toLowerCase();
  const publishedAt = safeString(normalizedRecord.publishedAt || normalizedRecord.publicationDate || normalizedRecord.published_at);
  const seed = canonicalize({ source, paperId, title, publishedAt });
  return `paper-${sha256(`phase16-paper-key-v1|${JSON.stringify(seed)}`).slice(0, 24)}`;
}

module.exports = {
  normalizeRecord,
  canonicalPaperKey
};
