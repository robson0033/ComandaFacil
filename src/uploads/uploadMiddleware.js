"use strict";

const multer = require("multer");
const { getUploadPolicy } = require("./uploadPolicy");

function createImageUpload(category) {
  const policy = getUploadPolicy(category);
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: policy.maxBytes, files: 1 },
  }).single(policy.field);
}

function imageUploadErrorHandler(error, req, res, next) {
  if (!error) return next();
  if (
    error instanceof multer.MulterError
    && ["LIMIT_FILE_SIZE", "LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"]
      .includes(error.code)
  ) {
    return res.status(413).json({
      code: "IMAGEM_MUITO_GRANDE",
      message: "A imagem excede o limite permitido.",
    });
  }
  return next(error);
}

module.exports = { createImageUpload, imageUploadErrorHandler };
