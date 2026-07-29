"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  assertCsrfConfiguration,
  configuredOrigins,
  createCsrfSameOriginProtection,
  isSafeHttpMethod,
  normalizeOrigin,
} = require("../src/middleware/csrf");
const { loginRequired, permissao } = require("../src/middleware/auth");

const APP_ORIGIN = "https://comandafacil-2kot.onrender.com";
const ADMIN_PATHS = [
  "/admin",
  "/admin/categorias",
  "/admin/catalogo",
  "/admin/cardapio",
  "/admin/mesas",
  "/admin/funcionarios",
  "/admin/estoque",
  "/admin/pedidos",
  "/admin/relatorios",
  "/admin/configuracoes",
  "/admin/agente",
  "/admin/agente/status",
  "/admin/api/pedidos/novos",
];

function response() {
  return {
    statusCode: 200,
    body: "",
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
    redirect(value) { this.redirectedTo = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function request({
  method = "GET",
  path: requestPath = "/admin",
  origin,
  referer,
  token = "csrf-token",
  supplied = "__VALID__",
} = {}) {
  return {
    method,
    path: requestPath,
    originalUrl: requestPath,
    session: { csrfToken: token },
    body: supplied === undefined
      ? {}
      : { _csrf: supplied === "__VALID__" ? token : supplied },
    get(name) {
      return {
        origin,
        referer,
        "x-csrf-token": "",
      }[String(name).toLowerCase()] || "";
    },
  };
}

function middleware(env = {}, logs = []) {
  return createCsrfSameOriginProtection({
    env: { NODE_ENV: "production", APP_URL: APP_ORIGIN, ...env },
    logger: { warn: (...items) => logs.push(items) },
  });
}

function execute(handler, req) {
  const res = response();
  let passed = false;
  handler(req, res, () => { passed = true; });
  return { passed, res };
}

test("GET administrativo sem Origin passa globalmente para todas as páginas", () => {
  const handler = middleware();
  for (const requestPath of ADMIN_PATHS) {
    const result = execute(handler, request({ path: requestPath }));
    assert.equal(result.passed, true, requestPath);
    assert.equal(result.res.statusCode, 200, requestPath);
  }
});

test("HEAD e OPTIONS sem Origin são seguros e não executam efeito colateral", () => {
  const handler = middleware();
  let nextCalls = 0;
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    handler(request({ method }), response(), () => { nextCalls += 1; });
    assert.equal(isSafeHttpMethod(method), true);
  }
  assert.equal(nextCalls, 3);
});

test("GET continua exigindo autenticação e permissão após o middleware", async () => {
  const req = request();
  req.session = {};
  req.get = () => "text/html";
  req.flash = () => {};
  const unauthenticated = response();
  await loginRequired(req, unauthenticated, () => assert.fail("não deve autenticar"));
  assert.equal(unauthenticated.redirectedTo, "/login/index");

  const deniedReq = request();
  deniedReq.session = {
    user: { tipo: "funcionario", id: "func", estabelecimentoId: "loja", permissoes: [] },
  };
  deniedReq.usuarioAtual = deniedReq.session.user;
  deniedReq.permissoesAtuais = [];
  const denied = response();
  await permissao("estoque")(deniedReq, denied, () => assert.fail("não deve autorizar"));
  assert.equal(denied.statusCode, 403);
});

test("POST exige simultaneamente origem exata e token CSRF", () => {
  const handler = middleware();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(execute(handler, request({
      method,
      origin: APP_ORIGIN,
    })).passed, true, method);
  }
  assert.equal(execute(handler, request({
    method: "POST",
    origin: APP_ORIGIN,
    supplied: "token-invalido",
  })).res.statusCode, 403);
  assert.equal(execute(handler, request({
    method: "POST",
    origin: undefined,
    referer: `${APP_ORIGIN}/admin`,
  })).passed, true);
  assert.equal(execute(handler, request({
    method: "POST",
    origin: undefined,
    referer: undefined,
  })).res.statusCode, 403);
});

test("origens aproximadas, inseguras, portas e URL malformada são bloqueadas", () => {
  const handler = middleware();
  for (const origin of [
    "http://comandafacil-2kot.onrender.com",
    "https://comandafacil-2kot.onrender.com.evil.example",
    "https://sub.comandafacil-2kot.onrender.com",
    "https://comandafacil-2kot.onrender.com:444",
    "não-é-url",
  ]) {
    assert.equal(execute(handler, request({ method: "POST", origin })).res.statusCode, 403);
  }
});

test("APP_URL normaliza barra, ALLOWED_ORIGINS é explícita e localhost só fora de produção", () => {
  assert.equal(normalizeOrigin(`${APP_ORIGIN}/`), APP_ORIGIN);
  assert.equal(normalizeOrigin(null), null);
  assert.equal(normalizeOrigin("null"), null);
  assert.equal(normalizeOrigin("ftp://example.com"), null);
  assert.equal(normalizeOrigin("https://user:pass@example.com"), null);
  const allowed = configuredOrigins({
    NODE_ENV: "production",
    APP_URL: `${APP_ORIGIN}/`,
    ALLOWED_ORIGINS: "https://admin.example.com,https://other.example.com:8443",
  });
  assert.deepEqual([...allowed], [
    APP_ORIGIN,
    "https://admin.example.com",
    "https://other.example.com:8443",
  ]);
  assert.equal(configuredOrigins({
    NODE_ENV: "production",
    APP_URL: APP_ORIGIN,
    ALLOWED_ORIGINS: "http://localhost:3000,http://admin.example.com",
  }).has("http://localhost:3000"), false);
  assert.equal(configuredOrigins({
    NODE_ENV: "production",
    APP_URL: APP_ORIGIN,
    ALLOWED_ORIGINS: "http://admin.example.com",
  }).has("http://admin.example.com"), false);
  assert.equal(configuredOrigins({
    NODE_ENV: "development",
    APP_URL: "http://localhost:3000",
  }).has("http://localhost:3000"), true);
  assert.equal(assertCsrfConfiguration({
    NODE_ENV: "production",
    APP_URL: `${APP_ORIGIN}/`,
  }), true);
  assert.throws(() => assertCsrfConfiguration({
    NODE_ENV: "production",
    APP_URL: "não-é-url",
  }), /APP_URL/);
  assert.throws(() => assertCsrfConfiguration({
    NODE_ENV: "production",
    APP_URL: APP_ORIGIN,
    ALLOWED_ORIGINS: "http://admin.example.com",
  }), /ALLOWED_ORIGINS/);
});

test("log de bloqueio contém apenas metadados técnicos sanitizados", () => {
  const logs = [];
  const req = request({ method: "DELETE", origin: "https://evil.example" });
  req.body = { senha: "segredo", _csrf: "token" };
  req.session.cookie = "cookie-secreto";
  execute(middleware({}, logs), req);
  const serialized = JSON.stringify(logs);
  assert.match(serialized, /ORIGIN_NAO_AUTORIZADA/);
  assert.doesNotMatch(serialized, /segredo|cookie-secreto|csrf-token/);
});

test("classifica precisamente falhas de origem, Referer, APP_URL e CSRF", () => {
  const cases = [
    [{ method: "POST", origin: undefined, referer: undefined }, "ORIGIN_AUSENTE"],
    [{ method: "POST", origin: "null" }, "ORIGIN_MALFORMADA"],
    [{ method: "POST", origin: "não-é-url" }, "ORIGIN_MALFORMADA"],
    [{ method: "POST", origin: "https://evil.example" }, "ORIGIN_NAO_AUTORIZADA"],
    [{ method: "POST", referer: "não-é-url" }, "REFERER_MALFORMADO"],
    [{ method: "POST", origin: APP_ORIGIN, supplied: null }, "CSRF_TOKEN_AUSENTE"],
    [{ method: "POST", origin: APP_ORIGIN, supplied: "inválido" }, "CSRF_TOKEN_INVALIDO"],
  ];
  for (const [input, expected] of cases) {
    const logs = [];
    execute(middleware({}, logs), request(input));
    assert.equal(logs[0][1].code, expected);
  }
  const invalidAppLogs = [];
  execute(
    middleware({ APP_URL: "não-é-url" }, invalidAppLogs),
    request({ method: "POST", origin: APP_ORIGIN }),
  );
  assert.equal(invalidAppLogs[0][1].code, "APP_URL_INVALIDA");
});

test("diagnóstico controlado reconhece exatamente a origem Render sem Referer", () => {
  const logs = [];
  const handler = createCsrfSameOriginProtection({
    env: {
      NODE_ENV: "production",
      APP_URL: `  ${APP_ORIGIN}/  `,
      CSRF_ORIGIN_DIAGNOSTICS: "true",
    },
    logger: {
      info: (...items) => logs.push(items),
      warn: (...items) => logs.push(items),
    },
  });
  const result = execute(handler, request({
    method: "POST",
    path: "/admin/categorias",
    origin: `  ${APP_ORIGIN}  `,
    referer: undefined,
  }));
  assert.equal(result.passed, true);
  const diagnostic = logs.find(items => items[0] === "csrf_origin_diagnostic")?.[1];
  assert.equal(diagnostic.originNormalizada, APP_ORIGIN);
  assert.equal(diagnostic.appOriginNormalizada, APP_ORIGIN);
  assert.equal(diagnostic.allowedOriginsCount, 1);
  assert.equal(diagnostic.matched, true);
  assert.equal(diagnostic.originRawType, "string");
  assert.ok(diagnostic.originRawLength > APP_ORIGIN.length);
});

test("todas as famílias administrativas passam com Origin Render e CSRF válidos", () => {
  const paths = [
    "/admin/categorias",
    "/admin/mesas",
    "/admin/funcionarios",
    "/admin/produtos",
    "/admin/estoque",
    "/admin/configuracoes",
    "/admin/pedidos/id/status",
    "/admin/agente/pedidos/id/imprimir",
    "/admin/mercado-pago/conectar",
    "/login/logout",
  ];
  const handler = middleware();
  for (const requestPath of paths) {
    const valid = input => execute(handler, request({
      method: "POST",
      path: requestPath,
      ...input,
    }));
    assert.equal(valid({ origin: APP_ORIGIN }).passed, true, requestPath);
    assert.equal(valid({ origin: APP_ORIGIN, supplied: null }).res.statusCode, 403);
    assert.equal(valid({ origin: APP_ORIGIN, supplied: "inválido" }).res.statusCode, 403);
    assert.equal(valid({ origin: "https://evil.example" }).res.statusCode, 403);
    assert.equal(valid({ referer: `${APP_ORIGIN}/admin` }).passed, true);
    assert.equal(valid({}).res.statusCode, 403);
  }
});

test("aliases GET são redirects protegidos e não possuem controller mutável", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../route.js"), "utf8");
  for (const requestPath of ADMIN_PATHS.slice(1, 11)) {
    if (requestPath === "/admin/pedidos") continue;
    assert.match(source, new RegExp(
      `route\\.get\\(\\s*['"]${requestPath.replaceAll("/", "\\/")}`,
    ));
  }
  assert.match(source, /route\.use\('\/admin', csrfSameOriginProtection\)/);
  const aliases = source.slice(
    source.indexOf("const redirectAdminSection"),
    source.indexOf("route.get(\n  '/admin/api/pedidos"),
  );
  assert.doesNotMatch(aliases, /\badmin\.[A-Za-z]/);
  const categoryGet = source.slice(
    source.indexOf("route.get(\n  '/admin/categorias'"),
    source.indexOf("route.post(\n  '/admin/categorias'"),
  );
  assert.match(categoryGet, /redirectAdminSection\('estoque'\)/);
  assert.doesNotMatch(categoryGet, /\badmin\.[A-Za-z]/);
});

test("trust proxy precede sessão e rotas na configuração do servidor", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const trust = source.indexOf('app.set("trust proxy", 1)');
  const session = source.indexOf("app.use(sessionMiddleware)");
  const routes = source.indexOf("app.use(route)");
  assert.ok(trust >= 0 && trust < session && session < routes);
  assert.doesNotMatch(
    fs.readFileSync(path.resolve(__dirname, "../src/middleware/csrf.js"), "utf8"),
    /x-forwarded-proto/i,
  );
});

test("middleware real é montado globalmente antes das rotas administrativas", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../route.js"), "utf8");
  const globalOrigin = source.indexOf("route.use('/admin', csrfSameOriginProtection)");
  const mercadoPago = source.indexOf("route.post('/admin/mercado-pago/conectar'");
  const adminPage = source.indexOf("route.get(\n  '/admin'");
  assert.ok(globalOrigin >= 0);
  assert.ok(globalOrigin < mercadoPago);
  assert.ok(globalOrigin < adminPage);
  assert.match(source, /route\.use\('\/assinatura', csrfSameOriginProtection\)/);
  const mutableAdminRoutes = [
    ...source.matchAll(/route\.(?:post|put|patch|delete)\(\s*['"](\/admin[^'"]*)['"]/g),
  ];
  assert.ok(mutableAdminRoutes.length >= 20);
  for (const routeMatch of mutableAdminRoutes) {
    assert.ok(routeMatch.index > globalOrigin, routeMatch[1]);
  }
});

test("frontend administrativo usa rotas relativas, credentials e token CSRF", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../src/views/admin-real.ejs"),
    "utf8",
  );
  assert.match(source, /function adminFetch/);
  assert.match(source, /headers\.set\('X-CSRF-Token', adminCsrfToken\)/);
  assert.match(source, /credentials:\s*'same-origin'/);
  assert.match(source, /input\.name = '_csrf'/);
  assert.doesNotMatch(source, /fetch\(\s*['"]https?:\/\/[^'"]+\/admin/i);
  assert.doesNotMatch(source, /fetch\(\s*['"]http:\/\/localhost/i);
  assert.equal(
    [...source.matchAll(/\bfetch\(/g)].length,
    1,
    "somente window.fetch dentro do helper central deve permanecer",
  );
  for (const match of source.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    if (!/method\s*=\s*["']POST["']/i.test(match[0])) continue;
    assert.match(match[0], /name\s*=\s*["']_csrf["']/i);
    assert.match(match[0], /<button\b[^>]*type\s*=\s*["']submit["']/i);
    const action = match[0].match(/action\s*=\s*["']([^"']+)/i)?.[1] || "";
    assert.ok(!action || action.startsWith("/"), action);
    assert.doesNotMatch(action, /^\/\//);
  }
});

test("logout, início OAuth e descoberta de rede não permanecem em GET", () => {
  const route = fs.readFileSync(path.resolve(__dirname, "../route.js"), "utf8");
  for (const requestPath of [
    "/login/logout",
    "/admin/mercado-pago/conectar",
    "/admin/agente/network/scan",
  ]) {
    const escaped = requestPath.replaceAll("/", "\\/");
    assert.match(route, new RegExp(`route\\.post\\(\\s*['"]${escaped}`));
    assert.doesNotMatch(route, new RegExp(`route\\.get\\(\\s*['"]${escaped}`));
  }
});
