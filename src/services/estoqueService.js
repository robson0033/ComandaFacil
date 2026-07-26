"use strict";

const crypto = require("crypto");
const { Estoque, Produto, Pedido } = require("../models/painelModels");

const LEASE_MS = 5 * 60 * 1000;
const FATORES = {
  kg: 1000,
  g: 1,
  litro: 1000,
  l: 1000,
  ml: 1,
  unidade: 1,
  un: 1,
  caixa: 1,
  pacote: 1,
};
const GRUPOS = {
  kg: "massa",
  g: "massa",
  litro: "volume",
  l: "volume",
  ml: "volume",
  unidade: "unidade",
  un: "unidade",
  caixa: "caixa",
  pacote: "pacote",
};

function erroIngredienteDesativado() {
  const error = new Error(
    "A ficha técnica contém ingrediente desativado. Atualize o produto antes de confirmar o pagamento.",
  );
  error.code = "INGREDIENTE_DESATIVADO";
  error.retryable = false;
  return error;
}

function normalizarUnidade(unidade) {
  const valor = String(unidade || "unidade").trim().toLowerCase();
  return valor === "l" ? "litro" : valor === "un" ? "unidade" : valor;
}

function converterQuantidade(valor, origem, destino) {
  const quantidade = Number(valor);
  const unidadeOrigem = normalizarUnidade(origem);
  const unidadeDestino = normalizarUnidade(destino);
  if (!Number.isFinite(quantidade) || quantidade < 0) {
    throw new Error("Quantidade inválida para conversão.");
  }
  if (!GRUPOS[unidadeOrigem] || !GRUPOS[unidadeDestino]) {
    throw new Error("Unidade de estoque não suportada.");
  }
  if (unidadeOrigem === unidadeDestino) return quantidade;
  if (GRUPOS[unidadeOrigem] !== GRUPOS[unidadeDestino]) {
    throw new Error(
      `Não é possível converter ${unidadeOrigem} para ${unidadeDestino}.`,
    );
  }
  return quantidade * FATORES[unidadeOrigem] / FATORES[unidadeDestino];
}

function custoDaPorcao(itemEstoque, quantidade, unidadeConsumo) {
  return converterQuantidade(
    quantidade,
    unidadeConsumo,
    itemEstoque.unidade,
  ) * Number(itemEstoque.custoUnitario || 0);
}

async function calcularFichaTecnica(estabelecimentoId, fichaTecnica = []) {
  const ids = fichaTecnica.map(item => item.estoqueId).filter(Boolean);
  const itens = await Estoque.find({
    _id: { $in: ids },
    estabelecimentoId,
  }).lean();
  const mapa = new Map(itens.map(item => [String(item._id), item]));
  let custo = 0;
  const fichaTecnicaNormalizada = fichaTecnica.map(item => {
    const estoque = mapa.get(String(item.estoqueId));
    if (!estoque) {
      throw new Error("Um item de estoque vinculado não foi encontrado.");
    }
    const quantidade = Number(item.quantidade);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new Error("Quantidade inválida na ficha técnica.");
    }
    const unidade = normalizarUnidade(item.unidade || estoque.unidade);
    const custoPorcao = custoDaPorcao(estoque, quantidade, unidade);
    custo += custoPorcao;
    return {
      estoqueId: estoque._id,
      nome: estoque.nome,
      quantidade,
      unidade,
      custoPorcao,
    };
  });
  return {
    fichaTecnica: fichaTecnicaNormalizada,
    custo: Number(custo.toFixed(4)),
  };
}

function montarConsumosDoPedido(pedido, produtos) {
  const mapaProdutos = new Map(
    produtos.map(produto => [String(produto._id), produto]),
  );
  const consumos = [];
  for (const [itemPedidoIndice, itemPedido] of (pedido.itens || []).entries()) {
    const produto = mapaProdutos.get(String(itemPedido.produtoId));
    if (!produto) {
      throw new Error("Produto do pedido não foi encontrado no estabelecimento.");
    }
    const quantidadeProduto = Number(itemPedido.quantidade);
    if (!Number.isFinite(quantidadeProduto) || quantidadeProduto <= 0) {
      throw new Error("Quantidade inválida no pedido.");
    }
    for (const ingrediente of Array.isArray(produto.fichaTecnica)
      ? produto.fichaTecnica
      : []) {
      const quantidadeFicha = Number(ingrediente.quantidade);
      if (!ingrediente.estoqueId
        || !Number.isFinite(quantidadeFicha)
        || quantidadeFicha <= 0) {
        throw new Error("Ingrediente inválido na ficha técnica do produto.");
      }
      consumos.push({
        estoqueId: ingrediente.estoqueId,
        produtoId: produto._id,
        itemPedidoIndice,
        quantidadeProduto,
        quantidadeConsumida: quantidadeFicha * quantidadeProduto,
        unidadeFicha: ingrediente.unidade,
      });
    }
  }
  return consumos;
}

async function calcularSnapshot(pedido) {
  const produtos = await Produto.find({
    _id: { $in: (pedido.itens || []).map(item => item.produtoId) },
    estabelecimentoId: pedido.estabelecimentoId,
  }).lean();
  const consumos = montarConsumosDoPedido(pedido, produtos);
  const idsEstoque = [...new Set(consumos.map(item => String(item.estoqueId)))];
  const estoques = await Estoque.find({
    _id: { $in: idsEstoque },
    estabelecimentoId: pedido.estabelecimentoId,
    ativo: { $ne: false },
  }).lean();
  const mapaEstoque = new Map(
    estoques.map(item => [String(item._id), item]),
  );
  const idsAusentes = idsEstoque.filter(id => !mapaEstoque.has(String(id)));
  if (idsAusentes.length) {
    const desativados = await Estoque.find({
      _id: { $in: idsAusentes },
      estabelecimentoId: pedido.estabelecimentoId,
      ativo: false,
    }).select("_id").lean();
    if (desativados.length) {
      throw erroIngredienteDesativado();
    }
    throw new Error(
      "Ingrediente da ficha técnica não pertence ao estabelecimento.",
    );
  }
  return consumos.map((consumo, consumoIndice) => {
    const estoque = mapaEstoque.get(String(consumo.estoqueId));
    const quantidadeNaUnidadeEstoque = converterQuantidade(
      consumo.quantidadeConsumida,
      consumo.unidadeFicha,
      estoque.unidade,
    );
    return {
      ...consumo,
      nomeIngrediente: String(estoque.nome || "Ingrediente").slice(0, 160),
      quantidadeNaUnidadeEstoque,
      unidadeEstoque: normalizarUnidade(estoque.unidade),
      operationKey: [
        "baixa",
        String(pedido._id),
        consumo.itemPedidoIndice,
        consumoIndice,
        String(consumo.estoqueId),
      ].join(":"),
      estado: "pendente",
      erro: "",
    };
  });
}

async function validarConsumosPendentesAtivos(pedido) {
  const idsPendentes = [...new Set(
    (pedido.estoqueConsumos || [])
      .filter(consumo => consumo.estado !== "baixado")
      .map(consumo => String(consumo.estoqueId)),
  )];
  if (!idsPendentes.length) return;
  const ativos = await Estoque.find({
    _id: { $in: idsPendentes },
    estabelecimentoId: pedido.estabelecimentoId,
    ativo: { $ne: false },
  }).select("_id").lean();
  if (ativos.length !== idsPendentes.length) {
    throw erroIngredienteDesativado();
  }
}

function novoLockId() {
  return crypto.randomUUID();
}

function lockExpiraEm() {
  return new Date(Date.now() + LEASE_MS);
}

async function renovarLock(pedidoId, lockId, estado) {
  const result = await Pedido.updateOne(
    {
      _id: pedidoId,
      estoqueLockId: lockId,
      estoqueLockExpiraEm: { $gt: new Date() },
    },
    {
      $set: {
        estoqueProcessamento: estado,
        estoqueProcessamentoEm: new Date(),
        estoqueLockExpiraEm: lockExpiraEm(),
      },
    },
  );
  if (!result.modifiedCount) {
    const error = new Error("O lease de estoque não pertence mais a este worker.");
    error.code = "ESTOQUE_LOCK_PERDIDO";
    throw error;
  }
}

async function adquirirLock(pedidoId, operacao) {
  const lockId = novoLockId();
  const agora = new Date();
  const filtroEstado = operacao === "baixa"
    ? { estoqueBaixado: { $ne: true }, estoqueRestaurado: { $ne: true } }
    : { estoqueRestaurado: { $ne: true } };
  const pedido = await Pedido.findOneAndUpdate(
    {
      _id: pedidoId,
      ...filtroEstado,
      $or: [
        { estoqueLockId: { $in: ["", null] } },
        { estoqueLockExpiraEm: { $lte: agora } },
        { estoqueLockExpiraEm: null },
      ],
    },
    {
      $set: {
        estoqueLockId: lockId,
        estoqueLockExpiraEm: lockExpiraEm(),
        estoqueProcessamento: operacao === "baixa"
          ? "preparando"
          : "restaurando",
        estoqueProcessamentoEm: agora,
        estoqueErro: "",
      },
    },
    { returnDocument: "after" },
  );
  return { pedido, lockId };
}

async function liberarLock(pedidoId, lockId, set) {
  const result = await Pedido.updateOne(
    { _id: pedidoId, estoqueLockId: lockId },
    {
      $set: {
        ...set,
        estoqueLockId: "",
        estoqueLockExpiraEm: null,
        estoqueProcessamentoEm: null,
      },
    },
  );
  if (!result.modifiedCount) {
    const error = new Error("Worker antigo não pode concluir o estoque.");
    error.code = "ESTOQUE_LOCK_PERDIDO";
    throw error;
  }
}

async function marcarConsumo(pedidoId, lockId, operationKey, estado, erro = "") {
  const result = await Pedido.updateOne(
    {
      _id: pedidoId,
      estoqueLockId: lockId,
      "estoqueConsumos.operationKey": operationKey,
    },
    {
      $set: {
        "estoqueConsumos.$.estado": estado,
        "estoqueConsumos.$.erro": String(erro || "").slice(0, 500),
      },
    },
  );
  if (!result.modifiedCount) {
    const error = new Error("Não foi possível persistir o estado do consumo.");
    error.code = "ESTOQUE_LOCK_PERDIDO";
    throw error;
  }
}

async function compensarBaixas(pedido, lockId) {
  let completa = true;
  for (const consumo of pedido.estoqueConsumos || []) {
    try {
      await renovarLock(pedido._id, lockId, "baixando");
      const result = await Estoque.updateOne(
        {
          _id: consumo.estoqueId,
          estabelecimentoId: pedido.estabelecimentoId,
          estoqueOperacoes: consumo.operationKey,
          totalConsumido: {
            $gte: consumo.quantidadeNaUnidadeEstoque,
          },
        },
        {
          $inc: {
            quantidade: consumo.quantidadeNaUnidadeEstoque,
            totalConsumido: -consumo.quantidadeNaUnidadeEstoque,
          },
          $pull: { estoqueOperacoes: consumo.operationKey },
        },
      );
      if (result.modifiedCount) {
        await marcarConsumo(
          pedido._id,
          lockId,
          consumo.operationKey,
          "pendente",
        );
      } else {
        const estoque = await Estoque.findOne({
          _id: consumo.estoqueId,
          estabelecimentoId: pedido.estabelecimentoId,
        }).select("+estoqueOperacoes");
        if (!estoque) {
          throw new Error("Ingrediente não encontrado durante compensação.");
        }
        if (!estoque.estoqueOperacoes?.includes(consumo.operationKey)) {
          await marcarConsumo(
            pedido._id,
            lockId,
            consumo.operationKey,
            "pendente",
          );
        }
      }
    } catch {
      completa = false;
      await marcarConsumo(
        pedido._id,
        lockId,
        consumo.operationKey,
        "falhou",
        "Falha ao compensar baixa parcial.",
      ).catch(() => {});
    }
  }
  return completa;
}

async function prepararSnapshot(pedido, lockId) {
  if (pedido.estoqueSnapshotCriado === true) {
    return pedido;
  }
  const snapshot = await calcularSnapshot(pedido);
  const result = await Pedido.findOneAndUpdate(
    {
      _id: pedido._id,
      estoqueLockId: lockId,
      estoqueSnapshotCriado: { $ne: true },
    },
    {
      $set: {
        estoqueConsumos: snapshot,
        estoqueSnapshotCriado: true,
      },
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!result) {
    const error = new Error("Snapshot não foi persistido pelo worker atual.");
    error.code = "ESTOQUE_LOCK_PERDIDO";
    throw error;
  }
  return result;
}

function resultadoFalha(status, pedido, errorCode, retryable = true) {
  return {
    success: false,
    status,
    pedido,
    retryable,
    errorCode,
  };
}

async function baixarEstoqueDoPedido(pedidoId) {
  const atual = await Pedido.findById(pedidoId);
  if (!atual) {
    return resultadoFalha(
      "falhou",
      null,
      "PEDIDO_NAO_ENCONTRADO",
      false,
    );
  }
  if (atual.estoqueBaixado === true) {
    return {
      success: true,
      status: "ja_concluido",
      pedido: atual,
      retryable: false,
    };
  }
  if (atual.estoqueRestaurado === true) {
    return resultadoFalha(
      "falhou",
      atual,
      "ESTOQUE_JA_RESTAURADO",
      false,
    );
  }

  const { pedido: claimed, lockId } = await adquirirLock(pedidoId, "baixa");
  if (!claimed) {
    return resultadoFalha(
      "lock_ocupado",
      await Pedido.findById(pedidoId),
      "ESTOQUE_LOCK_OCUPADO",
    );
  }

  let pedido = claimed;
  let erroOriginal;
  try {
    pedido = await prepararSnapshot(pedido, lockId);
    await validarConsumosPendentesAtivos(pedido);
    await renovarLock(pedido._id, lockId, "baixando");
    for (const consumo of pedido.estoqueConsumos || []) {
      if (consumo.estado === "baixado") continue;
      await renovarLock(pedido._id, lockId, "baixando");
      const result = await Estoque.updateOne(
        {
          _id: consumo.estoqueId,
          estabelecimentoId: pedido.estabelecimentoId,
          ativo: { $ne: false },
          estoqueOperacoes: { $ne: consumo.operationKey },
          quantidade: { $gte: consumo.quantidadeNaUnidadeEstoque },
        },
        {
          $inc: {
            quantidade: -consumo.quantidadeNaUnidadeEstoque,
            totalConsumido: consumo.quantidadeNaUnidadeEstoque,
          },
          $addToSet: { estoqueOperacoes: consumo.operationKey },
        },
      );
      if (!result.modifiedCount) {
        const estoque = await Estoque.findOne({
          _id: consumo.estoqueId,
          estabelecimentoId: pedido.estabelecimentoId,
        }).select("+estoqueOperacoes");
        if (estoque?.ativo === false) {
          throw erroIngredienteDesativado();
        }
        if (!estoque?.estoqueOperacoes?.includes(consumo.operationKey)) {
          throw new Error(
            `Estoque insuficiente de ${consumo.nomeIngrediente}.`,
          );
        }
      }
      await marcarConsumo(
        pedido._id,
        lockId,
        consumo.operationKey,
        "baixado",
      );
    }
    await liberarLock(pedido._id, lockId, {
      estoqueBaixado: true,
      estoqueBaixadoEm: pedido.estoqueBaixadoEm || new Date(),
      estoqueRestaurado: false,
      estoqueRestauradoEm: null,
      estoqueProcessamento: "concluido",
      estoqueErro: "",
    });
    return {
      success: true,
      status: "concluido",
      pedido: await Pedido.findById(pedido._id),
      retryable: false,
    };
  } catch (error) {
    erroOriginal = error;
  }

  const compensacaoCompleta = await compensarBaixas(pedido, lockId);
  const statusFinal = compensacaoCompleta
    ? "falhou"
    : "reconciliacao_necessaria";
  await liberarLock(pedido._id, lockId, {
    estoqueBaixado: false,
    estoqueRestaurado: false,
    estoqueProcessamento: statusFinal,
    estoqueErro: [
      "Falha ao aplicar movimentação de estoque:",
      String(erroOriginal?.message || "erro desconhecido").slice(0, 400),
    ].join(" "),
  }).catch(() => {});
  return resultadoFalha(
    statusFinal,
    await Pedido.findById(pedido._id),
    erroOriginal?.code === "INGREDIENTE_DESATIVADO"
      ? "INGREDIENTE_DESATIVADO"
      : compensacaoCompleta
        ? "ESTOQUE_BAIXA_FALHOU"
        : "ESTOQUE_RECONCILIACAO_NECESSARIA",
    erroOriginal?.code === "INGREDIENTE_DESATIVADO"
      ? false
      : compensacaoCompleta,
  );
}

async function restaurarEstoqueDoPedido(pedidoId) {
  const atual = await Pedido.findById(pedidoId);
  if (!atual) {
    return resultadoFalha(
      "falhou",
      null,
      "PEDIDO_NAO_ENCONTRADO",
      false,
    );
  }
  if (atual.estoqueRestaurado === true) {
    return {
      success: true,
      status: "ja_restaurado",
      pedido: atual,
      retryable: false,
    };
  }
  if (atual.estoqueBaixado !== true) {
    return {
      success: true,
      status: "nao_baixado",
      pedido: atual,
      retryable: false,
    };
  }
  if (atual.estoqueSnapshotCriado !== true) {
    await Pedido.updateOne(
      { _id: pedidoId },
      {
        $set: {
          estoqueProcessamento: "reconciliacao_necessaria",
          estoqueErro:
            "Pedido legado com estoque baixado e sem snapshot de consumo.",
        },
      },
    );
    return resultadoFalha(
      "reconciliacao_necessaria",
      await Pedido.findById(pedidoId),
      "ESTOQUE_LEGADO_SEM_SNAPSHOT",
      false,
    );
  }

  const { pedido, lockId } = await adquirirLock(pedidoId, "restauracao");
  if (!pedido) {
    return resultadoFalha(
      "lock_ocupado",
      await Pedido.findById(pedidoId),
      "ESTOQUE_LOCK_OCUPADO",
    );
  }
  try {
    for (const consumo of pedido.estoqueConsumos) {
      if (consumo.estado === "restaurado") continue;
      if (consumo.estado !== "baixado") continue;
      await renovarLock(pedido._id, lockId, "restaurando");
      const restoreKey = `restaura:${consumo.operationKey}`;
      const result = await Estoque.updateOne(
        {
          _id: consumo.estoqueId,
          estabelecimentoId: pedido.estabelecimentoId,
          $and: [
            { estoqueOperacoes: consumo.operationKey },
            { estoqueOperacoes: { $ne: restoreKey } },
          ],
          totalConsumido: {
            $gte: consumo.quantidadeNaUnidadeEstoque,
          },
        },
        {
          $inc: {
            quantidade: consumo.quantidadeNaUnidadeEstoque,
            totalConsumido: -consumo.quantidadeNaUnidadeEstoque,
          },
          $addToSet: { estoqueOperacoes: restoreKey },
        },
      );
      if (!result.modifiedCount) {
        const estoque = await Estoque.findOne({
          _id: consumo.estoqueId,
          estabelecimentoId: pedido.estabelecimentoId,
        }).select("+estoqueOperacoes");
        if (!estoque) {
          throw new Error("Ingrediente do snapshot foi excluído.");
        }
        if (!estoque.estoqueOperacoes?.includes(restoreKey)) {
          throw new Error("Movimentação original não foi encontrada.");
        }
      }
      await marcarConsumo(
        pedido._id,
        lockId,
        consumo.operationKey,
        "restaurado",
      );
    }
    await liberarLock(pedido._id, lockId, {
      estoqueBaixado: false,
      estoqueRestaurado: true,
      estoqueRestauradoEm: new Date(),
      estoqueProcessamento: "restaurado",
      estoqueErro: "",
    });
    return {
      success: true,
      status: "restaurado",
      pedido: await Pedido.findById(pedido._id),
      retryable: false,
    };
  } catch (error) {
    await liberarLock(pedido._id, lockId, {
      estoqueProcessamento: "reconciliacao_necessaria",
      estoqueErro: `Falha ao restaurar estoque: ${String(error.message).slice(0, 450)}`,
    }).catch(() => {});
    return resultadoFalha(
      "reconciliacao_necessaria",
      await Pedido.findById(pedido._id),
      "ESTOQUE_RECONCILIACAO_NECESSARIA",
      false,
    );
  }
}

module.exports = {
  normalizarUnidade,
  converterQuantidade,
  calcularFichaTecnica,
  montarConsumosDoPedido,
  calcularSnapshot,
  validarConsumosPendentesAtivos,
  baixarEstoqueDoPedido,
  restaurarEstoqueDoPedido,
  _testing: {
    adquirirLock,
    compensarBaixas,
    liberarLock,
    marcarConsumo,
    renovarLock,
  },
};
