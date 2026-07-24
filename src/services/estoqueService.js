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
  const pedido = await Pedido.findById(pedidoId);
  if (!pedido || pedido.estoqueBaixado) return pedido;
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
  const estoques = await Estoque.find({ _id: { $in: [...consumos.keys()] }, estabelecimentoId: pedido.estabelecimentoId });
  const mapaEstoque = new Map(estoques.map(i => [String(i._id), i]));
  for (const consumo of consumos.values()) {
    const item = mapaEstoque.get(String(consumo.estoqueId));
    if (!item) throw new Error('Item de estoque não encontrado durante a baixa.');
    const qtd = converterQuantidade(consumo.quantidade, consumo.unidade, item.unidade);
    if (Number(item.quantidade) + 1e-9 < qtd) throw new Error(`Estoque insuficiente de ${item.nome}. Disponível: ${item.quantidade} ${item.unidade}.`);
  }
  for (const consumo of consumos.values()) {
    const item = mapaEstoque.get(String(consumo.estoqueId));
    const qtd = converterQuantidade(consumo.quantidade, consumo.unidade, item.unidade);
    item.quantidade = Math.max(0, Number(item.quantidade) - qtd);
    await item.save();
  }
  pedido.estoqueBaixado = true;
  pedido.estoqueBaixadoEm = new Date();
  await pedido.save();
  return pedido;
}

async function restaurarEstoqueDoPedido(pedidoId) {
  const pedido = await Pedido.findById(pedidoId);
  if (!pedido || !pedido.estoqueBaixado) return pedido;
  const produtos = await Produto.find({ _id: { $in: pedido.itens.map(i => i.produtoId) }, estabelecimentoId: pedido.estabelecimentoId }).lean();
  const mapaProdutos = new Map(produtos.map(p => [String(p._id), p]));
  for (const itemPedido of pedido.itens) {
    const produto = mapaProdutos.get(String(itemPedido.produtoId));
    for (const ingrediente of produto?.receita || []) {
      const item = await Estoque.findOne({ _id: ingrediente.estoqueId, estabelecimentoId: pedido.estabelecimentoId });
      if (!item) continue;
      const qtd = converterQuantidade(Number(ingrediente.quantidade || 0) * Number(itemPedido.quantidade || 0), ingrediente.unidade, item.unidade);
      item.quantidade = Number(item.quantidade) + qtd;
      await item.save();
    }
  }
  pedido.estoqueBaixado = false;
  pedido.estoqueBaixadoEm = null;
  await pedido.save();
  return pedido;
}

module.exports = { normalizarUnidade, converterQuantidade, calcularReceita, baixarEstoqueDoPedido, restaurarEstoqueDoPedido };
