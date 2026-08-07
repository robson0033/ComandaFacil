const { logger: appLogger } = require("../utils/logger");

/**
 * Ajuste do backend para os filtros dos relatórios do ComandaMix.
 *
 * Cole as funções abaixo no seu adminController.js e adapte apenas
 * os imports dos seus models.
 *
 * O campo esperado no Pedido é:
 *   canal: 'delivery' | 'mesa' | 'retirada'
 *
 * Caso seu banco use outros nomes, altere normalizarCanal().
 */

function normalizarCanal(valor) {
  const canal = String(valor || 'todos')
    .trim()
    .toLowerCase();

  const canaisPermitidos = [
    'todos',
    'delivery',
    'mesa',
    'retirada'
  ];

  return canaisPermitidos.includes(canal)
    ? canal
    : 'todos';
}

function inicioDoDia(data) {
  const resultado = new Date(data);
  resultado.setHours(0, 0, 0, 0);
  return resultado;
}

function fimDoDia(data) {
  const resultado = new Date(data);
  resultado.setHours(23, 59, 59, 999);
  return resultado;
}

function criarIntervaloRelatorio({
  filtro,
  dataInicio,
  dataFim
}) {
  const agora = new Date();
  const filtroAtual = String(filtro || 'hoje');

  if (
    filtroAtual === 'personalizado' &&
    dataInicio &&
    dataFim
  ) {
    const inicio = inicioDoDia(
      new Date(`${dataInicio}T00:00:00`)
    );

    const fim = fimDoDia(
      new Date(`${dataFim}T00:00:00`)
    );

    if (
      Number.isNaN(inicio.getTime()) ||
      Number.isNaN(fim.getTime()) ||
      inicio > fim
    ) {
      throw new Error(
        'O período informado é inválido.'
      );
    }

    return {
      inicio,
      fim,
      filtroAtual: 'personalizado',
      dataInicio,
      dataFim
    };
  }

  if (filtroAtual === 'todos') {
    return {
      inicio: null,
      fim: null,
      filtroAtual: 'todos',
      dataInicio: '',
      dataFim: ''
    };
  }

  if (filtroAtual === 'semana') {
    const inicio = inicioDoDia(agora);
    const diaSemana = inicio.getDay();
    const diferenca = diaSemana === 0
      ? 6
      : diaSemana - 1;

    inicio.setDate(inicio.getDate() - diferenca);

    return {
      inicio,
      fim: fimDoDia(agora),
      filtroAtual: 'semana',
      dataInicio: '',
      dataFim: ''
    };
  }

  if (filtroAtual === 'mes') {
    return {
      inicio: new Date(
        agora.getFullYear(),
        agora.getMonth(),
        1,
        0,
        0,
        0,
        0
      ),
      fim: fimDoDia(agora),
      filtroAtual: 'mes',
      dataInicio: '',
      dataFim: ''
    };
  }

  if (filtroAtual === 'ano') {
    return {
      inicio: new Date(
        agora.getFullYear(),
        0,
        1,
        0,
        0,
        0,
        0
      ),
      fim: fimDoDia(agora),
      filtroAtual: 'ano',
      dataInicio: '',
      dataFim: ''
    };
  }

  return {
    inicio: inicioDoDia(agora),
    fim: fimDoDia(agora),
    filtroAtual: 'hoje',
    dataInicio: '',
    dataFim: ''
  };
}

function criarFiltroMongoRelatorio({
  userId,
  filtro,
  canal,
  dataInicio,
  dataFim
}) {
  const periodo = criarIntervaloRelatorio({
    filtro,
    dataInicio,
    dataFim
  });

  const canalAtual = normalizarCanal(canal);

  const consulta = {
    userId,
    excluido: { $ne: true },
    status: {
      $in: [
        'finalizado',
        'entregue',
        'pronto'
      ]
    }
  };

  if (periodo.inicio && periodo.fim) {
    consulta.createdAt = {
      $gte: periodo.inicio,
      $lte: periodo.fim
    };
  }

  if (canalAtual !== 'todos') {
    consulta.canal = canalAtual;
  }

  return {
    consulta,
    canalAtual,
    ...periodo
  };
}

/**
 * Exemplo de uso dentro de exports.admin.
 *
 * Substitua Pedido pelo seu model real e mantenha o restante
 * dos dados que seu controller já envia para a view.
 */
async function montarRelatorios({
  Pedido,
  userId,
  query
}) {
  const filtros = criarFiltroMongoRelatorio({
    userId,
    filtro: query.filtro,
    canal: query.canal,
    dataInicio: query.dataInicio,
    dataFim: query.dataFim
  });

  const historico = await Pedido.find(
    filtros.consulta
  )
    .sort({ createdAt: -1 })
    .lean();

  const faturamento = historico.reduce(
    (total, pedido) =>
      total + Number(pedido.total || 0),
    0
  );

  const custo = historico.reduce(
    (total, pedido) =>
      total + Number(pedido.custo || 0),
    0
  );

  const lucro = faturamento - custo;

  const produtos = new Map();

  for (const pedido of historico) {
    for (const item of pedido.itens || []) {
      const nome =
        item.nome ||
        item.produtoNome ||
        'Produto';

      const quantidade = Number(
        item.quantidade || 0
      );

      const subtotal = Number(
        item.subtotal ??
        item.total ??
        (
          Number(item.preco || 0) *
          quantidade
        )
      );

      const atual = produtos.get(nome) || {
        nome,
        quantidade: 0,
        total: 0
      };

      atual.quantidade += quantidade;
      atual.total += subtotal;

      produtos.set(nome, atual);
    }
  }

  const ranking = [...produtos.values()]
    .sort(
      (a, b) =>
        b.quantidade - a.quantidade
    );

  const graficoPorDia = new Map();

  for (const pedido of historico) {
    const data = new Date(pedido.createdAt);

    const chave = data.toLocaleDateString(
      'pt-BR',
      {
        day: '2-digit',
        month: '2-digit'
      }
    );

    graficoPorDia.set(
      chave,
      (
        graficoPorDia.get(chave) || 0
      ) + Number(pedido.total || 0)
    );
  }

  const labels = [
    ...graficoPorDia.keys()
  ].reverse();

  const valores = labels.map(
    label => graficoPorDia.get(label)
  );

  return {
    faturamento,
    custo,
    lucro,
    totalPedidos: historico.length,
    filtroAtual: filtros.filtroAtual,
    canalAtual: filtros.canalAtual,
    dataInicio: filtros.dataInicio,
    dataFim: filtros.dataFim,
    grafico: {
      labels,
      valores,
      maiorValor: Math.max(
        0,
        ...valores
      )
    },
    maisVendidos: ranking.slice(0, 5),
    menosVendidos: [...ranking]
      .reverse()
      .slice(0, 5),
    historico
  };
}

module.exports = {
  normalizarCanal,
  criarIntervaloRelatorio,
  criarFiltroMongoRelatorio,
  montarRelatorios
};

/*
Exemplo dentro do seu controller:

const Pedido = require('../models/Pedido');
const {
  montarRelatorios
} = require('./relatoriosFiltro');
const { safeFlash } = require('../utils/safeFlash');

exports.admin = async (req, res) => {
  try {
    const userId =
      req.session.user._id ||
      req.session.user.id;

    const relatorios = await montarRelatorios({
      Pedido,
      userId,
      query: req.query
    });

    // Busque aqui dashboard, produtos, mesas etc.
    res.render('admin', {
      relatorios,
      // restante das variáveis...
    });
  } catch (erro) {
    appLogger.error(erro);

    safeFlash(
      req,
      'errors',
      erro.message ||
      'Não foi possível gerar os relatórios.'
    );

    return res.redirect('/admin#relatorios');
  }
};
*/
