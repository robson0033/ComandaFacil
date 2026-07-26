"use strict";

const { AuditoriaEvento } = require("../models/painelModels");

const CAMPOS_RESUMO_PERMITIDOS = new Set([
  "codigoPedido",
  "statusAnterior",
  "statusNovo",
  "pagamentoStatus",
  "formaPagamento",
  "motivo",
  "resultado",
  "erroCodigo",
  "estoqueRestaurado",
]);

function resumirDados(value = {}) {
  const resumo = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (!CAMPOS_RESUMO_PERMITIDOS.has(key)) continue;
    if (typeof item === "boolean" || typeof item === "number") {
      resumo[key] = item;
    } else if (item != null) {
      resumo[key] = String(item).slice(0, 500);
    }
  }
  return resumo;
}

async function registrarAuditoria({
  estabelecimentoId,
  entidade,
  entidadeId,
  acao,
  usuarioId = null,
  usuarioTipo = "sistema",
  dadosResumidos = {},
  operationKey = "",
  session = null,
}) {
  const documento = {
    estabelecimentoId,
    entidade: String(entidade).slice(0, 80),
    entidadeId,
    acao: String(acao).slice(0, 100),
    usuarioId,
    usuarioTipo: ["proprietario", "funcionario"].includes(usuarioTipo)
      ? usuarioTipo
      : "sistema",
    dadosResumidos: resumirDados(dadosResumidos),
    registradoEm: new Date(),
  };
  const operationKeyNormalizada = String(operationKey || "").trim().slice(0, 200);
  if (!operationKeyNormalizada) {
    if (!session) return AuditoriaEvento.create(documento);
    const [evento] = await AuditoriaEvento.create([documento], { session });
    return evento;
  }
  documento.operationKey = operationKeyNormalizada;
  try {
    return await AuditoriaEvento.findOneAndUpdate(
      { operationKey: documento.operationKey },
      { $setOnInsert: documento },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
        runValidators: true,
        ...(session ? { session } : {}),
      },
    );
  } catch (error) {
    const duplicidadeOperationKey = error?.code === 11000
      && (
        error?.keyPattern?.operationKey === 1
        || Object.prototype.hasOwnProperty.call(error?.keyValue || {}, "operationKey")
        || String(error?.message || "").includes("auditoria_operation_key_unico")
      );
    if (!duplicidadeOperationKey) throw error;
    const existente = await AuditoriaEvento.findOne(
      { operationKey: documento.operationKey },
      null,
      session ? { session } : {},
    );
    if (!existente) throw error;
    return existente;
  }
}

module.exports = {
  registrarAuditoria,
  resumirDados,
};
