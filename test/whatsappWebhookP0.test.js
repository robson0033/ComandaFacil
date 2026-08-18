"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const whatsapp = require("../src/controllers/whatsappController");
const { WhatsAppWebhookEvent } = require("../src/models/painelModels");

const APP_SECRET = "app-secret-de-teste-comprido";

function sign(rawBody) {
  return `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
}

test("validação da assinatura Meta usa o corpo bruto exato", () => {
  const raw = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
  assert.equal(whatsapp._testing.verifyMetaSignature({
    rawBody: raw,
    signature: sign(raw),
    appSecret: APP_SECRET,
  }), true);
  assert.equal(whatsapp._testing.verifyMetaSignature({
    rawBody: Buffer.from(`${raw.toString()} `),
    signature: sign(raw),
    appSecret: APP_SECRET,
  }), false);
});

test("resumo de webhook não inclui texto nem telefone completo do cliente", () => {
  const summary = whatsapp._testing.summarizeWebhook({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "1297409796779940" },
          messages: [{ type: "text", from: "559870067117", text: { body: "segredo" } }],
          statuses: [{ status: "delivered", recipient_id: "559870067117" }],
        },
      }],
    }],
  });
  assert.equal(summary.messages, 1);
  assert.deepEqual(summary.messageTypes, ["text"]);
  assert.deepEqual(summary.statusTypes, ["delivered"]);
  assert.deepEqual(summary.phoneNumberIdSuffixes, ["96779940"]);
  assert.equal(JSON.stringify(summary).includes("segredo"), false);
  assert.equal(JSON.stringify(summary).includes("559870067117"), false);
});

test("rota WhatsApp está pública e fora da proteção /admin", () => {
  const route = fs.readFileSync(path.join(__dirname, "../route.js"), "utf8");
  const getIndex = route.indexOf("'/webhook/whatsapp'");
  const adminIndex = route.indexOf("route.use('/admin', csrfSameOriginProtection)");
  assert.ok(getIndex > 0);
  assert.ok(getIndex > adminIndex, "a rota pode vir depois do route.use('/admin') porque o middleware é prefixado apenas em /admin");
  assert.match(route, /whatsapp\.verificarWebhook/);
  assert.match(route, /whatsapp\.receberWebhook/);
});

test("server preserva rawBody apenas no endpoint de WhatsApp", () => {
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(server, /requestPath === "\/webhook\/whatsapp"/);
  assert.match(server, /req\.rawBody = Buffer\.from\(buffer\)/);
});

test("GET de verificação devolve exatamente o hub.challenge quando o token confere", t => {
  const previous = process.env.WHATSAPP_VERIFY_TOKEN;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-teste-123456";
  t.after(() => {
    if (previous === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = previous;
  });

  const headers = {};
  let statusCode = 200;
  let body = null;
  const req = {
    query: {
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-token-teste-123456",
      "hub.challenge": "987654321",
    },
    correlationId: "TEST-WA-VERIFY",
  };
  const res = {
    set(name, value) { headers[name] = value; return this; },
    status(code) { statusCode = code; return this; },
    type() { return this; },
    send(value) { body = value; return this; },
  };

  whatsapp.verificarWebhook(req, res);
  assert.equal(statusCode, 200);
  assert.equal(body, "987654321");
  assert.equal(headers["Cache-Control"], "no-store");
});

test("POST rejeita assinatura inválida e aceita assinatura Meta válida", async t => {
  const previous = process.env.WHATSAPP_APP_SECRET;
  const originalFindOneAndUpdate = WhatsAppWebhookEvent.findOneAndUpdate;
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;

  let persistenceCalls = 0;
  WhatsAppWebhookEvent.findOneAndUpdate = async () => {
    persistenceCalls += 1;
    if (persistenceCalls === 1) {
      return {
        _id: "64b000000000000000000099",
        eventKey: "evento-webhook-teste",
        payload: body,
        status: "pending",
        attempts: 0,
      };
    }
    // O processamento assíncrono pós-ACK não faz parte deste teste de HTTP.
    return null;
  };

  t.after(() => {
    WhatsAppWebhookEvent.findOneAndUpdate = originalFindOneAndUpdate;
    if (previous === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = previous;
  });

  const body = { object: "whatsapp_business_account", entry: [] };
  const rawBody = Buffer.from(JSON.stringify(body));

  const makeRes = () => {
    const state = { statusCode: 200, body: null };
    return {
      state,
      status(code) { state.statusCode = code; return this; },
      json(value) { state.body = value; return this; },
    };
  };

  const invalidRes = makeRes();
  await whatsapp.receberWebhook({
    body,
    rawBody,
    correlationId: "TEST-WA-POST-BAD",
    get: () => "sha256=00",
  }, invalidRes);
  assert.equal(invalidRes.state.statusCode, 401);

  const validRes = makeRes();
  await whatsapp.receberWebhook({
    body,
    rawBody,
    correlationId: "TEST-WA-POST-OK",
    get: () => sign(rawBody),
  }, validRes);
  assert.equal(validRes.state.statusCode, 200);
  assert.deepEqual(validRes.state.body, { ok: true });
  assert.equal(persistenceCalls >= 1, true);
});
