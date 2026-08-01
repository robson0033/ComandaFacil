"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const service = require("../src/services/mercadoPagoPlatformService");
const pagamento = require("../src/controllers/pagamentoController");

const VALID_ENV = {
  APP_URL: "https://comandafacil.example",
  MERCADO_PAGO_ACCESS_TOKEN: "TEST-token-never-log",
  MERCADO_PAGO_PLATFORM_USER_ID: "12345",
  MERCADO_PAGO_WEBHOOK_SECRET: "TEST-secret-never-log",
};

function withEnv(values, run) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(run).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("configuração completa da plataforma é aceita", () => {
  assert.deepEqual(service.validatePlatformPaymentConfig(VALID_ENV), { ok: true, missing: [], codes: [] });
});

for (const [variable, code] of Object.entries({
  MERCADO_PAGO_ACCESS_TOKEN: "PLATFORM_MP_ACCESS_TOKEN_MISSING",
  MERCADO_PAGO_PLATFORM_USER_ID: "PLATFORM_MP_USER_ID_MISSING",
  MERCADO_PAGO_WEBHOOK_SECRET: "PLATFORM_MP_WEBHOOK_SECRET_MISSING",
})) {
  test(`${variable} ausente retorna ${code} e missing definido`, () => {
    const result = service.validatePlatformPaymentConfig({ ...VALID_ENV, [variable]: "" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [variable]);
    assert.deepEqual(result.codes, [code]);
  });
}

test("APP_URL inválida retorna APP_URL_INVALID", () => {
  const result = service.validatePlatformPaymentConfig({ ...VALID_ENV, APP_URL: "http://inseguro.example" });
  assert.deepEqual(result, { ok: false, missing: ["APP_URL"], codes: ["APP_URL_INVALID"] });
});

test("/users/me correto valida e usa cache curto", async () => withEnv(VALID_ENV, async () => {
  service.clearPlatformAccountCache();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 12345 }) });
  try {
    calls += 1; await service.validatePlatformAccount();
    await service.validatePlatformAccount();
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
}));

test("/users/me divergente retorna PLATFORM_ACCOUNT_MISMATCH", async () => withEnv(VALID_ENV, async () => {
  service.clearPlatformAccountCache();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 999 }) });
  try { await assert.rejects(service.validatePlatformAccount({ force: true }), { code: "PLATFORM_ACCOUNT_MISMATCH" }); }
  finally { global.fetch = originalFetch; }
}));

test("/users/me 401 preserva status, código e mensagem do provedor", async () => withEnv(VALID_ENV, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false, status: 401,
    json: async () => ({ error: "unauthorized", message: "invalid access token", cause: [{ code: "bad_token", description: "invalid" }] }),
  });
  try {
    await assert.rejects(service.validatePlatformAccount({ force: true }), error => {
      assert.equal(error.httpStatus, 401);
      assert.equal(error.code, "unauthorized");
      assert.equal(error.providerResponse.providerMessage, "invalid access token");
      assert.equal(error.providerResponse.providerCauses[0].code, "bad_token");
      return true;
    });
  } finally { global.fetch = originalFetch; }
}));

test("falha de rede preserva cause e estágio", async () => withEnv(VALID_ENV, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    await assert.rejects(service.validatePlatformAccount({ force: true }), error => {
      assert.equal(error.code, "PLATFORM_MP_NETWORK_ERROR");
      assert.equal(error.cause.name, "TypeError");
      assert.equal(error.stage, "platform_account_lookup");
      return true;
    });
  } finally { global.fetch = originalFetch; }
}));

test("timeout recebe código específico", async () => withEnv(VALID_ENV, async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  try { await assert.rejects(service.validatePlatformAccount({ force: true, timeoutMs: 5 }), { code: "PLATFORM_MP_TIMEOUT" }); }
  finally { global.fetch = originalFetch; }
}));

test("log seguro contém diagnóstico e não contém credenciais", async () => withEnv(VALID_ENV, () => {
  const error = Object.assign(new Error("provider failed"), {
    code: "bad_request", stage: "pix_payment_create", endpointPath: "/v1/payments",
    providerResponse: { providerCode: "bad_request", providerMessage: "invalid field", providerCauses: [] },
  });
  const serialized = JSON.stringify(service.platformErrorLog(error, { correlationId: "corr-1" }));
  assert.doesNotMatch(serialized, /TEST-token-never-log|TEST-secret-never-log|Authorization/i);
  assert.match(serialized, /pix_payment_create/);
}));

test("builder Pix envia somente campos aceitos e ignora valor e moeda do navegador", () => {
  const payload = pagamento._testing.buildPixPaymentPayload({
    amount: 39.9,
    payerEmail: "cliente@example.com",
    externalReference: "assinatura-tentativa:uuid:estabelecimento:id",
    notificationUrl: "https://comandafacil.example/webhook/mercado-pago",
    transaction_amount: 0.01,
    currency_id: "USD",
    currency: "USD",
    valor: 0.01,
  });
  assert.deepEqual(payload, {
    transaction_amount: 39.9,
    payment_method_id: "pix",
    description: "Plano mensal ComandaFácil",
    external_reference: "assinatura-tentativa:uuid:estabelecimento:id",
    notification_url: "https://comandafacil.example/webhook/mercado-pago",
    payer: { email: "cliente@example.com" },
  });
  assert.equal(typeof payload.transaction_amount, "number");
  assert.equal(payload.currency_id, undefined);
  assert.equal(new URL(payload.notification_url).protocol, "https:");
});

test("builder preapproval preserva contrato recorrente e currency_id dentro de auto_recurring", () => {
  const payload = pagamento._testing.buildPreapprovalPayload({
    amount: 39.9,
    payerEmail: "cliente@example.com",
    externalReference: "assinatura:uuid",
    backUrl: "https://comandafacil.example/assinatura/retorno",
  });
  assert.equal(payload.auto_recurring.transaction_amount, 39.9);
  assert.equal(payload.auto_recurring.currency_id, "BRL");
  assert.equal(payload.payer_email, "cliente@example.com");
});

test("resposta Pix com QR, ticket e expiração é aceita", () => {
  const parsed = pagamento._testing.parseSubscriptionPixResponse({
    id: 123,
    status: "pending",
    point_of_interaction: { transaction_data: {
      qr_code: "000201",
      qr_code_base64: "base64",
      ticket_url: "https://www.mercadopago.com.br/ticket",
      expiration_date: "2026-08-02T12:00:00Z",
    } },
  });
  assert.equal(parsed.paymentId, "123");
  assert.equal(parsed.status, "pending");
  assert.equal(parsed.qrCode, "000201");
  assert.equal(parsed.ticketUrl, "https://www.mercadopago.com.br/ticket");
  assert.equal(parsed.expiresAt, "2026-08-02T12:00:00Z");
});

test("resposta Pix sem QR retorna SUBSCRIPTION_PIX_QR_MISSING", () => {
  assert.throws(() => pagamento._testing.parseSubscriptionPixResponse({
    id: 123,
    status: "pending",
    point_of_interaction: { transaction_data: {} },
  }), { code: "SUBSCRIPTION_PIX_QR_MISSING" });
});

test("requisição Pix envia idempotência e erro 400 preserva diagnóstico do provedor", async () => withEnv(VALID_ENV, async () => {
  const originalFetch = global.fetch;
  let receivedHeaders;
  global.fetch = async (_url, options) => {
    receivedHeaders = options.headers;
    return {
      ok: false,
      status: 400,
      json: async () => ({
        code: "bad_request",
        message: "The name of the following parameters is wrong : currency_id",
        cause: [{ code: 8, description: "invalid parameter" }],
      }),
    };
  };
  try {
    await assert.rejects(service.requestPlatform("/v1/payments", {
      method: "POST",
      operation: "create_subscription_pix",
      stage: "pix_payment_create",
      idempotencyKey: "idempotency-key-test",
      body: { transaction_amount: 39.9, payment_method_id: "pix" },
    }), error => {
      assert.equal(error.httpStatus, 400);
      assert.equal(error.code, "bad_request");
      assert.equal(error.providerResponse.providerMessage, "The name of the following parameters is wrong : currency_id");
      assert.equal(error.providerResponse.providerCauses[0].code, "8");
      return true;
    });
    assert.equal(receivedHeaders["X-Idempotency-Key"], "idempotency-key-test");
  } finally { global.fetch = originalFetch; }
}));

test("view usa botões sem submit nativo, bloqueio e contratos JSON", () => {
  const view = fs.readFileSync(path.join(__dirname, "../src/views/assinatura.ejs"), "utf8");
  assert.equal((view.match(/data-payment-button/g) || []).length >= 2, true);
  assert.doesNotMatch(view, /data-payment-button[^>]*type="submit"/);
  assert.match(view, /form\.dataset\.submitting === 'true'/);
  assert.match(view, /button\.textContent = 'Processando\.\.\.'/);
  assert.doesNotMatch(view, /location\.assign\('\/assinatura'\)/);
});
