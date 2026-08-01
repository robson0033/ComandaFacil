"use strict";

const crypto = require("crypto");

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function webhookSecurityError(code, message, stage, httpStatus = 401) {
  const error = new Error(message);
  error.name = "MercadoPagoWebhookSecurityError";
  error.code = code;
  error.stage = stage;
  error.httpStatus = httpStatus;
  error.responseReceived = false;
  return error;
}

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
    throw webhookSecurityError(
      "WEBHOOK_RESOURCE_ID_INVALID",
      "Identificador de recurso inválido.",
      "webhook_signature_validate",
      400,
    );
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
  if (!secret) throw webhookSecurityError(
    "WEBHOOK_SECRET_MISSING",
    "Segredo do webhook não configurado.",
    "webhook_signature_validate",
    503,
  );
  if (!signatureHeader) throw webhookSecurityError(
    "WEBHOOK_SIGNATURE_MISSING",
    "Assinatura do webhook ausente.",
    "webhook_signature_parse",
  );
  if (!requestId) throw webhookSecurityError(
    "WEBHOOK_REQUEST_ID_MISSING",
    "Identificador da requisição ausente.",
    "webhook_signature_validate",
  );

  const normalizedRequestId = String(requestId).trim();
  if (!normalizedRequestId || normalizedRequestId.length > 200) {
    throw webhookSecurityError(
      "WEBHOOK_REQUEST_ID_INVALID",
      "Identificador da requisição inválido.",
      "webhook_signature_validate",
    );
  }

  const normalizedResourceId = normalizeResourceId(resourceId);
  const { timestamp, signature } = parseSignature(signatureHeader);
  if (!/^\d{10,13}$/.test(timestamp) || !signature) {
    throw webhookSecurityError(
      "WEBHOOK_SIGNATURE_INVALID",
      "Assinatura do webhook malformada.",
      "webhook_signature_parse",
    );
  }

  const timestampMs = timestamp.length === 13
    ? Number(timestamp)
    : Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)
    || Math.abs(now - timestampMs) > toleranceSeconds * 1000) {
    throw webhookSecurityError(
      "WEBHOOK_SIGNATURE_INVALID",
      "Timestamp do webhook expirado.",
      "webhook_signature_validate",
    );
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
    throw webhookSecurityError(
      "WEBHOOK_SIGNATURE_INVALID",
      "Assinatura do webhook inválida.",
      "webhook_signature_validate",
    );
  }

  return {
    requestId: normalizedRequestId,
    resourceId: normalizedResourceId,
    timestamp: timestampMs,
    payloadHash: crypto.createHash("sha256").update(manifest).digest("hex"),
  };
}


function extractMercadoPagoProviderDetails(data) {
  const source = data && typeof data === "object" ? data : {};
  const rawCauses = Array.isArray(source.cause)
    ? source.cause
    : Array.isArray(source.causes)
      ? source.causes
      : [];
  const safe = value => String(value ?? "").trim();
  return {
    providerCode: safe(source.code || source.error || source.status) || null,
    providerMessage: safe(
      source.message
      || source.error_description
      || source.detail
      || source.title,
    ).slice(0, 300) || null,
    providerCauses: rawCauses.slice(0, 10).map(cause => ({
      code: safe(cause?.code || cause?.error || cause?.type).slice(0, 100) || null,
      description: safe(
        cause?.description
        || cause?.message
        || cause?.detail,
      ).slice(0, 240) || null,
    })),
  };
}

function sanitizeMercadoPagoError(error) {
  const status = Number(error?.httpStatus || error?.status || error?.statusCode || 0);
  const code = String(error?.code || "").slice(0, 80);
  const provider = error?.providerResponse || {};
  const safeText = (value, maxLength) => {
    let text = String(value || "");
    for (const secret of [
      process.env.MERCADO_PAGO_ACCESS_TOKEN,
      process.env.MERCADO_PAGO_WEBHOOK_SECRET,
    ]) {
      if (secret) text = text.split(String(secret)).join("[REDACTED]");
    }
    return text
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
      .slice(0, maxLength);
  };
  return {
    message: safeText(error?.message || "Falha na integração Mercado Pago.", 400),
    status: status || null,
    code: code || null,
    stage: String(error?.stage || "").slice(0, 100) || null,
    endpointPath: String(error?.endpointPath || "").slice(0, 200) || null,
    responseReceived: Boolean(error?.responseReceived),
    timeout: Boolean(error?.timeout),
    providerCode: String(provider.providerCode || "").slice(0, 100) || null,
    providerMessage: safeText(provider.providerMessage, 300) || null,
    providerCauses: Array.isArray(provider.providerCauses)
      ? provider.providerCauses.slice(0, 10).map(cause => ({
        code: safeText(cause?.code, 100) || null,
        description: safeText(cause?.description, 240) || null,
      }))
      : [],
    errorName: String(error?.name || "Error").slice(0, 100),
    causeName: String(error?.cause?.name || "").slice(0, 100) || null,
  };
}

module.exports = {
  extractMercadoPagoProviderDetails,
  DEFAULT_TOLERANCE_SECONDS,
  normalizeResourceId,
  parseSignature,
  sanitizeMercadoPagoError,
  validateMercadoPagoWebhook,
};
