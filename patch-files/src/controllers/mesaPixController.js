"use strict";

const { logger: appLogger } = require("../utils/logger");
const mesaPix = require("../services/mesaPixPaymentService");

function estabelecimentoId(req) {
  return req.session.user.estabelecimentoId || req.session.user.id;
}

function jsonError(res, error, fallback) {
  const status = Number(error?.httpStatus || error?.statusCode || 500);
  if (status >= 500) appLogger.error(error);
  return res.status(status).json({
    success: false,
    code: String(error?.code || "MESA_PIX_ERROR"),
    message: String(error?.message || fallback || "Não foi possível processar o Pix da mesa."),
    ...(error?.pixActive ? { pixActive: true } : {}),
    ...(error?.reconciliationRequired ? { reconciliationRequired: true } : {}),
  });
}

exports.gerar = async (req, res) => {
  try {
    const attempt = await mesaPix.gerarPixMesa({
      req,
      estabelecimentoId: estabelecimentoId(req),
      mesaId: req.params.id,
      usuarioId: req.session.user.id,
      paymentBody: req.body || {},
    });
    const data = await mesaPix.consultarTentativa({
      estabelecimentoId: estabelecimentoId(req),
      mesaId: req.params.id,
      consultarRemoto: false,
    });
    return res.json({ success: true, ...mesaPix.publicStatus(data), attemptId: String(attempt.attemptId) });
  } catch (error) {
    return jsonError(res, error, "Não foi possível gerar o Pix da mesa.");
  }
};

exports.status = async (req, res) => {
  try {
    const data = await mesaPix.consultarTentativa({
      estabelecimentoId: estabelecimentoId(req),
      mesaId: req.params.id,
      consultarRemoto: true,
    });
    if (!data) return res.status(404).json({ success: false, code: "MESA_PIX_NOT_FOUND", message: "Não existe Pix para esta mesa." });
    return res.json({ success: true, ...mesaPix.publicStatus(data) });
  } catch (error) {
    return jsonError(res, error, "Não foi possível consultar o Pix da mesa.");
  }
};

exports.cancelar = async (req, res) => {
  try {
    const result = await mesaPix.cancelarPixMesa({
      estabelecimentoId: estabelecimentoId(req),
      mesaId: req.params.id,
      usuarioId: req.session.user.id,
      motivo: "manual",
    });
    if (result.approved) {
      return res.status(409).json({
        success: false,
        code: "MESA_PIX_ALREADY_APPROVED",
        approved: true,
        mesaLiberada: Boolean(result.mesaLiberada),
        message: "O Pix foi aprovado antes do cancelamento. A mesa foi processada como paga.",
      });
    }
    if (result.reconciliationRequired) {
      return res.status(409).json({
        success: false,
        code: "MESA_PIX_CANCELLATION_RECONCILIATION",
        reconciliationRequired: true,
        message: "Ainda não foi possível confirmar o cancelamento no Mercado Pago. Não escolha outra forma de pagamento até a conciliação terminar.",
      });
    }
    return res.json({
      success: true,
      cancelled: true,
      message: "Pix cancelado. Agora você pode escolher outra forma de pagamento.",
    });
  } catch (error) {
    return jsonError(res, error, "Não foi possível cancelar o Pix da mesa.");
  }
};
