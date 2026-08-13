"use strict";

const { Pedido, OrderPaymentAttempt } = require("../models/painelModels");

// Regra comercial do ComandaFacil: o cliente tem 10 minutos para concluir o Pix.
const ORDER_PIX_EXPIRATION_MINUTES = 10;
const ORDER_PIX_EXPIRATION_MS = ORDER_PIX_EXPIRATION_MINUTES * 60 * 1000;

// A API de pagamentos Pix do Mercado Pago exige uma expiração remota mínima maior
// que a janela comercial do ComandaFacil. Mantemos o QR remoto com a menor janela
// aceita pelo provedor e, aos 10 minutos, solicitamos o cancelamento explicitamente.
const ORDER_PIX_PROVIDER_EXPIRATION_MINUTES = 31;
const ORDER_PIX_PROVIDER_EXPIRATION_MS = ORDER_PIX_PROVIDER_EXPIRATION_MINUTES * 60 * 1000;

const ORDER_PIX_ACTIVE_STATUSES = [
  "creating",
  "pending",
  "in_process",
  "authorized",
  "expiration_pending",
];
const ORDER_PIX_TERMINAL_UNPAID_STATUSES = ["expired", "cancelled", "canceled", "rejected"];

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRemoteStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isRemoteTerminalUnpaidStatus(value) {
  return ORDER_PIX_TERMINAL_UNPAID_STATUSES.includes(normalizeRemoteStatus(value));
}

function effectiveAttemptExpiration(attempt, fallback = null) {
  const explicit = validDate(attempt?.expiresAt || fallback);
  const createdAt = validDate(attempt?.createdAt);
  const tenMinutesFromCreation = createdAt
    ? new Date(createdAt.getTime() + ORDER_PIX_EXPIRATION_MS)
    : null;
  if (explicit && tenMinutesFromCreation) {
    return explicit <= tenMinutesFromCreation ? explicit : tenMinutesFromCreation;
  }
  return explicit || tenMinutesFromCreation;
}

function providerPixExpirationDate(now = new Date()) {
  const current = validDate(now) || new Date();
  return new Date(current.getTime() + ORDER_PIX_PROVIDER_EXPIRATION_MS);
}

function orderPixExpirationDate(pedido, attempt = null) {
  return effectiveAttemptExpiration(attempt, pedido?.pixExpiraEm);
}

function orderPixExpiredByClock(pedido, attempt = null, now = new Date()) {
  if (!pedido || String(pedido.pagamentoStatus || "") === "pago") return false;
  if (normalizeRemoteStatus(pedido.mercadoPagoStatus) === "approved") return false;
  const expiresAt = orderPixExpirationDate(pedido, attempt);
  const current = validDate(now) || new Date();
  return Boolean(expiresAt && expiresAt.getTime() <= current.getTime());
}

function orderPixApprovedAfterExpiration(payment, attempt, pedido = null) {
  if (normalizeRemoteStatus(payment?.status) !== "approved") return false;
  const expiresAt = orderPixExpirationDate(pedido, attempt);
  if (!expiresAt) return false;
  const approvedAt = validDate(payment?.date_approved);
  // Se o provedor não informar quando aprovou, não assumimos que ocorreu dentro
  // da janela vencida; o caso precisa de conciliação manual.
  if (!approvedAt) return true;
  return approvedAt.getTime() > expiresAt.getTime();
}

function appendExpirationHistory(pedido, paymentId, now) {
  if (!Array.isArray(pedido.historicoFinanceiro)) pedido.historicoFinanceiro = [];
  const operationKey = `pix_expirado:${String(paymentId || pedido._id)}`;
  const alreadyRecorded = pedido.historicoFinanceiro.some(item =>
    String(item?.operationKey || "") === operationKey,
  );
  if (alreadyRecorded) return;
  pedido.historicoFinanceiro.push({
    paymentId: String(paymentId || ""),
    status: "expired",
    tipo: "pix_online_expirado",
    statusAnterior: String(pedido.pagamentoStatus || "pendente"),
    statusNovo: "expirado",
    formaPagamento: "pix_online",
    valor: 0,
    motivo: `QR Code Pix expirado após ${ORDER_PIX_EXPIRATION_MINUTES} minutos e cancelamento/expiração confirmado pelo provedor.`,
    operationKey,
    registradoEm: now,
  });
}

async function markOrderPixExpirationPending({
  pedido,
  attempt = null,
  now = new Date(),
  remoteStatus = "",
  reason = "",
}) {
  if (!pedido) return { changed: false, pending: true, pedido: null, attempt };
  if (String(pedido.pagamentoStatus || "") === "pago"
    || normalizeRemoteStatus(pedido.mercadoPagoStatus) === "approved") {
    return { changed: false, pending: false, pedido, attempt };
  }

  const current = validDate(now) || new Date();
  const expiresAt = orderPixExpirationDate(pedido, attempt) || current;
  const normalizedRemoteStatus = normalizeRemoteStatus(remoteStatus);
  const alreadyPending = String(pedido.pagamentoStatus || "") === "expiracao_pendente";

  pedido.pagamentoStatus = "expiracao_pendente";
  if (normalizedRemoteStatus) pedido.mercadoPagoStatus = normalizedRemoteStatus;
  pedido.pixExpiraEm = expiresAt;
  pedido.pixExpiracaoStatusRemoto = normalizedRemoteStatus || pedido.pixExpiracaoStatusRemoto || "";
  pedido.pixExpiracaoUltimaTentativaEm = current;
  pedido.pixExpiracaoErro = String(reason || "Não foi possível confirmar o cancelamento remoto do Pix.")
    .slice(0, 500);
  // Depois de 10 minutos o cliente não deve continuar usando o QR mostrado pelo
  // ComandaFacil, mesmo enquanto o servidor confirma o cancelamento no provedor.
  pedido.pixCopiaCola = "";
  pedido.pixQrCodeBase64 = "";
  pedido.mercadoPagoCheckLockedUntil = null;
  await pedido.save();

  if (attempt) {
    attempt.status = "expiration_pending";
    attempt.expiresAt = expiresAt;
    attempt.lastCheckedAt = current;
    attempt.processedAt = null;
    if (String(attempt.reconciliationStatus || "") !== "reconciliation_required") {
      attempt.reconciliationStatus = "expiration_pending";
    }
    await attempt.save();
  }

  return {
    changed: !alreadyPending,
    pending: true,
    pedido,
    attempt,
    expiresAt,
    remoteStatus: normalizedRemoteStatus,
  };
}

async function markOrderPixExpired({
  pedido,
  attempt = null,
  now = new Date(),
  remoteStatus = "",
}) {
  if (!pedido) return { changed: false, pedido: null, attempt };
  if (String(pedido.pagamentoStatus || "") === "pago"
    || normalizeRemoteStatus(pedido.mercadoPagoStatus) === "approved") {
    return { changed: false, pedido, attempt };
  }

  const current = validDate(now) || new Date();
  const expiresAt = orderPixExpirationDate(pedido, attempt) || current;
  const normalizedRemoteStatus = normalizeRemoteStatus(remoteStatus);

  // Segurança financeira: nunca transformamos apenas o relógio local em um
  // estado arquivável. É preciso confirmação terminal do Mercado Pago.
  if (!isRemoteTerminalUnpaidStatus(normalizedRemoteStatus)) {
    return markOrderPixExpirationPending({
      pedido,
      attempt,
      now: current,
      remoteStatus: normalizedRemoteStatus,
      reason: "O prazo local terminou, mas o Mercado Pago ainda não confirmou cancelamento, rejeição ou expiração.",
    });
  }

  const paymentId = String(attempt?.paymentId || pedido.mercadoPagoPaymentId || "");
  const alreadyExpired = String(pedido.pagamentoStatus || "") === "expirado";

  appendExpirationHistory(pedido, paymentId, current);
  pedido.pagamentoStatus = "expirado";
  pedido.mercadoPagoStatus = normalizedRemoteStatus;
  pedido.pixExpiraEm = expiresAt;
  pedido.pixExpiradoEm = pedido.pixExpiradoEm || current;
  pedido.pixExpiracaoStatusRemoto = normalizedRemoteStatus;
  pedido.pixExpiracaoUltimaTentativaEm = current;
  pedido.pixExpiracaoErro = "";
  pedido.pixCopiaCola = "";
  pedido.pixQrCodeBase64 = "";
  pedido.mercadoPagoCheckLockedUntil = null;
  await pedido.save();

  if (attempt) {
    attempt.status = "expired";
    attempt.expiresAt = expiresAt;
    attempt.lastCheckedAt = current;
    attempt.processedAt = attempt.processedAt || current;
    if (String(attempt.reconciliationStatus || "") !== "reconciliation_required") {
      attempt.reconciliationStatus = "processed";
    }
    await attempt.save();
  }

  return {
    changed: !alreadyExpired,
    pending: false,
    pedido,
    attempt,
    expiresAt,
    remoteStatus: normalizedRemoteStatus,
  };
}

async function markMissingOrderAttemptPending(attempt, now = new Date()) {
  if (!attempt) return null;
  const current = validDate(now) || new Date();
  attempt.status = "reconciliation_required";
  attempt.expiresAt = effectiveAttemptExpiration(attempt) || current;
  attempt.lastCheckedAt = current;
  attempt.processedAt = null;
  attempt.reconciliationStatus = "reconciliation_required";
  await attempt.save();
  return attempt;
}

async function findExpiredActiveAttempts({ now = new Date(), limit = 100 } = {}) {
  const current = validDate(now) || new Date();
  const tenMinutesAgo = new Date(current.getTime() - ORDER_PIX_EXPIRATION_MS);
  return OrderPaymentAttempt.find({
    paymentMethod: "pix",
    status: { $in: ORDER_PIX_ACTIVE_STATUSES },
    $or: [
      { expiresAt: { $lte: current } },
      { createdAt: { $lte: tenMinutesAgo } },
      { status: "expiration_pending" },
    ],
  })
    .sort({ lastCheckedAt: 1, createdAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 100, 500)));
}

async function findOrderForAttempt(attempt) {
  if (!attempt?.pedidoId || !attempt?.estabelecimentoId) return null;
  return Pedido.findOne({
    _id: attempt.pedidoId,
    estabelecimentoId: attempt.estabelecimentoId,
  });
}

module.exports = {
  ORDER_PIX_EXPIRATION_MINUTES,
  ORDER_PIX_EXPIRATION_MS,
  ORDER_PIX_PROVIDER_EXPIRATION_MINUTES,
  ORDER_PIX_PROVIDER_EXPIRATION_MS,
  ORDER_PIX_ACTIVE_STATUSES,
  ORDER_PIX_TERMINAL_UNPAID_STATUSES,
  effectiveAttemptExpiration,
  providerPixExpirationDate,
  orderPixExpirationDate,
  orderPixExpiredByClock,
  orderPixApprovedAfterExpiration,
  isRemoteTerminalUnpaidStatus,
  markOrderPixExpirationPending,
  markOrderPixExpired,
  markMissingOrderAttemptPending,
  findExpiredActiveAttempts,
  findOrderForAttempt,
};
