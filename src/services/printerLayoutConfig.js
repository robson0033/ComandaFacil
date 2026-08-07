"use strict";

const DEFAULT_RIGHT_MARGIN_MM = 2;
const MAX_RIGHT_MARGIN_MM = 20;

function normalizeRightMarginMm(value, { fallback = DEFAULT_RIGHT_MARGIN_MM } = {}) {
  const candidate = value === undefined || value === null || value === ""
    ? fallback
    : value;
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed)) {
    const error = new Error("Espaçamento da direita inválido.");
    error.code = "VALIDATION_ERROR";
    error.statusCode = 422;
    throw error;
  }
  if (parsed < 0 || parsed > MAX_RIGHT_MARGIN_MM) {
    const error = new Error("O espaçamento da direita deve estar entre 0 e 20 mm.");
    error.code = "VALIDATION_ERROR";
    error.statusCode = 422;
    throw error;
  }
  return Math.round(parsed * 10) / 10;
}

function normalizePrinterLayoutConfig(config = {}) {
  return {
    ...config,
    margemDireitaMm: normalizeRightMarginMm(config.margemDireitaMm),
  };
}

module.exports = {
  DEFAULT_RIGHT_MARGIN_MM,
  MAX_RIGHT_MARGIN_MM,
  normalizePrinterLayoutConfig,
  normalizeRightMarginMm,
};
