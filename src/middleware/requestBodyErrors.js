"use strict";

const { logger: appLogger } = require("../utils/logger");

const BODY_ERROR_TYPES = Object.freeze({
  TOO_LARGE: new Set(["entity.too.large", "parameters.too.many"]),
  MALFORMED: new Set(["entity.parse.failed"]),
});

function classifyRequestBodyError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const type = String(error?.type || "").trim();

  if (status === 413 || BODY_ERROR_TYPES.TOO_LARGE.has(type)) {
    return {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "A solicitação ultrapassou o limite permitido.",
    };
  }

  if (
    (status === 400 && BODY_ERROR_TYPES.MALFORMED.has(type))
    || (error instanceof SyntaxError && status === 400 && "body" in error)
  ) {
    return {
      status: 400,
      code: "PAYLOAD_INVALID",
      message: "Os dados enviados estão em formato inválido.",
    };
  }

  return null;
}

function requestWantsJson(req) {
  return Boolean(
    req?.xhr
    || String(req?.get?.("accept") || "").includes("application/json")
    || String(req?.get?.("content-type") || "").includes("application/json"),
  );
}

function requestBodyErrorHandler(error, req, res, next) {
  const rejection = classifyRequestBodyError(error);
  if (!rejection || res.headersSent) return next(error);

  appLogger.warn("request_body_rejected", {
    correlationId: req.correlationId,
    code: rejection.code,
    method: req.method,
    path: String(req.path || "").slice(0, 300),
    contentType: String(req.get?.("content-type") || "").slice(0, 120),
  });

  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");

  if (requestWantsJson(req)) {
    return res.status(rejection.status).json({
      success: false,
      code: rejection.code,
      message: rejection.message,
      correlationId: req.correlationId,
    });
  }

  return res
    .status(rejection.status)
    .type("text/plain")
    .send(rejection.message);
}

module.exports = {
  classifyRequestBodyError,
  requestBodyErrorHandler,
  requestWantsJson,
};
