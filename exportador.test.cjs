"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const vm = require("node:vm");
const { mongo } = require("mongoose");
const { ObjectId, BSON: { EJSON } } = mongo;
const tool = require("./exportar-dados-web.cjs");
const tenant = "6a747203cbe38c815477d025";
const other = "6a6f97ac99f3e12db7b2daa9";
const cat = new ObjectId(), live = new ObjectId(), archived = new ObjectId();

function fixture() {
  const data = {
    registros: [{ _id: new ObjectId(tenant), nomeEstabelecimento: "Eusa Pizzaria", senha: "nao-exportar" }, { _id: new ObjectId(other), nomeEstabelecimento: "Outra loja" }],
    categorias: [{ _id: cat, estabelecimentoId: new ObjectId(tenant), nome: "Pizzas", tipo: "catalogo", ativo: true }],
    produtos: [
      { _id: live, estabelecimentoId: new ObjectId(tenant), nome: "Ativa", preco: 31.50, categoriaId: cat, ativo: true },
      { _id: archived, estabelecimentoId: new ObjectId(tenant), nome: "Arquivada", categoriaId: cat, ativo: false },
      { _id: new ObjectId(), estabelecimentoId: new ObjectId(other), nome: "De outro cliente", categoriaId: cat, ativo: true },
    ],
    pedidos: [{ _id: new ObjectId(), estabelecimentoId: new ObjectId(tenant), total: 46.50, custo: 10, createdAt: new Date("2026-01-01T12:00:00Z"), pagoEm: new Date("2026-01-01T12:05:00Z"), pagamentoStatus: "pago", formaPagamento: "combinado", pagamentos: [{ formaPagamento: "cartao", valorCentavos: 3000 }, { formaPagamento: "dinheiro", valorCentavos: 1650 }], precisaTroco: true, trocoPara: 50, valorTroco: 33.50, itens: [{ produtoId: archived, nome: "Arquivada vendida no passado", quantidade: 1, subtotal: 31.50 }], acompanhamentoTokenHash: "nao-exportar", mercadoPagoAccessToken: "nao-exportar" }],
    funcionarios: [{ _id: new ObjectId(), estabelecimentoId: new ObjectId(tenant), nome: "Funcionario", senha: "nao-exportar", salario: 1500, ativo: true, permissoes: ["pedidos"] }],
    configuracaos: [{ _id: new ObjectId(), estabelecimentoId: new ObjectId(tenant), nomeEstabelecimento: "Eusa Pizzaria", timezone: "America/Sao_Paulo", mercadoPago: { accessToken: "nao-exportar" } }],
    cidadeentregas: [], mesas: [],
    assinaturas: [{ _id: new ObjectId(), estabelecimentoId: new ObjectId(tenant), planoInicio: new Date("2026-09-01T12:00:00Z"), planoExpira: new Date("2026-12-01T12:00:00Z"), status: "ativa", mercadoPagoPreapprovalId: "nao-exportar", historicoFinanceiro: [{ aprovadoEm: new Date("2026-09-01T12:00:00Z"), paymentId: "nao-exportar" }] }],
  };
  const reads = [], session = { snapshot: true };
  function matches(doc, q) {
    return Object.entries(q).every(([k, v]) => v?.$in ? v.$in.some(id => String(id) === String(doc[k])) : String(v) === String(doc[k]));
  }
  const db = { databaseName: "comandafacil", collection(name) { return {
    find(query, options) { reads.push({ name, query, options }); return { toArray: async () => data[name].filter(d => matches(d, query)) }; },
    async findOne(query, options) { reads.push({ name, query, options }); return data[name].find(d => matches(d, query)) || null; },
  }; } };
  return { db, data, reads, session, names: Object.keys(data) };
}

test("exporta só cliente selecionado, produtos ativos e base dos relatórios", async () => {
  const f = fixture();
  const data = await tool.collectData({ ...f, ObjectId, id: tenant });
  assert.equal(String(data.estabelecimento._id), tenant);
  assert.deepEqual(data.produtos.map(p => p.nome), ["Ativa"]);
  assert.equal(data.controle.produtosForaDoCatalogo, 1);
  assert.equal(data.pedidos[0].itens[0].nome, "Arquivada vendida no passado");
  assert.equal(data.pedidos[0].itens[0].categoriaNome, "Pizzas");
  assert.equal(data.pedidos[0].valorTroco, 33.50);
  assert.deepEqual(data.pedidos[0].pagamentos, f.data.pedidos[0].pagamentos);
  assert.equal(data.pedidos[0].pagoEm.getTime(), f.data.pedidos[0].pagoEm.getTime());
  assert.equal(data.ciclo.inicio.getTime(), f.data.assinaturas[0].planoInicio.getTime());
  assert.equal(data.assinaturas, undefined);
  assert.equal(data.configuracaoCardapio.mercadoPago, undefined);
  assert.equal(data.funcionarios[0].senha, undefined);
  assert.deepEqual(data.funcionarios[0].permissoes, ["pedidos"]);
  assert.equal(data.pedidos[0].acompanhamentoTokenHash, undefined);
  assert.equal(data.pedidos[0].mercadoPagoAccessToken, undefined);
  assert.ok(f.reads.every(r => r.options.session === f.session));
  const readDates = f.reads.find(r => r.name === "assinaturas");
  assert.deepEqual(Object.keys(readDates.options.projection).sort(), ["historicoFinanceiro.aprovadoEm", "planoExpira", "planoInicio"]);
});

test("não altera os documentos originais durante a exportação", async () => {
  const f = fixture(); const before = EJSON.stringify(f.data, { relaxed: false });
  await tool.collectData({ ...f, ObjectId, id: tenant });
  assert.equal(EJSON.stringify(f.data, { relaxed: false }), before);
});

test("filtros excluem ativos falsos, arquivados e categorias inativas", () => {
  const products = [
    { nome: "ok", categoriaId: cat },
    { nome: "inativo", ativo: false, categoriaId: cat },
    { nome: "arquivado", arquivado: true, categoriaId: cat },
    { nome: "excluido", excluido: true, categoriaId: cat },
    { nome: "categoria inativa", categoriaId: "inactive" },
  ];
  assert.deepEqual(tool.chooseCatalog(products, [{ _id: cat }, { _id: "inactive", ativo: false }]).map(v => v.nome), ["ok"]);
});

test("interrompe se não existir a coleção de pedidos, em vez de entregar histórico vazio", async () => {
  const f = fixture(); f.names = f.names.filter(n => n !== "pedidos");
  await assert.rejects(tool.collectData({ ...f, ObjectId, id: tenant }), /obrigatória/);
});

test("interrompe se falhar a leitura de uma coleção", async () => {
  const f = fixture(); const collection = f.db.collection;
  f.db.collection = name => name === "pedidos" ? { find() { throw Error("Falha de leitura"); } } : collection(name);
  await assert.rejects(tool.collectData({ ...f, ObjectId, id: tenant }), /Falha de leitura/);
});

test("recusa nomes de coleção ambíguos e identificadores inválidos", async () => {
  assert.throws(() => tool.collectionName(["configuracaos", "configuracoes"], ["configuracaos", "configuracoes"]), /mais de uma/);
  await assert.rejects(tool.collectData({ ...fixture(), ObjectId, id: "invalid" }), /inválido/);
});

test("grava arquivo gzip válido, com BSON e datas preservados e modo privado", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "export-test-")); t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const data = await tool.collectData({ ...fixture(), ObjectId, id: tenant });
  const saved = await tool.saveArchive(data, EJSON, folder);
  const raw = await fs.readFile(saved.destination);
  const json = zlib.gunzipSync(raw).toString("utf8");
  const restored = EJSON.parse(json, { relaxed: true });
  assert.equal(String(restored.estabelecimento._id), tenant);
  assert.equal(restored.produtos[0].preco, 31.50);
  assert.equal(restored.pedidos[0].createdAt.toISOString(), "2026-01-01T12:00:00.000Z");
  assert.ok(json.includes('"$oid"'));
  assert.ok(json.includes('"$date"'));
  assert.equal((await fs.stat(saved.destination)).mode & 0o777, 0o600);
  const saved2 = await tool.saveArchive(data, EJSON, folder); assert.notEqual(saved2.name, saved.name);
});

test("copia fotos locais ativas e verifica hash, sem buscar produto arquivado", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "export-image-test-")); t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, "public/uploads"), { recursive: true });
  await fs.writeFile(path.join(folder, "public/uploads/foto.png"), Buffer.from("fixture-png"));
  const data = await tool.collectData({ ...fixture(), ObjectId, id: tenant }); data.produtos[0].imagem = "/uploads/foto.png";
  await tool.addImages(data, "", true, folder, () => {});
  assert.equal(data.imagens.length, 1); assert.equal(data.imagens[0].tipo, "produto");
  assert.equal(Buffer.from(data.imagens[0].base64, "base64").toString(), "fixture-png");
  assert.match(data.imagens[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(data.controle.imagensIncluidas, true);
});

test("sem fotos registra pendência de cópia, e erro de foto não é escondido", async () => {
  const data = await tool.collectData({ ...fixture(), ObjectId, id: tenant });
  data.produtos[0].imagem = "/uploads/missing.png";
  await tool.addImages(data, "", false, "/tmp", () => {});
  assert.equal(data.controle.imagensIncluidas, false);
  await assert.rejects(tool.addImages(data, "", true, "/tmp", () => {}), /endereço relativo/);
});

test("não exporta status, IDs ou valores do plano no ciclo", () => {
  const dates = tool.cycleDates({ planoInicio: new Date(1), planoExpira: new Date(2), status: "ativa", amount: 199.90, mercadoPagoPreapprovalId: "SEGREDO", historicoFinanceiro: [{ aprovadoEm: new Date(50) }, { aprovadoEm: new Date(20) }] });
  assert.equal(dates.primeiroPagamentoRegistradoEm.getTime(), 20);
  assert.equal(dates.status, undefined); assert.equal(dates.amount, undefined); assert.equal(dates.mercadoPagoPreapprovalId, undefined);
});

test("página gera JavaScript válido e usa textContent para nomes dos clientes", () => {
  const html = tool.page("/test/", "nonce");
  const script = html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  assert.ok(html.includes("textContent")); assert.ok(!script.includes("innerHTML"));
  assert.ok(html.includes("Sem planos")); assert.ok(html.includes("Produtos ativos"));
});

test("falhas de conexão não expõem credenciais", () => {
  assert.ok(!tool.publicFailure({ code: 18, message: "bad auth senha=SEGREDO" }).includes("SEGREDO"));
  assert.ok(!tool.publicFailure(Error("mongodb+srv://usuario:SENHA@host/banco")).includes("SENHA"));
});

test("interface local conecta, exporta cliente selecionado e entrega arquivo; recusa outra origem", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "export-http-test-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const f = fixture();
  f.db.listCollections = () => ({ toArray: async () => f.names.map(name => ({ name, type: "collection" })) });
  let ended = false;
  class FakeClient {
    async connect() {}
    db(name) { assert.equal(name, "comandafacil"); return f.db; }
    startSession(options) { assert.deepEqual(options, { snapshot: true }); return { endSession: async () => { ended = true; } }; }
    async close() {}
  }
  const previous = process.env.CONNECTIONSTRING;
  process.env.CONNECTIONSTRING = "mongodb+srv://usuario:SENHA@cluster.example/";
  t.after(() => { if (previous === undefined) delete process.env.CONNECTIONSTRING; else process.env.CONNECTIONSTRING = previous; });
  const instance = await tool.startServer({ mongoose: { mongo: { ...mongo, MongoClient: FakeClient } }, dotenv: { config() {} } }, folder, { openBrowser: false, outputDirectory: folder });
  t.after(instance.close);
  const base = new URL(instance.address).origin;
  const html = await (await fetch(instance.address)).text(); assert.ok(html.includes("Exportar dados do web"));
  async function post(route, body, origin = base) {
    return fetch(instance.address + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  assert.equal((await post("connect", {}, "https://evil.example")).status, 403);
  const connected = await (await post("connect")).json();
  assert.equal(connected.accounts.length, 2);
  assert.ok(!JSON.stringify(connected).includes("SENHA"));
  assert.equal((await post("export", { ids: ["000000000000000000000000"] })).status, 400);
  assert.equal((await post("export", { ids: [tenant], includePhotos: true })).status, 202);
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(instance.address + "status")).json();
    if (state.state === "done" || state.state === "error") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.state, "done", state.message);
  assert.equal(state.files.length, 1); assert.equal(ended, true);
  const downloaded = await fetch(instance.address + "download/0"); assert.equal(downloaded.status, 200);
  const raw = Buffer.from(await downloaded.arrayBuffer());
  const data = EJSON.parse(zlib.gunzipSync(raw).toString("utf8"), { relaxed: true });
  assert.equal(String(data.estabelecimento._id), tenant);
  assert.equal(data.produtos.length, 1);
  assert.equal(data.funcionarios[0].senha, undefined);
  assert.equal(data.assinaturas, undefined);
  assert.ok(!JSON.stringify(data).includes("SENHA"));
  assert.equal((await fetch(instance.address + "download/1")).status, 404);
});
