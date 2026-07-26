"use strict";

const REQUIRED_PRODUCTION = Object.freeze([
  "STORAGE_DRIVER",
  "STORAGE_EXTERNAL_PROVIDER",
  "STORAGE_EXTERNAL_BASE_URL",
  "STORAGE_EXTERNAL_ADAPTER_MODULE",
  "MERCADO_PAGO_ACCESS_TOKEN",
  "MERCADO_PAGO_PUBLIC_KEY",
  "MERCADO_PAGO_WEBHOOK_SECRET",
  "MERCADO_PAGO_PLATFORM_USER_ID",
  "MP_CLIENT_ID",
  "MP_CLIENT_SECRET",
  "MP_REDIRECT_URI",
  "TOKEN_ENCRYPTION_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
]);

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

  if (nodeEnv === "production") {
    for (const name of REQUIRED_PRODUCTION) {
      if (!nonEmpty(env, name)) invalid.push(name);
    }
    if (env.STORAGE_DRIVER !== "external") invalid.push("STORAGE_DRIVER");
    if (!["s3", "cloudinary"].includes(
      String(env.STORAGE_EXTERNAL_PROVIDER || "").toLowerCase(),
    )) {
      invalid.push("STORAGE_EXTERNAL_PROVIDER");
    }
    if (!/^https:\/\//i.test(String(env.STORAGE_EXTERNAL_BASE_URL || ""))) {
      invalid.push("STORAGE_EXTERNAL_BASE_URL");
    }
    const smtpPort = Number(env.SMTP_PORT);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      invalid.push("SMTP_PORT");
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

  if (invalid.length) throw new EnvironmentValidationError(invalid);
  return Object.freeze({
    nodeEnv,
    production: nodeEnv === "production",
    test: nodeEnv === "test",
    port,
    mongoUri: env.CONNECTIONSTRING,
    sessionSecret,
    appUrl: appUrl.toString().replace(/\/+$/, ""),
    allowMemorySession: env.ALLOW_MEMORY_SESSION === "true",
  });
}

module.exports = {
  EnvironmentValidationError,
  REQUIRED_PRODUCTION,
  validateEnvironment,
};
