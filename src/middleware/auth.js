exports.loginRequired = (req, res, next) => {
  if (!req.session.user) {
    req.flash("errors", "Faça login para acessar o painel.");
    return req.session.save(() => res.redirect("/login/index"));
  }
  next();
};

exports.permissao = (modulo) => (req, res, next) => {
  const user = req.session.user;
  if (!user) return res.redirect("/login/index");
  if (user.tipo === "proprietario" || user.permissoes?.includes(modulo))
    return next();
  return res
    .status(403)
    .send("Você não tem permissão para acessar este módulo.");
};

exports.permissaoCategoria = async (req, res, next) => {
  try {
    const user = req.session.user;

    if (!user) {
      return res.redirect("/login/index");
    }

    let tipo = String(req.body.tipo || "").trim();

    if (req.params.id) {
      const { Categoria } = require("../models/painelModels");
      const idEstabelecimento =
        user.estabelecimentoId || user.id;

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
      user.tipo === "proprietario" ||
      user.permissoes?.includes(modulo)
    ) {
      return next();
    }

    return res
      .status(403)
      .send("Você não tem permissão para acessar este módulo.");
  } catch (error) {
    return next(error);
  }
};
