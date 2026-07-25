const { Estoque, Produto, Pedido } = require('../models/painelModels');

const FATORES = { kg: 1000, g: 1, litro: 1000, l: 1000, ml: 1, unidade: 1, un: 1, caixa: 1, pacote: 1 };
const GRUPOS = { kg: 'massa', g: 'massa', litro: 'volume', l: 'volume', ml: 'volume', unidade: 'unidade', un: 'unidade', caixa: 'caixa', pacote: 'pacote' };

function normalizarUnidade(unidade) {
  const valor = String(unidade || 'unidade').trim().toLowerCase();
  return valor === 'l' ? 'litro' : valor === 'un' ? 'unidade' : valor;
}

function converterQuantidade(valor, origem, destino) {
  const quantidade = Number(valor || 0);
  const unidadeOrigem = normalizarUnidade(origem);
  const unidadeDestino = normalizarUnidade(destino);
  if (!Number.isFinite(quantidade)) return 0;
  if (unidadeOrigem === unidadeDestino) return quantidade;
  if (GRUPOS[unidadeOrigem] !== GRUPOS[unidadeDestino]) {
    throw new Error(`Não é possível converter ${unidadeOrigem} para ${unidadeDestino}.`);
  }
  return quantidade * (FATORES[unidadeOrigem] || 1) / (FATORES[unidadeDestino] || 1);
}

function custoDaPorcao(itemEstoque, quantidade, unidadeConsumo) {
  const consumoNaUnidadeEstoque = converterQuantidade(quantidade, unidadeConsumo, itemEstoque.unidade);
  return consumoNaUnidadeEstoque * Number(itemEstoque.custoUnitario || 0);
}

async function calcularReceita(estabelecimentoId, receita = []) {
  const ids = receita.map(item => item.estoqueId).filter(Boolean);
  const itens = await Estoque.find({ _id: { $in: ids }, estabelecimentoId }).lean();
  const mapa = new Map(itens.map(item => [String(item._id), item]));
  let custo = 0;
  const receitaNormalizada = receita.map(item => {
    const estoque = mapa.get(String(item.estoqueId));
    if (!estoque) throw new Error('Um item de estoque vinculado não foi encontrado.');
    const quantidade = Math.max(0, Number(item.quantidade || 0));
    const unidade = normalizarUnidade(item.unidade || estoque.unidade);
    const custoPorcao = custoDaPorcao(estoque, quantidade, unidade);
    custo += custoPorcao;
    return { estoqueId: estoque._id, nome: estoque.nome, quantidade, unidade, custoPorcao };
  }).filter(item => item.quantidade > 0);
  return { receita: receitaNormalizada, custo: Number(custo.toFixed(4)) };
}

async function baixarEstoqueDoPedido(pedidoId) {
  const lockExpiradoEm = new Date(Date.now() - 5 * 60 * 1000);
  const pedido = await Pedido.findOneAndUpdate(
    {
      _id: pedidoId,
      estoqueBaixado: { $ne: true },
      $or: [
        { estoqueProcessamento: { $ne: 'processando' } },
        { estoqueProcessamentoEm: { $lt: lockExpiradoEm } },
        { estoqueProcessamentoEm: null },
      ],
    },
    {
      $set: {
        estoqueProcessamento: 'processando',
        estoqueProcessamentoEm: new Date(),
        estoqueErro: '',
      },
    },
    { new: true },
  );
  if (!pedido) {
    const atual = await Pedido.findById(pedidoId);
    if (!atual) {
      return { success: false, status: 'falhou', pedido: null, retryable: false, errorCode: 'PEDIDO_NAO_ENCONTRADO' };
    }
    if (atual.estoqueBaixado === true) {
      return { success: true, status: 'ja_concluido', pedido: atual, retryable: false };
    }
    return {
      success: false,
      status: 'lock_ocupado',
      pedido: atual,
      retryable: true,
      errorCode: 'ESTOQUE_LOCK_OCUPADO',
    };
  }
  const produtos = await Produto.find({ _id: { $in: pedido.itens.map(i => i.produtoId) }, estabelecimentoId: pedido.estabelecimentoId }).lean();
  const mapaProdutos = new Map(produtos.map(p => [String(p._id), p]));
  const consumos = new Map();
  for (const itemPedido of pedido.itens) {
    const produto = mapaProdutos.get(String(itemPedido.produtoId));
    for (const ingrediente of produto?.receita || []) {
      const chave = String(ingrediente.estoqueId);
      const atual = consumos.get(chave) || { estoqueId: ingrediente.estoqueId, quantidade: 0, unidade: ingrediente.unidade };
      atual.quantidade += Number(ingrediente.quantidade || 0) * Number(itemPedido.quantidade || 0);
      consumos.set(chave, atual);
    }
  }
  try {
    const estoques = await Estoque.find({
      _id: { $in: [...consumos.keys()] },
      estabelecimentoId: pedido.estabelecimentoId,
    }).select('+estoqueOperacoes');
    const mapaEstoque = new Map(estoques.map(i => [String(i._id), i]));
    for (const consumo of consumos.values()) {
      const item = mapaEstoque.get(String(consumo.estoqueId));
      if (!item) throw new Error('Item de estoque não encontrado durante a baixa.');
      const qtd = converterQuantidade(consumo.quantidade, consumo.unidade, item.unidade);
      const operationKey = `baixa:${pedido._id}:${item._id}`;
      const result = await Estoque.updateOne(
        {
          _id: item._id,
          estabelecimentoId: pedido.estabelecimentoId,
          estoqueOperacoes: { $ne: operationKey },
          quantidade: { $gte: qtd },
        },
        {
          $inc: { quantidade: -qtd },
          $addToSet: { estoqueOperacoes: operationKey },
        },
      );
      if (!result.modifiedCount) {
        const atual = await Estoque.findOne({
          _id: item._id,
          estabelecimentoId: pedido.estabelecimentoId,
        }).select('+estoqueOperacoes');
        if (!atual?.estoqueOperacoes?.includes(operationKey)) {
          throw new Error(`Estoque insuficiente de ${item.nome}.`);
        }
      }
    }
    await Pedido.updateOne(
      { _id: pedido._id, estoqueBaixado: { $ne: true } },
      {
        $set: {
          estoqueBaixado: true,
          estoqueBaixadoEm: new Date(),
          estoqueProcessamento: 'concluido',
          estoqueProcessamentoEm: null,
          estoqueErro: '',
        },
      },
    );
    const finalizado = await Pedido.findById(pedido._id);
    if (!finalizado || finalizado.estoqueBaixado !== true) {
      throw new Error('Marcador final da baixa de estoque não foi persistido.');
    }
  } catch (error) {
    await Pedido.updateOne(
      { _id: pedido._id },
      {
        $set: {
          estoqueProcessamento: 'falhou',
          estoqueProcessamentoEm: null,
          estoqueErro: `Falha ao aplicar movimentação de estoque: ${String(error.message || 'erro desconhecido').slice(0, 500)}`,
        },
      },
    );
    return {
      success: false,
      status: 'falhou',
      pedido: await Pedido.findById(pedido._id),
      retryable: true,
      errorCode: 'ESTOQUE_BAIXA_FALHOU',
    };
  }
  return {
    success: true,
    status: 'concluido',
    pedido: await Pedido.findById(pedido._id),
    retryable: false,
  };
}

async function restaurarEstoqueDoPedido(pedidoId) {
  const lockExpiradoEm = new Date(Date.now() - 5 * 60 * 1000);
  const pedido = await Pedido.findOneAndUpdate(
    {
      _id: pedidoId,
      estoqueBaixado: true,
      $or: [
        { estoqueProcessamento: { $ne: 'processando' } },
        { estoqueProcessamentoEm: { $lt: lockExpiradoEm } },
        { estoqueProcessamentoEm: null },
      ],
    },
    {
      $set: {
        estoqueProcessamento: 'processando',
        estoqueProcessamentoEm: new Date(),
        estoqueErro: '',
      },
    },
    { new: true },
  );
  if (!pedido) {
    const atual = await Pedido.findById(pedidoId);
    if (!atual) {
      return { success: false, status: 'falhou', pedido: null, retryable: false, errorCode: 'PEDIDO_NAO_ENCONTRADO' };
    }
    if (atual.estoqueBaixado !== true
      && atual.estoqueProcessamento !== 'processando') {
      return { success: true, status: 'ja_concluido', pedido: atual, retryable: false };
    }
    return {
      success: false,
      status: 'lock_ocupado',
      pedido: atual,
      retryable: true,
      errorCode: 'ESTOQUE_LOCK_OCUPADO',
    };
  }
  const produtos = await Produto.find({ _id: { $in: pedido.itens.map(i => i.produtoId) }, estabelecimentoId: pedido.estabelecimentoId }).lean();
  const mapaProdutos = new Map(produtos.map(p => [String(p._id), p]));
  try {
    const consumos = new Map();
    for (const itemPedido of pedido.itens) {
      const produto = mapaProdutos.get(String(itemPedido.produtoId));
      for (const ingrediente of produto?.receita || []) {
        const key = String(ingrediente.estoqueId);
        const atual = consumos.get(key) || {
          estoqueId: ingrediente.estoqueId,
          quantidade: 0,
          unidade: ingrediente.unidade,
        };
        atual.quantidade += Number(ingrediente.quantidade || 0) * Number(itemPedido.quantidade || 0);
        consumos.set(key, atual);
      }
    }
    const estoques = await Estoque.find({
      _id: { $in: [...consumos.keys()] },
      estabelecimentoId: pedido.estabelecimentoId,
    }).select('+estoqueOperacoes');
    const mapaEstoque = new Map(estoques.map(item => [String(item._id), item]));
    for (const consumo of consumos.values()) {
      const item = mapaEstoque.get(String(consumo.estoqueId));
      if (!item) throw new Error('Item de estoque não encontrado durante a restauração.');
      const qtd = converterQuantidade(consumo.quantidade, consumo.unidade, item.unidade);
      const debitKey = `baixa:${pedido._id}:${item._id}`;
      const restoreKey = `restaura:${pedido._id}:${item._id}`;
      const result = await Estoque.updateOne(
        {
          _id: item._id,
          estabelecimentoId: pedido.estabelecimentoId,
          $and: [
            { estoqueOperacoes: debitKey },
            { estoqueOperacoes: { $ne: restoreKey } },
          ],
        },
        {
          $inc: { quantidade: qtd },
          $addToSet: { estoqueOperacoes: restoreKey },
        },
      );
      if (!result.modifiedCount) {
        const atual = await Estoque.findOne({
          _id: item._id,
          estabelecimentoId: pedido.estabelecimentoId,
        }).select('+estoqueOperacoes');
        if (!atual?.estoqueOperacoes?.includes(restoreKey)) {
          throw new Error(`Movimentação original de ${item.nome} não foi encontrada.`);
        }
      }
    }
    await Pedido.updateOne(
      { _id: pedido._id },
      {
        $set: {
          estoqueBaixado: false,
          estoqueBaixadoEm: null,
          estoqueProcessamento: 'concluido',
          estoqueProcessamentoEm: null,
          estoqueErro: '',
        },
      },
    );
    const finalizado = await Pedido.findById(pedido._id);
    if (!finalizado || finalizado.estoqueBaixado === true) {
      throw new Error('Marcador final da restauração de estoque não foi persistido.');
    }
  } catch (error) {
    await Pedido.updateOne(
      { _id: pedido._id },
      {
        $set: {
          estoqueProcessamento: 'falhou',
          estoqueProcessamentoEm: null,
          estoqueErro: `Falha ao restaurar movimentação de estoque: ${String(error.message || 'erro desconhecido').slice(0, 500)}`,
        },
      },
    );
    return {
      success: false,
      status: 'falhou',
      pedido: await Pedido.findById(pedido._id),
      retryable: true,
      errorCode: 'ESTOQUE_RESTAURACAO_FALHOU',
    };
  }
  return {
    success: true,
    status: 'concluido',
    pedido: await Pedido.findById(pedido._id),
    retryable: false,
  };
}

module.exports = { normalizarUnidade, converterQuantidade, calcularReceita, baixarEstoqueDoPedido, restaurarEstoqueDoPedido };
