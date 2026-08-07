"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createAdminLoading, optionsForAction } = require("../public/js/adminLoading");

function fixture() {
  let clock = 0;
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const classNames = new Set();
  const attributes = new Map();
  const makeElement = (hidden = false) => ({
    hidden,
    textContent: "",
    isConnected: true,
    focused: false,
    setAttribute(name, value) { this.attributes ||= new Map(); this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes?.delete(name); },
    focus() { this.focused = true; document.activeElement = this; },
  });
  const elements = {
    adminLoadingOverlay: makeElement(true),
    adminLoadingDialog: makeElement(),
    adminLoadingTitle: makeElement(),
    adminLoadingMessage: makeElement(),
  };
  const initialFocus = makeElement();
  const body = {
    classList: {
      add(value) { classNames.add(value); },
      remove(value) { classNames.delete(value); },
      contains(value) { return classNames.has(value); },
    },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
  };
  const document = {
    activeElement: initialFocus,
    body,
    getElementById(id) { return elements[id] || null; },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const env = {
    document,
    Date: { now: () => clock },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { at: clock + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  function tick(ms) {
    const end = clock + ms;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    clock = end;
  }
  return { api: createAdminLoading(env), elements, body, initialFocus, listeners, tick };
}

test("modal respeita atraso de 200 ms e operação rápida não aparece", async () => {
  const fast = fixture();
  await fast.api.run(async () => "ok");
  fast.tick(500);
  assert.equal(fast.api.isVisible(), false);

  const slow = fixture();
  slow.api.show();
  slow.tick(199);
  assert.equal(slow.api.isVisible(), false);
  slow.tick(1);
  assert.equal(slow.api.isVisible(), true);
});

test("modal mantém mínimo visual e fecha após sucesso", () => {
  const value = fixture();
  value.api.show();
  value.tick(200);
  value.api.hide();
  value.tick(249);
  assert.equal(value.api.isVisible(), true);
  value.tick(1);
  assert.equal(value.api.isVisible(), false);
});

test("run fecha em erro e propaga o erro real", async () => {
  const value = fixture();
  const promise = value.api.run(async () => {
    value.tick(200);
    throw new Error("erro preservado");
  });
  await assert.rejects(promise, /erro preservado/);
  value.tick(250);
  assert.equal(value.api.isVisible(), false);
});

test("contador concorrente não fecha enquanto resta operação", () => {
  const value = fixture();
  value.api.show();
  value.api.show();
  value.tick(200);
  assert.equal(value.api.pendingCount(), 2);
  value.api.hide();
  value.tick(1000);
  assert.equal(value.api.isVisible(), true);
  value.api.hide();
  value.tick(250);
  assert.equal(value.api.isVisible(), false);
});

test("contador nunca fica negativo", () => {
  const value = fixture();
  value.api.hide();
  value.api.hide();
  assert.equal(value.api.pendingCount(), 0);
});

test("mensagem personalizada usa textContent", () => {
  const value = fixture();
  value.api.show({ title: "Salvando produto", message: "<img src=x onerror=alert(1)>" });
  value.tick(200);
  assert.equal(value.elements.adminLoadingTitle.textContent, "Salvando produto");
  assert.equal(value.elements.adminLoadingMessage.textContent, "<img src=x onerror=alert(1)>");
});

test("Escape é bloqueado durante operação", () => {
  const value = fixture();
  let prevented = false;
  let stopped = false;
  value.api.show();
  value.listeners.get("keydown")({
    key: "Escape",
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(value.api.pendingCount(), 1);
});

test("foco e rolagem são restaurados", () => {
  const value = fixture();
  value.api.show();
  value.tick(200);
  assert.equal(value.body.classList.contains("admin-loading-open"), true);
  assert.equal(value.body.hasAttribute("aria-busy"), true);
  value.api.hide();
  value.tick(250);
  assert.equal(value.body.classList.contains("admin-loading-open"), false);
  assert.equal(value.body.hasAttribute("aria-busy"), false);
  assert.equal(value.initialFocus.focused, true);
});

test("mensagens longas mudam em 8 e 30 segundos", () => {
  const value = fixture();
  value.api.show();
  value.tick(200);
  value.tick(8000);
  assert.match(value.elements.adminLoadingMessage.textContent, /demorando/);
  value.tick(22000);
  assert.equal(value.elements.adminLoadingMessage.textContent, "Estamos aguardando a resposta do servidor.");
});

test("mapa central seleciona e sobrescreve mensagens", () => {
  assert.match(optionsForAction("payment").title, /pagamento/i);
  assert.equal(optionsForAction("save", { title: "Personalizado" }).title, "Personalizado");
});

test("integração do painel exclui GET, polling e impressão e não sobrescreve fetch", () => {
  const view = fs.readFileSync(path.join(__dirname, "../src/views/admin-real.ejs"), "utf8");
  const component = fs.readFileSync(path.join(__dirname, "../public/js/adminLoading.js"), "utf8");
  const markup = fs.readFileSync(path.join(__dirname, "../src/views/includes/admin-loading.ejs"), "utf8");
  assert.match(view, /mutatingAdminMethods\.has\(method\)/);
  assert.match(view, /event\.defaultPrevented/);
  assert.match(view, /!form\.checkValidity\(\)/);
  assert.match(view, /skipAdminLoading: true/);
  assert.match(view, /form\.dataset\.submitting === 'true'/);
  assert.match(view, /submitter\.disabled = true/);
  assert.match(view, /window\.AdminLoading\.run/);
  assert.doesNotMatch(component, /window\.fetch\s*=/);
  assert.doesNotMatch(component, /innerHTML/);
  assert.equal((markup.match(/id="adminLoadingOverlay"/g) || []).length, 1);
  assert.equal((view.match(/include\('includes\/admin-loading'\)/g) || []).length, 1);
});

test("assinatura reutiliza o componente sem remover proteção financeira local", () => {
  const view = fs.readFileSync(path.join(__dirname, "../src/views/assinatura.ejs"), "utf8");
  assert.match(view, /include\('includes\/admin-loading'\)/);
  assert.match(view, /AdminLoading\.messages\.cancel/);
  assert.match(view, /AdminLoading\.messages\.payment/);
  assert.match(view, /cancelInFlight/);
  assert.match(view, /form\.dataset\.submitting/);
});
