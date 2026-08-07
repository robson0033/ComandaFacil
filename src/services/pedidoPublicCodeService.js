"use strict";

const crypto = require("crypto");

const PUBLIC_CODE_PATTERN = /^[A-F0-9]{8}$/;
const FINAL_CODE_PATTERN = /^[A-F0-9]{4}$/;

function gerarCodigoPublico() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function normalizarCodigoPublico(value) {
  return String(value || "").trim().toUpperCase();
}

function codigoFinal(value) {
  return normalizarCodigoPublico(value).slice(-4);
}

function codigoPublicoValido(value) {
  return PUBLIC_CODE_PATTERN.test(normalizarCodigoPublico(value));
}

function codigoFinalValido(value) {
  return FINAL_CODE_PATTERN.test(normalizarCodigoPublico(value));
}

module.exports = {
  PUBLIC_CODE_PATTERN,
  codigoFinal,
  codigoFinalValido,
  codigoPublicoValido,
  gerarCodigoPublico,
  normalizarCodigoPublico,
};
