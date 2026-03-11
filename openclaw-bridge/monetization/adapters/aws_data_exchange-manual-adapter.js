"use strict";

const { createManualPlaceholderAdapter } = require("./manual-placeholder-adapter.js");

function createAdapter() {
  return createManualPlaceholderAdapter({
    platform_target: "aws_data_exchange",
    adapter_id: "phase21.manual.aws_data_exchange",
    adapter_version: "phase21-manual-v1"
  });
}

module.exports = {
  createAdapter
};
