"use strict";

const { logger: appLogger } = require("../utils/logger");

const { Produto } = require("../models/painelModels");

function uniqueProductsById(items, {
  estabelecimentoId,
  source = "public_catalog",
  logger = appLogger,
} = {}) {
  const seen = new Set();
  const unique = [];

  for (const item of Array.isArray(items) ? items : []) {
    const produtoId = String(item?._id || "");
    if (!produtoId) continue;
    if (seen.has(produtoId)) {
      logger.warn({
        code: "DUPLICATE_PRODUCT_IN_RESULT",
        produtoId,
        estabelecimentoId: String(estabelecimentoId || ""),
        source,
      });
      continue;
    }
    seen.add(produtoId);
    unique.push(item);
  }
  return unique;
}

async function buscarProdutosPublicosDoEstabelecimento(
  estabelecimentoId,
  {
    source = "public_catalog",
    model = Produto,
    logger = appLogger,
  } = {},
) {
  if (!estabelecimentoId) return [];
  const products = await model.find({
    estabelecimentoId,
    ativo: true,
  })
    .populate("categoriaId", "nome tipo")
    .sort({ nome: 1, _id: 1 })
    .lean();

  return uniqueProductsById(products, {
    estabelecimentoId,
    source,
    logger,
  });
}

module.exports = {
  buscarProdutosPublicosDoEstabelecimento,
  uniqueProductsById,
};
