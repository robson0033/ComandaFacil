"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  calculatePlatformFeeCents,
  centsToDecimal,
  getCurrentPlatformFeeConfig,
} = require("../src/services/platformFeeService");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("taxa de 1,5% é calculada em centavos sem aumentar o total", () => {
  assert.equal(calculatePlatformFeeCents(3000, 1.5), 45);
  assert.equal(calculatePlatformFeeCents(10000, 1.5), 150);
  assert.equal(centsToDecimal(45), 0.45);
  assert.equal(getCurrentPlatformFeeConfig({
    PLATFORM_PIX_FEE_PERCENT: "1.5",
    PLATFORM_PIX_TERMS_VERSION: "1.0",
  }).percentage, 1.5);
});

test("Pix usa application_fee no backend e preserva transaction_amount", () => {
  const controller = read("src/controllers/pagamentoController.js");
  assert.match(controller, /transaction_amount:\s*Number\(pedido\.total\)/);
  assert.match(controller, /application_fee:\s*centsToDecimal\(attempt\.platformFeeCents\)/);
  assert.doesNotMatch(controller, /transaction_amount:\s*Number\(pedido\.total\)\s*\+/);
});

test("OAuth exige aceite no backend e rota de aceite é restrita ao proprietário", () => {
  const controller = read("src/controllers/pagamentoController.js");
  const routes = read("route.js");
  assert.match(controller, /exports\.conectarMercadoPago[\s\S]*?requirePlatformFeeAcceptance\(estabelecimentoId\(req\)\)/);
  assert.match(routes, /mercado-pago\/termos\/aceitar[^\n]*loginRequired[^\n]*somenteProprietario/);
});

test("taxa aparece dentro da página de relatórios e não no modal de estoque", () => {
  const view = read("src/views/admin-real.ejs");
  const reportStart = view.indexOf('id="page-relatorios"');
  const feeStart = view.indexOf('id="relatorio-taxas-pix"');
  const stockModal = view.indexOf('id="modalEstoque"');
  assert.ok(reportStart >= 0 && feeStart > reportStart);
  assert.ok(stockModal < 0 || feeStart < stockModal || feeStart > view.indexOf('</div>\n  </div>', stockModal));
});

test("relatório considera somente Pix online e adicionais aparecem nos cards", () => {
  const controller = read("src/controllers/adminRealController.js");
  const view = read("src/views/admin-real.ejs");
  assert.match(controller, /String\(pedido\.formaPagamento \|\| ""\) !== "pix_online"/);
  assert.match(view, /Array\.isArray\(item\.adicionais\)/);
  assert.match(view, /order-item-addons/);
  assert.match(view, /adicional\.nome/);
});
