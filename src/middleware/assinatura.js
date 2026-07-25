const { Assinatura } = require("../models/painelModels");

const id = (req) =>
  req.session.user.estabelecimentoId || req.session.user.id;

function testeValido(assinatura, agora = new Date()) {
  return Boolean(
    assinatura?.fimTeste &&
    new Date(assinatura.fimTeste).getTime() > agora.getTime()
  );
}

function planoPagoValido(assinatura, agora = new Date()) {
  if (assinatura?.status !== "ativa") return false;
  if (!assinatura.ultimoPagamentoAprovadoId || !assinatura.planoExpira) {
    return false;
  }
  return new Date(assinatura.planoExpira).getTime() > agora.getTime();
}

exports.carregarAssinatura = async (req, res, next) => {
  try {
    if (!req.session.user) return next();

    let assinatura = await Assinatura.findOne({ estabelecimentoId: id(req) });
    if (!assinatura) {
      const inicio = new Date();
      assinatura = await Assinatura.create({
        estabelecimentoId: id(req),
        status: "teste",
        metodo: "teste",
        inicioTeste: inicio,
        fimTeste: new Date(inicio.getTime() + 7 * 24 * 60 * 60 * 1000),
      });
    }

    const agora = new Date();
    const emTeste = testeValido(assinatura, agora);
    const planoAtivo = planoPagoValido(assinatura, agora);
    const planoComprovado = Boolean(
      assinatura.ultimoPagamentoAprovadoId &&
      assinatura.planoExpira
    );

    if (assinatura.status === "ativa" && !planoComprovado) {
      assinatura.status = emTeste ? "teste" : "pendente";
    }

    // Uma tentativa de pagamento pendente nunca encerra o teste gratuito.
    if (!emTeste && !planoAtivo && assinatura.status === "teste") {
      assinatura.status = "expirada";
    }

    if (
      assinatura.status === "ativa" &&
      assinatura.planoExpira &&
      new Date(assinatura.planoExpira) <= agora
    ) {
      assinatura.status = "expirada";
    }

    if (assinatura.isModified()) await assinatura.save();

    req.assinatura = assinatura;
    req.assinaturaAcessoLiberado = emTeste || planoAtivo;
    res.locals.assinatura = assinatura.toObject();
    res.locals.testeValido = emTeste;
    res.locals.planoAtivo = planoAtivo;
    res.locals.diasRestantes = emTeste
      ? Math.max(0, Math.ceil((new Date(assinatura.fimTeste) - agora) / 86400000))
      : 0;

    return next();
  } catch (e) {
    return next(e);
  }
};

exports.assinaturaRequired = (req, res, next) => {
  if (req.assinaturaAcessoLiberado) return next();

  req.flash(
    "errors",
    "Seu período gratuito terminou. Escolha uma forma de pagamento para continuar.",
  );
  return req.session.save(() => res.redirect("/assinatura"));
};

exports.testeValido = testeValido;
exports.planoPagoValido = planoPagoValido;
