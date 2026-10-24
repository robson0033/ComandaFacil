"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

try {
  const root = path.resolve(__dirname, "..");
  const dependencies = [
    ["cidadeEntregaService", ["cidadeDisponivelNoHorario", "normalizarHorarioLimiteEntrega", "avaliarRegraEntregaCidade", "calcularTotaisPedidoComEntrega", "montarDadosCidadeEntrega", "validarTaxaEntregaCentavos"]],
    ["timezoneService", ["datePartsInTimezone", "getEstablishmentTimezone", "formatDateTimeInTimezone", "localDateTimeToUtc"]],
    ["mesaPagamentoService", ["montarPlanoPagamentoCatalogo", "valorFormaPagamentoCentavos", "valorMonetarioParaCentavos", "totalParaCentavos"]],
  ];
  for (const [name, methods] of dependencies) {
    const service = require(path.join(root, "src", "services", name));
    for (const method of methods)
      assert.equal(typeof service[method], "function", `${name}.${method} está ausente ou incompatível.`);
  }
  const city = require(path.join(root, "src/services/cidadeEntregaService"));
  assert.equal(city.cidadeDisponivelNoHorario({}), true, "Cidade sem horário precisa continuar disponível.");
  assert.equal(city.cidadeDisponivelNoHorario({ horarioLimiteEntrega: "22:00" }, new Date("2026-10-25T01:00:00Z"), "America/Bahia"), false);
  const controller = require(path.join(root, "src/controllers/adminRealController"));
  assert.equal(typeof controller.catalogoPublico, "function");
  assert.equal(typeof controller.criarPedidoCatalogo, "function");
  const filename = path.join(root, "src/views/catalogo-publico.ejs");
  const source = fs.readFileSync(filename, "utf8");
  assert.ok(source.includes('id="trocoModal"') && source.includes('abrirModalTroco(payload, valorDinheiroCentavos)'), "O cardápio com modal de troco combinado ainda não foi copiado.");
  require("ejs").compile(source, { filename });
  const adminFilename = path.join(root, "src/views/admin-real.ejs");
  const adminSource = fs.readFileSync(adminFilename, "utf8");
  assert.ok(adminSource.includes("pagamentosPedido.some(item => item.formaPagamento === 'dinheiro')"), "O painel que mostra troco em pagamentos combinados ainda não foi copiado.");
  require("ejs").compile(adminSource, { filename: adminFilename });
  console.log("Verificação concluída: controller, cardápio, cidades, fuso horário e pagamentos compatíveis.");
  console.log("Nenhum pedido, cobrança ou alteração de banco foi realizado.");
} catch (error) {
  console.error("Verificação interrompida:", error.message);
  process.exitCode = 1;
}
