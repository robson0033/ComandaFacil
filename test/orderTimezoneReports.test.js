"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const admin = require("../src/controllers/adminRealController");
const { Categoria, Pedido, Produto } = require("../src/models/painelModels");
const {
  DEFAULT_TIMEZONE,
  formatDateTimeInTimezone,
  getEstablishmentTimezone,
  localDateRangeToUtc,
  localDateTimeToUtc,
} = require("../src/services/timezoneService");

test("instante UTC do pagamento é exibido no fuso do estabelecimento", () => {
  const instant = new Date("2026-08-01T18:26:04.000Z");
  assert.equal(formatDateTimeInTimezone(instant, DEFAULT_TIMEZONE), "01/08/2026, 15:26:04");
  assert.doesNotMatch(formatDateTimeInTimezone(instant, DEFAULT_TIMEZONE), /18:26/);
});

test("formata igual quando o processo do servidor está em UTC", () => {
  const previous = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    assert.equal(
      formatDateTimeInTimezone("2026-08-01T18:26:04.000Z", DEFAULT_TIMEZONE),
      "01/08/2026, 15:26:04",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("intervalo local de hoje inclui as duas bordas e exclui dias vizinhos", () => {
  const range = localDateRangeToUtc({
    startDate: "2026-08-01",
    endDate: "2026-08-01",
    timezone: DEFAULT_TIMEZONE,
  });
  assert.equal(range.startUtc.toISOString(), "2026-08-01T03:00:00.000Z");
  assert.equal(range.endUtc.toISOString(), "2026-08-02T02:59:59.999Z");
  assert.ok(new Date("2026-08-01T03:00:00.000Z") >= range.startUtc);
  assert.ok(new Date("2026-08-02T02:59:59.999Z") <= range.endUtc);
  assert.ok(new Date("2026-08-01T02:59:59.999Z") < range.startUtc);
  assert.ok(new Date("2026-08-02T03:00:00.000Z") > range.endUtc);
});

test("períodos hoje, semana, mês e personalizado independem do fuso do servidor", () => {
  const now = new Date("2026-08-01T18:27:00.000Z");
  const today = admin.obterPeriodoRelatorio("hoje", "", "", now, DEFAULT_TIMEZONE);
  const week = admin.obterPeriodoRelatorio("semana", "", "", now, DEFAULT_TIMEZONE);
  const month = admin.obterPeriodoRelatorio("mes", "", "", now, DEFAULT_TIMEZONE);
  const custom = admin.obterPeriodoRelatorio(
    "personalizado", "2026-07-31", "2026-08-01", now, DEFAULT_TIMEZONE,
  );
  assert.equal(today.inicio.toISOString(), "2026-08-01T03:00:00.000Z");
  assert.equal(week.inicio.toISOString(), "2026-07-27T03:00:00.000Z");
  assert.equal(month.inicio.toISOString(), "2026-08-01T03:00:00.000Z");
  assert.equal(custom.inicio.toISOString(), "2026-07-31T03:00:00.000Z");
  assert.equal(custom.fim.toISOString(), "2026-08-02T02:59:59.999Z");
});

test("conversão usa regra histórica do Intl em vez de offset fixo", () => {
  assert.equal(
    localDateTimeToUtc({ year: 2018, month: 2, day: 1 }, DEFAULT_TIMEZONE).toISOString(),
    "2018-02-01T02:00:00.000Z",
  );
});

test("timezone inválido recebe fallback seguro", () => {
  assert.equal(getEstablishmentTimezone({ timezone: "Invalid/Zone" }), DEFAULT_TIMEZONE);
});

test("gráfico de hoje possui 24 horas e coloca 15:26 exclusivamente em 15h", () => {
  const graph = admin._testing.montarGraficoAgregado([
    { _id: "2026-08-01-15", valor: 28, quantidade: 1 },
  ], "hoje", DEFAULT_TIMEZONE);
  assert.equal(graph.labels.length, 24);
  assert.equal(graph.labels[0], "00h");
  assert.equal(graph.labels[23], "23h");
  assert.equal(graph.valores[15], 28);
  assert.equal(graph.valores[8], 0);
  assert.equal(graph.pedidosPagos[15], 1);
});

test("agrega faturamento horário por pagoEm com timezone explícito", async t => {
  const originalAggregate = Pedido.aggregate;
  const originalCountDocuments = Pedido.countDocuments;
  const originalCategoriaFind = Categoria.find;
  const originalProdutoFind = Produto.find;

  let pipeline;
  Pedido.aggregate = async value => {
    pipeline = value;
    return [{ financeiro: [], finalizados: [], grafico: [], produtos: [] }];
  };
  Pedido.countDocuments = async () => 0;

  const emptyLeanQuery = () => ({
    select() { return this; },
    lean: async () => [],
  });
  Categoria.find = () => emptyLeanQuery();
  Produto.find = () => emptyLeanQuery();

  t.after(() => {
    Pedido.aggregate = originalAggregate;
    Pedido.countDocuments = originalCountDocuments;
    Categoria.find = originalCategoriaFind;
    Produto.find = originalProdutoFind;
  });

  await admin._testing.agregarRelatorios({
    idEstabelecimento: "tenant-a",
    periodo: { filtro: "hoje", inicio: new Date("2026-08-01T03:00:00Z"), fim: new Date("2026-08-02T02:59:59.999Z") },
    canalAtual: "todos",
    timeZone: DEFAULT_TIMEZONE,
  });
  const graphPipeline = pipeline.find(stage => stage.$facet).$facet.grafico;
  const serialized = JSON.stringify(graphPipeline);
  assert.match(serialized, /\$pagoEm/);
  assert.doesNotMatch(serialized, /\$createdAt/);
  assert.match(serialized, /America\/Sao_Paulo/);
});

test("schema mantém pagoEm como Date e frontend usa fuso explícito", () => {
  assert.equal(Pedido.schema.path("pagoEm").instance, "Date");
  const view = fs.readFileSync(path.join(__dirname, "../src/views/admin-real.ejs"), "utf8");
  assert.match(view, /formatarDataHoraEstabelecimento\(dataPagamentoPedido\)/);
  assert.match(view, /timeZone: fusoEstabelecimento/);
  assert.match(view, /Pedidos pagos:/);
});
