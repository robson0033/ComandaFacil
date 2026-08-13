"use strict";

const crypto = require("crypto");
const { logger } = require("../utils/logger");
const {
  persistirWebhookEvent,
  processarWebhookEventByKey,
} = require("../services/whatsappWebhookQueueService");

function secureEqualText(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function configuredVerifyToken(env = process.env) {
  return String(env.WHATSAPP_VERIFY_TOKEN || "").trim();
}

function configuredAppSecret(env = process.env) {
  return String(env.WHATSAPP_APP_SECRET || "").trim();
}

function buildExpectedSignature(rawBody, appSecret) {
  return `sha256=${crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;
}

function verifyMetaSignature({ rawBody, signature, appSecret }) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  if (!String(signature || "").startsWith("sha256=")) return false;
  if (!String(appSecret || "").trim()) return false;
  const expected = buildExpectedSignature(rawBody, appSecret);
  return secureEqualText(expected, signature);
}

function suffix(value, max = 6) {
  const text = String(value ?? "").replace(/\s+/g, "");
  return text ? text.slice(-max) : null;
}

function summarizeWebhook(body) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  let changeCount = 0;
  let messageCount = 0;
  let statusCount = 0;
  const fields = new Set();
  const messageTypes = new Set();
  const statusTypes = new Set();
  const phoneNumberSuffixes = new Set();

  for (const entry of entries.slice(0, 20)) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes.slice(0, 30)) {
      changeCount += 1;
      if (change?.field) fields.add(String(change.field).slice(0, 80));
      const value = change?.value || {};
      const phoneId = value?.metadata?.phone_number_id;
      if (phoneId) phoneNumberSuffixes.add(suffix(phoneId, 8));
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      messageCount += messages.length;
      statusCount += statuses.length;
      for (const message of messages.slice(0, 30)) {
        if (message?.type) messageTypes.add(String(message.type).slice(0, 40));
      }
      for (const status of statuses.slice(0, 30)) {
        if (status?.status) statusTypes.add(String(status.status).slice(0, 40));
      }
    }
  }

  return {
    object: String(body?.object || "").slice(0, 80) || null,
    entries: entries.length,
    changes: changeCount,
    fields: [...fields].slice(0, 20),
    messages: messageCount,
    messageTypes: [...messageTypes].slice(0, 20),
    statuses: statusCount,
    statusTypes: [...statusTypes].slice(0, 20),
    phoneNumberIdSuffixes: [...phoneNumberSuffixes].slice(0, 10),
  };
}

function verificarWebhook(req, res) {
  const mode = String(req.query?.["hub.mode"] || "");
  const verifyToken = String(req.query?.["hub.verify_token"] || "");
  const challenge = String(req.query?.["hub.challenge"] || "");
  const expectedToken = configuredVerifyToken();

  res.set("Cache-Control", "no-store");

  if (!expectedToken) {
    logger.error("whatsapp_webhook_not_configured", {
      correlationId: req.correlationId,
      reason: "WHATSAPP_VERIFY_TOKEN ausente",
    });
    return res.status(503).type("text/plain").send("Webhook não configurado");
  }

  if (mode === "subscribe" && challenge && secureEqualText(verifyToken, expectedToken)) {
    logger.info("whatsapp_webhook_verified", {
      correlationId: req.correlationId,
      mode,
    });
    return res.status(200).type("text/plain").send(challenge);
  }

  logger.warn("whatsapp_webhook_verification_rejected", {
    correlationId: req.correlationId,
    mode: mode.slice(0, 40),
    tokenPresent: Boolean(verifyToken),
    challengePresent: Boolean(challenge),
  });
  return res.status(403).type("text/plain").send("Verificação recusada");
}

async function receberWebhook(req, res) {
  const appSecret = configuredAppSecret();
  const signature = String(req.get("x-hub-signature-256") || "");

  if (!appSecret) {
    logger.error("whatsapp_webhook_not_configured", {
      correlationId: req.correlationId,
      reason: "WHATSAPP_APP_SECRET ausente",
    });
    return res.status(503).json({ ok: false, code: "WHATSAPP_NOT_CONFIGURED" });
  }

  if (!verifyMetaSignature({
    rawBody: req.rawBody,
    signature,
    appSecret,
  })) {
    logger.warn("whatsapp_webhook_signature_invalid", {
      correlationId: req.correlationId,
      signaturePresent: Boolean(signature),
      rawBodyPresent: Buffer.isBuffer(req.rawBody),
    });
    return res.status(401).json({ ok: false, code: "INVALID_SIGNATURE" });
  }

  const summary = summarizeWebhook(req.body);
  logger.info("whatsapp_webhook_received", {
    correlationId: req.correlationId,
    ...summary,
  });

  // Antes de devolver 200, persiste idempotentemente o evento. Se o processo
  // cair depois da resposta, o worker recupera o payload e continua. Se a
  // persistência falhar, devolvemos 503 para que a Meta possa reenviar.
  let queued;
  try {
    queued = await persistirWebhookEvent({
      rawBody: req.rawBody,
      body: req.body,
      correlationId: req.correlationId,
    });
  } catch (error) {
    logger.error("whatsapp_webhook_persist_failed", {
      correlationId: req.correlationId,
      code: String(error?.code || "WHATSAPP_WEBHOOK_PERSIST_FAILED").slice(0, 80),
    });
    return res.status(503).json({ ok: false, code: "WHATSAPP_WEBHOOK_PERSIST_FAILED" });
  }

  res.status(200).json({ ok: true });

  setImmediate(() => {
    processarWebhookEventByKey(queued.eventKey)
      .catch(error => {
        logger.error("whatsapp_webhook_async_processing_failed", {
          correlationId: req.correlationId,
          code: error?.code || "WHATSAPP_ASYNC_PROCESSING_FAILED",
        });
      });
  });
  return res;
}

module.exports = {
  verificarWebhook,
  receberWebhook,
  _testing: {
    buildExpectedSignature,
    secureEqualText,
    summarizeWebhook,
    verifyMetaSignature,
  },
};
