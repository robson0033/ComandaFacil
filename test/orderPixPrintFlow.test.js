"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { PrintJob } = require("../src/models/painelModels");
const {
  isOrderEligibleForAutomaticPrint,
} = require("../src/services/printQueueService");

function pix(overrides = {}) {
  return {
    formaPagamento: "pix_online",
    pagamentoStatus: "pendente",
    mercadoPagoStatus: "pending",
    status: "novo",
    excluido: false,
    ...overrides,
  };
}

test("regra central bloqueia todos os estados Pix não aprovados", () => {
  for (const status of [
    "pending", "in_process", "rejected", "cancelled", "expired",
    "refunded", "charged_back", "reconciliation_required",
  ]) {
    assert.equal(isOrderEligibleForAutomaticPrint(pix({ mercadoPagoStatus: status })), false);
  }
});

test("somente Pix pago e approved libera impressão automática", () => {
  assert.equal(isOrderEligibleForAutomaticPrint(pix({
    pagamentoStatus: "pago",
    mercadoPagoStatus: "approved",
  })), true);
  assert.equal(isOrderEligibleForAutomaticPrint(pix({
    pagamentoStatus: "pago",
    mercadoPagoStatus: "approved",
    status: "cancelado",
  })), false);
});

test("índice persistido deduplica job automático por loja, pedido e impressora", () => {
  const index = PrintJob.schema.indexes().find(([, options]) =>
    options.name === "printjob_automatico_unico");
  assert.deepEqual(index[0], {
    estabelecimentoId: 1,
    pedidoId: 1,
    impressoraChave: 1,
    tipo: 1,
  });
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { tipo: "automatica" });
});

test("aprovação é atômica, idempotente e webhook/fallback compartilham função", () => {
  const source = fs.readFileSync("src/controllers/pagamentoController.js", "utf8");
  assert.match(source, /async function processApprovedOrderPayment/);
  assert.match(source, /pagamentoStatus: \{ \$ne: "pago" \}/);
  assert.match(source, /formaPagamento: "pix_online"/);
  assert.match(source, /criarJobsAutomaticos\(transitioned\)/);
  assert.match(source, /applyOrderPayment\(claimed, payment, attempt, "status_fallback"/);
  assert.match(source, /applyOrderPayment\(pedido, payment, attempt, "webhook"/);
});

test("modal usa polling adaptativo, pausa oculto e sempre limpa dados ao fechar", () => {
  const view = fs.readFileSync("src/views/catalogo-publico.ejs", "utf8");
  assert.match(view, /if \(elapsed < 30_000\) return 2_000/);
  assert.match(view, /if \(elapsed < 120_000\) return 5_000/);
  assert.doesNotMatch(view, /setInterval[\s\S]{0,300}pagamento-status/);
  assert.match(view, /document\.hidden/);
  assert.match(view, /clearTimeout\(pixPollingTimer\)/);
  assert.match(view, /setTimeout\(closePixModal, 700\)/);
  assert.match(view, /pixQrImage"\)\.removeAttribute\("src"\)/);
  assert.match(view, /pixCopyCode"\)\.value = ""/);
  assert.match(view, /document\.body\.classList\.remove\("modal-open"\)/);
});

test("paymentId do navegador não é usado pelo fallback", () => {
  const source = fs.readFileSync("src/controllers/pagamentoController.js", "utf8");
  const start = source.indexOf("exports.statusPagamentoPedido");
  const end = source.indexOf("function webhookPayloadError", start);
  const fallback = source.slice(start, end);
  assert.doesNotMatch(fallback, /req\.body[^\n]*paymentId/);
  assert.match(fallback, /pedido\.mercadoPagoPaymentId/);
  assert.match(fallback, /mercadoPagoCheckLockedUntil/);
  assert.match(fallback, />= 2_500/);
});
