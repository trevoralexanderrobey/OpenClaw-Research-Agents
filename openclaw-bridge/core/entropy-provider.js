"use strict";

const crypto = require("node:crypto");

let deterministicSeed = null;
let deterministicCounter = 0;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function deterministicBytes(size) {
  let output = Buffer.alloc(0);
  while (output.length < size) {
    const hash = crypto.createHash("sha256");
    hash.update(`${deterministicSeed}:${deterministicCounter}`);
    output = Buffer.concat([output, hash.digest()]);
    deterministicCounter += 1;
  }
  return output.subarray(0, size);
}

function randomBytes(size) {
  if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
    const error = new Error("size must be a positive number");
    error.code = "INVALID_ENTROPY_SIZE";
    throw error;
  }
  const byteCount = Number(size);
  if (deterministicSeed) {
    return deterministicBytes(byteCount);
  }

  const envSeed = normalizeString(process.env.OPENCLAW_DETERMINISTIC_SEED);
  if (envSeed) {
    deterministicSeed = envSeed;
    deterministicCounter = 0;
    return deterministicBytes(byteCount);
  }

  return crypto.randomBytes(byteCount);
}

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function randomToken(length = 16) {
  const hex = randomHex(Math.ceil(length / 2));
  return hex.slice(0, length);
}

function randomUuid() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function setDeterministicSeed(seed) {
  const normalized = normalizeString(seed);
  if (!normalized) {
    const error = new Error("seed must be a non-empty string");
    error.code = "INVALID_DETERMINISTIC_SEED";
    throw error;
  }
  deterministicSeed = normalized;
  deterministicCounter = 0;
}

function clearDeterministicSeed() {
  deterministicSeed = null;
  deterministicCounter = 0;
}

module.exports = {
  randomBytes,
  randomHex,
  randomToken,
  randomUuid,
  setDeterministicSeed,
  clearDeterministicSeed,
};
