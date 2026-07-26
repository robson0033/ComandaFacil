const { Assinatura, Configuracao } = require("../models/painelModels");
const {
  avaliarAcessoVenda,
} = require("../services/assinaturaAcessoService");

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

    const estabelecimento = await Configuracao.findOne({
      estabelecimentoId: id(req),
    })
      .select("ativo bloqueado vendasBloqueadas")
      .lean();
    const agora = new Date();
    const testeDentroDaData = testeValido(assinatura, agora);
    const planoDentroDaData = planoPagoValido(assinatura, agora);
    const planoComprovado = Boolean(
      assinatura.ultimoPagamentoAprovadoId &&
      assinatura.planoExpira
    );

    if (assinatura.status === "ativa" && !planoComprovado) {
      assinatura.status = testeDentroDaData ? "teste" : "pendente";
    }

    // Uma tentativa de pagamento pendente nunca encerra o teste gratuito.
    if (
      !testeDentroDaData
      && !planoDentroDaData
      && assinatura.status === "teste"
    ) {
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
    const avaliacao = avaliarAcessoVenda({
      estabelecimento,
      assinatura,
      agora,
    });
    const emTeste = avaliacao.permitido && avaliacao.status === "teste";
    const planoAtivo = avaliacao.permitido && avaliacao.status === "ativa";

    req.assinatura = assinatura;
    req.assinaturaAvaliacao = avaliacao;
    req.assinaturaAcessoLiberado = avaliacao.permitido;
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

  const usuario = req.usuarioAtual || req.session?.user || {};
  const aceita = String(req.get?.("accept") || "");
  const conteudo = String(req.get?.("content-type") || "");
  const caminho = String(req.path || req.originalUrl || "").split("?")[0];
  const requisicaoDeApi = Boolean(
    req.xhr
    || caminho.includes("/api/")
    || aceita.includes("application/json")
    || aceita.includes("text/event-stream")
    || conteudo.includes("application/json"),
  );

  if (requisicaoDeApi) {
    return res.status(403).json({
      success: false,
      code: "ASSINATURA_NECESSARIA",
      message: "Regularize a assinatura para acessar esta funcionalidade.",
    });
  }

  if (usuario.tipo === "funcionario") {
    return res.status(403).send(
      "O acesso operacional desta loja está temporariamente indisponível.",
    );
  }

  req.flash(
    "errors",
    "Sua assinatura precisa ser regularizada para liberar novas operações.",
  );
  return req.session.save(() => res.redirect("/assinatura"));
};

exports.testeValido = testeValido;
exports.planoPagoValido = planoPagoValido;
