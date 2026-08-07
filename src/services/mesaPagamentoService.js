"use strict";

const FORMAS_PAGAMENTO_MESA = Object.freeze([
  "dinheiro",
  "pix",
  "cartao",
]);

const FORMAS_PAGAMENTO_CATALOGO = Object.freeze([
  "dinheiro",
  "pix_online",
  "cartao",
]);

const FORMAS_PAGAMENTO_REGISTRAVEIS = new Set([
  ...FORMAS_PAGAMENTO_MESA,
  "pix_online",
  "nao_informado",
]);

const FORMA_PAGAMENTO_COMBINADO = "combinado";

function erroPagamentoMesa(message, code = "MESA_PAYMENT_VALIDATION") {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 422;
  return error;
}

function totalParaCentavos(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw erroPagamentoMesa("O total da conta é inválido.");
  }

  const cents = Math.round(number * 100);
  if (!Number.isSafeInteger(cents)) {
    throw erroPagamentoMesa("O total da conta ultrapassa o limite permitido.");
  }
  return cents;
}

function valorMonetarioParaCentavos(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw erroPagamentoMesa("Informe um valor de pagamento válido.");
    }
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents)) {
      throw erroPagamentoMesa("O valor do pagamento ultrapassa o limite permitido.");
    }
    return cents;
  }

  let text = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^R\$/i, "");

  if (!text) {
    throw erroPagamentoMesa("Informe o valor do primeiro pagamento.");
  }

  let normalized = "";
  if (/^\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/.test(text)) {
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+(?:,\d{1,2})?$/.test(text)) {
    normalized = text.replace(",", ".");
  } else if (/^\d+(?:\.\d{1,2})?$/.test(text)) {
    normalized = text;
  } else {
    throw erroPagamentoMesa("Informe o valor usando até duas casas decimais.");
  }

  const number = Number(normalized);
  const cents = Math.round(number * 100);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(cents)) {
    throw erroPagamentoMesa("Informe um valor de pagamento válido.");
  }
  return cents;
}

function normalizarFormaMesa(value, fieldLabel = "forma de pagamento") {
  const method = String(value || "").trim().toLowerCase();
  if (!FORMAS_PAGAMENTO_MESA.includes(method)) {
    throw erroPagamentoMesa(`Selecione uma ${fieldLabel} válida.`);
  }
  return method;
}

function normalizarFormaCatalogo(
  value,
  fieldLabel = "forma de pagamento",
  { pixDisponivel = true } = {},
) {
  const raw = String(value || "").trim().toLowerCase();
  const method = raw === "pix" ? "pix_online" : raw;

  if (!FORMAS_PAGAMENTO_CATALOGO.includes(method)) {
    throw erroPagamentoMesa(
      `Selecione uma ${fieldLabel} válida.`,
      "PUBLIC_PAYMENT_VALIDATION",
    );
  }

  if (method === "pix_online" && !pixDisponivel) {
    throw erroPagamentoMesa(
      "O Pix online está indisponível para este estabelecimento.",
      "PUBLIC_PAYMENT_VALIDATION",
    );
  }

  return method;
}

function montarPlanoCombinado({
  body,
  totalCentavos,
  normalizarForma,
  code = "MESA_PAYMENT_VALIDATION",
}) {
  if (totalCentavos <= 1) {
    throw erroPagamentoMesa(
      "A conta precisa ter valor suficiente para ser dividida em dois pagamentos.",
      code,
    );
  }

  const firstMethod = normalizarForma(
    body.formaPagamento1,
    "primeira forma de pagamento",
  );
  const secondMethod = normalizarForma(
    body.formaPagamento2,
    "segunda forma de pagamento",
  );

  if (firstMethod === secondMethod) {
    throw erroPagamentoMesa("Escolha dois meios de pagamento diferentes.", code);
  }

  const firstValueCents = valorMonetarioParaCentavos(body.valorPagamento1);
  const secondValueCents = totalCentavos - firstValueCents;

  if (firstValueCents <= 0 || secondValueCents <= 0) {
    throw erroPagamentoMesa(
      "Os dois pagamentos precisam possuir valor maior que zero.",
      code,
    );
  }

  if (body.valorPagamento2 !== undefined && String(body.valorPagamento2).trim()) {
    const submittedSecondValue = valorMonetarioParaCentavos(body.valorPagamento2);
    if (submittedSecondValue !== secondValueCents) {
      throw erroPagamentoMesa(
        "Os valores informados não correspondem ao total atual da conta.",
        code,
      );
    }
  }

  return {
    formaPagamento: FORMA_PAGAMENTO_COMBINADO,
    pagamentos: [
      {
        formaPagamento: firstMethod,
        valorCentavos: firstValueCents,
      },
      {
        formaPagamento: secondMethod,
        valorCentavos: secondValueCents,
      },
    ],
  };
}

function montarPlanoPagamentoMesa(body = {}, totalContaCentavos) {
  if (!Number.isSafeInteger(totalContaCentavos) || totalContaCentavos < 0) {
    throw erroPagamentoMesa("O total da conta é inválido.");
  }

  const mode = String(body.formaPagamento || "nao_informado")
    .trim()
    .toLowerCase();

  if (mode !== FORMA_PAGAMENTO_COMBINADO) {
    const method = mode === "nao_informado"
      ? "nao_informado"
      : normalizarFormaMesa(mode);

    return {
      formaPagamento: method,
      pagamentos: [{
        formaPagamento: method,
        valorCentavos: totalContaCentavos,
      }],
    };
  }

  return montarPlanoCombinado({
    body,
    totalCentavos: totalContaCentavos,
    normalizarForma: normalizarFormaMesa,
  });
}

function montarPlanoPagamentoCatalogo(
  body = {},
  totalPedidoCentavos,
  { pixDisponivel = true } = {},
) {
  if (!Number.isSafeInteger(totalPedidoCentavos) || totalPedidoCentavos < 0) {
    throw erroPagamentoMesa(
      "O total do pedido é inválido.",
      "PUBLIC_PAYMENT_VALIDATION",
    );
  }

  const mode = String(body.formaPagamento || "nao_informado")
    .trim()
    .toLowerCase();

  const normalizar = (value, label) => normalizarFormaCatalogo(
    value,
    label,
    { pixDisponivel },
  );

  if (mode !== FORMA_PAGAMENTO_COMBINADO) {
    const method = normalizar(mode);
    return {
      formaPagamento: method,
      pagamentos: [{
        formaPagamento: method,
        valorCentavos: totalPedidoCentavos,
      }],
    };
  }

  return montarPlanoCombinado({
    body,
    totalCentavos: totalPedidoCentavos,
    normalizarForma: normalizar,
    code: "PUBLIC_PAYMENT_VALIDATION",
  });
}

function normalizarPagamentosPedido({
  formaPagamento,
  pagamentos,
  totalCentavos,
}) {
  if (!Number.isSafeInteger(totalCentavos) || totalCentavos < 0) {
    throw erroPagamentoMesa("O total do pedido é inválido.");
  }

  if (!Array.isArray(pagamentos) || pagamentos.length === 0) {
    const method = String(formaPagamento || "nao_informado")
      .trim()
      .toLowerCase();
    if (!FORMAS_PAGAMENTO_REGISTRAVEIS.has(method)) {
      throw erroPagamentoMesa("A forma de pagamento do pedido é inválida.");
    }
    return {
      formaPagamento: method,
      pagamentos: [{ formaPagamento: method, valorCentavos: totalCentavos }],
    };
  }

  if (pagamentos.length > 2) {
    throw erroPagamentoMesa("Um pedido aceita no máximo dois meios de pagamento.");
  }

  const normalized = pagamentos.map(item => {
    const method = String(item?.formaPagamento || "")
      .trim()
      .toLowerCase();
    const valueCents = Number(item?.valorCentavos);
    if (!FORMAS_PAGAMENTO_REGISTRAVEIS.has(method)) {
      throw erroPagamentoMesa("A forma de pagamento do pedido é inválida.");
    }
    if (!Number.isSafeInteger(valueCents) || valueCents < 0) {
      throw erroPagamentoMesa("O valor de um pagamento do pedido é inválido.");
    }
    return { formaPagamento: method, valorCentavos: valueCents };
  }).filter(item => item.valorCentavos > 0 || totalCentavos === 0);

  const methods = new Set(normalized.map(item => item.formaPagamento));
  if (methods.size !== normalized.length) {
    throw erroPagamentoMesa("Não repita o mesmo meio de pagamento.");
  }

  const sum = normalized.reduce((acc, item) => acc + item.valorCentavos, 0);
  if (sum !== totalCentavos) {
    throw erroPagamentoMesa("Os pagamentos do pedido não fecham com o total.");
  }

  return {
    formaPagamento: normalized.length > 1
      ? FORMA_PAGAMENTO_COMBINADO
      : (normalized[0]?.formaPagamento || "nao_informado"),
    pagamentos: normalized,
  };
}

function pagamentosPlanejadosPedido(pedido = {}) {
  const totalCentavos = totalParaCentavos(pedido.total || 0);
  if (Array.isArray(pedido.pagamentos) && pedido.pagamentos.length) {
    return normalizarPagamentosPedido({
      formaPagamento: pedido.formaPagamento,
      pagamentos: pedido.pagamentos,
      totalCentavos,
    }).pagamentos;
  }

  const method = String(pedido.formaPagamento || "nao_informado")
    .trim()
    .toLowerCase();
  return [{
    formaPagamento: method === "pix" ? "pix_online" : method,
    valorCentavos: totalCentavos,
  }];
}

function valorFormaPagamentoCentavos(pedido = {}, formas = []) {
  const accepted = new Set(
    ([]).concat(formas).map(item => String(item || "").trim().toLowerCase()),
  );
  return pagamentosPlanejadosPedido(pedido).reduce(
    (sum, item) => accepted.has(item.formaPagamento)
      ? sum + item.valorCentavos
      : sum,
    0,
  );
}

function pedidoTemPixOnline(pedido = {}) {
  return valorFormaPagamentoCentavos(pedido, ["pix", "pix_online"]) > 0;
}

function valorPixOnlinePedidoCentavos(pedido = {}) {
  return valorFormaPagamentoCentavos(pedido, ["pix", "pix_online"]);
}

function distribuirPagamentosPorPedidos(pedidos = [], pagamentos = []) {
  const queue = pagamentos.map(item => ({
    formaPagamento: String(item.formaPagamento || ""),
    restanteCentavos: Number(item.valorCentavos),
  }));

  const totalPayments = queue.reduce((acc, item) => {
    if (!FORMAS_PAGAMENTO_REGISTRAVEIS.has(item.formaPagamento)
      || !Number.isSafeInteger(item.restanteCentavos)
      || item.restanteCentavos < 0) {
      throw erroPagamentoMesa("O plano de pagamento da conta é inválido.");
    }
    return acc + item.restanteCentavos;
  }, 0);

  const orders = [...pedidos].sort((left, right) => {
    const leftDate = new Date(left?.createdAt || 0).getTime() || 0;
    const rightDate = new Date(right?.createdAt || 0).getTime() || 0;
    if (leftDate !== rightDate) return leftDate - rightDate;
    return String(left?._id || "").localeCompare(String(right?._id || ""));
  });

  const totalOrders = orders.reduce(
    (acc, order) => acc + totalParaCentavos(order?.total || 0),
    0,
  );

  if (totalOrders !== totalPayments) {
    throw erroPagamentoMesa(
      "O plano de pagamento não corresponde ao total atual dos pedidos da mesa.",
    );
  }

  let paymentIndex = 0;
  const result = orders.map(order => {
    let pendingOrderCents = totalParaCentavos(order?.total || 0);
    const orderPayments = [];

    while (pendingOrderCents > 0) {
      const current = queue[paymentIndex];
      if (!current) {
        throw erroPagamentoMesa("Não foi possível distribuir o pagamento da conta.");
      }
      if (current.restanteCentavos === 0) {
        paymentIndex += 1;
        continue;
      }

      const usedCents = Math.min(
        pendingOrderCents,
        current.restanteCentavos,
      );
      orderPayments.push({
        formaPagamento: current.formaPagamento,
        valorCentavos: usedCents,
      });
      pendingOrderCents -= usedCents;
      current.restanteCentavos -= usedCents;
      if (current.restanteCentavos === 0) paymentIndex += 1;
    }

    const normalized = normalizarPagamentosPedido({
      pagamentos: orderPayments,
      totalCentavos: totalParaCentavos(order?.total || 0),
    });

    return {
      pedido: order,
      formaPagamento: normalized.formaPagamento,
      pagamentos: normalized.pagamentos,
    };
  });

  if (queue.some(item => item.restanteCentavos !== 0)) {
    throw erroPagamentoMesa("Restou valor sem vínculo com os pedidos da mesa.");
  }

  return result;
}

module.exports = {
  FORMAS_PAGAMENTO_CATALOGO,
  FORMAS_PAGAMENTO_MESA,
  FORMA_PAGAMENTO_COMBINADO,
  distribuirPagamentosPorPedidos,
  montarPlanoPagamentoCatalogo,
  montarPlanoPagamentoMesa,
  normalizarPagamentosPedido,
  pagamentosPlanejadosPedido,
  pedidoTemPixOnline,
  totalParaCentavos,
  valorFormaPagamentoCentavos,
  valorMonetarioParaCentavos,
  valorPixOnlinePedidoCentavos,
};
