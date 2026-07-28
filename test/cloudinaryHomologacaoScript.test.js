"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_FIXTURE,
  executarHomologacao,
  executarReconciliacao,
  gerarStorageKey,
  validarAmbiente,
  validarFixture,
  validarRespostaUpload,
} = require("../scripts/testar-cloudinary-homologacao");

const ESTABELECIMENTO_ID = "000000000000000000000001";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const STORAGE_KEY = `estabelecimentos/${ESTABELECIMENTO_ID}/testes/${UUID}.webp`;

function ambiente(overrides = {}) {
  return {
    ALLOW_EXTERNAL_STORAGE_TEST: "true",
    NODE_ENV: "development",
    STORAGE_DRIVER: "cloudinary",
    CLOUDINARY_CLOUD_NAME: "cloud-test",
    CLOUDINARY_API_KEY: "api-key-secret",
    CLOUDINARY_API_SECRET: "api-secret-value",
    CLOUDINARY_TEST_ESTABELECIMENTO_ID: ESTABELECIMENTO_ID,
    ...overrides,
  };
}

function respostaValida(overrides = {}) {
  return {
    provider: "cloudinary",
    storageKey: STORAGE_KEY,
    url: "https://res.cloudinary.test/image.webp",
    mimeType: "image/webp",
    largura: 8,
    altura: 8,
    tamanho: 42,
    publicId: STORAGE_KEY.slice(0, -5),
    resourceType: "image",
    format: "webp",
    ...overrides,
  };
}

function cenario(overrides = {}) {
  const calls = { save: [], remove: [], exists: [], process: [] };
  const states = Array.from(overrides.existsStates || [true, false]);
  const adapter = {
    async save(key, buffer, context) {
      calls.save.push({ key, buffer, context });
      if (overrides.saveError) throw overrides.saveError;
      return overrides.response || respostaValida();
    },
    async remove(key, context) {
      calls.remove.push({ key, context });
      if (overrides.removeError) throw overrides.removeError;
      return calls.remove.length === 1 ? { removed: true } : { removed: false };
    },
    async exists(key, context) {
      calls.exists.push({ key, context });
      if (overrides.existsError) throw overrides.existsError;
      return states.length ? states.shift() : false;
    },
  };
  const logs = [];
  return {
    calls,
    logs,
    deps: {
      env: ambiente(overrides.env),
      fixturePath: DEFAULT_FIXTURE,
      async processImage(buffer, category) {
        calls.process.push({ buffer, category });
        if (overrides.processError) throw overrides.processError;
        return {
          buffer: Buffer.from("webp-processado"),
          mimeType: "image/webp",
          width: 8,
          height: 8,
          size: 15,
        };
      },
      createStorageAdapter() {
        return adapter;
      },
      randomUUID: () => UUID,
      logger: {
        info: message => logs.push(String(message)),
        error: message => logs.push(String(message)),
      },
    },
  };
}

test("validação recusa flags, produção, driver, credenciais e tenant inválidos", () => {
  const cases = [
    [{ ALLOW_EXTERNAL_STORAGE_TEST: undefined }, "ALLOW_EXTERNAL_STORAGE_TEST"],
    [{ ALLOW_EXTERNAL_STORAGE_TEST: "TRUE" }, "ALLOW_EXTERNAL_STORAGE_TEST"],
    [{ NODE_ENV: "production" }, "NODE_ENV"],
    [{ STORAGE_DRIVER: "local" }, "STORAGE_DRIVER"],
    [{ CLOUDINARY_API_SECRET: "" }, "CLOUDINARY_API_SECRET"],
    [{ CLOUDINARY_TEST_ESTABELECIMENTO_ID: "1" }, "CLOUDINARY_TEST_ESTABELECIMENTO_ID"],
  ];
  for (const [change, expected] of cases) {
    assert.throws(() => validarAmbiente(ambiente(change)), error => {
      assert.equal(error.exitCode, 1);
      assert.match(error.message, new RegExp(expected));
      return true;
    });
  }
});

test("fixture aceita somente arquivo local existente, pequeno e dentro da pasta permitida", async () => {
  const valid = await validarFixture(DEFAULT_FIXTURE);
  assert.equal(valid.path, await fs.realpath(DEFAULT_FIXTURE));
  assert.ok(valid.size > 0);
  await assert.rejects(validarFixture("https://example.test/image.png"), { exitCode: 1 });
  await assert.rejects(validarFixture(path.join(path.dirname(DEFAULT_FIXTURE), "..", "secret.png")), {
    exitCode: 1,
  });
  await assert.rejects(validarFixture("/tmp/cloudinary-test.png"), { exitCode: 1 });
  await assert.rejects(validarFixture(path.join(path.dirname(DEFAULT_FIXTURE), "inexistente.png")), {
    exitCode: 1,
  });
  await assert.rejects(validarFixture(DEFAULT_FIXTURE, { maxBytes: 1 }), { exitCode: 1 });
});

test("storageKey é interna, imprevisível e pertence ao namespace testes", () => {
  assert.equal(gerarStorageKey(ESTABELECIMENTO_ID, () => UUID), STORAGE_KEY);
  assert.throws(() => gerarStorageKey(ESTABELECIMENTO_ID, () => "../manual"), { exitCode: 1 });
});

test("fluxo bem-sucedido processa, não envia o original, valida e remove idempotentemente", async () => {
  const run = cenario();
  const result = await executarHomologacao(run.deps);
  const original = await fs.readFile(DEFAULT_FIXTURE);
  assert.deepEqual(result, {
    exitCode: 0,
    storageKey: STORAGE_KEY,
    limpezaConfirmada: true,
  });
  assert.equal(run.calls.process.length, 1);
  assert.equal(run.calls.process[0].category, "produto");
  assert.equal(run.calls.save.length, 1);
  assert.equal(run.calls.save[0].key, STORAGE_KEY);
  assert.notDeepEqual(run.calls.save[0].buffer, original);
  assert.deepEqual(run.calls.save[0].context, {
    estabelecimentoId: ESTABELECIMENTO_ID,
    categoria: "testes",
    contexto: "homologacao_cloudinary",
  });
  assert.equal(run.calls.remove.length, 2);
  assert.equal(run.calls.exists.length, 2);
});

test("falha no processamento usa código 2 e não instancia nem chama storage", async () => {
  const run = cenario({ processError: new Error("imagem inválida") });
  const result = await executarHomologacao(run.deps);
  assert.equal(result.exitCode, 2);
  assert.equal(run.calls.save.length, 0);
  assert.equal(run.calls.remove.length, 0);
});

test("fixture que não é PNG falha antes do processamento e da rede", async () => {
  const run = cenario();
  run.deps.fsApi = {
    realpath: fs.realpath,
    stat: fs.stat,
    async readFile() {
      return Buffer.from("não é png");
    },
  };
  const result = await executarHomologacao(run.deps);
  assert.equal(result.exitCode, 2);
  assert.equal(run.calls.process.length, 0);
  assert.equal(run.calls.save.length, 0);
});

test("respostas inconsistentes são rejeitadas e compensadas", async t => {
  const cases = [
    ["HTTP", { url: "http://res.cloudinary.test/image.webp" }],
    ["provider", { provider: "outro" }],
    ["mime", { mimeType: "image/png" }],
    ["largura", { largura: 0 }],
    ["altura", { altura: 0 }],
    ["public_id", { publicId: "outro" }],
    ["resource_type", { resourceType: "raw" }],
    ["formato", { format: "png" }],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const run = cenario({ response: respostaValida(change), existsStates: [false] });
      const result = await executarHomologacao(run.deps);
      assert.equal(result.exitCode, 3);
      assert.equal(run.calls.save.length, 1);
      assert.equal(run.calls.remove.length, 1);
      assert.equal(result.limpezaConfirmada, true);
    });
  }
});

test("timeout não repete upload, preserva a chave e só remove após existência confirmada", async () => {
  const unknown = Object.assign(new Error("timeout"), {
    code: "STORAGE_RESULTADO_DESCONHECIDO",
  });
  const run = cenario({ saveError: unknown, existsStates: [true, false] });
  const result = await executarHomologacao(run.deps);
  assert.equal(result.exitCode, 4);
  assert.equal(result.storageKey, STORAGE_KEY);
  assert.equal(run.calls.save.length, 1);
  assert.equal(run.calls.remove.length, 1);
  assert.equal(result.limpezaConfirmada, true);
});

test("timeout sem confirmação de existência não remove cegamente", async () => {
  const unknown = Object.assign(new Error("timeout"), {
    code: "STORAGE_RESULTADO_DESCONHECIDO",
  });
  const run = cenario({
    saveError: unknown,
    existsError: new Error("consulta indisponível"),
  });
  const result = await executarHomologacao(run.deps);
  assert.equal(result.exitCode, 4);
  assert.equal(run.calls.save.length, 1);
  assert.equal(run.calls.remove.length, 0);
  assert.equal(result.limpezaConfirmada, false);
});

test("falha de limpeza retorna código 5 e mantém o código original no log", async () => {
  const run = cenario({
    response: respostaValida({ provider: "incompatível" }),
    removeError: new Error("falha de remoção"),
  });
  const result = await executarHomologacao(run.deps);
  assert.equal(result.exitCode, 5);
  assert.match(run.logs.join("\n"), /HOMOLOGACAO_RESPOSTA_INVALIDA/);
  assert.match(run.logs.join("\n"), /HOMOLOGACAO_LIMPEZA_FALHOU/);
});

test("logs não expõem credenciais, resposta bruta nem buffer", async () => {
  const run = cenario();
  await executarHomologacao(run.deps);
  const output = run.logs.join("\n");
  assert.doesNotMatch(output, /api-secret-value|api-key-secret|CLOUDINARY_URL/);
  assert.doesNotMatch(output, /res\.cloudinary|webp-processado/);
});

test("validador da resposta exige todos os campos técnicos esperados", () => {
  assert.equal(validarRespostaUpload(respostaValida(), STORAGE_KEY).provider, "cloudinary");
  assert.throws(
    () => validarRespostaUpload(respostaValida({ tamanho: Number.NaN }), STORAGE_KEY),
    { exitCode: 3 },
  );
});

test("reconciliação isola tenant e só remove com confirmação adicional exata", async () => {
  const calls = [];
  const createStorageAdapter = () => ({
    exists: async key => {
      calls.push(["exists", key]);
      return true;
    },
    remove: async key => calls.push(["remove", key]),
  });
  const env = ambiente({
    ALLOW_EXTERNAL_STORAGE_RECONCILIATION: "true",
    ALLOW_EXTERNAL_STORAGE_RECONCILIATION_REMOVE: "true",
  });
  const result = await executarReconciliacao({
    env,
    storageKey: STORAGE_KEY,
    createStorageAdapter,
    logger: { info() {}, error() {} },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls.map(call => call[0]), ["exists", "remove"]);

  const otherTenantKey = STORAGE_KEY.replace(ESTABELECIMENTO_ID, "000000000000000000000002");
  const denied = await executarReconciliacao({
    env,
    storageKey: otherTenantKey,
    createStorageAdapter,
    logger: { info() {}, error() {} },
  });
  assert.equal(denied.exitCode, 5);
  assert.equal(calls.length, 2);
});

test("execução conclui, não chama process.exit e importar não dispara main", async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, "../scripts/testar-cloudinary-homologacao.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bprocess\.exit\s*\(/);
  assert.match(source, /if \(require\.main === module\)/);
  const run = cenario();
  const result = await Promise.race([
    executarHomologacao(run.deps),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Promise pendente")), 500)),
  ]);
  assert.equal(result.exitCode, 0);
});

test("CLI manual define process.exitCode sem process.exit e recusa antes da rede", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/testar-cloudinary-homologacao.js"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        ALLOW_EXTERNAL_STORAGE_TEST: "",
        NODE_ENV: "test",
        STORAGE_DRIVER: "cloudinary",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /api-secret-value|api-key-secret/);
});
