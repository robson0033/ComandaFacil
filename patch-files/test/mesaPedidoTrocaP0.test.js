"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(rel) {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

test("troca da mesa é solicitada por item e não pelo pedido inteiro", () => {
  const model = source("src/models/painelModels.js");
  assert.match(model, /remocaoSolicitacaoStatus:[\s\S]{0,220}default: "nenhuma"/);

  const controller = source("src/controllers/adminRealController.js");
  const start = controller.indexOf("exports.solicitarRemocaoPedidoMesa = async");
  const end = controller.indexOf("function totaisPedidoMesaDepoisDaRemocao", start);
  const block = controller.slice(start, end);
  assert.match(block, /const itemId = String\(req\.body\?\.itemId/);
  assert.match(block, /"itens\.\$\.remocaoSolicitacaoStatus": "pendente"/);
  assert.match(block, /\$elemMatch/);
  assert.doesNotMatch(block, /\$set:\s*\{\s*remocaoSolicitacaoStatus: "pendente"/);
});

test("cardápio envia pedidoId e itemId do botão clicado", () => {
  const view = source("src/views/mesa-publica.ejs");
  assert.match(view, /data-remove-mesa-item="<%= item\.itemId %>"/);
  assert.match(view, /const itemId = String\(button\.dataset\.removeMesaItem/);
  assert.match(view, /JSON\.stringify\(\{ itemId \}\)/);
  assert.match(view, /somente deste item/);
});

test("aprovação remove apenas o subitem e recalcula o pedido", () => {
  const controller = source("src/controllers/adminRealController.js");
  const start = controller.indexOf("exports.aprovarRemocaoPedidoMesa = async");
  const end = controller.indexOf("exports.recusarRemocaoPedidoMesa = async", start);
  const block = controller.slice(start, end);
  assert.match(block, /itensRestantes = atual\.itens/);
  assert.match(block, /String\(item\?\._id \|\| ""\) !== itemId/);
  assert.match(block, /totaisPedidoMesaDepoisDaRemocao/);
  assert.match(block, /subtotalProdutos: totais\.subtotalProdutos/);
  assert.match(block, /total: totais\.total/);
  assert.match(block, /custo: totais\.custo/);
  assert.match(block, /pedidoEncerrado = itensRestantes\.length === 0/);
  assert.match(block, /Somente o item solicitado foi removido/);
});

test("recusa altera somente o item solicitado", () => {
  const controller = source("src/controllers/adminRealController.js");
  const start = controller.indexOf("exports.recusarRemocaoPedidoMesa = async");
  const end = controller.indexOf("exports.avaliarPedidoMesa = async", start);
  const block = controller.slice(start, end);
  assert.match(block, /"itens\.\$\.remocaoSolicitacaoStatus": "recusada"/);
  assert.match(block, /itemId/);
  assert.match(block, /idempotent: true/);
});

test("painel administrativo decide a solicitação usando itemId", () => {
  const view = source("src/views/admin-real.ejs");
  assert.match(view, /data-removal-item-id="<%= item\._id %>"/);
  assert.match(view, /const itemId = String\(button\.dataset\.removalItemId/);
  assert.match(view, /JSON\.stringify\(\{ itemId \}\)/);
  assert.match(view, /remover somente este item/);
});

test("rotas continuam protegidas e permissões críticas permanecem", () => {
  const routes = source("route.js");
  const publicStart = routes.indexOf("/mesa/:token/pedidos/:pedidoId/remover");
  assert.ok(publicStart >= 0);
  assert.match(routes.slice(publicStart - 100, publicStart + 450), /anonymousSameOriginProtection/);
  for (const action of ["aprovar", "recusar"]) {
    const start = routes.indexOf(`/solicitacao-remocao/${action}`);
    assert.ok(start >= 0, action);
    const block = routes.slice(start - 160, start + 500);
    assert.match(block, /permissao\('pedidos'\)/);
    assert.match(block, /permissao\('autorizar_troca_mesa'\)/);
  }
});
