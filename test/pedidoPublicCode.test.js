"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {
  codigoFinal,
  codigoFinalValido,
  codigoPublicoValido,
  gerarCodigoPublico,
} = require("../src/services/pedidoPublicCodeService");
const { Pedido } = require("../src/models/painelModels");

test("código público é aleatório, hexadecimal e não deriva de ObjectId", () => {
  const codigos = new Set(Array.from({ length: 100 }, gerarCodigoPublico));
  assert.equal(codigos.size, 100);
  for (const codigo of codigos) {
    assert.equal(codigoPublicoValido(codigo), true);
    assert.equal(codigo.length, 8);
  }
});

test("final público aceita exatamente quatro caracteres", () => {
  assert.equal(codigoFinal("8D910F2A"), "0F2A");
  assert.equal(codigoFinalValido("0f2a"), true);
  assert.equal(codigoFinalValido("F2A"), false);
});

test("modelo possui unicidade por loja e índice de consulta indexável", () => {
  const indexes = Pedido.schema.indexes();
  const unique = indexes.find(([, options]) =>
    options.name === "pedido_codigo_publico_tenant_unico");
  assert.deepEqual(unique[0], { estabelecimentoId: 1, codigoPublico: 1 });
  assert.equal(unique[1].unique, true);
  const lookup = indexes.find(([, options]) =>
    options.name === "pedido_consulta_publica_segura");
  assert.deepEqual(lookup[0], {
    estabelecimentoId: 1,
    telefoneNormalizado: 1,
    codigoPublicoFinal: 1,
    createdAt: -1,
  });
});

test("interface usa finally, loading, clique único e não usa OTP", () => {
  const view = fs.readFileSync("src/views/catalogo-publico.ejs", "utf8");
  assert.match(view, /let consultaEmAndamento = false/);
  assert.match(view, /loadingDialog\.showModal\(\)/);
  assert.match(view, /finally\s*\{/);
  assert.match(view, /if \(loadingDialog\.open\) loadingDialog\.close\(\)/);
  assert.match(view, /lookupButton\.disabled = true/);
  assert.match(view, /pedidos\/consultar/);
  assert.doesNotMatch(view, /one-time-code|Enviar código de verificação/);
});

test("resposta pública não seleciona identificadores internos", () => {
  const controller = fs.readFileSync("src/controllers/adminRealController.js", "utf8");
  const start = controller.indexOf("exports.consultarPedidoPublico");
  const end = controller.indexOf("const ORDER_LOOKUP_GENERIC", start);
  const implementation = controller.slice(start, end);
  assert.doesNotMatch(implementation, /paymentId|external_reference|collectorId/);
  assert.match(implementation, /estabelecimentoId: configuracao\.estabelecimentoId/);
  assert.match(implementation, /\.limit\(2\)/);
  assert.match(implementation, /ORDER_LOOKUP_FULL_CODE_REQUIRED/);
});
