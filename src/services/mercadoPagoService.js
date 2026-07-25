"use strict";

function finiteMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Valor financeiro inválido.");
  return Math.round(number * 100);
}

function normalizedId(value) {
  return String(value ?? "").trim();
}

function collectorId(payment) {
  return normalizedId(
    payment?.collector_id
    ?? payment?.collector?.id
    ?? payment?.merchant_account_id,
  );
}

function validatePaymentIdentity(payment, expected) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
    throw new Error("Resposta de pagamento inválida.");
  }
  if (normalizedId(payment.id) !== normalizedId(expected.paymentId)) {
    throw new Error("Pagamento não corresponde à tentativa vigente.");
  }
  if (finiteMoney(payment.transaction_amount) !== finiteMoney(expected.amount)) {
    throw new Error("Valor do pagamento divergente.");
  }
  if (normalizedId(payment.currency_id).toUpperCase() !== "BRL") {
    throw new Error("Moeda do pagamento divergente.");
  }
  if (normalizedId(payment.external_reference) !== normalizedId(expected.externalReference)) {
    throw new Error("Referência externa divergente.");
  }
  if (!expected.collectorId || collectorId(payment) !== normalizedId(expected.collectorId)) {
    throw new Error("Conta recebedora divergente.");
  }
  if (expected.preapprovalId
    && normalizedId(payment.preapproval_id ?? payment.metadata?.preapproval_id)
      !== normalizedId(expected.preapprovalId)) {
    throw new Error("Cobrança não pertence à assinatura vigente.");
  }
  return true;
}

function validateApprovedPayment(payment, expected) {
  validatePaymentIdentity(payment, expected);
  if (payment.status !== "approved") throw new Error("Pagamento ainda não foi aprovado.");
  return true;
}

function paidPeriod(currentExpiration, approvedAt = new Date(), days = 30) {
  const approved = new Date(approvedAt);
  if (Number.isNaN(approved.getTime())) throw new Error("Data de aprovação inválida.");
  const current = currentExpiration ? new Date(currentExpiration) : null;
  const start = current && !Number.isNaN(current.getTime()) && current > approved
    ? current
    : approved;
  return {
    startsAt: start,
    expiresAt: new Date(start.getTime() + days * 86_400_000),
  };
}

function subscriptionStatusForFinancialStatus(status, currentStatus) {
  if (status === "approved") return "ativa";
  if (["refunded", "charged_back"].includes(status)) return "reembolsada";
  if (["cancelled"].includes(status)) return "cancelada";
  if (["rejected"].includes(status)) return "atrasada";
  return currentStatus;
}

module.exports = {
  collectorId,
  finiteMoney,
  paidPeriod,
  subscriptionStatusForFinancialStatus,
  validateApprovedPayment,
  validatePaymentIdentity,
};
