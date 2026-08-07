"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const view = fs.readFileSync("src/views/admin-real.ejs", "utf8");
const controller = fs.readFileSync(
  "src/controllers/adminRealController.js",
  "utf8",
);
const routes = fs.readFileSync("route.js", "utf8");

test("painel possui fonte atual e única de consulta do token CSRF", () => {
  assert.match(view, /<meta name="csrf-token" content="<%= csrfToken %>">/);
  assert.match(view, /function obterCsrfTokenAtual\(\)/);
  assert.match(view, /meta\[name="csrf-token"\]/);
  assert.doesNotMatch(view, /localStorage[^;\n]*csrf/i);
  assert.doesNotMatch(view, /sessionStorage[^;\n]*csrf/i);
});

test("todos os formulários POST renderizados possuem _csrf", () => {
  for (const match of view.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    if (!/method\s*=\s*["']POST["']/i.test(match[0])) continue;
    assert.match(match[0], /name\s*=\s*["']_csrf["']/i);
  }
});

test("criação e edição de produto usam um único submit fetch multipart", () => {
  assert.match(view, /form\.matches\('form\[enctype="multipart\/form-data"\]'\)/);
  assert.doesNotMatch(
    view,
    /form\.matches\('form\[enctype="multipart\/form-data"\]'\)\s*&&\s*uploadInput\?\.files\?\.length/,
  );
  assert.match(view, /const formData = new FormData\(form\)/);
  assert.match(view, /formData\.set\('_csrf', csrfToken\)/);
  assert.match(view, /headers:\s*\{\s*Accept:\s*'application\/json'\s*\}/);
  assert.match(view, /function recarregarSecaoPainel\(secaoPreferida\)/);
  assert.match(view, /recarregarSecaoPainel\(payload\.section \|\| 'catalogo'\)/);
  assert.match(view, /const secoesPainelPermitidas = new Set/);
});

test("adminFetch exige CSRF nas mutações sem definir Content-Type multipart", () => {
  assert.match(view, /headers\.set\('X-CSRF-Token', csrfToken\)/);
  assert.match(view, /error\.code = 'CSRF_TOKEN_AUSENTE_NO_FRONTEND'/);
  assert.match(view, /credentials:\s*'same-origin'/);
  assert.doesNotMatch(view, /headers\.set\(['"]Content-Type['"],\s*['"]multipart\/form-data/);
  assert.doesNotMatch(view, /headers\.set\(['"]Origin['"]/);
});

test("produto é excluído definitivamente por botão independente e DELETE", () => {
  assert.match(view, /btn-excluir-produto/);
  assert.match(view, /method:\s*'DELETE'/);
  assert.match(routes, /route\.delete\(\s*['"]\/admin\/produtos\/:id['"]/);
  assert.match(routes, /permissao\(['"]catalogo['"]\)/);
  assert.match(controller, /const idEstabelecimento = estabelecimentoId\(req\)/);
  assert.match(controller, /Produto\.deleteOne/);
  assert.doesNotMatch(
    controller.match(/exports\.excluirProduto[\s\S]*?\/\*\n\|[-\s]*\| MESAS/)?.[0] || "",
    /\$set:\s*\{\s*ativo:\s*false/,
  );
});

test("adicionais ficam no mesmo FormData do formulário de produto", () => {
  assert.match(view, /name="adicionaisNome\[\]"/);
  assert.match(view, /name="adicionaisPreco\[\]"/);
  assert.match(controller, /normalizarAdicionais\(req\.body\)/);
});

test("fetch recebe JSON e submit nativo mantém redirect", () => {
  assert.match(controller, /includes\("application\/json"\)[\s\S]*res\.status\(200\)\.json/);
  assert.match(controller, /res\.redirect\(`\/admin#\$\{pagina\}`\)/);
});

test("sessão inválida encerra polling e ambos os SSE uma única vez", () => {
  assert.match(view, /let sessionRedirectInProgress = false/);
  assert.match(view, /function handleSessionExpired\(\)/);
  assert.match(view, /if \(sessionRedirectInProgress\) return/);
  assert.match(view, /pararPollings\(\);\s*fecharSse\(\)/);
  assert.match(view, /pedidosStream\?\.close\(\)/);
  assert.match(view, /printAgentStatusStream\?\.close\(\)/);
  assert.match(view, /if \(!pollingPedidosAtivo \|\| sessionRedirectInProgress/);
});


test("submit multipart bloqueia cliques repetidos antes da requisição", () => {
  assert.match(view, /function definirEstadoEnvioFormulario\(form, enviando\)/);
  assert.match(view, /if \(form\.dataset\.submitting === 'true'\)\s*\{\s*return;/);
  assert.match(view, /definirEstadoEnvioFormulario\(form, true\)/);
  assert.match(view, /botao\.disabled = true/);
  assert.match(view, /botao\.textContent = 'Salvando\.\.\.'/);
  assert.match(view, /const response = await adminFetch\(form\.action/);
  assert.match(view, /Mantém o formulário bloqueado até o reload/);
  assert.match(view, /definirEstadoEnvioFormulario\(form, false\)/);
});

test("edição de produto aponta somente para endpoint de edição", () => {
  assert.match(view, /action="\/admin\/produtos\/<%= produto\._id %>\/editar"/);
  const editar = controller.match(/exports\.editarProduto[\s\S]*?exports\.excluirProduto/)?.[0] || "";
  assert.match(editar, /Produto\.findOne\(/);
  assert.match(editar, /await produto\.save\(\)/);
  assert.doesNotMatch(editar, /Produto\.create\(/);
  assert.doesNotMatch(editar, /upsert\s*:\s*true/);
});
