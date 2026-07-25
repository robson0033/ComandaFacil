"use strict";

const crypto = require("crypto");

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("base64url");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtection(req, res, next) {
  const expected = String(req.session?.csrfToken || "");
  const supplied = String(req.body?._csrf || req.get("x-csrf-token") || "");
  const valid = expected.length === supplied.length
    && expected.length > 0
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (!valid) return res.status(403).send("Requisição não autorizada.");
  return next();
}

function csrfSameOriginProtection(req, res, next) {
  if (req.method !== "POST") return next();
  const expectedToken = String(req.session?.csrfToken || "");
  const suppliedToken = String(req.body?._csrf || req.get("x-csrf-token") || "");
  if (expectedToken && suppliedToken && expectedToken.length === suppliedToken.length
    && crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(suppliedToken))) {
    return next();
  }

  const source = req.get("origin") || req.get("referer");
  if (!source) return res.status(403).send("Origem da requisição não autorizada.");
  try {
    const sourceOrigin = new URL(source).origin;
    const requestOrigin = new URL(`${req.protocol}://${req.get("host")}`).origin;
    const configuredOrigin = process.env.APP_URL
      ? new URL(process.env.APP_URL).origin
      : requestOrigin;
    if ([requestOrigin, configuredOrigin].includes(sourceOrigin)) return next();
  } catch {
    // Origem inválida é rejeitada abaixo.
  }
  return res.status(403).send("Origem da requisição não autorizada.");
}

module.exports = {
  ensureCsrfToken,
  csrfProtection,
  csrfSameOriginProtection,
};
