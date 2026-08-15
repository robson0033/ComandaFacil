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

function idsCategoriasMeioAMeio(categoria = {}) {
  return [
    ...new Set(
      (Array.isArray(categoria.configuracaoPizza?.categoriasMeioAMeio)
        ? categoria.configuracaoPizza.categoriasMeioAMeio
        : [])
        .map(item => String(item?._id || item || "").trim())
        .filter(Boolean),
    ),
  ];
}

function categoriasCompativeisMeioAMeio(categoriaBase = {}, categoriaOutra = {}) {
  const categoriaBaseId = String(categoriaBase?._id || "");
  const categoriaOutraId = String(categoriaOutra?._id || "");
  if (!categoriaBaseId || !categoriaOutraId) return false;
  if (categoriaBaseId === categoriaOutraId) return true;
  if (String(categoriaOutra.tipo || "") !== "catalogo") return false;
  if (String(categoriaOutra.tipoProduto || "normal") !== "pizza") return false;
  return idsCategoriasMeioAMeio(categoriaBase).includes(categoriaOutraId);
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

function tamanhosPizzaCategoria(categoria = {}) {
  return (Array.isArray(categoria.configuracaoPizza?.tamanhos)
    ? categoria.configuracaoPizza.tamanhos
    : [])
    .filter(tamanho => tamanho?.ativo !== false && tamanho?._id && String(tamanho.nome || "").trim())
    .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));
}

function normalizarNomeTamanhoPizza(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function resolverTamanhoPizza(categoria = {}, itemRecebido = {}) {
  const tamanhos = tamanhosPizzaCategoria(categoria);
  if (!tamanhos.length) return null;

  const tamanhoId = String(
    itemRecebido.tamanhoPizzaId
      || itemRecebido.tamanhoId
      || itemRecebido.tamanhoPizza?._id
      || itemRecebido.tamanhoPizza?.id
      || "",
  ).trim();

  const tamanho = tamanhos.find(item => String(item._id) === tamanhoId);
  if (!tamanho) {
    throw criarErroPizza(
      "Escolha um tamanho de pizza válido.",
      "PIZZA_TAMANHO_INVALIDO",
    );
  }
  return tamanho;
}

function resolverTamanhoEquivalentePizza(categoria = {}, tamanhoReferencia = null) {
  const tamanhos = tamanhosPizzaCategoria(categoria);
  if (!tamanhoReferencia) {
    if (tamanhos.length) {
      throw criarErroPizza(
        "As categorias combinadas precisam usar tamanhos compatíveis.",
        "PIZZA_TAMANHO_INCOMPATIVEL",
      );
    }
    return null;
  }
  const tamanhoId = String(tamanhoReferencia?._id || tamanhoReferencia?.id || "");
  const direto = tamanhos.find(item => String(item._id) === tamanhoId);
  if (direto) return direto;

  const nomeReferencia = normalizarNomeTamanhoPizza(tamanhoReferencia?.nome);
  const equivalente = nomeReferencia
    ? tamanhos.find(item => normalizarNomeTamanhoPizza(item.nome) === nomeReferencia)
    : null;

  if (!equivalente) {
    throw criarErroPizza(
      `O tamanho ${String(tamanhoReferencia?.nome || "selecionado")} não existe em uma das categorias combinadas.`,
      "PIZZA_TAMANHO_INCOMPATIVEL",
    );
  }
  return equivalente;
}

function precoProdutoPizzaCentavos(produto = {}, tamanho = null) {
  if (!tamanho) return dinheiroParaCentavos(produto.preco);
  const tamanhoId = String(tamanho._id || tamanho.id || "");
  const precoTamanho = (Array.isArray(produto.precosPizza) ? produto.precosPizza : [])
    .find(item => String(item?.tamanhoId || "") === tamanhoId);
  if (!precoTamanho) {
    throw criarErroPizza(
      `O tamanho ${String(tamanho.nome || "selecionado")} não possui preço para ${String(produto.nome || "esta pizza")}.`,
      "PIZZA_TAMANHO_SEM_PRECO",
    );
  }
  return dinheiroParaCentavos(precoTamanho.preco);
}

function resolverTamanhoEPrecoPizza({ itemRecebido, produto, categoria }) {
  if (String(categoria?.tipoProduto || "normal") !== "pizza") {
    return { tamanho: null, precoBase: Number(produto?.preco || 0) };
  }
  const tamanho = resolverTamanhoPizza(categoria, itemRecebido);
  return {
    tamanho,
    precoBase: centavosParaDinheiro(precoProdutoPizzaCentavos(produto, tamanho)),
  };
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

function calcularMaiorPrecoCategoriaCentavos(produtosCategoria = [], tamanho = null) {
  const precos = produtosCategoria.flatMap(produto => {
    try {
      return [precoProdutoPizzaCentavos(produto, tamanho)];
    } catch (error) {
      if (error?.code === "PIZZA_TAMANHO_SEM_PRECO") return [];
      throw error;
    }
  });
  if (!precos.length) {
    throw criarErroPizza(
      "Não foi possível calcular o maior preço da categoria de pizzas.",
      "PIZZA_CATEGORIA_SEM_PRECO",
    );
  }
  return Math.max(...precos);
}

function calcularMaiorPrecoCategoriasMeioAMeioCentavos({
  categoriaBase,
  categoriasMap,
  produtosPorCategoria,
  tamanhoBase,
}) {
  const categoriaBaseId = String(categoriaBase?._id || "");
  const idsCategorias = [categoriaBaseId, ...idsCategoriasMeioAMeio(categoriaBase)]
    .filter(Boolean);
  const precos = [];

  for (const categoriaId of idsCategorias) {
    const categoria = categoriasMap.get(categoriaId);
    if (!categoria) continue;

    let tamanhoCategoria = null;
    try {
      tamanhoCategoria = resolverTamanhoEquivalentePizza(categoria, tamanhoBase);
    } catch (error) {
      if (error?.code === "PIZZA_TAMANHO_INCOMPATIVEL") continue;
      throw error;
    }

    for (const produto of produtosPorCategoria.get(categoriaId) || []) {
      try {
        precos.push(precoProdutoPizzaCentavos(produto, tamanhoCategoria));
      } catch (error) {
        if (error?.code === "PIZZA_TAMANHO_SEM_PRECO") continue;
        throw error;
      }
    }
  }

  if (!precos.length) {
    throw criarErroPizza(
      "Não foi possível calcular o maior preço das categorias de pizzas combinadas.",
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

  const categoriasSabores = sabores.map(produto =>
    categoriasMap.get(String(produto.categoriaId?._id || produto.categoriaId || "")),
  );
  const categoria = categoriasSabores[0];
  const categoriaSegundoSabor = categoriasSabores[1];
  if (!categoria || !categoriaSegundoSabor) {
    throw criarErroPizza("A categoria de um dos sabores não está mais disponível.");
  }
  if (!categoriaPermitePizzaMeioAMeio(categoria)) {
    throw criarErroPizza(
      "A categoria escolhida não permite pizza meio a meio.",
      "PIZZA_MEIO_A_MEIO_NAO_PERMITIDA",
    );
  }
  if (!categoriasCompativeisMeioAMeio(categoria, categoriaSegundoSabor)) {
    throw criarErroPizza(
      "As categorias dos sabores escolhidos não estão configuradas para combinar entre si.",
      "PIZZA_CATEGORIAS_INCOMPATIVEIS",
    );
  }

  const regraPrecoPizza = regraPrecoCategoria(categoria);
  const tamanho = resolverTamanhoPizza(categoria, itemRecebido);
  const tamanhosSabores = categoriasSabores.map(categoriaSabor =>
    resolverTamanhoEquivalentePizza(categoriaSabor, tamanho),
  );
  const precosSaboresCentavos = sabores.map((produto, index) =>
    precoProdutoPizzaCentavos(produto, tamanhosSabores[index]),
  );
  const precoBaseCentavos = regraPrecoPizza === REGRAS_PRECO_PIZZA.MAIOR_PRECO_CATEGORIA
    ? calcularMaiorPrecoCategoriasMeioAMeioCentavos({
        categoriaBase: categoria,
        categoriasMap,
        produtosPorCategoria,
        tamanhoBase: tamanho,
      })
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
    nome: `Pizza 1/2 ${saboresPizza[0].nome} + 1/2 ${saboresPizza[1].nome}${tamanho ? ` (${String(tamanho.nome || "")})` : ""}`.slice(0, 160),
    tamanhoPizza: tamanho
      ? {
          tamanhoId: tamanho._id,
          nome: String(tamanho.nome || "").slice(0, 50),
        }
      : null,
    custoUnitarioSnapshot: Number(custoUnitarioSnapshot.toFixed(4)),
    fichaTecnicaSnapshot: mesclarFichaTecnicaMetade(sabores),
  };
}

module.exports = {
  REGRAS_PRECO_PIZZA,
  categoriaPermitePizzaMeioAMeio,
  categoriasCompativeisMeioAMeio,
  centavosParaDinheiro,
  criarErroPizza,
  dinheiroParaCentavos,
  idsCategoriasMeioAMeio,
  montarPizzaMeioAMeio,
  normalizarIdsSabores,
  normalizarNomeTamanhoPizza,
  precoProdutoPizzaCentavos,
  regraPrecoCategoria,
  resolverTamanhoEPrecoPizza,
  resolverTamanhoEquivalentePizza,
  resolverTamanhoPizza,
  tamanhosPizzaCategoria,
};
