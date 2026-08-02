"use strict";

const { logger: appLogger } = require("../utils/logger");

const crypto = require("crypto");

const activeTimers = new Set();
const indexPromises = new WeakMap();

function sanitizeName(value) {
  return String(value || "default").toLowerCase().replace(/[^a-z0-9:_-]/g, "-").slice(0, 80);
}

function hashKey(value) {
  return crypto.createHash("sha256").update(String(value || "unknown")).digest("hex");
}

function setHeaders(res, max, count, resetAt) {
  res.set("RateLimit-Limit", String(max));
  res.set("RateLimit-Remaining", String(Math.max(0, max - count)));
  res.set("RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
}

function defaultLimitResponse(req, res) {
  const wantsJson = req.xhr
    || String(req.get?.("accept") || "").includes("application/json")
    || String(req.get?.("content-type") || "").includes("application/json");
  if (wantsJson) {
    return res.status(429).json({
      success: false,
      ok: false,
      code: "MUITAS_TENTATIVAS",
      message: "Muitas solicitações. Aguarde e tente novamente.",
      correlationId: req.correlationId,
    });
  }
  return res.status(429).send("Muitas solicitações. Tente novamente em instantes.");
}

function createMemoryStore(windowMs) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }, Math.min(windowMs, 60_000));
  timer.unref?.();
  activeTimers.add(timer);

  return {
    increment(bucketKey, now) {
      let bucket = buckets.get(bucketKey);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(bucketKey, bucket);
      }
      bucket.count += 1;
      return bucket;
    },
  };
}

function mongoStoreEnabled(env = process.env) {
  const configured = String(env.RATE_LIMIT_STORE || "").trim().toLowerCase();
  if (configured) return configured === "mongo";
  return String(env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function getMongoCollection() {
  // Carregamento tardio mantém os testes unitários do limitador independentes
  // de Mongoose e evita abrir conexão durante importação dos módulos.
  const mongoose = require("mongoose");
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB indisponível para o rate limit compartilhado.");
  }
  return mongoose.connection.db.collection("security_rate_limits");
}

async function ensureMongoTtlIndex(collection) {
  let promise = indexPromises.get(collection);
  if (!promise) {
    promise = collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "security_rate_limits_expiration_ttl" },
    );
    indexPromises.set(collection, promise);
  }
  await promise;
}

async function incrementMongo({ name, keyDigest, windowMs, now }) {
  const collection = getMongoCollection();
  await ensureMongoTtlIndex(collection);
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const id = `${name}:${keyDigest}:${windowStart}`;
  let result;
  try {
    result = await collection.findOneAndUpdate(
      { _id: id },
      {
        $inc: { count: 1 },
        $setOnInsert: {
          limiter: name,
          keyDigest,
          windowStart: new Date(windowStart),
          expiresAt: new Date(resetAt + windowMs),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    // Duas instâncias podem tentar criar o mesmo bucket no mesmo instante.
    // A segunda repete somente o incremento após o índice _id barrar o insert.
    if (Number(error?.code) !== 11000) throw error;
    result = await collection.findOneAndUpdate(
      { _id: id },
      { $inc: { count: 1 } },
      { returnDocument: "after" },
    );
  }
  const document = result?.value || result;
  return {
    count: Number(document?.count || 1),
    resetAt,
  };
}

function createRateLimiter({
  name = "default",
  windowMs = 60_000,
  max = 10,
  key = req => req.ip,
  skip = () => false,
  onLimit = null,
  env = process.env,
  logger = appLogger,
} = {}) {
  if (!Number.isInteger(windowMs) || windowMs < 1_000) {
    throw new TypeError("windowMs precisa ser um inteiro de pelo menos 1000 ms.");
  }
  if (!Number.isInteger(max) || max < 1) {
    throw new TypeError("max precisa ser um inteiro positivo.");
  }

  const limiterName = sanitizeName(name);
  const shared = mongoStoreEnabled(env);
  const memory = shared ? null : createMemoryStore(windowMs);

  function respond(req, res, bucket) {
    setHeaders(res, max, bucket.count, bucket.resetAt);
    if (bucket.count <= max) return false;
    res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))));
    if (typeof onLimit === "function") onLimit(req, res);
    else defaultLimitResponse(req, res);
    return true;
  }

  return (req, res, next) => {
    if (skip(req)) return next();
    const rawKey = String(key(req) || "unknown");
    const keyDigest = hashKey(rawKey);
    const now = Date.now();

    if (!shared) {
      const bucket = memory.increment(`${limiterName}:${keyDigest}`, now);
      if (!respond(req, res, bucket)) return next();
      return undefined;
    }

    return incrementMongo({
      name: limiterName,
      keyDigest,
      windowMs,
      now,
    }).then(bucket => {
      if (!respond(req, res, bucket)) return next();
      return undefined;
    }).catch(error => {
      logger.error?.("rate_limit_store_failed", {
        correlationId: req.correlationId,
        limiter: limiterName,
        code: "RATE_LIMIT_STORE_FAILED",
        errorType: String(error?.name || "Error").slice(0, 80),
      });
      return res.status(503).send("Serviço temporariamente indisponível.");
    });
  };
}

function stopRateLimiters() {
  for (const timer of activeTimers) clearInterval(timer);
  activeTimers.clear();
}

module.exports = {
  createRateLimiter,
  hashKey,
  mongoStoreEnabled,
  stopRateLimiters,
};
