"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("conexão OAuth é iniciada por fetch same-origin e redirecionamento validado", () => {
  const view = read("src/views/admin-real.ejs");
  const controller = read("src/controllers/pagamentoController.js");
  assert.match(view, /data-mercado-pago-connect/);
  assert.match(view, /MERCADO_PAGO_OAUTH_READY|authorizationUrl/);
  assert.match(view, /window\.location\.assign\(target\.toString\(\)\)/);
  assert.match(controller, /MERCADO_PAGO_OAUTH_READY/);
  assert.match(controller, /authorizationUrl/);
});

test("assinatura via cartão e Pix usa JSON sem depender de submit nativo", () => {
  const view = read("src/views/assinatura.ejs");
  const controller = read("src/controllers/pagamentoController.js");
  assert.match(view, /data-subscription-payment="cartao"/);
  assert.match(view, /data-subscription-payment="pix"/);
  assert.match(view, /X-CSRF-Token/);
  assert.match(view, /Accept:\s*'application\/json'/);
  assert.match(controller, /SUBSCRIPTION_REDIRECT_READY/);
  assert.match(controller, /PIX_READY/);
});

test("credencial principal é validada por users me antes da cobrança", () => {
  const controller = read("src/controllers/pagamentoController.js");
  assert.match(controller, /async function validarContaPrincipalMercadoPago/);
  assert.match(controller, /await mp\("\/users\/me"\)/);
  assert.match(controller, /MERCADO_PAGO_PLATFORM_ACCOUNT_MISMATCH/);
});

test("configuração OAuth e assinatura são avaliadas separadamente", () => {
  const controller = read("src/controllers/pagamentoController.js");
  assert.match(controller, /mercadoPagoConfigStatus\(scope = "all"\)/);
  assert.match(controller, /mercadoPagoConfigStatus\("subscription"\)/);
  assert.match(controller, /mercadoPagoConfigStatus\("oauth"\)|assertMercadoPagoConfig\("oauth"\)/);
});

test("rotas de conexão continuam exclusivas do proprietário", () => {
  const routes = read("route.js");
  assert.match(routes, /mercado-pago\/conectar', loginRequired, somenteProprietario/);
  assert.match(routes, /mercado-pago\/callback', loginRequired, somenteProprietario/);
  assert.match(routes, /mercado-pago\/desconectar', loginRequired, somenteProprietario/);
});
