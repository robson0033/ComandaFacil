const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const { registroModel } = require("../models/registroModel");

const {
  Assinatura,
  Categoria,
  Estoque,
  Produto,
  Mesa,
  Funcionario,
  Configuracao,
  Pedido,
  Avaliacao,
  PrintAgent,
} = require("../models/painelModels");

const printAgentHub = require("../services/printAgentHub");

/*
|--------------------------------------------------------------------------
| IMAGEM ARMAZENADA DIRETAMENTE NO MONGODB
|--------------------------------------------------------------------------
|
| O Multer entrega o arquivo em req.file.buffer.
| Este helper converte o Buffer em uma Data URL:
|
| data:image/png;base64,iVBORw0KGgo...
|
| Como os campos de imagem dos models já são String, não é
| necessário alterar os schemas atuais.
|
*/

function imagemParaDataUrl(file) {
  if (
    !file ||
    !file.buffer ||
    !file.mimetype
  ) {
    return "";
  }

  return [
    "data:",
    file.mimetype,
    ";base64,",
    file.buffer.toString("base64"),
  ].join("");
}



/*
|--------------------------------------------------------------------------
| FUNÇÕES AUXILIARES
|--------------------------------------------------------------------------
*/

function paraArray(valor) {
  if (Array.isArray(valor)) return valor;
  if (valor === undefined || valor === null || valor === "") return [];
  return [valor];
}

function unidadeBase(unidade) {
  const normalizada = String(unidade || "").trim().toLowerCase();
  if (["kg", "quilo", "quilos"].includes(normalizada)) return "kg";
  if (["g", "grama", "gramas"].includes(normalizada)) return "g";
  if (["l", "litro", "litros"].includes(normalizada)) return "l";
  if (["ml", "mililitro", "mililitros"].includes(normalizada)) return "ml";
  return "un";
}

function converterQuantidade(valor, origem, destino) {
  const quantidade = Number(valor || 0);
  const de = unidadeBase(origem);
  const para = unidadeBase(destino);
  if (de === para) return quantidade;
  if (de === "g" && para === "kg") return quantidade / 1000;
  if (de === "kg" && para === "g") return quantidade * 1000;
  if (de === "ml" && para === "l") return quantidade / 1000;
  if (de === "l" && para === "ml") return quantidade * 1000;
  return quantidade;
}

async function montarFichaTecnica(body, idEstabelecimento) {
  const ids = paraArray(body.fichaEstoqueId);
  const quantidades = paraArray(body.fichaQuantidade);
  const unidades = paraArray(body.fichaUnidade);

  const linhas = ids.map((id, indice) => ({
    estoqueId: String(id || "").trim(),
    quantidade: Number(quantidades[indice] || 0),
    unidade: unidadeBase(unidades[indice]),
  })).filter(linha => linha.estoqueId && linha.quantidade > 0);

  if (!linhas.length) return { fichaTecnica: [], custo: 0 };

  const itens = await Estoque.find({
    _id: { $in: linhas.map(linha => linha.estoqueId) },
    estabelecimentoId: idEstabelecimento,
  }).lean();
  const porId = new Map(itens.map(item => [String(item._id), item]));

  const fichaTecnica = linhas.map(linha => {
    const item = porId.get(linha.estoqueId);
    if (!item) return null;
    const quantidadeNaUnidadeDoEstoque = converterQuantidade(
      linha.quantidade,
      linha.unidade,
      item.unidade,
    );
    const custoCalculado = quantidadeNaUnidadeDoEstoque * Number(item.custoUnitario || 0);
    return {
      estoqueId: item._id,
      nome: item.nome,
      quantidade: linha.quantidade,
      unidade: linha.unidade,
      custoCalculado: Number(custoCalculado.toFixed(4)),
    };
  }).filter(Boolean);

  const custo = fichaTecnica.reduce(
    (total, ingrediente) => total + Number(ingrediente.custoCalculado || 0),
    0,
  );
  return { fichaTecnica, custo: Number(custo.toFixed(4)) };
}

function normalizarAdicionais(body = {}) {
  const nomes =
    Array.isArray(body.adicionaisNome)
      ? body.adicionaisNome
      : body.adicionaisNome
        ? [body.adicionaisNome]
        : [];

  const precos =
    Array.isArray(body.adicionaisPreco)
      ? body.adicionaisPreco
      : body.adicionaisPreco !== undefined
        ? [body.adicionaisPreco]
        : [];

  return nomes
    .map((nome, index) => ({
      nome: String(nome || "").trim(),
      preco: Math.max(
        0,
        Number(precos[index] || 0),
      ),
      ativo: true,
    }))
    .filter((adicional) => adicional.nome);
}

function normalizarImpressoras(body = {}) {
  const impressoras = [];

  for (let indice = 0; indice < 2; indice += 1) {
    const prefixo = `impressoras[${indice}]`;
    const grupo = Array.isArray(body.impressoras)
      ? (body.impressoras[indice] || {})
      : (body.impressoras?.[indice] || {});

    const campo = nome =>
      grupo[nome] !== undefined
        ? grupo[nome]
        : body[`${prefixo}[${nome}]`];

    const nome = String(
      campo("nome") || "",
    ).trim();

    const tipoConexao =
      campo("tipoConexao") === "rede"
        ? "rede"
        : "usb";

    const deviceName = String(
      campo("deviceName") || "",
    ).trim();

    const ip = String(
      campo("ip") || "",
    ).trim();

    const porta = Math.min(
      65535,
      Math.max(
        1,
        Number(campo("porta") || 9100),
      ),
    );

    const modoPermitido = [
      "desativada",
      "manual",
      "automatica",
      "manual_automatica",
    ];

    const modo = modoPermitido.includes(
      campo("modo"),
    )
      ? campo("modo")
      : "desativada";

    impressoras.push({
      nome:
        nome ||
        `Impressora ${indice + 1}`,
      tipoConexao,
      deviceName:
        tipoConexao === "usb"
          ? deviceName
          : "",
      ip:
        tipoConexao === "rede"
          ? ip
          : "",
      porta,
      papel:
        campo("papel") === "58mm"
          ? "58mm"
          : "80mm",
      modo,
      copias: Math.min(
        5,
        Math.max(
          1,
          Number(campo("copias") || 1),
        ),
      ),
      fontePx: Math.min(
        30,
        Math.max(
          8,
          Number(campo("fontePx") || 13),
        ),
      ),
      espacamentoLinhaPx: Math.min(
        30,
        Math.max(
          0,
          Number(
            campo("espacamentoLinhaPx") ||
              4,
          ),
        ),
      ),
      espacamentoLetrasPx: Math.min(
        10,
        Math.max(
          0,
          Number(
            campo("espacamentoLetrasPx") ||
              0,
          ),
        ),
      ),
      margemSuperiorMm: Math.min(
        30,
        Math.max(
          0,
          Number(
            campo("margemSuperiorMm") ||
              2,
          ),
        ),
      ),
      margemInferiorMm: Math.min(
        80,
        Math.max(
          0,
          Number(
            campo("margemInferiorMm") ||
              5,
          ),
        ),
      ),
      margemEsquerdaMm: Math.min(
        20,
        Math.max(
          0,
          Number(
            campo("margemEsquerdaMm") ||
              2,
          ),
        ),
      ),
      margemDireitaMm: Math.min(
        20,
        Math.max(
          0,
          Number(
            campo("margemDireitaMm") ||
              2,
          ),
        ),
      ),
      alturaMaximaMm: Math.min(
        3000,
        Math.max(
          100,
          Number(
            campo("alturaMaximaMm") ||
              500,
          ),
        ),
      ),
      imprimirLogo:
        campo("imprimirLogo") === "on",
      imprimirValores:
        campo("imprimirValores") === "on",
      imprimirEndereco:
        campo("imprimirEndereco") === "on",
      imprimirCpfCnpj:
        campo("imprimirCpfCnpj") === "on",
      imprimirObservacoes:
        campo("imprimirObservacoes") === "on",
      corteAutomatico:
        campo("corteAutomatico") === "on",
    });
  }

  return impressoras;
}

function slugify(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function estabelecimentoId(req) {
  return (
    req.session?.user?.estabelecimentoId ||
    req.session?.user?.id ||
    req.session?.user?._id
  );
}

function obterBaseUrl(req) {
  const appUrl = String(process.env.APP_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const placeholder =
    /seu-dominio\.com|seudominio\.com/i.test(appUrl);

  if (appUrl && !placeholder) {
    return appUrl;
  }

  return `${req.protocol}://${req.get("host")}`;
}

function salvarERedirecionar(
  req,
  res,
  pagina,
  mensagem = "Alteração salva com sucesso.",
) {
  req.flash("success", mensagem);

  return req.session.save(() => {
    return res.redirect(`/admin#${pagina}`);
  });
}

function erroERedirecionar(
  req,
  res,
  pagina,
  mensagem = "Não foi possível concluir a operação.",
) {
  req.flash("errors", mensagem);

  return req.session.save(() => {
    return res.redirect(`/admin#${pagina}`);
  });
}

async function criarSlugUnico(nome, idEstabelecimento) {
  const base = slugify(nome) || "estabelecimento";
  let slug = base;
  let contador = 1;

  while (
    await Configuracao.exists({
      slug,
      estabelecimentoId: { $ne: idEstabelecimento },
    })
  ) {
    contador += 1;
    slug = `${base}-${contador}`;
  }

  return slug;
}

async function obterAssinatura(idEstabelecimento) {
  let assinatura = await Assinatura.findOne({
    estabelecimentoId: idEstabelecimento,
  });

  if (!assinatura) {
    const inicioTeste = new Date();
    const fimTeste = new Date(
      inicioTeste.getTime() + 7 * 24 * 60 * 60 * 1000,
    );

    assinatura = await Assinatura.create({
      estabelecimentoId: idEstabelecimento,
      status: "teste",
      metodo: "teste",
      inicioTeste,
      fimTeste,
    });
  }

  const agora = new Date();

  if (
    assinatura.status === "teste" &&
    assinatura.fimTeste &&
    agora > new Date(assinatura.fimTeste)
  ) {
    assinatura.status = "expirada";
    await assinatura.save();
  }

  const vencimentoPago =
    assinatura.planoExpira ||
    assinatura.expiraEm;

  if (
    assinatura.status === "ativa" &&
    vencimentoPago &&
    agora > new Date(vencimentoPago)
  ) {
    assinatura.status = "expirada";
    await assinatura.save();
  }

  return assinatura;
}

function calcularDiasRestantes(assinatura) {
  if (!assinatura) {
    return 0;
  }

  let dataFinal = null;

  if (assinatura.status === "teste") {
    dataFinal = assinatura.fimTeste;
  }

  if (assinatura.status === "ativa") {
    dataFinal =
      assinatura.planoExpira ||
      assinatura.expiraEm;
  }

  if (!dataFinal) {
    return 0;
  }

  const diferenca =
    new Date(dataFinal).getTime() -
    Date.now();

  return Math.max(
    0,
    Math.ceil(
      diferenca /
        (1000 * 60 * 60 * 24),
    ),
  );
}

async function obterOuCriarConfiguracao(
  req,
  idEstabelecimento,
) {
  let configuracao =
    await Configuracao.findOne({
      estabelecimentoId:
        idEstabelecimento,
    });

  if (configuracao) {
    return configuracao;
  }

  const dono =
    await registroModel
      .findById(idEstabelecimento)
      .lean();

  const nomeEstabelecimento =
    dono?.nomeEstabelecimento ||
    req.session?.user
      ?.nomeEstabelecimento ||
    "Meu estabelecimento";

  const slug = await criarSlugUnico(
    nomeEstabelecimento,
    idEstabelecimento,
  );

  configuracao =
    await Configuracao.create({
      estabelecimentoId:
        idEstabelecimento,
      nomeEstabelecimento,
      telefone: dono?.telefone || "",
      endereco: "",
      descricao: "",
      fotoPerfil: "",
      slug,
    });

  return configuracao;
}

function obterPeriodoRelatorio(
  filtro,
  dataInicio,
  dataFim,
) {
  const agora = new Date();
  let inicio = null;
  let fim = null;
  let filtroFinal = filtro;

  if (filtro === "hoje") {
    inicio = new Date(agora);
    inicio.setHours(0, 0, 0, 0);

    fim = new Date(agora);
    fim.setHours(23, 59, 59, 999);
  }

  if (filtro === "semana") {
    const diaSemana = agora.getDay();
    const diferenca =
      diaSemana === 0
        ? -6
        : 1 - diaSemana;

    inicio = new Date(agora);
    inicio.setDate(
      agora.getDate() + diferenca,
    );
    inicio.setHours(0, 0, 0, 0);

    fim = new Date(inicio);
    fim.setDate(
      inicio.getDate() + 6,
    );
    fim.setHours(23, 59, 59, 999);
  }

  if (filtro === "mes") {
    inicio = new Date(
      agora.getFullYear(),
      agora.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );

    fim = new Date(
      agora.getFullYear(),
      agora.getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    );
  }

  if (filtro === "ano") {
    inicio = new Date(
      agora.getFullYear(),
      0,
      1,
      0,
      0,
      0,
      0,
    );

    fim = new Date(
      agora.getFullYear(),
      11,
      31,
      23,
      59,
      59,
      999,
    );
  }

  if (filtro === "personalizado") {
    const formatoValido =
      /^\d{4}-\d{2}-\d{2}$/;

    if (
      formatoValido.test(dataInicio) &&
      formatoValido.test(dataFim)
    ) {
      inicio = new Date(
        `${dataInicio}T00:00:00`,
      );

      fim = new Date(
        `${dataFim}T23:59:59.999`,
      );

      if (
        Number.isNaN(inicio.getTime()) ||
        Number.isNaN(fim.getTime()) ||
        inicio > fim
      ) {
        filtroFinal = "hoje";
      }
    } else {
      filtroFinal = "hoje";
    }

    if (filtroFinal === "hoje") {
      inicio = new Date(agora);
      inicio.setHours(0, 0, 0, 0);

      fim = new Date(agora);
      fim.setHours(23, 59, 59, 999);
    }
  }

  if (filtro === "todos") {
    inicio = null;
    fim = null;
  }

  return {
    filtro: filtroFinal,
    inicio,
    fim,
  };
}

function montarRankingProdutos(pedidos) {
  const mapa = new Map();

  pedidos.forEach((pedido) => {
    const itens = Array.isArray(
      pedido.itens,
    )
      ? pedido.itens
      : [];

    itens.forEach((item) => {
      const chave = String(
        item.produtoId ||
          item.nome ||
          "produto",
      );

      const atual = mapa.get(chave) || {
        nome: item.nome || "Produto",
        quantidade: 0,
        total: 0,
      };

      const quantidade = Math.max(
        0,
        Number(item.quantidade || 0),
      );

      const subtotal =
        Number(item.subtotal) ||
        Number(item.preco || 0) *
          quantidade;

      atual.quantidade += quantidade;
      atual.total += subtotal;

      mapa.set(chave, atual);
    });
  });

  const lista = Array.from(
    mapa.values(),
  );

  return {
    maisVendidos: [...lista]
      .sort(
        (a, b) =>
          b.quantidade - a.quantidade,
      )
      .slice(0, 5),

    menosVendidos: [...lista]
      .sort(
        (a, b) =>
          a.quantidade - b.quantidade,
      )
      .slice(0, 5),
  };
}

function montarGrafico(
  pedidos,
  filtro,
  inicioPeriodo,
  fimPeriodo,
) {
  let labels = [];
  let valores = [];

  if (filtro === "hoje") {
    labels = [
      "00h",
      "04h",
      "08h",
      "12h",
      "16h",
      "20h",
    ];

    valores = new Array(6).fill(0);

    pedidos.forEach((pedido) => {
      const hora = new Date(
        pedido.createdAt,
      ).getHours();

      let indice = 0;

      if (hora >= 4 && hora < 8) {
        indice = 1;
      } else if (
        hora >= 8 &&
        hora < 12
      ) {
        indice = 2;
      } else if (
        hora >= 12 &&
        hora < 16
      ) {
        indice = 3;
      } else if (
        hora >= 16 &&
        hora < 20
      ) {
        indice = 4;
      } else if (hora >= 20) {
        indice = 5;
      }

      valores[indice] += Number(
        pedido.total || 0,
      );
    });
  }

  if (filtro === "semana") {
    labels = [
      "Seg",
      "Ter",
      "Qua",
      "Qui",
      "Sex",
      "Sáb",
      "Dom",
    ];

    valores = new Array(7).fill(0);

    pedidos.forEach((pedido) => {
      const dia = new Date(
        pedido.createdAt,
      ).getDay();

      const indice =
        dia === 0 ? 6 : dia - 1;

      valores[indice] += Number(
        pedido.total || 0,
      );
    });
  }

  if (filtro === "mes") {
    labels = [
      "Semana 1",
      "Semana 2",
      "Semana 3",
      "Semana 4",
      "Semana 5",
    ];

    valores = new Array(5).fill(0);

    pedidos.forEach((pedido) => {
      const dia = new Date(
        pedido.createdAt,
      ).getDate();

      const indice = Math.min(
        4,
        Math.ceil(dia / 7) - 1,
      );

      valores[indice] += Number(
        pedido.total || 0,
      );
    });
  }

  if (filtro === "ano") {
    labels = [
      "Jan",
      "Fev",
      "Mar",
      "Abr",
      "Mai",
      "Jun",
      "Jul",
      "Ago",
      "Set",
      "Out",
      "Nov",
      "Dez",
    ];

    valores = new Array(12).fill(0);

    pedidos.forEach((pedido) => {
      const mes = new Date(
        pedido.createdAt,
      ).getMonth();

      valores[mes] += Number(
        pedido.total || 0,
      );
    });
  }

  if (
    filtro === "personalizado" &&
    inicioPeriodo &&
    fimPeriodo
  ) {
    const quantidadeDias =
      Math.floor(
        (fimPeriodo.getTime() -
          inicioPeriodo.getTime()) /
          (1000 * 60 * 60 * 24),
      ) + 1;

    if (quantidadeDias <= 31) {
      labels = [];
      valores = [];

      for (
        let indice = 0;
        indice < quantidadeDias;
        indice += 1
      ) {
        const data = new Date(
          inicioPeriodo,
        );

        data.setDate(
          inicioPeriodo.getDate() +
            indice,
        );

        labels.push(
          data.toLocaleDateString(
            "pt-BR",
            {
              day: "2-digit",
              month: "2-digit",
            },
          ),
        );

        valores.push(0);
      }

      pedidos.forEach((pedido) => {
        const dataPedido = new Date(
          pedido.createdAt,
        );

        dataPedido.setHours(
          0,
          0,
          0,
          0,
        );

        const inicio = new Date(
          inicioPeriodo,
        );

        inicio.setHours(0, 0, 0, 0);

        const indice = Math.floor(
          (dataPedido.getTime() -
            inicio.getTime()) /
            (1000 * 60 * 60 * 24),
        );

        if (
          indice >= 0 &&
          indice < valores.length
        ) {
          valores[indice] += Number(
            pedido.total || 0,
          );
        }
      });
    } else {
      const meses = new Map();

      let cursor = new Date(
        inicioPeriodo.getFullYear(),
        inicioPeriodo.getMonth(),
        1,
      );

      const ultimoMes = new Date(
        fimPeriodo.getFullYear(),
        fimPeriodo.getMonth(),
        1,
      );

      while (cursor <= ultimoMes) {
        const chave = `${cursor.getFullYear()}-${String(
          cursor.getMonth() + 1,
        ).padStart(2, "0")}`;

        meses.set(chave, {
          label:
            cursor.toLocaleDateString(
              "pt-BR",
              {
                month: "short",
                year: "2-digit",
              },
            ),
          valor: 0,
        });

        cursor = new Date(
          cursor.getFullYear(),
          cursor.getMonth() + 1,
          1,
        );
      }

      pedidos.forEach((pedido) => {
        const data = new Date(
          pedido.createdAt,
        );

        const chave = `${data.getFullYear()}-${String(
          data.getMonth() + 1,
        ).padStart(2, "0")}`;

        const mes = meses.get(chave);

        if (mes) {
          mes.valor += Number(
            pedido.total || 0,
          );
        }
      });

      labels = Array.from(
        meses.values(),
      ).map((mes) => mes.label);

      valores = Array.from(
        meses.values(),
      ).map((mes) => mes.valor);
    }
  }

  if (filtro === "todos") {
    const meses = new Map();

    pedidos
      .slice()
      .reverse()
      .forEach((pedido) => {
        const data = new Date(
          pedido.createdAt,
        );

        const chave = `${data.getFullYear()}-${String(
          data.getMonth() + 1,
        ).padStart(2, "0")}`;

        if (!meses.has(chave)) {
          meses.set(chave, {
            label:
              data.toLocaleDateString(
                "pt-BR",
                {
                  month: "short",
                  year: "2-digit",
                },
              ),
            valor: 0,
          });
        }

        meses.get(chave).valor += Number(
          pedido.total || 0,
        );
      });

    labels = Array.from(
      meses.values(),
    ).map((mes) => mes.label);

    valores = Array.from(
      meses.values(),
    ).map((mes) => mes.valor);
  }

  if (!labels.length) {
    labels = ["Sem dados"];
    valores = [0];
  }

  return {
    labels,
    valores,
    maiorValor: Math.max(
      ...valores,
      1,
    ),
  };
}

/*
|--------------------------------------------------------------------------
| PAINEL ADMINISTRATIVO
|--------------------------------------------------------------------------
*/

exports.admin = async (req, res) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    if (!idEstabelecimento) {
      return res.redirect(
        "/login/index",
      );
    }

    const assinatura =
      await obterAssinatura(
        idEstabelecimento,
      );

    const diasRestantes =
      calcularDiasRestantes(
        assinatura,
      );

    const configuracaoDocumento =
      await obterOuCriarConfiguracao(
        req,
        idEstabelecimento,
      );

    const pedidosFiltrosPermitidos = ["hoje", "semana", "mes", "personalizado"];
    const pedidoPeriodoSolicitado = pedidosFiltrosPermitidos.includes(req.query.pedidoPeriodo)
      ? req.query.pedidoPeriodo
      : "hoje";
    const pedidoDataInicio = String(req.query.pedidoDataInicio || "").trim();
    const pedidoDataFim = String(req.query.pedidoDataFim || "").trim();
    const pedidoPeriodo = obterPeriodoRelatorio(
      pedidoPeriodoSolicitado,
      pedidoDataInicio,
      pedidoDataFim,
    );

    const dashboardPeriodoConsulta = obterPeriodoRelatorio(
      ["hoje", "semana", "mes", "ano", "todos", "personalizado"].includes(req.query.dashboardFiltro)
        ? req.query.dashboardFiltro
        : "hoje",
      String(req.query.dashboardDataInicio || "").trim(),
      String(req.query.dashboardDataFim || "").trim(),
    );

    const relatorioPeriodoConsulta = obterPeriodoRelatorio(
      ["hoje", "semana", "mes", "ano", "todos", "personalizado"].includes(req.query.filtro)
        ? req.query.filtro
        : "hoje",
      String(req.query.dataInicio || "").trim(),
      String(req.query.dataFim || "").trim(),
    );

    const periodosConsulta = [pedidoPeriodo, dashboardPeriodoConsulta, relatorioPeriodoConsulta];
    const consultaSemLimiteDeData = periodosConsulta.some(periodoConsulta => !periodoConsulta.inicio || !periodoConsulta.fim);
    const filtroDataPedidos = {};

    if (!consultaSemLimiteDeData) {
      const inicios = periodosConsulta.map(periodoConsulta => periodoConsulta.inicio.getTime());
      const fins = periodosConsulta.map(periodoConsulta => periodoConsulta.fim.getTime());
      filtroDataPedidos.createdAt = {
        $gte: new Date(Math.min(...inicios)),
        $lte: new Date(Math.max(...fins)),
      };
    }

    const [
      categorias,
      estoque,
      produtos,
      mesas,
      funcionarios,
      pedidos,
    ] = await Promise.all([
      Categoria.find({
        estabelecimentoId:
          idEstabelecimento,
      })
        .sort({ nome: 1 })
        .lean(),

      Estoque.find({
        estabelecimentoId:
          idEstabelecimento,
      })
        .populate(
          "categoriaId",
          "nome tipo",
        )
        .sort({ nome: 1 })
        .lean(),

      Produto.find({
        estabelecimentoId:
          idEstabelecimento,
      })
        .populate(
          "categoriaId",
          "nome tipo",
        )
        .sort({ nome: 1 })
        .lean(),

      Mesa.find({
        estabelecimentoId:
          idEstabelecimento,
      })
        .sort({ numero: 1 })
        .lean(),

      Funcionario.find({
        estabelecimentoId:
          idEstabelecimento,
      })
        .select("-senha")
        .sort({ nome: 1 })
        .lean(),

      Pedido.find({
        estabelecimentoId:
          idEstabelecimento,
        ...filtroDataPedidos,
      })
        .populate(
          "mesaId",
          "numero setor status",
        )
        .sort({ createdAt: -1 })
        .limit(500)
        .lean(),
    ]);

    const configuracao =
      typeof configuracaoDocumento.toObject ===
      "function"
        ? configuracaoDocumento.toObject()
        : configuracaoDocumento;

    const categoriasEstoque =
      categorias.filter(
        (categoria) =>
          categoria.tipo ===
          "estoque",
      );

    const categoriasCatalogo =
      categorias.filter(
        (categoria) =>
          categoria.tipo ===
          "catalogo",
      );

    const baseUrl = obterBaseUrl(req);

    const catalogoLink =
      configuracao?.slug
        ? `${baseUrl}/catalogo/${configuracao.slug}`
        : "#";

    /*
    |--------------------------------------------------------------------------
    | CONTAS DAS MESAS
    |--------------------------------------------------------------------------
    */

    const contasPorMesa = new Map();

    pedidos
      .filter((pedido) => {
        return (
          pedido.mesaId &&
          pedido.pagamentoStatus ===
            "pendente" &&
          pedido.status !== "cancelado"
        );
      })
      .forEach((pedido) => {
        const idMesa = String(
          pedido.mesaId?._id ||
            pedido.mesaId,
        );

        const conta =
          contasPorMesa.get(idMesa) || {
            quantidadePedidos: 0,
            totalConta: 0,
          };

        conta.quantidadePedidos += 1;
        conta.totalConta += Number(
          pedido.total || 0,
        );

        contasPorMesa.set(
          idMesa,
          conta,
        );
      });

    const mesasComConta =
      await Promise.all(
        mesas.map(async (mesa) => {
          const link = `${baseUrl}/mesa/${mesa.token}`;

          const conta =
            contasPorMesa.get(
              String(mesa._id),
            ) || {
              quantidadePedidos: 0,
              totalConta: 0,
            };

          let qrCode = "";

          try {
            qrCode =
              await QRCode.toDataURL(
                link,
              );
          } catch (erroQrCode) {
            console.error(
              `Erro ao gerar QR Code da mesa ${mesa.numero}:`,
              erroQrCode,
            );
          }

          return {
            ...mesa,
            link,
            qrCode,
            quantidadePedidos:
              conta.quantidadePedidos,
            totalConta:
              conta.totalConta,
          };
        }),
      );

    /*
    |--------------------------------------------------------------------------
    | DASHBOARD COM FILTRO DE DATA
    |--------------------------------------------------------------------------
    */

    const dashboardFiltrosPermitidos = [
      "hoje",
      "semana",
      "mes",
      "ano",
      "todos",
      "personalizado",
    ];

    const dashboardFiltroSolicitado =
      dashboardFiltrosPermitidos.includes(
        req.query.dashboardFiltro,
      )
        ? req.query.dashboardFiltro
        : "hoje";

    const dashboardDataInicio = String(
      req.query.dashboardDataInicio || "",
    ).trim();

    const dashboardDataFim = String(
      req.query.dashboardDataFim || "",
    ).trim();

    const dashboardPeriodo =
      obterPeriodoRelatorio(
        dashboardFiltroSolicitado,
        dashboardDataInicio,
        dashboardDataFim,
      );

    const pedidosDashboard =
      pedidos.filter((pedido) => {
        if (
          !pedido.createdAt ||
          pedido.status === "cancelado"
        ) {
          return false;
        }

        if (
          !dashboardPeriodo.inicio ||
          !dashboardPeriodo.fim
        ) {
          return true;
        }

        const data = new Date(
          pedido.createdAt,
        );

        return (
          data >= dashboardPeriodo.inicio &&
          data <= dashboardPeriodo.fim
        );
      });

    const pedidosPagosDashboard =
      pedidosDashboard.filter((pedido) => {
        return (
          pedido.pagamentoStatus === "pago" ||
          pedido.status === "finalizado"
        );
      });

    const vendasHoje =
      pedidosPagosDashboard.reduce(
        (total, pedido) =>
          total + Number(pedido.total || 0),
        0,
      );

    const ticketMedio =
      pedidosPagosDashboard.length
        ? vendasHoje /
          pedidosPagosDashboard.length
        : 0;

    const dashboard = {
      filtroAtual:
        dashboardPeriodo.filtro,
      dataInicio:
        dashboardDataInicio,
      dataFim:
        dashboardDataFim,
      vendasHoje,
      pedidosHoje:
        pedidosDashboard.length,
      ticketMedio,
      mesasOcupadas: mesas.filter(
        (mesa) =>
          [
            "ocupada",
            "aguardando_pagamento",
          ].includes(mesa.status),
      ).length,
      totalMesas: mesas.length,
      pedidosLista:
        pedidosDashboard.slice(0, 100),
    };

    /*
    |--------------------------------------------------------------------------
    | RELATÓRIOS
    |--------------------------------------------------------------------------
    */

    const filtrosPermitidos = [
      "hoje",
      "semana",
      "mes",
      "ano",
      "todos",
      "personalizado",
    ];

    const filtroSolicitado =
      filtrosPermitidos.includes(
        req.query.filtro,
      )
        ? req.query.filtro
        : "hoje";

    const dataInicio = String(
      req.query.dataInicio || "",
    ).trim();

    const dataFim = String(
      req.query.dataFim || "",
    ).trim();

    const periodo =
      obterPeriodoRelatorio(
        filtroSolicitado,
        dataInicio,
        dataFim,
      );

    const canaisPermitidos = [
      "todos",
      "delivery",
      "mesa",
      "retirada",
    ];

    const canalAtual =
      canaisPermitidos.includes(
        req.query.canal,
      )
        ? req.query.canal
        : "todos";

    const pedidosFiltrados =
      pedidos.filter((pedido) => {
        if (
          pedido.status ===
          "cancelado"
        ) {
          return false;
        }

        const canalPedido =
          pedido.canal === "balcao"
            ? "retirada"
            : pedido.canal;

        if (
          canalAtual !== "todos" &&
          canalPedido !== canalAtual
        ) {
          return false;
        }

        if (
          !periodo.inicio ||
          !periodo.fim
        ) {
          return true;
        }

        if (!pedido.createdAt) {
          return false;
        }

        const data = new Date(
          pedido.createdAt,
        );

        return (
          data >= periodo.inicio &&
          data <= periodo.fim
        );
      });

    const pedidosFinalizados =
      pedidosFiltrados.filter(
        (pedido) => {
          return (
            pedido.pagamentoStatus ===
              "pago" ||
            pedido.status ===
              "finalizado"
          );
        },
      );

    const faturamento =
      pedidosFinalizados.reduce(
        (total, pedido) =>
          total +
          Number(pedido.total || 0),
        0,
      );

    const custo =
      pedidosFinalizados.reduce(
        (total, pedido) =>
          total +
          Number(pedido.custo || 0),
        0,
      );

    const ranking =
      montarRankingProdutos(
        pedidosFiltrados,
      );

    const relatorios = {
      filtroAtual: periodo.filtro,
      canalAtual,
      dataInicio,
      dataFim,
      faturamento,
      custo,
      lucro: faturamento - custo,
      totalPedidos:
        pedidosFinalizados.length,
      grafico: montarGrafico(
        pedidosFinalizados,
        periodo.filtro,
        periodo.inicio,
        periodo.fim,
      ),
      maisVendidos:
        ranking.maisVendidos,
      menosVendidos:
        ranking.menosVendidos,
      historico:
        pedidosFiltrados.slice(
          0,
          100,
        ),
    };

    const pedidoCanalAtual = ["todos", "delivery", "mesa", "retirada"].includes(req.query.pedidoCanal)
      ? req.query.pedidoCanal
      : "todos";
    const pedidoStatusAtual = ["todos", "novo", "preparo", "em_preparo", "pronto", "saiu_para_entrega", "finalizado", "cancelado"].includes(req.query.pedidoStatus)
      ? req.query.pedidoStatus
      : "todos";

    const listaPedidos = pedidos.filter(pedido => {
      if (!pedido.createdAt) return false;
      const dataPedido = new Date(pedido.createdAt);
      if (pedidoPeriodo.inicio && dataPedido < pedidoPeriodo.inicio) return false;
      if (pedidoPeriodo.fim && dataPedido > pedidoPeriodo.fim) return false;

      const canalPedido = pedido.canal === "balcao" ? "retirada" : (pedido.canal || "retirada");
      if (pedidoCanalAtual !== "todos" && canalPedido !== pedidoCanalAtual) return false;

      const statusPedido = pedido.status || "novo";
      if (pedidoStatusAtual !== "todos") {
        const preparoEquivalente = ["preparo", "em_preparo"].includes(pedidoStatusAtual)
          && ["preparo", "em_preparo"].includes(statusPedido);
        if (!preparoEquivalente && statusPedido !== pedidoStatusAtual) return false;
      }

      return true;
    });

    const filtrosPedidos = {
      periodoAtual: pedidoPeriodo.filtro,
      dataInicio: pedidoDataInicio,
      dataFim: pedidoDataFim,
      canalAtual: pedidoCanalAtual,
      statusAtual: pedidoStatusAtual,
    };

    return res.render(
      "admin-real",
      {
        user: req.session.user,
        assinatura,
        diasRestantes,

        configuracao,
        catalogoLink,

        dashboard,
        relatorios,

        categoriasEstoque,
        categoriasCatalogo,

        estoque,
        itensEstoque: estoque,

        produtos,

        mesas: mesasComConta,

        funcionarios,
        listaFuncionarios:
          funcionarios,

        pedidos,
        pedidosFiltradosPainel: listaPedidos,
        filtrosPedidos,

        errors:
          req.flash("errors"),

        success:
          req.flash("success"),
      },
    );
  } catch (error) {
    console.error(
      "Erro ao carregar painel:",
      error,
    );

    return res
      .status(500)
      .render("404");
  }
};

/*
|--------------------------------------------------------------------------
| CATEGORIAS
|--------------------------------------------------------------------------
*/

exports.criarCategoria = async (
  req,
  res,
) => {
  try {
    const tipo =
      req.body.tipo === "catalogo"
        ? "catalogo"
        : "estoque";

    await Categoria.create({
      estabelecimentoId:
        estabelecimentoId(req),
      nome: String(
        req.body.nome || "",
      ).trim(),
      tipo,
    });

    return salvarERedirecionar(
      req,
      res,
      tipo,
      "Categoria cadastrada.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      req.body.tipo === "catalogo"
        ? "catalogo"
        : "estoque",
      "Não foi possível cadastrar a categoria.",
    );
  }
};

exports.excluirCategoria = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const categoria =
      await Categoria.findOne({
        _id: req.params.id,
        estabelecimentoId:
          idEstabelecimento,
      });

    if (!categoria) {
      return erroERedirecionar(
        req,
        res,
        "estoque",
        "Categoria não encontrada.",
      );
    }

    const [
      utilizadaNoEstoque,
      utilizadaNoCatalogo,
    ] = await Promise.all([
      Estoque.exists({
        estabelecimentoId:
          idEstabelecimento,
        categoriaId:
          categoria._id,
      }),

      Produto.exists({
        estabelecimentoId:
          idEstabelecimento,
        categoriaId:
          categoria._id,
      }),
    ]);

    if (
      utilizadaNoEstoque ||
      utilizadaNoCatalogo
    ) {
      return erroERedirecionar(
        req,
        res,
        categoria.tipo,
        "A categoria está sendo usada.",
      );
    }

    await categoria.deleteOne();

    return salvarERedirecionar(
      req,
      res,
      categoria.tipo,
      "Categoria excluída.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "estoque",
      "Não foi possível excluir a categoria.",
    );
  }
};

/*
|--------------------------------------------------------------------------
| ESTOQUE
|--------------------------------------------------------------------------
*/

exports.criarEstoque = async (
  req,
  res,
) => {
  try {
    await Estoque.create({
      estabelecimentoId:
        estabelecimentoId(req),
      nome: String(
        req.body.nome || "",
      ).trim(),
      categoriaId:
        req.body.categoriaId,
      quantidade: Number(
        req.body.quantidade || 0,
      ),
      quantidadeInicial: Number(
        req.body.quantidade || 0,
      ),
      minimo: Number(
        req.body.minimo || 0,
      ),
      unidade:
        req.body.unidade || "un",
      custoUnitario: Number(
        req.body.custoUnitario || 0,
      ),
    });

    return salvarERedirecionar(
      req,
      res,
      "estoque",
      "Item cadastrado.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "estoque",
      "Não foi possível cadastrar o item.",
    );
  }
};

exports.editarEstoque = async (
  req,
  res,
) => {
  try {
    const item =
      await Estoque.findOne({
        _id: req.params.id,
        estabelecimentoId:
          estabelecimentoId(req),
      });

    if (!item) {
      return erroERedirecionar(
        req,
        res,
        "estoque",
        "Item não encontrado.",
      );
    }

    item.nome = String(
      req.body.nome || item.nome,
    ).trim();

    item.categoriaId =
      req.body.categoriaId ||
      item.categoriaId;

    if (item.quantidadeInicial === undefined || item.quantidadeInicial === null) {
      item.quantidadeInicial = Number(item.quantidade || 0);
    }

    item.quantidade = Number(
      req.body.quantidade ?? item.quantidade,
    );

    item.minimo = Number(
      req.body.minimo ?? item.minimo,
    );

    item.unidade =
      req.body.unidade ||
      item.unidade;

    item.custoUnitario = Number(
      req.body.custoUnitario ??
        item.custoUnitario,
    );

    await item.save();

    return salvarERedirecionar(
      req,
      res,
      "estoque",
      "Item atualizado.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "estoque",
      "Não foi possível atualizar o item.",
    );
  }
};

exports.excluirEstoque = async (
  req,
  res,
) => {
  try {
    await Estoque.deleteOne({
      _id: req.params.id,
      estabelecimentoId:
        estabelecimentoId(req),
    });

    return salvarERedirecionar(
      req,
      res,
      "estoque",
      "Item excluído.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "estoque",
      "Não foi possível excluir o item.",
    );
  }
};

/*
|--------------------------------------------------------------------------
| PRODUTOS
|--------------------------------------------------------------------------
*/

exports.criarProduto = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const { fichaTecnica, custo } = await montarFichaTecnica(
      req.body,
      idEstabelecimento,
    );

    await Produto.create({
      estabelecimentoId: idEstabelecimento,
      nome: String(
        req.body.nome || "",
      ).trim(),
      descricao: String(
        req.body.descricao || "",
      ).trim(),
      categoriaId:
        req.body.categoriaId,
      preco: Number(
        req.body.preco || 0,
      ),
      custo,
      fichaTecnica,
      adicionais:
        normalizarAdicionais(req.body),
      ativo:
        req.body.ativo === "on",
      imagem: req.file
        ? imagemParaDataUrl(req.file)
        : "",
    });

    return salvarERedirecionar(
      req,
      res,
      "catalogo",
      "Produto cadastrado.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "catalogo",
      "Não foi possível cadastrar o produto.",
    );
  }
};

exports.editarProduto = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const produto =
      await Produto.findOne({
        _id: req.params.id,
        estabelecimentoId: idEstabelecimento,
      });

    if (!produto) {
      return erroERedirecionar(
        req,
        res,
        "catalogo",
        "Produto não encontrado.",
      );
    }

    produto.nome = String(
      req.body.nome || produto.nome,
    ).trim();

    produto.descricao = String(
      req.body.descricao ??
        produto.descricao ??
        "",
    ).trim();

    produto.categoriaId =
      req.body.categoriaId ||
      produto.categoriaId;

    produto.preco = Number(
      req.body.preco ??
        produto.preco,
    );

    const ficha = await montarFichaTecnica(
      req.body,
      idEstabelecimento,
    );
    produto.fichaTecnica = ficha.fichaTecnica;
    produto.custo = ficha.custo;

    produto.adicionais =
      normalizarAdicionais(req.body);

    produto.ativo =
      req.body.ativo === "on";

    if (req.file) {
      produto.imagem =
        imagemParaDataUrl(req.file);
    }

    await produto.save();

    return salvarERedirecionar(
      req,
      res,
      "catalogo",
      "Produto atualizado.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "catalogo",
      "Não foi possível atualizar o produto.",
    );
  }
};

exports.excluirProduto = async (
  req,
  res,
) => {
  try {
    await Produto.deleteOne({
      _id: req.params.id,
      estabelecimentoId:
        estabelecimentoId(req),
    });

    return salvarERedirecionar(
      req,
      res,
      "catalogo",
      "Produto excluído.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "catalogo",
      "Não foi possível excluir o produto.",
    );
  }
};

/*
|--------------------------------------------------------------------------
| MESAS
|--------------------------------------------------------------------------
*/

exports.criarMesa = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const numero = Number(
      req.body.numero,
    );

    if (
      !Number.isInteger(numero) ||
      numero < 1
    ) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "Informe um número de mesa válido.",
      );
    }

    const mesaExistente =
      await Mesa.exists({
        estabelecimentoId:
          idEstabelecimento,
        numero,
      });

    if (mesaExistente) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        `A mesa ${numero} já está cadastrada.`,
      );
    }

    await Mesa.create({
      estabelecimentoId:
        idEstabelecimento,
      numero,
      capacidade: Math.max(
        1,
        Number(
          req.body.capacidade || 1,
        ),
      ),
      setor: String(
        req.body.setor || "",
      ).trim(),
      status:
        req.body.status || "livre",
      token: crypto
        .randomBytes(18)
        .toString("hex"),
    });

    return salvarERedirecionar(
      req,
      res,
      "mesas",
      "Mesa cadastrada.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "mesas",
      "Não foi possível cadastrar a mesa.",
    );
  }
};

exports.editarMesa = async (
  req,
  res,
) => {
  try {
    const mesa = await Mesa.findOne({
      _id: req.params.id,
      estabelecimentoId:
        estabelecimentoId(req),
    });

    if (!mesa) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "Mesa não encontrada.",
      );
    }

    const novoNumero = Number(
      req.body.numero ?? mesa.numero,
    );

    if (
      !Number.isInteger(novoNumero) ||
      novoNumero < 1
    ) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "Informe um número de mesa válido.",
      );
    }

    const outraMesaComMesmoNumero =
      await Mesa.exists({
        _id: { $ne: mesa._id },
        estabelecimentoId:
          estabelecimentoId(req),
        numero: novoNumero,
      });

    if (outraMesaComMesmoNumero) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        `A mesa ${novoNumero} já está cadastrada.`,
      );
    }

    mesa.numero = novoNumero;

    mesa.capacidade = Math.max(
      1,
      Number(
        req.body.capacidade ??
          mesa.capacidade,
      ),
    );

    mesa.setor = String(
      req.body.setor ??
        mesa.setor ??
        "",
    ).trim();

    if (req.body.status) {
      mesa.status = req.body.status;
    }

    await mesa.save();

    return salvarERedirecionar(
      req,
      res,
      "mesas",
      "Mesa atualizada.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "mesas",
      "Não foi possível atualizar a mesa.",
    );
  }
};

exports.excluirMesa = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const possuiPedido =
      await Pedido.exists({
        estabelecimentoId:
          idEstabelecimento,
        mesaId: req.params.id,
        pagamentoStatus: "pendente",
        status: {
          $ne: "cancelado",
        },
      });

    if (possuiPedido) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "A mesa possui pedidos pendentes.",
      );
    }

    await Mesa.deleteOne({
      _id: req.params.id,
      estabelecimentoId:
        idEstabelecimento,
    });

    return salvarERedirecionar(
      req,
      res,
      "mesas",
      "Mesa excluída.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "mesas",
      "Não foi possível excluir a mesa.",
    );
  }
};

exports.atualizarStatusMesa = async (
  req,
  res,
) => {
  try {
    const statusPermitidos = [
      "livre",
      "ocupada",
      "aguardando_pagamento",
      "paga",
      "reservada",
      "inativa",
    ];

    const status = req.body.status;

    if (
      !statusPermitidos.includes(
        status,
      )
    ) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "Status de mesa inválido.",
      );
    }

    const mesa =
      await Mesa.findOneAndUpdate(
        {
          _id: req.params.id,
          estabelecimentoId:
            estabelecimentoId(req),
        },
        { status },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );

    if (!mesa) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "Mesa não encontrada.",
      );
    }

    return salvarERedirecionar(
      req,
      res,
      "mesas",
      "Status da mesa atualizado.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "mesas",
      "Não foi possível atualizar a mesa.",
    );
  }
};

exports.solicitarContaMesa = async (
  req,
  res,
) => {
  try {
    const mesa = await Mesa.findOne({
      _id: req.params.id,
      estabelecimentoId:
        estabelecimentoId(req),
    });

    if (!mesa) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "Mesa não encontrada.",
      );
    }

    mesa.status =
      "aguardando_pagamento";

    await mesa.save();

    return salvarERedirecionar(
      req,
      res,
      "mesas",
      "Mesa marcada como aguardando pagamento.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "mesas",
      "Não foi possível solicitar a conta.",
    );
  }
};

exports.pagarContaMesa = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const mesa = await Mesa.findOne({
      _id: req.params.id,
      estabelecimentoId:
        idEstabelecimento,
    });

    if (!mesa) {
      return erroERedirecionar(
        req,
        res,
        "mesas",
        "Mesa não encontrada.",
      );
    }

    const formaPagamento =
      req.body.formaPagamento ||
      "nao_informado";

    await Pedido.updateMany(
      {
        estabelecimentoId:
          idEstabelecimento,
        mesaId: mesa._id,
        pagamentoStatus:
          "pendente",
        status: {
          $ne: "cancelado",
        },
      },
      {
        $set: {
          pagamentoStatus: "pago",
          formaPagamento,
          status: "finalizado",
          pagoEm: new Date(),
        },
      },
    );

    mesa.status = "livre";
    await mesa.save();

    return salvarERedirecionar(
      req,
      res,
      "mesas",
      "Conta paga e mesa liberada.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "mesas",
      "Não foi possível finalizar o pagamento.",
    );
  }
};

/*
|--------------------------------------------------------------------------
| FUNCIONÁRIOS
|--------------------------------------------------------------------------
*/

function permissoesPadrao(funcao) {
  const padroes = {
    gerente: [
      "dashboard",
      "pedidos",
      "relatorios",
      "estoque",
      "catalogo",
      "mesas",
      "funcionarios",
      "configuracoes",
    ],

    garcom: [
      "pedidos",
      "catalogo",
      "mesas",
    ],

    caixa: [
      "dashboard",
      "pedidos",
      "relatorios",
      "mesas",
    ],

    cozinha: [
      "dashboard",
      "pedidos",
      "catalogo",
    ],

    atendente: [
      "pedidos",
      "catalogo",
      "mesas",
    ],

    entregador: ["pedidos"],
  };

  return padroes[funcao] || [];
}

exports.criarFuncionario = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const nome = String(
      req.body.nome || "",
    ).trim();

    const email = String(
      req.body.email || "",
    )
      .trim()
      .toLowerCase();

    const cpf = String(
      req.body.cpf || "",
    ).replace(/\D/g, "");

    const senha = String(
      req.body.senha || "",
    );

    const salario = Number(
      req.body.salario || 0,
    );

    if (
      !nome ||
      !email ||
      cpf.length !== 11
    ) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Preencha nome, e-mail e um CPF válido.",
      );
    }

    if (senha.length < 6) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "A senha precisa ter pelo menos 6 caracteres.",
      );
    }

    if (
      Number.isNaN(salario) ||
      salario < 0
    ) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Informe um salário válido.",
      );
    }

    const duplicado =
      await Funcionario.exists({
        estabelecimentoId:
          idEstabelecimento,
        $or: [{ email }, { cpf }],
      });

    if (duplicado) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Já existe um funcionário com esse e-mail ou CPF.",
      );
    }

    const permissoes =
      req.body.permissoes
        ? [].concat(
            req.body.permissoes,
          )
        : permissoesPadrao(
            req.body.funcao,
          );

    await Funcionario.create({
      estabelecimentoId:
        idEstabelecimento,
      nome,
      email,
      cpf,
      telefone: String(
        req.body.telefone || "",
      ).trim(),
      endereco: String(
        req.body.endereco || "",
      ).trim(),
      salario,
      funcao: req.body.funcao,
      foto: req.file
        ? imagemParaDataUrl(req.file)
        : "",
      senha: await bcrypt.hash(
        senha,
        10,
      ),
      ativo:
        req.body.ativo === "on",
      permissoes,
    });

    return salvarERedirecionar(
      req,
      res,
      "funcionarios",
      "Funcionário cadastrado.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "funcionarios",
      "Não foi possível cadastrar o funcionário.",
    );
  }
};

exports.editarFuncionario = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const funcionario =
      await Funcionario.findOne({
        _id: req.params.id,
        estabelecimentoId:
          idEstabelecimento,
      });

    if (!funcionario) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Funcionário não encontrado.",
      );
    }

    const nome = String(
      req.body.nome || "",
    ).trim();

    const email = String(
      req.body.email || "",
    )
      .trim()
      .toLowerCase();

    const cpf = String(
      req.body.cpf || "",
    ).replace(/\D/g, "");

    const salario = Number(
      req.body.salario || 0,
    );

    if (
      !nome ||
      !email ||
      cpf.length !== 11
    ) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Preencha nome, e-mail e um CPF válido.",
      );
    }

    const duplicado =
      await Funcionario.exists({
        estabelecimentoId:
          idEstabelecimento,
        _id: {
          $ne: funcionario._id,
        },
        $or: [{ email }, { cpf }],
      });

    if (duplicado) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Outro funcionário já utiliza esse e-mail ou CPF.",
      );
    }

    funcionario.nome = nome;
    funcionario.email = email;
    funcionario.cpf = cpf;

    funcionario.telefone = String(
      req.body.telefone || "",
    ).trim();

    funcionario.endereco = String(
      req.body.endereco || "",
    ).trim();

    funcionario.salario = salario;
    funcionario.funcao =
      req.body.funcao;

    funcionario.ativo =
      req.body.ativo === "on";

    funcionario.permissoes =
      req.body.permissoes
        ? [].concat(
            req.body.permissoes,
          )
        : [];

    if (req.file) {
      funcionario.foto =
        imagemParaDataUrl(req.file);
    }

    const novaSenha = String(
      req.body.senha || "",
    );

    if (novaSenha) {
      if (novaSenha.length < 6) {
        return erroERedirecionar(
          req,
          res,
          "funcionarios",
          "A nova senha precisa ter pelo menos 6 caracteres.",
        );
      }

      funcionario.senha =
        await bcrypt.hash(
          novaSenha,
          10,
        );
    }

    await funcionario.save();

    return salvarERedirecionar(
      req,
      res,
      "funcionarios",
      "Funcionário atualizado.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "funcionarios",
      "Não foi possível atualizar o funcionário.",
    );
  }
};

exports.excluirFuncionario = async (
  req,
  res,
) => {
  try {
    await Funcionario.deleteOne({
      _id: req.params.id,
      estabelecimentoId:
        estabelecimentoId(req),
    });

    return salvarERedirecionar(
      req,
      res,
      "funcionarios",
      "Funcionário excluído.",
    );
  } catch (error) {
    console.error(error);

    return erroERedirecionar(
      req,
      res,
      "funcionarios",
      "Não foi possível excluir o funcionário.",
    );
  }
};

/*
|--------------------------------------------------------------------------
| CONFIGURAÇÕES
|--------------------------------------------------------------------------
*/

exports.salvarConfiguracao = async (
  req,
  res
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const nomeEstabelecimento =
      String(
        req.body
          .nomeEstabelecimento ||
          'Meu estabelecimento'
      ).trim();

    const slug =
      await criarSlugUnico(
        nomeEstabelecimento,
        idEstabelecimento
      );

    const diasRecebidos =
      req.body.diasFuncionamento;

    const diasFuncionamento =
      diasRecebidos
        ? []
            .concat(diasRecebidos)
            .map(dia => Number(dia))
            .filter(dia => {
              return (
                Number.isInteger(dia) &&
                dia >= 0 &&
                dia <= 6
              );
            })
        : [];

    const horarioAbertura =
      String(
        req.body.horarioAbertura ||
          '08:00'
      ).trim();

    const horarioFechamento =
      String(
        req.body.horarioFechamento ||
          '22:00'
      ).trim();

    const horarioValido =
      /^([01]\d|2[0-3]):[0-5]\d$/;

    if (
      !horarioValido.test(
        horarioAbertura
      ) ||
      !horarioValido.test(
        horarioFechamento
      )
    ) {
      return erroERedirecionar(
        req,
        res,
        'configuracoes',
        'Informe horários válidos.'
      );
    }

    const atualizacao = {
      nomeEstabelecimento,

      descricao: String(
        req.body.descricao || ''
      ).trim(),

      telefone: String(
        req.body.telefone || ''
      ).trim(),

      endereco: String(
        req.body.endereco || ''
      ).trim(),

      slug,

      horarioAbertura,
      horarioFechamento,
      diasFuncionamento,
    };

    if (req.file) {
      atualizacao.fotoPerfil =
        imagemParaDataUrl(req.file);
    }

    await Configuracao.findOneAndUpdate(
      {
        estabelecimentoId:
          idEstabelecimento,
      },
      atualizacao,
      {
        returnDocument: "after",
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      }
    );

    return salvarERedirecionar(
      req,
      res,
      'configuracoes',
      'Configurações salvas.'
    );
  } catch (error) {
    console.error(
      'Erro ao salvar configurações:',
      error
    );

    return erroERedirecionar(
      req,
      res,
      'configuracoes',
      'Não foi possível salvar as configurações.'
    );
  }
};

exports.salvarImpressora = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const impressoras =
      normalizarImpressoras(req.body);

    await Configuracao.findOneAndUpdate(
      {
        estabelecimentoId:
          idEstabelecimento,
      },
      {
        $set: {
          impressoras,
          impressoraTipo: "usb",
          impressoraNome:
            impressoras[0]?.nome || "",
          impressoraPapel:
            impressoras[0]?.papel ||
            "80mm",
          larguraPapel:
            impressoras[0]?.papel ||
            "80mm",
          impressaoAutomatica:
            impressoras.some(
              impressora =>
                impressora.modo ===
                  "automatica" ||
                impressora.modo ===
                  "manual_automatica",
            ),
        },
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return salvarERedirecionar(
      req,
      res,
      "configuracoes",
      "Configurações das impressoras USB e de rede salvas.",
    );
  } catch (error) {
    console.error(
      "Erro ao salvar impressoras:",
      error,
    );

    return erroERedirecionar(
      req,
      res,
      "configuracoes",
      "Não foi possível salvar as impressoras.",
    );
  }
};

/*
|--------------------------------------------------------------------------
| PEDIDOS
|--------------------------------------------------------------------------
*/

exports.obterPedidoParaImpressao = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const [pedido, configuracao, dono] =
      await Promise.all([
        Pedido.findOne({
          _id: req.params.id,
          estabelecimentoId:
            idEstabelecimento,
        })
          .populate(
            "mesaId",
            "numero setor",
          )
          .lean(),

        Configuracao.findOne({
          estabelecimentoId:
            idEstabelecimento,
        }).lean(),

        registroModel.findById(
          idEstabelecimento,
        ).select("cpfCnpj").lean(),
      ]);

    if (!pedido) {
      return res.status(404).json({
        success: false,
        message:
          "Pedido não encontrado.",
      });
    }

    let origem = "Retirada no local";

    if (pedido.canal === "delivery") {
      origem = "Delivery";
    }

    if (
      pedido.canal === "mesa" &&
      pedido.mesaId?.numero
    ) {
      origem =
        `Mesa ${pedido.mesaId.numero}`;
    }

    const baseUrl =
      obterBaseUrl(req);

    const logoUrl =
      configuracao?.fotoPerfil
        ? (
            configuracao.fotoPerfil
              .startsWith("http")
              ? configuracao.fotoPerfil
              : `${baseUrl}${configuracao.fotoPerfil}`
          )
        : "";

    return res.json({
      success: true,
      estabelecimento: {
        nome:
          configuracao
            ?.nomeEstabelecimento ||
          "ComandaMix",
        telefone:
          configuracao?.telefone || "",
        endereco:
          configuracao?.endereco || "",
        cpfCnpj:
          dono?.cpfCnpj || "",
        logoUrl,
      },
      impressoras:
        Array.isArray(
          configuracao?.impressoras,
        )
          ? configuracao.impressoras
          : [],
      pedido: {
        id: String(pedido._id),
        numero:
          String(pedido._id)
            .slice(-6)
            .toUpperCase(),
        origem,
        canal:
          pedido.canal || "retirada",
        mesaNumero:
          pedido.mesaId?.numero || null,
        cliente:
          pedido.cliente ||
          "Cliente não informado",
        telefone:
          pedido.telefoneCliente || "",
        endereco:
          pedido.enderecoEntrega || "",
        observacao:
          pedido.observacao || "",
        total:
          Number(pedido.total || 0),
        status:
          pedido.status || "novo",
        pagamentoStatus:
          pedido.pagamentoStatus ||
          "pendente",
        formaPagamento:
          pedido.formaPagamento || pedido.metodoPagamento || pedido.pagamentoMetodo || "nao_informado",
        pagamentoInformadoEm:
          pedido.pagamentoInformadoEm || null,
        pagoEm:
          pedido.pagoEm || null,
        precisaTroco:
          Boolean(pedido.precisaTroco),
        trocoPara:
          pedido.trocoPara ?? null,
        valorTroco:
          pedido.valorTroco ?? null,
        createdAt:
          pedido.createdAt,
        itens:
          (pedido.itens || []).map(
            item => ({
              nome:
                item.nome || "Produto",
              quantidade:
                Number(
                  item.quantidade || 0,
                ),
              preco:
                Number(item.preco || 0),
              subtotal:
                Number(
                  item.subtotal || 0,
                ),
              observacao:
                item.observacao || "",
              adicionais:
                Array.isArray(
                  item.adicionais,
                )
                  ? item.adicionais.map(
                      adicional => ({
                        nome:
                          adicional.nome ||
                          "Adicional",
                        preco:
                          Number(
                            adicional.preco ||
                              0,
                          ),
                      }),
                    )
                  : [],
            }),
          ),
      },
    });
  } catch (error) {
    console.error(
      "Erro ao preparar impressão:",
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        "Não foi possível preparar a impressão.",
    });
  }
};

exports.atualizarStatusPedido =
  async (req, res) => {
    try {
      const idEstabelecimento =
        estabelecimentoId(req);

      const statusPermitidos = [
        "novo",
        "preparo",
        "em_preparo",
        "pronto",
        "saiu_para_entrega",
        "finalizado",
        "cancelado",
      ];

      const status =
        req.body.status;

      if (
        !statusPermitidos.includes(
          status,
        )
      ) {
        return erroERedirecionar(
          req,
          res,
          "pedidos",
          "Status do pedido inválido.",
        );
      }

      const pedido =
        await Pedido.findOne({
          _id: req.params.id,
          estabelecimentoId:
            idEstabelecimento,
        });

      if (!pedido) {
        return erroERedirecionar(
          req,
          res,
          "pedidos",
          "Pedido não encontrado.",
        );
      }

      pedido.status = status;

      if (status === "finalizado") {
        pedido.pagamentoStatus =
          "pago";
        pedido.pagoEm = new Date();

        if (
          req.body.formaPagamento
        ) {
          pedido.formaPagamento =
            req.body.formaPagamento;
        }
      }

      await pedido.save();

      if (
        pedido.mesaId &&
        [
          "finalizado",
          "cancelado",
        ].includes(status)
      ) {
        const possuiOutrosPedidos =
          await Pedido.exists({
            estabelecimentoId:
              idEstabelecimento,
            mesaId: pedido.mesaId,
            _id: {
              $ne: pedido._id,
            },
            pagamentoStatus:
              "pendente",
            status: {
              $nin: [
                "finalizado",
                "cancelado",
              ],
            },
          });

        if (!possuiOutrosPedidos) {
          await Mesa.updateOne(
            {
              _id: pedido.mesaId,
              estabelecimentoId:
                idEstabelecimento,
            },
            {
              $set: {
                status: "livre",
              },
            },
          );
        }
      }

      return salvarERedirecionar(
        req,
        res,
        "pedidos",
        "Status do pedido atualizado.",
      );
    } catch (error) {
      console.error(error);

      return erroERedirecionar(
        req,
        res,
        "pedidos",
        "Não foi possível atualizar o pedido.",
      );
    }
  };

exports.excluirPedido = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const pedido = await Pedido.findOne({
      _id: req.params.id,
      estabelecimentoId: idEstabelecimento,
    });

    if (!pedido) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado.",
      });
    }

    const mesaId = pedido.mesaId;
    await Pedido.deleteOne({
      _id: pedido._id,
      estabelecimentoId: idEstabelecimento,
    });

    if (mesaId) {
      const possuiOutroPedidoAberto = await Pedido.exists({
        estabelecimentoId: idEstabelecimento,
        mesaId,
        pagamentoStatus: "pendente",
        status: { $nin: ["finalizado", "cancelado"] },
      });

      if (!possuiOutroPedidoAberto) {
        await Mesa.updateOne(
          { _id: mesaId, estabelecimentoId: idEstabelecimento },
          { $set: { status: "livre" } },
        );
      }
    }

    return res.json({
      success: true,
      message: "Pedido excluído definitivamente.",
    });
  } catch (error) {
    console.error("Erro ao excluir pedido:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível excluir o pedido.",
    });
  }
};

  exports.buscarNovosPedidos = async (
  req,
  res
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const dataRecebida = String(
      req.query.de || ''
    ).trim();

    let dataInicial = new Date(
      Date.now() - 60 * 1000
    );

    if (dataRecebida) {
      const dataConvertida =
        new Date(dataRecebida);

      if (
        !Number.isNaN(
          dataConvertida.getTime()
        )
      ) {
        dataInicial = new Date(
          dataConvertida.getTime() - 2000
        );
      }
    }

    const pedidos =
      await Pedido.find({
        estabelecimentoId:
          idEstabelecimento,

        createdAt: {
          $gt: dataInicial,
        },
      })
        .populate(
          'mesaId',
          'numero setor'
        )
        .sort({
          createdAt: 1,
        })
        .limit(50)
        .lean();

    const pedidosFormatados =
      pedidos.map(pedido => {
        let origem = {
          tipo: 'retirada',
          texto: 'Retirada no local',
          icone: '🏪',
        };

        if (
          pedido.canal === 'delivery'
        ) {
          origem = {
            tipo: 'delivery',
            texto: 'Delivery',
            icone: '🛵',
          };
        }

        if (
          pedido.canal === 'mesa' &&
          pedido.mesaId?.numero
        ) {
          origem = {
            tipo: 'mesa',
            texto:
              `Mesa ${pedido.mesaId.numero}`,
            icone: '🍽️',
          };
        }

        return {
          id: String(pedido._id),

          numero:
            String(pedido._id)
              .slice(-6)
              .toUpperCase(),

          cliente:
            pedido.cliente ||
            'Cliente não informado',

          telefone:
            pedido.telefoneCliente ||
            '',

          email:
            pedido.emailCliente ||
            '',

          formaPagamento:
            pedido.formaPagamento ||
            'nao_informado',

          pagoEm:
            pedido.pagoEm ||
            pedido.pagamentoInformadoEm ||
            null,

          precisaTroco:
            Boolean(pedido.precisaTroco),

          trocoPara:
            pedido.trocoPara != null
              ? Number(pedido.trocoPara)
              : null,

          valorTroco:
            pedido.valorTroco != null
              ? Number(pedido.valorTroco)
              : null,

          endereco:
            pedido.enderecoEntrega ||
            '',

          canal:
            pedido.canal ||
            'retirada',

          origem,

          itens:
            Array.isArray(pedido.itens)
              ? pedido.itens.map(item => ({
                  nome:
                    item.nome ||
                    'Produto',

                  quantidade:
                    Number(
                      item.quantidade || 0
                    ),

                  preco:
                    Number(
                      item.preco || 0
                    ),

                  subtotal:
                    Number(
                      item.subtotal
                    ) ||
                    Number(
                      item.preco || 0
                    ) *
                    Number(
                      item.quantidade || 0
                    ),

                  observacao:
                    item.observacao ||
                    '',
                }))
              : [],

          observacao:
            pedido.observacao ||
            '',

          total:
            Number(
              pedido.total || 0
            ),

          status:
            pedido.status ||
            'novo',

          pagamentoStatus:
            pedido.pagamentoStatus ||
            'pendente',

          createdAt:
            pedido.createdAt,
        };
      });

    return res.json({
      success: true,

      agora:
        new Date().toISOString(),

      quantidade:
        pedidosFormatados.length,

      pedidos:
        pedidosFormatados,
    });
  } catch (error) {
    console.error(
      'Erro ao buscar novos pedidos:',
      error
    );

    return res.status(500).json({
      success: false,

      message:
        'Não foi possível verificar novos pedidos.',
    });
  }
};

/*
|--------------------------------------------------------------------------
| CATÁLOGO PÚBLICO
|--------------------------------------------------------------------------
*/

exports.catalogoPublico = async (req, res) => {
  try {
    const configuracao = await Configuracao.findOne({ slug: req.params.slug }).lean();
    if (!configuracao) return res.status(404).render("404");

    const [produtos, avaliacoesAgregadas] = await Promise.all([
      Produto.find({ estabelecimentoId: configuracao.estabelecimentoId, ativo: true })
        .populate("categoriaId", "nome tipo").sort({ nome: 1 }).lean(),
      Avaliacao.aggregate([
        { $match: { estabelecimentoId: configuracao.estabelecimentoId } },
        { $group: { _id: "$produtoId", media: { $avg: "$nota" }, quantidade: { $sum: 1 } } },
      ]),
    ]);

    const avaliacoesPorProduto = Object.fromEntries(
      avaliacoesAgregadas.map(item => [String(item._id), {
        media: Number(item.media || 0).toFixed(1),
        quantidade: Number(item.quantidade || 0),
      }])
    );

    return res.render("catalogo-publico", { configuracao, produtos, avaliacoesPorProduto });
  } catch (error) {
    console.error("Erro ao abrir catálogo:", error);
    return res.status(500).render("404");
  }
};

/*
|--------------------------------------------------------------------------
| MESA PÚBLICA
|--------------------------------------------------------------------------
*/

exports.criarPedidoCatalogo = async (
  req,
  res
) => {
  try {
    const configuracao =
      await Configuracao.findOne({
        slug: req.params.slug,
      }).lean();

    if (!configuracao) {
      return res.status(404).json({
        success: false,
        message:
          'Estabelecimento não encontrado.',
      });
    }

    const cliente = String(
      req.body.cliente || ''
    ).trim();

    const telefone = String(
      req.body.telefone || ''
    ).trim();

    const emailCliente = String(
      req.body.emailCliente || req.body.email || ''
    ).trim().toLowerCase();

    const canal = String(
      req.body.canal || ''
    ).trim();

    const enderecoEntrega = String(
      req.body.enderecoEntrega || ''
    ).trim();

    const observacao = String(
      req.body.observacao || ''
    ).trim();

    const formaPagamentoBruta = String(
      req.body.formaPagamento ||
      req.body.metodoPagamento ||
      req.body.pagamentoMetodo ||
      'nao_informado'
    )
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\s-]+/g, '_');

    const aliasesPagamento = {
      pix: 'pix',
      pix_online: 'pix',
      dinheiro: 'dinheiro',
      dinheiro_entrega: 'dinheiro',
      dinheiro_na_entrega: 'dinheiro',
      cash: 'dinheiro',
      cartao: 'cartao',
      cartao_entrega: 'cartao',
      cartao_na_entrega: 'cartao',
      credito: 'cartao',
      debito: 'cartao',
      card: 'cartao',
    };

    const formaPagamento = aliasesPagamento[formaPagamentoBruta] || 'nao_informado';

    if (formaPagamento === 'pix') {
      const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCliente);
      if (!emailValido) {
        return res.status(400).json({
          success: false,
          message: 'Informe um e-mail válido para gerar o pagamento Pix.',
        });
      }
    }

    const precisaTroco = formaPagamento === 'dinheiro' &&
      ['true', '1', 'sim', 'on'].includes(String(req.body.precisaTroco || '').toLowerCase());

    const trocoParaRecebido = Number(
      String(req.body.trocoPara ?? '')
        .replace(',', '.')
    );

    if (precisaTroco && (!Number.isFinite(trocoParaRecebido) || trocoParaRecebido <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'Informe para quanto o cliente precisa de troco.',
      });
    }

    if (!cliente) {
      return res.status(400).json({
        success: false,
        message:
          'Informe o nome do cliente.',
      });
    }

    if (!telefone) {
      return res.status(400).json({
        success: false,
        message:
          'Informe o WhatsApp do cliente.',
      });
    }

    const canaisPermitidos = [
      'delivery',
      'retirada',
    ];

    if (
      !canaisPermitidos.includes(canal)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Tipo de pedido inválido.',
      });
    }

    if (
      canal === 'delivery' &&
      !enderecoEntrega
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Informe o endereço de entrega.',
      });
    }

    const itensRecebidos =
      Array.isArray(req.body.itens)
        ? req.body.itens
        : [];

    if (!itensRecebidos.length) {
      return res.status(400).json({
        success: false,
        message:
          'O carrinho está vazio.',
      });
    }

    const idsProdutos =
      itensRecebidos
        .map(item => {
          return item.produtoId;
        })
        .filter(Boolean);

    const produtos =
      await Produto.find({
        _id: {
          $in: idsProdutos,
        },

        estabelecimentoId:
          configuracao.estabelecimentoId,

        ativo: true,
      }).lean();

    const mapaProdutos =
      new Map(
        produtos.map(produto => {
          return [
            String(produto._id),
            produto,
          ];
        })
      );

    const itens = [];

    let total = 0;
    let custo = 0;

    for (
      const itemRecebido of
      itensRecebidos
    ) {
      const produto =
        mapaProdutos.get(
          String(
            itemRecebido.produtoId
          )
        );

      if (!produto) {
        continue;
      }

      const quantidade =
        Math.max(
          1,
          Math.min(
            99,
            Number(
              itemRecebido.quantidade
            ) || 1
          )
        );

      const preco = Number(
        produto.preco || 0
      );

      const custoUnitario = Number(
        produto.custo || 0
      );

      const subtotal =
        preco * quantidade;

      itens.push({
        produtoId: produto._id,
        nome: produto.nome,
        quantidade,
        preco,
        subtotal,
      });

      total += subtotal;

      custo +=
        custoUnitario * quantidade;
    }

    if (!itens.length) {
      return res.status(400).json({
        success: false,
        message:
          'Nenhum produto válido foi encontrado.',
      });
    }

    if (precisaTroco && trocoParaRecebido < total) {
      return res.status(400).json({
        success: false,
        message: `O valor para troco deve ser igual ou maior que o total de R$ ${total.toFixed(2).replace('.', ',')}.`,
      });
    }

    const pedido =
      await Pedido.create({
        estabelecimentoId:
          configuracao.estabelecimentoId,

        cliente,

        telefoneCliente: telefone,
        telefoneNormalizado: normalizarTelefonePublico(telefone),
        emailCliente: formaPagamento === 'pix' ? emailCliente : '',

        canal,

        enderecoEntrega:
          canal === 'delivery'
            ? enderecoEntrega
            : '',

        itens,

        observacao,

        total,
        custo,

        status: 'novo',

        pagamentoStatus:
          'pendente',

        formaPagamento,

        pagamentoInformadoEm:
          formaPagamento === 'pix'
            ? null
            : new Date(),

        precisaTroco,

        trocoPara:
          precisaTroco
            ? trocoParaRecebido
            : null,

        valorTroco:
          precisaTroco
            ? Math.max(0, trocoParaRecebido - total)
            : null,
      });

    return res.status(201).json({
      success: true,

      message:
        'Pedido enviado com sucesso.',

      pedidoId:
        pedido._id,

      numeroPedido:
        String(pedido._id)
          .slice(-6)
          .toUpperCase(),

      total,
    });
  } catch (error) {
    console.error(
      'Erro ao criar pedido do catálogo:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Não foi possível enviar o pedido.',
    });
  }
};

exports.mesaPublica = async (
  req,
  res,
) => {
  try {
    const mesa = await Mesa.findOne({
      token: req.params.token,
      status: {
        $ne: "inativa",
      },
    }).lean();

    if (!mesa) {
      return res
        .status(404)
        .render("404");
    }

    const [
      configuracao,
      produtos,
      pedidosAbertos,
      avaliacoesAgregadas,
    ] = await Promise.all([
      Configuracao.findOne({
        estabelecimentoId:
          mesa.estabelecimentoId,
      }).lean(),

      Produto.find({
        estabelecimentoId:
          mesa.estabelecimentoId,
        ativo: true,
      })
        .populate(
          "categoriaId",
          "nome tipo",
        )
        .sort({ nome: 1 })
        .lean(),

      Pedido.find({
        estabelecimentoId:
          mesa.estabelecimentoId,
        mesaId: mesa._id,
        pagamentoStatus:
          "pendente",
        status: {
          $ne: "cancelado",
        },
      })
        .sort({ createdAt: -1 })
        .lean(),

      Avaliacao.aggregate([
        {
          $match: {
            estabelecimentoId:
              mesa.estabelecimentoId,
          },
        },
        {
          $group: {
            _id: "$produtoId",
            media: {
              $avg: "$nota",
            },
            quantidade: {
              $sum: 1,
            },
          },
        },
      ]),
    ]);

    const avaliacoesPorProduto = {};

    avaliacoesAgregadas.forEach(
      (avaliacao) => {
        avaliacoesPorProduto[
          String(avaliacao._id)
        ] = {
          media:
            Math.round(
              Number(
                avaliacao.media || 0,
              ) * 10,
            ) / 10,
          quantidade:
            Number(
              avaliacao.quantidade || 0,
            ),
        };
      },
    );

    const totalConta =
      pedidosAbertos.reduce(
        (total, pedido) =>
          total +
          Number(pedido.total || 0),
        0,
      );

    const itensPendentesMesa = [];
    const pedidoAvaliavelPorProduto = {};

    pedidosAbertos.forEach((pedido) => {
      (pedido.itens || []).forEach((item) => {
        itensPendentesMesa.push({
          pedidoId: pedido._id,
          produtoId: item.produtoId,
          nome: item.nome,
          quantidade: item.quantidade,
          preco: item.preco,
          subtotal: item.subtotal,
          adicionais:
            Array.isArray(item.adicionais)
              ? item.adicionais
              : [],
          status: pedido.status,
          createdAt: pedido.createdAt,
        });

        const chave = String(item.produtoId);

        if (!pedidoAvaliavelPorProduto[chave]) {
          pedidoAvaliavelPorProduto[chave] =
            String(pedido._id);
        }
      });
    });

    return res.render(
      "mesa-publica",
      {
        mesa,
        configuracao,
        produtos,
        pedidosAbertos,
        totalConta,
        avaliacoesPorProduto,
        itensPendentesMesa,
        pedidoAvaliavelPorProduto,
      },
    );
  } catch (error) {
    console.error(
      "Erro ao abrir mesa:",
      error,
    );

    return res
      .status(500)
      .render("404");
  }
};

exports.criarPedidoMesa = async (
  req,
  res,
) => {
  try {
    const mesa = await Mesa.findOne({
      token: req.params.token,
      status: {
        $ne: "inativa",
      },
    });

    if (!mesa) {
      return res.status(404).json({
        success: false,
        message:
          "Mesa não encontrada.",
      });
    }

    const itensRecebidos =
      Array.isArray(req.body.itens)
        ? req.body.itens
        : [];

    if (!itensRecebidos.length) {
      return res.status(400).json({
        success: false,
        message:
          "O carrinho está vazio.",
      });
    }

    const idsProdutos =
      itensRecebidos
        .map(
          (item) =>
            item.produtoId,
        )
        .filter(Boolean);

    const produtos =
      await Produto.find({
        _id: {
          $in: idsProdutos,
        },
        estabelecimentoId:
          mesa.estabelecimentoId,
        ativo: true,
      });

    const produtosMap = new Map(
      produtos.map((produto) => [
        String(produto._id),
        produto,
      ]),
    );

    const itens = [];
    let total = 0;
    let custo = 0;

    for (const itemRecebido of itensRecebidos) {
      const produto =
        produtosMap.get(
          String(
            itemRecebido.produtoId,
          ),
        );

      if (!produto) {
        continue;
      }

      const quantidade = Math.max(
        1,
        Number(
          itemRecebido.quantidade,
        ) || 1,
      );

      const adicionaisDisponiveis =
        new Map(
          (produto.adicionais || [])
            .filter(
              (adicional) =>
                adicional.ativo !== false,
            )
            .map((adicional) => [
              String(adicional._id),
              adicional,
            ]),
        );

      const idsAdicionais =
        Array.isArray(
          itemRecebido.adicionais,
        )
          ? itemRecebido.adicionais
          : [];

      const adicionaisEscolhidos =
        idsAdicionais
          .map((adicionalRecebido) => {
            const id = String(
              adicionalRecebido._id ||
                adicionalRecebido.id ||
                adicionalRecebido,
            );

            const adicional =
              adicionaisDisponiveis.get(id);

            if (!adicional) {
              return null;
            }

            return {
              nome: adicional.nome,
              preco: Number(
                adicional.preco || 0,
              ),
            };
          })
          .filter(Boolean);

      const valorAdicionais =
        adicionaisEscolhidos.reduce(
          (soma, adicional) =>
            soma +
            Number(adicional.preco || 0),
          0,
        );

      const precoBase = Number(
        produto.preco || 0,
      );

      const preco =
        precoBase + valorAdicionais;

      const custoUnitario = Number(
        produto.custo || 0,
      );

      const subtotal =
        preco * quantidade;

      itens.push({
        produtoId: produto._id,
        nome: produto.nome,
        quantidade,
        preco,
        subtotal,
        adicionais:
          adicionaisEscolhidos,
        observacao: String(
          itemRecebido.observacao ||
            "",
        ).trim(),
      });

      total += subtotal;
      custo +=
        custoUnitario * quantidade;
    }

    if (!itens.length) {
      return res.status(400).json({
        success: false,
        message:
          "Nenhum produto válido foi encontrado.",
      });
    }

    const pedido =
      await Pedido.create({
        estabelecimentoId:
          mesa.estabelecimentoId,
        mesaId: mesa._id,
        cliente: String(
          req.body.cliente ||
            `Mesa ${mesa.numero}`,
        ).trim(),
        canal: "mesa",
        itens,
        observacao: String(
          req.body.observacao || "",
        ).trim(),
        total,
        custo,
        status: "novo",
        pagamentoStatus:
          "pendente",
      });

    mesa.status = "ocupada";
    await mesa.save();

    return res.status(201).json({
      success: true,
      message:
        "Pedido enviado com sucesso.",
      pedidoId: pedido._id,
      numeroPedido:
        String(pedido._id)
          .slice(-6)
          .toUpperCase(),
      total,
      itens: itens.map((item) => ({
        produtoId: item.produtoId,
        nome: item.nome,
      })),
    });
  } catch (error) {
    console.error(
      "Erro ao criar pedido:",
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        "Não foi possível enviar o pedido.",
    });
  }
};



exports.avaliarPedidoMesa = async (
  req,
  res,
) => {
  try {
    const mesa = await Mesa.findOne({
      token: req.params.token,
      status: {
        $ne: "inativa",
      },
    }).lean();

    if (!mesa) {
      return res.status(404).json({
        success: false,
        message: "Mesa não encontrada.",
      });
    }

    const pedido = await Pedido.findOne({
      _id: req.params.pedidoId,
      estabelecimentoId:
        mesa.estabelecimentoId,
      mesaId: mesa._id,
      status: {
        $ne: "cancelado",
      },
    }).lean();

    if (!pedido) {
      return res.status(404).json({
        success: false,
        message:
          "Pedido não encontrado para esta mesa.",
      });
    }

    const avaliacoesRecebidas =
      Array.isArray(req.body.avaliacoes)
        ? req.body.avaliacoes
        : [];

    if (!avaliacoesRecebidas.length) {
      return res.status(400).json({
        success: false,
        message:
          "Envie pelo menos uma avaliação.",
      });
    }

    const produtosDoPedido = new Set(
      (pedido.itens || []).map(
        (item) =>
          String(item.produtoId),
      ),
    );

    const operacoes = [];

    for (
      const avaliacao of
        avaliacoesRecebidas
    ) {
      const produtoId = String(
        avaliacao.produtoId || "",
      );

      const nota = Math.round(
        Number(avaliacao.nota),
      );

      if (
        !produtosDoPedido.has(produtoId) ||
        nota < 1 ||
        nota > 5
      ) {
        continue;
      }

      operacoes.push({
        updateOne: {
          filter: {
            pedidoId: pedido._id,
            produtoId,
          },
          update: {
            $set: {
              estabelecimentoId:
                mesa.estabelecimentoId,
              mesaId: mesa._id,
              cliente:
                pedido.cliente ||
                `Mesa ${mesa.numero}`,
              nota,
              comentario: String(
                avaliacao.comentario ||
                  "",
              )
                .trim()
                .slice(0, 500),
            },
          },
          upsert: true,
        },
      });
    }

    if (!operacoes.length) {
      return res.status(400).json({
        success: false,
        message:
          "Nenhuma avaliação válida foi enviada.",
      });
    }

    await Avaliacao.bulkWrite(
      operacoes,
      {
        ordered: false,
      },
    );

    return res.json({
      success: true,
      message:
        "Obrigado pela sua avaliação!",
    });
  } catch (error) {
    console.error(
      "Erro ao avaliar pedido da mesa:",
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        "Não foi possível salvar a avaliação.",
    });
  }
};

function horarioEmMinutos(horario) {
  const [hora, minuto] =
    String(horario || "00:00")
      .split(":")
      .map(Number);

  return hora * 60 + minuto;
}

function obterDataSaoPaulo() {
  const partes =
    new Intl.DateTimeFormat(
      "pt-BR",
      {
        timeZone:
          "America/Sao_Paulo",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      },
    ).formatToParts(new Date());

  const nomeDia = String(
    partes.find(
      (parte) =>
        parte.type === "weekday",
    )?.value || "",
  )
    .replace(".", "")
    .toLowerCase();

  const dias = {
    dom: 0,
    seg: 1,
    ter: 2,
    qua: 3,
    qui: 4,
    sex: 5,
    sáb: 6,
    sab: 6,
  };

  return {
    dia: dias[nomeDia],

    minutos:
      Number(
        partes.find(
          (parte) =>
            parte.type === "hour",
        )?.value || 0,
      ) *
        60 +
      Number(
        partes.find(
          (parte) =>
            parte.type === "minute",
        )?.value || 0,
      ),
  };
}

function estabelecimentoAberto(
  configuracao,
) {
  const horarioAbertura =
    configuracao.horarioAbertura ||
    "08:00";

  const horarioFechamento =
    configuracao.horarioFechamento ||
    "22:00";

  const diasFuncionamento =
    Array.isArray(
      configuracao.diasFuncionamento,
    )
      ? configuracao.diasFuncionamento
      : [0, 1, 2, 3, 4, 5, 6];

  const atual =
    obterDataSaoPaulo();

  const funcionaHoje =
    diasFuncionamento.includes(
      atual.dia,
    );

  if (!funcionaHoje) {
    return false;
  }

  const abertura =
    horarioEmMinutos(
      horarioAbertura,
    );

  const fechamento =
    horarioEmMinutos(
      horarioFechamento,
    );

  if (abertura === fechamento) {
    return true;
  }

  if (abertura < fechamento) {
    return (
      atual.minutos >= abertura &&
      atual.minutos < fechamento
    );
  }

  return (
    atual.minutos >= abertura ||
    atual.minutos < fechamento
  );
}

/*
|--------------------------------------------------------------------------
| CRIAR PEDIDO DO CATÁLOGO
|--------------------------------------------------------------------------
*/

exports.criarPedidoCatalogo =
  async (req, res) => {
    try {
      const configuracao =
        await Configuracao.findOne({
          slug: req.params.slug,
        }).lean();

      if (!configuracao) {
        return res.status(404).json({
          success: false,
          message:
            "Estabelecimento não encontrado.",
        });
      }

      if (
        !estabelecimentoAberto(
          configuracao,
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "O estabelecimento está fechado neste momento.",
        });
      }

      const cliente = String(
        req.body.cliente || "",
      ).trim();

      const telefone = String(
        req.body.telefone || "",
      ).trim();

      const canal = String(
        req.body.canal || "",
      ).trim();

      const enderecoEntrega =
        String(
          req.body.enderecoEntrega ||
            "",
        ).trim();

      const observacao = String(
        req.body.observacao || "",
      ).trim();

      const emailCliente = String(
        req.body.emailCliente || req.body.email || "",
      )
        .trim()
        .toLowerCase();

      // A forma de pagamento precisa ser lida nesta função, pois esta é a
      // implementação final exportada pelo controller. Aceita também nomes
      // antigos enviados por versões anteriores do catálogo.
      const formaPagamentoOriginal = String(
        req.body.formaPagamento ||
        req.body.metodoPagamento ||
        req.body.pagamentoMetodo ||
        "nao_informado",
      ).trim().toLowerCase();

      const mapaFormaPagamento = {
        dinheiro: "dinheiro",
        dinheiro_entrega: "dinheiro",
        dinheiro_na_entrega: "dinheiro",
        cash: "dinheiro",
        pix: "pix",
        pix_online: "pix",
        cartao: "cartao",
        cartão: "cartao",
        cartao_entrega: "cartao",
        cartao_na_entrega: "cartao",
        card: "cartao",
      };

      const formaPagamento =
        mapaFormaPagamento[formaPagamentoOriginal] ||
        "nao_informado";

      if (formaPagamento === "pix") {
        const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          emailCliente,
        );

        if (!emailValido) {
          return res.status(400).json({
            success: false,
            message: "Informe um e-mail válido para gerar o pagamento Pix.",
          });
        }
      }

      const precisaTroco =
        formaPagamento === "dinheiro" &&
        ["true", "1", "sim", "on"].includes(
          String(req.body.precisaTroco || "")
            .trim()
            .toLowerCase(),
        );

      const trocoTexto = String(
        req.body.trocoPara ?? "",
      )
        .replace(/\s/g, "")
        .replace(/R\$/gi, "")
        .replace(/\./g, "")
        .replace(",", ".");

      const trocoParaRecebido = Number(trocoTexto);

      if (
        precisaTroco &&
        (!Number.isFinite(trocoParaRecebido) ||
          trocoParaRecebido <= 0)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Informe para quanto o cliente precisa de troco.",
        });
      }

      const canaisPermitidos = [
        "delivery",
        "retirada",
      ];

      if (
        !cliente ||
        !telefone
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Informe seu nome e WhatsApp.",
        });
      }

      if (
        !canaisPermitidos.includes(
          canal,
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Tipo de pedido inválido.",
        });
      }

      if (
        canal === "delivery" &&
        !enderecoEntrega
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Informe o endereço de entrega.",
        });
      }

      const itensRecebidos =
        Array.isArray(req.body.itens)
          ? req.body.itens
          : [];

      if (!itensRecebidos.length) {
        return res.status(400).json({
          success: false,
          message:
            "O carrinho está vazio.",
        });
      }

      const idsProdutos =
        itensRecebidos
          .map(
            (item) =>
              item.produtoId,
          )
          .filter(Boolean);

      const produtos =
        await Produto.find({
          _id: {
            $in: idsProdutos,
          },

          estabelecimentoId:
            configuracao.estabelecimentoId,

          ativo: true,
        }).lean();

      const produtosMap =
        new Map(
          produtos.map(
            (produto) => [
              String(produto._id),
              produto,
            ],
          ),
        );

      const itens = [];
      let total = 0;
      let custo = 0;

      for (
        const itemRecebido of
        itensRecebidos
      ) {
        const produto =
          produtosMap.get(
            String(
              itemRecebido.produtoId,
            ),
          );

        if (!produto) {
          continue;
        }

        const quantidade =
          Math.max(
            1,
            Math.min(
              99,
              Number(
                itemRecebido.quantidade,
              ) || 1,
            ),
          );

        const precoBase = Number(
          produto.preco || 0,
        );

        const adicionaisDisponiveis =
          new Map(
            (produto.adicionais || [])
              .filter(adicional => adicional.ativo !== false)
              .map(adicional => [
                String(adicional._id),
                adicional,
              ]),
          );

        const adicionaisRecebidos =
          Array.isArray(itemRecebido.adicionais)
            ? itemRecebido.adicionais
            : [];

        const adicionais = [];
        const idsAdicionais = new Set();

        for (const adicionalRecebido of adicionaisRecebidos) {
          const adicionalId = String(
            adicionalRecebido?._id ||
            adicionalRecebido?.id ||
            adicionalRecebido || "",
          );

          if (!adicionalId || idsAdicionais.has(adicionalId)) {
            continue;
          }

          const adicional = adicionaisDisponiveis.get(adicionalId);
          if (!adicional) {
            continue;
          }

          idsAdicionais.add(adicionalId);
          adicionais.push({
            nome: adicional.nome,
            preco: Number(adicional.preco || 0),
          });
        }

        const valorAdicionais = adicionais.reduce(
          (soma, adicional) => soma + Number(adicional.preco || 0),
          0,
        );

        const preco = precoBase + valorAdicionais;

        const custoUnitario = Number(
          produto.custo || 0,
        );

        const subtotal = preco * quantidade;

        itens.push({
          produtoId: produto._id,
          nome: produto.nome,
          quantidade,
          preco,
          subtotal,
          adicionais,
          observacao: String(itemRecebido.observacao || "").trim(),
        });

        total += subtotal;
        custo +=
          custoUnitario *
          quantidade;
      }

      if (!itens.length) {
        return res.status(400).json({
          success: false,
          message:
            "Nenhum produto válido foi encontrado.",
        });
      }

      if (
        precisaTroco &&
        trocoParaRecebido < total
      ) {
        return res.status(400).json({
          success: false,
          message:
            `O valor para troco deve ser igual ou maior que o total de R$ ${total
              .toFixed(2)
              .replace(".", ",")}.`,
        });
      }

      const pedido =
        await Pedido.create({
          estabelecimentoId:
            configuracao.estabelecimentoId,

          cliente,
          emailCliente:
            formaPagamento === "pix"
              ? emailCliente
              : "",
          telefoneCliente: telefone,
          telefoneNormalizado:
            normalizarTelefonePublico(telefone),

          canal,

          enderecoEntrega:
            canal === "delivery"
              ? enderecoEntrega
              : "",

          itens,
          observacao,
          total,
          custo,

          status: "novo",

          pagamentoStatus:
            "pendente",

          formaPagamento,

          pagamentoInformadoEm:
            formaPagamento === "pix"
              ? null
              : new Date(),

          precisaTroco,

          trocoPara:
            precisaTroco
              ? trocoParaRecebido
              : null,

          valorTroco:
            precisaTroco
              ? Math.max(
                  0,
                  trocoParaRecebido - total,
                )
              : null,
        });

      return res.status(201).json({
        success: true,

        message:
          "Pedido enviado com sucesso.",

        pedidoId: pedido._id,

        numeroPedido:
          String(pedido._id)
            .slice(-6)
            .toUpperCase(),

        canal,

        total,
      });
    } catch (error) {
      console.error(
        "Erro ao criar pedido do catálogo:",
        error,
      );

      return res.status(500).json({
        success: false,

        message:
          "Não foi possível enviar o pedido.",
      });
    }
  };

/* PUBLIC CATALOG: order history and ratings */
function normalizarTelefonePublico(value = "") {
  return String(value).replace(/\D/g, "").slice(-11);
}

exports.buscarPedidosCatalogo = async (req, res) => {
  try {
    const configuracao = await Configuracao.findOne({ slug: req.params.slug }).lean();
    if (!configuracao) return res.status(404).json({ success: false, message: "Loja não encontrada." });
    const telefone = normalizarTelefonePublico(req.query.telefone);
    if (telefone.length < 10) return res.status(400).json({ success: false, message: "Informe um telefone válido." });
    const telefoneRegex = new RegExp(
      telefone.split("").join("\\D*"),
    );

    const pedidos = await Pedido.find({
      estabelecimentoId: configuracao.estabelecimentoId,
      $or: [
        { telefoneNormalizado: telefone },
        { telefoneCliente: telefoneRegex },
      ],
    }).sort({ createdAt: -1 }).limit(30).lean();
    return res.json({ success: true, pedidos: pedidos.map(p => ({
      id: String(p._id),
      numero: String(p._id).slice(-6).toUpperCase(),
      cliente: p.cliente,
      canal: p.canal,
      itens: p.itens || [],
      observacao: p.observacao || "",
      total: p.total,
      status: p.status,
      pagamentoStatus: p.pagamentoStatus,
      formaPagamento: p.formaPagamento,
      createdAt: p.createdAt,
    })) });
  } catch (error) {
    console.error("Erro ao consultar pedidos do catálogo:", error);
    return res.status(500).json({ success: false, message: "Não foi possível consultar os pedidos." });
  }
};

exports.avaliarProdutoCatalogo = async (req, res) => {
  try {
    const configuracao = await Configuracao.findOne({ slug: req.params.slug }).lean();
    if (!configuracao) return res.status(404).json({ success: false, message: "Loja não encontrada." });
    const telefone = normalizarTelefonePublico(req.body.telefone);
    const nota = Number(req.body.nota);
    if (telefone.length < 10 || nota < 1 || nota > 5) return res.status(400).json({ success: false, message: "Telefone ou nota inválida." });
    const pedido = await Pedido.findOne({
      estabelecimentoId: configuracao.estabelecimentoId,
      telefoneNormalizado: telefone,
      pagamentoStatus: "pago",
      "itens.produtoId": req.params.produtoId,
    }).sort({ createdAt: -1 });
    if (!pedido) return res.status(403).json({ success: false, message: "A avaliação é liberada após uma compra paga deste produto." });
    await Avaliacao.findOneAndUpdate(
      { pedidoId: pedido._id, produtoId: req.params.produtoId },
      { $set: { estabelecimentoId: configuracao.estabelecimentoId, pedidoId: pedido._id, produtoId: req.params.produtoId, cliente: pedido.cliente, nota, comentario: String(req.body.comentario || "").trim() } },
      { upsert: true, returnDocument: "after", runValidators: true }
    );
    return res.json({ success: true, message: "Avaliação salva." });
  } catch (error) {
    console.error("Erro ao avaliar produto:", error);
    return res.status(500).json({ success: false, message: "Não foi possível salvar a avaliação." });
  }
};

/* REMOTE PRINT AGENT */
exports.gerarCodigoAgente = async (req, res) => {
  try {
    const lojaId = estabelecimentoId(req);
    const codigo = String(crypto.randomInt(100000, 999999));
    await PrintAgent.findOneAndUpdate({ estabelecimentoId: lojaId }, {
      $set: { codigoVinculacao: codigo, codigoExpiraEm: new Date(Date.now() + 15 * 60 * 1000), ativo: true }
    }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
    return res.json({ success: true, codigo, expiraEm: new Date(Date.now() + 15 * 60 * 1000) });
  } catch (error) { return res.status(500).json({ success: false, message: "Não foi possível gerar o código." }); }
};

exports.statusAgente = async (req, res) => {
  const lojaId = String(estabelecimentoId(req));
  const agente = await PrintAgent.findOne({ estabelecimentoId: lojaId }).lean();
  return res.json({ success: true, online: printAgentHub.isOnline(lojaId), agente: agente ? { nomeComputador: agente.nomeComputador, ultimaConexao: agente.ultimaConexao, impressoras: agente.impressoras || [] } : null });
};

exports.impressorasAgente = async (req, res) => {
  try { const data = await printAgentHub.request(String(estabelecimentoId(req)), "printers:list", {}, 10000); return res.json({ success: true, printers: data }); }
  catch (error) { return res.status(503).json({ success: false, message: error.message }); }
};

exports.testarImpressoraRemota = async (req, res) => {
  try { const data = await printAgentHub.request(String(estabelecimentoId(req)), "printer:test", { impressora: req.body.impressora }, 20000); return res.json({ success: true, ...data }); }
  catch (error) { return res.status(503).json({ success: false, message: error.message }); }
};

exports.imprimirPedidoRemoto = async (req, res) => {
  try {
    const payloadResponse = { req: { ...req, params: { id: req.params.id } } };
    const lojaId = String(estabelecimentoId(req));
    const [pedido, configuracao, dono] = await Promise.all([
      Pedido.findOne({ _id: req.params.id, estabelecimentoId: lojaId }).populate("mesaId", "numero setor").lean(),
      Configuracao.findOne({ estabelecimentoId: lojaId }).lean(),
      registroModel.findById(lojaId).select("cpfCnpj").lean(),
    ]);
    if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
    const payload = {
      estabelecimento: {
        nome: configuracao?.nomeEstabelecimento || "ComandaFacil",
        telefone: configuracao?.telefone || "",
        endereco: configuracao?.endereco || "",
        cpfCnpj: dono?.cpfCnpj || "",
        logoUrl: configuracao?.fotoPerfil || "",
      },
      impressoras: configuracao?.impressoras || [], modo: req.body.modo || "manual",
      pedido: { id: String(pedido._id), numero: String(pedido._id).slice(-6).toUpperCase(), origem: pedido.canal === "delivery" ? "Delivery" : pedido.canal === "mesa" ? `Mesa ${pedido.mesaId?.numero || ""}` : "Retirada", canal: pedido.canal, cliente: pedido.cliente, telefone: pedido.telefoneCliente || "", endereco: pedido.enderecoEntrega || "", observacao: pedido.observacao || "", total: pedido.total, status: pedido.status, pagamentoStatus: pedido.pagamentoStatus, formaPagamento: pedido.formaPagamento || pedido.metodoPagamento || pedido.pagamentoMetodo || "nao_informado", pagamentoInformadoEm: pedido.pagamentoInformadoEm || null, pagoEm: pedido.pagoEm || null, precisaTroco: Boolean(pedido.precisaTroco), trocoPara: pedido.trocoPara ?? null, valorTroco: pedido.valorTroco ?? null, createdAt: pedido.createdAt, itens: pedido.itens || [] }
    };
    const data = await printAgentHub.request(lojaId, "print:job", payload, 30000);
    return res.json({ success: true, ...data });
  } catch (error) { return res.status(503).json({ success: false, message: error.message }); }
};

exports.buscarImpressorasRedeRemotas = async (req,res) => {
 try { const data=await printAgentHub.request(String(estabelecimentoId(req)), "network:scan", {}, 120000); return res.json({success:true,devices:data}); }
 catch(error){return res.status(503).json({success:false,message:error.message});}
};
