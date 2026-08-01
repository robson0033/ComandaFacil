"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const models = require("../src/models/painelModels");
const estoque = require("../src/services/estoqueService");
const pagamento = require("../src/controllers/pagamentoController");

test("estoque: lock ocupado é retry explícito, não sucesso", async () => {
  const originals = {
    findOneAndUpdate: models.Pedido.findOneAndUpdate,
    findById: models.Pedido.findById,
  };
  models.Pedido.findOneAndUpdate = async () => null;
  models.Pedido.findById = async () => ({
    estoqueBaixado: false,
    estoqueProcessamento: "processando",
  });
  try {
    const result = await estoque.baixarEstoqueDoPedido("pedido-1");
    assert.deepEqual(
      {
        success: result.success,
        status: result.status,
        retryable: result.retryable,
        errorCode: result.errorCode,
      },
      {
        success: false,
        status: "lock_ocupado",
        retryable: true,
        errorCode: "ESTOQUE_LOCK_OCUPADO",
      },
    );
  } finally {
    models.Pedido.findOneAndUpdate = originals.findOneAndUpdate;
    models.Pedido.findById = originals.findById;
  }
});

test("estoque: baixa já concluída é sucesso idempotente", async () => {
  const originals = {
    findOneAndUpdate: models.Pedido.findOneAndUpdate,
    findById: models.Pedido.findById,
  };
  models.Pedido.findOneAndUpdate = async () => null;
  models.Pedido.findById = async () => ({ estoqueBaixado: true });
  try {
    const result = await estoque.baixarEstoqueDoPedido("pedido-1");
    assert.equal(result.success, true);
    assert.equal(result.status, "ja_concluido");
    assert.equal(result.retryable, false);
  } finally {
    models.Pedido.findOneAndUpdate = originals.findOneAndUpdate;
    models.Pedido.findById = originals.findById;
  }
});

test("estoque: restauração concorrente também expõe lock", async () => {
  const originals = {
    findOneAndUpdate: models.Pedido.findOneAndUpdate,
    findById: models.Pedido.findById,
  };
  models.Pedido.findOneAndUpdate = async () => null;
  models.Pedido.findById = async () => ({
    _id: "507f1f77bcf86cd799439011",
    estoqueBaixado: true,
    estoqueRestaurado: false,
    estoqueSnapshotCriado: true,
    estoqueConsumos: [],
    estoqueProcessamento: "restaurando",
  });
  try {
    const result = await estoque.restaurarEstoqueDoPedido(
      "507f1f77bcf86cd799439011",
    );
    assert.equal(result.status, "lock_ocupado");
    assert.equal(result.retryable, true);
  } finally {
    models.Pedido.findOneAndUpdate = originals.findOneAndUpdate;
    models.Pedido.findById = originals.findById;
  }
});

test("estoque: worker sem lock não consegue concluir marcador", async () => {
  const originals = {
    pedidoUpdateOne: models.Pedido.updateOne,
  };
  models.Pedido.updateOne = async filter => {
    assert.equal(filter.estoqueLockId, "worker-antigo");
    return { modifiedCount: 0 };
  };
  try {
    await assert.rejects(
      estoque._testing.liberarLock(
        "507f1f77bcf86cd799439011",
        "worker-antigo",
        { estoqueProcessamento: "concluido" },
      ),
      error => error.code === "ESTOQUE_LOCK_PERDIDO",
    );
  } finally {
    models.Pedido.updateOne = originals.pedidoUpdateOne;
  }
});

test("tentativa: dois cliques concorrentes elegem uma única criação externa", async () => {
  const originals = {
    updateMany: models.AssinaturaTentativa.updateMany,
    findOne: models.AssinaturaTentativa.findOne,
    create: models.AssinaturaTentativa.create,
  };
  let stored = null;
  let createCalls = 0;
  models.AssinaturaTentativa.updateMany = async () => ({ modifiedCount: 0 });
  models.AssinaturaTentativa.findOne = async () => stored;
  models.AssinaturaTentativa.create = async data => {
    createCalls += 1;
    if (stored) throw Object.assign(new Error("duplicate"), { code: 11000 });
    stored = { _id: "attempt-db", ...data };
    return stored;
  };
  const assinatura = {
    _id: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f191e810c19729de860ea",
    status: "teste",
  };
  try {
    const [a, b] = await Promise.all([
      pagamento._testing.obterOuCriarTentativa(assinatura, "pix"),
      pagamento._testing.obterOuCriarTentativa(assinatura, "pix"),
    ]);
    assert.equal([a, b].filter(result => result.created).length, 1);
    assert.equal(a.attempt.attemptId, b.attempt.attemptId);
    assert.equal(a.attempt.idempotencyKey, b.attempt.idempotencyKey);
    assert.ok(createCalls >= 1);
  } finally {
    models.AssinaturaTentativa.updateMany = originals.updateMany;
    models.AssinaturaTentativa.findOne = originals.findOne;
    models.AssinaturaTentativa.create = originals.create;
  }
});

test("tentativa: índice impede duas tentativas ativas por loja, independentemente do método", () => {
  const found = models.AssinaturaTentativa.schema.indexes().some(([key, options]) =>
    key.estabelecimentoId === 1
    && key.metodo === undefined
    && options.unique === true
    && options.partialFilterExpression?.ativa === true
    && options.name === "assinatura_tentativa_ativa_global_unica");
  assert.equal(found, true);
});

test("OAuth: dois callbacks concorrentes consomem state uma única vez", async () => {
  const original = models.OAuthState.findOneAndUpdate;
  let available = true;
  models.OAuthState.findOneAndUpdate = async () => {
    if (!available) return null;
    available = false;
    return { _id: "state-1" };
  };
  const request = () => ({
    query: { state: "state-concorrente" },
    sessionID: "session-1",
    session: {
      user: {
        id: "507f191e810c19729de860ea",
        estabelecimentoId: "507f191e810c19729de860ea",
      },
      mpOauthCodeVerifier: "verifier-pkce-concorrente",
      save(callback) { callback(); },
    },
  });
  try {
    const settled = await Promise.allSettled([
      pagamento._testing.consumeOauthState(request()),
      pagamento._testing.consumeOauthState(request()),
    ]);
    assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(settled.filter(item => item.status === "rejected").length, 1);
  } finally {
    models.OAuthState.findOneAndUpdate = original;
  }
});

test("eventKey: requestId muda, efeito financeiro estável não muda", () => {
  const base = {
    resourceType: "payment",
    resourceId: "pay-1",
    action: "payment.updated",
    financialStatus: "approved",
    effectiveAt: "2026-07-25T10:00:00Z",
  };
  assert.equal(
    pagamento._testing.webhookEventKey({ ...base, requestId: "request-a" }),
    pagamento._testing.webhookEventKey({ ...base, requestId: "request-b" }),
  );
});

test("eventKey: mudança legítima de status produz nova chave", () => {
  const base = {
    resourceType: "payment",
    resourceId: "pay-1",
    action: "payment.updated",
    effectiveAt: "2026-07-25T10:00:00Z",
  };
  assert.notEqual(
    pagamento._testing.webhookEventKey({ ...base, financialStatus: "pending" }),
    pagamento._testing.webhookEventKey({ ...base, financialStatus: "approved" }),
  );
});

test("webhook: body e query com resourceId divergentes são rejeitados", () => {
  assert.throws(() => pagamento._testing.eventData({
    body: { type: "payment", data: { id: "pay-a" } },
    query: { type: "payment", "data.id": "pay-b" },
  }), /divergente/);
});

test("ordenação: aprovado antigo e recusado antigo não regressam renovação nova", () => {
  const base = {
    lastFinancialAt: "2026-07-25T12:00:00Z",
    lastApprovedPaymentId: "pay-new",
  };
  assert.equal(pagamento._testing.financialEventShouldApply({
    ...base,
    effectiveAt: "2026-07-24T12:00:00Z",
    status: "approved",
    paymentId: "pay-old",
  }), false);
  assert.equal(pagamento._testing.financialEventShouldApply({
    ...base,
    effectiveAt: "2026-07-24T13:00:00Z",
    status: "rejected",
    paymentId: "pay-old",
  }), false);
});

test("ordenação: reembolso posterior de pagamento antigo exige conciliação", () => {
  assert.equal(pagamento._testing.financialEventShouldApply({
    effectiveAt: "2026-07-26T12:00:00Z",
    lastFinancialAt: "2026-07-25T12:00:00Z",
    status: "refunded",
    paymentId: "pay-old",
    lastApprovedPaymentId: "pay-new",
  }), false);
});
