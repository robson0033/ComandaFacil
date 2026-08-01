"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const route = require("../route");
const admin = require("../src/controllers/adminRealController");
const { requestContext } = require("../src/middleware/requestContext");
const { permissao } = require("../src/middleware/auth");
const {
  ALL_PERMISSIONS,
  CRITICAL_PERMISSIONS,
} = require("../src/config/permissions");

function routeInventory() {
  const rows = [];
  for (const layer of route.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      rows.push({
        method: method.toUpperCase(),
        path: layer.route.path,
        handlers: layer.route.stack.map(item => item.handle),
      });
    }
  }
  return rows;
}

test("inventário possui 83 rotas e não contém método/path duplicado", () => {
  const inventory = routeInventory();
  assert.equal(inventory.length, 83);
  const keys = inventory.map(item => `${item.method} ${item.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("todas as mutações administrativas estão depois da proteção CSRF global", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../route.js"), "utf8");
  const protection = source.indexOf("route.use('/admin', csrfSameOriginProtection)");
  assert.ok(protection >= 0);
  const mutable = [...source.matchAll(
    /route\.(?:post|put|patch|delete)\(\s*['"](\/admin[^'"]*)['"]/g,
  )];
  assert.ok(mutable.length >= 25);
  for (const match of mutable) assert.ok(match.index > protection, match[1]);

  for (const item of routeInventory().filter(row =>
    row.path.startsWith("/admin")
    && ["POST", "PUT", "PATCH", "DELETE"].includes(row.method))) {
    assert.ok(item.handlers.length >= 5, `${item.method} ${item.path}`);
  }
});

test("webhook permanece fora de sessão/CSRF administrativo", () => {
  const webhook = routeInventory().find(item =>
    item.method === "POST" && item.path === "/webhook/mercado-pago");
  assert.ok(webhook);
  assert.equal(webhook.handlers.length, 2);
  const source = fs.readFileSync(path.resolve(__dirname, "../route.js"), "utf8");
  assert.match(source, /route\.use\('\/admin', csrfSameOriginProtection\)/);
  assert.doesNotMatch(
    source,
    /route\.use\('\/webhook',\s*csrfSameOriginProtection\)/,
  );
});

test("adicionais validam limites, NaN, negativos e duplicidade", () => {
  const normalize = admin._testing.normalizarAdicionais;
  assert.deepEqual(normalize({
    adicionaisNome: [" Bacon "],
    adicionaisPreco: ["4.50"],
  }), [{ nome: "Bacon", preco: 4.5, ativo: true }]);
  assert.throws(() => normalize({
    adicionaisNome: ["Bacon"],
    adicionaisPreco: ["NaN"],
  }), error => error.code === "VALIDATION_ERROR" && error.statusCode === 422);
  assert.throws(() => normalize({
    adicionaisNome: ["Bacon"],
    adicionaisPreco: ["-1"],
  }), /preço válido/);
  assert.throws(() => normalize({
    adicionaisNome: ["Bacon", " bacon "],
    adicionaisPreco: ["1", "2"],
  }), /repita/);
  assert.throws(() => normalize({
    adicionaisNome: Array.from({ length: 31 }, (_, index) => `Item ${index}`),
    adicionaisPreco: Array(31).fill("1"),
  }), /máximo 30/);
});

test("correlationId é técnico, único e enviado no header", () => {
  const ids = [];
  for (let index = 0; index < 2; index += 1) {
    const req = {};
    const res = {
      locals: {},
      set(name, value) {
        assert.equal(name, "X-Correlation-Id");
        ids.push(value);
      },
    };
    let passed = false;
    requestContext(req, res, () => { passed = true; });
    assert.equal(passed, true);
    assert.match(req.correlationId, /^[A-F0-9]{16}$/);
    assert.equal(res.locals.correlationId, req.correlationId);
  }
  assert.notEqual(ids[0], ids[1]);
});

test("permissões são centralizadas e nome desconhecido falha fechado", () => {
  for (const permission of [
    "pedidos",
    "catalogo",
    "estoque",
    "mesas",
    "funcionarios",
    "configuracoes",
    "relatorios",
    "imprimir_pedidos",
    "configurar_impressoras",
    "arquivar_pedidos",
  ]) {
    assert.equal(ALL_PERMISSIONS.has(permission), true, permission);
  }
  assert.equal(CRITICAL_PERMISSIONS.has("arquivar_pedidos"), true);
  assert.throws(() => permissao("catálogo"), /Permissão desconhecida/);
  assert.throws(() => permissao("adicionais"), /Permissão desconhecida/);
});

test("adminFetch central trata sessão, CSRF e permissão sem retry automático", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/views/admin-real.ejs"),
    "utf8",
  );
  assert.match(source, /async function adminFetch/);
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /headers\.set\('X-CSRF-Token', csrfToken\)/);
  assert.match(source, /function obterCsrfTokenAtual\(\)/);
  assert.match(source, /response\.status === 401/);
  assert.match(source, /response\.status === 403/);
  assert.match(source, /PERMISSION_DENIED/);
  assert.doesNotMatch(source, /headers\.set\(['"]Origin/i);
  assert.doesNotMatch(source, /headers\.set\(['"]Referer/i);
  assert.equal([...source.matchAll(/window\.fetch\(/g)].length, 1);
});
