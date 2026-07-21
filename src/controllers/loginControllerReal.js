const bcrypt = require("bcryptjs");
const validator = require("validator");
const { registroModel } = require("../models/registroModel");
const { Funcionario } = require("../models/painelModels");

exports.login = async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .toLowerCase()
      .trim();
    const senha = String(req.body.senha || "");
    if (!validator.isEmail(email) || !senha) {
      req.flash("errors", "E-mail ou senha inválidos.");
      return req.session.save(() => res.redirect("/login/index"));
    }
    const dono = await registroModel.findOne({ email });
    if (dono && (await bcrypt.compare(senha, dono.senha))) {
      req.session.user = {
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
      };
      return req.session.save(() => res.redirect("/admin"));
    }
    const funcionario = await Funcionario.findOne({ email, ativo: true });
    if (funcionario && (await bcrypt.compare(senha, funcionario.senha))) {
      req.session.user = {
        id: funcionario._id,
        estabelecimentoId: funcionario.estabelecimentoId,
        nome: funcionario.nome,
        email: funcionario.email,
        tipo: "funcionario",
        funcao: funcionario.funcao,
        permissoes: funcionario.permissoes,
      };
      return req.session.save(() => res.redirect("/admin"));
    }
    req.flash("errors", "E-mail ou senha inválidos.");
    return req.session.save(() => res.redirect("/login/index"));
  } catch (e) {
    console.error(e);
    res.status(500).render("404");
  }
};

exports.logout = (req, res) => req.session.destroy(() => res.redirect("/"));
