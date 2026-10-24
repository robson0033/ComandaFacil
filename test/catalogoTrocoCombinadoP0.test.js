"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const admin = require("../src/controllers/adminRealController");
const models = require("../src/models/painelModels");
const printQueue = require("../src/services/printQueueService");

const LOJA = "507f191e810c19729de860ea";
const PRODUTO = "507f191e810c19729de860eb";
const CIDADE = "507f191e810c19729de860ec";

function fixture() {
  const restore = [];
  const replace = (object, key, value) => {
    const previous = object[key];
    restore.push(() => { object[key] = previous; });
    object[key] = value;
  };
  const captured = [];
  replace(models.Configuracao, "findOne", () => ({ lean: async () => ({
    estabelecimentoId: LOJA,
    horarioAbertura: "00:00", horarioFechamento: "00:00",
    diasFuncionamento: [0, 1, 2, 3, 4, 5, 6],
    mercadoPago: { conectado: true },
  }) }));
  replace(models.Assinatura, "findOne", () => ({ lean: async () => ({
    status: "teste", fimTeste: new Date(Date.now() + 600_000),
  }) }));
  replace(models.Produto, "find", () => ({ lean: async () => [{
    _id: PRODUTO, nome: "Produto de teste", preco: 71.5, ativo: true,
    fichaTecnica: [], adicionais: [],
  }] }));
  replace(models.CidadeEntrega, "findOne", () => ({
    select() { return this; },
    lean: async () => ({ _id: CIDADE, nome: "Cidade teste", uf: "MA", taxaCentavos: 1500 }),
  }));
  replace(printQueue, "criarPedidoComJobsAutomaticos", async values => {
    captured.push(values);
    return { _id: "507f191e810c19729de860ef", numeroPedido: 1, ...values };
  });
  return {
    captured,
    async run(overrides = {}) {
      const req = { params: { slug: "teste" }, body: {
        idempotencyKey: crypto.randomUUID(), cliente: "Cliente de teste",
        telefone: "98999999999", canal: "delivery", cidadeEntregaId: CIDADE,
        ruaEntrega: "Rua de teste", numeroEntrega: "1", bairroEntrega: "Centro",
        formaPagamento: "combinado", formaPagamento1: "pix", valorPagamento1: "50,00",
        formaPagamento2: "dinheiro", precisaTroco: true, trocoPara: 50,
        itens: [{ produtoId: PRODUTO, preco: 71.5, quantidade: 1, adicionais: [] }],
        ...overrides,
      } };
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
      await admin.criarPedidoCatalogo(req, res);
      return res;
    },
    close() { restore.reverse().forEach(run => run()); },
  };
}

test("troco combinado usa apenas os R$ 36,50 em dinheiro e preserva a taxa de entrega", async () => {
  const f = fixture();
  try {
    const res = await f.run();
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(f.captured.length, 1);
    const order = f.captured[0];
    assert.equal(order.total, 86.5);
    assert.equal(order.taxaEntregaCentavos, 1500);
    assert.deepEqual(order.pagamentos, [
      { formaPagamento: "pix_online", valorCentavos: 5000 },
      { formaPagamento: "dinheiro", valorCentavos: 3650 },
    ]);
    assert.equal(order.precisaTroco, true);
    assert.equal(order.trocoPara, 50);
    assert.equal(order.valorTroco, 13.5);
  } finally { f.close(); }
});

test("dinheiro no primeiro componente aceita números JSON e texto com vírgula ou ponto", async () => {
  const f = fixture();
  try {
    for (const value of [50.5, "50,50", "50.50", "R$ 50,50"]) {
      const res = await f.run({ formaPagamento1: "dinheiro", valorPagamento1: "36,50",
        formaPagamento2: "cartao", trocoPara: value });
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
      assert.equal(f.captured.at(-1).trocoPara, 50.5);
      assert.equal(f.captured.at(-1).valorTroco, 14);
    }
  } finally { f.close(); }
});

test("troco é persistido em centavos sem resíduos de ponto flutuante", async () => {
  const f = fixture();
  try {
    const res = await f.run({ trocoPara: "50,01" });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(f.captured[0].valorTroco, 13.51);
    const exact = await f.run({ trocoPara: 36.5 });
    assert.equal(exact.statusCode, 201, JSON.stringify(exact.body));
    assert.equal(f.captured[1].valorTroco, 0);
  } finally { f.close(); }
});

test("servidor rejeita dinheiro insuficiente ou inválido antes de criar pedido ou impressão", async () => {
  const f = fixture();
  try {
    for (const value of [36.49, "abc", "50,555", -50, "Infinity", null]) {
      const res = await f.run({ trocoPara: value });
      assert.equal(res.statusCode, 400, `${value}: ${JSON.stringify(res.body)}`);
    }
    assert.equal(f.captured.length, 0);
  } finally { f.close(); }
});

test("sem dinheiro no pedido não se pode solicitar troco", async () => {
  const f = fixture();
  try {
    const res = await f.run({ formaPagamento2: "cartao" });
    assert.equal(res.statusCode, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, "PUBLIC_PAYMENT_VALIDATION");
    assert.equal(f.captured.length, 0);
  } finally { f.close(); }
});

test("sem troco e pagamento único em dinheiro continuam compatíveis", async () => {
  const f = fixture();
  try {
    let res = await f.run({ precisaTroco: false, trocoPara: null });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(f.captured[0].precisaTroco, false);
    assert.equal(f.captured[0].trocoPara, null);
    assert.equal(f.captured[0].valorTroco, null);
    res = await f.run({ formaPagamento: "dinheiro", trocoPara: "100,00" });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(f.captured[1].valorTroco, 13.5);
  } finally { f.close(); }
});
