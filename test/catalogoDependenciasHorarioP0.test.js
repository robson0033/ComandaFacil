"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");
const city = require("../src/services/cidadeEntregaService");
const timezone = require("../src/services/timezoneService");
const security = require("../src/utils/htmlSecurity");
const controller = fs.readFileSync(path.join(__dirname, "../src/controllers/adminRealController.js"), "utf8");
const routeStart = controller.indexOf("exports.catalogoPublico = async");
const route = controller.slice(routeStart, controller.indexOf("\nexports.statusProdutosCatalogo", routeStart));

async function openCatalog(cityFunction) {
  const errors = [];
  const context = {
    exports: {},
    Configuracao: { findOne: () => ({ lean: async () => ({
      nomeEstabelecimento: "Loja teste", slug: "teste", estabelecimentoId: "loja", timezone: "America/Bahia",
    }) }) },
    consultarAcessoVenda: async () => ({ permitido: true }),
    buscarProdutosPublicosDoEstabelecimento: async () => [],
    Avaliacao: { aggregate: async () => [] },
    CidadeEntrega: { find: () => ({
      select() { return this; }, sort() { return this; },
      lean: async () => [{ _id: "cidade", nome: "Cidade teste", uf: "MA", taxaCentavos: 1500 }],
    }) },
    getEstablishmentTimezone: timezone.getEstablishmentTimezone,
    cidadeDisponivelNoHorario: cityFunction,
    appLogger: { error: (...values) => errors.push(values) },
  };
  vm.runInNewContext(route, context);
  const res = { code: 200, status(code) { this.code = code; return this; },
    set() { return this; }, render(view, locals) { this.view = view; this.locals = locals; return this; } };
  await context.exports.catalogoPublico({ params: { slug: "teste" } }, res);
  return { res, errors };
}

test("reproduz TypeError do pacote incompleto quando falta a função de cidades", async () => {
  const { res, errors } = await openCatalog(undefined);
  assert.equal(res.code, 500);
  assert.match(errors[0][1].message, /cidadeDisponivelNoHorario is not a function/);
});

test("catálogo real volta a renderizar com serviço de cidades compatível", async () => {
  const { res, errors } = await openCatalog(city.cidadeDisponivelNoHorario);
  assert.equal(res.code, 200);
  assert.equal(res.view, "catalogo-publico");
  assert.equal(errors.length, 0);
  assert.equal(res.locals.cidadesEntrega[0].disponivel, true);
  const html = ejs.render(fs.readFileSync(path.join(__dirname, "../src/views/catalogo-publico.ejs"), "utf8"), {
    ...res.locals, ...security, cspNonce: "fixture", csrfToken: "fixture",
  });
  assert.match(html, /Precisa de troco\?/);
  assert.doesNotMatch(html, /id="combinedCashChange"/);
  assert.match(html, /Cidade teste - MA/);
});

test("serviço de cidades encontra suas dependências de fuso horário", () => {
  for (const name of ["datePartsInTimezone", "getEstablishmentTimezone", "formatDateTimeInTimezone", "localDateTimeToUtc"])
    assert.equal(typeof timezone[name], "function", name);
  for (const name of ["cidadeDisponivelNoHorario", "montarDadosCidadeEntrega", "calcularTotaisPedidoComEntrega", "avaliarRegraEntregaCidade"])
    assert.equal(typeof city[name], "function", name);
});

test("cidade sem horário permanece disponível e cidade inativa não é liberada", () => {
  assert.equal(city.cidadeDisponivelNoHorario({}), true);
  assert.equal(city.cidadeDisponivelNoHorario({ horarioLimiteEntrega: "" }), true);
  assert.equal(city.cidadeDisponivelNoHorario({ ativo: false }), false);
  assert.equal(city.cidadeDisponivelNoHorario(null), false);
});

test("limite de entrega respeita a hora da loja inclusive no minuto de encerramento", () => {
  for (const tz of ["America/Bahia", "America/Fortaleza"]) {
    const data = { horarioLimiteEntrega: "22:00" };
    assert.equal(city.cidadeDisponivelNoHorario(data, new Date("2026-10-25T00:59:59Z"), tz), true);
    assert.equal(city.cidadeDisponivelNoHorario(data, new Date("2026-10-25T01:00:00Z"), tz), false);
    assert.equal(city.cidadeDisponivelNoHorario(data, new Date("2026-10-25T01:01:00Z"), tz), false);
  }
});

test("horário inválido não é aceito no cadastro", () => {
  for (const value of ["25:00", "22:60", "abc", "9:00"])
    assert.throws(() => city.normalizarHorarioLimiteEntrega(value), /horário limite válido/);
  assert.equal(city.normalizarHorarioLimiteEntrega(" 22:00 "), "22:00");
});
