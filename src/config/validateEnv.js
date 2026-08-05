"use strict";

const {
  validatePrintProtocolRollout,
} = require("./printProtocolRollout");
const {
  assertCsrfConfiguration,
} = require("../middleware/csrf");

const REQUIRED_PRODUCTION = Object.freeze([
  "MERCADO_PAGO_ACCESS_TOKEN",
  "MERCADO_PAGO_PUBLIC_KEY",
  "MERCADO_PAGO_WEBHOOK_SECRET",
  "MERCADO_PAGO_PLATFORM_USER_ID",
  "MP_CLIENT_ID",
  "MP_CLIENT_SECRET",
  "MP_REDIRECT_URI",
  "TOKEN_ENCRYPTION_KEY",
]);

const EMAIL_REQUIRED_BY_PROVIDER = Object.freeze({
  smtp: Object.freeze([
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM",
  ]),
  resend: Object.freeze([
    "RESEND_API_KEY",
    "EMAIL_FROM",
  ]),
});

class EnvironmentValidationError extends Error {
  constructor(invalidNames) {
    const names = [...new Set(invalidNames)].sort();
    super(`Variáveis de ambiente inválidas: ${names.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.invalidNames = names;
  }
}

function nonEmpty(env, name) {
  return Boolean(String(env[name] || "").trim());
}

function validateEnvironment(env = process.env) {
  const invalid = [];
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  if (!["development", "test", "production"].includes(nodeEnv)) {
    invalid.push("NODE_ENV");
  }

  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push("PORT");

  if (!nonEmpty(env, "CONNECTIONSTRING")
    || !/^mongodb(?:\+srv)?:\/\//i.test(String(env.CONNECTIONSTRING || ""))) {
    invalid.push("CONNECTIONSTRING");
  }

  const sessionSecret = String(env.SESSION_SECRET || "");
  if (sessionSecret.length < 32) invalid.push("SESSION_SECRET");

  let appUrl;
  try {
    appUrl = new URL(env.APP_URL);
    if (!["http:", "https:"].includes(appUrl.protocol)) throw new Error();
    if (nodeEnv === "production" && appUrl.protocol !== "https:") {
      invalid.push("APP_URL");
    }
  } catch {
    invalid.push("APP_URL");
  }

  const rateLimitStore = String(env.RATE_LIMIT_STORE || "").trim().toLowerCase();
  if (rateLimitStore && !["mongo", "memory"].includes(rateLimitStore)) {
    invalid.push("RATE_LIMIT_STORE");
  }

  if (nodeEnv === "production") {
    if (rateLimitStore === "memory") invalid.push("RATE_LIMIT_STORE");
    const webConcurrency = Number(env.WEB_CONCURRENCY || 1);
    if (!Number.isInteger(webConcurrency) || webConcurrency !== 1) {
      invalid.push("WEB_CONCURRENCY");
    }
    for (const name of REQUIRED_PRODUCTION) {
      if (!nonEmpty(env, name)) invalid.push(name);
    }
    const storageDriver = String(env.STORAGE_DRIVER || "").trim().toLowerCase();
    if (!["cloudinary", "external"].includes(storageDriver)) {
      invalid.push("STORAGE_DRIVER");
    } else if (storageDriver === "cloudinary") {
      for (const name of [
        "CLOUDINARY_CLOUD_NAME",
        "CLOUDINARY_API_KEY",
        "CLOUDINARY_API_SECRET",
      ]) {
        if (!nonEmpty(env, name)) invalid.push(name);
      }
    } else {
      for (const name of [
        "STORAGE_EXTERNAL_PROVIDER",
        "STORAGE_EXTERNAL_BASE_URL",
        "STORAGE_EXTERNAL_ADAPTER_MODULE",
      ]) {
        if (!nonEmpty(env, name)) invalid.push(name);
      }
      if (!["s3", "cloudinary"].includes(
        String(env.STORAGE_EXTERNAL_PROVIDER || "").toLowerCase(),
      )) {
        invalid.push("STORAGE_EXTERNAL_PROVIDER");
      }
      if (!/^https:\/\//i.test(String(env.STORAGE_EXTERNAL_BASE_URL || ""))) {
        invalid.push("STORAGE_EXTERNAL_BASE_URL");
      }
    }
    const emailProvider = String(env.EMAIL_PROVIDER || "smtp")
      .trim().toLowerCase();
    if (!Object.hasOwn(EMAIL_REQUIRED_BY_PROVIDER, emailProvider)) {
      invalid.push("EMAIL_PROVIDER");
    } else {
      for (const name of EMAIL_REQUIRED_BY_PROVIDER[emailProvider]) {
        if (!nonEmpty(env, name)) invalid.push(name);
      }
      if (emailProvider === "smtp") {
        const smtpPort = Number(env.SMTP_PORT);
        if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
          invalid.push("SMTP_PORT");
        }
      } else {
        const from = String(env.EMAIL_FROM || "").trim();
        const fromAddress = from.match(/<([^>]+)>/)?.[1] || from;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress)) {
          invalid.push("EMAIL_FROM");
        }
      }
    }
    try {
      const redirect = new URL(env.MP_REDIRECT_URI);
      if (
        redirect.protocol !== "https:"
        || redirect.origin !== appUrl?.origin
        || redirect.pathname !== "/admin/mercado-pago/callback"
      ) {
        invalid.push("MP_REDIRECT_URI");
      }
    } catch {
      invalid.push("MP_REDIRECT_URI");
    }
  }

  try {
    validatePrintProtocolRollout(env);
  } catch (error) {
    if (/PILOT_ESTABLISHMENT_IDS/.test(error.message)) {
      invalid.push("PRINT_PROTOCOL_V2_PILOT_ESTABLISHMENT_IDS");
    } else {
      invalid.push("PRINT_PROTOCOL_V2_ENABLED");
    }
  }

  try {
    assertCsrfConfiguration(env);
  } catch (error) {
    if (/ALLOWED_ORIGINS/.test(error.message)) invalid.push("ALLOWED_ORIGINS");
    else invalid.push("APP_URL");
  }

  if (invalid.length) throw new EnvironmentValidationError(invalid);
  return Object.freeze({
    nodeEnv,
    production: nodeEnv === "production",
    test: nodeEnv === "test",
    port,
    mongoUri: env.CONNECTIONSTRING,
    sessionSecret,
    appUrl: appUrl.toString().replace(/\/+$/, ""),
    emailProvider: String(env.EMAIL_PROVIDER || "smtp").trim().toLowerCase(),
    allowMemorySession: env.ALLOW_MEMORY_SESSION === "true",
  });
}

module.exports = {
  EnvironmentValidationError,
  EMAIL_REQUIRED_BY_PROVIDER,
  REQUIRED_PRODUCTION,
  validateEnvironment,
};
