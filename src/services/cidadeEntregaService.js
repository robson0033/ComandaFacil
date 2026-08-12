"use strict";

const UFS_BRASIL = Object.freeze([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO",
  "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI",
  "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

const UFS_BRASIL_SET = new Set(UFS_BRASIL);
const TAXA_ENTREGA_MAXIMA_CENTAVOS = 50_000;
const PEDIDO_MINIMO_MAXIMO_CENTAVOS = 1_000_000;
const NOME_CIDADE_MAXIMO = 120;
const MODOS_ABAIXO_MINIMO = new Set(["bloquear", "taxa_especial"]);

function criarErroValidacao(message, code = "CIDADE_ENTREGA_INVALIDA") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function limparNomeCidade(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizarNomeCidadeEntrega(value) {
  return limparNomeCidade(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function validarNomeCidadeEntrega(value) {
  const nome = limparNomeCidade(value);

  if (nome.length < 2 || nome.length > NOME_CIDADE_MAXIMO) {
    throw criarErroValidacao(
      `Informe uma cidade com 2 a ${NOME_CIDADE_MAXIMO} caracteres.`,
    );
  }

  if (/[\u0000-\u001f\u007f]/.test(nome)) {
    throw criarErroValidacao("O nome da cidade contém caracteres inválidos.");
  }

  return nome;
}

function normalizarUf(value) {
  const uf = String(value || "").trim().toUpperCase();

  if (!UFS_BRASIL_SET.has(uf)) {
    throw criarErroValidacao("Selecione uma UF válida.");
  }

  return uf;
}

function limparValorMonetario(value) {
  return String(value ?? "")
    .trim()
    .replace(/^R\$\s*/i, "")
    .replace(/\s+/g, "");
}

function converterTaxaEntregaParaCentavos(value) {
  const raw = limparValorMonetario(value);

  if (!/^\d{1,3}(?:[.,]\d{1,2})?$/.test(raw)) {
    throw criarErroValidacao(
      "Informe uma taxa válida entre R$ 0,00 e R$ 500,00.",
    );
  }

  const valor = Number(raw.replace(",", "."));
  const centavos = Math.round(valor * 100);

  if (
    !Number.isSafeInteger(centavos)
    || centavos < 0
    || centavos > TAXA_ENTREGA_MAXIMA_CENTAVOS
  ) {
    throw criarErroValidacao(
      "Informe uma taxa válida entre R$ 0,00 e R$ 500,00.",
    );
  }

  return centavos;
}

function converterPedidoMinimoParaCentavos(value) {
  const raw = limparValorMonetario(value || "0");

  if (!/^\d{1,5}(?:[.,]\d{1,2})?$/.test(raw)) {
    throw criarErroValidacao(
      "Informe um pedido mínimo válido entre R$ 0,00 e R$ 10.000,00.",
    );
  }

  const valor = Number(raw.replace(",", "."));
  const centavos = Math.round(valor * 100);

  if (
    !Number.isSafeInteger(centavos)
    || centavos < 0
    || centavos > PEDIDO_MINIMO_MAXIMO_CENTAVOS
  ) {
    throw criarErroValidacao(
      "Informe um pedido mínimo válido entre R$ 0,00 e R$ 10.000,00.",
    );
  }

  return centavos;
}

function normalizarModoAbaixoMinimo(value) {
  const modo = String(value || "bloquear").trim().toLowerCase();
  if (!MODOS_ABAIXO_MINIMO.has(modo)) {
    throw criarErroValidacao("Selecione uma regra válida para pedidos abaixo do mínimo.");
  }
  return modo;
}

function validarTaxaEntregaCentavos(value) {
  const centavos = Number(value);

  if (
    !Number.isSafeInteger(centavos)
    || centavos < 0
    || centavos > TAXA_ENTREGA_MAXIMA_CENTAVOS
  ) {
    throw criarErroValidacao(
      "A taxa de entrega configurada é inválida.",
      "TAXA_ENTREGA_CONFIGURACAO_INVALIDA",
    );
  }

  return centavos;
}

function validarPedidoMinimoCentavos(value) {
  const centavos = Number(value || 0);
  if (
    !Number.isSafeInteger(centavos)
    || centavos < 0
    || centavos > PEDIDO_MINIMO_MAXIMO_CENTAVOS
  ) {
    throw criarErroValidacao(
      "O pedido mínimo configurado é inválido.",
      "PEDIDO_MINIMO_CONFIGURACAO_INVALIDO",
    );
  }
  return centavos;
}

function converterValorReaisParaCentavos(value) {
  const valor = Number(value);

  if (!Number.isFinite(valor) || valor < 0) {
    throw criarErroValidacao(
      "O subtotal do pedido é inválido.",
      "SUBTOTAL_PEDIDO_INVALIDO",
    );
  }

  const centavos = Math.round((valor + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(centavos)) {
    throw criarErroValidacao(
      "O subtotal do pedido é inválido.",
      "SUBTOTAL_PEDIDO_INVALIDO",
    );
  }

  return centavos;
}

function calcularTotaisPedidoComEntrega({
  subtotalProdutos,
  taxaEntregaCentavos = 0,
} = {}) {
  const subtotalCentavos = converterValorReaisParaCentavos(subtotalProdutos);
  const taxaCentavos = validarTaxaEntregaCentavos(taxaEntregaCentavos);
  const totalCentavos = subtotalCentavos + taxaCentavos;

  if (!Number.isSafeInteger(totalCentavos)) {
    throw criarErroValidacao(
      "O total do pedido é inválido.",
      "TOTAL_PEDIDO_INVALIDO",
    );
  }

  return {
    subtotalProdutos: subtotalCentavos / 100,
    taxaEntregaCentavos: taxaCentavos,
    taxaEntrega: taxaCentavos / 100,
    total: totalCentavos / 100,
  };
}

function avaliarRegraEntregaCidade({ subtotalProdutos, cidade } = {}) {
  const subtotalCentavos = converterValorReaisParaCentavos(subtotalProdutos);
  const taxaNormalCentavos = validarTaxaEntregaCentavos(cidade?.taxaCentavos ?? 0);
  const pedidoMinimoCentavos = validarPedidoMinimoCentavos(
    cidade?.pedidoMinimoCentavos ?? 0,
  );
  const abaixoMinimoModo = normalizarModoAbaixoMinimo(
    cidade?.abaixoMinimoModo || "bloquear",
  );

  if (pedidoMinimoCentavos <= 0 || subtotalCentavos >= pedidoMinimoCentavos) {
    return {
      permitido: true,
      abaixoDoMinimo: false,
      regra: "normal",
      subtotalCentavos,
      pedidoMinimoCentavos,
      faltamCentavos: 0,
      taxaEntregaCentavos: taxaNormalCentavos,
      taxaNormalCentavos,
      taxaAbaixoMinimoCentavos: Number(cidade?.taxaAbaixoMinimoCentavos || 0),
      abaixoMinimoModo,
    };
  }

  const faltamCentavos = pedidoMinimoCentavos - subtotalCentavos;

  if (abaixoMinimoModo === "taxa_especial") {
    const taxaEspecialCentavos = validarTaxaEntregaCentavos(
      cidade?.taxaAbaixoMinimoCentavos ?? 0,
    );
    return {
      permitido: true,
      abaixoDoMinimo: true,
      regra: "taxa_especial",
      subtotalCentavos,
      pedidoMinimoCentavos,
      faltamCentavos,
      taxaEntregaCentavos: taxaEspecialCentavos,
      taxaNormalCentavos,
      taxaAbaixoMinimoCentavos: taxaEspecialCentavos,
      abaixoMinimoModo,
    };
  }

  return {
    permitido: false,
    abaixoDoMinimo: true,
    regra: "bloquear",
    subtotalCentavos,
    pedidoMinimoCentavos,
    faltamCentavos,
    taxaEntregaCentavos: taxaNormalCentavos,
    taxaNormalCentavos,
    taxaAbaixoMinimoCentavos: Number(cidade?.taxaAbaixoMinimoCentavos || 0),
    abaixoMinimoModo,
  };
}

function montarDadosCidadeEntrega(input = {}) {
  const nome = validarNomeCidadeEntrega(input.nome);
  const pedidoMinimoCentavos = converterPedidoMinimoParaCentavos(
    input.pedidoMinimo ?? "0",
  );
  const abaixoMinimoModo = normalizarModoAbaixoMinimo(input.abaixoMinimoModo);
  let taxaAbaixoMinimoCentavos = 0;

  if (pedidoMinimoCentavos > 0 && abaixoMinimoModo === "taxa_especial") {
    if (String(input.taxaAbaixoMinimo ?? "").trim() === "") {
      throw criarErroValidacao(
        "Informe a taxa especial cobrada quando o pedido ficar abaixo do mínimo.",
      );
    }
    taxaAbaixoMinimoCentavos = converterTaxaEntregaParaCentavos(
      input.taxaAbaixoMinimo,
    );
  }

  return {
    nome,
    nomeNormalizado: normalizarNomeCidadeEntrega(nome),
    uf: normalizarUf(input.uf),
    taxaCentavos: converterTaxaEntregaParaCentavos(input.taxa),
    pedidoMinimoCentavos,
    abaixoMinimoModo,
    taxaAbaixoMinimoCentavos,
  };
}

module.exports = {
  NOME_CIDADE_MAXIMO,
  PEDIDO_MINIMO_MAXIMO_CENTAVOS,
  TAXA_ENTREGA_MAXIMA_CENTAVOS,
  UFS_BRASIL,
  avaliarRegraEntregaCidade,
  calcularTotaisPedidoComEntrega,
  converterPedidoMinimoParaCentavos,
  converterTaxaEntregaParaCentavos,
  converterValorReaisParaCentavos,
  montarDadosCidadeEntrega,
  normalizarModoAbaixoMinimo,
  normalizarNomeCidadeEntrega,
  normalizarUf,
  validarNomeCidadeEntrega,
  validarPedidoMinimoCentavos,
  validarTaxaEntregaCentavos,
};
