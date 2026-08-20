"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function csrfFunctions() {
  const source = read("src/middleware/csrf.js");
  const start = source.indexOf("function isPublicAnonymousCsrfBypassPath");
  const end = source.indexOf("function csrfProtection", start);
  assert.ok(start >= 0 && end > start, "funções da otimização CSRF não encontradas");
  const sandbox = { crypto };
  vm.runInNewContext(
    source.slice(start, end) +
      "; this.ensureCsrfToken = ensureCsrfToken;" +
      " this.isPublicAnonymousCsrfBypassPath = isPublicAnonymousCsrfBypassPath;",
    sandbox,
  );
  return sandbox;
}

test("catálogo e mesa anônimos não criam token CSRF persistível", () => {
  const { ensureCsrfToken, isPublicAnonymousCsrfBypassPath } = csrfFunctions();
  for (const originalUrl of [
    "/catalogo/eusa-pizzaria",
    "/catalogo/eusa-pizzaria/pedidos",
    "/mesa/token-publico",
    "/mesa/token-publico/pedidos",
  ]) {
    const req = { originalUrl, session: {} };
    const res = { locals: {} };
    let nextCalled = false;
    ensureCsrfToken(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.session.csrfToken, undefined);
    assert.equal(res.locals.csrfToken, "");
    assert.equal(isPublicAnonymousCsrfBypassPath(req), true);
  }
});

test("admin continua criando e expondo token CSRF normalmente", () => {
  const { ensureCsrfToken, isPublicAnonymousCsrfBypassPath } = csrfFunctions();
  const req = { originalUrl: "/admin", session: { user: { id: "user" } } };
  const res = { locals: {} };
  ensureCsrfToken(req, res, () => {});
  assert.match(req.session.csrfToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(res.locals.csrfToken, req.session.csrfToken);
  assert.equal(isPublicAnonymousCsrfBypassPath(req), false);
});

test("produtos públicos projetam somente dados necessários ao catálogo", () => {
  const source = read("src/services/produtoPublicoService.js");
  assert.match(source, /\.select\(\s*[\"']nome descricao categoriaId preco imagem adicionais precosPizza precosVariacoes[\"']/);
  const selectStart = source.indexOf(".select(");
  const selectEnd = source.indexOf(".populate(", selectStart);
  const projection = source.slice(selectStart, selectEnd);
  assert.doesNotMatch(projection, /fichaTecnica|custo|imagemArquivo/);
});

test("cards usam lazy loading e imagens do topo continuam imediatas", () => {
  const view = read("src/views/catalogo-publico.ejs");
  const productCoverStart = view.indexOf('<div class="product-cover">');
  assert.ok(productCoverStart >= 0);
  const cardImageStart = view.indexOf("safePublicUrl(produto.imagem", productCoverStart);
  assert.ok(cardImageStart >= 0);
  const cardImage = view.slice(cardImageStart, cardImageStart + 500);
  assert.match(cardImage, /loading="lazy"/);
  assert.match(cardImage, /decoding="async"/);

  for (const marker of [
    "safePublicUrl(configuracao.fotoPerfil",
    "safePublicUrl(heroProduto.imagem",
  ]) {
    const start = view.indexOf(marker);
    assert.ok(start >= 0);
    assert.doesNotMatch(view.slice(start, start + 350), /loading="lazy"/);
  }
});
