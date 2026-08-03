"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyRequestBodyError,
  requestBodyErrorHandler,
  requestWantsJson,
} = require("../src/middleware/requestBodyErrors");

function fakeResponse() {
  return {
    headers: {},
    headersSent: false,
    statusCode: 200,
    payload: null,
    contentType: "",
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.payload = value; return this; },
  };
}

function fakeRequest(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    correlationId: "CORRELATION",
    method: "POST",
    path: "/catalogo/loja/pedidos",
    xhr: false,
    get(name) { return normalized[String(name).toLowerCase()] || ""; },
  };
}

test("classifica payload grande e JSON malformado sem vazar o conteúdo", () => {
  assert.deepEqual(classifyRequestBodyError({
    status: 413,
    type: "entity.too.large",
  }), {
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    message: "A solicitação ultrapassou o limite permitido.",
  });

  assert.deepEqual(classifyRequestBodyError({
    status: 413,
    type: "parameters.too.many",
  }), {
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
    message: "A solicitação ultrapassou o limite permitido.",
  });

  assert.deepEqual(classifyRequestBodyError({
    status: 400,
    type: "entity.parse.failed",
  }), {
    status: 400,
    code: "PAYLOAD_INVALID",
    message: "Os dados enviados estão em formato inválido.",
  });

  assert.equal(classifyRequestBodyError(new Error("outro erro")), null);
});

test("responde 413 JSON controlado e no-store", () => {
  const req = fakeRequest({
    accept: "application/json",
    "content-type": "application/json",
  });
  const res = fakeResponse();
  let forwarded = null;

  requestBodyErrorHandler(
    { status: 413, type: "entity.too.large" },
    req,
    res,
    error => { forwarded = error; },
  );

  assert.equal(forwarded, null);
  assert.equal(res.statusCode, 413);
  assert.equal(res.payload.code, "PAYLOAD_TOO_LARGE");
  assert.equal(res.payload.correlationId, "CORRELATION");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(JSON.stringify(res.payload).includes("entity.too.large"), false);
});

test("responde texto controlado para formulário e encaminha erro desconhecido", () => {
  const htmlReq = fakeRequest({ accept: "text/html" });
  const htmlRes = fakeResponse();
  requestBodyErrorHandler(
    { status: 413, type: "parameters.too.many" },
    htmlReq,
    htmlRes,
    () => assert.fail("não deveria encaminhar"),
  );
  assert.equal(htmlRes.statusCode, 413);
  assert.equal(typeof htmlRes.payload, "string");
  assert.match(htmlRes.payload, /limite permitido/);

  const unknown = new Error("falha desconhecida");
  let forwarded = null;
  requestBodyErrorHandler(
    unknown,
    htmlReq,
    fakeResponse(),
    error => { forwarded = error; },
  );
  assert.equal(forwarded, unknown);
});

test("detecta JSON por Accept, Content-Type ou XHR", () => {
  assert.equal(requestWantsJson(fakeRequest({ accept: "application/json" })), true);
  assert.equal(requestWantsJson(fakeRequest({ "content-type": "application/json" })), true);
  const xhr = fakeRequest({});
  xhr.xhr = true;
  assert.equal(requestWantsJson(xhr), true);
  assert.equal(requestWantsJson(fakeRequest({ accept: "text/html" })), false);
});
