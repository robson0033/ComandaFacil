"use strict";

const { Funcionario } = require("../models/painelModels");
const {
  clearSessionCookie,
  markSessionEnding,
} = require("../config/sessionConfig");
const appState = require("../runtime/appState");
const { safeFlash } = require("../utils/safeFlash");
const { assertKnownPermission } = require("../config/permissions");

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
  markSessionEnding(req, "unknown");
  appState.closeSseConnectionsForSession(req.sessionID);
  if (typeof req.session?.destroy === "function") {
    return req.session.destroy(error => {
      if (error) {
        console.error("session_destroy_failed", {
          code: "SESSION_DESTROY_FAILED",
          type: String(error.name || "Error").slice(0, 80),
        });
      }
      return callback(error || null);
    });
  }
  if (req.session) {
    delete req.session.user;
    delete req.session.usuario;
  }
  return callback();
}

function negarAutenticacao(req, res) {
  console.warn("access_blocked", {
    correlationId: req.correlationId,
    code: "SESSION_INVALID",
    method: req.method,
    path: String(req.path || "").slice(0, 300),
    requestType: requisicaoEsperaJson(req) ? "api" : "html",
    sessionPresent: Boolean(req.session),
    userAuthenticated: Boolean(req.session?.user),
    tenantPresent: Boolean(
      req.session?.user?.estabelecimentoId || req.session?.user?.id,
    ),
  });
  return encerrarSessao(req, error => {
    clearSessionCookie(res, process.env.NODE_ENV === "production");
    if (error) {
      if (requisicaoEsperaJson(req)) {
        return res.status(500).json({
          success: false,
          message: "Não foi possível encerrar a sessão.",
        });
      }
      return res.status(500).render("404");
    }
    if (String(req.get?.("accept") || "").includes("text/event-stream")) {
      res.status(401);
      return res.end();
    }
    if (requisicaoEsperaJson(req)) {
      return res.status(401).json({
        success: false,
        code: "SESSION_INVALID",
        message: "Sua sessão não é mais válida. Entre novamente.",
        correlationId: req.correlationId,
      });
    }
    safeFlash(req, "errors", "Faça login novamente para acessar o painel.");
    return res.redirect(303, "/login");
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

function negarPermissao(req, res, message) {
  console.warn("access_blocked", {
    correlationId: req.correlationId,
    code: "PERMISSION_DENIED",
    method: req.method,
    path: String(req.path || "").slice(0, 300),
    requestType: requisicaoEsperaJson(req) ? "api" : "html",
    sessionPresent: Boolean(req.session),
    userAuthenticated: Boolean(req.session?.user),
    tenantPresent: Boolean(
      req.session?.user?.estabelecimentoId || req.session?.user?.id,
    ),
  });
  if (requisicaoEsperaJson(req)) {
    return res.status(403).json({
      success: false,
      code: "PERMISSION_DENIED",
      message,
      correlationId: req.correlationId,
    });
  }
  return res.status(403).send(`Operação bloqueada (PERMISSION_DENIED). ${message}`);
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

exports.permissao = modulo => {
  assertKnownPermission(modulo);
  return async (req, res, next) => {
  try {
    const usuario = await carregarIdentidadeAtual(req);
    if (!usuario) return negarAutenticacao(req, res);
    if (
      usuario.tipo === "proprietario"
      || req.permissoesAtuais.includes(modulo)
    ) {
      return next();
    }
    return negarPermissao(
      req,
      res,
      "Você não possui permissão para esta ação.",
    );
  } catch (error) {
    return next(error);
  }
  };
};

exports.permissaoQualquer = (...modulos) => {
  const permissoes = [...new Set(modulos.flat().map(String))];
  if (!permissoes.length) {
    throw new Error("Informe ao menos uma permissão.");
  }
  permissoes.forEach(assertKnownPermission);

  return async (req, res, next) => {
    try {
      const usuario = await carregarIdentidadeAtual(req);
      if (!usuario) return negarAutenticacao(req, res);
      if (
        usuario.tipo === "proprietario"
        || permissoes.some(permissao => req.permissoesAtuais.includes(permissao))
      ) {
        return next();
      }
      return negarPermissao(
        req,
        res,
        "Você não possui permissão para esta ação.",
      );
    } catch (error) {
      return next(error);
    }
  };
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

    return negarPermissao(
      req,
      res,
      "Você não possui permissão para esta ação.",
    );
  } catch (error) {
    return next(error);
  }
};

exports.permissaoCategoriaLeitura = async (req, res, next) => {
  try {
    const user = await carregarIdentidadeAtual(req);
    if (!user) return negarAutenticacao(req, res);
    if (
      user.tipo === "proprietario"
      || req.permissoesAtuais.includes("estoque")
      || req.permissoesAtuais.includes("catalogo")
    ) {
      return next();
    }
    return negarPermissao(
      req,
      res,
      "Você não possui permissão para acessar categorias.",
    );
  } catch (error) {
    return next(error);
  }
};

exports.somenteProprietario = (req, res, next) => {
  const usuario = req.usuarioAtual || req.session?.user;
  if (!usuario) return negarAutenticacao(req, res);
  if (usuario.tipo === "proprietario") return next();
  return negarPermissao(
    req,
    res,
    "Esta área é exclusiva do proprietário.",
  );
};

exports._testing = {
  carregarIdentidadeAtual,
  encerrarSessao,
  negarAutenticacao,
  negarPermissao,
  requisicaoEsperaJson,
};
exports.carregarIdentidadeAtual = carregarIdentidadeAtual;
exports.encerrarSessao = encerrarSessao;
