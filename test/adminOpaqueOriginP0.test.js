"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildContentSecurityPolicy,
  securityHeaders,
} = require("../src/middleware/securityHeaders");
const {
  createCsrfSameOriginProtection,
} = require("../src/middleware/csrf");

const APP_ORIGIN = "https://comandafacil-2kot.onrender.com";

function collectHeaders(requestPath) {
  const values = new Map();
  const setCount = new Map();
  const removed = [];
  const res = {
    locals: {},
    removeHeader(name) { removed.push(name.toLowerCase()); values.delete(name.toLowerCase()); },
    set(name, value) {
      const key = name.toLowerCase();
      setCount.set(key, (setCount.get(key) || 0) + 1);
      values.set(key, value);
    },
  };
  let passed = false;
  securityHeaders(
    { path: requestPath, originalUrl: requestPath },
    res,
    () => { passed = true; },
  );
  return { passed, values, setCount, removed, nonce: res.locals.cspNonce };
}

test("páginas administrativas recebem uma CSP única sem sandbox e sem cache", () => {
  for (const requestPath of ["/admin", "/admin/categorias", "/admin/mesas"]) {
    const result = collectHeaders(requestPath);
    const csp = result.values.get("content-security-policy");
    assert.equal(result.passed, true);
    assert.equal(result.setCount.get("content-security-policy"), 1);
    assert.doesNotMatch(csp, /(^|;)\s*sandbox(?:\s|;|$)/i);
    assert.ok(csp.includes(`script-src 'self' 'nonce-${result.nonce}'`));
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.equal(result.values.get("cache-control"), "no-store, private");
    assert.equal(result.values.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(result.values.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(result.values.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(result.setCount.get("referrer-policy"), 1);
    assert.ok(result.removed.includes("referrer-policy"));
    assert.ok(result.removed.includes("content-security-policy-report-only"));
  }
});

test("nenhuma view força no-referrer em navegação ou envio de formulários", () => {
  const viewsDirectory = path.resolve(__dirname, "../src/views");
  for (const name of fs.readdirSync(viewsDirectory).filter(file => file.endsWith(".ejs"))) {
    const source = fs.readFileSync(path.join(viewsDirectory, name), "utf8");
    assert.doesNotMatch(
      source,
      /<meta\b[^>]*\bname=["']referrer["'][^>]*\bcontent=["']no-referrer["']/i,
      name,
    );
    assert.doesNotMatch(
      source,
      /<form\b[^>]*\breferrerpolicy=["']no-referrer["']/i,
      name,
    );
  }

  const adminSource = fs.readFileSync(
    path.join(viewsDirectory, "admin-real.ejs"),
    "utf8",
  );
  assert.doesNotMatch(adminSource, /\breferrerPolicy\s*:/);
  assert.doesNotMatch(adminSource, /\breferrer\s*:\s*["']{2}/);
});

test("construtor central rejeita regressão sandbox e preserva proteções", () => {
  const csp = buildContentSecurityPolicy({ nonce: "nonce-teste", production: true });
  assert.doesNotMatch(csp, /\bsandbox\b/i);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'nonce-nonce-teste'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /upgrade-insecure-requests/);
});

test("views não contêm meta CSP, iframe sandbox ou formulário com target opaco", () => {
  const viewsDirectory = path.resolve(__dirname, "../src/views");
  for (const name of fs.readdirSync(viewsDirectory).filter(file => file.endsWith(".ejs"))) {
    const source = fs.readFileSync(path.join(viewsDirectory, name), "utf8");
    assert.doesNotMatch(source, /http-equiv\s*=\s*["']Content-Security-Policy/i, name);
    assert.doesNotMatch(source, /<iframe\b[^>]*\bsandbox\b/i, name);
    assert.doesNotMatch(source, /<form\b[^>]*\btarget\s*=/i, name);
    assert.doesNotMatch(source, /\bformaction\s*=\s*["'](?:data:|blob:|https?:)/i, name);
  }
});

test("não existe service worker nem cache de navegação administrativa", () => {
  const roots = [
    path.resolve(__dirname, "../public"),
    path.resolve(__dirname, "../src"),
  ];
  const found = [];
  const walk = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) walk(absolute);
      else if (/^(?:sw|service-worker)\.js$/i.test(item.name)) found.push(absolute);
    }
  };
  roots.forEach(walk);
  assert.deepEqual(found, []);
});

test("Origin null continua bloqueada e Origin Render continua aceita", () => {
  const middleware = createCsrfSameOriginProtection({
    env: { NODE_ENV: "production", APP_URL: APP_ORIGIN },
    logger: { warn() {} },
  });
  const invoke = origin => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      send() { return this; },
    };
    let passed = false;
    middleware({
      method: "POST",
      path: "/admin/categorias",
      originalUrl: "/admin/categorias",
      session: { csrfToken: "token" },
      body: { _csrf: "token" },
      get(name) {
        return name.toLowerCase() === "origin" ? origin : "";
      },
    }, res, () => { passed = true; });
    return { passed, statusCode: res.statusCode };
  };
  assert.deepEqual(invoke("null"), { passed: false, statusCode: 403 });
  assert.deepEqual(invoke(APP_ORIGIN), { passed: true, statusCode: 200 });
});
