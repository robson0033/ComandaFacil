"use strict";

function createRateLimiter({
  windowMs = 60_000,
  max = 10,
  key = req => req.ip,
  skip = () => false,
  onLimit = null,
} = {}) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }, Math.min(windowMs, 60_000));
  timer.unref?.();

  return (req, res, next) => {
    if (skip(req)) return next();
    const now = Date.now();
    const bucketKey = String(key(req) || "unknown");
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      if (typeof onLimit === "function") return onLimit(req, res);
      return res.status(429).send("Muitas solicitações. Tente novamente em instantes.");
    }
    return next();
  };
}

module.exports = { createRateLimiter };
