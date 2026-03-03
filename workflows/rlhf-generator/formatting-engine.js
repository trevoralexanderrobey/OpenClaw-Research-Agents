"use strict";

function normalizeArray(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => String(item || "").trim()).filter(Boolean);
}

function escapePipes(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

function rubricRows(rubric) {
  const rows = Array.isArray(rubric) ? rubric : [];
  return rows.map((row) => {
    const criterion = escapePipes(row.criterion);
    const weight = Number.isFinite(Number(row.weight)) ? Math.max(0, Math.min(100, Math.floor(Number(row.weight)))) : 0;
    const guidance = escapePipes(row.guidance);
    return `| ${criterion} | ${weight} | ${guidance} |`;
  });
}

function formatDraftMarkdown(payload = {}, options = {}) {
  const templateVersion = typeof options.templateVersion === "string" && options.templateVersion.trim()
    ? options.templateVersion.trim()
    : "v1";
  const checklist = normalizeArray(payload.reviewerChecklist);
  const authors = normalizeArray(payload.sourceAuthors);
  const rubric = rubricRows(payload.rubric);

  const lines = [
    "# AI-Assisted RLHF Draft (Human Review Required)",
    "",
    "This draft was generated with AI assistance and requires human editorial review before any external submission.",
    "",
    `Template Version: ${templateVersion}`,
    "",
    "## Source Metadata",
    `- Source Paper ID: ${String(payload.sourcePaperId || "")}`,
    `- Source Hash: ${String(payload.sourceHash || "")}`,
    `- Domain Tag: ${String(payload.domainTag || "general-research")}`,
    `- Source Title: ${String(payload.sourceTitle || "")}`,
    `- Source Published At: ${String(payload.sourcePublishedAt || "")}`,
    `- Source Retrieved At: ${String(payload.sourceRetrievedAt || "")}`,
    `- Generator Version: ${String(payload.generatorVersion || "v1")}`,
    authors.length > 0 ? `- Source Authors: ${authors.join(", ")}` : "- Source Authors: (not provided)",
    "",
    "## Target Prompt",
    String(payload.targetPrompt || ""),
    "",
    "## Golden Response",
    String(payload.goldenResponse || ""),
    "",
    "## Grading Rubric",
    "| Criterion | Weight | Guidance |",
    "| --- | ---: | --- |",
    ...rubric,
    "",
    "## Reviewer Checklist",
    ...checklist.map((item) => `- [ ] ${item}`),
    "",
    "## Manual Submission Reminder",
    "Human operator must perform platform login, attestations, and final submission manually.",
    "Do not automate submission, credential use, browser control, or identity declarations.",
    ""
  ];

  return `${lines.join("\n")}\n`;
}

module.exports = {
  formatDraftMarkdown
};
