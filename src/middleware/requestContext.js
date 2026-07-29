"use strict";

const crypto = require("crypto");

function requestContext(req, res, next) {
  const correlationId = crypto.randomBytes(8).toString("hex").toUpperCase();
  req.correlationId = correlationId;
  res.locals ||= {};
  res.locals.correlationId = correlationId;
  res.set("X-Correlation-Id", correlationId);
  return next();
}

module.exports = { requestContext };
