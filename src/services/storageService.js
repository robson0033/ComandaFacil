"use strict";

const crypto = require("crypto");
const { LocalStorageAdapter } = require("./storage/LocalStorageAdapter");
const { ExternalStorageAdapter } = require("./storage/ExternalStorageAdapter");
const {
  CloudinaryStorageAdapter,
  StorageError,
} = require("./storage/CloudinaryStorageAdapter");

const SEGMENTS = new Set(["produtos", "funcionarios", "perfil"]);
let adapterOverride = null;
let adapterInstance = null;

function configError(message) {
  return new StorageError("STORAGE_CONFIG_INVALIDA", message, {
    statusCode: 500,
  });
}

function storageConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const driver = String(env.STORAGE_DRIVER || (production ? "" : "local"))
    .trim()
    .toLowerCase();
  if (production && driver === "local") {
    throw configError(
      "STORAGE_DRIVER local é proibido em produção.",
    );
  }
  if (!["local", "cloudinary", "external"].includes(driver)) {
    throw configError("STORAGE_DRIVER deve ser local, cloudinary ou external.");
  }
  if (driver === "cloudinary") {
    const missing = [
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
    ].filter(name => !String(env[name] || "").trim());
    if (missing.length) {
      throw configError(`Configuração de storage inválida: ${missing.join(", ")}`);
    }
  }
  if (driver === "external" && !/^https:\/\//i.test(env.STORAGE_EXTERNAL_BASE_URL || "")) {
    throw configError("STORAGE_EXTERNAL_BASE_URL HTTPS é obrigatória.");
  }
  const provider = String(env.STORAGE_EXTERNAL_PROVIDER || "").trim().toLowerCase();
  if (driver === "external" && !["s3", "cloudinary"].includes(provider)) {
    throw configError("STORAGE_EXTERNAL_PROVIDER deve ser s3 ou cloudinary.");
  }
  const adapterModule = String(env.STORAGE_EXTERNAL_ADAPTER_MODULE || "").trim();
  if (driver === "external" && !adapterModule) {
    throw configError(
      "STORAGE_EXTERNAL_ADAPTER_MODULE é obrigatório para habilitar o storage externo.",
    );
  }
  return {
    driver,
    baseUrl: env.STORAGE_EXTERNAL_BASE_URL,
    provider,
    adapterModule,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  };
}

function createAdapter(config = storageConfig()) {
  if (adapterOverride) return adapterOverride;
  if (config.driver === "local") return new LocalStorageAdapter();
  if (config.driver === "cloudinary") {
    const cloudinary = require("cloudinary").v2;
    return new CloudinaryStorageAdapter({
      cloudinary,
      cloudName: config.cloudName,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
    });
  }
  const implementation = require(config.adapterModule);
  const client = typeof implementation.createStorageClient === "function"
    ? implementation.createStorageClient({ provider: config.provider })
    : implementation;
  for (const method of ["save", "remove", "exists"]) {
    if (typeof client?.[method] !== "function") {
      throw configError(`Adaptador externo não implementa ${method}().`);
    }
  }
  return new ExternalStorageAdapter({
    baseUrl: config.baseUrl,
    provider: config.provider,
    client,
  });
}

function getAdapter() {
  if (adapterOverride) return adapterOverride;
  if (!adapterInstance) adapterInstance = createAdapter();
  return adapterInstance;
}

function initializeStorage(env = process.env) {
  const config = storageConfig(env);
  if (!adapterOverride) adapterInstance = createAdapter(config);
  return {
    driver: config.driver,
    provider: config.driver === "cloudinary"
      ? "cloudinary"
      : (config.provider || config.driver),
  };
}

function tenantId(value) {
  const id = String(value || "");
  if (!/^[a-f\d]{24}$/i.test(id)) {
    throw new StorageError(
      "STORAGE_TENANT_INVALIDO",
      "Contexto de estabelecimento inválido.",
      { statusCode: 403 },
    );
  }
  return id.toLowerCase();
}

function buildStorageKey({ estabelecimentoId, resource, extension = "webp" }) {
  if (!SEGMENTS.has(resource) || extension !== "webp") {
    throw new StorageError(
      "STORAGE_TENANT_INVALIDO",
      "Contexto de imagem inválido.",
      { statusCode: 403 },
    );
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
  const result = await adapter.save(key, buffer, {
    estabelecimentoId: context.estabelecimentoId,
    contentType: "image/webp",
    cacheControl: "public, max-age=31536000, immutable",
  });
  return {
    storageKey: key,
    url: result?.url || adapter.publicUrl(key),
    mimeType: result?.mimeType || "image/webp",
    largura: result?.largura,
    altura: result?.altura,
    tamanho: result?.tamanho || buffer.length,
    provider: result?.provider || "local",
  };
}

async function removeImage(key, { estabelecimentoId } = {}) {
  if (!key) return;
  const prefix = `estabelecimentos/${tenantId(estabelecimentoId)}/`;
  if (!String(key).startsWith(prefix)) {
    throw new StorageError(
      "STORAGE_TENANT_INVALIDO",
      "A imagem não pertence ao estabelecimento.",
      { statusCode: 403 },
    );
  }
  await getAdapter().remove(key, { estabelecimentoId });
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
  adapterInstance = null;
}

module.exports = {
  buildStorageKey,
  createAdapter,
  imageExists,
  listKeys,
  initializeStorage,
  existe: imageExists,
  obterUrlPublica: publicImageUrl,
  publicImageUrl,
  removerImagem: removeImage,
  removeImage,
  salvarImagem: saveImage,
  saveImage,
  setAdapterForTests,
  storageConfig,
  StorageError,
};
