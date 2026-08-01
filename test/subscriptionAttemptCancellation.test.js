"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const models = require("../src/models/painelModels");
const pagamento = require("../src/controllers/pagamentoController");
const { platformErrorLog } = require("../src/services/mercadoPagoPlatformService");
const {
  BLOCKING_ATTEMPT_STATUSES,
  CANCELLABLE_ATTEMPT_STATUSES,
  SUBSCRIPTION_ATTEMPT_STATUS,
} = require("../src/constants/subscriptionAttempt");

const STORE_A = "507f191e810c19729de860ea";
const STORE_B = "507f191e810c19729de860eb";
const SUBSCRIPTION = "507f1f77bcf86cd799439011";

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function request(storeId = STORE_A) {
  return {
    body: { estabelecimentoId: STORE_B, attemptId: "nao-confiar" },
    correlationId: "corr-cancel",
    assinatura: { status: "teste", fimTeste: new Date(Date.now() + 60_000) },
    session: { user: { id: storeId, estabelecimentoId: storeId, tipo: "proprietario" } },
  };
}

function attempt(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439012",
    attemptId: crypto.randomUUID(),
    assinaturaId: SUBSCRIPTION,
    estabelecimentoId: STORE_A,
    metodo: "cartao",
    status: SUBSCRIPTION_ATTEMPT_STATUS.PENDING,
    ativa: true,
    expiresAt: new Date(Date.now() + 60_000),
    mercadoPagoPreapprovalId: "",
    ...overrides,
  };
}

test("estados bloqueadores são centralizados e excluem estados terminais", () => {
  assert.ok(BLOCKING_ATTEMPT_STATUSES.includes("processing"));
  assert.ok(BLOCKING_ATTEMPT_STATUSES.includes("pending"));
  assert.ok(BLOCKING_ATTEMPT_STATUSES.includes("authorized"));
  for (const status of ["approved", "cancelled", "expired", "failed"]) {
    assert.equal(BLOCKING_ATTEMPT_STATUSES.includes(status), false);
  }
});

test("modelo preserva cancelamento, autor, claim e diagnóstico de reconciliação", () => {
  const schema = models.AssinaturaTentativa.schema;
  for (const field of [
    "cancelRequestedAt", "cancelRequestId", "cancelledAt", "cancelledBy", "remoteCancellationStatus",
    "reconciliationReason", "reconciliationRequestedAt", "reconciliationAttempts",
    "lastRemoteStatus", "lastRemoteCheckedAt",
  ]) {
    assert.ok(schema.path(field), field);
  }
});

test("página mostra cancelamento sem ID interno e frontend impede submit duplo", () => {
  const view = fs.readFileSync(path.join(__dirname, "../src/views/assinatura.ejs"), "utf8");
  assert.match(view, /Descartar tentativa de cartão/);
  assert.match(view, /Cancelar assinatura no Mercado Pago/);
  assert.match(view, /type="button" data-cancel-attempt/);
  assert.match(view, /button\.dataset\.submitting === 'true'/);
  assert.match(view, /if \(cancelInFlight \|\| button\.dataset\.submitting === 'true'\) return/);
  assert.match(view, /cancelInFlight = true/);
  assert.match(view, /button\.textContent = 'Cancelando\.\.\.'/);
  assert.match(view, /credentials: 'same-origin'/);
  assert.match(view, /X-CSRF-Token/);
  assert.doesNotMatch(view, /tentativaAtiva\.(?:_id|attemptId|mercadoPagoPreapprovalId)/);
});

test("rota de cancelamento exige CSRF global, sessão e proprietário", () => {
  const source = fs.readFileSync(path.join(__dirname, "../route.js"), "utf8");
  assert.match(source, /route\.use\('\/assinatura', csrfSameOriginProtection\)/);
  assert.match(source, /'\/assinatura\/tentativa-ativa\/cancelar',[\s\S]*?loginRequired,[\s\S]*?somenteProprietario,[\s\S]*?carregarAssinatura/);
});

test("cancelamento local usa tenant da sessão, é atômico e não ativa assinatura", async t => {
  const originalUpdateMany = models.AssinaturaTentativa.updateMany;
  const originalFindOneAndUpdate = models.AssinaturaTentativa.findOneAndUpdate;
  const originalFindOne = models.AssinaturaTentativa.findOne;
  const stored = attempt();
  const calls = [];
  models.AssinaturaTentativa.updateMany = async () => ({ modifiedCount: 0 });
  models.AssinaturaTentativa.findOneAndUpdate = async (filter, update) => {
    calls.push({ filter, update });
    return calls.length === 1 ? stored : { ...stored, ...update.$set };
  };
  models.AssinaturaTentativa.findOne = () => ({ sort: async () => null });
  t.after(() => {
    models.AssinaturaTentativa.updateMany = originalUpdateMany;
    models.AssinaturaTentativa.findOneAndUpdate = originalFindOneAndUpdate;
    models.AssinaturaTentativa.findOne = originalFindOne;
  });
  const res = response();
  await pagamento.cancelarTentativaAtiva(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.code, "SUBSCRIPTION_ATTEMPT_ABANDONED");
  assert.equal(String(calls[0].filter.estabelecimentoId), STORE_A);
  assert.notEqual(String(calls[0].filter.estabelecimentoId), STORE_B);
  assert.deepEqual(calls[0].filter.status.$in, CANCELLABLE_ATTEMPT_STATUSES);
  assert.equal(calls[1].update.$set.status, "cancelled");
  assert.equal(calls[1].update.$set.ativa, false);
  assert.equal(String(calls[1].update.$set.cancelledBy), STORE_A);
  assert.equal(request().assinatura.status, "teste");
});

test("tentativa de outra loja não é localizada", async t => {
  const originalUpdateMany = models.AssinaturaTentativa.updateMany;
  const originalFindOneAndUpdate = models.AssinaturaTentativa.findOneAndUpdate;
  const originalFindOne = models.AssinaturaTentativa.findOne;
  const queries = [];
  models.AssinaturaTentativa.updateMany = async () => ({ modifiedCount: 0 });
  models.AssinaturaTentativa.findOneAndUpdate = async filter => { queries.push(filter); return null; };
  models.AssinaturaTentativa.findOne = filter => {
    queries.push(filter);
    return { sort: async () => null, then(resolve) { resolve(null); } };
  };
  t.after(() => {
    models.AssinaturaTentativa.updateMany = originalUpdateMany;
    models.AssinaturaTentativa.findOneAndUpdate = originalFindOneAndUpdate;
    models.AssinaturaTentativa.findOne = originalFindOne;
  });
  const res = response();
  await pagamento.cancelarTentativaAtiva(request(STORE_A), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.code, "SUBSCRIPTION_ATTEMPT_NOT_FOUND");
  assert.ok(queries.every(query => String(query.estabelecimentoId) === STORE_A));
});

test("tentativa approved não pode ser cancelada", async t => {
  const originalUpdateMany = models.AssinaturaTentativa.updateMany;
  const originalFindOneAndUpdate = models.AssinaturaTentativa.findOneAndUpdate;
  const originalFindOne = models.AssinaturaTentativa.findOne;
  let findCalls = 0;
  models.AssinaturaTentativa.updateMany = async () => ({ modifiedCount: 0 });
  models.AssinaturaTentativa.findOneAndUpdate = async () => null;
  models.AssinaturaTentativa.findOne = () => {
    findCalls += 1;
    if (findCalls === 1) return Promise.resolve(null);
    if (findCalls === 2) return { sort: async () => null };
    return Promise.resolve(attempt({ status: "approved", ativa: false }));
  };
  t.after(() => {
    models.AssinaturaTentativa.updateMany = originalUpdateMany;
    models.AssinaturaTentativa.findOneAndUpdate = originalFindOneAndUpdate;
    models.AssinaturaTentativa.findOne = originalFindOne;
  });
  const res = response();
  await pagamento.cancelarTentativaAtiva(request(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE");
});

test("cancelamento repetido é idempotente", async t => {
  const originalUpdateMany = models.AssinaturaTentativa.updateMany;
  const originalFindOneAndUpdate = models.AssinaturaTentativa.findOneAndUpdate;
  const originalFindOne = models.AssinaturaTentativa.findOne;
  models.AssinaturaTentativa.updateMany = async () => ({ modifiedCount: 0 });
  models.AssinaturaTentativa.findOneAndUpdate = async () => null;
  let findCalls = 0;
  models.AssinaturaTentativa.findOne = () => {
    findCalls += 1;
    if (findCalls === 1) return Promise.resolve(null);
    return { sort: async () => attempt({ status: "cancelled", ativa: false }) };
  };
  t.after(() => {
    models.AssinaturaTentativa.updateMany = originalUpdateMany;
    models.AssinaturaTentativa.findOneAndUpdate = originalFindOneAndUpdate;
    models.AssinaturaTentativa.findOne = originalFindOne;
  });
  const res = response();
  await pagamento.cancelarTentativaAtiva(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.code, "SUBSCRIPTION_ATTEMPT_ALREADY_CANCELLED");
});

test("preapproval remoto é validado e cancelado somente com credencial da plataforma", async () => {
  const stored = attempt({ mercadoPagoPreapprovalId: "pre-1" });
  const calls = [];
  const requester = async (endpoint, options) => {
    calls.push({ endpoint, options });
    if (options.method === "PUT") return { id: "pre-1", status: "canceled" };
    return {
      id: "pre-1",
      status: "authorized",
      payer_id: "payer-1",
      collector_id: "platform-1",
      external_reference: `assinatura-tentativa:${stored.attemptId}:estabelecimento:${STORE_A}`,
    };
  };
  const previous = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
  process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
  try {
    const result = await pagamento._testing.cancelarPreapprovalRemoto(stored, "cancel-key", requester);
    assert.equal(result.status, "canceled");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, "PUT");
    assert.deepEqual(calls[1].options.body, { status: "canceled" });
    assert.equal(calls[1].options.idempotencyKey, "cancel-key");
  } finally {
    if (previous === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previous;
  }
});

test("preapproval pending sem pagador é abandonado localmente sem PUT", async () => {
  const stored = attempt({ mercadoPagoPreapprovalId: "pre-1" });
  const calls = [];
  const previous = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
  process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
  try {
    const result = await pagamento._testing.cancelarPreapprovalRemoto(stored, "cancel-key", async (endpoint, options) => {
      calls.push({ endpoint, options });
      return {
        id: "pre-1",
        status: "pending",
        collector_id: "platform-1",
        external_reference: `assinatura-tentativa:${stored.attemptId}:estabelecimento:${STORE_A}`,
      };
    });
    assert.deepEqual(result, { action: "abandon", status: "not_applicable" });
    assert.equal(calls.length, 1);
    assert.equal(calls.some(call => call.options.method === "PUT"), false);
  } finally {
    if (previous === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previous;
  }
});

test("preapproval pending com pagador também é checkout abandonável sem PUT", async () => {
  const stored = attempt({ mercadoPagoPreapprovalId: "pre-pending-payer" });
  const calls = [];
  const previous = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
  process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
  try {
    const result = await pagamento._testing.cancelarPreapprovalRemoto(stored, "cancel-key", async (endpoint, options) => {
      calls.push({ endpoint, options });
      return {
        id: "pre-pending-payer",
        status: "pending",
        payer_id: "payer-optional",
        collector_id: "platform-1",
        external_reference: `assinatura-tentativa:${stored.attemptId}:estabelecimento:${STORE_A}`,
      };
    });
    assert.deepEqual(result, { action: "abandon", status: "not_applicable" });
    assert.equal(calls.length, 1);
    assert.equal(calls.some(call => call.options.method === "PUT"), false);
    assert.equal(pagamento._testing.classifyRemotePreapproval({ status: "pending", payer_id: "payer" }).classification, "checkout_pending");
  } finally {
    if (previous === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previous;
  }
});

test("authorized e paused não dependem de payer_id para permitir canceled", () => {
  for (const status of ["authorized", "paused"]) {
    const classification = pagamento._testing.classifyRemotePreapproval({ status });
    assert.equal(classification.classification, "remote_subscription");
    assert.equal(classification.canRequestRemoteCancellation, true);
    assert.equal(classification.requiresReconciliation, false);
  }
});

test("status nulo ou desconhecido exige reconciliação com GET 200 registrado", async () => {
  for (const status of [null, "future_status"]) {
    const stored = attempt({ mercadoPagoPreapprovalId: "pre-secret-12345678" });
    const previous = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    const originalInfo = console.info;
    const logs = [];
    process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
    console.info = (name, data) => logs.push({ name, data });
    try {
      await assert.rejects(pagamento._testing.cancelarPreapprovalRemoto(stored, "cancel-key", async () => ({
        id: "pre-secret-12345678",
        status,
        payer_id: "payer-secret",
        payer_email: "pessoa@example.com",
        collector_id: "platform-1",
        external_reference: `assinatura-tentativa:${stored.attemptId}:estabelecimento:${STORE_A}`,
        init_point: "https://example.invalid/secret",
        auto_recurring: { currency_id: "BRL", frequency: 1, frequency_type: "months" },
      })), error => {
        assert.equal(error.code, "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION");
        assert.equal(error.responseReceived, true);
        assert.equal(error.httpStatus, 200);
        assert.equal(error.remoteStatus, status || "");
        assert.equal(error.classificationReason, "remote_status_not_supported");
        return true;
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].name, "mercado_pago_preapproval_inspection");
      assert.equal(logs[0].data.preapprovalIdSuffix, "12345678");
      assert.equal(logs[0].data.remoteStatus, status || null);
      assert.equal(logs[0].data.payerIdPresent, true);
      assert.equal(logs[0].data.payerEmailPresent, true);
      const serialized = JSON.stringify(logs[0]);
      assert.equal(serialized.includes("pre-secret-12345678"), false);
      assert.equal(serialized.includes("payer-secret"), false);
      assert.equal(serialized.includes("pessoa@example.com"), false);
      assert.equal(serialized.includes("https://example.invalid/secret"), false);
    } finally {
      console.info = originalInfo;
      if (previous === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
      else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previous;
    }
  }
});

test("erro de classificação registra GET 200 e libera claim para nova tentativa", () => {
  const error = Object.assign(new Error("Não foi possível confirmar o estado da tentativa."), {
    code: "SUBSCRIPTION_ATTEMPT_REQUIRES_RECONCILIATION",
    stage: "preapproval_cancel_classification",
    responseReceived: true,
    httpStatus: 200,
    remoteStatus: "future_status",
    classificationReason: "remote_status_not_supported",
  });
  const logged = platformErrorLog(error, { correlationId: "corr-safe" });
  assert.equal(logged.responseReceived, true);
  assert.equal(logged.httpStatus, 200);
  assert.equal(logged.remoteStatus, "future_status");
  assert.equal(logged.classificationReason, "remote_status_not_supported");

  const update = pagamento._testing.reconciliationAttemptUpdate(error, new Date("2026-08-01T00:00:00Z"));
  assert.equal(update.$set.cancelRequestedAt, null);
  assert.equal(update.$set.cancelRequestId, "");
  assert.equal(update.$set.lastRemoteStatus, "future_status");
  assert.equal(update.$inc.reconciliationAttempts, 1);
  assert.ok(CANCELLABLE_ATTEMPT_STATUSES.includes("reconciliation_required"));
});

test("preapproval remoto já canceled é idempotente e não envia PUT", async () => {
  const stored = attempt({ mercadoPagoPreapprovalId: "pre-1" });
  let calls = 0;
  const previous = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
  process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
  try {
    const result = await pagamento._testing.cancelarPreapprovalRemoto(stored, "cancel-key", async () => {
      calls += 1;
      return {
        id: "pre-1",
        status: "canceled",
        collector_id: "platform-1",
        external_reference: `assinatura-tentativa:${stored.attemptId}:estabelecimento:${STORE_A}`,
      };
    });
    assert.equal(result.status, "canceled");
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previous;
  }
});

test("400 ao cancelar reconcilia por GET, preserva diagnóstico e nunca tenta cancelled", async () => {
  const stored = attempt({ mercadoPagoPreapprovalId: "pre-1" });
  const calls = [];
  const previous = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
  process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
  const remote = {
    id: "pre-1",
    status: "authorized",
    payer_id: "payer-1",
    collector_id: "platform-1",
    external_reference: `assinatura-tentativa:${stored.attemptId}:estabelecimento:${STORE_A}`,
  };
  try {
    await assert.rejects(pagamento._testing.cancelarPreapprovalRemoto(stored, "cancel-key", async (endpoint, options) => {
      calls.push({ endpoint, options });
      if (options.method === "PUT") {
        const error = new Error("Invalid preapproval status param: canceled");
        error.httpStatus = 400;
        error.providerResponse = {
          providerCode: "bad_request",
          providerMessage: "Invalid preapproval status param: canceled",
        };
        throw error;
      }
      return remote;
    }), error => {
      assert.equal(error.code, "SUBSCRIPTION_REMOTE_CANCEL_REJECTED");
      assert.equal(error.httpStatus, 400);
      assert.equal(error.providerResponse.providerMessage, "Invalid preapproval status param: canceled");
      return true;
    });
    assert.equal(calls.length, 3);
    const puts = calls.filter(call => call.options.method === "PUT");
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].options.body, { status: "canceled" });
    assert.equal(JSON.stringify(calls).includes('"cancelled"'), false);
  } finally {
    if (previous === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previous;
  }
});

test("falha ou identidade remota divergente não confirma cancelamento", async () => {
  const stored = attempt({ mercadoPagoPreapprovalId: "pre-1" });
  const previous = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
  process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
  try {
    await assert.rejects(pagamento._testing.cancelarPreapprovalRemoto(
      stored,
      "cancel-key",
      async () => ({ id: "pre-1", status: "pending", collector_id: "outra-conta", external_reference: "outra" }),
    ), { code: "SUBSCRIPTION_ATTEMPT_NOT_CANCELLABLE" });
  } finally {
    if (previous === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previous;
  }
});

test("webhook aprovado durante cancelamento não ativa e exige conciliação", async t => {
  const originalAttempt = models.AssinaturaTentativa.findOne;
  const originalSubscription = models.Assinatura.findOne;
  const previousCollector = process.env.MERCADO_PAGO_PLATFORM_USER_ID;
  process.env.MERCADO_PAGO_PLATFORM_USER_ID = "platform-1";
  const storedAttempt = attempt({
    mercadoPagoPreapprovalId: "pre-1",
    cancelRequestedAt: new Date(),
    async save() {},
  });
  const subscription = {
    _id: SUBSCRIPTION,
    estabelecimentoId: STORE_A,
    status: "pendente",
    historicoFinanceiro: [],
    async save() {},
  };
  models.AssinaturaTentativa.findOne = async () => storedAttempt;
  models.Assinatura.findOne = async () => subscription;
  t.after(() => {
    models.AssinaturaTentativa.findOne = originalAttempt;
    models.Assinatura.findOne = originalSubscription;
    if (previousCollector === undefined) delete process.env.MERCADO_PAGO_PLATFORM_USER_ID;
    else process.env.MERCADO_PAGO_PLATFORM_USER_ID = previousCollector;
  });
  await pagamento._testing.processSubscriptionPayment({}, {
    id: "pay-1",
    status: "approved",
    transaction_amount: 39.9,
    currency_id: "BRL",
    collector_id: "platform-1",
    preapproval_id: "pre-1",
    external_reference: `assinatura-tentativa:${storedAttempt.attemptId}:estabelecimento:${STORE_A}`,
  });
  assert.equal(subscription.status, "pendente");
  assert.equal(storedAttempt.status, "reconciliation_required");
  assert.equal(storedAttempt.ativa, false);
  assert.equal(subscription.historicoFinanceiro.length, 1);
  assert.equal(subscription.historicoFinanceiro[0].status, "reconciliation_required:approved");
});

test("tentativa vencida é expirada no servidor antes de bloquear", async t => {
  const original = models.AssinaturaTentativa.updateMany;
  let filter;
  let update;
  models.AssinaturaTentativa.updateMany = async (value, change) => { filter = value; update = change; };
  t.after(() => { models.AssinaturaTentativa.updateMany = original; });
  const now = new Date();
  await pagamento._testing.expirarTentativasVencidas(STORE_A, now);
  assert.equal(String(filter.estabelecimentoId), STORE_A);
  assert.equal(filter.ativa, true);
  assert.equal(filter.expiresAt.$lte, now);
  assert.equal(update.$set.status, "expired");
  assert.equal(update.$set.ativa, false);
});

test("Pix e cartão podem criar nova tentativa com idempotencyKey nova após cancelamento", async t => {
  const originalUpdateMany = models.AssinaturaTentativa.updateMany;
  const originalFindOne = models.AssinaturaTentativa.findOne;
  const originalCreate = models.AssinaturaTentativa.create;
  models.AssinaturaTentativa.updateMany = async () => ({ modifiedCount: 0 });
  models.AssinaturaTentativa.findOne = async () => null;
  const created = [];
  models.AssinaturaTentativa.create = async value => { created.push(value); return value; };
  t.after(() => {
    models.AssinaturaTentativa.updateMany = originalUpdateMany;
    models.AssinaturaTentativa.findOne = originalFindOne;
    models.AssinaturaTentativa.create = originalCreate;
  });
  for (const metodo of ["pix", "cartao"]) {
    await pagamento._testing.obterOuCriarTentativa({
      _id: SUBSCRIPTION,
      estabelecimentoId: STORE_A,
      status: "teste",
    }, metodo);
  }
  assert.equal(created.length, 2);
  assert.match(created[0].idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.match(created[1].idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.notEqual(created[0].idempotencyKey, created[1].idempotencyKey);
  assert.notEqual(created[0].idempotencyKey, "chave-da-tentativa-cancelada");
});
