"use strict";

const crypto = require("crypto");

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(left.toLowerCase(), "hex"),
    Buffer.from(right.toLowerCase(), "hex"),
  );
}

function parseSignature(header) {
  const parts = Object.fromEntries(
    String(header || "")
      .split(",")
      .map(part => part.trim().split("=", 2))
      .filter(([key, value]) => key && value),
  );
  return { timestamp: parts.ts || "", signature: parts.v1 || "" };
}

function normalizeResourceId(value) {
  const resourceId = String(value || "").trim().toLowerCase();
  if (!resourceId || resourceId.length > 160 || !/^[a-z0-9:_-]+$/.test(resourceId)) {
    throw new Error("Identificador de recurso inválido.");
  }
  return resourceId;
}

function validateMercadoPagoWebhook({
  signatureHeader,
  requestId,
  resourceId,
  secret,
  now = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}) {
  if (!secret) throw new Error("Segredo do webhook não configurado.");
  if (!signatureHeader || !requestId) throw new Error("Cabeçalhos de autenticação ausentes.");

  const normalizedRequestId = String(requestId).trim();
  if (!normalizedRequestId || normalizedRequestId.length > 200) {
    throw new Error("Identificador da requisição inválido.");
  }

  const normalizedResourceId = normalizeResourceId(resourceId);
  const { timestamp, signature } = parseSignature(signatureHeader);
  if (!/^\d{10,13}$/.test(timestamp) || !signature) {
    throw new Error("Assinatura do webhook malformada.");
  }

  const timestampMs = timestamp.length === 13
    ? Number(timestamp)
    : Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)
    || Math.abs(now - timestampMs) > toleranceSeconds * 1000) {
    throw new Error("Timestamp do webhook expirado.");
  }

  const manifest = [
    `id:${normalizedResourceId}`,
    `request-id:${normalizedRequestId}`,
    `ts:${timestamp}`,
  ].join(";");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${manifest};`)
    .digest("hex");

  if (!safeEqualHex(signature, expected)) {
    throw new Error("Assinatura do webhook inválida.");
  }

  return {
    requestId: normalizedRequestId,
    resourceId: normalizedResourceId,
    timestamp: timestampMs,
    payloadHash: crypto.createHash("sha256").update(manifest).digest("hex"),
  };
}

function sanitizeMercadoPagoError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || "").slice(0, 80);
  const safeMessage = status
    ? `Falha na integração Mercado Pago (HTTP ${status}).`
    : "Falha na integração Mercado Pago.";
  return { message: safeMessage, status: status || null, code: code || null };
}

module.exports = {
  DEFAULT_TOLERANCE_SECONDS,
  normalizeResourceId,
  parseSignature,
  sanitizeMercadoPagoError,
  validateMercadoPagoWebhook,
};
