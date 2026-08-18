"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relative) {
  return fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
}

test("Pix da mesa possui tentativa própria e unicidade ativa por loja/mesa", () => {
  const source = read("src/models/painelModels.js");
  assert.match(source, /const mesaPaymentAttemptSchema = new mongoose\.Schema/);
  assert.match(source, /mesa_payment_active_unique/);
  assert.match(source, /partialFilterExpression:\s*\{ ativa: true \}/);
  assert.match(source, /const MesaPaymentAttempt = mongoose\.model\("MesaPaymentAttempt"/);
  assert.match(source, /mesaPaymentAttemptId/);
  assert.match(source, /"pix_mesa"/);
});

test("rotas Pix da mesa exigem sessão, assinatura e permissão", () => {
  const source = read("route.js");
  for (const fragment of [
    "'/admin/mesas/:id/pix'",
    "'/admin/mesas/:id/pix/status'",
    "'/admin/mesas/:id/pix/cancelar'",
  ]) assert.match(source, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /mesaPix\.gerar/);
  assert.match(source, /mesaPix\.status/);
  assert.match(source, /mesaPix\.cancelar/);
  assert.match(source, /permissaoQualquer\('mesas', 'pedidos'\)/);
});

test("Pix não pode marcar mesa como paga pelo POST manual antigo", () => {
  const source = read("src/controllers/adminRealController.js");
  assert.match(source, /formasPixMesaSolicitadas/);
  assert.match(source, /formasPixMesaSolicitadas\.includes\("pix"\)/);
  assert.match(source, /O Pix da mesa precisa ser confirmado pelo Mercado Pago/);
  assert.match(source, /Pagamento combinado com Pix ainda não pode ser confirmado manualmente/);
  assert.match(source, /MesaPaymentAttempt\.exists/);
});

test("conta fica imutável enquanto existir Pix ativo", () => {
  const source = read("src/controllers/adminRealController.js");
  assert.match(source, /MESA_PIX_PAYMENT_ACTIVE/g);
  assert.match(source, /Não é possível adicionar novos pedidos agora/);
  assert.match(source, /Cancele o Pix antes de solicitar troca ou remoção/);
});

test("cobrança usa token OAuth da loja, valor do servidor, application_fee e idempotência", () => {
  const source = read("src/services/mesaPixPaymentService.js");
  assert.match(source, /accessTokenCriptografado/);
  assert.match(source, /X-Idempotency-Key/);
  assert.match(source, /application_fee:\s*centsToDecimal\(attempt\.platformFeeCents\)/);
  assert.match(source, /transaction_amount:\s*amount/);
  assert.match(source, /pedidoIds/);
  assert.match(source, /expectedAmount/);
});

test("mesa só é liberada por payment approved e cancelamento incerto exige conciliação", () => {
  const source = read("src/services/mesaPixPaymentService.js");
  assert.match(source, /remoteStatus !== "approved"/);
  assert.match(source, /status: "livre"/);
  assert.match(source, /cancellation_not_confirmed/);
  assert.match(source, /reconciliation_required/);
  assert.match(source, /approved_after_confirmed_cancellation/);
  assert.doesNotMatch(source, /pedido\.mercadoPagoPaymentId\s*=/);
});

test("QR da mesa usa job manual único e exige agente 1.4.0", () => {
  const source = read("src/services/printQueueService.js");
  assert.match(source, /async function criarJobPixMesa/);
  assert.match(source, /compareVersions\(agent\?\.agentVersion, "1\.4\.0"\)/);
  assert.match(source, /tipo: "manual"/);
  assert.match(source, /motivo: "pix_mesa"/);
  assert.match(source, /pixPagamento:/);
  assert.match(source, /\.find\(item =>/);
});

test("painel abre modal, acompanha impressão/pagamento e permite cancelamento seguro", () => {
  const source = read("src/views/admin-real.ejs");
  assert.match(source, /id="modalPixMesa"/);
  assert.match(source, /Gerando pagamento Pix/);
  assert.match(source, /QR Code impresso\. Aguardando o pagamento/);
  assert.match(source, /Cancelar Pix e escolher outra forma/);
  assert.match(source, /\/pix\/status/);
  assert.match(source, /\/pix\/cancelar/);
  assert.match(source, /data-forma-pagamento-mesa/);
  assert.match(source, /String\(modo\?\.value \|\| ''\) !== 'pix'/);
});

test("webhook classifica e processa pagamento Pix da mesa antes de assinatura", () => {
  const source = read("src/controllers/pagamentoController.js");
  assert.match(source, /mesaPixPaymentService\.loadWebhookPayment/);
  assert.match(source, /mesaPixPaymentService\.recoverWebhookByExternalReference/);
  assert.match(source, /loaded\.kind === "mesa_payment"/);
  assert.match(source, /mesaPixPaymentService\.processWebhookPayment/);
});

test("migração controlada inclui os índices da tentativa Pix da mesa", () => {
  const source = read("scripts/create-mercado-pago-indexes.js");
  assert.match(source, /MesaPaymentAttempt/);
  assert.match(source, /mesa_payment_attempt_id_unique/);
  assert.match(source, /mesa_payment_payment_id_unique/);
  assert.match(source, /mesa_payment_active_unique/);
  assert.match(source, /partialFilterExpression:\s*\{ ativa: true \}/);
});

test("criação incerta não libera outra forma e recuperação busca pela external_reference", () => {
  const service = read("src/services/mesaPixPaymentService.js");
  const controller = read("src/controllers/mesaPixController.js");
  const view = read("src/views/admin-real.ejs");
  assert.match(service, /paymentCreationMayBeUncertain/);
  assert.match(service, /\/v1\/payments\/search\?\$\{query\.toString\(\)\}/);
  assert.match(service, /payment_creation_uncertain/);
  assert.match(service, /reconciliationStatus \|\| ""\) === "reconciliation_required"/);
  assert.match(controller, /pixActive: true/);
  assert.match(controller, /reconciliationRequired: true/);
  assert.match(view, /Não escolha outra forma de pagamento enquanto esta tentativa estiver ativa/);
  const estoque = service.indexOf("for (const pedido of aindaPendentes) {\n      exigirEstoqueConcluido");
  const baixaFinanceira = service.indexOf("pedido.pagamentoStatus = \"pago\"");
  assert.ok(estoque >= 0 && baixaFinanceira > estoque, "estoque de toda a comanda deve ser processado antes de marcar pedidos como pagos");
});
