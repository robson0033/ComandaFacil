"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");

const payment = require("../src/controllers/pagamentoController");
const { OrderPaymentAttempt } = require("../src/models/painelModels");

test("referência nova usa UUID opaco e não contém ObjectId", () => {
  const objectId = "64f123456789abcdef123456";
  const first = payment._testing.orderAttemptExternalReference(crypto.randomUUID());
  const second = payment._testing.orderAttemptExternalReference(crypto.randomUUID());
  assert.match(first, /^order_payment_attempt:[0-9a-f-]{36}$/i);
  assert.equal(payment._testing.isOpaqueOrderReference(first), true);
  assert.equal(first.includes(objectId), false);
  assert.notEqual(first, second);
  assert.equal(payment._testing.isOpaqueOrderReference(`pedido:${objectId}`), false);
});

test("modelo da tentativa possui tenant, vínculos e índices únicos", () => {
  for (const path of [
    "publicReference", "externalReference", "estabelecimentoId", "pedidoId",
    "paymentId", "expectedCollectorId", "expectedAmount", "currency", "status",
    "paymentMethod", "idempotencyKey", "expiresAt", "lastCheckedAt", "processedAt",
    "reconciliationStatus", "webhookEvents", "legacyReference",
  ]) assert.ok(OrderPaymentAttempt.schema.path(path), path);
  const indexes = OrderPaymentAttempt.schema.indexes();
  assert.ok(indexes.some(([key, options]) => key.publicReference === 1 && options.unique));
  assert.ok(indexes.some(([key, options]) => key.externalReference === 1 && options.unique));
  assert.ok(indexes.some(([key, options]) => key.paymentId === 1 && options.unique));
  assert.ok(indexes.some(([key, options]) => key.idempotencyKey === 1 && options.unique));
  assert.ok(indexes.some(([key]) => key.estabelecimentoId === 1 && key.pedidoId === 1));
});

test("criação nova não usa pedido:ObjectId e resposta não expõe referência", () => {
  const source = fs.readFileSync("src/controllers/pagamentoController.js", "utf8");
  const creation = source.slice(source.indexOf("exports.gerarPixPedido"), source.indexOf("exports.statusPagamentoPedido"));
  assert.match(creation, /external_reference: attempt\.externalReference/);
  assert.match(creation, /X-Idempotency-Key": attempt\.idempotencyKey/);
  assert.doesNotMatch(creation, /external_reference: `pedido:\$\{pedido\._id\}`/);
  const publicResponse = creation.slice(creation.lastIndexOf("return res.status(201).json"));
  assert.doesNotMatch(publicResponse, /externalReference|external_reference/);
});

test("webhook e fallback priorizam tentativa persistida e legado é explicitamente marcado", () => {
  const source = fs.readFileSync("src/controllers/pagamentoController.js", "utf8");
  assert.match(source, /OrderPaymentAttempt\.findOne\(\{ paymentId: data\.resourceId \}\)/);
  assert.match(source, /legacyReference: true/);
  assert.match(source, /applyOrderPayment\(claimed, payment, attempt\)/);
  assert.match(source, /Moeda do pagamento divergente/);
});
