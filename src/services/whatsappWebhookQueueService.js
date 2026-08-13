"use strict";

const crypto = require("crypto");
const { WhatsAppWebhookEvent } = require("../models/painelModels");
const { processarWebhook } = require("./whatsappAutomationService");
const { logger } = require("../utils/logger");

const MAX_ATTEMPTS = 20;
const PROCESSING_LOCK_MS = 2 * 60 * 1000;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60 * 1000;

function eventKeyFromRawBody(rawBody) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) {
    throw Object.assign(new Error("Corpo bruto do webhook ausente."), {
      code: "WHATSAPP_WEBHOOK_RAW_BODY_REQUIRED",
    });
  }
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

function retryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 1) - 1, 8));
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** exponent));
}

async function persistirWebhookEvent({ rawBody, body, correlationId = "" }) {
  const eventKey = eventKeyFromRawBody(rawBody);
  const now = new Date();
  const event = await WhatsAppWebhookEvent.findOneAndUpdate(
    { eventKey },
    {
      $setOnInsert: {
        eventKey,
        payload: body,
        correlationId: String(correlationId || "").slice(0, 100),
        status: "pending",
        attempts: 0,
        nextRetryAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  return { eventKey, event };
}

async function claimEventByKey(eventKey) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LOCK_MS);
  return WhatsAppWebhookEvent.findOneAndUpdate(
    {
      eventKey,
      attempts: { $lt: MAX_ATTEMPTS },
      $or: [
        { status: { $in: ["pending", "failed"] }, nextRetryAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: "processing", lockedAt: now, lastError: "" },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  );
}

async function claimNextEvent() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LOCK_MS);
  return WhatsAppWebhookEvent.findOneAndUpdate(
    {
      attempts: { $lt: MAX_ATTEMPTS },
      $or: [
        { status: { $in: ["pending", "failed"] }, nextRetryAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: "processing", lockedAt: now, lastError: "" },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
}

async function concluirEvento(event) {
  await WhatsAppWebhookEvent.updateOne(
    { _id: event._id, status: "processing" },
    {
      $set: {
        status: "processed",
        processedAt: new Date(),
        lockedAt: null,
        nextRetryAt: null,
        lastError: "",
        // Minimiza retenção de conteúdo após o processamento. O histórico de
        // conversa necessário já fica nas coleções próprias do WhatsApp.
        payload: null,
      },
    },
  );
}

async function falharEvento(event, error) {
  const attempts = Number(event.attempts || 1);
  const now = Date.now();
  const reachedLimit = attempts >= MAX_ATTEMPTS;
  await WhatsAppWebhookEvent.updateOne(
    { _id: event._id, status: "processing" },
    {
      $set: {
        status: "failed",
        lockedAt: null,
        nextRetryAt: reachedLimit
          ? new Date(now + MAX_RETRY_MS)
          : new Date(now + retryDelayMs(attempts)),
        lastError: String(error?.code || error?.message || "Falha ao processar webhook").slice(0, 300),
      },
    },
  );
  logger.error("whatsapp_webhook_queue_processing_failed", {
    eventKeySuffix: String(event.eventKey || "").slice(-10),
    attempts,
    maxAttemptsReached: reachedLimit,
    code: String(error?.code || "WHATSAPP_WEBHOOK_QUEUE_PROCESSING_FAILED").slice(0, 80),
  });
}

async function processarEventoClaimed(event) {
  if (!event?.payload) {
    await concluirEvento(event);
    return { processed: true, empty: true };
  }
  try {
    const result = await processarWebhook(event.payload, {
      correlationId: event.correlationId || null,
    });
    await concluirEvento(event);
    return { processed: true, result };
  } catch (error) {
    await falharEvento(event, error);
    return { processed: false, error };
  }
}

async function processarWebhookEventByKey(eventKey) {
  const event = await claimEventByKey(String(eventKey || ""));
  if (!event) return { processed: false, skipped: true };
  return processarEventoClaimed(event);
}

async function processarWebhooksPendentes({ limit = 50 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  const summary = { claimed: 0, processed: 0, failed: 0 };
  for (let index = 0; index < max; index += 1) {
    const event = await claimNextEvent();
    if (!event) break;
    summary.claimed += 1;
    const result = await processarEventoClaimed(event);
    if (result.processed) summary.processed += 1;
    else summary.failed += 1;
  }
  return summary;
}

module.exports = {
  MAX_ATTEMPTS,
  PROCESSING_LOCK_MS,
  eventKeyFromRawBody,
  persistirWebhookEvent,
  processarWebhookEventByKey,
  processarWebhooksPendentes,
};
