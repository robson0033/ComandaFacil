"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");

const expirationService = read("src/services/pedidoPixExpirationService.js");
const pagamentoController = read("src/controllers/pagamentoController.js");
const pedidoModel = read("src/models/painelModels.js");
const archiveService = read("src/services/pedidoArquivamentoService.js");
const publicCatalog = read("src/views/catalogo-publico.ejs");
const adminView = read("src/views/admin-real.ejs");
const server = read("server.js");

test("Pix online mantém janela comercial de 10 minutos e expiração remota compatível com o provedor", () => {
  // Regra comercial: o cliente tem somente 10 minutos para concluir o Pix.
  assert.match(expirationService, /ORDER_PIX_EXPIRATION_MINUTES\s*=\s*10\s*;/);
  assert.match(expirationService, /createdAt\.getTime\(\)\s*\+\s*ORDER_PIX_EXPIRATION_MS/);
  assert.match(pagamentoController, /expiresAt:\s*new Date\(Date\.now\(\)\s*\+\s*ORDER_PIX_EXPIRATION_MS\)/);

  // A expiração enviada ao Mercado Pago é separada da janela comercial.
  // O provedor recebe a menor janela aceita por sua API; o ComandaFacil
  // continua expirando/cancelando localmente após os 10 minutos.
  assert.match(expirationService, /ORDER_PIX_PROVIDER_EXPIRATION_MINUTES\s*=\s*31\s*;/);
  assert.match(expirationService, /current\.getTime\(\)\s*\+\s*ORDER_PIX_PROVIDER_EXPIRATION_MS/);
  assert.match(
    pagamentoController,
    /date_of_expiration:\s*providerPixExpirationDate\(\)\.toISOString\(\)/,
  );
  assert.match(
    pagamentoController,
    /requestedExpiration[\s\S]{0,360}attempt\.expiresAt\s*=\s*providerExpiration[\s\S]{0,360}requestedExpiration/,
  );
});

test("expiração deixa de ser pagamento ativo e vira estado arquivável", () => {
  assert.match(pedidoModel, /pagamentoStatus:[\s\S]{0,220}"expirado"/);
  assert.match(expirationService, /pedido\.pagamentoStatus\s*=\s*"expirado"/);
  assert.match(expirationService, /pedido\.pixCopiaCola\s*=\s*""/);
  assert.match(expirationService, /pedido\.pixQrCodeBase64\s*=\s*""/);
  assert.match(archiveService, /pixExpiradoSemAprovacao/);
  assert.match(archiveService, /pedido\.pagamentoStatus\s*!==\s*"expirado"/);
});

test("catálogo exibe contagem regressiva e desativa QR expirado", () => {
  assert.match(publicCatalog, /id="pixCountdown">10:00<\/strong>/);
  assert.match(publicCatalog, /Pagamento expirado\. Este QR Code não pode mais ser usado/);
  assert.match(publicCatalog, /function mostrarPixExpirado\(/);
  assert.match(publicCatalog, /function iniciarContagemPix\(expiraEm\)/);
  assert.match(publicCatalog, /pixExpirado/);
});

test("painel administrativo identifica pagamento expirado", () => {
  assert.match(adminView, /Pagamento expirado/);
  assert.match(adminView, /pagamentoStatus\s*===\s*'expirado'/);
  assert.match(adminView, /\.status\.expirado/);
});

test("worker reconcilia expirações sem depender do navegador do cliente", () => {
  assert.match(server, /reconciliarPixPedidosExpirados\(\{\s*limit:\s*200\s*\}\)/);
  assert.match(server, /setInterval\([\s\S]{0,240}reconciliarPixPedidosExpirados/);
  assert.match(server, /30\s*\*\s*1000/);
});

test("cancelamento e rejeição não usam mais assert de baixa para restaurar estoque", () => {
  assert.match(pagamentoController, /function assertStockRestored\(result\)/);
  assert.match(pagamentoController, /\["restaurado",\s*"ja_restaurado",\s*"nao_baixado"\]/);
  assert.match(
    pagamentoController,
    /\["cancelled",\s*"rejected",\s*"refunded",\s*"charged_back"\][\s\S]{0,180}assertStockRestored\(await restaurarEstoqueDoPedido/,
  );
});

test("aprovação posterior ao prazo exige conciliação em vez de pagamento silencioso", () => {
  assert.match(pagamentoController, /mercado_pago_order_pix_approved_after_expiration/);
  assert.match(pagamentoController, /reconciliation_required:approved_after_expiration/);
  assert.match(pagamentoController, /pagamentoInconsistente\s*=\s*true/);
});
