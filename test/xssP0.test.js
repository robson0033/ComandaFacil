"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const {
  safeJsonForHtml,
  safePublicUrl,
} = require("../src/utils/htmlSecurity");
const { securityHeaders } = require("../src/middleware/securityHeaders");

const PAYLOADS = [
  "</script><script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  "\"><script>alert(1)</script>",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "' \" & \u2028 \u2029 </style>",
];

function responseMock() {
  return {
    locals: {},
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
}

test("safeJsonForHtml mantém JSON válido e neutraliza fechamento de script", () => {
  const value = {
    nome: PAYLOADS[0],
    descricao: PAYLOADS[1],
    unicode: `antes\u2028meio\u2029fim`,
    ampersand: "A&B",
  };
  const serialized = safeJsonForHtml(value);
  assert.deepEqual(JSON.parse(serialized), value);
  assert.doesNotMatch(serialized, /<\/script|<script|<img|&/i);
  assert.match(serialized, /\\u003c/);
  assert.match(serialized, /\\u003e/);
  assert.match(serialized, /\\u0026/);
  assert.match(serialized, /\\u2028/);
  assert.match(serialized, /\\u2029/);
});

test("texto comum renderizado por EJS aparece escapado", () => {
  for (const payload of PAYLOADS) {
    const output = ejs.render("<p><%= value %></p>", { value: payload });
    assert.doesNotMatch(output, /<script|<img|<svg/i);
    if (/[<>&'"]/.test(payload)) {
      assert.equal(output.includes(payload), false);
    }
  }
});

test("validador de URL bloqueia protocolos ativos e permite imagens autorizadas", () => {
  assert.equal(safePublicUrl("javascript:alert(1)"), "");
  assert.equal(
    safePublicUrl("data:text/html,<script>alert(1)</script>", {
      allowDataImage: true,
    }),
    "",
  );
  assert.equal(safePublicUrl("vbscript:msgbox(1)"), "");
  assert.equal(safePublicUrl("https://example.com/imagem.png"),
    "https://example.com/imagem.png");
  assert.equal(safePublicUrl("/assets/imgs/comanda.png"),
    "/assets/imgs/comanda.png");
  assert.equal(
    safePublicUrl("data:image/png;base64,iVBORw0KGgo=", {
      allowDataImage: true,
    }),
    "data:image/png;base64,iVBORw0KGgo=",
  );
  assert.equal(
    safePublicUrl("data:image/svg+xml,<svg onload=alert(1)>", {
      allowDataImage: true,
    }),
    "",
  );
});

test("CSP usa nonce e bloqueia scripts inline sem autorização", () => {
  const first = responseMock();
  const second = responseMock();
  let nextCalls = 0;
  securityHeaders({}, first, () => { nextCalls += 1; });
  securityHeaders({}, second, () => { nextCalls += 1; });
  const csp = first.headers["Content-Security-Policy"];
  assert.equal(nextCalls, 2);
  assert.notEqual(first.locals.cspNonce, second.locals.cspNonce);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.equal(first.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(first.headers["X-Frame-Options"], "DENY");
});

test("todas as tags script EJS possuem nonce e não há handlers inline", () => {
  const views = fs.readdirSync("src/views")
    .filter(name => name.endsWith(".ejs"))
    .map(name => fs.readFileSync(path.join("src/views", name), "utf8"));
  const source = views.join("\n");
  const scripts = [...source.matchAll(/<script\b[^>]*>/gi)]
    .map(match => match[0]);
  assert.ok(scripts.length > 0);
  assert.equal(
    scripts.every(tag => /\bnonce="<%=\s*cspNonce/.test(tag)),
    true,
  );
  assert.doesNotMatch(
    source,
    /\s(?:onclick|onerror|onload|onchange|onsubmit|oninput|onfocus|onblur)\s*=/i,
  );
});

test("JSON embutido em EJS passa exclusivamente pelo helper central", () => {
  const source = fs.readdirSync("src/views")
    .filter(name => name.endsWith(".ejs"))
    .map(name => fs.readFileSync(path.join("src/views", name), "utf8"))
    .join("\n");
  const rawOutputs = [...source.matchAll(/<%-\s*([^%]+)%>/g)]
    .map(match => match[1].trim())
    .filter(value => !value.startsWith("lojaDisponivel"));
  assert.equal(
    rawOutputs.every(value => value.startsWith("safeJsonForHtml(") || value.startsWith("include(")),
    true,
  );
  assert.doesNotMatch(source, /<%-\s*JSON\.stringify/);
});

test("mensagens de backend não são atribuídas diretamente a innerHTML", () => {
  const source = fs.readdirSync("src/views")
    .filter(name => name.endsWith(".ejs"))
    .map(name => fs.readFileSync(path.join("src/views", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /innerHTML\s*=\s*(?:result|response|data|error)\.message/i,
  );
  assert.match(source, /formMessage\.textContent\s*=\s*error\.message/);
  assert.match(source, /toast\.textContent\s*=\s*message/);
});

test("URLs dinâmicas sensíveis das views usam validação central", () => {
  const catalogo = fs.readFileSync("src/views/catalogo-publico.ejs", "utf8");
  const mesa = fs.readFileSync("src/views/mesa-publica.ejs", "utf8");
  const admin = fs.readFileSync("src/views/admin-real.ejs", "utf8");
  for (const source of [catalogo, mesa, admin]) {
    assert.doesNotMatch(
      source,
      /src="<%=\s*(?:configuracao|config|produto|funcionario|mesa)\.[^%]+%>"/,
    );
  }
  assert.match(catalogo, /safePublicUrl\(produto\.imagem/);
  assert.match(mesa, /safePublicUrl\(produto\.imagem/);
  assert.match(admin, /safePublicUrl\(funcionario\.foto/);
});

test("payloads armazenados não são usados como HTML nos fluxos críticos", () => {
  const catalogo = fs.readFileSync("src/views/catalogo-publico.ejs", "utf8");
  const mesa = fs.readFileSync("src/views/mesa-publica.ejs", "utf8");
  const admin = fs.readFileSync("src/views/admin-real.ejs", "utf8");
  assert.match(catalogo, /name\.textContent = String\(item\.nome/);
  assert.match(catalogo, /mostrarMensagemPedidos\('orders-error', error\.message\)/);
  assert.equal(
    mesa.includes("querySelector('.cart-item-name').textContent"),
    true,
  );
  assert.equal(
    mesa.includes("comment.value = String(item.comentario"),
    true,
  );
  assert.match(admin, /escaparHtml\(\s*pedido\.cliente/);
  assert.doesNotMatch(
    `${catalogo}\n${mesa}\n${admin}`,
    /innerHTML\s*=\s*[^\n;]*(?:acompanhamentoToken|authorization)/i,
  );
});
