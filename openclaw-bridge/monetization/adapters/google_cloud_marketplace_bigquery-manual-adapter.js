"use strict";

const { createManualPlaceholderAdapter } = require("./manual-placeholder-adapter.js");

function createAdapter() {
  return createManualPlaceholderAdapter({
    platform_target: "google_cloud_marketplace_bigquery",
    adapter_id: "phase21.manual.google_cloud_marketplace_bigquery",
    adapter_version: "phase21-manual-v1"
  });
}

module.exports = {
  createAdapter
};
