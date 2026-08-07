"use strict";

const BATCH_SIZE = 200;
const EXAMPLE_LIMIT = 20;

function createReport() {
  return {
    totalDocumentos: 0,
    providers: { local: 0, cloudinary: 0, external: 0, legado: 0 },
    problemas: {
      legado_data_url: { quantidade: 0, exemplos: [] },
      legado_url: { quantidade: 0, exemplos: [] },
      legado_caminho_local: { quantidade: 0, exemplos: [] },
      documento_sem_storage_key: { quantidade: 0, exemplos: [] },
      storage_key_inexistente: { quantidade: 0, exemplos: [] },
      arquivo_orfao: { quantidade: 0, exemplos: [] },
      provider_invalido: { quantidade: 0, exemplos: [] },
      url_incompativel: { quantidade: 0, exemplos: [] },
    },
  };
}

function addIssue(report, type, document) {
  const issue = report.problemas[type];
  issue.quantidade += 1;
  if (issue.exemplos.length < EXAMPLE_LIMIT) {
    issue.exemplos.push({
      id: String(document._id || document.storageKey || ""),
      estabelecimentoId: String(document.estabelecimentoId || ""),
      ...(document.storageKey ? { storageKey: String(document.storageKey) } : {}),
    });
  }
}

function classifyLegacy(value) {
  if (!value) return null;
  if (/^data:image\//i.test(value)) return "legado_data_url";
  if (/^https?:\/\//i.test(value)) return "legado_url";
  return "legado_caminho_local";
}

async function forEachBatch(model, projection, callback) {
  let lastId = null;
  for (;;) {
    const filter = lastId ? { _id: { $gt: lastId } } : {};
    const rows = await model.find(filter)
      .select(projection)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();
    if (!rows.length) return;
    for (const row of rows) await callback(row);
    lastId = rows[rows.length - 1]._id;
  }
}

async function auditUploads({ models, storage, output = console.log }) {
  const report = createReport();
  const referenced = new Set();
  const definitions = [
    [models.Produto, "imagem imagemArquivo estabelecimentoId", "imagem", "imagemArquivo"],
    [models.Funcionario, "foto fotoArquivo estabelecimentoId", "foto", "fotoArquivo"],
    [
      models.Configuracao,
      "fotoPerfil fotoPerfilArquivo estabelecimentoId",
      "fotoPerfil",
      "fotoPerfilArquivo",
    ],
  ];

  for (const [model, projection, legacyField, metadataField] of definitions) {
    await forEachBatch(model, projection, async document => {
      report.totalDocumentos += 1;
      const metadata = document[metadataField];
      if (metadata?.storageKey) {
        const provider = String(metadata.provider || "local").toLowerCase();
        if (provider in report.providers) report.providers[provider] += 1;
        else addIssue(report, "provider_invalido", document);
        const url = String(metadata.url || "");
        const urlCompativel = provider === "local"
          ? url.startsWith("/uploads/")
          : /^https:\/\//i.test(url);
        if (!urlCompativel) addIssue(report, "url_incompativel", document);
        referenced.add(metadata.storageKey);
        if (!(await storage.imageExists(metadata.storageKey))) {
          addIssue(report, "storage_key_inexistente", {
            ...document,
            storageKey: metadata.storageKey,
          });
        }
      } else if (metadata) {
        addIssue(report, "documento_sem_storage_key", document);
      }
      if (!metadata?.storageKey && document[legacyField]) {
        report.providers.legado += 1;
        addIssue(report, classifyLegacy(document[legacyField]), document);
      }
    });
  }

  try {
    for (const key of await storage.listKeys()) {
      if (!referenced.has(key)) {
        const match = /^estabelecimentos\/([^/]+)\//.exec(key);
        addIssue(report, "arquivo_orfao", {
          _id: key,
          storageKey: key,
          estabelecimentoId: match?.[1] || "",
        });
      }
    }
  } catch (error) {
    report.listagemStorage = "indisponivel";
  }

  output(JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  if (process.env.ALLOW_READONLY_AUDIT !== "true") {
    throw new Error(
      "Auditoria bloqueada. Execute somente com ALLOW_READONLY_AUDIT=true.",
    );
  }
  require("dotenv").config();
  const mongoose = require("mongoose");
  const models = require("../src/models/painelModels");
  const storage = require("../src/services/storageService");
  await mongoose.connect(process.env.CONNECTIONSTRING);
  try {
    await auditUploads({ models, storage });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  EXAMPLE_LIMIT,
  auditUploads,
  classifyLegacy,
  forEachBatch,
  main,
};
