"use strict";

const ALLOWED_DATABASE_IDS = Object.freeze([
  "db_openclaw_publications"
]);

const ALLOWED_PROPERTIES = Object.freeze({
  Name: "title",
  Summary: "rich_text",
  Score: "number",
  Source: "select",
  PublishedAt: "date"
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertAllowedDatabaseId(databaseId) {
  const normalized = normalizeString(databaseId);
  if (!normalized || !ALLOWED_DATABASE_IDS.includes(normalized)) {
    const error = new Error("Notion database ID is not allowlisted");
    error.code = "NOTION_DATABASE_NOT_ALLOWLISTED";
    error.details = { databaseId: normalized };
    throw error;
  }
  return normalized;
}

function assertAllowedProperties(properties) {
  const source = properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {};
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_PROPERTIES, key)) {
      const error = new Error(`Notion property '${key}' is not allowlisted`);
      error.code = "NOTION_PROPERTY_NOT_ALLOWLISTED";
      error.details = { key };
      throw error;
    }
  }
  return true;
}

module.exports = {
  ALLOWED_DATABASE_IDS,
  ALLOWED_PROPERTIES,
  assertAllowedDatabaseId,
  assertAllowedProperties
};
