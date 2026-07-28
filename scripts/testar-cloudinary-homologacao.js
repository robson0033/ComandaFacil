"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const FIXTURE_DIRECTORY = path.resolve(__dirname, "../test/fixtures");
const DEFAULT_FIXTURE = path.join(FIXTURE_DIRECTORY, "cloudinary-test.png");
const MAX_FIXTURE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class HomologacaoError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = "HomologacaoError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function validarAmbiente(env = {}, { reconciliation = false } = {}) {
  const invalid = [];
  const requiredFlag = reconciliation
    ? "ALLOW_EXTERNAL_STORAGE_RECONCILIATION"
    : "ALLOW_EXTERNAL_STORAGE_TEST";
  if (env[requiredFlag] !== "true") invalid.push(requiredFlag);
  if (env.NODE_ENV === "production") invalid.push("NODE_ENV");
  if (env.STORAGE_DRIVER !== "cloudinary") invalid.push("STORAGE_DRIVER");
  for (const name of [
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ]) {
    if (!String(env[name] || "").trim()) invalid.push(name);
  }
  if (!/^[a-f\d]{24}$/i.test(String(env.CLOUDINARY_TEST_ESTABELECIMENTO_ID || ""))) {
    invalid.push("CLOUDINARY_TEST_ESTABELECIMENTO_ID");
  }
  if (invalid.length) {
    throw new HomologacaoError(
      "HOMOLOGACAO_CONFIG_INVALIDA",
      `Configuração inválida: ${[...new Set(invalid)].sort().join(", ")}`,
      1,
    );
  }
  return {
    estabelecimentoId: String(env.CLOUDINARY_TEST_ESTABELECIMENTO_ID)
      .toLowerCase(),
    credentials: {
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      apiKey: env.CLOUDINARY_API_KEY,
      apiSecret: env.CLOUDINARY_API_SECRET,
    },
  };
}

function caminhoTemFormatoRemoto(value) {
  return /^[a-z][a-z\d+.-]*:/i.test(String(value || ""))
    || String(value || "").includes("\0");
}

async function validarFixture(fixturePath = DEFAULT_FIXTURE, {
  fsApi = fs,
  allowedDirectory = FIXTURE_DIRECTORY,
  maxBytes = MAX_FIXTURE_BYTES,
} = {}) {
  const informedPath = String(fixturePath || "");
  const informedSegments = informedPath.replace(/\\/g, "/").split("/");
  if (
    caminhoTemFormatoRemoto(informedPath)
    || informedPath.includes("\\")
    || informedSegments.includes("..")
  ) {
    throw new HomologacaoError(
      "FIXTURE_INVALIDA",
      "O arquivo de homologação é inválido.",
      1,
    );
  }
  const allowed = path.resolve(allowedDirectory);
  const resolved = path.resolve(String(fixturePath || ""));
  if (
    resolved !== allowed
    && !resolved.startsWith(`${allowed}${path.sep}`)
  ) {
    throw new HomologacaoError(
      "FIXTURE_FORA_DA_PASTA",
      "O arquivo precisa estar na pasta de fixtures permitida.",
      1,
    );
  }
  let realPath;
  let stats;
  try {
    realPath = await fsApi.realpath(resolved);
    stats = await fsApi.stat(realPath);
  } catch {
    throw new HomologacaoError(
      "FIXTURE_INEXISTENTE",
      "O arquivo de homologação não existe.",
      1,
    );
  }
  if (
    realPath !== allowed
    && !realPath.startsWith(`${allowed}${path.sep}`)
  ) {
    throw new HomologacaoError(
      "FIXTURE_FORA_DA_PASTA",
      "O arquivo precisa estar na pasta de fixtures permitida.",
      1,
    );
  }
  if (!stats.isFile() || stats.size < 1 || stats.size > maxBytes) {
    throw new HomologacaoError(
      "FIXTURE_TAMANHO_INVALIDO",
      "O arquivo de homologação excede o limite permitido.",
      1,
    );
  }
  return { path: realPath, size: stats.size };
}

function gerarStorageKey(estabelecimentoId, randomUUID = crypto.randomUUID) {
  const uuid = randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)
  ) {
    throw new HomologacaoError(
      "UUID_INVALIDO",
      "Não foi possível gerar uma chave técnica segura.",
      1,
    );
  }
  return `estabelecimentos/${estabelecimentoId}/testes/${uuid}.webp`;
}

function validarRespostaUpload(result, storageKey) {
  const expectedPublicId = storageKey.slice(0, -".webp".length);
  const valid = result?.provider === "cloudinary"
    && result.storageKey === storageKey
    && /^https:\/\//i.test(String(result.url || ""))
    && result.mimeType === "image/webp"
    && Number(result.largura) > 0
    && Number(result.altura) > 0
    && Number(result.tamanho) > 0
    && result.publicId === expectedPublicId
    && result.resourceType === "image"
    && result.format === "webp";
  if (!valid) {
    throw new HomologacaoError(
      "HOMOLOGACAO_RESPOSTA_INVALIDA",
      "O provedor retornou dados incompatíveis.",
      3,
    );
  }
  return result;
}

function safeLogger(logger = console) {
  return {
    info(message) {
      logger.info?.(String(message));
    },
    error(code, storageKey = "") {
      logger.error?.(
        `Homologação falhou: ${String(code || "ERRO_DESCONHECIDO")}`
        + (storageKey ? ` | storageKey=${storageKey}` : ""),
      );
    },
  };
}

async function executarHomologacao({
  env = process.env,
  fixturePath = DEFAULT_FIXTURE,
  fsApi = fs,
  processImage,
  createStorageAdapter,
  randomUUID = crypto.randomUUID,
  logger = console,
} = {}) {
  const log = safeLogger(logger);
  let storageKey = "";
  let adapter = null;
  let limpezaAutorizada = false;
  let limpezaConfirmada = false;
  let resultCode = 0;
  let originalCode = "";
  let cleanupCode = "";

  try {
    log.info("Iniciando homologação controlada do Cloudinary.");
    const config = validarAmbiente(env);
    const fixture = await validarFixture(fixturePath, { fsApi });
    const originalBuffer = await fsApi.readFile(fixture.path);
    if (
      originalBuffer.length < PNG_SIGNATURE.length
      || !originalBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      throw new HomologacaoError(
        "FIXTURE_PNG_INVALIDA",
        "A fixture descartável precisa ser uma imagem PNG.",
        2,
      );
    }

    let processed;
    try {
      processed = await processImage(originalBuffer, "produto");
    } catch {
      throw new HomologacaoError(
        "HOMOLOGACAO_PROCESSAMENTO_FALHOU",
        "A imagem descartável não pôde ser processada.",
        2,
      );
    }
    if (
      !Buffer.isBuffer(processed?.buffer)
      || processed.mimeType !== "image/webp"
      || processed.buffer === originalBuffer
    ) {
      throw new HomologacaoError(
        "HOMOLOGACAO_PROCESSAMENTO_FALHOU",
        "O processamento não gerou um WebP seguro.",
        2,
      );
    }
    log.info("Processamento da imagem aprovado.");

    storageKey = gerarStorageKey(config.estabelecimentoId, randomUUID);
    log.info(`storageKey=${storageKey}`);
    adapter = createStorageAdapter(config.credentials);

    let uploadResult;
    try {
      uploadResult = await adapter.save(storageKey, processed.buffer, {
        estabelecimentoId: config.estabelecimentoId,
        categoria: "testes",
        contexto: "homologacao_cloudinary",
      });
      limpezaAutorizada = true;
    } catch (error) {
      if (error?.code === "STORAGE_RESULTADO_DESCONHECIDO") {
        throw new HomologacaoError(
          "STORAGE_RESULTADO_DESCONHECIDO",
          "O upload precisa ser conciliado pela mesma storageKey.",
          4,
        );
      }
      throw new HomologacaoError(
        error?.code || "HOMOLOGACAO_UPLOAD_FALHOU",
        "O upload de homologação falhou.",
        3,
      );
    }

    const validated = validarRespostaUpload(uploadResult, storageKey);
    log.info(`provider=${validated.provider}`);
    log.info(`dimensoes=${validated.largura}x${validated.altura}`);
    log.info(`tamanho=${validated.tamanho}`);
    if (typeof adapter.exists === "function"
      && !await adapter.exists(storageKey, {
        estabelecimentoId: config.estabelecimentoId,
      })) {
      throw new HomologacaoError(
        "HOMOLOGACAO_EXISTENCIA_NAO_CONFIRMADA",
        "O upload não pôde ser confirmado.",
        3,
      );
    }
    log.info("Upload aprovado.");

    try {
      await adapter.remove(storageKey, {
        estabelecimentoId: config.estabelecimentoId,
      });
      await adapter.remove(storageKey, {
        estabelecimentoId: config.estabelecimentoId,
      });
      if (typeof adapter.exists === "function"
        && await adapter.exists(storageKey, {
          estabelecimentoId: config.estabelecimentoId,
        })) {
        throw new Error("O recurso ainda existe.");
      }
    } catch (error) {
      throw new HomologacaoError(
        "HOMOLOGACAO_REMOCAO_NAO_CONFIRMADA",
        "A remoção não pôde ser confirmada.",
        5,
      );
    }
    limpezaConfirmada = true;
    limpezaAutorizada = false;
    log.info("Remoção aprovada.");
    log.info("Limpeza final aprovada.");
  } catch (error) {
    originalCode = error?.code || "HOMOLOGACAO_FALHOU";
    resultCode = Number(error?.exitCode) || 3;
    if (
      originalCode === "STORAGE_RESULTADO_DESCONHECIDO"
      && adapter
      && storageKey
      && typeof adapter.exists === "function"
    ) {
      try {
        const exists = await adapter.exists(storageKey, {
          estabelecimentoId: env.CLOUDINARY_TEST_ESTABELECIMENTO_ID,
        });
        limpezaAutorizada = exists === true;
        limpezaConfirmada = !exists;
      } catch {
        // Resultado ainda ambíguo: não remova sem confirmação do provedor.
        limpezaAutorizada = false;
      }
    }
  } finally {
    if (adapter && storageKey && limpezaAutorizada && !limpezaConfirmada) {
      try {
        await adapter.remove(storageKey, {
          estabelecimentoId: env.CLOUDINARY_TEST_ESTABELECIMENTO_ID,
        });
        const stillExists = typeof adapter.exists === "function"
          ? await adapter.exists(storageKey, {
              estabelecimentoId: env.CLOUDINARY_TEST_ESTABELECIMENTO_ID,
            })
          : false;
        if (stillExists) throw new Error("O recurso ainda existe.");
        limpezaConfirmada = true;
        log.info("Limpeza final aprovada.");
      } catch {
        cleanupCode = "HOMOLOGACAO_LIMPEZA_FALHOU";
        resultCode = 5;
      }
    }
  }

  if (resultCode) log.error(originalCode, storageKey);
  if (cleanupCode) log.error(cleanupCode, storageKey);
  return {
    exitCode: resultCode,
    storageKey,
    limpezaConfirmada,
  };
}

async function executarReconciliacao({
  env = process.env,
  storageKey,
  createStorageAdapter,
  logger = console,
} = {}) {
  const log = safeLogger(logger);
  try {
    const config = validarAmbiente(env, { reconciliation: true });
    const {
      validateStorageKey,
    } = require("../src/services/storage/CloudinaryStorageAdapter");
    const parsed = validateStorageKey(storageKey, {
      estabelecimentoId: config.estabelecimentoId,
    });
    if (parsed.resource !== "testes") {
      throw new HomologacaoError(
        "RECONCILIACAO_CHAVE_INVALIDA",
        "A chave não pertence ao namespace de homologação.",
        1,
      );
    }
    const adapter = createStorageAdapter(config.credentials);
    const exists = await adapter.exists(parsed.storageKey, {
      estabelecimentoId: config.estabelecimentoId,
    });
    log.info(`storageKey=${parsed.storageKey}`);
    log.info(`existe=${exists}`);
    if (exists && env.ALLOW_EXTERNAL_STORAGE_RECONCILIATION_REMOVE === "true") {
      await adapter.remove(parsed.storageKey, {
        estabelecimentoId: config.estabelecimentoId,
      });
      log.info("Remoção aprovada.");
    }
    return { exitCode: 0, storageKey: parsed.storageKey, exists };
  } catch (error) {
    log.error(error?.code || "RECONCILIACAO_FALHOU", storageKey);
    return { exitCode: Number(error?.exitCode) || 5, storageKey };
  }
}

function criarDependenciasReais() {
  const { processImage } = require("../src/uploads/imageProcessor");
  const {
    CloudinaryStorageAdapter,
  } = require("../src/services/storage/CloudinaryStorageAdapter");
  const cloudinary = require("cloudinary").v2;
  return {
    processImage,
    createStorageAdapter(credentials) {
      return new CloudinaryStorageAdapter({
        cloudinary,
        ...credentials,
      });
    },
  };
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  logger = console,
} = {}) {
  require("dotenv").config({ quiet: true });
  const dependencies = criarDependenciasReais();
  const reconcileIndex = argv.indexOf("--reconcile");
  const result = reconcileIndex >= 0
    ? await executarReconciliacao({
        env,
        storageKey: argv[reconcileIndex + 1],
        createStorageAdapter: dependencies.createStorageAdapter,
        logger,
      })
    : await executarHomologacao({
        env,
        ...dependencies,
        logger,
      });
  return result.exitCode;
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  }).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_FIXTURE,
  FIXTURE_DIRECTORY,
  HomologacaoError,
  executarHomologacao,
  executarReconciliacao,
  gerarStorageKey,
  main,
  validarAmbiente,
  validarFixture,
  validarRespostaUpload,
};
