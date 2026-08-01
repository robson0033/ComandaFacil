"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractMercadoPagoProviderDetails,
  sanitizeMercadoPagoError,
} = require("../src/middleware/mercadoPagoSecurity");

test("extrai código, mensagem e causas da resposta do Mercado Pago", () => {
  const details = extractMercadoPagoProviderDetails({
    code: "bad_request",
    message: "Application fee is not allowed",
    cause: [
      { code: 1234, description: "Invalid application_fee" },
    ],
  });

  assert.deepEqual(details, {
    providerCode: "bad_request",
    providerMessage: "Application fee is not allowed",
    providerCauses: [
      { code: "1234", description: "Invalid application_fee" },
    ],
  });
});

test("aceita formatos alternativos sem vazar conteúdo extra", () => {
  const details = extractMercadoPagoProviderDetails({
    error: "invalid_request",
    error_description: "Invalid payer",
    causes: [{ type: "payer", message: "Email invalid" }],
  });

  assert.equal(details.providerCode, "invalid_request");
  assert.equal(details.providerMessage, "Invalid payer");
  assert.deepEqual(details.providerCauses, [
    { code: "payer", description: "Email invalid" },
  ]);
});

test("sanitização preserva diagnóstico HTTP recebido", () => {
  const error = new Error("Application fee is not allowed");
  error.name = "MercadoPagoHttpError";
  error.httpStatus = 400;
  error.status = 400;
  error.code = "bad_request";
  error.responseReceived = true;
  error.endpointPath = "/v1/payments";
  error.providerResponse = {
    providerCode: "bad_request",
    providerMessage: "Application fee is not allowed",
    providerCauses: [
      { code: "1234", description: "Invalid application_fee" },
    ],
  };

  const result = sanitizeMercadoPagoError(error);
  assert.equal(result.status, 400);
  assert.equal(result.responseReceived, true);
  assert.equal(result.providerCode, "bad_request");
  assert.equal(result.providerMessage, "Application fee is not allowed");
  assert.deepEqual(result.providerCauses, [
    { code: "1234", description: "Invalid application_fee" },
  ]);
});
