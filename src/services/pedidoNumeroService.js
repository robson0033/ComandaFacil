"use strict";

const {
  Configuracao,
  Pedido,
  PedidoSequencia,
} = require("../models/painelModels");
const {
  datePartsInTimezone,
  getEstablishmentTimezone,
  localDateTimeToUtc,
} = require("./timezoneService");

function chaveDataLocal(date = new Date(), timeZone) {
  const partes = datePartsInTimezone(date, timeZone);
  return `${String(partes.year).padStart(4, "0")}-${String(partes.month).padStart(2, "0")}-${String(partes.day).padStart(2, "0")}`;
}

function intervaloDataLocal(dataLocal, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dataLocal || ""));
  if (!match) throw new Error("Data local inválida para a sequência do pedido.");
  const [year, month, day] = match.slice(1).map(Number);
  const inicio = localDateTimeToUtc({ year, month, day }, timeZone);
  const proximoDiaUtc = new Date(Date.UTC(year, month - 1, day + 1));
  const proximoDia = localDateTimeToUtc({
    year: proximoDiaUtc.getUTCFullYear(),
    month: proximoDiaUtc.getUTCMonth() + 1,
    day: proximoDiaUtc.getUTCDate(),
  }, timeZone);
  return { inicio, fim: proximoDia };
}

function idSequencia(estabelecimentoId, dataLocal) {
  return `${String(estabelecimentoId)}:${String(dataLocal)}`;
}

function formatarNumeroPedido(value) {
  const numero = Number(value);
  if (!Number.isSafeInteger(numero) || numero <= 0) return "";
  return String(numero).padStart(4, "0");
}

async function reservarNumeroPedido({ estabelecimentoId, agora = new Date() } = {}) {
  if (!estabelecimentoId) {
    throw new Error("Estabelecimento obrigatório para numerar o pedido.");
  }

  const configuracao = await Configuracao.findOne({ estabelecimentoId })
    .select("timezone")
    .lean();
  const timeZone = getEstablishmentTimezone(configuracao || {});
  const dataLocal = chaveDataLocal(agora, timeZone);
  const _id = idSequencia(estabelecimentoId, dataLocal);

  // Na primeira execução do dia, considera também pedidos criados antes desta
  // funcionalidade entrar em produção. Assim, se já existirem 148 pedidos no
  // dia, o primeiro pedido numerado após o deploy será o #0149.
  let baseline = 0;
  const contadorExistente = await PedidoSequencia.findById(_id)
    .select("_id")
    .lean();
  if (!contadorExistente) {
    const { inicio, fim } = intervaloDataLocal(dataLocal, timeZone);
    baseline = await Pedido.countDocuments({
      estabelecimentoId,
      createdAt: { $gte: inicio, $lt: fim },
    });
  }

  if (!contadorExistente) {
    try {
      await PedidoSequencia.updateOne(
        { _id },
        {
          $setOnInsert: {
            estabelecimentoId,
            dataLocal,
            ultimoNumero: baseline,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      // Duas compras podem tentar inaugurar o contador do dia ao mesmo tempo.
      // O _id determinístico garante unicidade; quem perder a corrida apenas
      // segue para o $inc no contador que a outra requisição acabou de criar.
      if (Number(error?.code) !== 11000) throw error;
    }
  }

  const contador = await PedidoSequencia.findOneAndUpdate(
    { _id },
    { $inc: { ultimoNumero: 1 } },
    { returnDocument: 'after' },
  ).lean();

  const numeroPedido = Number(contador?.ultimoNumero);
  if (!Number.isSafeInteger(numeroPedido) || numeroPedido <= 0) {
    throw new Error("Não foi possível reservar o número sequencial do pedido.");
  }

  return {
    numeroPedido,
    numeroPedidoData: dataLocal,
    numeroPedidoFormatado: formatarNumeroPedido(numeroPedido),
    timeZone,
  };
}

module.exports = {
  chaveDataLocal,
  formatarNumeroPedido,
  reservarNumeroPedido,
};
