"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  CloudinaryStorageAdapter,
  StorageError,
  validateStorageKey,
} = require("../src/services/storage/CloudinaryStorageAdapter");
const {
  initializeStorage,
  setAdapterForTests,
  storageConfig,
} = require("../src/services/storageService");
const {
  EnvironmentValidationError,
  validateEnvironment,
} = require("../src/config/validateEnv");

const TENANT = "507f1f77bcf86cd799439011";
const OTHER_TENANT = "507f191e810c19729de860ea";
const KEY = `estabelecimentos/${TENANT}/produtos/550e8400-e29b-41d4-a716-446655440000.webp`;
const PUBLIC_ID = KEY.slice(0, -5);

function validResult(overrides = {}) {
  return {
    public_id: PUBLIC_ID,
    secure_url: `https://res.cloudinary.com/demo/image/upload/${PUBLIC_ID}.webp`,
    width: 320,
    height: 240,
    bytes: 1234,
    resource_type: "image",
    format: "webp",
    ...overrides,
  };
}

function sdkMock({
  uploadResult = validResult(),
  uploadError = null,
  omitUploadCallback = false,
  destroyResult = { result: "ok" },
  resourceError = null,
} = {}) {
  const calls = {
    config: [],
    upload: [],
    destroy: [],
    resource: [],
    resources: [],
    uploadedBuffer: null,
  };
  const sdk = {
    config(value) { calls.config.push(value); },
    url(publicId) {
      return `https://res.cloudinary.com/demo/image/upload/${publicId}.webp`;
    },
    uploader: {
      upload_stream(options, callback) {
        calls.upload.push(options);
        return {
          end(buffer) {
            calls.uploadedBuffer = buffer;
            if (!omitUploadCallback) queueMicrotask(() =>
              callback(uploadError, uploadResult));
          },
        };
      },
      destroy(publicId, options, callback) {
        calls.destroy.push({ publicId, options });
        queueMicrotask(() => callback(null, destroyResult));
      },
    },
    api: {
      resource(publicId, options, callback) {
        calls.resource.push({ publicId, options });
        queueMicrotask(() => callback(resourceError, resourceError ? null : {}));
      },
      resources(options, callback) {
        calls.resources.push(options);
        queueMicrotask(() => callback(null, {
          resources: [{ public_id: PUBLIC_ID }],
        }));
      },
    },
  };
  return { calls, sdk };
}

function adapterWithMock(options = {}) {
  const mock = sdkMock(options);
  return {
    ...mock,
    adapter: new CloudinaryStorageAdapter({
      cloudinary: mock.sdk,
      cloudName: "cloud",
      apiKey: "key",
      apiSecret: "secret",
      timeoutMs: 100,
    }),
  };
}

function commonProduction(overrides = {}) {
  return {
    NODE_ENV: "production",
    PORT: "3000",
    CONNECTIONSTRING: "mongodb://127.0.0.1/test",
    SESSION_SECRET: "x".repeat(48),
    APP_URL: "https://app.example",
    STORAGE_DRIVER: "cloudinary",
    CLOUDINARY_CLOUD_NAME: "cloud",
    CLOUDINARY_API_KEY: "key",
    CLOUDINARY_API_SECRET: "secret",
    MERCADO_PAGO_ACCESS_TOKEN: "configured",
    MERCADO_PAGO_PUBLIC_KEY: "configured",
    MERCADO_PAGO_WEBHOOK_SECRET: "configured",
    MERCADO_PAGO_PLATFORM_USER_ID: "configured",
    MP_CLIENT_ID: "configured",
    MP_CLIENT_SECRET: "configured",
    MP_REDIRECT_URI: "https://app.example/admin/mercado-pago/callback",
    TOKEN_ENCRYPTION_KEY: "configured",
    SMTP_HOST: "smtp.example",
    SMTP_PORT: "465",
    SMTP_USER: "configured",
    SMTP_PASS: "configured",
    SMTP_FROM: "configured",
    ...overrides,
  };
}

test("configuração Cloudinary válida não exige módulo customizado", () => {
  const env = commonProduction();
  assert.equal(validateEnvironment(env).production, true);
  const config = storageConfig(env);
  assert.equal(config.driver, "cloudinary");
  assert.equal(config.adapterModule, "");
});

test("credencial ausente e produção local são bloqueadas sem mostrar valores", () => {
  const secret = "nao-expor-este-segredo";
  assert.throws(
    () => validateEnvironment(commonProduction({
      CLOUDINARY_API_SECRET: "",
      CLOUDINARY_API_KEY: secret,
    })),
    error => {
      assert.ok(error instanceof EnvironmentValidationError);
      assert.match(error.message, /CLOUDINARY_API_SECRET/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(
    () => validateEnvironment(commonProduction({ STORAGE_DRIVER: "local" })),
    /STORAGE_DRIVER/,
  );
});

test("upload envia o buffer processado e usa opções Cloudinary restritas", async () => {
  const { adapter, calls } = adapterWithMock();
  const processedBuffer = Buffer.from("webp-processado");
  const result = await adapter.save(KEY, processedBuffer, {
    estabelecimentoId: TENANT,
  });
  assert.strictEqual(calls.uploadedBuffer, processedBuffer);
  assert.deepEqual(calls.upload[0], {
    public_id: PUBLIC_ID,
    resource_type: "image",
    format: "webp",
    overwrite: false,
    unique_filename: false,
    invalidate: true,
  });
  assert.deepEqual(result, {
    storageKey: KEY,
    url: validResult().secure_url,
    mimeType: "image/webp",
    largura: 320,
    altura: 240,
    tamanho: 1234,
    provider: "cloudinary",
    publicId: PUBLIC_ID,
    resourceType: "image",
    format: "webp",
  });
  assert.deepEqual(calls.config[0], {
    cloud_name: "cloud",
    api_key: "key",
    api_secret: "secret",
    secure: true,
  });
});

test("respostas Cloudinary incompatíveis são rejeitadas", async () => {
  const invalidResponses = [
    validResult({ secure_url: "http://res.cloudinary.com/inseguro.webp" }),
    validResult({ format: "png" }),
    validResult({ resource_type: "raw" }),
    validResult({ public_id: undefined }),
    validResult({ public_id: `${PUBLIC_ID}-outro` }),
  ];
  for (const uploadResult of invalidResponses) {
    const { adapter } = adapterWithMock({ uploadResult });
    await assert.rejects(
      adapter.save(KEY, Buffer.from("webp"), { estabelecimentoId: TENANT }),
      error => error.code === "STORAGE_RESPOSTA_INVALIDA",
    );
  }
});

test("timeout de upload é resultado desconhecido e não faz retry cego", async () => {
  let timeoutCallback;
  const mock = sdkMock({ omitUploadCallback: true });
  const adapter = new CloudinaryStorageAdapter({
    cloudinary: mock.sdk,
    cloudName: "cloud",
    apiKey: "key",
    apiSecret: "secret",
    timeoutMs: 10_000,
    setTimeoutFn(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutFn() {},
  });
  const pending = adapter.save(KEY, Buffer.from("webp"), {
    estabelecimentoId: TENANT,
  });
  timeoutCallback();
  await assert.rejects(
    pending,
    error => error.code === "STORAGE_RESULTADO_DESCONHECIDO"
      && error.storageKey === KEY,
  );
  assert.equal(mock.calls.upload.length, 1);
});

test("remoção usa public_id técnico, é idempotente e não recebe extensão", async () => {
  const success = adapterWithMock();
  assert.deepEqual(
    await success.adapter.remove(KEY, { estabelecimentoId: TENANT }),
    { removed: true },
  );
  assert.equal(success.calls.destroy[0].publicId, PUBLIC_ID);
  assert.deepEqual(success.calls.destroy[0].options, {
    resource_type: "image",
    invalidate: true,
  });

  const absent = adapterWithMock({ destroyResult: { result: "not found" } });
  assert.deepEqual(
    await absent.adapter.remove(KEY, { estabelecimentoId: TENANT }),
    { removed: false },
  );
});

test("remoção bloqueia outra loja, traversal, URL e caminho absoluto", async () => {
  const { adapter, calls } = adapterWithMock();
  for (const [key, context] of [
    [KEY, { estabelecimentoId: OTHER_TENANT }],
    [`estabelecimentos/${TENANT}/produtos/../arquivo.webp`, {
      estabelecimentoId: TENANT,
    }],
    ["https://res.cloudinary.com/demo/image.webp", { estabelecimentoId: TENANT }],
    ["/etc/passwd", { estabelecimentoId: TENANT }],
  ]) {
    await assert.rejects(
      adapter.remove(key, context),
      error => error.code === "STORAGE_TENANT_INVALIDO",
    );
  }
  assert.equal(calls.destroy.length, 0);
});

test("exists trata 404 como ausente e URL pública é sempre HTTPS", async () => {
  const missingError = Object.assign(new Error("missing"), { http_code: 404 });
  const { adapter } = adapterWithMock({ resourceError: missingError });
  assert.equal(await adapter.exists(KEY, { estabelecimentoId: TENANT }), false);
  assert.match(adapter.publicUrl(KEY), /^https:\/\//);
});

test("erros sanitizados nunca contêm credenciais ou resposta integral", async () => {
  const sensitive = "api-secret-super-sensivel";
  const { adapter } = adapterWithMock({
    uploadError: new Error(`falha ${sensitive}`),
  });
  await assert.rejects(
    adapter.save(KEY, Buffer.from("webp"), { estabelecimentoId: TENANT }),
    error => {
      assert.ok(error instanceof StorageError);
      assert.doesNotMatch(error.message, new RegExp(sensitive));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(sensitive));
      return true;
    },
  );
});

test("integração mantém compensação e usa somente bytes processados pelo Sharp", () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, "../src/controllers/adminRealController.js"),
    "utf8",
  );
  assert.match(
    controller,
    /processImage\(file\.buffer, category\)[\s\S]*saveImage\(processed\.buffer/,
  );
  assert.match(controller, /!produtoSalvo && novaImagem/);
  assert.match(controller, /!funcionarioSalvo && novaImagem/);
  assert.match(controller, /!configuracaoSalva && novaImagem/);
  assert.match(controller, /produtoSalvo = true[\s\S]*Imagem anterior de produto ficou órfã/);
});

test("auditoria permanece somente-leitura e reconhece providers sem expor URLs", () => {
  const audit = fs.readFileSync(
    path.resolve(__dirname, "../scripts/auditar-uploads.js"),
    "utf8",
  );
  assert.match(audit, /providers: \{ local: 0, cloudinary: 0/);
  assert.match(audit, /url_incompativel/);
  assert.match(audit, /ALLOW_READONLY_AUDIT/);
  assert.doesNotMatch(audit, /\.(?:updateOne|deleteOne|insertOne|createIndex)\(/);
  assert.doesNotMatch(audit, /metadata\.url.*exemplos/);
});

test("listagem Cloudinary devolve somente storageKeys técnicas do namespace", async () => {
  const { adapter, calls } = adapterWithMock();
  assert.deepEqual(await adapter.listKeys(), [KEY]);
  assert.deepEqual(calls.resources[0], {
    resource_type: "image",
    type: "upload",
    prefix: "estabelecimentos/",
    max_results: 500,
  });
});

test("LocalStorageAdapter continua sendo selecionável apenas fora de produção", () => {
  assert.equal(storageConfig({ NODE_ENV: "development" }).driver, "local");
  assert.throws(
    () => storageConfig({ NODE_ENV: "production", STORAGE_DRIVER: "local" }),
    /proibido/,
  );
});

test.after(() => setAdapterForTests(null));
