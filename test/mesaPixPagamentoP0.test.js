"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relative) {
  return fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
}

test("Pix da mesa fica disponível apenas como registro manual", () => {
  const controller = read("src/controllers/adminRealController.js");
  const view = read("src/views/admin-real.ejs");

  assert.match(controller, /Pix informado na mesa é somente um registro manual da forma de pagamento/);
  assert.doesNotMatch(controller, /formasPixMesaSolicitadas/);
  assert.doesNotMatch(controller, /O Pix da mesa precisa ser confirmado pelo Mercado Pago/);

  // Pix continua selecionável para registrar a forma recebida e alimentar dashboard/relatórios.
  assert.match(view, /<option value="pix">\s*Pix\s*<\/option>/);
  assert.match(view, /painelDashboard\.formasPagamento\?\.pix/);
});

test("rota antiga de criação de Pix da mesa está desativada e não gera QR Code", () => {
  const route = read("route.js");

  assert.match(route, /'\/admin\/mesas\/:id\/pix'/);
  assert.match(route, /MESA_PIX_DISABLED/);
  assert.match(route, /Nenhum QR Code é gerado/);
  assert.doesNotMatch(route, /mesaPix\.gerar/);

  // Rotas de status/cancelamento permanecem apenas para tentativas legadas já existentes.
  assert.match(route, /mesaPix\.status/);
  assert.match(route, /mesaPix\.cancelar/);
});

test("painel não abre modal nem chama fluxo online de Pix da mesa", () => {
  const view = read("src/views/admin-real.ejs");

  assert.doesNotMatch(view, /id="modalPixMesa"/);
  assert.doesNotMatch(view, /function montarPayloadPixMesa\(form\)/);
  assert.doesNotMatch(view, /function iniciarPixMesa\(/);
  assert.doesNotMatch(view, /\/admin\/mesas\/\$\{encodeURIComponent\(mesaId\)\}\/pix/);
  assert.doesNotMatch(view, /QR Code impresso\. Aguardando o pagamento/);
});

test("Pix manual e Pix online continuam consolidados no Dashboard", () => {
  const controller = read("src/controllers/adminRealController.js");
  const view = read("src/views/admin-real.ejs");

  assert.match(controller, /method === "pix" \|\| method === "pix_online"/);
  assert.match(view, /Recebimentos por forma de pagamento/);
  assert.match(view, /Valor registrado em Pix no período/);
});

test("infraestrutura legada de Pix da mesa permanece capaz de reconciliar pagamentos antigos", () => {
  const paymentController = read("src/controllers/pagamentoController.js");
  const service = read("src/services/mesaPixPaymentService.js");

  assert.match(paymentController, /mesaPixPaymentService\.loadWebhookPayment/);
  assert.match(paymentController, /mesaPixPaymentService\.recoverWebhookByExternalReference/);
  assert.match(paymentController, /mesaPixPaymentService\.processWebhookPayment/);
  assert.match(service, /reconciliation_required/);
});
