"use strict";

const { Assinatura } = require("../models/painelModels");

const MENSAGEM_LOJA_INDISPONIVEL =
  "Esta loja está temporariamente indisponível para novos pedidos.";

function dataValida(valor) {
  if (!valor) return null;
  const data = new Date(valor);
  return Number.isFinite(data.getTime()) ? data : null;
}

function bloqueioDoEstabelecimento(estabelecimento) {
  return Boolean(
    estabelecimento?.ativo === false
    || estabelecimento?.bloqueado === true
    || estabelecimento?.vendasBloqueadas === true,
  );
}

function avaliarAcessoVenda({
  estabelecimento = null,
  assinatura = null,
  agora = new Date(),
} = {}) {
  const instanteAtual = dataValida(agora) || new Date();
  if (bloqueioDoEstabelecimento(estabelecimento)) {
    return {
      permitido: false,
      status: "bloqueada",
      motivo: "estabelecimento_bloqueado",
      expiraEm: null,
    };
  }
  if (!assinatura) {
    return {
      permitido: false,
      status: "ausente",
      motivo: "assinatura_ausente",
      expiraEm: null,
    };
  }

  const statusOriginal = String(assinatura.status || "").toLowerCase();
  const fimTeste = dataValida(assinatura.fimTeste);
  const planoExpira = dataValida(
    assinatura.planoExpira || assinatura.expiraEm,
  );
  const statusBloqueados = new Set([
    "cancelada",
    "suspensa",
    "bloqueada",
    "reembolsada",
  ]);

  if (statusBloqueados.has(statusOriginal)) {
    return {
      permitido: false,
      status: statusOriginal === "reembolsada" ? "cancelada" : statusOriginal,
      motivo: `assinatura_${statusOriginal}`,
      expiraEm: planoExpira || fimTeste,
    };
  }

  const testeEmStatusPermitido = ["teste", "pendente"].includes(statusOriginal);
  if (
    testeEmStatusPermitido
    && fimTeste
    && fimTeste.getTime() > instanteAtual.getTime()
  ) {
    return {
      permitido: true,
      status: "teste",
      motivo: "periodo_gratuito_valido",
      expiraEm: fimTeste,
    };
  }

  if (
    statusOriginal === "ativa"
    && assinatura.ultimoPagamentoAprovadoId
    && planoExpira
    && planoExpira.getTime() > instanteAtual.getTime()
  ) {
    return {
      permitido: true,
      status: "ativa",
      motivo: "assinatura_ativa",
      expiraEm: planoExpira,
    };
  }

  return {
    permitido: false,
    status: "vencida",
    motivo: statusOriginal === "pendente"
      ? "pagamento_pendente_sem_periodo_valido"
      : "validade_expirada",
    expiraEm: statusOriginal === "ativa" ? planoExpira : fimTeste,
  };
}

async function consultarAcessoVenda({
  estabelecimentoId,
  estabelecimento = null,
  agora = new Date(),
} = {}) {
  if (!estabelecimentoId) {
    return avaliarAcessoVenda({ estabelecimento, assinatura: null, agora });
  }
  const assinatura = await Assinatura.findOne({
    estabelecimentoId,
  }).lean();
  return avaliarAcessoVenda({ estabelecimento, assinatura, agora });
}

function respostaLojaIndisponivel(res) {
  return res.status(403).json({
    success: false,
    code: "LOJA_INDISPONIVEL",
    message: MENSAGEM_LOJA_INDISPONIVEL,
  });
}

module.exports = {
  MENSAGEM_LOJA_INDISPONIVEL,
  avaliarAcessoVenda,
  consultarAcessoVenda,
  respostaLojaIndisponivel,
};
