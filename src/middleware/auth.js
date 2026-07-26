"use strict";

const { Funcionario } = require("../models/painelModels");

function requisicaoEsperaJson(req) {
  return Boolean(
    req.path?.includes("/api/")
    || req.xhr
    || String(req.get?.("accept") || "").includes("application/json")
    || String(req.get?.("accept") || "").includes("text/event-stream")
    || String(req.get?.("content-type") || "").includes("application/json"),
  );
}

function encerrarSessao(req, callback) {
  if (typeof req.session?.destroy === "function") {
    return req.session.destroy(() => callback());
  }
  if (req.session) {
    delete req.session.user;
    delete req.session.usuario;
  }
  return callback();
}

function negarAutenticacao(req, res) {
  return encerrarSessao(req, () => {
    if (requisicaoEsperaJson(req)) {
      return res.status(401).json({
        success: false,
        message: "Sua sessão não é mais válida. Entre novamente.",
      });
    }
    req.flash?.("errors", "Faça login novamente para acessar o painel.");
    return res.redirect("/login/index");
  });
}

async function carregarIdentidadeAtual(req, { forcar = false } = {}) {
  if (forcar) {
    delete req.usuarioAtual;
    delete req.permissoesAtuais;
  }
  if (req.usuarioAtual && Array.isArray(req.permissoesAtuais)) {
    return req.usuarioAtual;
  }

  const usuarioSessao = req.session?.user;
  if (!usuarioSessao) return null;

  if (usuarioSessao.tipo !== "funcionario") {
    req.usuarioAtual = usuarioSessao;
    req.permissoesAtuais = Array.isArray(usuarioSessao.permissoes)
      ? [...usuarioSessao.permissoes]
      : [];
    return req.usuarioAtual;
  }

  const funcionarioId = usuarioSessao.id || usuarioSessao._id;
  const idEstabelecimento = usuarioSessao.estabelecimentoId;
  if (!funcionarioId || !idEstabelecimento) return null;

  const funcionario = await Funcionario.findOne({
    _id: funcionarioId,
    estabelecimentoId: idEstabelecimento,
    ativo: true,
  })
    .select("_id estabelecimentoId nome email funcao permissoes ativo")
    .lean();

  if (!funcionario) return null;

  const permissoesAtuais = [...new Set(
    Array.isArray(funcionario.permissoes)
      ? funcionario.permissoes.map(String)
      : [],
  )];
  const usuarioAtual = {
    id: funcionario._id,
    estabelecimentoId: funcionario.estabelecimentoId,
    nome: funcionario.nome,
    email: funcionario.email,
    tipo: "funcionario",
    funcao: funcionario.funcao,
    permissoes: permissoesAtuais,
  };

  req.usuarioAtual = usuarioAtual;
  req.permissoesAtuais = permissoesAtuais;
  req.session.user = usuarioAtual;
  if (req.session.usuario) {
    req.session.usuario = {
      ...req.session.usuario,
      ...usuarioAtual,
      permissoes: permissoesAtuais,
    };
  }
  return usuarioAtual;
}

exports.loginRequired = async (req, res, next) => {
  try {
    const usuario = await carregarIdentidadeAtual(req);
    if (!usuario) return negarAutenticacao(req, res);
    return next();
  } catch (error) {
    return next(error);
  }
};

exports.permissao = modulo => async (req, res, next) => {
  try {
    const usuario = await carregarIdentidadeAtual(req);
    if (!usuario) return negarAutenticacao(req, res);
    if (
      usuario.tipo === "proprietario"
      || req.permissoesAtuais.includes(modulo)
    ) {
      return next();
    }
    return res.status(403).send(
      "Você não tem permissão para acessar este módulo.",
    );
  } catch (error) {
    return next(error);
  }
};

exports.permissaoCategoria = async (req, res, next) => {
  try {
    const user = await carregarIdentidadeAtual(req);
    if (!user) return negarAutenticacao(req, res);

    let tipo = String(req.body.tipo || "").trim();

    if (req.params.id) {
      const { Categoria } = require("../models/painelModels");
      const idEstabelecimento = user.estabelecimentoId || user.id;

      const categoria = await Categoria.findOne({
        _id: req.params.id,
        estabelecimentoId: idEstabelecimento,
      })
        .select("tipo")
        .lean();

      if (!categoria) {
        return res.status(404).send("Categoria não encontrada.");
      }

      tipo = categoria.tipo;
    }

    if (!["estoque", "catalogo"].includes(tipo)) {
      return res.status(400).send("Tipo de categoria inválido.");
    }

    const modulo = tipo === "catalogo" ? "catalogo" : "estoque";
    if (
      user.tipo === "proprietario"
      || req.permissoesAtuais.includes(modulo)
    ) {
      return next();
    }

    return res.status(403).send(
      "Você não tem permissão para acessar este módulo.",
    );
  } catch (error) {
    return next(error);
  }
};

exports.somenteProprietario = (req, res, next) => {
  const usuario = req.usuarioAtual || req.session?.user;
  if (!usuario) return negarAutenticacao(req, res);
  if (usuario.tipo === "proprietario") return next();
  if (requisicaoEsperaJson(req)) {
    return res.status(403).json({
      success: false,
      message: "Esta área é exclusiva do proprietário.",
    });
  }
  return res.status(403).send("Esta área é exclusiva do proprietário.");
};

exports._testing = {
  carregarIdentidadeAtual,
  encerrarSessao,
  negarAutenticacao,
  requisicaoEsperaJson,
};
exports.carregarIdentidadeAtual = carregarIdentidadeAtual;
exports.encerrarSessao = encerrarSessao;
