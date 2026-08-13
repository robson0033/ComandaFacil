"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const automation = require("../src/services/whatsappAutomationService");
const cloud = require("../src/services/whatsappCloudApiService");

test("extrai texto e seleção interativa do webhook sem depender do número exibido", () => {
  const events = automation.extrairMensagensRecebidas({
    entry: [{
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "123456789012345" },
          contacts: [{ wa_id: "5598999999999", profile: { name: "Cliente" } }],
          messages: [{
            id: "wamid.ABC",
            from: "5598999999999",
            type: "interactive",
            interactive: { button_reply: { id: "cfw:status", title: "Status do pedido" } },
          }],
        },
      }],
    }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].phoneNumberId, "123456789012345");
  assert.equal(events[0].from, "5598999999999");
  assert.equal(events[0].profileName, "Cliente");
  assert.equal(events[0].interactiveId, "cfw:status");
  assert.equal(events[0].text, "Status do pedido");
});

test("saudações e comandos de início reabrem o menu sem fallback", () => {
  const { ehSaudacaoOuInicio } = automation._testing;
  for (const text of ["oi", "Olá!", "Bom dia", "boa tarde", "Boa noite 👋", "menu", "início", "começar", "ajuda"]) {
    assert.equal(ehSaudacaoOuInicio({ type: "text", text }), true, text);
  }
  assert.equal(ehSaudacaoOuInicio({ type: "text", text: "123" }), false);
  assert.equal(ehSaudacaoOuInicio({ type: "text", text: "quero pizza" }), false);
  assert.equal(ehSaudacaoOuInicio({
    type: "interactive",
    text: "Olá",
    interactiveId: "cfw:status",
  }), false);
});

test("formata status do pedido para resposta do WhatsApp", () => {
  const text = automation.montarStatusPedido({
    _id: "64b000000000000000000001",
    codigoPublicoFinal: "AB12CD",
    status: "preparo",
    pagamentoStatus: "pago",
    canal: "delivery",
    total: 42.5,
  });
  assert.match(text, /Pedido #AB12CD/);
  assert.match(text, /Em preparo/);
  assert.match(text, /Pagamento: Pago/);
  assert.match(text, /Delivery/);
  assert.match(text, /42,50/);
});

test("Cloud API usa botões até 3 opções e lista acima disso", async t => {
  const oldToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const oldPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldVersion = process.env.WHATSAPP_GRAPH_VERSION;
  process.env.WHATSAPP_ACCESS_TOKEN = "token-de-teste";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789012345";
  process.env.WHATSAPP_GRAPH_VERSION = "v26.0";
  t.after(() => {
    if (oldToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = oldToken;
    if (oldPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhone;
    if (oldVersion === undefined) delete process.env.WHATSAPP_GRAPH_VERSION;
    else process.env.WHATSAPP_GRAPH_VERSION = oldVersion;
  });

  const payloads = [];
  const fakeFetch = async (url, init) => {
    payloads.push({ url, body: JSON.parse(init.body), authorization: init.headers.Authorization });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${payloads.length}` }] }) };
  };

  await cloud.enviarMenu({
    phoneNumberId: "123456789012345",
    to: "5598999999999",
    bodyText: "Menu",
    options: [1, 2, 3].map(n => ({ id: `o${n}`, title: `Opção ${n}` })),
    fetchImpl: fakeFetch,
  });
  await cloud.enviarMenu({
    phoneNumberId: "123456789012345",
    to: "5598999999999",
    bodyText: "Menu",
    options: [1, 2, 3, 4].map(n => ({ id: `o${n}`, title: `Opção ${n}` })),
    fetchImpl: fakeFetch,
  });

  assert.equal(payloads[0].body.interactive.type, "button");
  assert.equal(payloads[0].body.interactive.action.buttons.length, 3);
  assert.equal(payloads[1].body.interactive.type, "list");
  assert.equal(payloads[1].body.interactive.action.sections[0].rows.length, 4);
  assert.match(payloads[0].url, /graph\.facebook\.com\/v26\.0\/123456789012345\/messages/);
  assert.equal(payloads[0].authorization, "Bearer token-de-teste");
});

test("painel possui aba WhatsApp API e rotas administrativas protegidas", () => {
  const route = fs.readFileSync(path.join(__dirname, "../route.js"), "utf8");
  const view = fs.readFileSync(path.join(__dirname, "../src/views/admin-real.ejs"), "utf8");
  assert.match(route, /\/admin\/whatsapp\/configuracao/);
  assert.match(route, /admin\.salvarWhatsAppConfiguracao/);
  assert.match(route, /permissao\('configuracoes'\)/);
  assert.match(view, /data-page="whatsapp"/);
  assert.match(view, /id="page-whatsapp"/);
  assert.match(view, /Ver status do pedido/);
  assert.match(view, /Falar com atendente/);
  assert.match(view, /action="\/admin\/configuracoes" method="POST" id="whatsappAutomationForm"/);
  assert.match(view, /name="_whatsappAction" value="configuracao"/);
  const controller = fs.readFileSync(path.join(__dirname, "../src/controllers/adminRealController.js"), "utf8");
  assert.match(controller, /whatsappAction === "configuracao"/);
  assert.match(controller, /whatsappAction === "responder_conversa"/);
  assert.match(controller, /whatsappAction === "reativar_bot"/);
});

test("mensagens e conversas têm retenção definida no modelo", () => {
  const models = fs.readFileSync(path.join(__dirname, "../src/models/painelModels.js"), "utf8");
  assert.match(models, /whatsapp_message_retention_ttl/);
  assert.match(models, /whatsapp_conversa_retention_ttl/);
  assert.match(models, /90 \* 24 \* 60 \* 60 \* 1000/);
});
