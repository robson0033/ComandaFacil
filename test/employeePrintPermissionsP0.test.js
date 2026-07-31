"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("status do agente aceita imprimir_pedidos ou configurar_impressoras", () => {
  const route = read("route.js");
  assert.match(route, /permissaoQualquer\('imprimir_pedidos', 'configurar_impressoras'\), admin\.statusAgente/);
  assert.match(route, /permissaoQualquer\('imprimir_pedidos', 'configurar_impressoras'\), admin\.streamStatusAgente/);
});

test("painel não consulta agente sem permissão e notificações dependem de pedidos", () => {
  const view = read("src/views/admin-real.ejs");
  assert.match(view, /const podeReceberNotificacoes =\s*<%- safeJsonForHtml\(pode\('pedidos'\)\); %>;/);
  assert.match(view, /if \(podeImprimirPedidos \|\| <%- safeJsonForHtml\(pode\('configurar_impressoras'\)\); %>\) \{/);
});

test("middleware permissaoQualquer valida qualquer permissão concedida", () => {
  const auth = read("src/middleware/auth.js");
  assert.match(auth, /exports\.permissaoQualquer = \(\.\.\.modulos\) =>/);
  assert.match(auth, /permissoes\.some\(permissao => req\.permissoesAtuais\.includes\(permissao\)\)/);
});
