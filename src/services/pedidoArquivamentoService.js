"use strict";

const mongoose = require("mongoose");
const { Pedido, PrintJob, OrderPaymentAttempt } = require("../models/painelModels");
const { restaurarEstoqueDoPedido } = require("./estoqueService");
const { registrarAuditoria } = require("./auditoriaService");
const {
  ORDER_PIX_EXPIRATION_MS,
  effectiveAttemptExpiration,
} = require("./pedidoPixExpirationService");

const ESTADOS_ESTOQUE_BLOQUEADOS = new Set([
  "preparando",
  "baixando",
  "restaurando",
  "processando",
  "pendente",
  "falhou",
  "reconciliacao_necessaria",
]);
const ESTADOS_IMPRESSAO_BLOQUEADOS = new Set([
  "entregando",
  "recebido",
  "processando",
  "enviado",
  "resultado_desconhecido",
]);
const ESTADOS_IMPRESSAO_CANCELAVEIS = [
  "pendente",
  "aguardando_retry",
  "falhou",
];
const ESTADOS_PIX_ARQUIVAMENTO_BLOQUEADOS = [
  "creating",
  "pending",
  "in_process",
  "authorized",
  "expiration_pending",
];

function tentativaPixExigeBloqueio(tentativa, agora = new Date()) {
  if (!tentativa) return false;
  const status = String(tentativa.status || "").trim().toLowerCase();
  const reconciliacao = String(tentativa.reconciliationStatus || "").trim().toLowerCase();
  const expiraEm = effectiveAttemptExpiration(tentativa);
  const tentativaAtivaNoPrazo = status === "expiration_pending"
    || (ESTADOS_PIX_ARQUIVAMENTO_BLOQUEADOS.includes(status)
      && (!expiraEm || expiraEm.getTime() > agora.getTime()));
  return tentativaAtivaNoPrazo
    || reconciliacao === "reconciliation_required"
    || (status === "approved" && reconciliacao !== "processed");
}

async function buscarTentativaPixBloqueadora({ pedido, session, agora = new Date() }) {
  const recenteDepoisDe = new Date(agora.getTime() - ORDER_PIX_EXPIRATION_MS);
  return OrderPaymentAttempt.findOne(
    {
      estabelecimentoId: pedido.estabelecimentoId,
      pedidoId: pedido._id,
      paymentMethod: "pix",
      $or: [
        {
          status: { $in: ["creating", "pending", "in_process", "authorized"] },
          expiresAt: { $gt: agora },
          createdAt: { $gt: recenteDepoisDe },
        },
        { status: "expiration_pending" },
        { reconciliationStatus: { $in: ["expiration_pending", "reconciliation_required"] } },
        { status: "approved", reconciliationStatus: { $ne: "processed" } },
      ],
    },
    null,
    { session },
  );
}

function erroTentativaPixAtiva(tentativa) {
  const status = String(tentativa?.status || "").trim().toLowerCase();
  const reconciliacao = String(tentativa?.reconciliationStatus || "").trim().toLowerCase();
  if (status === "expiration_pending" || reconciliacao === "expiration_pending") {
    return erroArquivamento(
      "PIX_EXPIRACAO_PENDENTE",
      "O prazo do Pix terminou, mas o cancelamento ainda está sendo confirmado no Mercado Pago. Aguarde a confirmação antes de arquivar.",
    );
  }
  if (status === "approved" || reconciliacao === "reconciliation_required") {
    return erroArquivamento(
      "PIX_RECONCILIACAO_NECESSARIA",
      "Este pedido possui um Pix aprovado ou pendente de conciliação. Conclua a conciliação financeira antes de arquivar.",
    );
  }
  return erroArquivamento(
    "PIX_EM_PROCESSAMENTO",
    "Este pedido possui um pagamento Pix em andamento. Aguarde a confirmação, rejeição ou cancelamento antes de arquivar.",
  );
}

function erroArquivamento(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function transacaoIndisponivel(error) {
  return /Transaction numbers|replica set|transactions are not supported|does not support transactions/i
    .test(String(error?.message || ""));
}

function validarPedidoParaArquivamento(pedido, usuario, agora = new Date()) {
  if (ESTADOS_ESTOQUE_BLOQUEADOS.has(String(pedido.estoqueProcessamento))) {
    throw erroArquivamento(
      "ESTOQUE_EM_PROCESSAMENTO",
      "O estoque deste pedido precisa ser concluído ou conciliado antes do arquivamento.",
    );
  }
  if (
    pedido.estoqueLockId
    && (
      !pedido.estoqueLockExpiraEm
      || new Date(pedido.estoqueLockExpiraEm).getTime() > agora.getTime()
    )
  ) {
    throw erroArquivamento(
      "ESTOQUE_EM_PROCESSAMENTO",
      "O estoque deste pedido está sendo processado. Aguarde antes de arquivar.",
    );
  }
  const estadosConsumo = (pedido.estoqueConsumos || [])
    .map(item => String(item.estado || ""));
  if (
    pedido.estoqueSnapshotCriado === true
    && (
      estadosConsumo.includes("pendente")
      || estadosConsumo.includes("falhou")
      || (pedido.estoqueBaixado !== true && estadosConsumo.includes("baixado"))
    )
  ) {
    throw erroArquivamento(
      "RECONCILIACAO_NECESSARIA",
      "O estoque deste pedido precisa ser conciliado antes do arquivamento.",
    );
  }

  const possuiHistorico = (pedido.historicoFinanceiro || []).length > 0;
  const pixExpiradoSemAprovacao = pedido.pagamentoStatus === "expirado"
    && String(pedido.mercadoPagoStatus || "").toLowerCase() !== "approved"
    && pedido.pagamentoInconsistente !== true;
  const possuiPagamento = pedido.pagamentoStatus === "pago"
    || (Boolean(pedido.mercadoPagoPaymentId) && !pixExpiradoSemAprovacao);
  if (
    possuiPagamento
    && pedido.status !== "cancelado"
    && pedido.pagamentoStatus !== "cancelado"
    && pedido.pagamentoStatus !== "expirado"
  ) {
    throw erroArquivamento(
      "PAGAMENTO_ATIVO",
      "Cancele ou reembolse o pagamento antes de arquivar o pedido.",
    );
  }
  if (usuario.tipo !== "proprietario"
    && (possuiPagamento || possuiHistorico)
    && !pixExpiradoSemAprovacao) {
    throw erroArquivamento(
      "ARQUIVAMENTO_EXCLUSIVO_PROPRIETARIO",
      "Somente o proprietário pode arquivar pedidos com histórico financeiro.",
    );
  }
}

function impressaoEmProcessamento(
  jobs,
  agora = new Date(),
  { agenteConectado = true } = {},
) {
  if (!agenteConectado) return false;

  return jobs.some(job => {
    const status = String(job.status || "");
    const possuiLease = Boolean(job.leaseToken || job.lockedBy);
    const leaseAtivo = Boolean(job.leaseExpiresAt)
      && new Date(job.leaseExpiresAt).getTime() > agora.getTime();

    // Somente bloqueia quando existe agente online e um trabalho realmente
    // em execução com lease ativo. Jobs antigos, desconectados ou presos
    // podem ser cancelados com segurança durante o arquivamento.
    if (ESTADOS_IMPRESSAO_BLOQUEADOS.has(status)) {
      return possuiLease && leaseAtivo;
    }

    return possuiLease && leaseAtivo;
  });
}

async function registrarArquivamento({ pedido, usuario, session }) {
  return registrarAuditoria({
    estabelecimentoId: pedido.estabelecimentoId,
    entidade: "pedido",
    entidadeId: pedido._id,
    acao: "pedido_arquivado",
    usuarioId: pedido.excluidoPor || usuario.id,
    usuarioTipo: pedido.excluidoPorTipo || usuario.tipo,
    dadosResumidos: {
      codigoPedido: String(pedido.codigoPublico || pedido._id).slice(pedido.codigoPublico ? 0 : -6).toUpperCase(),
      statusAnterior: pedido.status,
      statusNovo: "arquivado",
      pagamentoStatus: pedido.pagamentoStatus,
      motivo: pedido.motivoExclusao,
      estoqueRestaurado: pedido.estoqueRestaurado,
    },
    operationKey: pedido.exclusaoOperationKey || `pedido_arquivado:${pedido._id}`,
    session,
  });
}

async function registrarBloqueio({ pedido, usuario, error, session }) {
  return registrarAuditoria({
    estabelecimentoId: pedido.estabelecimentoId,
    entidade: "pedido",
    entidadeId: pedido._id,
    acao: "tentativa_arquivamento_bloqueada",
    usuarioId: usuario.id,
    usuarioTipo: usuario.tipo,
    dadosResumidos: {
      codigoPedido: String(pedido.codigoPublico || pedido._id).slice(pedido.codigoPublico ? 0 : -6).toUpperCase(),
      pagamentoStatus: pedido.pagamentoStatus,
      erroCodigo: error.code,
      motivo: error.message,
    },
    operationKey: `pedido_arquivamento_bloqueado:${pedido._id}:${error.code}`,
    session,
  });
}

async function arquivarPedido({
  pedidoId,
  estabelecimentoId,
  usuario,
  motivo,
  restaurar = restaurarEstoqueDoPedido,
  agenteConectado = true,
}) {
  const motivoValidado = String(motivo || "").trim().slice(0, 500);
  if (motivoValidado.length < 3) {
    throw erroArquivamento(
      "MOTIVO_OBRIGATORIO",
      "Informe o motivo do arquivamento.",
      400,
    );
  }

  let resultado;
  let bloqueio;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      resultado = null;
      bloqueio = null;
      let pedido = await Pedido.findOne(
        {
          _id: pedidoId,
          estabelecimentoId,
          excluido: { $ne: true },
        },
        null,
        { session },
      );
      if (!pedido) {
        const arquivado = await Pedido.findOne(
          { _id: pedidoId, estabelecimentoId, excluido: true },
          null,
          { session },
        );
        if (!arquivado) {
          throw erroArquivamento(
            "PEDIDO_NAO_ENCONTRADO",
            "Pedido não encontrado.",
            404,
          );
        }
        await registrarArquivamento({ pedido: arquivado, usuario, session });
        resultado = { success: true, status: "ja_excluido", pedido: arquivado };
        return;
      }

      try {
        validarPedidoParaArquivamento(pedido, usuario);
      } catch (error) {
        if (!error.statusCode || error.statusCode >= 500) throw error;
        await registrarBloqueio({ pedido, usuario, error, session });
        bloqueio = error;
        return;
      }

      const tentativaPix = await buscarTentativaPixBloqueadora({ pedido, session });
      if (tentativaPixExigeBloqueio(tentativaPix)) {
        const error = erroTentativaPixAtiva(tentativaPix);
        await registrarBloqueio({ pedido, usuario, error, session });
        bloqueio = error;
        return;
      }

      const jobs = await PrintJob.find(
        { estabelecimentoId, pedidoId: pedido._id },
        null,
        { session },
      );
      if (impressaoEmProcessamento(jobs, new Date(), { agenteConectado })) {
        const error = erroArquivamento(
          "IMPRESSAO_EM_PROCESSAMENTO",
          "Este pedido possui uma impressão em processamento.",
        );
        await registrarBloqueio({ pedido, usuario, error, session });
        bloqueio = error;
        return;
      }

      if (pedido.estoqueBaixado === true && pedido.estoqueRestaurado !== true) {
        const restauracao = await restaurar(pedido._id, { session });
        if (
          !restauracao?.success
          || !["restaurado", "ja_restaurado"].includes(restauracao.status)
        ) {
          throw erroArquivamento(
            restauracao?.status === "reconciliacao_necessaria"
              ? "RECONCILIACAO_NECESSARIA"
              : "RESTAURACAO_ESTOQUE_FALHOU",
            restauracao?.message
              || "Não foi possível restaurar completamente o estoque.",
          );
        }
        pedido = await Pedido.findOne(
          {
            _id: pedidoId,
            estabelecimentoId,
            excluido: { $ne: true },
          },
          null,
          { session },
        );
        if (!pedido || pedido.estoqueRestaurado !== true) {
          throw erroArquivamento(
            "RESTAURACAO_ESTOQUE_FALHOU",
            "Não foi possível confirmar a restauração do estoque.",
          );
        }
        try {
          validarPedidoParaArquivamento(pedido, usuario);
        } catch (error) {
          if (!error.statusCode || error.statusCode >= 500) throw error;
          await registrarBloqueio({ pedido, usuario, error, session });
          bloqueio = error;
          return;
        }

        const tentativaPixAposRestauracao = await buscarTentativaPixBloqueadora({ pedido, session });
        if (tentativaPixExigeBloqueio(tentativaPixAposRestauracao)) {
          const error = erroTentativaPixAtiva(tentativaPixAposRestauracao);
          await registrarBloqueio({ pedido, usuario, error, session });
          bloqueio = error;
          return;
        }
      }

      const estadosCancelaveis = agenteConectado
        ? ESTADOS_IMPRESSAO_CANCELAVEIS
        : [
            ...ESTADOS_IMPRESSAO_CANCELAVEIS,
            ...ESTADOS_IMPRESSAO_BLOQUEADOS,
          ];
      const cancelaveis = jobs.filter(job =>
        estadosCancelaveis.includes(String(job.status)));
      if (cancelaveis.length) {
        const filtroCancelamento = {
          estabelecimentoId,
          pedidoId: pedido._id,
          _id: { $in: cancelaveis.map(job => job._id) },
          status: { $in: estadosCancelaveis },
        };
        if (agenteConectado) {
          filtroCancelamento.$or = [
            { leaseToken: { $in: ["", null] } },
            { leaseExpiresAt: { $lte: new Date() } },
          ];
        }
        const cancelamento = await PrintJob.updateMany(
          filtroCancelamento,
          {
            $set: {
              status: "cancelado",
              erro: "Pedido arquivado; impressão cancelada.",
              lockedBy: "",
              leaseToken: "",
              leaseExpiresAt: null,
            },
          },
          { session },
        );
        if (cancelamento.modifiedCount !== cancelaveis.length) {
          throw erroArquivamento(
            "IMPRESSAO_EM_PROCESSAMENTO",
            "Este pedido possui uma impressão em processamento.",
          );
        }
      }

      const operationKey = `pedido_arquivado:${pedido._id}`;
      const atualizado = await Pedido.findOneAndUpdate(
        {
          _id: pedido._id,
          estabelecimentoId,
          excluido: { $ne: true },
        },
        {
          $set: {
            excluido: true,
            excluidoEm: new Date(),
            excluidoPor: usuario.id,
            excluidoPorTipo: usuario.tipo,
            motivoExclusao: motivoValidado,
            exclusaoOperationKey: operationKey,
          },
        },
        {
          session,
          returnDocument: "after",
          runValidators: true,
        },
      );
      if (!atualizado) {
        throw erroArquivamento(
          "ARQUIVAMENTO_CONCORRENTE",
          "Não foi possível concluir o arquivamento.",
        );
      }
      await registrarArquivamento({ pedido: atualizado, usuario, session });
      resultado = { success: true, status: "arquivado", pedido: atualizado };
    });
  } catch (error) {
    if (transacaoIndisponivel(error)) {
      throw erroArquivamento(
        "TRANSACAO_INDISPONIVEL",
        "O arquivamento seguro não está disponível neste ambiente.",
        503,
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
  if (bloqueio) throw bloqueio;
  if (!resultado) {
    throw erroArquivamento(
      "ARQUIVAMENTO_NAO_CONCLUIDO",
      "Não foi possível concluir o arquivamento.",
    );
  }
  return resultado;
}

module.exports = {
  ESTADOS_ESTOQUE_BLOQUEADOS,
  ESTADOS_IMPRESSAO_BLOQUEADOS,
  ESTADOS_IMPRESSAO_CANCELAVEIS,
  ESTADOS_PIX_ARQUIVAMENTO_BLOQUEADOS,
  arquivarPedido,
  buscarTentativaPixBloqueadora,
  erroArquivamento,
  impressaoEmProcessamento,
  registrarBloqueio,
  transacaoIndisponivel,
  tentativaPixExigeBloqueio,
  validarPedidoParaArquivamento,
};
