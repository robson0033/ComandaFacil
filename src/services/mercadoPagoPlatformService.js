"use strict";

const MP_API = "https://api.mercadopago.com";
const DEFAULT_TIMEOUT_MS = 12_000;
const ACCOUNT_CACHE_TTL_MS = 5 * 60_000;
let accountCache = null;

const CONFIG_CODES = {
  MERCADO_PAGO_ACCESS_TOKEN: "PLATFORM_MP_ACCESS_TOKEN_MISSING",
  MERCADO_PAGO_PLATFORM_USER_ID: "PLATFORM_MP_USER_ID_MISSING",
  MERCADO_PAGO_WEBHOOK_SECRET: "PLATFORM_MP_WEBHOOK_SECRET_MISSING",
  APP_URL: "APP_URL_INVALID",
};

function platformConfigPresence(env = process.env) {
  return {
    appUrl: Boolean(String(env.APP_URL || "").trim()),
    accessToken: Boolean(String(env.MERCADO_PAGO_ACCESS_TOKEN || "").trim()),
    platformUserId: Boolean(String(env.MERCADO_PAGO_PLATFORM_USER_ID || "").trim()),
    webhookSecret: Boolean(String(env.MERCADO_PAGO_WEBHOOK_SECRET || "").trim()),
  };
}

function validAppUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function validatePlatformPaymentConfig(env = process.env) {
  const missing = [];
  for (const name of [
    "MERCADO_PAGO_ACCESS_TOKEN",
    "MERCADO_PAGO_PLATFORM_USER_ID",
    "MERCADO_PAGO_WEBHOOK_SECRET",
  ]) {
    if (!String(env[name] || "").trim()) missing.push(name);
  }
  if (!validAppUrl(env.APP_URL)) missing.push("APP_URL");
  const codes = missing.map(name => CONFIG_CODES[name]);
  return { ok: missing.length === 0, missing, codes };
}

function assertPlatformPaymentConfig(env = process.env) {
  const result = validatePlatformPaymentConfig(env);
  if (result.ok) return result;
  const error = new Error("Configuração de pagamento da plataforma incompleta.");
  error.name = "PlatformPaymentConfigError";
  error.code = result.codes[0];
  error.missing = result.missing;
  error.configCodes = result.codes;
  error.stage = "config_validation";
  throw error;
}

function providerDetails(data) {
  const causes = Array.isArray(data?.cause)
    ? data.cause
    : Array.isArray(data?.causes) ? data.causes : [];
  return {
    providerCode: String(data?.code || data?.error || "").slice(0, 100) || null,
    providerMessage: String(data?.message || data?.error_description || "").slice(0, 300) || null,
    providerCauses: causes.slice(0, 10).map(cause => ({
      code: String(cause?.code || "").slice(0, 100) || null,
      description: String(cause?.description || cause?.message || "").slice(0, 240) || null,
    })),
  };
}

async function requestPlatform(path, options = {}) {
  assertPlatformPaymentConfig();
  const operation = String(options.operation || "platform_request");
  const stage = String(options.stage || "provider_request");
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MP_API}${path}`, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${String(process.env.MERCADO_PAGO_ACCESS_TOKEN).trim()}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "X-Idempotency-Key": options.idempotencyKey } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = providerDetails(data);
      const error = new Error(details.providerMessage || `Mercado Pago respondeu HTTP ${response.status}.`);
      error.name = "MercadoPagoPlatformHttpError";
      error.code = details.providerCode || "PLATFORM_MP_HTTP_ERROR";
      error.status = response.status;
      error.httpStatus = response.status;
      error.providerResponse = details;
      error.responseReceived = true;
      error.operation = operation;
      error.stage = stage;
      error.endpointPath = path;
      throw error;
    }
    return data;
  } catch (cause) {
    if (cause?.operation) throw cause;
    const timeout = cause?.name === "AbortError";
    const error = new Error(timeout
      ? "A comunicação com o Mercado Pago excedeu o tempo limite."
      : "Não foi possível comunicar com o Mercado Pago.", { cause });
    error.name = timeout ? "MercadoPagoPlatformTimeoutError" : "MercadoPagoPlatformNetworkError";
    error.code = timeout ? "PLATFORM_MP_TIMEOUT" : "PLATFORM_MP_NETWORK_ERROR";
    error.operation = operation;
    error.stage = stage;
    error.endpointPath = path;
    error.responseReceived = false;
    error.timeout = timeout;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function validatePlatformAccount(options = {}) {
  assertPlatformPaymentConfig();
  const expectedId = String(process.env.MERCADO_PAGO_PLATFORM_USER_ID).trim();
  if (!options.force && accountCache?.id === expectedId && accountCache.expiresAt > Date.now()) {
    return accountCache.id;
  }
  const response = await requestPlatform("/users/me", {
    operation: "validate_platform_account",
    stage: "platform_account_lookup",
    timeoutMs: options.timeoutMs,
  });
  if (!response?.id || String(response.id) !== expectedId) {
    const error = new Error("A credencial Mercado Pago não pertence à conta configurada da plataforma.");
    error.name = "PlatformAccountMismatchError";
    error.code = "PLATFORM_ACCOUNT_MISMATCH";
    error.operation = "validate_platform_account";
    error.stage = "platform_account_match";
    error.endpointPath = "/users/me";
    error.responseReceived = true;
    throw error;
  }
  accountCache = { id: expectedId, expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS };
  return expectedId;
}

function platformErrorLog(error, context = {}) {
  const provider = error?.providerResponse || {};
  return {
    correlationId: String(context.correlationId || error?.correlationId || "") || null,
    operation: String(context.operation || error?.operation || "subscription_payment"),
    stage: String(error?.stage || context.stage || "unknown"),
    endpointPath: String(error?.endpointPath || context.endpointPath || "") || null,
    errorName: String(error?.name || "Error").slice(0, 100),
    errorMessage: String(error?.message || "Erro desconhecido").slice(0, 400),
    causeName: String(error?.cause?.name || "").slice(0, 100) || null,
    httpStatus: Number(error?.httpStatus || error?.status || 0) || null,
    providerCode: provider.providerCode || null,
    providerMessage: provider.providerMessage || null,
    providerCauses: Array.isArray(provider.providerCauses) ? provider.providerCauses : [],
    responseReceived: Boolean(error?.responseReceived),
    remoteStatus: String(error?.remoteStatus || "").slice(0, 40) || null,
    classificationReason: String(error?.classificationReason || "").slice(0, 100) || null,
    timeout: Boolean(error?.timeout),
    configPresent: platformConfigPresence(),
  };
}

function clearPlatformAccountCache() {
  accountCache = null;
}

module.exports = {
  MP_API,
  assertPlatformPaymentConfig,
  clearPlatformAccountCache,
  platformConfigPresence,
  platformErrorLog,
  requestPlatform,
  validatePlatformAccount,
  validatePlatformPaymentConfig,
  validAppUrl,
};
