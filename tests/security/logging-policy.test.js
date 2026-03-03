"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLogger } = require("../../logging/logger.js");

function makeCaptureStream() {
  let body = "";
  return {
    write(chunk) {
      body += String(chunk);
    },
    readLines() {
      return body
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

test("logger masks secrets and strips control characters", () => {
  const stream = makeCaptureStream();
  const logger = createLogger("test-logger", { stream });

  logger.info({
    correlationId: "abcdabcdabcdabcd",
    message: "line1\nline2\u0000",
    apiKey: "supersecretapikeyvalue",
  });

  const [line] = stream.readLines();
  assert.equal(line.component, "test-logger");
  assert.equal(line.message.includes("\n"), false);
  assert.equal(line.apiKey.includes("supersecretapikeyvalue"), false);
});

test("invalid correlation id is replaced", () => {
  const stream = makeCaptureStream();
  const logger = createLogger("test-logger", { stream });

  logger.warn({
    correlationId: "INVALID!",
    message: "ok",
  });

  const [line] = stream.readLines();
  assert.equal(line.correlationId, "00000000-0000-0000-0000-000000000000");
});
