"use strict";

const crypto = require("crypto");

const TERMS_TEXT = "Pix online: taxa de serviço Comanda Fácil sobre o total do pedido; tarifas Mercado Pago são da loja; o cliente não paga acréscimo.";

function getCurrentPlatformFeeConfig(env = process.env) {
  const percentage = Number(env.PLATFORM_PIX_FEE_PERCENT || 1.5);
  const termsVersion = String(env.PLATFORM_PIX_TERMS_VERSION || "1.0").trim();
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) {
    throw new Error("Percentual da taxa Pix da plataforma inválido.");
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(termsVersion)) {
    throw new Error("Versão dos termos Pix inválida.");
  }
  return {
    percentage,
    termsVersion,
    termsHash: crypto.createHash("sha256").update(TERMS_TEXT).digest("hex"),
  };
}

function calculatePlatformFeeCents(totalCents, percentage) {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new Error("Total em centavos inválido.");
  }
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) {
    throw new Error("Percentual inválido.");
  }
  const feeCents = Math.round(totalCents * percentage / 100);
  if (feeCents < 0 || feeCents >= totalCents) throw new Error("Taxa calculada inválida.");
  return feeCents;
}

function moneyToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Valor monetário inválido.");
  return Math.round(amount * 100);
}

function centsToDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Centavos inválidos.");
  return Number((cents / 100).toFixed(2));
}

function buildPlatformFeeSnapshot(total) {
  const config = getCurrentPlatformFeeConfig();
  const grossAmountCents = moneyToCents(total);
  const platformFeeCents = calculatePlatformFeeCents(
    grossAmountCents,
    config.percentage,
  );
  return {
    platformFeePercent: config.percentage,
    platformFeeCents,
    platformFeeStatus: "requested",
    platformFeeTermsVersion: config.termsVersion,
    platformFeeCalculatedAt: new Date(),
    grossAmountCents,
    merchantAmountBeforeMpFeesCents: grossAmountCents - platformFeeCents,
    platformFeeReversedCents: 0,
    platformFeeNetCents: 0,
  };
}

module.exports = {
  TERMS_TEXT,
  buildPlatformFeeSnapshot,
  calculatePlatformFeeCents,
  centsToDecimal,
  getCurrentPlatformFeeConfig,
  moneyToCents,
};
