const bcrypt = require("bcryptjs");
const validator = require("validator");
const { registroModel } = require("../models/registroModel");
const { Funcionario } = require("../models/painelModels");
const {
  SESSION_MAX_AGE_MS,
  clearSessionCookie,
  markSessionEnding,
} = require("../config/sessionConfig");
const appState = require("../runtime/appState");

const TRINTA_DIAS = 1000 * 60 * 60 * 24 * 30;

function configurarDuracaoDaSessao(req, lembrar) {
  if (lembrar) {
    req.session.cookie.maxAge = TRINTA_DIAS;
    return;
  }

  req.session.cookie.maxAge = SESSION_MAX_AGE_MS;
}

function autenticarComNovaSessao(req, res, user, lembrar) {
  const previousSessionId = req.sessionID;
  markSessionEnding(req, "regenerated");
  appState.closeSseConnectionsForSession(previousSessionId);
  return req.session.regenerate(error => {
    if (error) {
      console.error("session_regenerate_failed", { code: "SESSION_REGENERATE_FAILED" });
      return res.status(500).render("404");
    }
    configurarDuracaoDaSessao(req, lembrar);
    req.session.user = user;
    return req.session.save(saveError => {
      if (saveError) {
        console.error("session_save_failed", { code: "SESSION_SAVE_FAILED" });
        return res.status(500).render("404");
      }
      res.clearCookie("connect.sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
      return res.redirect("/admin");
    });
  });
}

exports.login = async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .toLowerCase()
      .trim();
    const senha = String(req.body.senha || "");
    const lembrar = req.body.lembrar === "on";

    if (!validator.isEmail(email) || !senha) {
      req.flash("errors", "E-mail ou senha inválidos.");
      return req.session.save(() => res.redirect("/login/index"));
    }

    const dono = await registroModel.findOne({ email });

    if (dono && (await bcrypt.compare(senha, dono.senha))) {
      return autenticarComNovaSessao(req, res, {
        id: dono._id,
        estabelecimentoId: dono._id,
        nome: dono.nome,
        email: dono.email,
        nomeEstabelecimento: dono.nomeEstabelecimento,
        tipo: "proprietario",
        permissoes: [
          "dashboard",
          "relatorios",
          "estoque",
          "catalogo",
          "mesas",
          "funcionarios",
          "configuracoes",
        ],
      }, lembrar);
    }

    const funcionario = await Funcionario.findOne({
      email,
      ativo: true,
    });

    if (
      funcionario &&
      (await bcrypt.compare(senha, funcionario.senha))
    ) {
      return autenticarComNovaSessao(req, res, {
        id: funcionario._id,
        estabelecimentoId: funcionario.estabelecimentoId,
        nome: funcionario.nome,
        email: funcionario.email,
        tipo: "funcionario",
        funcao: funcionario.funcao,
        permissoes: funcionario.permissoes,
      }, lembrar);
    }

    req.flash("errors", "E-mail ou senha inválidos.");
    return req.session.save(() => res.redirect("/login/index"));
  } catch (e) {
    console.error(e);
    return res.status(500).render("404");
  }
};

exports._testing = { autenticarComNovaSessao };

exports.logout = (req, res, next) => {
  const sessionId = req.sessionID;
  markSessionEnding(req, "logout");
  appState.closeSseConnectionsForSession(sessionId);
  req.session.destroy(error => {
    clearSessionCookie(res, process.env.NODE_ENV === "production");
    if (error) return next(error);
    return res.redirect("/");
  });
};
