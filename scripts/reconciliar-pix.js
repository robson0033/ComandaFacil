"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const mongoose = require("mongoose");
const {
  Configuracao,
  Pedido,
  OrderPaymentAttempt,
} = require("../src/models/painelModels");
const {
  ORDER_PIX_ACTIVE_STATUSES,
  isRemoteTerminalUnpaidStatus,
  markOrderPixExpired,
} = require("../src/services/pedidoPixExpirationService");
const {
  validatePaymentIdentity,
} = require("../src/services/mercadoPagoService");

const MP_API = "https://api.mercadopago.com";
const REQUEST_TIMEOUT_MS = 12_000;

function usage() {
  console.log(`\nUso normal (consulta Mercado Pago):\n  node scripts/reconciliar-pix.js <paymentId> [--pedido=<pedidoId>] [--apply]\n\nModo manual para pagamento visível como CANCELADO no painel do Mercado Pago, mas que retorna 404 pela API atual:\n  node scripts/reconciliar-pix.js <paymentId> --pedido=<pedidoId> --manual-cancelled --confirm=<paymentId> [--apply]\n\nExemplo - somente verificação manual:\n  node scripts/reconciliar-pix.js 171741217770 --pedido=6a6fa7244035c997f805ce7b --manual-cancelled --confirm=171741217770\n\nExemplo - aplicar conciliação manual:\n  node scripts/reconciliar-pix.js 171741217770 --pedido=6a6fa7244035c997f805ce7b --manual-cancelled --confirm=171741217770 --apply\n`);
}

function parseArgs(argv) {
  const paymentId = String(argv[2] || "").trim();
  const apply = argv.includes("--apply");
  const manualCancelled = argv.includes("--manual-cancelled");
  const pedidoArg = argv.find(value => String(value).startsWith("--pedido="));
  const confirmArg = argv.find(value => String(value).startsWith("--confirm="));
  const pedidoId = pedidoArg ? String(pedidoArg).slice("--pedido=".length).trim() : "";
  const confirm = confirmArg ? String(confirmArg).slice("--confirm=".length).trim() : "";

  if (!/^\d{6,30}$/.test(paymentId)) {
    throw new Error("Informe um paymentId numérico válido do Mercado Pago.");
  }
  if (pedidoId && !mongoose.isValidObjectId(pedidoId)) {
    throw new Error("O --pedido informado não é um ObjectId válido.");
  }
  if (manualCancelled && !pedidoId) {
    throw new Error("O modo --manual-cancelled exige --pedido=<pedidoId>.");
  }
  if (manualCancelled && confirm !== paymentId) {
    throw new Error("O modo --manual-cancelled exige --confirm=<paymentId> com o mesmo ID informado.");
  }

  return { paymentId, pedidoId, apply, manualCancelled, confirm };
}

function chaveCriptografia() {
  const segredo = String(process.env.TOKEN_ENCRYPTION_KEY || "");
  if (!segredo) {
    throw new Error("TOKEN_ENCRYPTION_KEY não está configurada no ambiente.");
  }
  return crypto.createHash("sha256").update(segredo).digest();
}

function descriptografar(valor) {
  if (!valor) return "";
  const parts = String(valor).split(".");
  if (parts.length !== 3) throw new Error("Token Mercado Pago armazenado em formato inválido.");
  const [iv, tag, encrypted] = parts.map(value => Buffer.from(value, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", chaveCriptografia(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

async function consultarPagamento(paymentId, accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    if (!response.ok) {
      const providerMessage = String(body?.message || body?.error || `HTTP ${response.status}`)
        .replace(/[\r\n]/g, " ")
        .slice(0, 240);
      const error = new Error(`Mercado Pago recusou a consulta (${response.status}): ${providerMessage}`);
      error.httpStatus = response.status;
      error.providerMessage = providerMessage;
      throw error;
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function printLocalSummary({ attempt, pedido, currentCollectorId = "" }) {
  console.log("\n=== DADOS LOCAIS ===");
  console.log(JSON.stringify({
    paymentId: String(attempt.paymentId || ""),
    pedidoId: String(pedido._id || ""),
    attemptStatus: String(attempt.status || ""),
    reconciliationStatus: String(attempt.reconciliationStatus || ""),
    externalReference: String(attempt.externalReference || ""),
    expectedCollectorId: String(attempt.expectedCollectorId || ""),
    currentConnectedCollectorId: String(currentCollectorId || ""),
    collectorChanged: Boolean(
      currentCollectorId
      && attempt.expectedCollectorId
      && String(currentCollectorId) !== String(attempt.expectedCollectorId)
    ),
    expectedAmount: Number(attempt.expectedAmount || 0),
    currency: String(attempt.currency || ""),
    pedidoPagamentoStatus: String(pedido.pagamentoStatus || ""),
    pedidoMercadoPagoStatus: String(pedido.mercadoPagoStatus || ""),
    pedidoMercadoPagoPaymentId: String(pedido.mercadoPagoPaymentId || ""),
    expiresAt: attempt.expiresAt,
    lastCheckedAt: attempt.lastCheckedAt,
  }, null, 2));
}

async function assertNoNewerActiveAttempt(attempt) {
  const newerAttempt = await OrderPaymentAttempt.findOne({
    estabelecimentoId: attempt.estabelecimentoId,
    pedidoId: attempt.pedidoId,
    _id: { $ne: attempt._id },
    createdAt: { $gt: attempt.createdAt },
    status: { $in: [...ORDER_PIX_ACTIVE_STATUSES, "approved"] },
  }).sort({ createdAt: -1 });

  if (newerAttempt) {
    throw new Error(
      `Existe uma tentativa Pix mais nova (${String(newerAttempt._id)}) com status ${String(newerAttempt.status)}. `
      + "A conciliação foi bloqueada para não expirar uma cobrança substituta.",
    );
  }
}

function assertLocalSafety({ attempt, pedido, args }) {
  if (args.pedidoId && String(attempt.pedidoId) !== args.pedidoId) {
    throw new Error(
      `O paymentId pertence ao pedido ${String(attempt.pedidoId)}, não ao pedido ${args.pedidoId}.`,
    );
  }

  if (String(attempt.paymentMethod || "") !== "pix") {
    throw new Error("A tentativa encontrada não é um pagamento Pix.");
  }

  if (String(attempt.paymentId || "") !== args.paymentId) {
    throw new Error("O paymentId da tentativa não corresponde ao ID informado.");
  }

  if (String(pedido.pagamentoStatus || "") === "pago"
    || String(pedido.mercadoPagoStatus || "").toLowerCase() === "approved"
    || String(attempt.status || "").toLowerCase() === "approved") {
    throw new Error("O pedido/tentativa já consta como pago/aprovado. Nenhuma expiração será aplicada.");
  }

  const pedidoPaymentId = String(pedido.mercadoPagoPaymentId || "").trim();
  if (pedidoPaymentId && pedidoPaymentId !== args.paymentId) {
    throw new Error(
      `O pedido atualmente aponta para outro paymentId (${pedidoPaymentId}). Conciliação bloqueada.`,
    );
  }

  if (args.manualCancelled) {
    const allowed = new Set(["expiration_pending", "pending", "in_process", "authorized", "expired"]);
    if (!allowed.has(String(attempt.status || "").toLowerCase())) {
      throw new Error(
        `Status local da tentativa '${String(attempt.status || "")}' não é elegível para conciliação manual de cancelamento.`,
      );
    }
    const expiresAt = attempt.expiresAt ? new Date(attempt.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > Date.now()) {
      throw new Error("A tentativa ainda não atingiu a data de expiração local. Conciliação manual bloqueada.");
    }
  }
}

async function applyManualCancelled({ attempt, pedido, args }) {
  const now = new Date();

  // Este script também precisa funcionar em ambientes MongoDB que não
  // suportam transações multi-documento. Para não correr o risco de marcar
  // a tentativa como encerrada e deixar o Pedido pendente, atualizamos o
  // Pedido PRIMEIRO e a tentativa DEPOIS. A operação é idempotente: se a
  // segunda gravação falhar, basta executar o mesmo comando novamente.
  const [attemptAtual, pedidoAtual] = await Promise.all([
    OrderPaymentAttempt.findOne({
      _id: attempt._id,
      estabelecimentoId: attempt.estabelecimentoId,
      pedidoId: attempt.pedidoId,
      paymentId: args.paymentId,
    }),
    Pedido.findOne({
      _id: pedido._id,
      estabelecimentoId: attempt.estabelecimentoId,
    }),
  ]);

  if (!attemptAtual || !pedidoAtual) {
    throw new Error("Pedido ou tentativa deixou de existir antes da aplicação.");
  }

  assertLocalSafety({ attempt: attemptAtual, pedido: pedidoAtual, args });

  const newerAttempt = await OrderPaymentAttempt.findOne({
    estabelecimentoId: attemptAtual.estabelecimentoId,
    pedidoId: attemptAtual.pedidoId,
    _id: { $ne: attemptAtual._id },
    createdAt: { $gt: attemptAtual.createdAt },
    status: { $in: [...ORDER_PIX_ACTIVE_STATUSES, "approved"] },
  }).sort({ createdAt: -1 });

  if (newerAttempt) {
    throw new Error(
      `Surgiu uma tentativa Pix mais nova (${String(newerAttempt._id)}) antes da aplicação. Operação cancelada.`,
    );
  }

  const statusAnterior = String(pedidoAtual.pagamentoStatus || "pendente");
  if (!Array.isArray(pedidoAtual.historicoFinanceiro)) pedidoAtual.historicoFinanceiro = [];
  const operationKey = `pix_expirado_manual:${args.paymentId}`;
  const alreadyRecorded = pedidoAtual.historicoFinanceiro.some(item =>
    String(item?.operationKey || "") === operationKey,
  );

  if (!alreadyRecorded) {
    pedidoAtual.historicoFinanceiro.push({
      paymentId: args.paymentId,
      status: "cancelled",
      tipo: "pix_online_expirado_conciliacao_manual",
      statusAnterior,
      statusNovo: "expirado",
      formaPagamento: "pix_online",
      valor: Number(attemptAtual.expectedAmount || 0),
      motivo: "Conciliação manual: transação confirmada como Cancelado no painel do Mercado Pago; a API com a credencial atualmente conectada retornou 404 Payment not found.",
      operationKey,
      registradoEm: now,
    });
  }

  pedidoAtual.pagamentoStatus = "expirado";
  pedidoAtual.mercadoPagoPaymentId = args.paymentId;
  pedidoAtual.mercadoPagoStatus = "cancelled";
  pedidoAtual.pixExpiradoEm = pedidoAtual.pixExpiradoEm || now;
  pedidoAtual.pixExpiracaoStatusRemoto = "cancelled";
  pedidoAtual.pixExpiracaoUltimaTentativaEm = now;
  pedidoAtual.pixExpiracaoErro = "";
  pedidoAtual.pixCopiaCola = "";
  pedidoAtual.pixQrCodeBase64 = "";
  pedidoAtual.mercadoPagoCheckLockedUntil = null;

  // Pedido primeiro: caso a segunda gravação falhe, não perdemos a informação
  // operacional importante. O comando pode ser reexecutado sem duplicar o
  // histórico graças ao operationKey acima.
  await pedidoAtual.save();

  // Recarrega a tentativa depois da gravação do Pedido para reduzir a janela
  // de concorrência e impedir que um estado aprovado seja sobrescrito.
  const attemptDepoisDoPedido = await OrderPaymentAttempt.findOne({
    _id: attemptAtual._id,
    estabelecimentoId: attemptAtual.estabelecimentoId,
    pedidoId: attemptAtual.pedidoId,
    paymentId: args.paymentId,
  });

  if (!attemptDepoisDoPedido) {
    throw new Error(
      "O Pedido foi conciliado, mas a tentativa deixou de existir antes da segunda gravação. Verifique o banco antes de repetir.",
    );
  }

  if (String(attemptDepoisDoPedido.status || "").toLowerCase() === "approved") {
    throw new Error(
      "O Pedido foi conciliado, mas a tentativa mudou para approved antes da segunda gravação. NÃO execute novamente; revise este pagamento manualmente.",
    );
  }

  attemptDepoisDoPedido.status = "expired";
  attemptDepoisDoPedido.lastCheckedAt = now;
  attemptDepoisDoPedido.processedAt = attemptDepoisDoPedido.processedAt || now;
  attemptDepoisDoPedido.reconciliationStatus = "processed";
  await attemptDepoisDoPedido.save();
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(`ERRO: ${error.message}`);
    usage();
    process.exitCode = 2;
    return;
  }

  const mongoUri = String(process.env.CONNECTIONSTRING || "").trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(mongoUri)) {
    throw new Error("CONNECTIONSTRING não está configurada corretamente.");
  }

  await mongoose.connect(mongoUri, { autoIndex: false });

  const attempt = await OrderPaymentAttempt.findOne({ paymentId: args.paymentId });
  if (!attempt) {
    throw new Error(`Nenhuma OrderPaymentAttempt encontrada para paymentId ${args.paymentId}.`);
  }

  const pedido = await Pedido.findOne({
    _id: attempt.pedidoId,
    estabelecimentoId: attempt.estabelecimentoId,
  });
  if (!pedido) {
    throw new Error("O pedido associado à tentativa não foi encontrado no mesmo estabelecimento.");
  }

  assertLocalSafety({ attempt, pedido, args });
  await assertNoNewerActiveAttempt(attempt);

  const configuracao = await Configuracao.findOne({
    estabelecimentoId: attempt.estabelecimentoId,
  }).select("+mercadoPago.accessTokenCriptografado mercadoPago.conectado mercadoPago.userId");

  const currentCollectorId = String(configuracao?.mercadoPago?.userId || "");
  printLocalSummary({ attempt, pedido, currentCollectorId });

  if (args.manualCancelled) {
    console.log("\n=== MODO MANUAL CANCELADO ===");
    console.log("A API do Mercado Pago NÃO será usada como confirmação do status.");
    console.log("Use este modo somente após conferir o mesmo paymentId como CANCELADO no painel do Mercado Pago.");
    console.log(`Confirmação explícita recebida para paymentId: ${args.confirm}`);

    if (!args.apply) {
      console.log("\nMODO VERIFICAÇÃO: nenhuma alteração foi feita no banco.");
      console.log("Para aplicar, repita o comando acrescentando --apply.");
      return;
    }

    await applyManualCancelled({ attempt, pedido, args });

    const [pedidoFinal, attemptFinal] = await Promise.all([
      Pedido.findById(pedido._id)
        .select("pagamentoStatus mercadoPagoStatus mercadoPagoPaymentId pixExpiradoEm pixExpiracaoStatusRemoto pixExpiracaoUltimaTentativaEm pixExpiracaoErro historicoFinanceiro")
        .lean(),
      OrderPaymentAttempt.findById(attempt._id)
        .select("status reconciliationStatus paymentId lastCheckedAt processedAt expectedCollectorId")
        .lean(),
    ]);

    console.log("\n=== CONCILIAÇÃO MANUAL APLICADA ===");
    console.log(JSON.stringify({ pedido: pedidoFinal, attempt: attemptFinal }, null, 2));
    console.log("\nO registro foi preservado e conciliado; nada foi apagado.");
    return;
  }

  if (!configuracao?.mercadoPago?.conectado || !configuracao.mercadoPago.accessTokenCriptografado) {
    throw new Error("O estabelecimento não possui uma conta Mercado Pago conectada com token disponível.");
  }

  const accessToken = descriptografar(configuracao.mercadoPago.accessTokenCriptografado);
  if (!accessToken) throw new Error("Não foi possível obter o token Mercado Pago do estabelecimento.");

  let payment;
  try {
    payment = await consultarPagamento(args.paymentId, accessToken);
  } catch (error) {
    if (Number(error?.httpStatus) === 404) {
      console.error("\nA API retornou 404 Payment not found para a credencial atualmente conectada.");
      console.error("Isso é compatível com pagamento criado por outro collector/conta anteriormente conectada.");
      console.error("Se você conferiu ESTE MESMO paymentId como CANCELADO no painel do Mercado Pago, use o modo --manual-cancelled com --confirm=<paymentId>.");
    }
    throw error;
  }

  validatePaymentIdentity(payment, {
    paymentId: args.paymentId,
    amount: attempt.expectedAmount,
    externalReference: attempt.externalReference,
    collectorId: attempt.expectedCollectorId,
  });

  if (String(payment.payment_method_id || "").toLowerCase() !== "pix") {
    throw new Error(`O provedor retornou payment_method_id=${String(payment.payment_method_id || "vazio")}, não Pix.`);
  }

  const remoteStatus = String(payment.status || "").trim().toLowerCase();
  if (!isRemoteTerminalUnpaidStatus(remoteStatus)) {
    throw new Error(
      `Status remoto '${remoteStatus || "vazio"}' não é terminal não pago. O script não alterará o banco.`,
    );
  }

  console.log("\nValidações financeiras via API: OK");
  console.log(`Status remoto confirmado: ${remoteStatus}`);

  if (!args.apply) {
    console.log("\nMODO VERIFICAÇÃO: nenhuma alteração foi feita no banco.");
    console.log("Para aplicar, execute novamente acrescentando --apply.");
    return;
  }

  const [pedidoAtual, attemptAtual] = await Promise.all([
    Pedido.findOne({ _id: pedido._id, estabelecimentoId: attempt.estabelecimentoId }),
    OrderPaymentAttempt.findById(attempt._id),
  ]);
  if (!pedidoAtual || !attemptAtual) throw new Error("Pedido ou tentativa deixou de existir antes da aplicação.");
  assertLocalSafety({ attempt: attemptAtual, pedido: pedidoAtual, args });
  await assertNoNewerActiveAttempt(attemptAtual);

  await markOrderPixExpired({
    pedido: pedidoAtual,
    attempt: attemptAtual,
    now: new Date(),
    remoteStatus,
  });

  console.log("\nCONCILIAÇÃO VIA API APLICADA COM SUCESSO.");
}

main()
  .catch(error => {
    console.error(`\nFALHA: ${String(error?.message || error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch {}
  });
