"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const controller = fs.readFileSync(
  path.join(__dirname, "../src/controllers/pagamentoController.js"),
  "utf8",
);

test("Pix do pedido usa explicitamente o token OAuth do estabelecimento", () => {
  assert.match(controller, /configuracaoComToken\(cfgPublica\.estabelecimentoId\)/);
  assert.match(controller, /mp\("\/v1\/payments"[\s\S]*?\}, accessToken\)/);
  assert.match(controller, /tokenSource:\s*"oauth_estabelecimento"/);
});

test("taxa de marketplace bloqueia conta vendedora igual à conta integradora", () => {
  assert.match(controller, /MP_MARKETPLACE_SELLER_SAME_AS_PLATFORM/);
  assert.match(controller, /assertMarketplaceSellerAccount\(sellerUserId\)/);
  assert.match(controller, /sellerMatchesPlatform:\s*sameMercadoPagoAccount/);
});

test("diagnóstico não registra access token", () => {
  const diagnostic = controller.match(/appLogger\.info\("mercado_pago_order_token_diagnostic"[\s\S]*?\n\s*\}\);/)?.[0] || "";
  assert.ok(diagnostic);
  assert.doesNotMatch(diagnostic, /accessToken\s*[,}]/);
  assert.match(diagnostic, /accessTokenPresent/);
});
