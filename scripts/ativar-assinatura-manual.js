"use strict";

require("dotenv").config();

const crypto = require("crypto");
const mongoose = require("mongoose");
const { registroModel } = require("../src/models/registroModel");
const { PLAN_CODES } = require("../src/config/plans");
const {
  Assinatura,
  AssinaturaTentativa,
  Configuracao,
} = require("../src/models/painelModels");

function argValue(prefix, fallback = "") {
  const item = process.argv.find(arg => arg.startsWith(`${prefix}=`));
  return item ? item.slice(prefix.length + 1) : fallback;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fail(message) {
  console.error(`\nFALHA: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const days = Number(argValue("--dias", "30"));
  const planCode = String(argValue("--plano", PLAN_CODES.PROFISSIONAL)).trim().toLowerCase();
  const reason = String(argValue("--motivo", "ativacao_manual_admin")).trim().slice(0, 120);

  if (!email || !email.includes("@")) {
    throw new Error(
      "Informe o e-mail. Ex.: node scripts/ativar-assinatura-manual.js cliente@email.com --dias=30"
    );
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--dias deve ser um número inteiro entre 1 e 365.");
  }
  if (![PLAN_CODES.PROFISSIONAL, PLAN_CODES.GESTAO_COMPLETA].includes(planCode)) {
    throw new Error("--plano deve ser profissional ou gestao_completa.");
  }
  if (!process.env.CONNECTIONSTRING) {
    throw new Error("CONNECTIONSTRING não está configurada no ambiente.");
  }

  await mongoose.connect(process.env.CONNECTIONSTRING, { autoIndex: false });

  const user = await registroModel.findOne({ email });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  let subscription = await Assinatura.findOne({ estabelecimentoId: user._id });
  const config = await Configuracao.findOne({ estabelecimentoId: user._id })
    .select("ativo bloqueado vendasBloqueadas")
    .lean();

  const now = new Date();
  const expiresAt = addDays(now, days);

  const current = subscription ? {
    status: subscription.status,
    metodo: subscription.metodo,
    planoCodigo: subscription.planoCodigo || PLAN_CODES.PROFISSIONAL,
    planoInicio: iso(subscription.planoInicio),
    planoExpira: iso(subscription.planoExpira),
    ultimoPagamentoAprovadoId: subscription.ultimoPagamentoAprovadoId || "",
    ultimoStatusMercadoPago: subscription.ultimoStatusMercadoPago || "",
    mercadoPagoPreapprovalId: subscription.mercadoPagoPreapprovalId || "",
  } : null;

  const realPaidPlanActive = Boolean(
    subscription
    && subscription.status === "ativa"
    && subscription.planoExpira
    && new Date(subscription.planoExpira) > now
    && subscription.ultimoPagamentoAprovadoId
    && !String(subscription.ultimoPagamentoAprovadoId).startsWith("manual_admin:")
  );

  console.log("\n=== USUÁRIO ===");
  console.log(JSON.stringify({
    email: user.email,
    nome: user.nome,
    estabelecimento: user.nomeEstabelecimento,
    estabelecimentoId: String(user._id),
  }, null, 2));

  console.log("\n=== ESTADO ATUAL ===");
  console.log(JSON.stringify({
    assinatura: current,
    estabelecimento: config || null,
  }, null, 2));

  if (realPaidPlanActive && !force) {
    throw new Error(
      "A conta já possui um plano pago ativo. Para evitar sobreposição, o script não alterou nada. Use --force somente se tiver certeza."
    );
  }

  console.log("\n=== ATIVAÇÃO PROPOSTA ===");
  console.log(JSON.stringify({
    status: "ativa",
    planoCodigo: planCode,
    inicio: now.toISOString(),
    expira: expiresAt.toISOString(),
    dias: days,
    motivo: reason,
    modo: "manual_admin",
  }, null, 2));

  if (!apply) {
    console.log("\nMODO VERIFICAÇÃO: nenhuma alteração foi feita no banco.");
    console.log("Para aplicar, repita o comando acrescentando --apply.");
    return;
  }

  // Revalida imediatamente antes da escrita.
  subscription = await Assinatura.findOne({ estabelecimentoId: user._id });
  const currentNow = new Date();
  const stillHasRealPaidPlan = Boolean(
    subscription
    && subscription.status === "ativa"
    && subscription.planoExpira
    && new Date(subscription.planoExpira) > currentNow
    && subscription.ultimoPagamentoAprovadoId
    && !String(subscription.ultimoPagamentoAprovadoId).startsWith("manual_admin:")
  );
  if (stillHasRealPaidPlan && !force) {
    throw new Error("A assinatura mudou e agora possui plano pago ativo. Operação cancelada.");
  }

  const manualId = `manual_admin:${crypto.randomUUID()}`;

  if (!subscription) {
    subscription = new Assinatura({
      estabelecimentoId: user._id,
      status: "teste",
      metodo: "teste",
      inicioTeste: currentNow,
      fimTeste: currentNow,
    });
  }

  if (!Array.isArray(subscription.historicoFinanceiro)) {
    subscription.historicoFinanceiro = [];
  }

  // Não afirma que o Mercado Pago aprovou um pagamento real. O prefixo
  // manual_admin deixa claro que é uma concessão administrativa interna.
  subscription.status = "ativa";
  subscription.planoCodigo = planCode;
  subscription.planoInicio = currentNow;
  subscription.planoExpira = addDays(currentNow, days);
  subscription.proximaCobranca = null;
  subscription.ultimoPagamentoAprovadoId = manualId;
  subscription.ultimoPagamentoAprovadoEm = currentNow;
  subscription.ultimoEventoFinanceiroEm = currentNow;
  subscription.ultimoEventoFinanceiroKey = manualId;
  subscription.historicoFinanceiro.push({
    paymentId: manualId,
    preapprovalId: "",
    status: `manual_admin:${days}_dias:${reason}`.slice(0, 500),
    aprovadoEm: currentNow,
    registradoEm: currentNow,
  });

  await subscription.save();

  // Qualquer tentativa antiga deixa de ser a tentativa vigente. Isso evita
  // que um PIX velho/rejeitado continue bloqueando uma nova cobrança local.
  const supersedeResult = await AssinaturaTentativa.updateMany(
    {
      estabelecimentoId: user._id,
      ativa: true,
      status: { $in: ["processing", "criando", "pending", "authorized", "reconciliation_required"] },
    },
    {
      $set: {
        ativa: false,
        status: "superseded",
        supersededAt: currentNow,
        completedAt: currentNow,
        erro: "Tentativa encerrada por ativação manual administrativa.",
      },
    },
  );

  const finalSubscription = await Assinatura.findOne({ estabelecimentoId: user._id }).lean();

  console.log("\n=== ATIVAÇÃO APLICADA ===");
  console.log(JSON.stringify({
    email: user.email,
    estabelecimento: user.nomeEstabelecimento,
    status: finalSubscription.status,
    planoCodigo: finalSubscription.planoCodigo || PLAN_CODES.PROFISSIONAL,
    planoInicio: iso(finalSubscription.planoInicio),
    planoExpira: iso(finalSubscription.planoExpira),
    marcadorManual: finalSubscription.ultimoPagamentoAprovadoId,
    tentativasAntigasEncerradas: supersedeResult.modifiedCount || 0,
    aviso: config && (config.ativo === false || config.bloqueado === true || config.vendasBloqueadas === true)
      ? "A assinatura foi ativada, mas o estabelecimento possui bloqueio operacional em Configuracao."
      : null,
  }, null, 2));
}

main()
  .catch(error => fail(error?.message || String(error)))
  .finally(async () => {
    try {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    } catch {}
  });
