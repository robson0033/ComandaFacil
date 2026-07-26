"use strict";

const crypto = require("crypto");
const { LocalStorageAdapter } = require("./storage/LocalStorageAdapter");
const { ExternalStorageAdapter } = require("./storage/ExternalStorageAdapter");

const SEGMENTS = new Set(["produtos", "funcionarios", "perfil"]);
let adapterOverride = null;

function storageConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const driver = String(env.STORAGE_DRIVER || (production ? "" : "local"))
    .trim()
    .toLowerCase();
  if (production && driver !== "external") {
    throw new Error(
      "STORAGE_DRIVER=external é obrigatório em produção; disco local não é persistente.",
    );
  }
  if (!["local", "external"].includes(driver)) {
    throw new Error("STORAGE_DRIVER deve ser local ou external.");
  }
  if (driver === "external" && !/^https:\/\//i.test(env.STORAGE_EXTERNAL_BASE_URL || "")) {
    throw new Error("STORAGE_EXTERNAL_BASE_URL HTTPS é obrigatória.");
  }
  const provider = String(env.STORAGE_EXTERNAL_PROVIDER || "").trim().toLowerCase();
  if (driver === "external" && !["s3", "cloudinary"].includes(provider)) {
    throw new Error("STORAGE_EXTERNAL_PROVIDER deve ser s3 ou cloudinary.");
  }
  const adapterModule = String(env.STORAGE_EXTERNAL_ADAPTER_MODULE || "").trim();
  if (driver === "external" && !adapterModule) {
    throw new Error(
      "STORAGE_EXTERNAL_ADAPTER_MODULE é obrigatório para habilitar o storage externo.",
    );
  }
  return {
    driver,
    baseUrl: env.STORAGE_EXTERNAL_BASE_URL,
    provider,
    adapterModule,
  };
}

function getAdapter() {
  if (adapterOverride) return adapterOverride;
  const config = storageConfig();
  if (config.driver === "local") return new LocalStorageAdapter();
  const implementation = require(config.adapterModule);
  const client = typeof implementation.createStorageClient === "function"
    ? implementation.createStorageClient({ provider: config.provider })
    : implementation;
  for (const method of ["save", "remove", "exists"]) {
    if (typeof client?.[method] !== "function") {
      throw new Error(`Adaptador externo não implementa ${method}().`);
    }
  }
  return new ExternalStorageAdapter({
    baseUrl: config.baseUrl,
    provider: config.provider,
    client,
  });
}

function tenantId(value) {
  const id = String(value || "");
  if (!/^[a-f\d]{24}$/i.test(id)) {
    throw new Error("Contexto de estabelecimento inválido.");
  }
  return id.toLowerCase();
}

function buildStorageKey({ estabelecimentoId, resource, extension = "webp" }) {
  if (!SEGMENTS.has(resource) || extension !== "webp") {
    throw new Error("Contexto de imagem inválido.");
  }
  return [
    "estabelecimentos",
    tenantId(estabelecimentoId),
    resource,
    `${crypto.randomUUID()}.webp`,
  ].join("/");
}

async function saveImage(buffer, context) {
  const key = buildStorageKey(context);
  const adapter = getAdapter();
  await adapter.save(key, buffer, {
    contentType: "image/webp",
    cacheControl: "public, max-age=31536000, immutable",
  });
  return { storageKey: key, url: adapter.publicUrl(key) };
}

async function removeImage(key, { estabelecimentoId } = {}) {
  if (!key) return;
  const prefix = `estabelecimentos/${tenantId(estabelecimentoId)}/`;
  if (!String(key).startsWith(prefix)) {
    throw new Error("A imagem não pertence ao estabelecimento.");
  }
  await getAdapter().remove(key);
}

async function imageExists(key) {
  return getAdapter().exists(key);
}

function publicImageUrl(key) {
  return getAdapter().publicUrl(key);
}

async function listKeys() {
  const adapter = getAdapter();
  if (typeof adapter.listKeys !== "function") {
    throw new Error("Listagem não suportada pelo adaptador configurado.");
  }
  return adapter.listKeys();
}

function setAdapterForTests(adapter) {
  adapterOverride = adapter || null;
}

module.exports = {
  buildStorageKey,
  imageExists,
  listKeys,
  existe: imageExists,
  obterUrlPublica: publicImageUrl,
  publicImageUrl,
  removerImagem: removeImage,
  removeImage,
  salvarImagem: saveImage,
  saveImage,
  setAdapterForTests,
  storageConfig,
};
