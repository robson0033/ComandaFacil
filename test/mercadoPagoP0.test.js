"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");
const {
  parseSignature,
  sanitizeMercadoPagoError,
  validateMercadoPagoWebhook,
} = require("../src/middleware/mercadoPagoSecurity");
const {
  createCsrfSameOriginProtection,
  csrfProtection,
  ensureCsrfToken,
} = require("../src/middleware/csrf");
const { createRateLimiter } = require("../src/middleware/rateLimit");
const {
  paidPeriod,
  subscriptionStatusForFinancialStatus,
  validateApprovedPayment,
  validatePaymentIdentity,
} = require("../src/services/mercadoPagoService");
const models = require("../src/models/painelModels");
const pagamento = require("../src/controllers/pagamentoController");
const login = require("../src/controllers/loginControllerReal");
const estoqueService = require("../src/services/estoqueService");
const assinaturaMiddleware = require("../src/middleware/assinatura");

function signedWebhook({
  id = "123456",
  requestId = "request-1",
  secret = "test-secret",
  now = Date.now(),
} = {}) {
  const ts = String(Math.floor(now / 1000));
  const manifest = `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  return { id, requestId, secret, now, header: `ts=${ts},v1=${v1}` };
}

test("webhook: assinatura válida", () => {
  const fixture = signedWebhook();
  const result = validateMercadoPagoWebhook({
    signatureHeader: fixture.header,
    requestId: fixture.requestId,
    resourceId: fixture.id,
    secret: fixture.secret,
    now: fixture.now,
  });
  assert.equal(result.resourceId, fixture.id);
});



test("webhook: segredo com espaços externos é normalizado", () => {
  const fixture = signedWebhook();
  const result = validateMercadoPagoWebhook({
    signatureHeader: fixture.header,
    requestId: fixture.requestId,
    resourceId: fixture.id,
    secret: `  ${fixture.secret}  `,
    now: fixture.now,
  });
  assert.equal(result.resourceId, fixture.id);
});

test("webhook: assinatura inválida", () => {
  const fixture = signedWebhook();
  const parsed = parseSignature(fixture.header);
  const invalidSignature = `${parsed.signature[0] === "0" ? "1" : "0"}${parsed.signature.slice(1)}`;
  assert.throws(() => validateMercadoPagoWebhook({
    signatureHeader: `ts=${parsed.timestamp},v1=${invalidSignature}`,
    requestId: fixture.requestId,
    resourceId: fixture.id,
    secret: fixture.secret,
    now: fixture.now,
  }), /inválida/);
});

test("webhook: cabeçalhos ausentes", () => {
  assert.throws(() => validateMercadoPagoWebhook({
    resourceId: "123",
    secret: "secret",
  }), { code: "WEBHOOK_SIGNATURE_MISSING" });
});

test("webhook: timestamp expirado", () => {
  const fixture = signedWebhook({ now: Date.now() - 600_000 });
  assert.throws(() => validateMercadoPagoWebhook({
    signatureHeader: fixture.header,
    requestId: fixture.requestId,
    resourceId: fixture.id,
    secret: fixture.secret,
    now: Date.now(),
  }), /expirado/);
});

test("webhook: payload malformado é rejeitado", () => {
  const fixture = signedWebhook({ id: "123" });
  assert.throws(() => validateMercadoPagoWebhook({
    signatureHeader: fixture.header,
    requestId: fixture.requestId,
    resourceId: "https://malicioso.test",
    secret: fixture.secret,
    now: fixture.now,
  }), /inválido/);
});

test("webhook: parser aceita ts e v1 sem confiar na ordem", () => {
  assert.deepEqual(parseSignature("v1=abc,ts=1234567890"), {
    timestamp: "1234567890",
    signature: "abc",
  });
});

test("webhook: erro sanitizado preserva diagnóstico estruturado", () => {
  const result = sanitizeMercadoPagoError(
    Object.assign(new Error("Assinatura do webhook inválida."), {
      status: 401,
      code: "WEBHOOK_SIGNATURE_INVALID",
      stage: "webhook_signature_validate",
    }),
  );
  assert.equal(result.message, "Assinatura do webhook inválida.");
  assert.equal(result.status, 401);
  assert.equal(result.code, "WEBHOOK_SIGNATURE_INVALID");
  assert.equal(result.stage, "webhook_signature_validate");
});

test("webhook: diagnóstico remove token, secret e dados pessoais", () => {
  const previousToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const previousSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = "APP_USR_TOKEN_SUPER_SECRETO";
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = "WEBHOOK_SECRET_SUPER_SECRETO";
  try {
    const result = sanitizeMercadoPagoError(Object.assign(
      new Error("Bearer APP_USR_TOKEN_SUPER_SECRETO pessoa@example.com WEBHOOK_SECRET_SUPER_SECRETO"),
      { providerResponse: { providerMessage: "pessoa@example.com" } },
    ));
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /APP_USR_TOKEN_SUPER_SECRETO|WEBHOOK_SECRET_SUPER_SECRETO|pessoa@example\.com/);
  } finally {
    if (previousToken === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    else process.env.MERCADO_PAGO_ACCESS_TOKEN = previousToken;
    if (previousSecret === undefined) delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    else process.env.MERCADO_PAGO_WEBHOOK_SECRET = previousSecret;
  }
});

test("webhook: secret, assinatura e request ID ausentes têm códigos específicos", () => {
  assert.throws(() => validateMercadoPagoWebhook({ resourceId: "123" }), {
    code: "WEBHOOK_SECRET_MISSING",
    httpStatus: 503,
  });
  assert.throws(() => validateMercadoPagoWebhook({ resourceId: "123", secret: "secret" }), {
    code: "WEBHOOK_SIGNATURE_MISSING",
    httpStatus: 401,
  });
  assert.throws(() => validateMercadoPagoWebhook({
    resourceId: "123",
    secret: "secret",
    signatureHeader: "ts=123,v1=abc",
  }), { code: "WEBHOOK_REQUEST_ID_MISSING" });
});

test("webhook: extrai IDs de body, query e aliases topic/id", () => {
  const fixtures = [
    { body: { type: "payment", data: { id: "pay-body" } }, query: {} },
    { body: { type: "payment" }, query: { "data.id": "pay-query" } },
    { body: { topic: "payment", id: "pay-flat" }, query: {} },
    { body: {}, query: { topic: "preapproval", id: "pre-query" } },
  ];
  assert.deepEqual(fixtures.map(value => pagamento._testing.extractMercadoPagoWebhookEvent(value)), [
    { resourceId: "pay-body", eventType: "payment", eventAction: "payment", resourceType: "payment", action: "payment" },
    { resourceId: "pay-query", eventType: "payment", eventAction: "payment", resourceType: "payment", action: "payment" },
    { resourceId: "pay-flat", eventType: "payment", eventAction: "payment", resourceType: "payment", action: "payment" },
    { resourceId: "pre-query", eventType: "subscription_preapproval", eventAction: "subscription_preapproval", resourceType: "subscription_preapproval", action: "subscription_preapproval" },
  ]);
});

test("webhook: body.id do evento não é comparado com data.id do pagamento", () => {
  const event = pagamento._testing.extractMercadoPagoWebhookEvent({
    body: {
      id: "notification-event-987654",
      type: "payment",
      action: "payment.updated",
      data: { id: "123456789" },
    },
    query: { "data.id": "123456789", type: "payment" },
  });
  assert.equal(event.resourceId, "123456789");
  assert.equal(event.eventAction, "payment.updated");
});

test("webhook: data.id realmente divergente continua bloqueado", () => {
  assert.throws(() => pagamento._testing.extractMercadoPagoWebhookEvent({
    body: { type: "payment", data: { id: "111" } },
    query: { "data.id": "222", type: "payment" },
  }), { code: "WEBHOOK_RESOURCE_ID_DIVERGENT" });
});

test("webhook: ID ausente retorna erro controlado, não INTERNAL_ERROR", async () => {
  const previousSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = "test-secret";
  const req = {
    body: { type: "payment" },
    query: {},
    method: "POST",
    path: "/webhook/mercado-pago",
    correlationId: "corr-webhook",
    get() { return undefined; },
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await pagamento.webhook(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, "WEBHOOK_RESOURCE_ID_MISSING");
    assert.notEqual(res.payload.code, "INTERNAL_ERROR");
  } finally {
    console.warn = originalWarn;
    if (previousSecret === undefined) delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    else process.env.MERCADO_PAGO_WEBHOOK_SECRET = previousSecret;
  }
});

test("webhook: diagnóstico preserva causa sem IDs ou assinatura completos", () => {
  const error = Object.assign(new Error("Pagamento não encontrado."), {
    code: "not_found",
    stage: "webhook_resource_lookup",
    httpStatus: 404,
    responseReceived: true,
    providerResponse: { providerCode: "not_found", providerMessage: "Payment not found", providerCauses: [] },
  });
  const req = {
    method: "POST",
    path: "/webhook/mercado-pago",
    correlationId: "corr-safe",
    get(name) { return name === "x-signature" ? "secret-signature" : "request-full"; },
  };
  const log = pagamento._testing.webhookDiagnostic(error, req, {
    resourceId: "payment-full-secret-12345678",
    eventType: "payment",
    eventAction: "payment.updated",
  }, { signatureValid: true, responseStatus: 503 });
  assert.equal(log.httpStatus, 404);
  assert.equal(log.providerMessage, "Payment not found");
  assert.equal(log.stage, "webhook_resource_lookup");
  assert.equal(log.resourceIdSuffix, "12345678");
  assert.equal(log.responseStatus, 503);
  assert.doesNotMatch(JSON.stringify(log), /secret-signature|request-full|payment-full-secret/);
});

test("webhook: rota é pública e não usa login, sessão, CSRF ou Origin", () => {
  const source = fs.readFileSync("route.js", "utf8");
  const match = source.match(/route\.post\(\s*'\/webhook\/mercado-pago',[\s\S]*?\);/);
  assert.ok(match);
  assert.match(match[0], /limiteWebhook,[\s\S]*pagamento\.webhook/);
  assert.doesNotMatch(match[0], /loginRequired|csrf|sess|origin|carregarAssinatura/iu);
});

test("webhook: controller responde somente JSON, sem flash ou redirect", () => {
  const source = fs.readFileSync("src/controllers/pagamentoController.js", "utf8");
  const start = source.indexOf("exports.webhook =");
  const end = source.indexOf("exports.assinaturaDoUsuario", start);
  const handler = source.slice(start, end);
  assert.doesNotMatch(handler, /req\.flash|res\.redirect/);
  assert.match(handler, /WEBHOOK_ACCEPTED/);
  assert.match(handler, /WEBHOOK_ALREADY_PROCESSED/);
});

test("webhook: replay conhecido produz a mesma eventKey", () => {
  const input = {
    requestId: "request-replay",
    resourceType: "payment",
    resourceId: "123",
    action: "payment.updated",
  };
  assert.equal(
    pagamento._testing.webhookEventKey(input),
    pagamento._testing.webhookEventKey(input),
  );
});

test("webhook: retries com request IDs distintos compartilham eventKey", () => {
  const base = {
    resourceType: "payment",
    resourceId: "123",
    action: "payment.updated",
  };
  assert.equal(
    pagamento._testing.webhookEventKey({ ...base, requestId: "request-1" }),
    pagamento._testing.webhookEventKey({ ...base, requestId: "request-2" }),
  );
});

test("webhook: evento duplicado simultâneo obtém um único processamento", async () => {
  const original = models.PaymentEvent.findOneAndUpdate;
  let available = true;
  models.PaymentEvent.findOneAndUpdate = async () => {
    if (!available) return null;
    available = false;
    return { _id: "event-1", status: "processando", tentativas: 1 };
  };
  try {
    const event = { _id: "event-1" };
    const [first, second] = await Promise.all([
      pagamento._testing.claimEvent(event),
      pagamento._testing.claimEvent(event),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
  } finally {
    models.PaymentEvent.findOneAndUpdate = original;
  }
});

test("webhook: evento falho permanece elegível para retry", async () => {
  const original = models.PaymentEvent.findOneAndUpdate;
  let receivedFilter;
  models.PaymentEvent.findOneAndUpdate = async filter => {
    receivedFilter = filter;
    return { _id: "event-retry", status: "processando", tentativas: 2 };
  };
  try {
    const result = await pagamento._testing.claimEvent({ _id: "event-retry" });
    assert.equal(result.tentativas, 2);
    assert.deepEqual(receivedFilter.$or[0].status.$in, ["recebido", "falhou"]);
  } finally {
    models.PaymentEvent.findOneAndUpdate = original;
  }
});

const approvedPayment = {
  id: "pay-1",
  status: "approved",
  transaction_amount: 39.9,
  currency_id: "BRL",
  external_reference: "assinatura:abc:estabelecimento:def",
  collector_id: "platform-1",
};
const expectedPayment = {
  paymentId: "pay-1",
  amount: 39.9,
  externalReference: "assinatura:abc:estabelecimento:def",
  collectorId: "platform-1",
};

test("assinatura: cobrança aprovada válida", () => {
  assert.equal(validateApprovedPayment(approvedPayment, expectedPayment), true);
});

test("assinatura: valor divergente bloqueia", () => {
  assert.throws(() => validateApprovedPayment(
    { ...approvedPayment, transaction_amount: 1 },
    expectedPayment,
  ), /Valor/);
});

test("assinatura: moeda diferente de BRL bloqueia", () => {
  assert.throws(() => validateApprovedPayment(
    { ...approvedPayment, currency_id: "USD" },
    expectedPayment,
  ), /Moeda/);
});

test("assinatura: paymentId antigo bloqueia", () => {
  assert.throws(() => validateApprovedPayment(
    { ...approvedPayment, id: "pay-old" },
    expectedPayment,
  ), /tentativa vigente/);
});

test("assinatura: conta recebedora divergente bloqueia", () => {
  assert.throws(() => validateApprovedPayment(
    { ...approvedPayment, collector_id: "other" },
    expectedPayment,
  ), /recebedora/);
});

test("assinatura: referência externa divergente bloqueia", () => {
  assert.throws(() => validateApprovedPayment(
    { ...approvedPayment, external_reference: "outra" },
    expectedPayment,
  ), /Referência/);
});

test("assinatura: preapproval antigo bloqueia cobrança recorrente", () => {
  assert.throws(() => validateApprovedPayment(
    { ...approvedPayment, preapproval_id: "pre-old" },
    { ...expectedPayment, preapprovalId: "pre-current" },
  ), /assinatura vigente/);
});

test("assinatura: authorized não ativa assinatura", () => {
  assert.equal(subscriptionStatusForFinancialStatus("authorized", "teste"), "teste");
  assert.equal(subscriptionStatusForFinancialStatus("authorized", "pendente"), "pendente");
});

test("assinatura: handler de preapproval authorized preserva estado local", async () => {
  const original = models.Assinatura.findOne;
  const document = {
    _id: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f191e810c19729de860ea",
    mercadoPagoPreapprovalId: "pre-1",
    status: "pendente",
    async save() {},
  };
  models.Assinatura.findOne = async () => document;
  try {
    await pagamento._testing.processPreapproval({}, {
      id: "pre-1",
      status: "authorized",
      external_reference:
        "assinatura:507f1f77bcf86cd799439011:estabelecimento:507f191e810c19729de860ea",
      next_payment_date: "2026-09-01T00:00:00Z",
    });
    assert.equal(document.status, "pendente");
    assert.equal(document.ultimoStatusMercadoPago, "authorized");
  } finally {
    models.Assinatura.findOne = original;
  }
});

test("assinatura: middleware não libera ativa sem pagamento comprovado", () => {
  assert.equal(assinaturaMiddleware.planoPagoValido({
    status: "ativa",
    planoExpira: new Date(Date.now() + 86_400_000),
    ultimoPagamentoAprovadoId: "",
  }), false);
});

test("assinatura: middleware libera vigência comprovada", () => {
  assert.equal(assinaturaMiddleware.planoPagoValido({
    status: "ativa",
    planoExpira: new Date(Date.now() + 86_400_000),
    ultimoPagamentoAprovadoId: "pay-approved",
  }), true);
});

test("assinatura: renovação aprovada estende vigência futura", () => {
  const current = new Date("2026-08-10T00:00:00Z");
  const period = paidPeriod(current, new Date("2026-08-01T00:00:00Z"));
  assert.equal(period.startsAt.toISOString(), current.toISOString());
  assert.equal(period.expiresAt.toISOString(), "2026-09-09T00:00:00.000Z");
});

test("assinatura: renovação atrasada não vira ativa", () => {
  assert.equal(subscriptionStatusForFinancialStatus("rejected", "ativa"), "atrasada");
});

test("assinatura: reembolso e chargeback viram reembolsada", () => {
  assert.equal(subscriptionStatusForFinancialStatus("refunded", "ativa"), "reembolsada");
  assert.equal(subscriptionStatusForFinancialStatus("charged_back", "ativa"), "reembolsada");
});

test("Pix pedido: pagamento aprovado correto", () => {
  assert.equal(validateApprovedPayment({
    id: "pedido-pay",
    status: "approved",
    transaction_amount: 52.25,
    currency_id: "BRL",
    external_reference: "pedido:507f1f77bcf86cd799439011",
    collector_id: "store-1",
  }, {
    paymentId: "pedido-pay",
    amount: 52.25,
    externalReference: "pedido:507f1f77bcf86cd799439011",
    collectorId: "store-1",
  }), true);
});

test("Pix pedido: status não aprovado não passa validação de aprovação", () => {
  assert.throws(() => validateApprovedPayment(
    { ...approvedPayment, status: "pending" },
    expectedPayment,
  ), /não foi aprovado/);
});

test("Pix pedido: identidade financeira pode validar cancelamento", () => {
  assert.equal(validatePaymentIdentity(
    { ...approvedPayment, status: "refunded" },
    expectedPayment,
  ), true);
});

test("Pix pedido: conta de outra loja é bloqueada", () => {
  assert.throws(() => validatePaymentIdentity(
    { ...approvedPayment, collector_id: "store-b" },
    { ...expectedPayment, collectorId: "store-a" },
  ), /recebedora/);
});

test("Pix pedido: paymentId antigo é bloqueado", () => {
  assert.throws(() => validatePaymentIdentity(
    { ...approvedPayment, id: "old-payment" },
    expectedPayment,
  ), /tentativa vigente/);
});

function oauthRequest({ state, stored, storeId = "507f1f77bcf86cd799439011" }) {
  return {
    sessionID: "session-test",
    query: { state },
    session: {
      user: { id: storeId, estabelecimentoId: storeId },
      mpOauthState: stored,
      mpOauthCodeVerifier: "verifier-pkce-valido",
      save(callback) { callback(); },
    },
  };
}

async function consumeOauthWithMock(req, result = { _id: "oauth-state" }) {
  const original = models.OAuthState.findOneAndUpdate;
  models.OAuthState.findOneAndUpdate = async () => result;
  try {
    return await pagamento._testing.consumeOauthState(req);
  } finally {
    models.OAuthState.findOneAndUpdate = original;
  }
}

function oauthStored(state, storeId = "507f1f77bcf86cd799439011", createdAt = Date.now()) {
  return {
    valueHash: crypto.createHash("sha256").update(state).digest("hex"),
    estabelecimentoId: storeId,
    createdAt,
  };
}

test("OAuth: state válido é aceito e consumido", async () => {
  const state = "state-valido";
  const req = oauthRequest({ state, stored: oauthStored(state) });
  await consumeOauthWithMock(req);
  assert.equal(req.session.mpOauthStateHash, undefined);
});

test("OAuth: state ausente é rejeitado", async () => {
  const req = oauthRequest({ state: "", stored: oauthStored("outro") });
  await assert.rejects(pagamento._testing.consumeOauthState(req), /inválido/);
});

test("OAuth: state inválido é rejeitado", async () => {
  const req = oauthRequest({ state: "errado", stored: oauthStored("correto") });
  await assert.rejects(consumeOauthWithMock(req, null), /inválido/);
});

test("OAuth: state expirado é rejeitado", async () => {
  const state = "expirado";
  const req = oauthRequest({
    state,
    stored: oauthStored(state, undefined, Date.now() - 11 * 60_000),
  });
  await assert.rejects(consumeOauthWithMock(req, null), /expirado/);
});

test("OAuth: state é de uso único inclusive após falha", async () => {
  const state = "uso-unico";
  const req = oauthRequest({ state, stored: oauthStored(state) });
  let available = true;
  const original = models.OAuthState.findOneAndUpdate;
  models.OAuthState.findOneAndUpdate = async () => {
    if (!available) return null;
    available = false;
    return { _id: "oauth-state" };
  };
  try {
    await pagamento._testing.consumeOauthState(req);
    await assert.rejects(pagamento._testing.consumeOauthState(req), /inválido/);
  } finally {
    models.OAuthState.findOneAndUpdate = original;
  }
});

test("OAuth: state de outro estabelecimento é rejeitado", async () => {
  const state = "outra-loja";
  const req = oauthRequest({
    state,
    stored: oauthStored(state, "507f191e810c19729de860ea"),
  });
  await assert.rejects(consumeOauthWithMock(req, null), /inválido/);
});

test("OAuth: falha posterior não restaura state consumido", async () => {
  const state = "consumido-antes-do-fetch";
  const req = oauthRequest({ state, stored: oauthStored(state) });
  await consumeOauthWithMock(req);
  assert.equal(req.session.mpOauthStateHash, undefined);
});

test("CSRF: token é criado e aceito", () => {
  const req = {
    session: { user: { id: "user", tipo: "proprietario" } },
    body: {},
  };
  const res = { locals: {} };
  ensureCsrfToken(req, res, () => {});
  req.body._csrf = req.session.csrfToken;
  let passed = false;
  csrfProtection(req, { status() { throw new Error("não deveria rejeitar"); } }, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test("CSRF: token inválido é bloqueado", () => {
  const req = {
    session: {
      csrfToken: "correto",
      user: { id: "user", tipo: "proprietario" },
    },
    body: { _csrf: "errado" },
    get: () => "",
  };
  const res = {
    statusCode: 0,
    status(code) { this.statusCode = code; return this; },
    send() { return this; },
  };
  csrfProtection(req, res, () => assert.fail("não deve avançar"));
  assert.equal(res.statusCode, 403);
});

test("CSRF: POST administrativo de mesma origem é aceito", () => {
  const csrfSameOriginProtection = createCsrfSameOriginProtection({
    env: { APP_URL: "https://app.example.com" },
    logger: { warn() {} },
  });
  const req = {
    method: "POST",
    protocol: "https",
    session: {
      csrfToken: "token-correto",
      user: { id: "user", tipo: "proprietario" },
    },
    body: { _csrf: "token-correto" },
    get(name) {
      return {
        origin: "https://app.example.com",
        host: "app.example.com",
      }[name.toLowerCase()] || "";
    },
  };
  let passed = false;
  csrfSameOriginProtection(req, {}, () => { passed = true; });
  assert.equal(passed, true);
});

test("CSRF: POST administrativo de origem externa é bloqueado", () => {
  const csrfSameOriginProtection = createCsrfSameOriginProtection({
    env: { APP_URL: "https://app.example.com" },
    logger: { warn() {} },
  });
  const req = {
    method: "POST",
    protocol: "https",
    session: {
      csrfToken: "token",
      user: { id: "user", tipo: "proprietario" },
    },
    body: {},
    get(name) {
      return {
        origin: "https://evil.example",
        host: "app.example.com",
      }[name.toLowerCase()] || "";
    },
  };
  const res = {
    code: 0,
    status(code) { this.code = code; return this; },
    send() { return this; },
  };
  csrfSameOriginProtection(req, res, () => assert.fail("não deve avançar"));
  assert.equal(res.code, 403);
});

test("rate limit: excedente é bloqueado sem dependência externa", () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  const req = { ip: "127.0.0.2" };
  const response = () => ({
    code: 200,
    set() {},
    status(code) { this.code = code; return this; },
    send() { return this; },
  });
  limiter(req, response(), () => {});
  const second = response();
  limiter(req, second, () => assert.fail("não deve avançar"));
  assert.equal(second.code, 429);
});

test("sessão: login regenera sessão e preserva usuário e duração", async () => {
  const req = {
    body: {},
    session: {
      cookie: {},
      regenerate(callback) { callback(); },
      save(callback) { callback(); },
    },
  };
  const result = await new Promise(resolve => {
  const res = {
    clearCookie() {},
    redirect(path) { resolve(path); },
    status() { return this; },
    render() { resolve("erro"); },
    };
    login._testing.autenticarComNovaSessao(
      req,
      res,
      { id: "user-1", tipo: "proprietario" },
      true,
    );
  });
  assert.equal(result, "/admin");
  assert.equal(req.session.user.id, "user-1");
  assert.equal(req.session.cookie.maxAge, 30 * 24 * 60 * 60 * 1000);
});

test("estoque: duas solicitações simultâneas adquirem um único lock", async () => {
  const originals = {
    pedidoFindOneAndUpdate: models.Pedido.findOneAndUpdate,
  };
  let claimed = false;
  const pedido = {
    _id: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f191e810c19729de860ea",
    itens: [{ produtoId: "507f191e810c19729de860eb", quantidade: 2 }],
  };
  models.Pedido.findOneAndUpdate = async (filter, update) => {
    if (claimed) return null;
    claimed = true;
    return { ...pedido, estoqueLockId: update.$set.estoqueLockId };
  };
  try {
    const [primeiro, segundo] = await Promise.all([
      estoqueService._testing.adquirirLock(pedido._id, "baixa"),
      estoqueService._testing.adquirirLock(pedido._id, "baixa"),
    ]);
    assert.equal([primeiro, segundo].filter(item => item.pedido).length, 1);
  } finally {
    models.Pedido.findOneAndUpdate = originals.pedidoFindOneAndUpdate;
  }
});

function indexNamed(model, name) {
  return model.schema.indexes().some(([, options]) => options.name === name);
}

test("índice: uma assinatura por estabelecimento", () => {
  assert.equal(indexNamed(models.Assinatura, "assinatura_estabelecimento_unico"), true);
});

test("índice: uma configuração por estabelecimento", () => {
  assert.equal(indexNamed(models.Configuracao, "configuracao_estabelecimento_unico"), true);
});

test("índice: eventKey único", () => {
  assert.equal(indexNamed(models.PaymentEvent, "payment_event_key_unico"), true);
});

test("índice: paymentId de pedido único parcial", () => {
  assert.equal(indexNamed(models.Pedido, "pedido_payment_id_unico"), true);
});

test("índice: paymentId e preapprovalId da assinatura únicos parciais", () => {
  assert.equal(indexNamed(models.Assinatura, "assinatura_payment_id_unico"), true);
  assert.equal(indexNamed(models.Assinatura, "assinatura_preapproval_id_unico"), true);
});

test("máquina de status: cancelamento e rejeição são explícitos", () => {
  assert.equal(subscriptionStatusForFinancialStatus("cancelled", "ativa"), "cancelada");
  assert.equal(subscriptionStatusForFinancialStatus("rejected", "pendente"), "atrasada");
});
