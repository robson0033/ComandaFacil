"use strict";

const REGRAS_PRECO_PIZZA = Object.freeze({
  MAIOR_SABOR_ESCOLHIDO: "maior_sabor_escolhido",
  MAIOR_PRECO_CATEGORIA: "maior_preco_categoria",
});

function criarErroPizza(message, code = "PIZZA_MEIO_A_MEIO_INVALIDA") {
  const error = new Error(message);
  error.name = "PizzaMeioAMeioValidationError";
  error.code = code;
  error.statusCode = 422;
  return error;
}

function dinheiroParaCentavos(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw criarErroPizza("Preço de pizza inválido.");
  }
  const cents = Math.round((number + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) {
    throw criarErroPizza("Preço de pizza inválido.");
  }
  return cents;
}

function centavosParaDinheiro(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw criarErroPizza("Preço de pizza inválido.");
  }
  return cents / 100;
}

function categoriaPermitePizzaMeioAMeio(categoria = {}) {
  return String(categoria.tipo || "") === "catalogo"
    && String(categoria.tipoProduto || "normal") === "pizza"
    && categoria.configuracaoPizza?.permiteMeioAMeio === true;
}

function regraPrecoCategoria(categoria = {}) {
  const regra = String(
    categoria.configuracaoPizza?.regraPrecoMeioAMeio
    || REGRAS_PRECO_PIZZA.MAIOR_SABOR_ESCOLHIDO,
  );

  if (!Object.values(REGRAS_PRECO_PIZZA).includes(regra)) {
    throw criarErroPizza("A regra de preço da categoria de pizza é inválida.");
  }

  return regra;
}

function normalizarIdsSabores(itemRecebido = {}) {
  const sabores = Array.isArray(itemRecebido.saboresPizza)
    ? itemRecebido.saboresPizza
    : Array.isArray(itemRecebido.sabores)
      ? itemRecebido.sabores
      : [];

  return sabores
    .map(item => String(item?.produtoId || item?.id || item || "").trim())
    .filter(Boolean);
}

function mesclarFichaTecnicaMetade(produtos = []) {
  const merged = new Map();

  for (const produto of produtos) {
    for (const item of Array.isArray(produto?.fichaTecnica)
      ? produto.fichaTecnica
      : []) {
      const estoqueId = String(item?.estoqueId?._id || item?.estoqueId || "");
      const unidade = String(item?.unidade || "");
      const quantidade = Number(item?.quantidade);
      if (!estoqueId || !unidade || !Number.isFinite(quantidade) || quantidade <= 0) {
        throw criarErroPizza(
          "Uma ficha técnica da pizza está inválida.",
          "PIZZA_FICHA_TECNICA_INVALIDA",
        );
      }

      const key = `${estoqueId}:${unidade}`;
      const existing = merged.get(key) || {
        estoqueId: item.estoqueId?._id || item.estoqueId,
        nome: String(item.nome || "Ingrediente").slice(0, 160),
        quantidade: 0,
        unidade,
        custoCalculado: 0,
      };

      existing.quantidade += quantidade / 2;
      existing.custoCalculado += Number(item.custoCalculado || 0) / 2;
      merged.set(key, existing);
    }
  }

  return [...merged.values()].map(item => ({
    ...item,
    quantidade: Number(item.quantidade.toFixed(6)),
    custoCalculado: Number(item.custoCalculado.toFixed(4)),
  }));
}

function calcularMaiorPrecoCategoriaCentavos(produtosCategoria = []) {
  const precos = produtosCategoria.map(produto => dinheiroParaCentavos(produto.preco));
  if (!precos.length) {
    throw criarErroPizza(
      "Não foi possível calcular o maior preço da categoria de pizzas.",
      "PIZZA_CATEGORIA_SEM_PRECO",
    );
  }
  return Math.max(...precos);
}

function montarPizzaMeioAMeio({
  itemRecebido,
  produtosMap,
  categoriasMap,
  produtosPorCategoria,
}) {
  const idsSabores = normalizarIdsSabores(itemRecebido);
  if (idsSabores.length !== 2 || idsSabores[0] === idsSabores[1]) {
    throw criarErroPizza("Escolha dois sabores diferentes para a pizza meio a meio.");
  }

  const sabores = idsSabores.map(id => produtosMap.get(id));
  if (sabores.some(produto => !produto)) {
    throw criarErroPizza(
      "Um dos sabores escolhidos não está mais disponível.",
      "PIZZA_SABOR_INDISPONIVEL",
    );
  }

  const categoriaId = String(sabores[0].categoriaId?._id || sabores[0].categoriaId || "");
  const mesmaCategoria = sabores.every(produto =>
    String(produto.categoriaId?._id || produto.categoriaId || "") === categoriaId,
  );
  if (!categoriaId || !mesmaCategoria) {
    throw criarErroPizza("Os dois sabores devem pertencer à mesma categoria de pizzas.");
  }

  const categoria = categoriasMap.get(categoriaId);
  if (!categoriaPermitePizzaMeioAMeio(categoria)) {
    throw criarErroPizza(
      "A categoria escolhida não permite pizza meio a meio.",
      "PIZZA_MEIO_A_MEIO_NAO_PERMITIDA",
    );
  }

  const regraPrecoPizza = regraPrecoCategoria(categoria);
  const precosSaboresCentavos = sabores.map(produto => dinheiroParaCentavos(produto.preco));
  const precoBaseCentavos = regraPrecoPizza === REGRAS_PRECO_PIZZA.MAIOR_PRECO_CATEGORIA
    ? calcularMaiorPrecoCategoriaCentavos(produtosPorCategoria.get(categoriaId) || [])
    : Math.max(...precosSaboresCentavos);

  const custoUnitarioSnapshot = sabores.reduce(
    (total, produto) => total + Number(produto.custo || 0) / 2,
    0,
  );

  const saboresPizza = sabores.map((produto, index) => ({
    produtoId: produto._id,
    nome: String(produto.nome || "Sabor").slice(0, 160),
    preco: centavosParaDinheiro(precosSaboresCentavos[index]),
    fracao: 0.5,
  }));

  return {
    produtoPrincipal: sabores[0],
    categoria,
    sabores,
    saboresPizza,
    regraPrecoPizza,
    precoBaseCentavos,
    precoBase: centavosParaDinheiro(precoBaseCentavos),
    nome: `Pizza 1/2 ${saboresPizza[0].nome} + 1/2 ${saboresPizza[1].nome}`.slice(0, 160),
    custoUnitarioSnapshot: Number(custoUnitarioSnapshot.toFixed(4)),
    fichaTecnicaSnapshot: mesclarFichaTecnicaMetade(sabores),
  };
}

module.exports = {
  REGRAS_PRECO_PIZZA,
  categoriaPermitePizzaMeioAMeio,
  centavosParaDinheiro,
  criarErroPizza,
  dinheiroParaCentavos,
  montarPizzaMeioAMeio,
  normalizarIdsSabores,
  regraPrecoCategoria,
};
