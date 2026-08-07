"use strict";

const mongoose = require("mongoose");

const DEFAULT_BATCH_SIZE = 200;
const MAX_GROUPS = 100;

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function technicalId(value) {
  return value == null ? "" : String(value);
}

function duplicateKey(product) {
  return [
    technicalId(product.estabelecimentoId),
    normalizeName(product.nome),
    technicalId(product.categoriaId),
    Number(product.preco || 0).toFixed(2),
  ].join("|");
}

async function auditProducts({
  source,
  batchSize = DEFAULT_BATCH_SIZE,
  maxGroups = MAX_GROUPS,
} = {}) {
  const groups = new Map();
  let analyzed = 0;
  let active = 0;
  const returnedIds = [];
  let cursor = "";

  for (;;) {
    const batch = await source.nextBatch({ afterId: cursor, limit: batchSize });
    if (!batch.length) break;
    analyzed += batch.length;
    for (const product of batch) {
      if (product.ativo !== false) {
        active += 1;
        returnedIds.push(technicalId(product._id));
      }
      const key = duplicateKey(product);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        _id: technicalId(product._id),
        estabelecimentoId: technicalId(product.estabelecimentoId),
        nomeNormalizado: normalizeName(product.nome),
        categoriaId: technicalId(product.categoriaId),
        preco: Number(product.preco || 0),
        imagem: String(product.imagem || ""),
        storageKey: String(product.imagemArquivo?.storageKey || ""),
        ativo: product.ativo !== false,
        createdAt: product.createdAt || null,
        updatedAt: product.updatedAt || null,
      });
    }
    cursor = technicalId(batch.at(-1)._id);
    if (batch.length < batchSize) break;
  }

  const duplicates = [...groups.values()]
    .filter(group => group.length > 1)
    .slice(0, maxGroups);
  return {
    analyzed,
    active,
    publicQueryTotal: returnedIds.length,
    publicQueryIds: returnedIds,
    repeatedIdsInPublicResult: returnedIds.filter(
      (id, index) => returnedIds.indexOf(id) !== index,
    ),
    duplicateGroups: duplicates.length,
    truncated: [...groups.values()].filter(group => group.length > 1).length
      > duplicates.length,
    duplicates,
  };
}

function mongoSource(Produto, baseFilter = {}) {
  return {
    async nextBatch({ afterId, limit }) {
      const filter = {
        ...baseFilter,
        ...(afterId
          ? { _id: { $gt: new mongoose.Types.ObjectId(afterId) } }
          : {}),
      };
      return Produto.find(filter)
        .select(
          "_id estabelecimentoId nome categoriaId preco imagem "
          + "imagemArquivo.storageKey ativo createdAt updatedAt",
        )
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
    },
  };
}

async function main({
  env = process.env,
  connect = mongoose.connect.bind(mongoose),
  disconnect = mongoose.disconnect.bind(mongoose),
  logger = console,
} = {}) {
  if (env.ALLOW_READONLY_AUDIT !== "true") {
    logger.error(
      "Auditoria bloqueada. Defina ALLOW_READONLY_AUDIT=true explicitamente.",
    );
    return { exitCode: 2, connected: false };
  }
  const connectionString = String(env.CONNECTIONSTRING || "").trim();
  if (!connectionString) {
    logger.error("CONNECTIONSTRING não configurada.");
    return { exitCode: 2, connected: false };
  }

  await connect(connectionString);
  try {
    const {
      Configuracao,
      Produto,
    } = require("../src/models/painelModels");
    const requestedSlug = String(
      env.AUDIT_STORE_SLUG || "robson-do-carmo-barbosa-teixeira",
    ).trim();
    const configuracao = requestedSlug
      ? await Configuracao.findOne({ slug: requestedSlug })
        .select("_id estabelecimentoId slug")
        .lean()
      : null;
    if (requestedSlug && !configuracao) {
      logger.error(`Loja não encontrada para o slug técnico: ${requestedSlug}`);
      return { exitCode: 3, connected: true };
    }
    const baseFilter = configuracao
      ? { estabelecimentoId: configuracao.estabelecimentoId }
      : {};
    const report = await auditProducts({
      source: mongoSource(Produto, baseFilter),
    });
    report.store = configuracao
      ? {
          slug: configuracao.slug,
          estabelecimentoId: technicalId(configuracao.estabelecimentoId),
        }
      : null;
    logger.log(JSON.stringify(report, null, 2));
    return { exitCode: 0, connected: true, report };
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main()
    .then(result => {
      process.exitCode = result.exitCode;
    })
    .catch(error => {
      console.error("Auditoria falhou:", error?.message || "erro desconhecido");
      process.exitCode = 1;
    });
}

module.exports = {
  auditProducts,
  duplicateKey,
  main,
  normalizeName,
};
