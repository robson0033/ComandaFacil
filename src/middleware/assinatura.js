const { Assinatura } = require("../models/painelModels");

const id = (req) => req.session.user.estabelecimentoId || req.session.user.id;

exports.carregarAssinatura = async (req, res, next) => {
  try {
    if (!req.session.user) return next();
    let assinatura = await Assinatura.findOne({ estabelecimentoId: id(req) });
    if (!assinatura) {
      const inicio = new Date();
      assinatura = await Assinatura.create({
        estabelecimentoId: id(req),
        inicioTeste: inicio,
        fimTeste: new Date(inicio.getTime() + 7 * 24 * 60 * 60 * 1000),
      });
    }
    const agora = new Date();
    if (assinatura.status === "teste" && assinatura.fimTeste <= agora)
      assinatura.status = "expirada";
    if (
      assinatura.status === "ativa" &&
      assinatura.metodo === "pix" &&
      assinatura.planoExpira &&
      assinatura.planoExpira <= agora
    )
      assinatura.status = "expirada";
    if (assinatura.isModified()) await assinatura.save();
    req.assinatura = assinatura;
    res.locals.assinatura = assinatura.toObject();
    res.locals.diasRestantes =
      assinatura.status === "teste"
        ? Math.max(0, Math.ceil((assinatura.fimTeste - agora) / 86400000))
        : 0;
    next();
  } catch (e) {
    next(e);
  }
};

exports.assinaturaRequired = (req, res, next) => {
  const a = req.assinatura;
  if (!a) return res.redirect("/assinatura");
  const liberado = a.status === "teste" || a.status === "ativa";
  if (liberado) return next();
  req.flash(
    "errors",
    "Seu período gratuito terminou. Escolha uma forma de pagamento para continuar.",
  );
  return req.session.save(() => res.redirect("/assinatura"));
};
