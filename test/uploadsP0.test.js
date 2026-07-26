"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const sharp = require("sharp");

const { processImage, UploadError } = require("../src/uploads/imageProcessor");
const {
  buildStorageKey,
  setAdapterForTests,
  storageConfig,
} = require("../src/services/storageService");
const { LocalStorageAdapter } = require("../src/services/storage/LocalStorageAdapter");
const { auditUploads, EXAMPLE_LIMIT } = require("../scripts/auditar-uploads");

async function image(format, width = 8, height = 8) {
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0.5 },
    },
  });
  if (format === "jpeg") pipeline = pipeline.jpeg();
  if (format === "png") pipeline = pipeline.png();
  if (format === "webp") pipeline = pipeline.webp();
  return pipeline.toBuffer();
}

test("PNG, JPEG e WebP reais são decodificados e regravados como WebP sem EXIF", async () => {
  for (const format of ["png", "jpeg", "webp"]) {
    const result = await processImage(await image(format), "produto");
    assert.equal(result.mimeType, "image/webp");
    assert.equal(result.extension, "webp");
    const metadata = await sharp(result.buffer).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.exif, undefined);
  }
});

test("HTML, executável, SVG, vazio e conteúdo falso são rejeitados com 415", async () => {
  const inputs = [
    Buffer.from("<html><script>alert(1)</script></html>"),
    Buffer.from("MZ\u0000\u0002fake executable"),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    Buffer.alloc(0),
  ];
  for (const input of inputs) {
    await assert.rejects(
      processImage(input, "produto"),
      error => error instanceof UploadError && error.status === 415,
    );
  }
});

test("tamanho e dimensões excessivas retornam 413", async () => {
  await assert.rejects(
    processImage(Buffer.alloc(5 * 1024 * 1024 + 1), "produto"),
    error => error.status === 413,
  );
  await assert.rejects(
    processImage(await image("png", 4100, 1), "produto"),
    error => error.status === 413,
  );
});

test("storage local usa UUID, isola tenant e bloqueia traversal", async () => {
  const tenant = "507f1f77bcf86cd799439011";
  const key = buildStorageKey({
    estabelecimentoId: tenant,
    resource: "produtos",
  });
  assert.match(
    key,
    /^estabelecimentos\/507f1f77bcf86cd799439011\/produtos\/[0-9a-f-]{36}\.webp$/,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-p0-"));
  const adapter = new LocalStorageAdapter({ root });
  await adapter.save(key, Buffer.from("safe"));
  assert.equal(await adapter.exists(key), true);
  assert.throws(() => adapter.resolve("../escape.webp"));
  assert.throws(() => adapter.resolve("/tmp/escape.webp"));
  assert.throws(() => adapter.resolve("x\u0000.webp"));
  await adapter.remove(key);
  assert.equal(await adapter.exists(key), false);
});

test("produção falha sem storage externo e desenvolvimento aceita local", () => {
  assert.throws(
    () => storageConfig({ NODE_ENV: "production" }),
    /STORAGE_DRIVER=external/,
  );
  assert.throws(
    () => storageConfig({
      NODE_ENV: "production",
      STORAGE_DRIVER: "external",
      STORAGE_EXTERNAL_BASE_URL: "http://inseguro.example",
    }),
    /HTTPS/,
  );
  assert.throws(
    () => storageConfig({
      NODE_ENV: "production",
      STORAGE_DRIVER: "external",
      STORAGE_EXTERNAL_BASE_URL: "https://cdn.example",
      STORAGE_EXTERNAL_PROVIDER: "s3",
    }),
    /STORAGE_EXTERNAL_ADAPTER_MODULE/,
  );
  assert.deepEqual(storageConfig({ NODE_ENV: "development" }), {
    driver: "local",
    baseUrl: undefined,
    provider: "",
    adapterModule: "",
  });
});

function mockModel(rows) {
  return {
    find(filter = {}) {
      const state = {};
      const chain = {
        select() { return chain; },
        sort() { return chain; },
        limit(value) { state.limit = value; return chain; },
        lean() {
          const after = filter._id?.$gt;
          return Promise.resolve(
            rows.filter(row => after == null || row._id > after).slice(0, state.limit),
          );
        },
      };
      return chain;
    },
  };
}

test("auditoria é paginada, somente-leitura, limita exemplos e não expõe dados pessoais", async () => {
  const personalMarker = "cliente-secreto@example.com";
  const legacyRows = Array.from({ length: EXAMPLE_LIMIT + 5 }, (_, index) => ({
    _id: index + 1,
    estabelecimentoId: "507f1f77bcf86cd799439011",
    imagem: `data:image/png;base64,${personalMarker}`,
    cliente: personalMarker,
  }));
  const empty = mockModel([]);
  let output = "";
  const report = await auditUploads({
    models: {
      Produto: mockModel(legacyRows),
      Funcionario: empty,
      Configuracao: empty,
    },
    storage: {
      imageExists: async () => true,
      listKeys: async () => [],
      save: () => assert.fail("auditoria tentou gravar"),
      remove: () => assert.fail("auditoria tentou remover"),
    },
    output: value => { output = value; },
  });
  assert.equal(report.problemas.legado_data_url.quantidade, legacyRows.length);
  assert.equal(report.problemas.legado_data_url.exemplos.length, EXAMPLE_LIMIT);
  assert.doesNotMatch(output, new RegExp(personalMarker));
  assert.match(
    fs.readFileSync(require.resolve("../scripts/auditar-uploads"), "utf8"),
    /ALLOW_READONLY_AUDIT/,
  );
});

test("auditoria sem ALLOW_READONLY_AUDIT encerra antes de conectar", () => {
  const env = { ...process.env };
  delete env.ALLOW_READONLY_AUDIT;
  env.CONNECTIONSTRING = "mongodb://127.0.0.1:1/nunca-conectar";
  const result = spawnSync(
    process.execPath,
    ["scripts/auditar-uploads.js"],
    { cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 3_000 },
  );
  assert.notEqual(result.status, 0);
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(diagnostic, /ECONNREFUSED|MongoServerSelectionError/);
  const source = fs.readFileSync(
    path.resolve(__dirname, "../scripts/auditar-uploads.js"),
    "utf8",
  );
  assert.ok(
    source.indexOf('process.env.ALLOW_READONLY_AUDIT !== "true"')
      < source.indexOf("mongoose.connect"),
  );
});

test("schema e controller não gravam Base64 novo e preservam substituição segura", () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, "../src/controllers/adminRealController.js"),
    "utf8",
  );
  assert.doesNotMatch(controller, /toString\(["']base64/);
  assert.match(controller, /imagemArquivo: novaImagem/);
  assert.match(controller, /fotoArquivo: novaImagem/);
  assert.match(controller, /fotoPerfilArquivo = novaImagem/);
  assert.match(controller, /!produtoSalvo && novaImagem/);
  assert.match(controller, /!funcionarioSalvo && novaImagem/);
  assert.match(controller, /!configuracaoSalva && novaImagem/);
  assert.doesNotMatch(controller, /req\.body\.(?:imagem|foto|fotoPerfil)/);
});

test("headers de uploads e limites frontend estão configurados", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  const view = fs.readFileSync(
    path.resolve(__dirname, "../src/views/admin-real.ejs"),
    "utf8",
  );
  assert.match(server, /app\.use\(["']\/uploads/);
  assert.match(server, /X-Content-Type-Options/);
  assert.match(server, /immutable/);
  assert.match(view, /image\/jpeg,image\/png,image\/webp/);
  assert.match(view, /textContent = input\.validationMessage/);
  assert.doesNotMatch(view, /accept="image\/\*"/);
});

test.after(() => setAdapterForTests(null));
