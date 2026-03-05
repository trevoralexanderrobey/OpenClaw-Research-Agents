"use strict";

const { safeString, canonicalize } = require("../../workflows/governance-automation/common.js");

function parseEntry(entry) {
  const getTag = (tag) => {
    const match = String(entry || "").match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match ? safeString(match[1]) : "";
  };
  const id = getTag("id");
  return canonicalize({
    source: "arxiv",
    arxivId: id.includes("/abs/") ? id.split("/abs/").pop() : id,
    title: getTag("title"),
    abstract: getTag("summary"),
    publishedAt: getTag("published") || "1970-01-01T00:00:00.000Z"
  });
}

function parseFeed(xml) {
  const out = [];
  const source = String(xml || "");
  const regex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match = regex.exec(source);
  while (match) {
    out.push(parseEntry(match[1]));
    match = regex.exec(source);
  }
  return out;
}

function createArxivClient(options = {}) {
  const endpoint = safeString(options.endpoint) || "https://export.arxiv.org/api/query";

  async function searchPapers(query, config = {}) {
    const url = new URL(endpoint);
    url.searchParams.set("search_query", `all:${safeString(query)}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(Math.max(1, Number(config.limit || 10))));

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const error = new Error(`arXiv request failed (${response.status})`);
      error.code = "PHASE16_ARXIV_HTTP_ERROR";
      throw error;
    }

    const xml = await response.text();
    return canonicalize(parseFeed(xml));
  }

  async function getPaper(arxivId) {
    const url = new URL(endpoint);
    url.searchParams.set("id_list", safeString(arxivId));
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", "1");

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const error = new Error(`arXiv request failed (${response.status})`);
      error.code = "PHASE16_ARXIV_HTTP_ERROR";
      throw error;
    }

    const xml = await response.text();
    const entries = parseFeed(xml);
    return entries[0] || null;
  }

  return Object.freeze({
    searchPapers,
    getPaper
  });
}

module.exports = {
  createArxivClient
};
