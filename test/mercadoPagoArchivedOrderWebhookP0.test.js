"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const paymentController = require("../src/controllers/pagamentoController");
const { operationalAlerts } = require("../src/services/operationalAlertService");

const ESTABELECIMENTO = "64b000000000000000000001";
const PEDIDO = "64b000000000000000000002";
const PAYMENT_ID = "12345678943129";
const EXTERNAL_REFERENCE = "order_payment_attempt:72b5b8df-8f13-4c41-a0ad-df0f79c2cc19";

function makeAttempt(overrides = {}) {
  return {
    _id: "attempt-1",
    estabelecimentoId: ESTABELECIMENTO,
    pedidoId: PEDIDO,
    paymentId: PAYMENT_ID,
    expectedCollectorId: "99887766",
    expectedAmount: 40,
    externalReference: EXTERNAL_REFERENCE,
    currency: "BRL",
    status: "pending",
    reconciliationStatus: "pending",
    paymentMethod: "pix",
    platformFeeCents: 0,
    platformFeeStatus: "not_applied",
    platformFeeNetCents: 0,
    webhookEvents: [],
    lastCheckedAt: null,
    processedAt: null,
    saves: 0,
    async save() {
      this.saves += 1;
      return this;
    },
    ...overrides,
  };
}

function makePedido(overrides = {}) {
  return {
    _id: PEDIDO,
    estabelecimentoId: ESTABELECIMENTO,
    excluido: true,
    status: "novo",
    pagamentoStatus: "pendente",
    mercadoPagoPaymentId: "",
    mercadoPagoStatus: "",
    pagamentoInconsistente: false,
    pagamentoInconsistencia: "",
    platformFeeStatus: "not_applied",
    platformFeeNetCents: 0,
    historicoFinanceiro: [],
    saves: 0,
    async save() {
      this.saves += 1;
      return this;
    },
    ...overrides,
  };
}

function makePayment(status, overrides = {}) {
  return {
    id: PAYMENT_ID,
    status,
    transaction_amount: 40,
    currency_id: "BRL",
    external_reference: EXTERNAL_REFERENCE,
    collector_id: "99887766",
    date_last_updated: "2026-08-12T07:45:57.000Z",
    ...(status === "approved" ? { date_approved: "2026-08-12T07:45:40.000Z" } : {}),
    ...overrides,
  };
}

function makeEvent() {
  return {
    eventKey: "event-key-archived-order",
    requestId: "request-1",
    estabelecimentoId: null,
    pedidoId: null,
  };
}

test("webhook approved de pedido arquivado vira conciliação e não marca o pedido como pago", async t => {
  const attempt = makeAttempt();
  const pedido = makePedido();
  const event = makeEvent();
  const alerts = [];
  const originalTrigger = operationalAlerts.trigger;
  operationalAlerts.trigger = payload => {
    alerts.push(payload);
    return { queued: false, suppressed: false, event: payload.event };
  };
  t.after(() => { operationalAlerts.trigger = originalTrigger; });

  await paymentController._testing.processWebhookEvent(event, {
    kind: "archived_order",
    attempt,
    pedido,
    resource: makePayment("approved"),
  });

  assert.equal(event.estabelecimentoId, ESTABELECIMENTO);
  assert.equal(event.pedidoId, PEDIDO);
  assert.equal(attempt.status, "approved");
  assert.equal(attempt.reconciliationStatus, "reconciliation_required");
  assert.equal(pedido.pagamentoStatus, "pendente");
  assert.equal(pedido.mercadoPagoPaymentId, PAYMENT_ID);
  assert.equal(pedido.mercadoPagoStatus, "approved");
  assert.equal(pedido.pagamentoInconsistente, true);
  assert.match(pedido.pagamentoInconsistencia, /arquivado/i);
  assert.ok(pedido.historicoFinanceiro.some(item =>
    item.paymentId === PAYMENT_ID
    && item.tipo === "pix_online_pedido_arquivado"
    && item.status === "approved"));
  assert.equal(attempt.webhookEvents.includes(event.eventKey), true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, "mercado_pago_archived_order_payment_detected");
  assert.equal(alerts[0].severity, "critical");
});

test("webhook rejected de pedido arquivado é encerrado sem alerta financeiro crítico", async t => {
  const attempt = makeAttempt();
  const pedido = makePedido();
  const event = makeEvent();
  const alerts = [];
  const originalTrigger = operationalAlerts.trigger;
  operationalAlerts.trigger = payload => {
    alerts.push(payload);
    return { queued: false, suppressed: false, event: payload.event };
  };
  t.after(() => { operationalAlerts.trigger = originalTrigger; });

  await paymentController._testing.processWebhookEvent(event, {
    kind: "archived_order",
    attempt,
    pedido,
    resource: makePayment("rejected"),
  });

  assert.equal(attempt.status, "rejected");
  assert.equal(attempt.reconciliationStatus, "processed");
  assert.ok(attempt.processedAt instanceof Date);
  assert.equal(pedido.pagamentoStatus, "pendente");
  assert.equal(pedido.pagamentoInconsistente, false);
  assert.equal(pedido.mercadoPagoStatus, "rejected");
  assert.equal(alerts.length, 0);
});

test("tentativa órfã aprovada é preservada para conciliação sem depender do Pedido", async t => {
  const attempt = makeAttempt();
  const event = makeEvent();
  const alerts = [];
  const originalTrigger = operationalAlerts.trigger;
  operationalAlerts.trigger = payload => {
    alerts.push(payload);
    return { queued: false, suppressed: false, event: payload.event };
  };
  t.after(() => { operationalAlerts.trigger = originalTrigger; });

  await paymentController._testing.processWebhookEvent(event, {
    kind: "orphaned_order_attempt",
    attempt,
    pedido: null,
    resource: makePayment("approved"),
  });

  assert.equal(attempt.status, "approved");
  assert.equal(attempt.reconciliationStatus, "reconciliation_required");
  assert.equal(event.estabelecimentoId, ESTABELECIMENTO);
  assert.equal(event.pedidoId, PEDIDO);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, "mercado_pago_orphaned_order_payment_detected");
});

test("validação de tentativa arquivada fornece stage específico em vez de webhook_unknown", async () => {
  const attempt = makeAttempt();
  const pedido = makePedido();
  await assert.rejects(
    paymentController._testing.processArchivedOrderPayment(
      makeEvent(),
      pedido,
      makePayment("approved", { transaction_amount: 39 }),
      attempt,
    ),
    error => error.stage === "webhook_archived_order_validation"
      && error.code === "ORDER_PAYMENT_WEBHOOK_INVALID",
  );
});
