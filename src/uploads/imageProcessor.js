"use strict";

const sharp = require("sharp");
const { ALLOWED_INPUT_FORMATS, getUploadPolicy } = require("./uploadPolicy");

class UploadError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.status = status;
  }
}

function invalidFormat() {
  return new UploadError(
    "FORMATO_IMAGEM_INVALIDO",
    "Envie uma imagem PNG, JPEG ou WebP válida.",
    415,
  );
}

async function processImage(buffer, category) {
  const policy = getUploadPolicy(category);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalidFormat();
  if (buffer.length > policy.maxBytes) {
    throw new UploadError(
      "IMAGEM_MUITO_GRANDE",
      "A imagem excede o tamanho permitido.",
      413,
    );
  }

  let metadata;
  try {
    metadata = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: policy.maxPixels,
      sequentialRead: true,
    }).metadata();
  } catch (error) {
    if (/pixel limit/i.test(String(error?.message || ""))) {
      throw new UploadError(
        "DIMENSOES_IMAGEM_EXCESSIVAS",
        "As dimensões da imagem excedem o limite permitido.",
        413,
      );
    }
    throw invalidFormat();
  }

  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (
    !ALLOWED_INPUT_FORMATS.includes(metadata.format)
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
  ) {
    throw invalidFormat();
  }
  if (
    width > policy.maxWidth
    || height > policy.maxHeight
    || width * height > policy.maxPixels
  ) {
    throw new UploadError(
      "DIMENSOES_IMAGEM_EXCESSIVAS",
      "As dimensões da imagem excedem o limite permitido.",
      413,
    );
  }

  try {
    const output = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: policy.maxPixels,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: policy.maxWidth,
        height: policy.maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: output.data,
      mimeType: "image/webp",
      width: output.info.width,
      height: output.info.height,
      size: output.info.size,
      extension: "webp",
    };
  } catch {
    throw invalidFormat();
  }
}

module.exports = { UploadError, processImage };
