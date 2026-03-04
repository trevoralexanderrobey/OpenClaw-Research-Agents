"use strict";

const { z } = require("zod");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

const DraftQualityRecordSchema = z.object({
  draftSequence: z.number().int().min(1),
  domainTag: z.string().min(1).max(128),
  generatorVersion: z.string().min(1).max(64),
  templateVersion: z.string().min(1).max(64),
  result: z.enum(["accepted", "rejected", "revise_requested", "pending"]),
  score: z.number().int().min(0).max(100),
  qualitySignal: z.number().int().min(0).max(100),
  complexityScore: z.number().int().min(0).max(100),
  monetizationScore: z.number().int().min(0).max(100),
  outcomeSequence: z.number().int().min(0)
}).strict();

const DomainQualityRecordSchema = z.object({
  domainTag: z.string().min(1).max(128),
  draftCount: z.number().int().min(0),
  finalizedCount: z.number().int().min(0),
  acceptedCount: z.number().int().min(0),
  rejectedCount: z.number().int().min(0),
  reviseRequestedCount: z.number().int().min(0),
  pendingCount: z.number().int().min(0),
  averageQualitySignal: z.number().int().min(0).max(100),
  acceptanceRatePct: z.number().int().min(0).max(100)
}).strict();

const TemplateQualityRecordSchema = z.object({
  generatorVersion: z.string().min(1).max(64),
  templateVersion: z.string().min(1).max(64),
  domainTag: z.string().min(1).max(128),
  draftCount: z.number().int().min(0),
  finalizedCount: z.number().int().min(0),
  averageQualitySignal: z.number().int().min(0).max(100),
  acceptedCount: z.number().int().min(0),
  rejectedCount: z.number().int().min(0),
  reviseRequestedCount: z.number().int().min(0),
  pendingCount: z.number().int().min(0)
}).strict();

const QualitySnapshotSchema = z.object({
  ok: z.literal(true),
  asOfIso: z.string().min(1).max(64),
  totals: z.object({
    draftCount: z.number().int().min(0),
    outcomeCount: z.number().int().min(0),
    finalizedCount: z.number().int().min(0),
    pendingCount: z.number().int().min(0)
  }).strict(),
  monetizationSnapshotScore: z.number().int().min(0).max(100),
  perDraft: z.array(DraftQualityRecordSchema),
  perDomain: z.array(DomainQualityRecordSchema),
  perTemplate: z.array(TemplateQualityRecordSchema),
  qualityPriorByDomain: z.record(z.string(), z.number().int().min(0).max(100))
}).strict();

module.exports = {
  canonicalize,
  DraftQualityRecordSchema,
  DomainQualityRecordSchema,
  TemplateQualityRecordSchema,
  QualitySnapshotSchema
};
