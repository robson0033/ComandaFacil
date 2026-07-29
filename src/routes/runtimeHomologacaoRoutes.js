"use strict";

const crypto = require("crypto");
const express = require("express");
const { clearSessionCookie } = require("../config/sessionConfig");

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createRuntimeHomologacaoRouter({
  env = process.env,
  technicalToken,
  operationId,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
} = {}) {
  if (
    env.ALLOW_RUNTIME_HOMOLOGATION !== "true"
    || env.NODE_ENV === "production"
  ) {
    return null;
  }
  if (
    !/^[a-f\d]{64}$/i.test(String(technicalToken || ""))
    || !/^runtime-homologacao-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(operationId || ""),
    )
  ) {
    throw new Error("Configuração técnica de homologação inválida.");
  }

  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const authorization = String(req.get("authorization") || "");
    const expected = `Bearer ${technicalToken}`;
    if (!safeEqual(authorization, expected)) {
      return res.status(401).json({ code: "NAO_AUTORIZADO" });
    }
    return next();
  });

  router.post("/session/create", (req, res, next) => {
    const marker = randomBytes(16).toString("hex");
    req.session.runtimeHomologation = {
      operationId,
      marker,
      createdAt: now().toISOString(),
    };
    req.session.save(error => {
      if (error) return next(error);
      return res.status(201).json({ created: true });
    });
  });

  router.get("/session/check", (req, res) => {
    const marker = req.session?.runtimeHomologation;
    return res.status(200).json({
      exists: Boolean(marker && marker.operationId === operationId),
    });
  });

  router.post("/session/logout", (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      clearSessionCookie(res, false);
      return res.status(200).json({ removed: true });
    });
  });

  return router;
}

module.exports = {
  createRuntimeHomologacaoRouter,
  safeEqual,
};
