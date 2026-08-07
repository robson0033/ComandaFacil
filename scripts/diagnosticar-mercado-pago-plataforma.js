#!/usr/bin/env node
"use strict";

require("dotenv").config();
const {
  validatePlatformAccount,
  validatePlatformPaymentConfig,
} = require("../src/services/mercadoPagoPlatformService");

async function main() {
  if (process.env.ALLOW_MP_DIAGNOSTIC !== "true") {
    console.error("Diagnóstico bloqueado. Defina ALLOW_MP_DIAGNOSTIC=true para executar somente a consulta /users/me.");
    process.exitCode = 2;
    return;
  }
  const config = validatePlatformPaymentConfig();
  console.log(JSON.stringify({
    operation: "mercado_pago_platform_diagnostic",
    configOk: config.ok,
    missing: config.missing,
    codes: config.codes,
  }));
  if (!config.ok) {
    process.exitCode = 1;
    return;
  }
  try {
    await validatePlatformAccount({ force: true });
    console.log(JSON.stringify({
      operation: "mercado_pago_platform_diagnostic",
      endpointPath: "/users/me",
      httpStatus: 200,
      accountMatches: true,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      operation: "mercado_pago_platform_diagnostic",
      endpointPath: "/users/me",
      httpStatus: Number(error.httpStatus || error.status || 0) || null,
      code: String(error.code || "PLATFORM_MP_DIAGNOSTIC_FAILED"),
      accountMatches: error.code === "PLATFORM_ACCOUNT_MISMATCH" ? false : null,
    }));
    process.exitCode = 1;
  }
}

main();
