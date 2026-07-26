"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const auth = require("../src/middleware/auth");
const admin = require("../src/controllers/adminRealController");
const models = require("../src/models/painelModels");

const FUNCIONARIO = "507f191e810c19729de860ea";
const LOJA = "507f191e810c19729de860eb";
const OUTRA_LOJA = "507f191e810c19729de860ec";

function request({
  permissoesSessao = ["pedidos"],
  estabelecimentoId = LOJA,
  path = "/admin",
  accept = "text/html",
} = {}) {
  let destruida = false;
  return {
    path,
    body: {},
    params: {},
    xhr: false,
    session: {
      user: {
        id: FUNCIONARIO,
        estabelecimentoId,
        tipo: "funcionario",
        permissoes: permissoesSessao,
      },
      destroy(callback) {
        destruida = true;
        callback();
      },
    },
    get(nome) {
      if (nome.toLowerCase() === "accept") return accept;
      return "";
    },
    flash() {},
    get destruida() {
      return destruida;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    redirectedTo: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      return this;
    },
  };
}

function mockFuncionario(documento) {
  const original = models.Funcionario.findOne;
  const filtros = [];
  models.Funcionario.findOne = filtro => {
    filtros.push(filtro);
    return {
      select() {
        return this;
      },
      lean: async () => documento,
    };
  };
  return {
    filtros,
    restore() {
      models.Funcionario.findOne = original;
    },
  };
}

function funcionario(permissoes = ["pedidos"]) {
  return {
    _id: FUNCIONARIO,
    estabelecimentoId: LOJA,
    nome: "Funcionário",
    email: "funcionario@teste.local",
    funcao: "atendente",
    permissoes,
    ativo: true,
  };
}

test("funcionário ativo é revalidado por id, loja e ativo", async () => {
  const mock = mockFuncionario(funcionario(["estoque"]));
  const req = request();
  let next = 0;
  try {
    await auth.loginRequired(req, response(), () => { next += 1; });
    assert.equal(next, 1);
    assert.deepEqual(mock.filtros[0], {
      _id: FUNCIONARIO,
      estabelecimentoId: LOJA,
      ativo: true,
    });
    assert.deepEqual(req.permissoesAtuais, ["estoque"]);
    assert.deepEqual(req.session.user.permissoes, ["estoque"]);
  } finally {
    mock.restore();
  }
});

test("funcionário desativado após login perde sessão e API recebe 401", async () => {
  const mock = mockFuncionario(null);
  const req = request({
    path: "/admin/api/pedidos/novos",
    accept: "application/json",
  });
  const res = response();
  try {
    await auth.loginRequired(req, res, () => assert.fail("não deve avançar"));
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.success, false);
    assert.equal(req.destruida, true);
  } finally {
    mock.restore();
  }
});

test("permissão removida na base bloqueia a próxima requisição", async () => {
  const mock = mockFuncionario(funcionario([]));
  const req = request({ permissoesSessao: ["estoque"] });
  const res = response();
  let executou = false;
  try {
    await auth.loginRequired(req, res, () => {});
    await auth.permissao("estoque")(req, res, () => { executou = true; });
    assert.equal(executou, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(req.session.user.permissoes, []);
    assert.equal(mock.filtros.length, 1);
  } finally {
    mock.restore();
  }
});

test("permissão adicionada na base vale sem novo login", async () => {
  const mock = mockFuncionario(funcionario(["relatorios"]));
  const req = request({ permissoesSessao: [] });
  let executou = false;
  try {
    await auth.loginRequired(req, response(), () => {});
    await auth.permissao("relatorios")(
      req,
      response(),
      () => { executou = true; },
    );
    assert.equal(executou, true);
    assert.deepEqual(req.permissoesAtuais, ["relatorios"]);
  } finally {
    mock.restore();
  }
});

test("sessão de outra loja ou adulterada não encontra funcionário", async () => {
  for (const estabelecimentoId of [OUTRA_LOJA, null]) {
    const mock = mockFuncionario(null);
    const req = request({
      estabelecimentoId,
      accept: "application/json",
      path: "/admin/api/pedidos/novos",
    });
    const res = response();
    try {
      await auth.loginRequired(req, res, () => assert.fail("não deve avançar"));
      assert.equal(res.statusCode, 401);
      assert.equal(req.destruida, true);
      if (estabelecimentoId) {
        assert.equal(String(mock.filtros[0].estabelecimentoId), estabelecimentoId);
      }
    } finally {
      mock.restore();
    }
  }
});

test("proprietário mantém fluxo próprio sem consultar Funcionario", async () => {
  const original = models.Funcionario.findOne;
  models.Funcionario.findOne = () => assert.fail("não deve consultar funcionário");
  const req = request();
  req.session.user = {
    id: LOJA,
    estabelecimentoId: LOJA,
    tipo: "proprietario",
    permissoes: [],
  };
  let executou = false;
  try {
    await auth.loginRequired(req, response(), () => { executou = true; });
    assert.equal(executou, true);
    assert.equal(req.usuarioAtual.tipo, "proprietario");
  } finally {
    models.Funcionario.findOne = original;
  }
});

test("funcionário não edita a própria permissão nem situação", () => {
  const req = request();
  req.usuarioAtual = req.session.user;
  req.permissoesAtuais = ["funcionarios", "pedidos"];
  assert.throws(
    () => admin._testing.validarAdministracaoFuncionario(
      req,
      ["pedidos"],
      { funcionarioAlvoId: FUNCIONARIO },
    ),
    error => error.code === "PERMISSAO_FUNCIONARIO_NEGADA",
  );
});

test("funcionário não concede permissão superior ou administrativa crítica", () => {
  const req = request();
  req.usuarioAtual = req.session.user;
  req.permissoesAtuais = ["funcionarios", "pedidos"];
  assert.throws(
    () => admin._testing.validarAdministracaoFuncionario(req, ["estoque"]),
    /permissão superior/,
  );
  assert.throws(
    () => admin._testing.validarAdministracaoFuncionario(
      req,
      ["funcionarios"],
    ),
    /Somente o proprietário/,
  );
  req.permissoesAtuais.push("arquivar_pedidos");
  assert.throws(
    () => admin._testing.validarAdministracaoFuncionario(
      req,
      ["arquivar_pedidos"],
    ),
    /Somente o proprietário/,
  );
});

test("middleware atual protege estoque, pedidos e relatórios", async () => {
  const mock = mockFuncionario(funcionario(["estoque", "pedidos", "relatorios"]));
  const req = request();
  try {
    await auth.loginRequired(req, response(), () => {});
    for (const modulo of ["estoque", "pedidos", "relatorios"]) {
      let executou = false;
      await auth.permissao(modulo)(
        req,
        response(),
        () => { executou = true; },
      );
      assert.equal(executou, true);
    }
    assert.equal(mock.filtros.length, 1);
  } finally {
    mock.restore();
  }
});

test("SSE aberto é encerrado quando a permissão é removida", async () => {
  const mock = mockFuncionario(funcionario([]));
  const req = request({ permissoesSessao: ["pedidos"] });
  req.usuarioAtual = req.session.user;
  req.permissoesAtuais = ["pedidos"];
  const res = {
    writableEnded: false,
    end() {
      this.writableEnded = true;
    },
  };
  try {
    const autorizado = await admin._testing.validarAcessoSse(
      req,
      res,
      "pedidos",
      { forcar: true },
    );
    assert.equal(autorizado, false);
    assert.equal(res.writableEnded, true);
  } finally {
    mock.restore();
  }
});

test("login, recuperação e logout preservam as políticas exigidas", () => {
  const login = fs.readFileSync("src/controllers/loginControllerReal.js", "utf8");
  const recuperacao = fs.readFileSync(
    "src/controllers/recuperacaoSenhaController.js",
    "utf8",
  );
  assert.match(login, /\.toLowerCase\(\)\s*\.trim\(\)/);
  assert.match(login, /Funcionario\.findOne\(\{[\s\S]*?ativo:\s*true/);
  assert.match(login, /req\.session\.regenerate/);
  assert.match(login, /req\.session\.destroy/);
  assert.match(recuperacao, /Funcionario\.findOne\(\{\s*email,\s*ativo:\s*true\s*\}\)/);
  assert.doesNotMatch(recuperacao, /\$set:\s*\{\s*ativo:\s*true/);
});
