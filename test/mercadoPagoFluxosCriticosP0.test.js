"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const project = path.resolve(__dirname, "..");
const routeSource = fs.readFileSync(path.join(project, "route.js"), "utf8");
const assinaturaView = fs.readFileSync(path.join(project, "src/views/assinatura.ejs"), "utf8");
const controllerSource = fs.readFileSync(path.join(project, "src/controllers/pagamentoController.js"), "utf8");

test("assinatura continua acessível ao proprietário sem depender da permissão configuracoes", () => {
  const block = routeSource.slice(routeSource.indexOf("route.get(\n  '/assinatura'"), routeSource.indexOf("route.post(\n  '/assinatura/cartao'"));
  assert.match(block, /somenteProprietario/);
  assert.doesNotMatch(block, /permissao\('configuracoes'\)/);
});

test("OAuth da conta da loja não fica bloqueado por assinatura vencida", () => {
  const lines = routeSource.split("\n").filter(line => line.includes("/admin/mercado-pago/"));
  assert.ok(lines.length >= 3);
  for (const line of lines) assert.doesNotMatch(line, /assinaturaRequired/);
});

test("OAuth usa state, PKCE e valida identidade da conta conectada", () => {
  assert.match(controllerSource, /code_challenge_method", "S256"/);
  assert.match(controllerSource, /mp\("\/users\/me", \{\}, token\.access_token\)/);
  assert.match(controllerSource, /String\(account\.id\) !== String\(token\.user_id\)/);
});

test("pagamento de pedido é validado contra o collector da própria loja antes de persistir", () => {
  assert.match(controllerSource, /collectorId: cfgPrivada\.mercadoPago\.userId/);
  assert.match(controllerSource, /validatePaymentIdentity\(data/);
});

test("redirect de assinatura é validado para HTTPS do Mercado Pago", () => {
  assert.match(controllerSource, /function validarRedirectMercadoPago/);
  assert.match(controllerSource, /url\.protocol !== "https:"/);
  assert.match(controllerSource, /host\.endsWith\("\.mercadopago\.com\.br"\)/);
  assert.match(controllerSource, /URL de pagamento não pertence ao Mercado Pago/);
});

test("tela usa marca Comanda Fácil e bloqueia envio duplo", () => {
  assert.doesNotMatch(assinaturaView, /ComandaMix/);
  assert.match(assinaturaView, /form\.dataset\.submitting/);
  assert.match(assinaturaView, /Aguarde\.\.\./);
});
