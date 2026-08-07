"use strict";

const MEBIBYTE = 1024 * 1024;

const UPLOAD_POLICIES = Object.freeze({
  produto: Object.freeze({
    field: "imagem",
    maxBytes: 5 * MEBIBYTE,
    maxWidth: 4096,
    maxHeight: 4096,
    maxPixels: 16_000_000,
    output: "webp",
  }),
  capa: Object.freeze({
    field: "capa",
    maxBytes: 8 * MEBIBYTE,
    maxWidth: 5000,
    maxHeight: 3000,
    maxPixels: 15_000_000,
    output: "webp",
  }),
  perfil: Object.freeze({
    field: "fotoPerfil",
    maxBytes: 3 * MEBIBYTE,
    maxWidth: 3000,
    maxHeight: 3000,
    maxPixels: 9_000_000,
    output: "webp",
  }),
  funcionario: Object.freeze({
    field: "foto",
    maxBytes: 3 * MEBIBYTE,
    maxWidth: 3000,
    maxHeight: 3000,
    maxPixels: 9_000_000,
    output: "webp",
  }),
});

const ALLOWED_INPUT_FORMATS = Object.freeze(["jpeg", "png", "webp"]);

function getUploadPolicy(category) {
  const policy = UPLOAD_POLICIES[category];
  if (!policy) throw new Error(`Categoria de upload inválida: ${category}`);
  return policy;
}

module.exports = {
  ALLOWED_INPUT_FORMATS,
  UPLOAD_POLICIES,
  getUploadPolicy,
};
