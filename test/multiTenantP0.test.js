"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const models = require("../src/models/painelModels");
const { Registro, registroModel } = require("../src/models/registroModel");
const admin = require("../src/controllers/adminRealController");
const login = require("../src/controllers/loginControllerReal");
const recuperacao = require("../src/controllers/recuperacaoSenhaController");
const pagamento = require("../src/controllers/pagamentoController");
const printAgentHub = require("../src/services/printAgentHub");
const printQueueService = require("../src/services/printQueueService");

function hasUniqueIndex(model, key, name, partialFilterExpression) {
  return model.schema.indexes().some(([actualKey, options]) =>
    JSON.stringify(actualKey) === JSON.stringify(key)
    && options.unique === true
    && options.name === name
    && (
      partialFilterExpression === undefined
      || JSON.stringify(options.partialFilterExpression)
        === JSON.stringify(partialFilterExpression)
    ));
}

test("índices P0 protegem identidade, agente e tentativa ativa", () => {
  assert.equal(hasUniqueIndex(
    models.Funcionario,
    { email: 1 },
    "funcionario_email_global_unico",
  ), true);
  assert.equal(hasUniqueIndex(
    models.PrintAgent,
    { estabelecimentoId: 1 },
    "print_agent_estabelecimento_unico",
  ), true);
  assert.equal(hasUniqueIndex(
    models.PrintAgent,
    { tokenHash: 1 },
    "print_agent_token_hash_unico",
    { tokenHash: { $type: "string", $gt: "" } },
  ), true);
  assert.equal(hasUniqueIndex(
    models.PrintAgent,
    { codigoVinculacao: 1 },
    "print_agent_codigo_ativo_unico",
    { codigoVinculacao: { $type: "string", $gt: "" } },
  ), true);
  assert.equal(hasUniqueIndex(
    models.AssinaturaTentativa,
    { estabelecimentoId: 1 },
    "assinatura_tentativa_ativa_global_unica",
    { ativa: true },
  ), true);
});

test("cadastro de proprietário normaliza e bloqueia e-mail de funcionário", async () => {
  const originals = {
    ownerFindOne: registroModel.findOne,
    ownerCreate: registroModel.create,
    employeeExists: models.Funcionario.exists,
  };
  let employeeQuery;
  registroModel.findOne = async () => null;
  registroModel.create = async () => {
    throw new Error("não deveria criar");
  };
  models.Funcionario.exists = async query => {
    employeeQuery = query;
    return { _id: "funcionario-existente" };
  };
  const registro = new Registro({
    nome: "Dono",
    nomeEstabelecimento: "Loja",
    email: "  MESMO@EXEMPLO.COM ",
    telefone: "71999999999",
    cpfCnpj: "52998224725",
    senha: "ComandaFacil#2026Segura",
    confirmarSenha: "ComandaFacil#2026Segura",
    aceitarTermos: "on",
  });
  try {
    await registro.register();
    assert.equal(registro.body.email, "mesmo@exemplo.com");
    assert.deepEqual(employeeQuery, { email: "mesmo@exemplo.com" });
    assert.match(registro.errors.join(" "), /E-mail já cadastrado/);
  } finally {
    registroModel.findOne = originals.ownerFindOne;
    registroModel.create = originals.ownerCreate;
    models.Funcionario.exists = originals.employeeExists;
  }
});

test("login normaliza e consulta funcionário uma única vez", async () => {
  const originals = {
    ownerFindOne: registroModel.findOne,
    employeeFindOne: models.Funcionario.findOne,
  };
  let query;
  let employeeLookups = 0;
  registroModel.findOne = async () => null;
  models.Funcionario.findOne = async value => {
    query = value;
    employeeLookups += 1;
    return null;
  };
  const req = {
    body: { email: "  FUNCIONARIO@EXEMPLO.COM ", senha: "invalida" },
    flash() {},
    session: { save(callback) { callback(); } },
  };
  const res = {
    redirect() { return this; },
    status() { return this; },
    render() { return this; },
  };
  try {
    await login.login(req, res);
    assert.deepEqual(query, { email: "funcionario@exemplo.com", ativo: true });
    assert.equal(employeeLookups, 1);
  } finally {
    registroModel.findOne = originals.ownerFindOne;
    models.Funcionario.findOne = originals.employeeFindOne;
  }
});

test("duas lojas não podem reutilizar o mesmo e-mail de funcionário", async () => {
  const originals = {
    employeeExists: models.Funcionario.exists,
    ownerExists: registroModel.exists,
  };
  const queries = [];
  models.Funcionario.exists = async query => {
    queries.push(query);
    return { _id: "funcionario-da-loja-a" };
  };
  registroModel.exists = async () => null;
  try {
    const emUso = await admin._testing.emailFuncionarioEmUso(
      "global@exemplo.com",
    );
    assert.equal(emUso, true);
    assert.deepEqual(queries[0], { email: "global@exemplo.com" });
    assert.equal("estabelecimentoId" in queries[0], false);
  } finally {
    models.Funcionario.exists = originals.employeeExists;
    registroModel.exists = originals.ownerExists;
  }
});

test("edição ignora o próprio funcionário, mas detecta outro e proprietário", async () => {
  const originals = {
    employeeExists: models.Funcionario.exists,
    ownerExists: registroModel.exists,
  };
  let employeeQuery;
  models.Funcionario.exists = async query => {
    employeeQuery = query;
    return null;
  };
  registroModel.exists = async () => ({ _id: "proprietario-conflitante" });
  try {
    const emUso = await admin._testing.emailFuncionarioEmUso(
      "editar@exemplo.com",
      "funcionario-atual",
    );
    assert.equal(emUso, true);
    assert.deepEqual(employeeQuery, {
      email: "editar@exemplo.com",
      _id: { $ne: "funcionario-atual" },
    });
  } finally {
    models.Funcionario.exists = originals.employeeExists;
    registroModel.exists = originals.ownerExists;
  }
});

test("recuperação normaliza e faz uma consulta determinística por tipo de conta", async () => {
  const originals = {
    ownerFindOne: registroModel.findOne,
    employeeFindOne: models.Funcionario.findOne,
  };
  let ownerQuery;
  let employeeLookups = 0;
  registroModel.findOne = async query => {
    ownerQuery = query;
    return null;
  };
  models.Funcionario.findOne = async () => {
    employeeLookups += 1;
    return null;
  };
  const req = {
    body: { email: "  DONO@EXEMPLO.COM " },
    session: {},
  };
  const rendered = [];
  const res = {
    render(view, data) {
      rendered.push({ view, data });
      return this;
    },
  };
  try {
    await recuperacao.solicitarCodigo(req, res);
    assert.deepEqual(ownerQuery, { email: "dono@exemplo.com" });
    assert.equal(employeeLookups, 1);
    assert.match(rendered[0].data.success[0], /Se esse e-mail estiver cadastrado/);
  } finally {
    registroModel.findOne = originals.ownerFindOne;
    models.Funcionario.findOne = originals.employeeFindOne;
  }
});

test("falha de e-mail invalida o código sem esconder o erro original", async () => {
  const erroEnvio = Object.assign(new Error("SMTP indisponível"), {
    code: "ESOCKET",
  });
  const updates = [];

  await assert.rejects(
    recuperacao._testing.enviarCodigoPersistido({
      recuperacaoId: "507f191e810c19729de860ea",
      email: "usuario@example.com",
      nome: "Usuário",
      codigo: "123456",
      enviar: async () => { throw erroEnvio; },
      RecuperacaoSenhaModel: {
        async updateOne(filter, update) {
          updates.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
      },
    }),
    error => error === erroEnvio,
  );

  assert.deepEqual(updates, [{
    filter: {
      _id: "507f191e810c19729de860ea",
      usado: false,
    },
    update: { $set: { usado: true } },
  }]);

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, "../src/controllers/recuperacaoSenhaController.js"),
    "utf8",
  );
  assert.match(
    controllerSource,
    /RecuperacaoSenha\.findOne\(\{\s*email,\s*usado: false,?\s*\}\)/,
  );
});

test("envio bem-sucedido mantém o código ativo", async () => {
  let updates = 0;
  await recuperacao._testing.enviarCodigoPersistido({
    recuperacaoId: "507f191e810c19729de860ea",
    email: "usuario@example.com",
    nome: "Usuário",
    codigo: "123456",
    enviar: async () => undefined,
    RecuperacaoSenhaModel: {
      async updateOne() { updates += 1; },
    },
  });
  assert.equal(updates, 0);
});

test("reserva de código repete após colisão sem sobrescrever outra loja", async () => {
  const originals = {
    updateMany: models.PrintAgent.updateMany,
    findOneAndUpdate: models.PrintAgent.findOneAndUpdate,
  };
  const calls = [];
  models.PrintAgent.updateMany = async () => ({ modifiedCount: 0 });
  models.PrintAgent.findOneAndUpdate = async (filter, update) => {
    calls.push({ filter, update });
    if (calls.length === 1) {
      throw Object.assign(new Error("colisão"), { code: 11000 });
    }
    return { estabelecimentoId: filter.estabelecimentoId };
  };
  const codes = ["111111", "222222"];
  try {
    const result = await admin._testing.reservarCodigoAgente(
      "507f191e810c19729de860ea",
      () => codes.shift(),
    );
    assert.equal(result.codigo, "222222");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.filter), [
      { estabelecimentoId: "507f191e810c19729de860ea" },
      { estabelecimentoId: "507f191e810c19729de860ea" },
    ]);
  } finally {
    models.PrintAgent.updateMany = originals.updateMany;
    models.PrintAgent.findOneAndUpdate = originals.findOneAndUpdate;
  }
});

function setupHub() {
  printQueueService.drenarFilaDoEstabelecimento = async () => {};
  let middleware;
  const namespace = {
    use(handler) { middleware = handler; },
    on() {},
  };
  printAgentHub.init({ of: () => namespace });
  return middleware;
}

test("consumo simultâneo permite o código a apenas um agente", async () => {
  const originals = {
    findOne: models.PrintAgent.findOne,
    findOneAndUpdate: models.PrintAgent.findOneAndUpdate,
    updateMany: models.PrintAgent.updateMany,
  };
  let available = true;
  models.PrintAgent.findOne = async () => null;
  models.PrintAgent.findOneAndUpdate = async () => {
    if (!available) return null;
    available = false;
    return { estabelecimentoId: "507f191e810c19729de860ea" };
  };
  models.PrintAgent.updateMany = async () => ({ modifiedCount: 0 });
  const middleware = setupHub();
  const connect = () => {
    const socket = {
      handshake: {
        auth: {
          code: "123456",
          agentVersion: "1.2.0",
          protocolVersion: 2,
          supportedProtocolVersions: [2],
        },
      },
      data: {},
    };
    return new Promise(resolve =>
      middleware(socket, error => resolve({ socket, error })));
  };
  try {
    const results = await Promise.all([connect(), connect()]);
    assert.equal(results.filter(result => !result.error).length, 1);
    assert.equal(results.filter(result => result.error).length, 1);
    assert.ok(results.find(result => !result.error).socket.data.newToken);
  } finally {
    models.PrintAgent.findOne = originals.findOne;
    models.PrintAgent.findOneAndUpdate = originals.findOneAndUpdate;
    models.PrintAgent.updateMany = originals.updateMany;
  }
});

test("Pix e cartão simultâneos não criam duas tentativas ativas", async () => {
  const originals = {
    updateMany: models.AssinaturaTentativa.updateMany,
    findOne: models.AssinaturaTentativa.findOne,
    create: models.AssinaturaTentativa.create,
  };
  let stored = null;
  models.AssinaturaTentativa.updateMany = async () => ({ modifiedCount: 0 });
  models.AssinaturaTentativa.findOne = async () => stored;
  models.AssinaturaTentativa.create = async data => {
    if (stored) throw Object.assign(new Error("duplicate"), { code: 11000 });
    stored = { _id: "attempt", ...data };
    return stored;
  };
  const assinatura = {
    _id: "507f1f77bcf86cd799439011",
    estabelecimentoId: "507f191e810c19729de860ea",
    status: "teste",
  };
  try {
    const results = await Promise.allSettled([
      pagamento._testing.obterOuCriarTentativa(assinatura, "pix"),
      pagamento._testing.obterOuCriarTentativa(assinatura, "cartao"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected");
    assert.equal(rejected.reason.code, "TENTATIVA_METODO_DIFERENTE");
  } finally {
    models.AssinaturaTentativa.updateMany = originals.updateMany;
    models.AssinaturaTentativa.findOne = originals.findOne;
    models.AssinaturaTentativa.create = originals.create;
  }
});
