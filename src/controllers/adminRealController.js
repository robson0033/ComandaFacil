const { logger: appLogger } = require("../utils/logger");

const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const { validatePassword } = require("../utils/passwordPolicy");
const crypto = require("crypto");
const mongoose = require("mongoose");

const { registroModel } = require("../models/registroModel");

const {
  Assinatura,
  Categoria,
  Estoque,
  Produto,
  Mesa,
  Funcionario,
  Configuracao,
  CidadeEntrega,
  Pedido,
  Avaliacao,
  PrintAgent,
  PrintJob,
  OrderLookupVerification,
  WhatsAppConfiguracao,
  WhatsAppConversa,
  WhatsAppMensagem,
} = require("../models/painelModels");
const {
  enviarCodigoConsultaPedidos,
  enviarConfirmacaoPedido,
} = require("../services/emailService");

const printAgentHub = require("../services/printAgentHub");
const printQueueService = require("../services/printQueueService");
const {
  BLOCKING_PRINT_STATUSES,
  MANUAL_PRINT_COOLDOWN_MS,
  evaluateManualPrintRequest,
} = require("../services/manualPrintGuard");
const { normalizeRightMarginMm } = require("../services/printerLayoutConfig");
const {
  datePartsInTimezone,
  formatDateTimeInTimezone,
  getEstablishmentTimezone,
  localDateTimeToUtc,
} = require("../services/timezoneService");
const {
  buscarProdutosPublicosDoEstabelecimento,
} = require("../services/produtoPublicoService");
const {
  MINIMUM_AGENT_VERSION,
  PROTOCOL_VERSION,
} = require("../services/printAgentProtocol");
const { formatarNumeroPedido } = require("../services/pedidoNumeroService");
const {
  consultarAcessoVenda,
  respostaLojaIndisponivel,
} = require("../services/assinaturaAcessoService");
const {
  buscarPedidoPorToken,
  extrairBearerToken,
  serializarPedidoPublico,
} = require("../services/pedidoPublicoTokenService");
const {
  codigoFinalValido,
  codigoPublicoValido,
  normalizarCodigoPublico,
} = require("../services/pedidoPublicCodeService");

function numeroPedidoExibicao(pedido = {}) {
  return formatarNumeroPedido(pedido.numeroPedido)
    || String(pedido.codigoPublico || pedido._id || "")
      .slice(pedido.codigoPublico ? 0 : -6)
      .toUpperCase();
}
const {
  carregarIdentidadeAtual,
  encerrarSessao,
} = require("../middleware/auth");
const {
  baixarEstoqueDoPedido,
  converterQuantidade,
  restaurarEstoqueDoPedido,
} = require("../services/estoqueService");
const {
  arquivarPedido,
} = require("../services/pedidoArquivamentoService");
const {
  registrarAuditoria,
} = require("../services/auditoriaService");
const { processImage, UploadError } = require("../uploads/imageProcessor");
const storageService = require("../services/storageService");
const appState = require("../runtime/appState");
const {
  ALL_PERMISSIONS,
  CRITICAL_PERMISSIONS,
} = require("../config/permissions");
const {
  readFlash,
  safeFlash,
  saveSessionOrRun,
} = require("../utils/safeFlash");
const {
  PUBLIC_ORDER_LIMITS,
  text: publicText,
  validatePublicOrderBase,
} = require("../utils/publicOrderValidation");
const {
  avaliarRegraEntregaCidade,
  calcularTotaisPedidoComEntrega,
  montarDadosCidadeEntrega,
  validarTaxaEntregaCentavos,
} = require("../services/cidadeEntregaService");
const {
  distribuirPagamentosPorPedidos,
  montarPlanoPagamentoCatalogo,
  montarPlanoPagamentoMesa,
  normalizarPagamentosPedido,
  totalParaCentavos,
  valorFormaPagamentoCentavos,
} = require("../services/mesaPagamentoService");
const {
  filtrarComandasMesaParaPainel,
  montarComandasMesaAbertas,
} = require("../services/mesaComandaPainelService");
const {
  montarPedidoComandaMesaParaImpressao,
} = require("../services/mesaComandaImpressaoService");
const {
  montarPizzaMeioAMeio,
  normalizarIdsSabores,
  resolverTamanhoEPrecoPizza,
} = require("../services/pizzaMeioAMeioService");
const {
  phoneNumberIdHash,
} = require("../services/whatsappAutomationService");
const whatsappCloudApi = require("../services/whatsappCloudApiService");

function exigirMovimentacaoEstoqueConcluida(resultado) {
  if (resultado?.success
    && [
      "concluido",
      "ja_concluido",
      "restaurado",
      "ja_restaurado",
      "nao_baixado",
    ].includes(resultado.status)) {
    return resultado;
  }
  const error = new Error(
    resultado?.status === "lock_ocupado"
      ? "O estoque deste pedido está sendo processado. Tente novamente."
      : "Não foi possível concluir a movimentação de estoque.",
  );
  error.code = resultado?.errorCode || "ESTOQUE_NAO_CONCLUIDO";
  error.retryable = Boolean(resultado?.retryable);
  throw error;
}

function adicionarHistoricoFinanceiro(pedido, entrada) {
  const operationKey = String(entrada.operationKey || "");
  pedido.historicoFinanceiro = Array.isArray(pedido.historicoFinanceiro)
    ? pedido.historicoFinanceiro
    : [];
  if (operationKey && pedido.historicoFinanceiro.some(item =>
    String(item.operationKey || "") === operationKey)) {
    return false;
  }
  const pagamentos = Array.isArray(entrada.pagamentos)
    ? entrada.pagamentos
    : Array.isArray(pedido.pagamentos)
      ? pedido.pagamentos
      : [];
  pedido.historicoFinanceiro.push({
    tipo: entrada.tipo,
    status: entrada.statusNovo || entrada.status || "",
    statusAnterior: entrada.statusAnterior || "",
    statusNovo: entrada.statusNovo || "",
    formaPagamento: entrada.formaPagamento || pedido.formaPagamento || "",
    pagamentos: pagamentos.map(item => ({
      formaPagamento: String(item?.formaPagamento || ""),
      valorCentavos: Number(item?.valorCentavos || 0),
    })),
    valor: Number(entrada.valor ?? pedido.total ?? 0),
    usuarioId: entrada.usuarioId || null,
    motivo: entrada.motivo || "",
    operationKey,
    registradoEm: new Date(),
  });
  return true;
}

async function confirmarPedidoComEstoque(
  pedido,
  {
    formaPagamento = pedido.formaPagamento,
    pagamentos = Array.isArray(pedido.pagamentos)
      ? pedido.pagamentos
      : null,
    finalizar = false,
    usuarioId = null,
    tipo = finalizar ? "pagamento_mesa" : "pagamento_manual",
    motivo = "",
  } = {},
  baixar = baixarEstoqueDoPedido,
) {
  const statusAnterior = pedido.pagamentoStatus || "pendente";
  const operationKey = `${tipo}:${pedido._id}`;
  const planoPagamento = normalizarPagamentosPedido({
    formaPagamento,
    pagamentos,
    totalCentavos: totalParaCentavos(pedido.total || 0),
  });
  try {
    exigirMovimentacaoEstoqueConcluida(await baixar(pedido._id));
  } catch (error) {
    adicionarHistoricoFinanceiro(pedido, {
      tipo: "falha_estoque_pagamento",
      statusAnterior,
      statusNovo: statusAnterior,
      formaPagamento: planoPagamento.formaPagamento,
      pagamentos: planoPagamento.pagamentos,
      usuarioId,
      motivo: error.message,
      operationKey: `falha:${operationKey}:${error.code || "erro"}`,
    });
    await pedido.save();
    throw error;
  }
  pedido.pagamentoStatus = "pago";
  pedido.formaPagamento = planoPagamento.formaPagamento;
  pedido.pagamentos = planoPagamento.pagamentos;
  pedido.pagoEm = pedido.pagoEm || new Date();
  if (finalizar) pedido.status = "finalizado";
  adicionarHistoricoFinanceiro(pedido, {
    tipo,
    statusAnterior,
    statusNovo: "pago",
    formaPagamento: pedido.formaPagamento,
    pagamentos: pedido.pagamentos,
    usuarioId,
    motivo,
    operationKey,
  });
  await pedido.save();
  return pedido;
}

async function montarFichaTecnicaProduto(
  body,
  idEstabelecimento,
  { fichaAnterior = [] } = {},
) {
  const ids = body.fichaEstoqueId === undefined
    ? []
    : [].concat(body.fichaEstoqueId);
  const quantidades = body.fichaQuantidade === undefined
    ? []
    : [].concat(body.fichaQuantidade);
  const unidades = body.fichaUnidade === undefined
    ? []
    : [].concat(body.fichaUnidade);
  const tamanho = Math.max(ids.length, quantidades.length, unidades.length);
  const linhas = [];
  const duplicados = new Set();
  const unidadesPermitidas = new Set(["g", "kg", "ml", "l", "un"]);

  for (let indice = 0; indice < tamanho; indice += 1) {
    const estoqueId = String(ids[indice] || "").trim();
    const quantidadeBruta = String(quantidades[indice] || "").trim();
    const unidade = String(unidades[indice] || "").trim().toLowerCase();
    if (!estoqueId && !quantidadeBruta && !unidade) continue;
    if (!estoqueId || !quantidadeBruta || !unidade) {
      throw new Error(`Linha ${indice + 1} da ficha técnica está incompleta.`);
    }
    if (!mongoose.isValidObjectId(estoqueId)) {
      throw new Error(`Ingrediente inválido na linha ${indice + 1}.`);
    }
    const quantidade = Number(quantidadeBruta.replace(",", "."));
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new Error(`Quantidade inválida na linha ${indice + 1}.`);
    }
    if (!unidadesPermitidas.has(unidade)) {
      throw new Error(`Unidade inválida na linha ${indice + 1}.`);
    }
    if (duplicados.has(estoqueId)) {
      throw new Error("Ingredientes duplicados não são permitidos.");
    }
    duplicados.add(estoqueId);
    linhas.push({ estoqueId, quantidade, unidade });
  }

  if (!linhas.length) return [];
  const idsAnteriores = new Set(
    fichaAnterior.map(item => String(item.estoqueId?._id || item.estoqueId)),
  );
  const estoques = await Estoque.find({
    _id: { $in: linhas.map(item => item.estoqueId) },
    estabelecimentoId: idEstabelecimento,
  }).lean();
  const mapa = new Map(estoques.map(item => [String(item._id), item]));
  if (mapa.size !== linhas.length) {
    throw new Error("Um ingrediente não pertence a este estabelecimento.");
  }
  return linhas.map(item => {
    const estoque = mapa.get(item.estoqueId);
    if (estoque.ativo === false && !idsAnteriores.has(item.estoqueId)) {
      const error = new Error(
        "Ingrediente desativado não pode ser adicionado à ficha técnica.",
      );
      error.code = "INGREDIENTE_DESATIVADO";
      throw error;
    }
    return {
      estoqueId: estoque._id,
      nome: estoque.nome,
      quantidade: item.quantidade,
      unidade: item.unidade,
      custoCalculado: Number(
        (
          converterQuantidade(
            item.quantidade,
            item.unidade,
            estoque.unidade,
          ) * Number(estoque.custoUnitario || 0)
        ).toFixed(4),
      ),
    };
  });
}

async function validarFichaAntesDeSalvar(
  fichaTecnica,
  idEstabelecimento,
  fichaAnterior = [],
) {
  const idsLegados = new Set(
    fichaAnterior.map(item => String(item.estoqueId?._id || item.estoqueId)),
  );
  const idsQuePrecisamEstarAtivos = [...new Set(
    fichaTecnica
      .map(item => String(item.estoqueId?._id || item.estoqueId))
      .filter(id => !idsLegados.has(id)),
  )];
  if (!idsQuePrecisamEstarAtivos.length) return;
  const quantidade = await Estoque.countDocuments({
    _id: { $in: idsQuePrecisamEstarAtivos },
    estabelecimentoId: idEstabelecimento,
    ativo: { $ne: false },
  });
  if (quantidade !== idsQuePrecisamEstarAtivos.length) {
    const error = new Error(
      "Um ingrediente foi desativado antes da ficha ser salva.",
    );
    error.code = "INGREDIENTE_DESATIVADO";
    throw error;
  }
}

function idsDeIngredientesDesativadosReferenciados(estoque, produtos) {
  const idsEstoqueAtivo = new Set(
    estoque.map(item => String(item._id)),
  );
  return [...new Set(
    produtos.flatMap(produto =>
      (produto.fichaTecnica || [])
        .map(item => String(item.estoqueId?._id || item.estoqueId))
        .filter(id => id && !idsEstoqueAtivo.has(id))),
  )];
}

async function armazenarUploadImagem(file, category, idEstabelecimento, resource) {
  if (!file) return null;
  const processed = await processImage(file.buffer, category);
  const saved = await storageService.saveImage(processed.buffer, {
    estabelecimentoId: idEstabelecimento,
    resource,
    extension: processed.extension,
  });
  return {
    storageKey: saved.storageKey,
    url: saved.url,
    mimeType: saved.mimeType || processed.mimeType,
    largura: saved.largura || processed.width,
    altura: saved.altura || processed.height,
    tamanho: saved.tamanho || processed.size,
    provider: saved.provider,
    atualizadoEm: new Date(),
  };
}

async function removerUploadSemOcultarErro(metadata, idEstabelecimento) {
  if (!metadata?.storageKey) return;
  await storageService.removeImage(metadata.storageKey, {
    estabelecimentoId: idEstabelecimento,
  });
}

function responderErroUpload(req, res, error, section, fallback) {
  const isImageError = error instanceof UploadError;
  const isStorageError = error instanceof storageService.StorageError;
  if (!isImageError && !isStorageError) return null;
  return res.status(error.status || error.statusCode || 503).json({
    code: error.code,
    message: error.message || fallback,
  });
}

function erroValidacao(message) {
  const error = new Error(message);
  error.code = "VALIDATION_ERROR";
  error.statusCode = 422;
  return error;
}

function responderErroValidacao(req, res, error, section) {
  if (error?.code !== "VALIDATION_ERROR") return null;
  if (
    req.xhr
    || String(req.get?.("accept") || "").includes("application/json")
  ) {
    return res.status(422).json({
      success: false,
      code: "VALIDATION_ERROR",
      message: error.message,
      correlationId: req.correlationId,
    });
  }
  return erroERedirecionar(req, res, section, error.message);
}



/*
|--------------------------------------------------------------------------
| FUNÇÕES AUXILIARES
|--------------------------------------------------------------------------
*/

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

  if (nomes.length !== precos.length) {
    throw erroValidacao("Preencha o nome e o preço de todos os adicionais.");
  }
  if (nomes.length > 30) {
    throw erroValidacao("Um produto pode possuir no máximo 30 adicionais.");
  }
  const vistos = new Set();
  return nomes.map((nomeRecebido, index) => {
    const nome = String(nomeRecebido || "").trim();
    const preco = Number(precos[index]);
    if (!nome || nome.length > 120) {
      throw erroValidacao("O nome do adicional deve possuir entre 1 e 120 caracteres.");
    }
    if (!Number.isFinite(preco) || preco < 0 || preco > 100_000) {
      throw erroValidacao("Informe um preço válido e não negativo para o adicional.");
    }
    const chave = nome.toLocaleLowerCase("pt-BR");
    if (vistos.has(chave)) {
      throw erroValidacao("Não repita o mesmo adicional no produto.");
    }
    vistos.add(chave);
    return { nome, preco, ativo: true };
  });
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

    const origemPedidosPermitida = [
      "todas",
      "delivery",
      "mesa",
      "retirada",
      "delivery_retirada",
    ];
    const origemPedidos = origemPedidosPermitida.includes(
      campo("origemPedidos"),
    )
      ? campo("origemPedidos")
      : "todas";

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
      origemPedidos,
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
      margemDireitaMm: normalizeRightMarginMm(campo("margemDireitaMm")),
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

function montarAcessoPainel(usuario = {}) {
  const proprietario =
    usuario.tipo === "proprietario";
  const permissoes = new Set(
    Array.isArray(usuario.permissoes)
      ? usuario.permissoes
      : [],
  );
  const pode = modulo =>
    proprietario ||
    permissoes.has(modulo);

  return {
    podeDashboard: pode("dashboard"),
    podePedidos: pode("pedidos"),
    podeRelatorios: pode("relatorios"),
    podeEstoque: pode("estoque"),
    podeCatalogo: pode("catalogo"),
    podeMesas: pode("mesas"),
    podeFuncionarios:
      pode("funcionarios"),
    podeConfiguracoes:
      pode("configuracoes"),
    podeImprimirPedidos:
      pode("imprimir_pedidos"),
    podeConfigurarImpressoras:
      pode("configurar_impressoras"),
    podeArquivarPedidos:
      pode("arquivar_pedidos"),
  };
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
  if (
    req.xhr
    || String(req.get?.("accept") || "").includes("application/json")
  ) {
    return res.status(200).json({
      success: true,
      message: mensagem,
      section: pagina,
      correlationId: req.correlationId,
    });
  }
  safeFlash(req, "success", mensagem);

  return saveSessionOrRun(req, () => {
    return res.redirect(`/admin#${pagina}`);
  });
}

function erroERedirecionar(
  req,
  res,
  pagina,
  mensagem = "Não foi possível concluir a operação.",
) {
  if (
    req.xhr
    || String(req.get?.("accept") || "").includes("application/json")
  ) {
    return res.status(422).json({
      success: false,
      code: "OPERATION_FAILED",
      message: mensagem,
      section: pagina,
      correlationId: req.correlationId,
    });
  }
  safeFlash(req, "errors", mensagem);

  return saveSessionOrRun(req, () => {
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

  if (assinatura.status === "ativa") {
    if (!assinatura.ultimoPagamentoAprovadoId || !vencimentoPago) {
      const testeAindaValido =
        assinatura.fimTeste &&
        agora < new Date(assinatura.fimTeste);
      assinatura.status = testeAindaValido
        ? "teste"
        : "pendente";
      await assinatura.save();
    } else if (agora > new Date(vencimentoPago)) {
      assinatura.status = "expirada";
      await assinatura.save();
    }
  }

  return assinatura;
}

function calcularDiasRestantes(assinatura) {
  if (!assinatura) {
    return 0;
  }

  let dataFinal = null;

  const testeAindaValido =
    assinatura.fimTeste &&
    new Date(assinatura.fimTeste).getTime() > Date.now();

  if (testeAindaValido) {
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
  {
    completa = false,
    incluirImpressoras = false,
  } = {},
) {
  const consulta =
    Configuracao.findOne({
      estabelecimentoId:
        idEstabelecimento,
    });

  if (!completa) {
    consulta.select([
      "nomeEstabelecimento",
      "fotoPerfil",
      "slug",
      ...(incluirImpressoras
        ? [
            "impressoras",
            "impressaoAutomatica",
          ]
        : []),
    ].join(" "));
  }

  let configuracao = await consulta;

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

function partesDataNoFuso(
  data,
  timeZone,
) {
  const parts = datePartsInTimezone(data, timeZone);
  return {
    ano: parts.year,
    mes: parts.month,
    dia: parts.day,
  };
}

function dataLocalParaUtc(
  {
    ano,
    mes,
    dia,
    hora = 0,
    minuto = 0,
    segundo = 0,
    milissegundo = 0,
  },
  timeZone,
) {
  return localDateTimeToUtc({
    year: ano, month: mes, day: dia, hour: hora, minute: minuto,
    second: segundo, millisecond: milissegundo,
  }, timeZone);
}

function adicionarDiasCalendario(
  partes,
  quantidade,
) {
  const data = new Date(
    Date.UTC(
      partes.ano,
      partes.mes - 1,
      partes.dia + quantidade,
    ),
  );

  return {
    ano: data.getUTCFullYear(),
    mes: data.getUTCMonth() + 1,
    dia: data.getUTCDate(),
  };
}

function obterPeriodoRelatorio(
  filtro,
  dataInicio,
  dataFim,
  agoraReferencia = new Date(),
  timeZone,
) {
  const agora =
    new Date(agoraReferencia);
  const hoje =
    partesDataNoFuso(agora, timeZone);
  let inicio = null;
  let fim = null;
  let filtroFinal = filtro;

  if (filtro === "hoje") {
    inicio = dataLocalParaUtc(
      hoje, timeZone,
    );
    fim = dataLocalParaUtc({
      ...hoje,
      hora: 23,
      minuto: 59,
      segundo: 59,
      milissegundo: 999,
    }, timeZone);
  }

  if (filtro === "semana") {
    const meioDiaHoje =
      dataLocalParaUtc({
        ...hoje,
        hora: 12,
      }, timeZone);
    const nomeDia =
      meioDiaHoje.toLocaleDateString(
        "en-US",
        {
          timeZone,
          weekday: "short",
        },
      );
    const diaSemana = [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ].indexOf(nomeDia);
    const inicioSemana =
      adicionarDiasCalendario(
        hoje,
        diaSemana === 0
          ? -6
          : 1 - diaSemana,
      );
    const fimSemana =
      adicionarDiasCalendario(
        inicioSemana,
        6,
      );

    inicio =
      dataLocalParaUtc(
        inicioSemana,
        timeZone,
      );
    fim = dataLocalParaUtc({
      ...fimSemana,
      hora: 23,
      minuto: 59,
      segundo: 59,
      milissegundo: 999,
    }, timeZone);
  }

  if (filtro === "mes") {
    inicio = dataLocalParaUtc({
      ano: hoje.ano,
      mes: hoje.mes,
      dia: 1,
    }, timeZone);
    fim = new Date(
      dataLocalParaUtc({
        ano:
          hoje.mes === 12
            ? hoje.ano + 1
            : hoje.ano,
        mes:
          hoje.mes === 12
            ? 1
            : hoje.mes + 1,
        dia: 1,
      }, timeZone).getTime() - 1,
    );
  }

  if (filtro === "ano") {
    inicio = dataLocalParaUtc({
      ano: hoje.ano,
      mes: 1,
      dia: 1,
    }, timeZone);
    fim = new Date(
      dataLocalParaUtc({
        ano: hoje.ano + 1,
        mes: 1,
        dia: 1,
      }, timeZone).getTime() - 1,
    );
  }

  if (filtro === "personalizado") {
    const formatoValido =
      /^\d{4}-\d{2}-\d{2}$/;

    if (
      formatoValido.test(dataInicio) &&
      formatoValido.test(dataFim)
    ) {
      const [
        anoInicio,
        mesInicio,
        diaInicio,
      ] = dataInicio
        .split("-")
        .map(Number);
      const [
        anoFim,
        mesFim,
        diaFim,
      ] = dataFim
        .split("-")
        .map(Number);

      inicio = dataLocalParaUtc({
        ano: anoInicio,
        mes: mesInicio,
        dia: diaInicio,
      }, timeZone);

      fim = dataLocalParaUtc({
        ano: anoFim,
        mes: mesFim,
        dia: diaFim,
        hora: 23,
        minuto: 59,
        segundo: 59,
        milissegundo: 999,
      }, timeZone);

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
      inicio =
        dataLocalParaUtc(hoje, timeZone);
      fim = dataLocalParaUtc({
        ...hoje,
        hora: 23,
        minuto: 59,
        segundo: 59,
        milissegundo: 999,
      }, timeZone);
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
  timeZone,
) {
  let labels = [];
  let valores = [];

  if (filtro === "hoje") {
    labels = Array.from({ length: 24 }, (_, hora) => `${String(hora).padStart(2, "0")}h`);
    valores = new Array(24).fill(0);

    pedidos.forEach((pedido) => {
      if (!pedido.pagoEm) return;
      const hora = datePartsInTimezone(pedido.pagoEm, timeZone).hour;
      valores[hora] += Number(
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
        pedido.pagoEm,
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
        pedido.pagoEm,
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
        pedido.pagoEm,
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
        if (!pedido.pagoEm) return;
        const dataPedido = datePartsInTimezone(pedido.pagoEm, timeZone);
        const inicio = datePartsInTimezone(inicioPeriodo, timeZone);

        const indice = Math.floor(
          (Date.UTC(dataPedido.year, dataPedido.month - 1, dataPedido.day) -
            Date.UTC(inicio.year, inicio.month - 1, inicio.day)) /
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
          pedido.pagoEm,
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
          pedido.pagoEm,
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

function filtroBaseRelatorio(
  idEstabelecimento,
  periodo,
  canalAtual = "todos",
  dateField = "createdAt",
) {
  const idNormalizado =
    mongoose.isValidObjectId(
      idEstabelecimento,
    )
      ? new mongoose.Types.ObjectId(
          idEstabelecimento,
        )
      : idEstabelecimento;

  const filtro = {
    estabelecimentoId:
      idNormalizado,
    excluido: { $ne: true },
    status: {
      $ne: "cancelado",
    },
  };

  if (
    periodo?.inicio &&
    periodo?.fim
  ) {
    filtro[dateField] = {
      $gte: periodo.inicio,
      $lte: periodo.fim,
    };
  }

  if (canalAtual !== "todos") {
    filtro.canal =
      canalAtual === "retirada"
        ? {
            $in: [
              "retirada",
              "balcao",
            ],
          }
        : canalAtual;
  }

  return filtro;
}

function pedidoEntraNoFinanceiro(
  pedido,
) {
  return (
    pedido?.status !== "cancelado" &&
    pedido?.pagamentoStatus ===
      "pago"
  );
}

function pedidoContaFinalizado(
  pedido,
) {
  return (
    pedido?.status !== "cancelado" &&
    [
      "finalizado",
      "entregue",
    ].includes(pedido?.status)
  );
}

function formatoDataGrafico(
  filtro,
  periodo,
) {
  if (filtro === "hoje") {
    return "%Y-%m-%d-%H";
  }

  if (
    filtro === "ano" ||
    filtro === "todos"
  ) {
    return "%Y-%m";
  }

  if (
    filtro === "personalizado" &&
    periodo?.inicio &&
    periodo?.fim &&
    (
      periodo.fim.getTime() -
      periodo.inicio.getTime()
    ) > 31 * 86400000
  ) {
    return "%Y-%m";
  }

  return "%Y-%m-%d";
}

function montarGraficoAgregado(
  grupos = [],
  filtro,
  timeZone,
) {
  const mapa = new Map(
    grupos.map(grupo => [
      String(grupo._id),
      Number(grupo.valor || 0),
    ]),
  );
  const quantidades = new Map(
    grupos.map(grupo => [String(grupo._id), Number(grupo.quantidade || 0)]),
  );

  if (filtro === "hoje") {
    const labels = Array.from(
      { length: 24 },
      (_, hora) => `${String(hora).padStart(2, "0")}h`,
    );
    const valores = new Array(24).fill(0);
    const pedidosPagos = new Array(24).fill(0);

    mapa.forEach(
      (valor, chave) => {
        const hora = Number(
          chave.slice(-2),
        );
        if (hora >= 0 && hora <= 23) {
          valores[hora] += valor;
          pedidosPagos[hora] += quantidades.get(chave) || 0;
        }
      },
    );

    return {
      labels,
      valores,
      pedidosPagos,
      maiorValor: Math.max(
        ...valores,
        1,
      ),
    };
  }

  if (filtro === "semana") {
    const labels = [
      "Seg",
      "Ter",
      "Qua",
      "Qui",
      "Sex",
      "Sáb",
      "Dom",
    ];
    const valores =
      new Array(7).fill(0);

    mapa.forEach(
      (valor, chave) => {
        const [ano, mes, dia] =
          chave.split("-").map(Number);
        const data =
          dataLocalParaUtc({
            ano,
            mes,
            dia,
            hora: 12,
          });
        const nomeDia =
          data.toLocaleDateString(
            "en-US",
            {
              timeZone:
                timeZone,
              weekday: "short",
            },
          );
        const diaSemana = [
          "Sun",
          "Mon",
          "Tue",
          "Wed",
          "Thu",
          "Fri",
          "Sat",
        ].indexOf(nomeDia);
        const indice =
          diaSemana === 0
            ? 6
            : diaSemana - 1;
        valores[indice] += valor;
      },
    );

    return {
      labels,
      valores,
      maiorValor: Math.max(
        ...valores,
        1,
      ),
    };
  }

  const ordenados =
    [...mapa.entries()].sort(
      ([a], [b]) =>
        a.localeCompare(b),
    );
  const labels =
    ordenados.map(([chave]) => {
      const partes =
        chave.split("-").map(Number);

      if (partes.length === 2) {
        return new Date(
          Date.UTC(
            partes[0],
            partes[1] - 1,
            1,
          ),
        ).toLocaleDateString(
          "pt-BR",
          {
            timeZone: "UTC",
            month: "short",
            year: "2-digit",
          },
        );
      }

      return `${String(
        partes[2],
      ).padStart(2, "0")}/${String(
        partes[1],
      ).padStart(2, "0")}`;
    });
  const valores =
    ordenados.map(
      ([, valor]) => valor,
    );

  return {
    labels: labels.length
      ? labels
      : ["Sem dados"],
    valores: valores.length
      ? valores
      : [0],
    maiorValor: Math.max(
      ...valores,
      1,
    ),
  };
}


function criarResumoFormasPagamentoVazio() {
  return {
    dinheiro: {
      valorCentavos: 0,
      quantidade: 0,
    },
    pix: {
      valorCentavos: 0,
      quantidade: 0,
    },
    cartao: {
      valorCentavos: 0,
      quantidade: 0,
    },
    naoInformado: {
      valorCentavos: 0,
      quantidade: 0,
    },
    totalCentavos: 0,
  };
}

function chaveResumoFormaPagamento(value) {
  const method = String(value || "")
    .trim()
    .toLowerCase();

  if (method === "dinheiro") return "dinheiro";
  if (method === "cartao") return "cartao";
  if (method === "pix" || method === "pix_online") return "pix";
  return "naoInformado";
}

function normalizarResumoFormasPagamento(rows = []) {
  const summary = criarResumoFormasPagamentoVazio();

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = chaveResumoFormaPagamento(row?._id);
    const valueCents = Number(row?.valorCentavos || 0);
    const quantity = Number(row?.quantidade || 0);

    if (!Number.isFinite(valueCents) || valueCents <= 0) continue;

    const normalizedCents = Math.round(valueCents);
    summary[key].valorCentavos += normalizedCents;
    summary[key].quantidade += Number.isFinite(quantity)
      ? Math.max(0, Math.round(quantity))
      : 0;
    summary.totalCentavos += normalizedCents;
  }

  return summary;
}

function etapasAgregacaoFormasPagamento({
  intervaloPagamento = null,
} = {}) {
  return [
    {
      $match: {
        pagamentoStatus: "pago",
        ...(intervaloPagamento
          ? { pagoEm: intervaloPagamento }
          : {}),
      },
    },
    {
      $project: {
        componentesPagamento: {
          $cond: [
            {
              $gt: [
                {
                  $size: {
                    $ifNull: [
                      "$pagamentos",
                      [],
                    ],
                  },
                },
                0,
              ],
            },
            "$pagamentos",
            [
              {
                formaPagamento: {
                  $ifNull: [
                    "$formaPagamento",
                    "nao_informado",
                  ],
                },
                valorCentavos: {
                  $round: [
                    {
                      $multiply: [
                        {
                          $ifNull: [
                            "$total",
                            0,
                          ],
                        },
                        100,
                      ],
                    },
                    0,
                  ],
                },
              },
            ],
          ],
        },
      },
    },
    {
      $unwind:
        "$componentesPagamento",
    },
    {
      $match: {
        "componentesPagamento.valorCentavos": {
          $gt: 0,
        },
      },
    },
    {
      $group: {
        _id:
          "$componentesPagamento.formaPagamento",
        valorCentavos: {
          $sum: {
            $ifNull: [
              "$componentesPagamento.valorCentavos",
              0,
            ],
          },
        },
        quantidade: {
          $sum: 1,
        },
      },
    },
  ];
}

function montarVendasPorCategoriaProduto({
  categorias = [],
  produtos = [],
  vendas = [],
} = {}) {
  const vendasPorProduto = new Map();

  for (const venda of Array.isArray(vendas) ? vendas : []) {
    const produtoId = String(venda?._id || "").trim();
    if (!produtoId) continue;

    vendasPorProduto.set(produtoId, {
      quantidade: Math.max(0, Number(venda?.quantidade || 0)),
      total: Math.max(0, Number(venda?.total || 0)),
    });
  }

  const produtosPorCategoria = new Map();
  for (const produto of Array.isArray(produtos) ? produtos : []) {
    const categoriaId = String(produto?.categoriaId || "").trim();
    if (!categoriaId) continue;

    const produtoId = String(produto?._id || "").trim();
    const venda = vendasPorProduto.get(produtoId) || { quantidade: 0, total: 0 };
    const item = {
      categoriaId,
      produtoId,
      produtoNome: String(produto?.nome || "Produto").trim() || "Produto",
      quantidade: venda.quantidade,
      total: venda.total,
    };

    if (!produtosPorCategoria.has(categoriaId)) {
      produtosPorCategoria.set(categoriaId, []);
    }
    produtosPorCategoria.get(categoriaId).push(item);
  }

  const linhas = [];
  const categoriasOrdenadas = [...(Array.isArray(categorias) ? categorias : [])]
    .sort((a, b) =>
      String(a?.nome || "").localeCompare(String(b?.nome || ""), "pt-BR", { sensitivity: "base" }),
    );

  for (const categoria of categoriasOrdenadas) {
    const categoriaId = String(categoria?._id || "").trim();
    const categoriaNome = String(categoria?.nome || "Categoria").trim() || "Categoria";
    const produtosCategoria = [...(produtosPorCategoria.get(categoriaId) || [])]
      .sort((a, b) =>
        b.quantidade - a.quantidade
        || a.produtoNome.localeCompare(b.produtoNome, "pt-BR", { sensitivity: "base" }),
      );

    if (!produtosCategoria.length) {
      linhas.push({
        categoriaId,
        categoriaNome,
        produtoId: "",
        produtoNome: "Nenhum produto cadastrado",
        quantidade: 0,
        total: 0,
        semProduto: true,
      });
      continue;
    }

    for (const produto of produtosCategoria) {
      linhas.push({
        ...produto,
        categoriaNome,
        semProduto: false,
      });
    }
  }

  return linhas;
}

function montarResumoVendasPorCategoria(linhas = []) {
  const resumo = new Map();

  for (const linha of Array.isArray(linhas) ? linhas : []) {
    const categoriaId = String(linha?.categoriaId || "").trim();
    const categoriaNome = String(linha?.categoriaNome || "Categoria").trim() || "Categoria";
    const chave = categoriaId || `nome:${categoriaNome.toLocaleLowerCase("pt-BR")}`;
    const atual = resumo.get(chave) || {
      categoriaId,
      categoriaNome,
      quantidade: 0,
      total: 0,
    };

    if (!linha?.semProduto) {
      atual.quantidade += Math.max(0, Number(linha?.quantidade || 0));
      atual.total += Math.max(0, Number(linha?.total || 0));
    }

    resumo.set(chave, atual);
  }

  return [...resumo.values()]
    .map(item => ({
      ...item,
      quantidade: Math.max(0, Number(item.quantidade || 0)),
      total: Math.round(Math.max(0, Number(item.total || 0)) * 100) / 100,
    }))
    .sort((a, b) =>
      b.quantidade - a.quantidade
      || b.total - a.total
      || a.categoriaNome.localeCompare(b.categoriaNome, "pt-BR", { sensitivity: "base" }),
    );
}

async function agregarRelatorios({
  idEstabelecimento,
  periodo,
  canalAtual,
  timeZone,
}) {
  const base = filtroBaseRelatorio(
    idEstabelecimento,
    periodo,
    canalAtual,
    "pagoEm",
  );
  const formato =
    formatoDataGrafico(
      periodo.filtro,
      periodo,
    );
  const [
    [resultado = {}],
    categoriasCatalogo,
    produtosCatalogo,
    paidOrdersWithoutPaymentDate,
  ] = await Promise.all([
    Pedido.aggregate([
      {
        $match: base,
      },
      {
        $facet: {
          financeiro: [
            {
              $match: {
                pagamentoStatus:
                  "pago",
              },
            },
            {
              $group: {
                _id: null,
                faturamento: {
                  $sum: {
                    $ifNull: [
                      "$total",
                      0,
                    ],
                  },
                },
                custo: {
                  $sum: {
                    $ifNull: [
                      "$custo",
                      0,
                    ],
                  },
                },
                quantidade: {
                  $sum: 1,
                },
              },
            },
          ],
          finalizados: [
            {
              $match: {
                status: {
                  $in: [
                    "finalizado",
                    "entregue",
                  ],
                },
              },
            },
            {
              $count:
                "quantidade",
            },
          ],
          grafico: [
            {
              $match: {
                pagamentoStatus:
                  "pago",
                pagoEm: { $type: "date" },
              },
            },
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: formato,
                    date: "$pagoEm",
                    timezone: timeZone,
                  },
                },
                valor: {
                  $sum: {
                    $ifNull: [
                      "$total",
                      0,
                    ],
                  },
                },
                quantidade: { $sum: 1 },
              },
            },
            {
              $sort: {
                _id: 1,
              },
            },
          ],
          produtos: [
            {
              $match: {
                pagamentoStatus:
                  "pago",
              },
            },
            {
              $unwind: "$itens",
            },
            {
              $group: {
                _id: "$itens.produtoId",
                nome: {
                  $first:
                    "$itens.nome",
                },
                quantidade: {
                  $sum: {
                    $ifNull: [
                      "$itens.quantidade",
                      0,
                    ],
                  },
                },
                total: {
                  $sum: {
                    $ifNull: [
                      "$itens.subtotal",
                      {
                        $multiply: [
                          { $ifNull: ["$itens.preco", 0] },
                          { $ifNull: ["$itens.quantidade", 0] },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          ],
          formasPagamento:
            etapasAgregacaoFormasPagamento(),
        },
      },
    ]),
    Categoria.find({
      estabelecimentoId: idEstabelecimento,
      tipo: "catalogo",
    })
      .select("_id nome")
      .lean(),
    Produto.find({
      estabelecimentoId: idEstabelecimento,
    })
      .select("_id nome categoriaId ativo")
      .lean(),
    Pedido.countDocuments({
      ...filtroBaseRelatorio(
        idEstabelecimento,
        { inicio: null, fim: null },
        canalAtual,
        "pagoEm",
      ),
      pagamentoStatus: "pago",
      pagoEm: null,
    }),
  ]);

  const financeiro =
    resultado.financeiro?.[0] ||
    {};
  const produtos =
    resultado.produtos || [];
  const categoriasProdutosVendidos =
    montarVendasPorCategoriaProduto({
      categorias: categoriasCatalogo,
      produtos: produtosCatalogo,
      vendas: produtos,
    });
  const resumoCategoriasVendidas =
    montarResumoVendasPorCategoria(
      categoriasProdutosVendidos,
    );

  return {
    faturamento: Number(
      financeiro.faturamento || 0,
    ),
    custo: Number(
      financeiro.custo || 0,
    ),
    quantidadePaga: Number(
      financeiro.quantidade || 0,
    ),
    totalFinalizados: Number(
      resultado.finalizados?.[0]
        ?.quantidade || 0,
    ),
    paidOrdersWithoutPaymentDate: Number(
      paidOrdersWithoutPaymentDate || 0,
    ),
    formasPagamento:
      normalizarResumoFormasPagamento(
        resultado.formasPagamento,
      ),
    grafico:
      montarGraficoAgregado(
        resultado.grafico || [],
        periodo.filtro,
        timeZone,
      ),
    categoriasProdutosVendidos,
    resumoCategoriasVendidas,
  };
}

async function agregarDashboard({
  idEstabelecimento,
  periodo,
}) {
  const intervalo = periodo?.inicio && periodo?.fim
    ? { $gte: periodo.inicio, $lte: periodo.fim }
    : null;
  const [resultado = {}] =
    await Pedido.aggregate([
      {
        $match:
          filtroBaseRelatorio(
            idEstabelecimento,
            { inicio: null, fim: null },
          ),
      },
      {
        $facet: {
          pedidos: [
            ...(intervalo ? [{ $match: { createdAt: intervalo } }] : []),
            {
              $count:
                "quantidade",
            },
          ],
          financeiro: [
            {
              $match: {
                pagamentoStatus:
                  "pago",
                ...(intervalo ? { pagoEm: intervalo } : {}),
              },
            },
            {
              $group: {
                _id: null,
                faturamento: {
                  $sum: {
                    $ifNull: [
                      "$total",
                      0,
                    ],
                  },
                },
                quantidade: {
                  $sum: 1,
                },
              },
            },
          ],
          formasPagamento:
            etapasAgregacaoFormasPagamento({
              intervaloPagamento:
                intervalo,
            }),
        },
      },
    ]);

  const financeiro =
    resultado.financeiro?.[0] ||
    {};

  return {
    vendas: Number(
      financeiro.faturamento || 0,
    ),
    quantidadePaga: Number(
      financeiro.quantidade || 0,
    ),
    quantidadePedidos: Number(
      resultado.pedidos?.[0]
        ?.quantidade || 0,
    ),
    formasPagamento:
      normalizarResumoFormasPagamento(
        resultado.formasPagamento,
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

    const acessoPainel = montarAcessoPainel(req.session.user);
    const {
      podeDashboard,
      podePedidos,
      podeRelatorios,
      podeEstoque,
      podeCatalogo,
      podeMesas,
      podeFuncionarios,
      podeConfiguracoes,
      podeImprimirPedidos,
      podeConfigurarImpressoras,
      podeArquivarPedidos,
    } = acessoPainel;

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
        {
          completa:
            podeConfiguracoes,
          incluirImpressoras:
            podeImprimirPedidos ||
            podeConfigurarImpressoras,
        },
      );
    const timezoneEstabelecimento = getEstablishmentTimezone(configuracaoDocumento);

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
      new Date(),
      timezoneEstabelecimento,
    );

    const dashboardPeriodoConsulta = obterPeriodoRelatorio(
      ["hoje", "semana", "mes", "ano", "todos", "personalizado"].includes(req.query.dashboardFiltro)
        ? req.query.dashboardFiltro
        : "hoje",
      String(req.query.dashboardDataInicio || "").trim(),
      String(req.query.dashboardDataFim || "").trim(),
      new Date(),
      timezoneEstabelecimento,
    );

    const relatorioPeriodoConsulta = obterPeriodoRelatorio(
      ["hoje", "semana", "mes", "ano", "todos", "personalizado"].includes(req.query.filtro)
        ? req.query.filtro
        : "hoje",
      String(req.query.dataInicio || "").trim(),
      String(req.query.dataFim || "").trim(),
      new Date(),
      timezoneEstabelecimento,
    );

    const periodosConsulta = [pedidoPeriodo, dashboardPeriodoConsulta, relatorioPeriodoConsulta];
    const consultaSemLimiteDeData = periodosConsulta.some(periodoConsulta => !periodoConsulta.inicio || !periodoConsulta.fim);
    const filtroDataPedidos = {};

    if (!consultaSemLimiteDeData) {
      const inicios = periodosConsulta.map(periodoConsulta => periodoConsulta.inicio.getTime());
      const fins = periodosConsulta.map(periodoConsulta => periodoConsulta.fim.getTime());
      const intervaloCarregamento = {
        $gte: new Date(Math.min(...inicios)),
        $lte: new Date(Math.max(...fins)),
      };
      filtroDataPedidos.$or = [
        { createdAt: intervaloCarregamento },
        { pagoEm: intervaloCarregamento },
      ];
    }

    const [
      categorias,
      estoque,
      produtos,
      mesas,
      funcionarios,
      cidadesEntrega,
      pedidos,
      pedidosArquivados,
    ] = await Promise.all([
      podeEstoque || podeCatalogo
        ? Categoria.find({
            estabelecimentoId:
              idEstabelecimento,
            tipo: {
              $in: [
                ...(podeEstoque
                  ? ["estoque"]
                  : []),
                ...(podeCatalogo
                  ? ["catalogo"]
                  : []),
              ],
            },
          })
            .sort({ nome: 1 })
            .lean()
        : Promise.resolve([]),

      podeEstoque
        ? Estoque.find({
            estabelecimentoId:
              idEstabelecimento,
            ativo: { $ne: false },
          })
            .populate(
              "categoriaId",
              "nome tipo tipoProduto configuracaoPizza configuracaoVariacoes",
            )
            .sort({ nome: 1 })
            .lean()
        : Promise.resolve([]),

      podeCatalogo
        ? Produto.find({
            estabelecimentoId:
              idEstabelecimento,
          })
            .populate(
              "categoriaId",
              "nome tipo tipoProduto configuracaoPizza configuracaoVariacoes",
            )
            .sort({ nome: 1 })
            .lean()
        : Promise.resolve([]),

      podeMesas || podeDashboard
        ? Mesa.find({
            estabelecimentoId:
              idEstabelecimento,
          })
            .sort({ numero: 1 })
            .lean()
        : Promise.resolve([]),

      podeFuncionarios
        ? Funcionario.find({
            estabelecimentoId:
              idEstabelecimento,
          })
            .select("-senha")
            .sort({ nome: 1 })
            .lean()
        : Promise.resolve([]),

      podeConfiguracoes
        ? CidadeEntrega.find({
            estabelecimentoId:
              idEstabelecimento,
          })
            .sort({ ativo: -1, nome: 1, uf: 1 })
            .lean()
        : Promise.resolve([]),

      (
        podeDashboard ||
        podePedidos ||
        podeRelatorios ||
        podeMesas
      )
        ? Pedido.find({
            estabelecimentoId:
              idEstabelecimento,
            excluido: { $ne: true },
            ...filtroDataPedidos,
          })
            .populate(
              "mesaId",
              "numero setor status",
            )
            .sort({ createdAt: -1 })
            .limit(500)
            .lean()
        : Promise.resolve([]),

      podeArquivarPedidos
        ? Pedido.find({
            estabelecimentoId: idEstabelecimento,
            excluido: true,
          })
            .select(
              "_id numeroPedido numeroPedidoData codigoPublico createdAt status pagamentoStatus motivoExclusao "
              + "excluidoEm excluidoPor excluidoPorTipo "
              + "mercadoPagoStatus mercadoPagoPaymentId pagamentoInconsistente pagamentoInconsistencia",
            )
            .sort({ excluidoEm: -1 })
            .limit(200)
            .lean()
        : Promise.resolve([]),
    ]);

    if (podeArquivarPedidos && pedidosArquivados.length) {
      const idsFuncionarios = pedidosArquivados
        .filter(item => item.excluidoPorTipo === "funcionario" && item.excluidoPor)
        .map(item => item.excluidoPor);
      const [proprietario, autoresFuncionarios] = await Promise.all([
        registroModel.findOne({
          _id: idEstabelecimento,
        }).select("_id nome").lean(),
        idsFuncionarios.length
          ? Funcionario.find({
              _id: { $in: idsFuncionarios },
              estabelecimentoId: idEstabelecimento,
            }).select("_id nome").lean()
          : Promise.resolve([]),
      ]);
      const nomesFuncionarios = new Map(
        autoresFuncionarios.map(item => [String(item._id), item.nome]),
      );
      pedidosArquivados.forEach(item => {
        item.excluidoPorNome = item.excluidoPorTipo === "proprietario"
          ? (proprietario?.nome || "Proprietário")
          : (nomesFuncionarios.get(String(item.excluidoPor)) || "Funcionário");
      });
    }

    // A tela de Pedidos precisa enxergar a conta aberta inteira da mesa,
    // mesmo quando algum pedido da mesma comanda ficou fora do filtro de data.
    // Os documentos continuam separados no banco (auditoria, estoque e impressão
    // automática permanecem intactos); somente a visualização operacional é agrupada.
    const pedidosMesaAbertosPainel = podePedidos
      ? await Pedido.find({
          estabelecimentoId: idEstabelecimento,
          canal: "mesa",
          mesaId: { $ne: null },
          excluido: { $ne: true },
          pagamentoStatus: "pendente",
          status: { $ne: "cancelado" },
        })
          .populate("mesaId", "numero setor status")
          .sort({ createdAt: 1 })
          .limit(1000)
          .lean()
      : [];

    const idsDesativadosReferenciados =
      idsDeIngredientesDesativadosReferenciados(estoque, produtos);
    const ingredientesDesativadosReferenciados =
      idsDesativadosReferenciados.length
        ? await Estoque.find({
            _id: { $in: idsDesativadosReferenciados },
            estabelecimentoId: idEstabelecimento,
            ativo: false,
          })
            .select("_id nome ativo unidade custoUnitario")
            .lean()
        : [];

    const configuracaoCompleta =
      typeof configuracaoDocumento.toObject ===
      "function"
        ? configuracaoDocumento.toObject()
        : configuracaoDocumento;

    const configuracao = podeConfiguracoes
      ? configuracaoCompleta
      : {
          nomeEstabelecimento:
            configuracaoCompleta
              ?.nomeEstabelecimento ||
            "Meu estabelecimento",
          fotoPerfil:
            configuracaoCompleta
              ?.fotoPerfil || "",
          slug: podeCatalogo
            ? configuracaoCompleta?.slug ||
              ""
            : "",
          impressoras:
            podeImprimirPedidos ||
            podeConfigurarImpressoras
              ? configuracaoCompleta
                  ?.impressoras || []
              : [],
          impressaoAutomatica:
            (
              podeImprimirPedidos ||
              podeConfigurarImpressoras
            ) &&
            Boolean(
              configuracaoCompleta
                ?.impressaoAutomatica,
            ),
        };

    const categoriasEstoque =
      podeEstoque
        ? categorias.filter(
        (categoria) =>
          categoria.tipo ===
          "estoque",
          )
        : [];

    const categoriasCatalogo =
      podeCatalogo
        ? categorias.filter(
        (categoria) =>
          categoria.tipo ===
          "catalogo",
          )
        : [];

    const baseUrl = obterBaseUrl(req);

    const slugCatalogo = podeCatalogo
      ? String(configuracaoCompleta?.slug || "").trim()
      : "";

    const catalogoCaminho = slugCatalogo
      ? `/catalogo/${encodeURIComponent(slugCatalogo)}`
      : "#";

    const catalogoLink = catalogoCaminho !== "#"
      ? `${baseUrl}${catalogoCaminho}`
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
          const caminhoPublico = `/mesa/${encodeURIComponent(String(mesa.token || ""))}`;
          const link = `${baseUrl}${caminhoPublico}`;

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
            appLogger.error(
              `Erro ao gerar QR Code da mesa ${mesa.numero}:`,
              erroQrCode,
            );
          }

          return {
            ...mesa,
            link,
            caminhoPublico,
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
        new Date(),
        timezoneEstabelecimento,
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

    const dashboardAgregado =
      podeDashboard
        ? await agregarDashboard({
            idEstabelecimento,
            periodo:
              dashboardPeriodo,
          })
        : {
            vendas: 0,
            quantidadePaga: 0,
            quantidadePedidos: 0,
            formasPagamento:
              criarResumoFormasPagamentoVazio(),
          };

    const vendasHoje =
      dashboardAgregado.vendas;

    const ticketMedio =
      dashboardAgregado
        .quantidadePaga
        ? vendasHoje /
          dashboardAgregado
            .quantidadePaga
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
        dashboardAgregado
          .quantidadePedidos,
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
      formasPagamento:
        dashboardAgregado
          .formasPagamento,
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
        new Date(),
        timezoneEstabelecimento,
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

    const baseRelatorioPago = {
      ...filtroBaseRelatorio(
        idEstabelecimento,
        periodo,
        canalAtual,
        "pagoEm",
      ),
      pagamentoStatus: "pago",
    };

    const relatorioVazio = {
      faturamento: 0,
      custo: 0,
      quantidadePaga: 0,
      totalFinalizados: 0,
      grafico: {
        labels: ["Sem dados"],
        valores: [0],
        maiorValor: 1,
      },
      categoriasProdutosVendidos: [],
      resumoCategoriasVendidas: [],
      formasPagamento: criarResumoFormasPagamentoVazio(),
      paidOrdersWithoutPaymentDate: 0,
    };

    const [
      agregadoRelatorios,
      pedidosFiltrados,
      pagamentosPixComTaxa,
    ] = podeRelatorios
      ? await Promise.all([
          agregarRelatorios({
            idEstabelecimento,
            periodo,
            canalAtual,
            timeZone: timezoneEstabelecimento,
          }),
          Pedido.find(baseRelatorioPago)
            .sort({ pagoEm: -1, createdAt: -1 })
            .limit(100)
            .lean(),
          Pedido.find({
            ...baseRelatorioPago,
            $or: [
              { formaPagamento: "pix_online" },
              {
                pagamentos: {
                  $elemMatch: {
                    formaPagamento: "pix_online",
                    valorCentavos: { $gt: 0 },
                  },
                },
              },
            ],
          })
            .select(
              "grossAmountCents platformFeeCents platformFeeReversedCents "
              + "platformFeeNetCents merchantAmountBeforeMpFeesCents platformFeeStatus",
            )
            .lean(),
        ])
      : [relatorioVazio, [], []];

    const faturamento =
      agregadoRelatorios
        .faturamento;

    const custo =
      agregadoRelatorios.custo;

    const taxasPix = pagamentosPixComTaxa.reduce((acc, pedido) => {
      acc.valorBrutoCents += Number(pedido.grossAmountCents || 0);
      acc.taxaCents += Number(pedido.platformFeeCents || 0);
      acc.estornadaCents += Number(pedido.platformFeeReversedCents || 0);
      acc.liquidaCents += Number(pedido.platformFeeNetCents || 0);
      acc.destinadoLojaCents += Number(pedido.merchantAmountBeforeMpFeesCents || 0);
      if (pedido.platformFeeStatus === "reconciliation_required") acc.reconciliacao += 1;
      return acc;
    }, {
      valorBrutoCents: 0,
      taxaCents: 0,
      estornadaCents: 0,
      liquidaCents: 0,
      destinadoLojaCents: 0,
      reconciliacao: 0,
    });

    const relatorios = {
      filtroAtual: periodo.filtro,
      canalAtual,
      dataInicio,
      dataFim,
      faturamento,
      custo,
      lucro: faturamento - custo,
      totalPedidos:
        agregadoRelatorios
          .totalFinalizados,
      grafico:
        agregadoRelatorios.grafico,
      categoriasProdutosVendidos:
        agregadoRelatorios
          .categoriasProdutosVendidos,
      resumoCategoriasVendidas:
        agregadoRelatorios
          .resumoCategoriasVendidas || [],
      paidOrdersWithoutPaymentDate:
        agregadoRelatorios.paidOrdersWithoutPaymentDate || 0,
      formasPagamento:
        agregadoRelatorios
          .formasPagamento,
      taxasPix: {
        ...taxasPix,
        quantidade: pagamentosPixComTaxa.filter(pedido =>
          Number(pedido.platformFeeCents || 0) > 0).length,
        percentual: Number(process.env.PLATFORM_PIX_FEE_PERCENT || 1.5),
      },
      historico:
        pedidosFiltrados.slice(
          0,
          100,
        ),
    };

    const pedidoCanalAtual = ["todos", "delivery", "mesa", "retirada"].includes(req.query.pedidoCanal)
      ? req.query.pedidoCanal
      : "todos";
    const pedidoStatusAtual = ["todos", "novo", "preparo", "pronto", "entregue", "finalizado", "cancelado"].includes(req.query.pedidoStatus)
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
        if (statusPedido !== pedidoStatusAtual) return false;
      }

      return true;
    });

    const comandasMesaAbertasPainel = filtrarComandasMesaParaPainel(
      montarComandasMesaAbertas(pedidosMesaAbertosPainel),
      {
        canal: pedidoCanalAtual,
        status: pedidoStatusAtual,
      },
    );

    const idsPedidosAgrupadosMesa = new Set(
      comandasMesaAbertasPainel.flatMap(comanda => comanda.pedidoIds || []),
    );

    // Pedidos de uma mesa com conta aberta deixam de virar vários cards.
    // Eles continuam existindo individualmente no banco e aparecem dentro do
    // único card da comanda da mesa. Pedidos já pagos/fechados seguem históricos.
    const listaPedidosPainel = listaPedidos.filter(
      pedido => !idsPedidosAgrupadosMesa.has(String(pedido._id)),
    );

    const filtrosPedidos = {
      periodoAtual: pedidoPeriodo.filtro,
      dataInicio: pedidoDataInicio,
      dataFim: pedidoDataFim,
      canalAtual: pedidoCanalAtual,
      statusAtual: pedidoStatusAtual,
    };

    const donoPainel =
      podeConfiguracoes
        ? await registroModel
            .findOne({
              _id: idEstabelecimento,
            })
            .select("cpfCnpj")
            .lean()
        : null;

    const whatsappConfiguracao = podeConfiguracoes
      ? await WhatsAppConfiguracao.findOne({
          estabelecimentoId: idEstabelecimento,
        }).lean()
      : null;

    const whatsappConversas = podeConfiguracoes
      ? await WhatsAppConversa.find({
          estabelecimentoId: idEstabelecimento,
        })
          .sort({ updatedAt: -1 })
          .limit(40)
          .lean()
      : [];

    const dashboardSeguro =
      podeDashboard
        ? dashboard
        : {
            filtroAtual: "hoje",
            dataInicio: "",
            dataFim: "",
            vendasHoje: 0,
            pedidosHoje: 0,
            ticketMedio: 0,
            mesasOcupadas: 0,
            totalMesas: 0,
            pedidosLista: [],
            formasPagamento:
              criarResumoFormasPagamentoVazio(),
          };

    const relatoriosSeguros =
      podeRelatorios
        ? relatorios
        : {
            filtroAtual: "hoje",
            canalAtual: "todos",
            dataInicio: "",
            dataFim: "",
            faturamento: 0,
            custo: 0,
            lucro: 0,
            totalPedidos: 0,
            paidOrdersWithoutPaymentDate: 0,
            grafico: {
              labels: [],
              valores: [],
              maiorValor: 1,
            },
            categoriasProdutosVendidos: [],
            resumoCategoriasVendidas: [],
            historico: [],
            formasPagamento:
              criarResumoFormasPagamentoVazio(),
          };

    return res.render(
      "admin-real",
      {
        user: {
          ...(req.session.user || {}),
          cpfCnpj: donoPainel?.cpfCnpj || "",
        },
        assinatura,
        diasRestantes,

        configuracao,
        timezoneEstabelecimento,
        catalogoCaminho,
        catalogoLink,

        dashboard:
          dashboardSeguro,
        relatorios:
          relatoriosSeguros,

        categoriasEstoque,
        categoriasCatalogo,

        estoque:
          podeEstoque ? estoque : [],
        itensEstoque:
          podeEstoque ? estoque : [],
        ingredientesDesativadosReferenciados,

        produtos:
          podeCatalogo ? produtos : [],

        mesas:
          podeMesas ? mesasComConta : [],

        funcionarios:
          podeFuncionarios
            ? funcionarios
            : [],
        listaFuncionarios:
          podeFuncionarios
            ? funcionarios
            : [],

        cidadesEntrega:
          podeConfiguracoes
            ? cidadesEntrega
            : [],

        whatsappConfiguracao:
          podeConfiguracoes
            ? whatsappConfiguracao
            : null,
        whatsappConversas:
          podeConfiguracoes
            ? whatsappConversas
            : [],

        pedidos:
          podePedidos ? pedidos : [],
        pedidosArquivados:
          podeArquivarPedidos ? pedidosArquivados : [],
        pedidosFiltradosPainel:
          podePedidos
            ? listaPedidosPainel
            : [],
        comandasMesaAbertasPainel:
          podePedidos
            ? comandasMesaAbertasPainel
            : [],
        filtrosPedidos,

        errors:
          readFlash(req, "errors"),

        success:
          readFlash(req, "success"),
      },
    );
  } catch (error) {
    appLogger.error(
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

function valorBooleanoFormulario(value) {
  return ["true", "1", "sim", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function listaFormulario(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizarIdsCategoriasMeioAMeio(body = {}, categoriaAtual = null) {
  const categoriaAtualId = String(categoriaAtual?._id || "");
  const ids = [
    ...new Set(
      listaFormulario(body.categoriasMeioAMeio)
        .map(value => String(value || "").trim())
        .filter(Boolean),
    ),
  ].filter(id => id !== categoriaAtualId);

  if (ids.length > 20) {
    throw erroValidacao("Selecione no máximo 20 categorias para combinar no meio a meio.");
  }
  if (ids.some(id => !mongoose.isValidObjectId(id))) {
    throw erroValidacao("Uma das categorias selecionadas para o meio a meio é inválida.");
  }
  return ids;
}

async function validarCategoriasMeioAMeio({
  ids = [],
  estabelecimentoId,
  categoriaAtualId = "",
} = {}) {
  const idsUnicos = [...new Set(ids.map(id => String(id || "")).filter(Boolean))]
    .filter(id => id !== String(categoriaAtualId || ""));
  if (!idsUnicos.length) return [];

  const categorias = await Categoria.find({
    _id: { $in: idsUnicos },
    estabelecimentoId,
    tipo: "catalogo",
    tipoProduto: "pizza",
  }).select("_id").lean();

  if (categorias.length !== idsUnicos.length) {
    throw erroValidacao(
      "Selecione apenas categorias de pizza desta loja para combinar no meio a meio.",
    );
  }
  return categorias.map(categoria => categoria._id);
}

function normalizarTamanhosCategoriaPizza(body = {}, tamanhosAnteriores = []) {
  const nomes = listaFormulario(body.categoriaPizzaTamanhoNome);
  const ids = listaFormulario(body.categoriaPizzaTamanhoId);
  const maximosSabores = listaFormulario(body.categoriaPizzaTamanhoMaxSabores);
  if (nomes.length > 12) {
    throw erroValidacao("Cadastre no máximo 12 tamanhos por categoria de pizza.");
  }

  const anteriores = new Map(
    (Array.isArray(tamanhosAnteriores) ? tamanhosAnteriores : []).map(tamanho => [
      String(tamanho?._id || ""),
      tamanho,
    ]),
  );
  const nomesVistos = new Set();
  const tamanhos = [];

  for (let indice = 0; indice < nomes.length; indice += 1) {
    const nome = String(nomes[indice] || "").trim();
    const idRecebido = String(ids[indice] || "").trim();
    if (!nome && !idRecebido) continue;
    if (!nome || nome.length > 50) {
      throw erroValidacao("Cada tamanho de pizza deve ter um nome de 1 a 50 caracteres.");
    }

    const chaveNome = nome.toLocaleLowerCase("pt-BR");
    if (nomesVistos.has(chaveNome)) {
      throw erroValidacao("Não repita o mesmo tamanho de pizza.");
    }
    nomesVistos.add(chaveNome);

    let tamanhoId = null;
    let tamanhoAnterior = null;
    if (idRecebido) {
      if (!mongoose.isValidObjectId(idRecebido) || !anteriores.has(idRecebido)) {
        throw erroValidacao("Um tamanho de pizza informado é inválido.");
      }
      tamanhoAnterior = anteriores.get(idRecebido);
      tamanhoId = tamanhoAnterior._id;
    } else {
      tamanhoId = new mongoose.Types.ObjectId();
    }

    const maxSaboresRecebido = maximosSabores[indice];
    let maxSabores = maxSaboresRecebido === undefined || maxSaboresRecebido === null || maxSaboresRecebido === ""
      ? Number(tamanhoAnterior?.maxSabores || 2)
      : Number(maxSaboresRecebido);
    if (!Number.isInteger(maxSabores) || maxSabores < 1 || maxSabores > 3) {
      throw erroValidacao("Escolha entre 1 e 3 sabores para cada tamanho de pizza.");
    }

    tamanhos.push({
      _id: tamanhoId,
      nome,
      ordem: tamanhos.length,
      ativo: true,
      maxSabores,
    });
  }

  return tamanhos;
}

function tamanhosAtivosDaCategoria(categoria = {}) {
  return (Array.isArray(categoria.configuracaoPizza?.tamanhos)
    ? categoria.configuracaoPizza.tamanhos
    : [])
    .filter(tamanho => tamanho?.ativo !== false && tamanho?._id)
    .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));
}

function normalizarPrecosPizzaProduto(body = {}, categoria = {}) {
  if (String(categoria.tipoProduto || "normal") !== "pizza") return [];
  const tamanhos = tamanhosAtivosDaCategoria(categoria);
  if (!tamanhos.length) return [];

  const ids = listaFormulario(body.produtoPizzaTamanhoId);
  const precos = listaFormulario(body.produtoPizzaTamanhoPreco);
  if (ids.length !== precos.length) {
    throw erroValidacao("Informe o preço de todos os tamanhos da pizza.");
  }

  const mapaPrecos = new Map();
  for (let indice = 0; indice < ids.length; indice += 1) {
    const tamanhoId = String(ids[indice] || "").trim();
    if (!tamanhoId || mapaPrecos.has(tamanhoId)) {
      throw erroValidacao("Os tamanhos e preços da pizza são inválidos.");
    }
    const numero = Number(String(precos[indice] ?? "").replace(",", "."));
    if (!Number.isFinite(numero) || numero < 0 || numero > 100_000) {
      throw erroValidacao("Informe um preço válido para cada tamanho da pizza.");
    }
    mapaPrecos.set(tamanhoId, numero);
  }

  return tamanhos.map(tamanho => {
    const tamanhoId = String(tamanho._id);
    if (!mapaPrecos.has(tamanhoId)) {
      throw erroValidacao(`Informe o preço da pizza no tamanho ${tamanho.nome}.`);
    }
    return {
      tamanhoId: tamanho._id,
      tamanhoNome: String(tamanho.nome || "").slice(0, 50),
      preco: mapaPrecos.get(tamanhoId),
    };
  });
}

function normalizarOpcoesCategoria(body = {}, opcoesAnteriores = []) {
  const nomes = listaFormulario(body.categoriaVariacaoNome);
  const ids = listaFormulario(body.categoriaVariacaoId);
  if (nomes.length > 12) {
    throw erroValidacao("Cadastre no máximo 12 opções por categoria.");
  }

  const anteriores = new Map(
    (Array.isArray(opcoesAnteriores) ? opcoesAnteriores : []).map(opcao => [
      String(opcao?._id || ""),
      opcao,
    ]),
  );
  const nomesVistos = new Set();
  const opcoes = [];

  for (let indice = 0; indice < nomes.length; indice += 1) {
    const nome = String(nomes[indice] || "").trim();
    const idRecebido = String(ids[indice] || "").trim();
    if (!nome && !idRecebido) continue;
    if (!nome || nome.length > 50) {
      throw erroValidacao("Cada opção deve ter um nome de 1 a 50 caracteres.");
    }

    const chaveNome = nome.toLocaleLowerCase("pt-BR");
    if (nomesVistos.has(chaveNome)) {
      throw erroValidacao("Não repita a mesma opção na categoria.");
    }
    nomesVistos.add(chaveNome);

    let variacaoId = null;
    if (idRecebido) {
      if (!mongoose.isValidObjectId(idRecebido) || !anteriores.has(idRecebido)) {
        throw erroValidacao("Uma opção informada é inválida.");
      }
      variacaoId = anteriores.get(idRecebido)._id;
    } else {
      variacaoId = new mongoose.Types.ObjectId();
    }

    opcoes.push({
      _id: variacaoId,
      nome,
      ordem: opcoes.length,
      ativo: true,
    });
  }

  return opcoes;
}

function opcoesVariacaoAtivasDaCategoria(categoria = {}) {
  return (Array.isArray(categoria.configuracaoVariacoes?.opcoes)
    ? categoria.configuracaoVariacoes.opcoes
    : [])
    .filter(opcao => opcao?.ativo !== false && opcao?._id)
    .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));
}

function categoriaUsaVariacoes(categoria = {}) {
  return String(categoria.tipoProduto || "normal") !== "pizza"
    && categoria.configuracaoVariacoes?.habilitado === true
    && opcoesVariacaoAtivasDaCategoria(categoria).length > 0;
}

function normalizarPrecosVariacoesProduto(body = {}, categoria = {}) {
  if (!categoriaUsaVariacoes(categoria)) return [];
  const opcoes = opcoesVariacaoAtivasDaCategoria(categoria);

  const ids = listaFormulario(body.produtoVariacaoId);
  const precos = listaFormulario(body.produtoVariacaoPreco);
  if (ids.length !== precos.length) {
    throw erroValidacao("Informe o preço de todas as opções do produto.");
  }

  const mapaPrecos = new Map();
  for (let indice = 0; indice < ids.length; indice += 1) {
    const variacaoId = String(ids[indice] || "").trim();
    if (!variacaoId || mapaPrecos.has(variacaoId)) {
      throw erroValidacao("As opções e preços do produto são inválidos.");
    }
    const numero = Number(String(precos[indice] ?? "").replace(",", "."));
    if (!Number.isFinite(numero) || numero < 0 || numero > 100_000) {
      throw erroValidacao("Informe um preço válido para cada opção do produto.");
    }
    mapaPrecos.set(variacaoId, numero);
  }

  return opcoes.map(opcao => {
    const variacaoId = String(opcao._id);
    if (!mapaPrecos.has(variacaoId)) {
      throw erroValidacao(`Informe o preço do produto na opção ${opcao.nome}.`);
    }
    return {
      variacaoId: opcao._id,
      variacaoNome: String(opcao.nome || "").slice(0, 50),
      preco: mapaPrecos.get(variacaoId),
    };
  });
}

function resolverVariacaoEPrecoProduto({ itemRecebido = {}, produto = {}, categoria = {} } = {}) {
  if (!categoriaUsaVariacoes(categoria)) {
    return { precoBase: Number(produto.preco || 0), variacao: null };
  }

  const variacaoId = String(
    itemRecebido.variacaoId
      ?? itemRecebido.opcaoId
      ?? itemRecebido.variacao?._id
      ?? itemRecebido.variacao?.id
      ?? "",
  ).trim();
  if (!mongoose.isValidObjectId(variacaoId)) {
    const error = erroValidacao("Escolha uma opção válida para o produto.");
    error.statusCode = 422;
    error.code = "VARIACAO_PRODUTO_INVALIDA";
    throw error;
  }

  const opcao = opcoesVariacaoAtivasDaCategoria(categoria)
    .find(item => String(item._id) === variacaoId);
  const preco = (produto.precosVariacoes || [])
    .find(item => String(item.variacaoId || "") === variacaoId);
  if (!opcao || !preco || !Number.isFinite(Number(preco.preco))) {
    const error = erroValidacao("Esta opção não está disponível para o produto.");
    error.statusCode = 422;
    error.code = "VARIACAO_PRODUTO_INDISPONIVEL";
    throw error;
  }

  return {
    precoBase: Number(preco.preco),
    variacao: {
      variacaoId: opcao._id,
      nome: String(opcao.nome || "").slice(0, 50),
    },
  };
}

function dadosCategoriaCatalogo(body = {}, categoriaAtual = null) {
  const tipoProduto = body.tipoProduto === "pizza"
    ? "pizza"
    : "normal";
  const regrasPermitidas = new Set([
    "maior_sabor_escolhido",
    "maior_preco_categoria",
  ]);
  const regraRecebida = String(
    body.regraPrecoMeioAMeio || "maior_sabor_escolhido",
  );
  const regraPrecoMeioAMeio = regrasPermitidas.has(regraRecebida)
    ? regraRecebida
    : "maior_sabor_escolhido";
  const tamanhos = tipoProduto === "pizza"
    ? normalizarTamanhosCategoriaPizza(
        body,
        categoriaAtual?.configuracaoPizza?.tamanhos || [],
      )
    : [];
  const categoriasMeioAMeio = tipoProduto === "pizza"
    ? normalizarIdsCategoriasMeioAMeio(body, categoriaAtual)
    : [];
  const variacoesHabilitadas = tipoProduto !== "pizza"
    && valorBooleanoFormulario(body.variacoesHabilitadas);
  const opcoesVariacoes = variacoesHabilitadas
    ? normalizarOpcoesCategoria(
        body,
        categoriaAtual?.configuracaoVariacoes?.opcoes || [],
      )
    : [];
  if (variacoesHabilitadas && !opcoesVariacoes.length) {
    throw erroValidacao("Adicione pelo menos uma opção de tamanho, volume ou porção.");
  }

  return {
    tipoProduto,
    configuracaoPizza: {
      permiteMeioAMeio: tipoProduto === "pizza"
        && valorBooleanoFormulario(body.permiteMeioAMeio),
      regraPrecoMeioAMeio,
      categoriasMeioAMeio,
      tamanhos,
    },
    configuracaoVariacoes: {
      habilitado: variacoesHabilitadas,
      opcoes: opcoesVariacoes,
    },
  };
}

exports.criarCategoria = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const nome = String(req.body.nome || "").trim().slice(0, 120);
    if (!nome) {
      return erroERedirecionar(
        req,
        res,
        req.body.tipo === "catalogo" ? "catalogo" : "estoque",
        "Informe o nome da categoria.",
      );
    }

    const categoriaId = String(req.body.categoriaId || "").trim();
    if (categoriaId) {
      if (!mongoose.isValidObjectId(categoriaId)) {
        return erroERedirecionar(
          req,
          res,
          "catalogo",
          "Categoria inválida.",
        );
      }

      const categoria = await Categoria.findOne({
        _id: categoriaId,
        estabelecimentoId: idEstabelecimento,
      });
      if (!categoria) {
        return erroERedirecionar(
          req,
          res,
          "catalogo",
          "Categoria não encontrada.",
        );
      }

      categoria.nome = nome;
      if (categoria.tipo === "catalogo") {
        const dadosCatalogo = dadosCategoriaCatalogo(req.body, categoria);
        dadosCatalogo.configuracaoPizza.categoriasMeioAMeio =
          dadosCatalogo.tipoProduto === "pizza"
            ? await validarCategoriasMeioAMeio({
                ids: dadosCatalogo.configuracaoPizza.categoriasMeioAMeio,
                estabelecimentoId: idEstabelecimento,
                categoriaAtualId: categoria._id,
              })
            : [];
        categoria.tipoProduto = dadosCatalogo.tipoProduto;
        categoria.configuracaoPizza = dadosCatalogo.configuracaoPizza;
        categoria.configuracaoVariacoes = dadosCatalogo.configuracaoVariacoes;
      } else {
        categoria.tipoProduto = "normal";
        categoria.configuracaoPizza = {
          permiteMeioAMeio: false,
          regraPrecoMeioAMeio: "maior_sabor_escolhido",
          categoriasMeioAMeio: [],
          tamanhos: [],
        };
        categoria.configuracaoVariacoes = {
          habilitado: false,
          opcoes: [],
        };
      }

      await categoria.save();
      return salvarERedirecionar(
        req,
        res,
        categoria.tipo,
        "Categoria atualizada.",
      );
    }

    const tipo = req.body.tipo === "catalogo"
      ? "catalogo"
      : "estoque";
    const dadosCatalogo = tipo === "catalogo"
      ? dadosCategoriaCatalogo(req.body)
      : {
          tipoProduto: "normal",
          configuracaoPizza: {
            permiteMeioAMeio: false,
            regraPrecoMeioAMeio: "maior_sabor_escolhido",
            categoriasMeioAMeio: [],
            tamanhos: [],
          },
          configuracaoVariacoes: {
            habilitado: false,
            opcoes: [],
          },
        };

    if (tipo === "catalogo" && dadosCatalogo.tipoProduto === "pizza") {
      dadosCatalogo.configuracaoPizza.categoriasMeioAMeio =
        await validarCategoriasMeioAMeio({
          ids: dadosCatalogo.configuracaoPizza.categoriasMeioAMeio,
          estabelecimentoId: idEstabelecimento,
        });
    }

    await Categoria.create({
      estabelecimentoId: idEstabelecimento,
      nome,
      tipo,
      ...dadosCatalogo,
    });

    return salvarERedirecionar(
      req,
      res,
      tipo,
      "Categoria cadastrada.",
    );
  } catch (error) {
    appLogger.error(error);

    return erroERedirecionar(
      req,
      res,
      req.body.tipo === "catalogo"
        ? "catalogo"
        : "estoque",
      "Não foi possível salvar a categoria.",
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
    appLogger.error(error);

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
    const idEstabelecimento =
      estabelecimentoId(req);

    const categoriaValida =
      await Categoria.exists({
        _id: req.body.categoriaId,
        estabelecimentoId:
          idEstabelecimento,
        tipo: "estoque",
      });

    if (!categoriaValida) {
      return erroERedirecionar(
        req,
        res,
        "estoque",
        "Categoria de estoque inválida.",
      );
    }

    const quantidadeInicial = Number(
      req.body.quantidade || 0,
    );
    await Estoque.create({
      estabelecimentoId:
        idEstabelecimento,
      nome: String(
        req.body.nome || "",
      ).trim(),
      categoriaId:
        req.body.categoriaId,
      quantidade: quantidadeInicial,
      quantidadeInicial,
      totalEntradas: quantidadeInicial,
      totalConsumido: 0,
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
    appLogger.error(error);

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

    const categoriaValida =
      await Categoria.exists({
        _id: item.categoriaId,
        estabelecimentoId:
          estabelecimentoId(req),
        tipo: "estoque",
      });

    if (!categoriaValida) {
      return erroERedirecionar(
        req,
        res,
        "estoque",
        "Categoria de estoque inválida.",
      );
    }

    const quantidadeAnterior = Number(item.quantidade || 0);
    const novaQuantidade = Number(
      req.body.quantidade ?? item.quantidade,
    );
    item.quantidade = novaQuantidade;
    if (
      Number.isFinite(novaQuantidade) &&
      novaQuantidade > quantidadeAnterior &&
      Number.isFinite(Number(item.totalEntradas))
    ) {
      item.totalEntradas =
        Number(item.totalEntradas) + (novaQuantidade - quantidadeAnterior);
    }

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
    appLogger.error(error);

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
    const idEstabelecimento = estabelecimentoId(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({
        success: false,
        message: "Ingrediente não encontrado.",
      });
    }
    const ingredienteId = new mongoose.Types.ObjectId(req.params.id);
    const estabelecimentoObjectId =
      new mongoose.Types.ObjectId(String(idEstabelecimento));
    const [referencias = { quantidadeProdutos: 0, produtos: [] }] =
      await Produto.aggregate([
        {
          $match: {
            estabelecimentoId: estabelecimentoObjectId,
            "fichaTecnica.estoqueId": ingredienteId,
          },
        },
        {
          $facet: {
            total: [{ $count: "quantidade" }],
            produtos: [
              { $sort: { nome: 1 } },
              { $limit: 10 },
              { $project: { _id: 0, nome: 1 } },
            ],
          },
        },
        {
          $project: {
            _id: 0,
            quantidadeProdutos: {
              $ifNull: [
                { $arrayElemAt: ["$total.quantidade", 0] },
                0,
              ],
            },
            produtos: {
              $map: {
                input: "$produtos",
                as: "produto",
                in: "$$produto.nome",
              },
            },
          },
        },
      ]);

    if (referencias.quantidadeProdutos > 0) {
      return res.status(409).json({
        message:
          "Este ingrediente está sendo usado na ficha técnica de produtos. Remova-o ou substitua-o nas fichas antes de desativar.",
        quantidadeProdutos: referencias.quantidadeProdutos,
        produtos: referencias.produtos,
      });
    }

    const agora = new Date();
    const usuarioId = req.session?.user?.id || req.session?.user?._id || null;
    const operationKey = `ingrediente_desativado:${ingredienteId}`;
    const ingrediente = await Estoque.findOneAndUpdate(
      {
        _id: ingredienteId,
        estabelecimentoId: idEstabelecimento,
        ativo: { $ne: false },
      },
      {
        $set: {
          ativo: false,
          desativadoEm: agora,
          desativadoPor: usuarioId,
          motivoDesativacao: String(
            req.body?.motivoDesativacao || "Desativação solicitada no painel.",
          ).trim().slice(0, 300),
        },
        $push: {
          auditoria: {
            tipo: "ingrediente_desativado",
            ingredienteId,
            usuarioId,
            registradoEm: agora,
            operationKey,
          },
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!ingrediente) {
      const existente = await Estoque.findOne({
        _id: ingredienteId,
        estabelecimentoId: idEstabelecimento,
      }).select("_id ativo");
      if (existente?.ativo === false) {
        return res.status(200).json({
          success: true,
          status: "ja_desativado",
          message: "Ingrediente já estava desativado.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Ingrediente não encontrado.",
      });
    }
    return res.json({
      success: true,
      status: "desativado",
      message: "Ingrediente desativado.",
    });
  } catch (error) {
    appLogger.error(error);

    return res.status(500).json({
      success: false,
      message: "Não foi possível excluir o ingrediente.",
    });
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
  let novaImagem = null;
  let idEstabelecimento = null;
  try {
    idEstabelecimento =
      estabelecimentoId(req);
    if (!mongoose.isValidObjectId(req.body.categoriaId)) {
      throw erroValidacao("Categoria de catálogo inválida.");
    }

    const categoriaValida =
      await Categoria.findOne({
        _id: req.body.categoriaId,
        estabelecimentoId:
          idEstabelecimento,
        tipo: "catalogo",
      }).lean();

    if (!categoriaValida) {
      return erroERedirecionar(
        req,
        res,
        "catalogo",
        "Categoria de catálogo inválida.",
      );
    }

    const fichaTecnica = await montarFichaTecnicaProduto(
      req.body,
      idEstabelecimento,
    );
    await validarFichaAntesDeSalvar(
      fichaTecnica,
      idEstabelecimento,
    );

    const precosPizza = normalizarPrecosPizzaProduto(req.body, categoriaValida);
    const precosVariacoes = normalizarPrecosVariacoesProduto(req.body, categoriaValida);
    const precoBaseRecebido = Number(req.body.preco || 0);
    const precoProduto = precosPizza.length
      ? Number(precosPizza[0].preco)
      : precosVariacoes.length
        ? Number(precosVariacoes[0].preco)
        : precoBaseRecebido;
    if (!Number.isFinite(precoProduto) || precoProduto < 0 || precoProduto > 100_000) {
      throw erroValidacao("Informe um preço válido para o produto.");
    }

    novaImagem = await armazenarUploadImagem(
      req.file,
      "produto",
      idEstabelecimento,
      "produtos",
    );
    await Produto.create({
      estabelecimentoId:
        idEstabelecimento,
      nome: String(
        req.body.nome || "",
      ).trim(),
      descricao: String(
        req.body.descricao || "",
      ).trim(),
      categoriaId:
        req.body.categoriaId,
      preco: precoProduto,
      precosPizza,
      precosVariacoes,
      custo: Number(
        req.body.custo || 0,
      ),
      fichaTecnica,
      adicionais:
        normalizarAdicionais(req.body),
      ativo:
        req.body.ativo === "on",
      imagem: novaImagem?.url || "",
      imagemArquivo: novaImagem,
    });

    return salvarERedirecionar(
      req,
      res,
      "catalogo",
      "Produto cadastrado.",
    );
  } catch (error) {
    appLogger.error(error);
    if (novaImagem?.storageKey && idEstabelecimento) {
      await removerUploadSemOcultarErro(novaImagem, idEstabelecimento)
        .catch(cleanupError =>
          appLogger.error("Falha ao limpar nova imagem de produto:", cleanupError.message));
    }
    const uploadResponse = responderErroUpload(
      req, res, error, "catalogo", "Não foi possível cadastrar o produto.",
    );
    if (uploadResponse) return uploadResponse;
    const validationResponse = responderErroValidacao(
      req, res, error, "catalogo",
    );
    if (validationResponse) return validationResponse;

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
  let novaImagem = null;
  let imagemAntiga = null;
  let idEstabelecimento = null;
  let produtoSalvo = false;
  try {
    idEstabelecimento = estabelecimentoId(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw erroValidacao("Produto inválido.");
    }
    const produto =
      await Produto.findOne({
        _id: req.params.id,
        estabelecimentoId:
          idEstabelecimento,
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
    if (!mongoose.isValidObjectId(produto.categoriaId)) {
      throw erroValidacao("Categoria de catálogo inválida.");
    }

    const categoriaValida =
      await Categoria.findOne({
        _id: produto.categoriaId,
        estabelecimentoId:
          estabelecimentoId(req),
        tipo: "catalogo",
      }).lean();

    if (!categoriaValida) {
      return erroERedirecionar(
        req,
        res,
        "catalogo",
        "Categoria de catálogo inválida.",
      );
    }

    const precosPizza = normalizarPrecosPizzaProduto(req.body, categoriaValida);
    const precosVariacoes = normalizarPrecosVariacoesProduto(req.body, categoriaValida);
    const precoBaseRecebido = Number(
      req.body.preco ?? produto.preco,
    );
    const precoProduto = precosPizza.length
      ? Number(precosPizza[0].preco)
      : precosVariacoes.length
        ? Number(precosVariacoes[0].preco)
        : precoBaseRecebido;
    if (!Number.isFinite(precoProduto) || precoProduto < 0 || precoProduto > 100_000) {
      throw erroValidacao("Informe um preço válido para o produto.");
    }
    produto.preco = precoProduto;
    produto.precosPizza = precosPizza;
    produto.precosVariacoes = precosVariacoes;

    produto.custo = Number(
      req.body.custo ??
        produto.custo ??
        0,
    );

    const fichaTecnicaAnterior = Array.from(produto.fichaTecnica || []);
    produto.fichaTecnica = await montarFichaTecnicaProduto(
      req.body,
      estabelecimentoId(req),
      { fichaAnterior: fichaTecnicaAnterior },
    );

    produto.adicionais =
      normalizarAdicionais(req.body);

    produto.ativo =
      req.body.ativo === "on";

    if (req.file) {
      imagemAntiga = produto.imagemArquivo?.toObject?.()
        || produto.imagemArquivo
        || null;
      novaImagem = await armazenarUploadImagem(
        req.file,
        "produto",
        idEstabelecimento,
        "produtos",
      );
      produto.imagem = novaImagem.url;
      produto.imagemArquivo = novaImagem;
    }

    await validarFichaAntesDeSalvar(
      produto.fichaTecnica,
      estabelecimentoId(req),
      fichaTecnicaAnterior,
    );
    await produto.save();
    produtoSalvo = true;
    await removerUploadSemOcultarErro(imagemAntiga, idEstabelecimento)
      .catch(cleanupError =>
        appLogger.error("Imagem anterior de produto ficou órfã:", cleanupError.message));

    return salvarERedirecionar(
      req,
      res,
      "catalogo",
      "Produto atualizado.",
    );
  } catch (error) {
    appLogger.error(error);
    if (!produtoSalvo && novaImagem?.storageKey && idEstabelecimento) {
      await removerUploadSemOcultarErro(novaImagem, idEstabelecimento)
        .catch(cleanupError =>
          appLogger.error("Falha ao limpar nova imagem de produto:", cleanupError.message));
    }
    const uploadResponse = responderErroUpload(
      req, res, error, "catalogo", "Não foi possível atualizar o produto.",
    );
    if (uploadResponse) return uploadResponse;
    const validationResponse = responderErroValidacao(
      req, res, error, "catalogo",
    );
    if (validationResponse) return validationResponse;

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
  next,
) => {
  const produtoId = String(req.params.id || "");
  const idEstabelecimento = estabelecimentoId(req);
  if (!mongoose.isValidObjectId(produtoId)) {
    return res.status(422).json({
      ok: false,
      code: "PRODUCT_ID_INVALID",
      message: "Produto inválido.",
      correlationId: req.correlationId,
    });
  }

  let session = null;
  let produtoExcluido = null;
  let imagemCompartilhada = false;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      produtoExcluido = await Produto.findOne({
        _id: produtoId,
        estabelecimentoId: idEstabelecimento,
      }).session(session);

      if (!produtoExcluido) return;

      const fichaTecnicaSnapshot = (produtoExcluido.fichaTecnica || [])
        .map(item => ({
          estoqueId: item.estoqueId,
          nome: item.nome,
          quantidade: item.quantidade,
          unidade: item.unidade,
          custoCalculado: item.custoCalculado,
        }));

      await Pedido.updateMany(
        {
          estabelecimentoId: idEstabelecimento,
          "itens.produtoId": produtoExcluido._id,
        },
        {
          $set: {
            "itens.$[item].fichaTecnicaSnapshot": fichaTecnicaSnapshot,
            "itens.$[item].fichaTecnicaSnapshotCriado": true,
            "itens.$[item].custoUnitarioSnapshot":
              Number(produtoExcluido.custo || 0),
          },
        },
        {
          arrayFilters: [{
            "item.produtoId": produtoExcluido._id,
            "item.fichaTecnicaSnapshotCriado": { $ne: true },
          }],
          session,
        },
      );

      const storageKey = produtoExcluido.imagemArquivo?.storageKey;
      if (storageKey) {
        imagemCompartilhada = await Produto.exists({
          _id: { $ne: produtoExcluido._id },
          estabelecimentoId: idEstabelecimento,
          "imagemArquivo.storageKey": storageKey,
        }).session(session);
      }

      const resultado = await Produto.deleteOne(
        {
          _id: produtoExcluido._id,
          estabelecimentoId: idEstabelecimento,
        },
        { session },
      );
      if (resultado.deletedCount !== 1) {
        const error = new Error("O produto mudou durante a exclusão.");
        error.code = "PRODUCT_DELETE_CONFLICT";
        throw error;
      }
    });

    if (!produtoExcluido) {
      return res.status(404).json({
        ok: false,
        code: "PRODUCT_NOT_FOUND",
        message: "Produto não encontrado.",
        correlationId: req.correlationId,
      });
    }

    let limpezaImagemPendente = false;
    if (!imagemCompartilhada && produtoExcluido.imagemArquivo?.storageKey) {
      try {
        await removerUploadSemOcultarErro(
          produtoExcluido.imagemArquivo,
          idEstabelecimento,
        );
      } catch (error) {
        limpezaImagemPendente = true;
        appLogger.error("product_image_cleanup_pending", {
          correlationId: req.correlationId,
          produtoId,
          code: error?.code || "STORAGE_REMOCAO_FALHOU",
        });
      }
    }

    return res.status(200).json({
      ok: true,
      code: "PRODUCT_DELETED",
      produtoId,
      message: "Produto excluído permanentemente.",
      section: "catalogo",
      ...(limpezaImagemPendente ? { limpezaImagemPendente: true } : {}),
    });
  } catch (error) {
    return next(error);
  } finally {
    await session?.endSession();
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
    appLogger.error(error);

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
    appLogger.error(error);

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
        excluido: { $ne: true },
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
    appLogger.error(error);

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
    appLogger.error(error);

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
  const secaoRetorno = req.body?.retorno === "pedidos" ? "pedidos" : "mesas";
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
        secaoRetorno,
        "Mesa não encontrada.",
      );
    }

    mesa.status =
      "aguardando_pagamento";

    await mesa.save();

    return salvarERedirecionar(
      req,
      res,
      secaoRetorno,
      "Mesa marcada como aguardando pagamento.",
    );
  } catch (error) {
    appLogger.error(error);

    return erroERedirecionar(
      req,
      res,
      secaoRetorno,
      "Não foi possível solicitar a conta.",
    );
  }
};

exports.pagarContaMesa = async (
  req,
  res,
) => {
  const secaoRetorno = req.body?.retorno === "pedidos" ? "pedidos" : "mesas";
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
        secaoRetorno,
        "Mesa não encontrada.",
      );
    }

    const pedidosPendentes = await Pedido.find({
      estabelecimentoId: idEstabelecimento,
      mesaId: mesa._id,
      excluido: { $ne: true },
      pagamentoStatus: "pendente",
      status: { $ne: "cancelado" },
    });

    const totalContaCentavos = pedidosPendentes.reduce(
      (total, pedido) => total + totalParaCentavos(pedido.total || 0),
      0,
    );
    const planoConta = montarPlanoPagamentoMesa(
      req.body,
      totalContaCentavos,
    );
    const distribuicoes = distribuirPagamentosPorPedidos(
      pedidosPendentes,
      planoConta.pagamentos,
    );

    for (const distribuicao of distribuicoes) {
      await confirmarPedidoComEstoque(distribuicao.pedido, {
        formaPagamento: distribuicao.formaPagamento,
        pagamentos: distribuicao.pagamentos,
        finalizar: true,
        usuarioId: req.session.user.id,
      });
    }

    mesa.status = "livre";
    await mesa.save();

    return salvarERedirecionar(
      req,
      res,
      secaoRetorno,
      "Conta paga e mesa liberada.",
    );
  } catch (error) {
    appLogger.error(error);

    return erroERedirecionar(
      req,
      res,
      secaoRetorno,
      error?.code === "MESA_PAYMENT_VALIDATION"
        ? error.message
        : "Não foi possível finalizar o pagamento.",
    );
  }

};

exports.resumoMesas = async (
  req,
  res,
) => {
  try {
    const idEstabelecimento =
      estabelecimentoId(req);

    const [mesas, pedidosPendentes] =
      await Promise.all([
        Mesa.find({
          estabelecimentoId:
            idEstabelecimento,
        })
          .select(
            "_id numero status",
          )
          .sort({ numero: 1 })
          .lean(),

        Pedido.find({
          estabelecimentoId:
            idEstabelecimento,
          canal: "mesa",
          mesaId: { $ne: null },
          excluido: { $ne: true },
          pagamentoStatus:
            "pendente",
          status: { $ne: "cancelado" },
        })
          .select(
            "_id mesaId total createdAt",
          )
          .sort({ createdAt: 1 })
          .lean(),
      ]);

    const contasPorMesa =
      new Map();

    pedidosPendentes.forEach(
      pedido => {
        const idMesa = String(
          pedido.mesaId?._id ||
            pedido.mesaId ||
            "",
        );

        if (!idMesa) {
          return;
        }

        const conta =
          contasPorMesa.get(idMesa) || {
            quantidadePedidos: 0,
            totalCentavos: 0,
            pedidoIds: [],
          };

        conta.quantidadePedidos += 1;
        conta.totalCentavos +=
          totalParaCentavos(
            pedido.total || 0,
          );
        conta.pedidoIds.push(
          String(pedido._id),
        );

        contasPorMesa.set(
          idMesa,
          conta,
        );
      },
    );

    return res.json({
      success: true,
      agora:
        new Date().toISOString(),
      mesas: mesas.map(mesa => {
        const conta =
          contasPorMesa.get(
            String(mesa._id),
          ) || {
            quantidadePedidos: 0,
            totalCentavos: 0,
            pedidoIds: [],
          };

        return {
          id: String(mesa._id),
          numero: mesa.numero,
          status:
            String(mesa.status || "livre"),
          quantidadePedidos:
            conta.quantidadePedidos,
          totalCentavos:
            conta.totalCentavos,
          pedidoIds:
            conta.pedidoIds,
        };
      }),
    });
  } catch (error) {
    appLogger.error(
      "Erro ao atualizar resumo das mesas:",
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        "Não foi possível atualizar as mesas.",
    });
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

function erroPermissaoFuncionario(mensagem) {
  const error = new Error(mensagem);
  error.code = "PERMISSAO_FUNCIONARIO_NEGADA";
  error.statusCode = 403;
  return error;
}

function normalizarPermissoesFuncionario(valores) {
  const permissoes = [...new Set(
    (valores ? [].concat(valores) : [])
      .map(valor => String(valor || "").trim())
      .filter(Boolean),
  )];
  if (permissoes.some(permissao => !ALL_PERMISSIONS.has(permissao))) {
    throw erroPermissaoFuncionario("Uma permissão informada não é válida.");
  }
  return permissoes;
}

function validarAdministracaoFuncionario(
  req,
  permissoes,
  { funcionarioAlvoId = null } = {},
) {
  const usuarioAtual = req.usuarioAtual || req.session?.user || {};
  const idEstabelecimento = String(
    usuarioAtual.estabelecimentoId || usuarioAtual.id || "",
  );
  const estabelecimentoInformado = String(
    req.body?.estabelecimentoId || "",
  ).trim();
  if (
    estabelecimentoInformado
    && estabelecimentoInformado !== idEstabelecimento
  ) {
    throw erroPermissaoFuncionario(
      "Não é permitido alterar o estabelecimento do funcionário.",
    );
  }
  if (
    String(req.body?.tipo || "").toLowerCase() === "proprietario"
    || String(req.body?.funcao || "").toLowerCase() === "proprietario"
  ) {
    throw erroPermissaoFuncionario(
      "Funcionários não podem ser promovidos a proprietário.",
    );
  }
  if (usuarioAtual.tipo === "proprietario") return permissoes;

  if (
    funcionarioAlvoId
    && String(funcionarioAlvoId) === String(usuarioAtual.id || usuarioAtual._id)
  ) {
    throw erroPermissaoFuncionario(
      "Você não pode editar suas próprias permissões ou situação.",
    );
  }
  if (
    permissoes.some(permissao =>
      CRITICAL_PERMISSIONS.has(permissao))
  ) {
    throw erroPermissaoFuncionario(
      "Somente o proprietário pode conceder permissões administrativas.",
    );
  }
  const permissoesDoOperador = new Set(req.permissoesAtuais || []);
  if (permissoes.some(permissao => !permissoesDoOperador.has(permissao))) {
    throw erroPermissaoFuncionario(
      "Você não pode conceder uma permissão superior às suas.",
    );
  }
  return permissoes;
}

function responderErroFuncionario(req, res, error, mensagemPadrao) {
  if (error?.code === "PERMISSAO_FUNCIONARIO_NEGADA") {
    if (
      req.xhr
      || String(req.get?.("accept") || "").includes("application/json")
    ) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }
    res.status(403);
    return erroERedirecionar(req, res, "funcionarios", error.message);
  }
  return erroERedirecionar(req, res, "funcionarios", mensagemPadrao);
}

async function emailFuncionarioEmUso(email, funcionarioId = null) {
  const filtroFuncionario = { email };
  if (funcionarioId) {
    filtroFuncionario._id = { $ne: funcionarioId };
  }
  const [funcionario, proprietario] = await Promise.all([
    Funcionario.exists(filtroFuncionario),
    registroModel.exists({ email }),
  ]);
  return Boolean(funcionario || proprietario);
}

exports.criarFuncionario = async (
  req,
  res,
) => {
  let novaImagem = null;
  let idEstabelecimento = null;
  try {
    idEstabelecimento =
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

    const passwordResult = validatePassword(senha);
    if (!passwordResult.valid) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        passwordResult.errors[0],
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

    const [emailEmUso, cpfEmUso] = await Promise.all([
      emailFuncionarioEmUso(email),
      Funcionario.exists({
        estabelecimentoId: idEstabelecimento,
        cpf,
      }),
    ]);

    if (emailEmUso || cpfEmUso) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Este e-mail já está cadastrado ou o CPF já pertence a um funcionário desta loja.",
      );
    }

    const permissoes = validarAdministracaoFuncionario(
      req,
      normalizarPermissoesFuncionario(
        req.body.permissoes
          ? req.body.permissoes
          : permissoesPadrao(req.body.funcao),
      ),
    );

    novaImagem = await armazenarUploadImagem(
      req.file,
      "funcionario",
      idEstabelecimento,
      "funcionarios",
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
      foto: novaImagem?.url || "",
      fotoArquivo: novaImagem,
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
    appLogger.error(error);
    if (novaImagem?.storageKey && idEstabelecimento) {
      await removerUploadSemOcultarErro(novaImagem, idEstabelecimento)
        .catch(cleanupError =>
          appLogger.error("Falha ao limpar nova foto de funcionário:", cleanupError.message));
    }
    const uploadResponse = responderErroUpload(
      req, res, error, "funcionarios", "Não foi possível cadastrar o funcionário.",
    );
    if (uploadResponse) return uploadResponse;

    return responderErroFuncionario(
      req,
      res,
      error,
      error?.code === 11000
        ? "Este e-mail já está cadastrado."
        : "Não foi possível cadastrar o funcionário.",
    );
  }
};

exports.editarFuncionario = async (
  req,
  res,
) => {
  let novaImagem = null;
  let imagemAntiga = null;
  let idEstabelecimento = null;
  let funcionarioSalvo = false;
  try {
    idEstabelecimento =
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

    const permissoes = validarAdministracaoFuncionario(
      req,
      normalizarPermissoesFuncionario(req.body.permissoes),
      { funcionarioAlvoId: funcionario._id },
    );

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

    const [emailEmUso, cpfEmUso] = await Promise.all([
      emailFuncionarioEmUso(email, funcionario._id),
      Funcionario.exists({
        estabelecimentoId: idEstabelecimento,
        cpf,
        _id: { $ne: funcionario._id },
      }),
    ]);

    if (emailEmUso || cpfEmUso) {
      return erroERedirecionar(
        req,
        res,
        "funcionarios",
        "Este e-mail já está cadastrado ou o CPF já pertence a outro funcionário desta loja.",
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

    funcionario.permissoes = permissoes;

    if (req.file) {
      imagemAntiga = funcionario.fotoArquivo?.toObject?.()
        || funcionario.fotoArquivo
        || null;
      novaImagem = await armazenarUploadImagem(
        req.file,
        "funcionario",
        idEstabelecimento,
        "funcionarios",
      );
      funcionario.foto = novaImagem.url;
      funcionario.fotoArquivo = novaImagem;
    }

    const novaSenha = String(
      req.body.senha || "",
    );

    if (novaSenha) {
      const passwordResult = validatePassword(novaSenha);
      if (!passwordResult.valid) {
        return erroERedirecionar(
          req,
          res,
          "funcionarios",
          passwordResult.errors[0],
        );
      }

      funcionario.senha =
        await bcrypt.hash(
          novaSenha,
          10,
        );
    }

    await funcionario.save();
    funcionarioSalvo = true;
    await removerUploadSemOcultarErro(imagemAntiga, idEstabelecimento)
      .catch(cleanupError =>
        appLogger.error("Foto anterior de funcionário ficou órfã:", cleanupError.message));

    return salvarERedirecionar(
      req,
      res,
      "funcionarios",
      "Funcionário atualizado.",
    );
  } catch (error) {
    appLogger.error(error);
    if (!funcionarioSalvo && novaImagem?.storageKey && idEstabelecimento) {
      await removerUploadSemOcultarErro(novaImagem, idEstabelecimento)
        .catch(cleanupError =>
          appLogger.error("Falha ao limpar nova foto de funcionário:", cleanupError.message));
    }
    const uploadResponse = responderErroUpload(
      req, res, error, "funcionarios", "Não foi possível atualizar o funcionário.",
    );
    if (uploadResponse) return uploadResponse;

    return responderErroFuncionario(
      req,
      res,
      error,
      error?.code === 11000
        ? "Este e-mail já está cadastrado."
        : "Não foi possível atualizar o funcionário.",
    );
  }
};

exports.excluirFuncionario = async (
  req,
  res,
) => {
  try {
    const usuarioAtual = req.usuarioAtual || req.session?.user || {};
    if (
      usuarioAtual.tipo === "funcionario"
      && String(req.params.id) === String(usuarioAtual.id || usuarioAtual._id)
    ) {
      throw erroPermissaoFuncionario(
        "Você não pode excluir o próprio usuário.",
      );
    }
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
    appLogger.error(error);

    return responderErroFuncionario(
      req,
      res,
      error,
      "Não foi possível excluir o funcionário.",
    );
  }
};

/*
|--------------------------------------------------------------------------
| CIDADES E TAXAS DE ENTREGA
|--------------------------------------------------------------------------
*/

function mensagemErroCidadeEntrega(error, fallback) {
  if (error?.code === 11000) {
    return "Esta cidade e UF já estão cadastradas para a loja.";
  }
  if (error?.code === "CIDADE_ENTREGA_INVALIDA") {
    return error.message;
  }
  return fallback;
}

exports.criarCidadeEntrega = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const dados = montarDadosCidadeEntrega(req.body);

    const existente = await CidadeEntrega.exists({
      estabelecimentoId: idEstabelecimento,
      nomeNormalizado: dados.nomeNormalizado,
      uf: dados.uf,
    });

    if (existente) {
      return erroERedirecionar(
        req,
        res,
        "configuracoes",
        "Esta cidade e UF já estão cadastradas. Edite ou reative o registro existente.",
      );
    }

    await CidadeEntrega.create({
      estabelecimentoId: idEstabelecimento,
      ...dados,
      ativo: true,
      desativadoEm: null,
    });

    return salvarERedirecionar(
      req,
      res,
      "configuracoes",
      "Cidade de entrega cadastrada.",
    );
  } catch (error) {
    appLogger.error("delivery_city_create_failed", {
      correlationId: req.correlationId,
      code: error?.code || "DELIVERY_CITY_CREATE_FAILED",
    });

    return erroERedirecionar(
      req,
      res,
      "configuracoes",
      mensagemErroCidadeEntrega(error, "Não foi possível cadastrar a cidade de entrega."),
    );
  }
};

exports.editarCidadeEntrega = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);

    if (!mongoose.isValidObjectId(req.params.id)) {
      return erroERedirecionar(
        req,
        res,
        "configuracoes",
        "Cidade de entrega não encontrada.",
      );
    }

    const cidade = await CidadeEntrega.findOne({
      _id: req.params.id,
      estabelecimentoId: idEstabelecimento,
    });

    if (!cidade) {
      return erroERedirecionar(
        req,
        res,
        "configuracoes",
        "Cidade de entrega não encontrada.",
      );
    }

    const dados = montarDadosCidadeEntrega(req.body);
    const duplicada = await CidadeEntrega.exists({
      _id: { $ne: cidade._id },
      estabelecimentoId: idEstabelecimento,
      nomeNormalizado: dados.nomeNormalizado,
      uf: dados.uf,
    });

    if (duplicada) {
      return erroERedirecionar(
        req,
        res,
        "configuracoes",
        "Esta cidade e UF já estão cadastradas.",
      );
    }

    cidade.nome = dados.nome;
    cidade.nomeNormalizado = dados.nomeNormalizado;
    cidade.uf = dados.uf;
    cidade.taxaCentavos = dados.taxaCentavos;
    cidade.pedidoMinimoCentavos = dados.pedidoMinimoCentavos;
    cidade.abaixoMinimoModo = dados.abaixoMinimoModo;
    cidade.taxaAbaixoMinimoCentavos = dados.taxaAbaixoMinimoCentavos;
    await cidade.save();

    return salvarERedirecionar(
      req,
      res,
      "configuracoes",
      "Cidade, taxa e regra de pedido mínimo atualizadas.",
    );
  } catch (error) {
    appLogger.error("delivery_city_update_failed", {
      correlationId: req.correlationId,
      code: error?.code || "DELIVERY_CITY_UPDATE_FAILED",
    });

    return erroERedirecionar(
      req,
      res,
      "configuracoes",
      mensagemErroCidadeEntrega(error, "Não foi possível atualizar a cidade de entrega."),
    );
  }
};

exports.alterarStatusCidadeEntrega = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const valorAtivo = String(req.body?.ativo || "").trim().toLowerCase();

    if (!mongoose.isValidObjectId(req.params.id) || !["true", "false"].includes(valorAtivo)) {
      return erroERedirecionar(
        req,
        res,
        "configuracoes",
        "Situação da cidade de entrega inválida.",
      );
    }

    const ativo = valorAtivo === "true";
    const cidade = await CidadeEntrega.findOne({
      _id: req.params.id,
      estabelecimentoId: idEstabelecimento,
    });

    if (!cidade) {
      return erroERedirecionar(
        req,
        res,
        "configuracoes",
        "Cidade de entrega não encontrada.",
      );
    }

    cidade.ativo = ativo;
    cidade.desativadoEm = ativo ? null : new Date();
    await cidade.save();

    return salvarERedirecionar(
      req,
      res,
      "configuracoes",
      ativo
        ? "Cidade de entrega reativada."
        : "Cidade de entrega desativada.",
    );
  } catch (error) {
    appLogger.error("delivery_city_status_failed", {
      correlationId: req.correlationId,
      code: error?.code || "DELIVERY_CITY_STATUS_FAILED",
    });

    return erroERedirecionar(
      req,
      res,
      "configuracoes",
      "Não foi possível alterar a situação da cidade de entrega.",
    );
  }
};


/*
|--------------------------------------------------------------------------
| WHATSAPP API / AUTOMAÇÕES
|--------------------------------------------------------------------------
*/

function listaCampoFormulario(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizarWhatsAppMenuOpcoes(body = {}) {
  const ids = listaCampoFormulario(body.menuOpcaoId);
  const titulos = listaCampoFormulario(body.menuOpcaoTitulo);
  const acoes = listaCampoFormulario(body.menuOpcaoAcao);
  const respostas = listaCampoFormulario(body.menuOpcaoResposta);
  const permitidas = new Set([
    "status_pedido",
    "falar_atendente",
    "abrir_cardapio",
    "resposta_personalizada",
  ]);

  return titulos.slice(0, 10).map((titulo, index) => {
    const tituloLimpo = String(titulo || "").trim().slice(0, 20);
    const idRecebido = String(ids[index] || "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 80);
    const acaoRecebida = String(acoes[index] || "resposta_personalizada").trim();
    return {
      id: idRecebido || `op_${crypto.randomBytes(6).toString("hex")}`,
      titulo: tituloLimpo,
      acao: permitidas.has(acaoRecebida) ? acaoRecebida : "resposta_personalizada",
      resposta: String(respostas[index] || "").trim().slice(0, 1200),
      ativo: Boolean(tituloLimpo),
      ordem: index,
    };
  }).filter(item => item.titulo);
}

exports.salvarWhatsAppConfiguracao = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const ativo = req.body.ativo === "on";
    const menuAtivo = req.body.menuAtivo === "on";
    const phoneNumberId = whatsappCloudApi.somenteDigitos(
      process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    );
    const menuOpcoes = normalizarWhatsAppMenuOpcoes(req.body);

    if (ativo && !phoneNumberId) {
      return erroERedirecionar(
        req,
        res,
        "whatsapp",
        "O WHATSAPP_PHONE_NUMBER_ID ainda não está configurado no servidor.",
      );
    }
    if (ativo && !String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim()) {
      return erroERedirecionar(
        req,
        res,
        "whatsapp",
        "O WHATSAPP_ACCESS_TOKEN ainda não está configurado no servidor.",
      );
    }
    if (menuAtivo && menuOpcoes.length === 0) {
      return erroERedirecionar(
        req,
        res,
        "whatsapp",
        "Adicione pelo menos uma opção ao menu automático.",
      );
    }

    const idHash = phoneNumberId ? phoneNumberIdHash(phoneNumberId) : "";
    if (ativo && idHash) {
      const conflito = await WhatsAppConfiguracao.findOne({
        phoneNumberIdHash: idHash,
        estabelecimentoId: { $ne: idEstabelecimento },
      }).select("_id estabelecimentoId").lean();
      if (conflito) {
        return erroERedirecionar(
          req,
          res,
          "whatsapp",
          "Este número do WhatsApp já está vinculado a outro estabelecimento.",
        );
      }
    }

    await WhatsAppConfiguracao.findOneAndUpdate(
      { estabelecimentoId: idEstabelecimento },
      {
        $set: {
          ativo,
          phoneNumberIdHash: ativo ? idHash : "",
          phoneNumberIdSuffix: ativo ? phoneNumberId.slice(-8) : "",
          conectadoEm: ativo ? new Date() : null,
          menuAtivo,
          mensagemBoasVindas: String(req.body.mensagemBoasVindas || "")
            .trim().slice(0, 1000),
          mensagemMenu: String(req.body.mensagemMenu || "")
            .trim().slice(0, 1000),
          mensagemFallback: String(req.body.mensagemFallback || "")
            .trim().slice(0, 1000),
          mensagemPedidoNaoEncontrado: String(req.body.mensagemPedidoNaoEncontrado || "")
            .trim().slice(0, 1000),
          textoBotaoMenu: String(req.body.textoBotaoMenu || "Ver opções")
            .trim().slice(0, 20) || "Ver opções",
          menuOpcoes,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    );

    appLogger.info("whatsapp_automation_config_saved", {
      correlationId: req.correlationId,
      estabelecimentoIdSuffix: String(idEstabelecimento).slice(-8),
      ativo,
      menuAtivo,
      menuOptions: menuOpcoes.length,
      phoneNumberIdSuffix: ativo ? phoneNumberId.slice(-8) : null,
    });
    return salvarERedirecionar(
      req,
      res,
      "whatsapp",
      ativo
        ? "WhatsApp API ativado. O atendimento automático já pode responder mensagens."
        : "Configuração do WhatsApp salva com o atendimento automático desativado.",
    );
  } catch (error) {
    appLogger.error("whatsapp_automation_config_save_failed", {
      correlationId: req.correlationId,
      code: error?.code || "WHATSAPP_CONFIG_SAVE_FAILED",
    });
    return erroERedirecionar(
      req,
      res,
      "whatsapp",
      "Não foi possível salvar a configuração do WhatsApp.",
    );
  }
};

exports.responderWhatsAppConversa = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const conversaId = String(req.params?.id || req.body?.whatsappConversaId || "").trim();
    const texto = String(req.body.mensagem || "").trim().slice(0, 4096);
    if (!texto) {
      return erroERedirecionar(req, res, "whatsapp", "Digite uma mensagem para o cliente.");
    }
    const [conversa, config] = await Promise.all([
      WhatsAppConversa.findOne({
        _id: conversaId,
        estabelecimentoId: idEstabelecimento,
      }),
      WhatsAppConfiguracao.findOne({
        estabelecimentoId: idEstabelecimento,
        ativo: true,
      }).lean(),
    ]);
    if (!conversa || !config) {
      return erroERedirecionar(
        req,
        res,
        "whatsapp",
        "Conversa não encontrada ou WhatsApp API desativado.",
      );
    }
    const ultimaEntradaMs = conversa.ultimaEntradaEm
      ? new Date(conversa.ultimaEntradaEm).getTime()
      : 0;
    if (!ultimaEntradaMs || Date.now() - ultimaEntradaMs > 24 * 60 * 60 * 1000) {
      return erroERedirecionar(
        req,
        res,
        "whatsapp",
        "A janela de atendimento de 24 horas terminou. Aguarde o cliente enviar uma nova mensagem ou use um template aprovado pela Meta.",
      );
    }

    const phoneNumberId = whatsappCloudApi.somenteDigitos(process.env.WHATSAPP_PHONE_NUMBER_ID || "");
    if (!phoneNumberId || phoneNumberIdHash(phoneNumberId) !== config.phoneNumberIdHash) {
      return erroERedirecionar(
        req,
        res,
        "whatsapp",
        "A credencial do número conectado não corresponde a esta loja.",
      );
    }

    const envio = await whatsappCloudApi.enviarTexto({
      phoneNumberId,
      to: conversa.clienteWaId,
      text: texto,
      correlationId: req.correlationId,
    });
    await WhatsAppMensagem.create({
      estabelecimentoId: idEstabelecimento,
      conversaId: conversa._id,
      direcao: "saida",
      tipo: "text",
      texto,
      metaMessageIdHash: envio.messageId
        ? crypto.createHash("sha256").update(`message-id:${String(process.env.WHATSAPP_APP_SECRET || process.env.SESSION_SECRET || "comanda-facil")}:${envio.messageId}`).digest("hex")
        : "",
      status: "sent",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    conversa.modo = "atendente";
    conversa.ultimaSaidaEm = new Date();
    conversa.naoLidas = 0;
    conversa.expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await conversa.save();

    return salvarERedirecionar(req, res, "whatsapp", "Mensagem enviada pelo WhatsApp.");
  } catch (error) {
    appLogger.error("whatsapp_human_reply_failed", {
      correlationId: req.correlationId,
      code: error?.code || "WHATSAPP_HUMAN_REPLY_FAILED",
      providerCode: error?.providerCode || null,
    });
    return erroERedirecionar(
      req,
      res,
      "whatsapp",
      "Não foi possível enviar a mensagem pelo WhatsApp.",
    );
  }
};

exports.reativarWhatsAppBot = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const conversaId = String(req.params?.id || req.body?.whatsappConversaId || "").trim();
    const conversa = await WhatsAppConversa.findOneAndUpdate(
      {
        _id: conversaId,
        estabelecimentoId: idEstabelecimento,
      },
      {
        $set: {
          modo: "bot",
          atendenteSolicitadoEm: null,
          naoLidas: 0,
        },
      },
      { returnDocument: "after" },
    );
    if (!conversa) {
      return erroERedirecionar(req, res, "whatsapp", "Conversa não encontrada.");
    }
    return salvarERedirecionar(
      req,
      res,
      "whatsapp",
      "Atendimento automático reativado para este cliente.",
    );
  } catch (error) {
    appLogger.error("whatsapp_bot_reactivate_failed", {
      correlationId: req.correlationId,
      code: error?.code || "WHATSAPP_BOT_REACTIVATE_FAILED",
    });
    return erroERedirecionar(req, res, "whatsapp", "Não foi possível reativar o robô.");
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
  // Compatibilidade: as ações da aba WhatsApp usam a rota administrativa
  // consolidada /admin/configuracoes. Isso evita depender de novas rotas
  // durante deploys parciais e preserva o mesmo CSRF/permissão da seção.
  const whatsappAction = String(req.body?._whatsappAction || "").trim();
  if (whatsappAction === "configuracao") {
    return exports.salvarWhatsAppConfiguracao(req, res);
  }
  if (whatsappAction === "responder_conversa") {
    return exports.responderWhatsAppConversa(req, res);
  }
  if (whatsappAction === "reativar_bot") {
    return exports.reativarWhatsAppBot(req, res);
  }

  let novaImagem = null;
  let imagemAntiga = null;
  let idEstabelecimento = null;
  let configuracaoSalva = false;
  try {
    idEstabelecimento =
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
      const configuracaoAnterior = await Configuracao.findOne({
        estabelecimentoId: idEstabelecimento,
      }).select("fotoPerfilArquivo");
      imagemAntiga = configuracaoAnterior?.fotoPerfilArquivo?.toObject?.()
        || configuracaoAnterior?.fotoPerfilArquivo
        || null;
      novaImagem = await armazenarUploadImagem(
        req.file,
        "perfil",
        idEstabelecimento,
        "perfil",
      );
      atualizacao.fotoPerfil = novaImagem.url;
      atualizacao.fotoPerfilArquivo = novaImagem;
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
    configuracaoSalva = true;
    await removerUploadSemOcultarErro(imagemAntiga, idEstabelecimento)
      .catch(cleanupError =>
        appLogger.error("Foto anterior do perfil ficou órfã:", cleanupError.message));

    return salvarERedirecionar(
      req,
      res,
      'configuracoes',
      'Configurações salvas.'
    );
  } catch (error) {
    appLogger.error(
      'Erro ao salvar configurações:',
      error
    );
    if (!configuracaoSalva && novaImagem?.storageKey && idEstabelecimento) {
      await removerUploadSemOcultarErro(novaImagem, idEstabelecimento)
        .catch(cleanupError =>
          appLogger.error("Falha ao limpar nova foto do perfil:", cleanupError.message));
    }
    const uploadResponse = responderErroUpload(
      req, res, error, "configuracoes", "Não foi possível salvar as configurações.",
    );
    if (uploadResponse) return uploadResponse;

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

    // Jobs ainda não entregues que apontavam para uma impressora removida,
    // desativada ou que deixou de atender a origem do pedido não podem ficar
    // presos para sempre na fila. Eles são cancelados de forma segura e uma
    // reimpressão manual continua disponível caso o operador precise.
    try {
      await printQueueService.reconciliarJobsComImpressorasAtuais(
        idEstabelecimento,
        impressoras,
      );
    } catch (reconcileError) {
      // A configuração já foi salva. Uma falha do reconciliador não deve
      // transformar o salvamento bem-sucedido em erro para o usuário; o
      // worker periódico tentará novamente em seguida.
      appLogger.error("Erro ao reconciliar fila após salvar impressoras:", reconcileError);
    }

    return salvarERedirecionar(
      req,
      res,
      "configuracoes",
      "Configurações das impressoras USB e de rede salvas.",
    );
  } catch (error) {
    appLogger.error(
      "Erro ao salvar impressoras:",
      error,
    );

    const validationResponse = responderErroValidacao(
      req,
      res,
      error,
      "configuracoes",
    );
    if (validationResponse) return validationResponse;
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
          excluido: { $ne: true },
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
        numero: numeroPedidoExibicao(pedido),
        codigoPublico: String(pedido.codigoPublico || "").toUpperCase(),
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
        rua: pedido.ruaEntrega || "",
        numeroEndereco: pedido.numeroEntrega || "",
        bairro: pedido.bairroEntrega || "",
        referencia: pedido.referenciaEntrega || "",
        cidadeEntrega: pedido.cidadeEntregaNome || "",
        cidadeEntregaUf: pedido.cidadeEntregaUf || "",
        observacao:
          pedido.observacao || "",
        subtotalProdutos:
          Number(
            pedido.subtotalProdutos
            || Math.max(0, Number(pedido.total || 0) - Number(pedido.taxaEntregaCentavos || 0) / 100),
          ),
        taxaEntregaCentavos:
          Number(pedido.taxaEntregaCentavos || 0),
        taxaEntrega:
          Number(pedido.taxaEntregaCentavos || 0) / 100,
        total:
          Number(pedido.total || 0),
        status:
          pedido.status || "novo",
        pagamentoStatus:
          pedido.pagamentoStatus ||
          "pendente",
        formaPagamento:
          pedido.formaPagamento || pedido.metodoPagamento || pedido.pagamentoMetodo || "nao_informado",
        pagamentos:
          Array.isArray(pedido.pagamentos)
            ? pedido.pagamentos.map(item => ({
                formaPagamento: String(item.formaPagamento || ""),
                valorCentavos: Number(item.valorCentavos || 0),
              }))
            : [],
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
    appLogger.error(
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
        "pronto",
        "entregue",
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
          excluido: { $ne: true },
        });

      if (!pedido) {
        return erroERedirecionar(
          req,
          res,
          "pedidos",
          "Pedido não encontrado.",
        );
      }

      if (status === "cancelado") {
        const resultadoEstoque = await restaurarEstoqueDoPedido(pedido._id);
        if (!resultadoEstoque?.success) {
          adicionarHistoricoFinanceiro(pedido, {
            tipo: "falha_estoque_cancelamento",
            statusAnterior: pedido.pagamentoStatus,
            statusNovo: pedido.pagamentoStatus,
            usuarioId: req.session.user.id,
            motivo: resultadoEstoque?.errorCode || "Falha na restauração.",
            operationKey:
              `falha_cancelamento:${pedido._id}:${resultadoEstoque?.errorCode || "erro"}`,
          });
          await pedido.save();
        }
        exigirMovimentacaoEstoqueConcluida(resultadoEstoque);
        if (resultadoEstoque.status !== "nao_baixado") {
          adicionarHistoricoFinanceiro(pedido, {
            tipo: "restauracao_estoque_manual",
            statusAnterior: pedido.pagamentoStatus,
            statusNovo: pedido.pagamentoStatus,
            usuarioId: req.session.user.id,
            operationKey: `restauracao_manual:${pedido._id}`,
          });
          await registrarAuditoria({
            estabelecimentoId: idEstabelecimento,
            entidade: "pedido",
            entidadeId: pedido._id,
            acao: "estoque_restaurado",
            usuarioId: req.session.user.id,
            usuarioTipo: req.session.user.tipo,
            dadosResumidos: {
              codigoPedido: String(pedido.codigoPublico || pedido._id).slice(pedido.codigoPublico ? 0 : -6).toUpperCase(),
              resultado: resultadoEstoque.status,
              estoqueRestaurado: true,
            },
            operationKey: `auditoria:estoque_restaurado:${pedido._id}`,
          });
        }
        adicionarHistoricoFinanceiro(pedido, {
          tipo: "cancelamento_manual",
          statusAnterior: pedido.pagamentoStatus,
          statusNovo: "cancelado",
          usuarioId: req.session.user.id,
          motivo: String(req.body.motivo || "").trim(),
          operationKey: `cancelamento_manual:${pedido._id}`,
        });
        pedido.pagamentoStatus = "cancelado";
      }

      pedido.status = status;

      await pedido.save();
      await registrarAuditoria({
        estabelecimentoId: idEstabelecimento,
        entidade: "pedido",
        entidadeId: pedido._id,
        acao: status === "cancelado"
          ? "pedido_cancelado"
          : "status_sensivel_alterado",
        usuarioId: req.session.user.id,
        usuarioTipo: req.session.user.tipo,
        dadosResumidos: {
          codigoPedido: String(pedido.codigoPublico || pedido._id).slice(pedido.codigoPublico ? 0 : -6).toUpperCase(),
          statusNovo: status,
          pagamentoStatus: pedido.pagamentoStatus,
          motivo: String(req.body.motivo || "").trim().slice(0, 500),
        },
        operationKey: `auditoria:status:${pedido._id}:${status}`,
      });

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
            excluido: { $ne: true },
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
      appLogger.error(error);

      return erroERedirecionar(
        req,
        res,
        "pedidos",
        "Não foi possível atualizar o pedido.",
      );
    }
  };


exports.alterarFormaPagamentoPedido = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const novaForma = String(req.body?.formaPagamento || "")
      .trim()
      .toLowerCase();
    const formasPermitidas = new Set([
      "dinheiro",
      "pix",
      "cartao",
      "combinado",
    ]);

    if (!formasPermitidas.has(novaForma)) {
      return erroERedirecionar(
        req,
        res,
        "pedidos",
        "Selecione uma forma de pagamento válida.",
      );
    }

    const pedido = await Pedido.findOne({
      _id: req.params.id,
      estabelecimentoId: idEstabelecimento,
      excluido: { $ne: true },
      status: { $ne: "cancelado" },
    });

    if (!pedido) {
      return erroERedirecionar(
        req,
        res,
        "pedidos",
        "Pedido não encontrado.",
      );
    }

    const pagamentoOnlineAprovado = pedido.pagamentoStatus === "pago"
      && String(pedido.mercadoPagoStatus || "") === "approved"
      && (
        Boolean(String(pedido.mercadoPagoPaymentId || "").trim())
        || String(pedido.formaPagamento || "") === "pix_online"
      );
    if (pagamentoOnlineAprovado) {
      return erroERedirecionar(
        req,
        res,
        "pedidos",
        "Este pagamento Pix online foi aprovado pelo provedor e não pode ser reclassificado manualmente.",
      );
    }

    const formaAnterior = String(pedido.formaPagamento || "nao_informado");
    const pagamentosAnteriores = Array.isArray(pedido.pagamentos)
      ? pedido.pagamentos.map(item => ({
          formaPagamento: String(item?.formaPagamento || ""),
          valorCentavos: Number(item?.valorCentavos || 0),
        }))
      : [];

    const planoPagamento = montarPlanoPagamentoMesa(
      req.body || {},
      totalParaCentavos(pedido.total || 0),
    );

    const jaEstaIgual = formaAnterior === planoPagamento.formaPagamento
      && pagamentosAnteriores.length === planoPagamento.pagamentos.length
      && pagamentosAnteriores.every((item, index) => {
        const novo = planoPagamento.pagamentos[index];
        return item.formaPagamento === novo?.formaPagamento
          && item.valorCentavos === novo?.valorCentavos;
      });

    if (jaEstaIgual) {
      return salvarERedirecionar(
        req,
        res,
        "pedidos",
        "A forma de pagamento já está configurada dessa maneira.",
      );
    }

    pedido.formaPagamento = planoPagamento.formaPagamento;
    pedido.pagamentos = planoPagamento.pagamentos;

    // Ao corrigir a forma de pagamento, dados de troco anteriores deixam de ser
    // confiáveis. Se o pagamento real foi em dinheiro, o caixa pode registrar o
    // troco à parte; aqui preservamos apenas a forma efetivamente recebida.
    pedido.precisaTroco = false;
    pedido.trocoPara = null;
    pedido.valorTroco = null;

    adicionarHistoricoFinanceiro(pedido, {
      tipo: "forma_pagamento_corrigida",
      statusAnterior: pedido.pagamentoStatus || "pendente",
      statusNovo: pedido.pagamentoStatus || "pendente",
      formaPagamento: pedido.formaPagamento,
      pagamentos: pedido.pagamentos,
      usuarioId: req.session.user.id,
      motivo: pedido.formaPagamento === "combinado"
        ? `Pagamento corrigido de ${formaAnterior} para dois meios de pagamento.`
        : `Forma de pagamento corrigida de ${formaAnterior} para ${pedido.formaPagamento}.`,
    });

    await pedido.save();

    await registrarAuditoria({
      estabelecimentoId: idEstabelecimento,
      entidade: "pedido",
      entidadeId: pedido._id,
      acao: "forma_pagamento_corrigida",
      usuarioId: req.session.user.id,
      usuarioTipo: req.session.user.tipo,
      dadosResumidos: {
        codigoPedido: String(pedido.codigoPublico || pedido._id)
          .slice(pedido.codigoPublico ? 0 : -6)
          .toUpperCase(),
        pagamentoStatus: pedido.pagamentoStatus || "pendente",
        formaPagamento: pedido.formaPagamento,
        pagamentos: pedido.pagamentos.map(item => ({
          formaPagamento: String(item?.formaPagamento || ""),
          valorCentavos: Number(item?.valorCentavos || 0),
        })),
        motivo: `${formaAnterior} -> ${pedido.formaPagamento}`,
      },
    });

    const mensagem = pedido.pagamentoStatus === "pago"
      ? "Pagamento atualizado. Dashboard e relatórios já considerarão a nova divisão."
      : "Pagamento atualizado. O pedido continua pendente até a confirmação do pagamento.";

    return salvarERedirecionar(req, res, "pedidos", mensagem);
  } catch (error) {
    appLogger.error("Erro ao alterar forma de pagamento do pedido:", error);

    return erroERedirecionar(
      req,
      res,
      "pedidos",
      error?.statusCode && error.statusCode < 500
        ? error.message
        : "Não foi possível alterar a forma de pagamento.",
    );
  }
};

exports.confirmarPagamentoPedido =
  async (req, res) => {
    try {
      const idEstabelecimento =
        estabelecimentoId(req);

      const pedido =
        await Pedido.findOne({
          _id: req.params.id,
          estabelecimentoId:
            idEstabelecimento,
          excluido: { $ne: true },
          status: {
            $ne: "cancelado",
          },
        });

      if (!pedido) {
        return erroERedirecionar(
          req,
          res,
          "pedidos",
          "Pedido não encontrado.",
        );
      }

      if (pedido.pagamentoStatus !== "pago") {
        const possuiPixOnline = valorFormaPagamentoCentavos(
          pedido,
          ["pix_online"],
        ) > 0 || (
          String(pedido.formaPagamento || "") === "pix"
          && Boolean(String(pedido.mercadoPagoPaymentId || "").trim())
        );
        const pagamentoCombinado = String(pedido.formaPagamento || "") === "combinado";

        if (possuiPixOnline && !pagamentoCombinado) {
          return erroERedirecionar(
            req,
            res,
            "pedidos",
            "Pagamentos Pix devem ser confirmados automaticamente pelo provedor.",
          );
        }

        if (possuiPixOnline
          && pagamentoCombinado
          && pedido.mercadoPagoStatus !== "approved") {
          return erroERedirecionar(
            req,
            res,
            "pedidos",
            "A parte Pix do pagamento combinado ainda não foi confirmada.",
          );
        }
      }

      await confirmarPedidoComEstoque(pedido, {
        usuarioId: req.session.user.id,
      });
      await registrarAuditoria({
        estabelecimentoId: idEstabelecimento,
        entidade: "pedido",
        entidadeId: pedido._id,
        acao: "pagamento_manual_confirmado",
        usuarioId: req.session.user.id,
        usuarioTipo: req.session.user.tipo,
        dadosResumidos: {
          codigoPedido: String(pedido.codigoPublico || pedido._id).slice(pedido.codigoPublico ? 0 : -6).toUpperCase(),
          pagamentoStatus: "pago",
          formaPagamento: pedido.formaPagamento,
        },
        operationKey: `auditoria:pagamento_manual:${pedido._id}`,
      });

      return salvarERedirecionar(
        req,
        res,
        "pedidos",
        "Pagamento confirmado.",
      );
    } catch (error) {
      appLogger.error(
        "Erro ao confirmar pagamento:",
        error,
      );

      return erroERedirecionar(
        req,
        res,
        "pedidos",
        "Não foi possível confirmar o pagamento.",
      );
    }
  };

exports.arquivarPedido = async (req, res) => {
  try {
    const idEstabelecimento = estabelecimentoId(req);
    const usuario = req.usuarioAtual || req.session.user;
    const resultado = await arquivarPedido({
      pedidoId: req.params.id,
      estabelecimentoId: idEstabelecimento,
      usuario: {
        id: usuario.id || usuario._id,
        tipo: usuario.tipo === "funcionario"
          ? "funcionario"
          : "proprietario",
      },
      motivo: req.body?.motivo,
      agenteConectado: printAgentHub.isOnline(idEstabelecimento),
    });
    const pedido = resultado.pedido;
    if (pedido.mesaId) {
      const possuiOutroPedidoAberto = await Pedido.exists({
        estabelecimentoId: idEstabelecimento,
        mesaId: pedido.mesaId,
        excluido: { $ne: true },
        pagamentoStatus: "pendente",
        status: { $nin: ["finalizado", "cancelado"] },
      });

      if (!possuiOutroPedidoAberto) {
        await Mesa.updateOne(
          { _id: pedido.mesaId, estabelecimentoId: idEstabelecimento },
          { $set: { status: "livre" } },
        );
      }
    }

    return res.json({
      success: true,
      status: resultado.status,
      message: resultado.status === "ja_excluido"
        ? "Pedido já estava arquivado."
        : "Pedido arquivado. O histórico foi preservado.",
    });
  } catch (error) {
    appLogger.error("Erro ao arquivar pedido:", error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      code: error.code || "ARQUIVAMENTO_FALHOU",
      message: statusCode < 500
        ? error.message
        : "Não foi possível arquivar o pedido.",
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
        excluido: { $ne: true },

        updatedAt: {
          $gt: dataInicial,
        },
      })
        .populate(
          'mesaId',
          'numero setor'
        )
        .sort({
          updatedAt: 1,
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

          numero: numeroPedidoExibicao(pedido),
          codigoPublico: String(pedido.codigoPublico || "").toUpperCase(),

          cliente:
            pedido.cliente ||
            'Cliente não informado',

          telefone:
            pedido.telefoneCliente ||
            '',

          rua: pedido.ruaEntrega || '',
          numeroEndereco: pedido.numeroEntrega || '',
          bairro: pedido.bairroEntrega || '',
          referencia: pedido.referenciaEntrega || '',
          cidadeEntrega: pedido.cidadeEntregaNome || '',
          cidadeEntregaUf: pedido.cidadeEntregaUf || '',

          formaPagamento:
            pedido.formaPagamento ||
            'nao_informado',

          pagamentos:
            Array.isArray(pedido.pagamentos)
              ? pedido.pagamentos.map(item => ({
                  formaPagamento: String(item.formaPagamento || ''),
                  valorCentavos: Number(item.valorCentavos || 0),
                }))
              : [],

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

          mesaId:
            pedido.mesaId?._id
              ? String(pedido.mesaId._id)
              : (pedido.mesaId ? String(pedido.mesaId) : ''),

          mesaNumero:
            pedido.mesaId?.numero ?? null,

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

          subtotalProdutos:
            Number(
              pedido.subtotalProdutos
              || Math.max(0, Number(pedido.total || 0) - Number(pedido.taxaEntregaCentavos || 0) / 100)
            ),

          taxaEntregaCentavos:
            Number(pedido.taxaEntregaCentavos || 0),

          taxaEntrega:
            Number(pedido.taxaEntregaCentavos || 0) / 100,

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

          pagamentoPixOnlineGerenciado:
            String(pedido.formaPagamento || '') === 'pix_online'
            || (
              String(pedido.formaPagamento || '') === 'pix'
              && Boolean(String(pedido.mercadoPagoPaymentId || '').trim())
            ),

          pagamentoPixOnlineAprovado:
            pedido.pagamentoStatus === 'pago'
            && String(pedido.mercadoPagoStatus || '') === 'approved'
            && (
              Boolean(String(pedido.mercadoPagoPaymentId || '').trim())
              || String(pedido.formaPagamento || '') === 'pix_online'
            ),

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
    appLogger.error(
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
    const acessoVenda = await consultarAcessoVenda({
      estabelecimentoId: configuracao.estabelecimentoId,
      estabelecimento: configuracao,
    });

    const [produtos, avaliacoesAgregadas, cidadesEntrega] = await Promise.all([
      acessoVenda.permitido
        ? buscarProdutosPublicosDoEstabelecimento(
          configuracao.estabelecimentoId,
          { source: "catalogo_publico" },
        )
        : Promise.resolve([]),
      acessoVenda.permitido ? Avaliacao.aggregate([
        { $match: { estabelecimentoId: configuracao.estabelecimentoId } },
        { $group: { _id: "$produtoId", media: { $avg: "$nota" }, quantidade: { $sum: 1 } } },
      ]) : Promise.resolve([]),
      acessoVenda.permitido
        ? CidadeEntrega.find({
          estabelecimentoId: configuracao.estabelecimentoId,
          ativo: true,
        })
          .select("nome uf taxaCentavos pedidoMinimoCentavos abaixoMinimoModo taxaAbaixoMinimoCentavos")
          .sort({ nome: 1, uf: 1 })
          .lean()
        : Promise.resolve([]),
    ]);

    const avaliacoesPorProduto = Object.fromEntries(
      avaliacoesAgregadas.map(item => [String(item._id), {
        media: Number(item.media || 0).toFixed(1),
        quantidade: Number(item.quantidade || 0),
      }])
    );

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    return res.render("catalogo-publico", {
      configuracao,
      produtos,
      avaliacoesPorProduto,
      cidadesEntrega: cidadesEntrega.map(cidade => ({
        id: String(cidade._id),
        nome: cidade.nome,
        uf: cidade.uf,
        taxaCentavos: Number(cidade.taxaCentavos || 0),
        pedidoMinimoCentavos: Number(cidade.pedidoMinimoCentavos || 0),
        abaixoMinimoModo: cidade.abaixoMinimoModo === "taxa_especial"
          ? "taxa_especial"
          : "bloquear",
        taxaAbaixoMinimoCentavos: Number(cidade.taxaAbaixoMinimoCentavos || 0),
      })),
      lojaDisponivel: acessoVenda.permitido,
    });
  } catch (error) {
    appLogger.error("Erro ao abrir catálogo:", error);
    return res.status(500).render("404");
  }
};

exports.statusProdutosCatalogo = async (req, res) => {
  try {
    const configuracao = await Configuracao.findOne({
      slug: req.params.slug,
    }).select(
      "estabelecimentoId ativo bloqueado vendasBloqueadas",
    ).lean();

    if (!configuracao) {
      return res.status(404).json({
        success: false,
        message: "Estabelecimento não encontrado.",
      });
    }
    const acessoVenda = await consultarAcessoVenda({
      estabelecimentoId: configuracao.estabelecimentoId,
      estabelecimento: configuracao,
    });
    if (!acessoVenda.permitido) return respostaLojaIndisponivel(res);

    const produtos = await buscarProdutosPublicosDoEstabelecimento(
      configuracao.estabelecimentoId,
      { source: "catalogo_produtos_status" },
    );

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    return res.json({
      success: true,
      produtos: produtos.map(produto => ({
        id: String(produto._id),
        nome: produto.nome,
        preco: Number(produto.preco || 0),
        precosPizza: (produto.precosPizza || []).map(item => ({
          tamanhoId: String(item.tamanhoId || ""),
          tamanhoNome: String(item.tamanhoNome || ""),
          preco: Number(item.preco || 0),
        })),
        precosVariacoes: (produto.precosVariacoes || []).map(item => ({
          variacaoId: String(item.variacaoId || ""),
          variacaoNome: String(item.variacaoNome || ""),
          preco: Number(item.preco || 0),
        })),
        imagem: produto.imagem || "",
        categoria: produto.categoriaId
          ? {
              id: String(produto.categoriaId._id || produto.categoriaId),
              nome: String(produto.categoriaId.nome || ""),
              tipoProduto: String(produto.categoriaId.tipoProduto || "normal"),
              permiteMeioAMeio:
                produto.categoriaId.configuracaoPizza?.permiteMeioAMeio === true,
              regraPrecoMeioAMeio: String(
                produto.categoriaId.configuracaoPizza?.regraPrecoMeioAMeio
                || "maior_sabor_escolhido",
              ),
              categoriasMeioAMeio: (
                produto.categoriaId.configuracaoPizza?.categoriasMeioAMeio || []
              ).map(categoriaId => String(categoriaId?._id || categoriaId || "")),
              tamanhos: (produto.categoriaId.configuracaoPizza?.tamanhos || [])
                .filter(tamanho => tamanho?.ativo !== false)
                .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0))
                .map(tamanho => ({
                  id: String(tamanho._id || ""),
                  nome: String(tamanho.nome || ""),
                  maxSabores: Math.max(1, Math.min(3, Number(tamanho.maxSabores || 2))),
                })),
              variacoesHabilitadas:
                produto.categoriaId.configuracaoVariacoes?.habilitado === true,
              variacoes: (produto.categoriaId.configuracaoVariacoes?.opcoes || [])
                .filter(opcao => opcao?.ativo !== false)
                .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0))
                .map(opcao => ({
                  id: String(opcao._id || ""),
                  nome: String(opcao.nome || ""),
                })),
            }
          : null,
        adicionais: (produto.adicionais || [])
          .filter(adicional => adicional.ativo !== false)
          .map(adicional => ({
            id: String(adicional._id),
            nome: adicional.nome,
            preco: Number(adicional.preco || 0),
          })),
      })),
    });
  } catch (error) {
    appLogger.error("Erro ao sincronizar produtos do catálogo:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível atualizar o catálogo.",
    });
  }
};

/*
|--------------------------------------------------------------------------
| MESA PÚBLICA
|--------------------------------------------------------------------------
*/

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

    const configuracao = await Configuracao.findOne({
      estabelecimentoId: mesa.estabelecimentoId,
    }).lean();
    const acessoVenda = await consultarAcessoVenda({
      estabelecimentoId: mesa.estabelecimentoId,
      estabelecimento: configuracao || { ativo: false },
    });

    const [
      produtos,
      pedidosAbertos,
      avaliacoesAgregadas,
    ] = await Promise.all([
      acessoVenda.permitido
        ? buscarProdutosPublicosDoEstabelecimento(
          mesa.estabelecimentoId,
          { source: "mesa_publica" },
        )
        : Promise.resolve([]),

      Pedido.find({
        estabelecimentoId:
          mesa.estabelecimentoId,
        mesaId: mesa._id,
        excluido: { $ne: true },
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
          pizzaMeioAMeio: item.pizzaMeioAMeio === true,
          saboresPizza: Array.isArray(item.saboresPizza)
            ? item.saboresPizza
            : [],
          tamanhoPizzaNome: String(item.tamanhoPizzaNome || ""),
          variacaoNome: String(item.variacaoNome || ""),
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

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
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
        lojaDisponivel: acessoVenda.permitido,
      },
    );
  } catch (error) {
    appLogger.error(
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
    const validacaoPedido = validatePublicOrderBase(req.body, { mesa: true });
    if (!validacaoPedido.valid) {
      return res.status(400).json({
        success: false,
        code: validacaoPedido.code || "PEDIDO_INVALIDO",
        message: validacaoPedido.message,
      });
    }

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
    const configuracao = await Configuracao.findOne({
      estabelecimentoId: mesa.estabelecimentoId,
    }).lean();
    const acessoVenda = await consultarAcessoVenda({
      estabelecimentoId: mesa.estabelecimentoId,
      estabelecimento: configuracao || { ativo: false },
    });
    if (!acessoVenda.permitido) return respostaLojaIndisponivel(res);

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

    // Inclui também os sabores adicionais quando o item é uma pizza com múltiplos sabores.
    // O servidor nunca confia no preço enviado pelo navegador: os preços são
    // recalculados a partir dos produtos/categoria pertencentes à mesa.
    const idsProdutos = [
      ...new Set(
        itensRecebidos
          .flatMap(item => [
            String(item?.produtoId || "").trim(),
            ...normalizarIdsSabores(item),
          ])
          .filter(Boolean),
      ),
    ];
    const idsProdutosValidos = idsProdutos.filter(id =>
      mongoose.isValidObjectId(id),
    );

    const produtos = await Produto.find({
      _id: { $in: idsProdutosValidos },
      estabelecimentoId: mesa.estabelecimentoId,
      ativo: true,
    }).lean();

    const produtosMap = new Map(
      produtos.map(produto => [String(produto._id), produto]),
    );

    const idsCategoriasMesa = [
      ...new Set(
        produtos
          .map(produto => String(produto.categoriaId || ""))
          .filter(Boolean),
      ),
    ];

    const categoriasMesa = idsCategoriasMesa.length
      ? await Categoria.find({
          estabelecimentoId: mesa.estabelecimentoId,
          tipo: "catalogo",
        }).lean()
      : [];
    const categoriasMesaMap = new Map(
      categoriasMesa.map(categoria => [String(categoria._id), categoria]),
    );
    const idsCategoriasPrecoMesa = [
      ...new Set([
        ...idsCategoriasMesa,
        ...idsCategoriasMesa.flatMap(categoriaId => {
          const categoria = categoriasMesaMap.get(categoriaId);
          return (categoria?.configuracaoPizza?.categoriasMeioAMeio || [])
            .map(id => String(id?._id || id || ""))
            .filter(Boolean);
        }),
      ]),
    ];
    const produtosAtivosCategorias = idsCategoriasPrecoMesa.length
      ? await Produto.find({
          estabelecimentoId: mesa.estabelecimentoId,
          categoriaId: { $in: idsCategoriasPrecoMesa },
          ativo: true,
        })
          .select("_id nome preco precosPizza precosVariacoes custo categoriaId fichaTecnica adicionais imagem")
          .lean()
      : [];

    // Necessário para a regra "maior preço da categoria" da pizza com múltiplos sabores.
    const produtosPorCategoriaMesa = new Map();
    for (const produtoCategoria of produtosAtivosCategorias) {
      const categoriaId = String(produtoCategoria.categoriaId || "");
      if (!produtosPorCategoriaMesa.has(categoriaId)) {
        produtosPorCategoriaMesa.set(categoriaId, []);
      }
      produtosPorCategoriaMesa.get(categoriaId).push(produtoCategoria);
    }

    const itens = [];
    let total = 0;
    let custo = 0;

    for (const itemRecebido of itensRecebidos) {
      const pizzaMeioAMeioSolicitada = itemRecebido?.pizzaMeioAMeio === true
        || String(itemRecebido?.pizzaMeioAMeio || "").toLowerCase() === "true";

      let pizzaMeioAMeio = null;
      let produto = produtosMap.get(String(itemRecebido.produtoId || ""));

      if (pizzaMeioAMeioSolicitada) {
        try {
          pizzaMeioAMeio = montarPizzaMeioAMeio({
            itemRecebido,
            produtosMap,
            categoriasMap: categoriasMesaMap,
            produtosPorCategoria: produtosPorCategoriaMesa,
          });
          produto = pizzaMeioAMeio.produtoPrincipal;
        } catch (error) {
          if (error?.statusCode === 422) {
            return res.status(422).json({
              success: false,
              code: error.code || "PIZZA_MEIO_A_MEIO_INVALIDA",
              message: error.message,
            });
          }
          throw error;
        }
      }

      if (!produto) {
        return res.status(409).json({
          success: false,
          code: "PRODUTO_INDISPONIVEL",
          message: "Um produto não está mais disponível.",
        });
      }

      const quantidade = Number(itemRecebido.quantidade);
      const categoriaProduto = pizzaMeioAMeio?.categoria
        || categoriasMesaMap.get(String(produto.categoriaId || ""));

      let tamanhoPizzaSelecionado = pizzaMeioAMeio?.tamanhoPizza || null;
      let variacaoSelecionada = null;
      let precoBase = pizzaMeioAMeio
        ? pizzaMeioAMeio.precoBase
        : Number(produto.preco || 0);

      if (
        !pizzaMeioAMeio
        && String(categoriaProduto?.tipoProduto || "normal") === "pizza"
      ) {
        try {
          const selecaoPizza = resolverTamanhoEPrecoPizza({
            itemRecebido,
            produto,
            categoria: categoriaProduto,
          });
          precoBase = selecaoPizza.precoBase;
          tamanhoPizzaSelecionado = selecaoPizza.tamanho
            ? {
                tamanhoId: selecaoPizza.tamanho._id,
                nome: String(selecaoPizza.tamanho.nome || "").slice(0, 50),
              }
            : null;
        } catch (error) {
          if (error?.statusCode === 422) {
            return res.status(422).json({
              success: false,
              code: error.code || "PIZZA_TAMANHO_INVALIDO",
              message: error.message,
            });
          }
          throw error;
        }
      }

      if (!pizzaMeioAMeio && categoriaUsaVariacoes(categoriaProduto)) {
        try {
          const selecaoVariacao = resolverVariacaoEPrecoProduto({
            itemRecebido,
            produto,
            categoria: categoriaProduto,
          });
          precoBase = selecaoVariacao.precoBase;
          variacaoSelecionada = selecaoVariacao.variacao;
        } catch (error) {
          if (error?.statusCode === 422) {
            return res.status(422).json({
              success: false,
              code: error.code || "VARIACAO_PRODUTO_INVALIDA",
              message: error.message,
            });
          }
          throw error;
        }
      }

      // Detecta preço antigo/manipulado no F12, inclusive para pizzas.
      const precoRecebido = Number(itemRecebido.preco);
      if (
        Number.isFinite(precoRecebido)
        && Math.abs(precoRecebido - precoBase) > 0.001
      ) {
        return res.status(409).json({
          success: false,
          code: "PRECO_ATUALIZADO",
          message: String(categoriaProduto?.tipoProduto || "normal") === "pizza"
            ? "O preço da pizza foi atualizado. Confira o carrinho novamente."
            : "O preço do produto foi atualizado. Confira o carrinho novamente.",
        });
      }

      const adicionaisDisponiveis = new Map(
        (produto.adicionais || [])
          .filter(adicional => adicional.ativo !== false)
          .map(adicional => [String(adicional._id), adicional]),
      );

      const idsAdicionais = Array.isArray(itemRecebido.adicionais)
        ? itemRecebido.adicionais
        : [];

      const adicionaisEscolhidos = idsAdicionais
        .map(adicionalRecebido => {
          const id = String(
            adicionalRecebido?._id
              || adicionalRecebido?.id
              || adicionalRecebido
              || "",
          );
          const adicional = adicionaisDisponiveis.get(id);
          if (!adicional) return null;
          return {
            nome: adicional.nome,
            preco: Number(adicional.preco || 0),
          };
        })
        .filter(Boolean);

      const valorAdicionais = adicionaisEscolhidos.reduce(
        (soma, adicional) => soma + Number(adicional.preco || 0),
        0,
      );

      const preco = precoBase + valorAdicionais;
      const custoUnitario = pizzaMeioAMeio
        ? pizzaMeioAMeio.custoUnitarioSnapshot
        : Number(produto.custo || 0);
      const subtotal = preco * quantidade;
      const fichaTecnicaSnapshot = pizzaMeioAMeio
        ? pizzaMeioAMeio.fichaTecnicaSnapshot
        : (produto.fichaTecnica || []).map(item => ({
            estoqueId: item.estoqueId,
            nome: item.nome,
            quantidade: item.quantidade,
            unidade: item.unidade,
            custoCalculado: item.custoCalculado,
          }));

      const nomeItemBase = pizzaMeioAMeio ? pizzaMeioAMeio.nome : produto.nome;
      const complementoNome = !pizzaMeioAMeio
        ? (tamanhoPizzaSelecionado?.nome || variacaoSelecionada?.nome || "")
        : "";
      const nomeItem = complementoNome
        ? `${nomeItemBase} (${complementoNome})`.slice(0, 160)
        : String(nomeItemBase || "").slice(0, 160);

      itens.push({
        produtoId: produto._id,
        nome: nomeItem,
        quantidade,
        preco,
        subtotal,
        adicionais: adicionaisEscolhidos,
        observacao: publicText(
          itemRecebido.observacao,
          PUBLIC_ORDER_LIMITS.itemNote,
        ),
        pizzaMeioAMeio: Boolean(pizzaMeioAMeio),
        saboresPizza: pizzaMeioAMeio?.saboresPizza || [],
        regraPrecoPizza: pizzaMeioAMeio?.regraPrecoPizza || "",
        precoBasePizza: String(categoriaProduto?.tipoProduto || "normal") === "pizza"
          ? precoBase
          : null,
        tamanhoPizzaId: tamanhoPizzaSelecionado?.tamanhoId || null,
        tamanhoPizzaNome: tamanhoPizzaSelecionado?.nome || "",
        variacaoId: variacaoSelecionada?.variacaoId || null,
        variacaoNome: variacaoSelecionada?.nome || "",
        precoBaseVariacao: variacaoSelecionada ? precoBase : null,
        custoUnitarioSnapshot: custoUnitario,
        fichaTecnicaSnapshotCriado: true,
        fichaTecnicaSnapshot,
      });

      total += subtotal;
      custo += custoUnitario * quantidade;
    }

    if (!itens.length) {
      return res.status(400).json({
        success: false,
        message:
          "Nenhum produto válido foi encontrado.",
      });
    }

    const pedido =
      await printQueueService.criarPedidoComJobsAutomaticos({
        estabelecimentoId:
          mesa.estabelecimentoId,
        mesaId: mesa._id,
        cliente: publicText(
          req.body.cliente || `Mesa ${mesa.numero}`,
          PUBLIC_ORDER_LIMITS.client,
        ),
        canal: "mesa",
        idempotencyKey: validacaoPedido.idempotencyKey,
        itens,
        observacao: publicText(
          req.body.observacao,
          PUBLIC_ORDER_LIMITS.orderNote,
        ),
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
        pedido.idempotentReplay
          ? "Pedido já recebido anteriormente."
          : "Pedido enviado com sucesso.",
      idempotentReplay: Boolean(pedido.idempotentReplay),
      pedidoId: pedido._id,
      numeroPedido: numeroPedidoExibicao(pedido),
      codigoPublico: String(pedido.codigoPublico || "").toUpperCase(),
      acompanhamentoToken:
        pedido.acompanhamentoToken,
      acompanhamentoTokenExpiraEm:
        pedido.acompanhamentoTokenExpiraEm,
      total,
      itens: itens.map((item) => ({
        produtoId: item.produtoId,
        nome: item.nome,
      })),
    });
  } catch (error) {
    appLogger.error(
      "Erro ao criar pedido:",
      error,
    );

    if (error?.code === "IDEMPOTENCY_CONFLICT") {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: "Esta tentativa já foi usada com dados diferentes. Atualize a página e envie novamente.",
      });
    }

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
      excluido: { $ne: true },
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
    appLogger.error(
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

async function validarAcessoSse(
  req,
  res,
  permissaoNecessaria,
  { forcar = true } = {},
) {
  const usuario = await carregarIdentidadeAtual(req, { forcar });
  if (!usuario) {
    encerrarSessao(req, () => {
      if (!res.writableEnded) res.end();
    });
    return false;
  }
  if (
    usuario.tipo !== "proprietario"
    && !req.permissoesAtuais.includes(permissaoNecessaria)
  ) {
    if (!res.writableEnded) res.end();
    return false;
  }
  return true;
}

exports.streamNovosPedidos = (req, res) => {
  res.setHeader(
    "Content-Type",
    "text/event-stream"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.flushHeaders?.();

  let validando = false;
  let primeiraValidacao = true;
  let timer = null;
  const enviarEvento = async () => {
    if (res.writableEnded) return;
    if (validando) return;
    validando = true;
    try {
      const autorizado = await validarAcessoSse(
        req,
        res,
        "pedidos",
        { forcar: !primeiraValidacao },
      );
      primeiraValidacao = false;
      if (!autorizado) {
        if (timer) clearInterval(timer);
        return;
      }

      res.write(
        `event: novos-pedidos\n` +
        `data: ${JSON.stringify({
          timestamp: Date.now()
        })}\n\n`
      );
    } catch {
      if (!res.writableEnded) res.end();
    } finally {
      validando = false;
    }
  };

  enviarEvento();

  timer = setInterval(
    enviarEvento,
    5000
  );

  timer.unref?.();

  const unregisterSse = appState.registerSse(res, () => {
    if (timer) clearInterval(timer);
  }, { sessionId: req.sessionID });
  req.on("close", () => {
    unregisterSse();

    if (!res.writableEnded) {
      res.end();
    }
  });
};

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
      const validacaoPedido = validatePublicOrderBase(req.body);
      if (!validacaoPedido.valid) {
        return res.status(400).json({
          success: false,
          code: validacaoPedido.code || "PEDIDO_INVALIDO",
          message: validacaoPedido.message,
        });
      }

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
      const acessoVenda = await consultarAcessoVenda({
        estabelecimentoId: configuracao.estabelecimentoId,
        estabelecimento: configuracao,
      });
      if (!acessoVenda.permitido) return respostaLojaIndisponivel(res);

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

      const cliente = publicText(
        req.body.cliente,
        PUBLIC_ORDER_LIMITS.client,
      );

      const telefone = publicText(
        req.body.telefone,
        PUBLIC_ORDER_LIMITS.phone,
      );

      const canal = String(
        req.body.canal || "",
      ).trim();

      const ruaEntrega = publicText(req.body.ruaEntrega, PUBLIC_ORDER_LIMITS.street);
      const numeroEntrega = publicText(req.body.numeroEntrega, PUBLIC_ORDER_LIMITS.number);
      const bairroEntrega = publicText(req.body.bairroEntrega, PUBLIC_ORDER_LIMITS.neighborhood);
      const referenciaEntrega = publicText(
        req.body.referenciaEntrega,
        PUBLIC_ORDER_LIMITS.reference,
      );
      const enderecoEntrega = [ruaEntrega, numeroEntrega, bairroEntrega]
        .filter(Boolean)
        .join(", ");

      const observacao = publicText(
        req.body.observacao,
        PUBLIC_ORDER_LIMITS.orderNote,
      );


      // Aceita os nomes atuais e aliases enviados por versões anteriores do
      // catálogo. O valor financeiro só é validado depois que o servidor
      // recalcular produtos, adicionais e taxa de entrega.
      const mapaFormaPagamento = {
        combinado: "combinado",
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
      const normalizarFormaRecebida = value => {
        const original = String(value || "").trim().toLowerCase();
        return mapaFormaPagamento[original] || original;
      };
      const pagamentoRecebido = {
        ...req.body,
        formaPagamento: normalizarFormaRecebida(
          req.body.formaPagamento ||
          req.body.metodoPagamento ||
          req.body.pagamentoMetodo,
        ),
        formaPagamento1: normalizarFormaRecebida(req.body.formaPagamento1),
        formaPagamento2: normalizarFormaRecebida(req.body.formaPagamento2),
      };

      const precisaTrocoSolicitado =
        ["true", "1", "sim", "on"].includes(
          String(req.body.precisaTroco || "")
            .trim()
            .toLowerCase(),
        );

      const trocoTexto = String(req.body.trocoPara ?? "")
        .replace(/\s/g, "")
        .replace(/R\$/gi, "")
        .replace(/\./g, "")
        .replace(",", ".");
      const trocoParaRecebido = Number(trocoTexto);

      if (
        precisaTrocoSolicitado &&
        (!Number.isFinite(trocoParaRecebido) || trocoParaRecebido <= 0)
      ) {
        return res.status(400).json({
          success: false,
          message: "Informe para quanto o cliente precisa de troco.",
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

      const telefoneNormalizado = normalizarTelefonePublico(telefone);
      if (telefoneNormalizado.length < 10) {
        return res.status(400).json({
          success: false,
          message: "Informe um WhatsApp válido com DDD.",
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
        (!ruaEntrega || !numeroEntrega || !bairroEntrega)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Informe rua, número e bairro para a entrega.",
        });
      }

      const cidadeEntregaId = String(
        req.body.cidadeEntregaId || "",
      ).trim();
      let cidadeEntregaSelecionada = null;

      if (canal === "delivery" && !mongoose.isValidObjectId(cidadeEntregaId)) {
        return res.status(400).json({
          success: false,
          code: "CIDADE_ENTREGA_OBRIGATORIA",
          message: "Selecione uma cidade atendida pelo estabelecimento.",
        });
      }

      if (canal === "delivery") {
        cidadeEntregaSelecionada = await CidadeEntrega.findOne({
          _id: cidadeEntregaId,
          estabelecimentoId: configuracao.estabelecimentoId,
          ativo: true,
        })
          .select("_id nome uf taxaCentavos pedidoMinimoCentavos abaixoMinimoModo taxaAbaixoMinimoCentavos")
          .lean();

        if (!cidadeEntregaSelecionada) {
          return res.status(409).json({
            success: false,
            code: "CIDADE_ENTREGA_INDISPONIVEL",
            message: "A cidade selecionada não está disponível para entrega.",
          });
        }

        try {
          validarTaxaEntregaCentavos(cidadeEntregaSelecionada.taxaCentavos);
        } catch (error) {
          appLogger.error("delivery_city_fee_invalid", {
            correlationId: req.correlationId,
            estabelecimentoId: String(configuracao.estabelecimentoId),
            cidadeEntregaId,
            code: error?.code || "TAXA_ENTREGA_CONFIGURACAO_INVALIDA",
          });
          return res.status(409).json({
            success: false,
            code: "TAXA_ENTREGA_INDISPONIVEL",
            message: "A taxa da cidade selecionada está indisponível. Escolha outra cidade ou fale com a loja.",
          });
        }
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

      const idsProdutos = [
        ...new Set(
          itensRecebidos
            .flatMap(item => [
              String(item?.produtoId || "").trim(),
              ...normalizarIdsSabores(item),
            ])
            .filter(Boolean),
        ),
      ];
      const idsProdutosValidos =
        idsProdutos.filter(id => mongoose.isValidObjectId(id));

      const produtos =
        await Produto.find({
          _id: {
            $in: idsProdutosValidos,
          },

          estabelecimentoId:
            configuracao.estabelecimentoId,

          ativo: true,
        }).lean();

      const idsCategoriasProdutos = [
        ...new Set(
          produtos
            .map(produto => String(produto.categoriaId || ""))
            .filter(Boolean),
        ),
      ];
      const categoriasProdutos = idsCategoriasProdutos.length
        ? await Categoria.find({
            estabelecimentoId: configuracao.estabelecimentoId,
            tipo: "catalogo",
          }).lean()
        : [];
      const categoriasMap = new Map(
        categoriasProdutos.map(categoria => [String(categoria._id), categoria]),
      );
      const idsCategoriasPreco = [
        ...new Set([
          ...idsCategoriasProdutos,
          ...idsCategoriasProdutos.flatMap(categoriaId => {
            const categoria = categoriasMap.get(categoriaId);
            return (categoria?.configuracaoPizza?.categoriasMeioAMeio || [])
              .map(id => String(id?._id || id || ""))
              .filter(Boolean);
          }),
        ]),
      ];
      const produtosAtivosCategorias = idsCategoriasPreco.length
        ? await Produto.find({
            estabelecimentoId: configuracao.estabelecimentoId,
            categoriaId: { $in: idsCategoriasPreco },
            ativo: true,
          })
            .select("_id nome preco precosPizza precosVariacoes custo categoriaId fichaTecnica adicionais imagem")
            .lean()
        : [];
      const produtosPorCategoria = new Map();
      for (const produto of produtosAtivosCategorias) {
        const categoriaId = String(produto.categoriaId || "");
        if (!produtosPorCategoria.has(categoriaId)) {
          produtosPorCategoria.set(categoriaId, []);
        }
        produtosPorCategoria.get(categoriaId).push(produto);
      }

      const idsIngredientes = [
        ...new Set(
          produtos.flatMap(produto =>
            (produto.fichaTecnica || [])
              .map(item => String(item.estoqueId?._id || item.estoqueId || ""))
              .filter(Boolean),
          ),
        ),
      ];
      const ingredientesAtivos = idsIngredientes.length
        ? await Estoque.find({
            _id: { $in: idsIngredientes },
            estabelecimentoId: configuracao.estabelecimentoId,
            ativo: { $ne: false },
          }).select("_id").lean()
        : [];
      const idsIngredientesAtivos = new Set(
        ingredientesAtivos.map(item => String(item._id)),
      );
      const produtosComIngredienteIndisponivel = new Set(
        produtos
          .filter(produto =>
            (produto.fichaTecnica || []).some(item =>
              !idsIngredientesAtivos.has(
                String(item.estoqueId?._id || item.estoqueId || ""),
              ),
            ),
          )
          .map(produto => String(produto._id)),
      );
      const produtosMap =
        new Map(
          produtos
            .filter(produto =>
              !produtosComIngredienteIndisponivel.has(String(produto._id)),
            )
            .map(
            (produto) => [
              String(produto._id),
              produto,
            ],
            ),
        );

      const produtosInvalidos = idsProdutos.filter(
        id => !produtosMap.has(id),
      );
      if (produtosInvalidos.length) {
        return res.status(409).json({
          success: false,
          code: "PRODUTO_INDISPONIVEL",
          message: "Um ou mais produtos não estão mais disponíveis.",
          produtosInvalidos,
        });
      }

      const produtosComPrecoAlterado = itensRecebidos
        .filter(item => {
          if (item?.pizzaMeioAMeio === true
            || String(item?.pizzaMeioAMeio || "").toLowerCase() === "true") {
            return false;
          }
          const produto = produtosMap.get(String(item?.produtoId || ""));
          const categoria = produto
            ? categoriasMap.get(String(produto.categoriaId || ""))
            : null;
          // Pizza e produtos com variações são validados dentro do loop,
          // pois o preço depende da opção escolhida pelo cliente.
          if (String(categoria?.tipoProduto || "normal") === "pizza") return false;
          if (categoriaUsaVariacoes(categoria)) return false;
          const precoRecebido = Number(item?.preco);
          return produto
            && Number.isFinite(precoRecebido)
            && Math.abs(precoRecebido - Number(produto.preco || 0)) > 0.001;
        })
        .map(item => {
          const produto = produtosMap.get(String(item.produtoId));
          return {
            id: String(produto._id),
            nome: produto.nome,
            preco: Number(produto.preco || 0),
            imagem: produto.imagem || "",
          };
        });
      if (produtosComPrecoAlterado.length) {
        return res.status(409).json({
          success: false,
          code: "PRECO_ATUALIZADO",
          message: "O preço de um produto foi atualizado.",
          produtosAtualizados: produtosComPrecoAlterado,
        });
      }

      const itens = [];
      let total = 0;
      let custo = 0;

      for (
        const itemRecebido of
        itensRecebidos
      ) {
        const pizzaMeioAMeioSolicitada = itemRecebido?.pizzaMeioAMeio === true
          || String(itemRecebido?.pizzaMeioAMeio || "").toLowerCase() === "true";
        let pizzaMeioAMeio = null;
        let produto = produtosMap.get(String(itemRecebido.produtoId || ""));

        if (pizzaMeioAMeioSolicitada) {
          try {
            pizzaMeioAMeio = montarPizzaMeioAMeio({
              itemRecebido,
              produtosMap,
              categoriasMap,
              produtosPorCategoria,
            });
            produto = pizzaMeioAMeio.produtoPrincipal;
          } catch (error) {
            if (error?.statusCode === 422) {
              return res.status(422).json({
                success: false,
                code: error.code || "PIZZA_MEIO_A_MEIO_INVALIDA",
                message: error.message,
              });
            }
            throw error;
          }
        }

        if (!produto) {
          return res.status(409).json({
            success: false,
            code: "PRODUTO_INDISPONIVEL",
            message: "Um produto não está mais disponível.",
          });
        }

        const quantidade = Number(itemRecebido.quantidade);
        if (
          !Number.isInteger(quantidade)
          || quantidade < 1
          || quantidade > 99
        ) {
          return res.status(400).json({
            success: false,
            message: "Quantidade de produto inválida.",
          });
        }

        const categoriaProduto = pizzaMeioAMeio?.categoria
          || categoriasMap.get(String(produto.categoriaId || ""));
        let tamanhoPizzaSelecionado = pizzaMeioAMeio?.tamanhoPizza || null;
        let variacaoSelecionada = null;
        let precoBase = pizzaMeioAMeio
          ? pizzaMeioAMeio.precoBase
          : Number(produto.preco || 0);

        if (!pizzaMeioAMeio && String(categoriaProduto?.tipoProduto || "normal") === "pizza") {
          try {
            const selecaoPizza = resolverTamanhoEPrecoPizza({
              itemRecebido,
              produto,
              categoria: categoriaProduto,
            });
            precoBase = selecaoPizza.precoBase;
            tamanhoPizzaSelecionado = selecaoPizza.tamanho
              ? {
                  tamanhoId: selecaoPizza.tamanho._id,
                  nome: String(selecaoPizza.tamanho.nome || "").slice(0, 50),
                }
              : null;
          } catch (error) {
            if (error?.statusCode === 422) {
              return res.status(422).json({
                success: false,
                code: error.code || "PIZZA_TAMANHO_INVALIDO",
                message: error.message,
              });
            }
            throw error;
          }
        }

        if (!pizzaMeioAMeio && categoriaUsaVariacoes(categoriaProduto)) {
          try {
            const selecaoVariacao = resolverVariacaoEPrecoProduto({
              itemRecebido,
              produto,
              categoria: categoriaProduto,
            });
            precoBase = selecaoVariacao.precoBase;
            variacaoSelecionada = selecaoVariacao.variacao;
          } catch (error) {
            if (error?.statusCode === 422) {
              return res.status(422).json({
                success: false,
                code: error.code || "VARIACAO_PRODUTO_INVALIDA",
                message: error.message,
              });
            }
            throw error;
          }
        }

        const precoRecebido = Number(itemRecebido.preco);
        if (
          Number.isFinite(precoRecebido)
          && Math.abs(precoRecebido - precoBase) > 0.001
        ) {
          return res.status(409).json({
            success: false,
            code: "PRECO_ATUALIZADO",
            message: String(categoriaProduto?.tipoProduto || "normal") === "pizza"
              ? "O preço da pizza foi atualizado. Confira o carrinho novamente."
              : "O preço do produto foi atualizado. Confira o carrinho novamente.",
            produtosAtualizados: pizzaMeioAMeio
              ? pizzaMeioAMeio.sabores.map(sabor => ({
                  id: String(sabor._id),
                  nome: sabor.nome,
                  preco: Number(sabor.preco || 0),
                  imagem: sabor.imagem || "",
                }))
              : [{
                  id: String(produto._id),
                  nome: produto.nome,
                  preco: Number(precoBase || 0),
                  imagem: produto.imagem || "",
                }],
          });
        }

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
            return res.status(409).json({
              success: false,
              code: "ADICIONAL_INDISPONIVEL",
              message: "Um adicional selecionado não está mais disponível.",
              produtoId: String(produto._id),
            });
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
        const custoUnitario = pizzaMeioAMeio
          ? pizzaMeioAMeio.custoUnitarioSnapshot
          : Number(produto.custo || 0);
        const subtotal = preco * quantidade;
        const fichaTecnicaSnapshot = pizzaMeioAMeio
          ? pizzaMeioAMeio.fichaTecnicaSnapshot
          : (produto.fichaTecnica || []).map(item => ({
              estoqueId: item.estoqueId,
              nome: item.nome,
              quantidade: item.quantidade,
              unidade: item.unidade,
              custoCalculado: item.custoCalculado,
            }));

        const nomeItemBase = pizzaMeioAMeio ? pizzaMeioAMeio.nome : produto.nome;
        const complementoNome = !pizzaMeioAMeio
          ? (tamanhoPizzaSelecionado?.nome || variacaoSelecionada?.nome || "")
          : "";
        const nomeItem = complementoNome
          ? `${nomeItemBase} (${complementoNome})`.slice(0, 160)
          : nomeItemBase;

        itens.push({
          produtoId: produto._id,
          nome: nomeItem,
          quantidade,
          preco,
          subtotal,
          adicionais,
          observacao: publicText(
            itemRecebido.observacao,
            PUBLIC_ORDER_LIMITS.itemNote,
          ),
          pizzaMeioAMeio: Boolean(pizzaMeioAMeio),
          saboresPizza: pizzaMeioAMeio?.saboresPizza || [],
          regraPrecoPizza: pizzaMeioAMeio?.regraPrecoPizza || "",
          precoBasePizza: String(categoriaProduto?.tipoProduto || "normal") === "pizza"
            ? precoBase
            : null,
          tamanhoPizzaId: tamanhoPizzaSelecionado?.tamanhoId || null,
          tamanhoPizzaNome: tamanhoPizzaSelecionado?.nome || "",
          variacaoId: variacaoSelecionada?.variacaoId || null,
          variacaoNome: variacaoSelecionada?.nome || "",
          precoBaseVariacao: variacaoSelecionada ? precoBase : null,
          custoUnitarioSnapshot: custoUnitario,
          fichaTecnicaSnapshotCriado: true,
          fichaTecnicaSnapshot,
        });

        total += subtotal;
        custo += custoUnitario * quantidade;
      }

      if (!itens.length) {
        return res.status(400).json({
          success: false,
          message:
            "Nenhum produto válido foi encontrado.",
        });
      }

      let regraEntregaCidade = null;
      if (canal === "delivery") {
        try {
          regraEntregaCidade = avaliarRegraEntregaCidade({
            subtotalProdutos: total,
            cidade: cidadeEntregaSelecionada,
          });
        } catch (error) {
          appLogger.error("delivery_city_minimum_rule_invalid", {
            correlationId: req.correlationId,
            estabelecimentoId: String(configuracao.estabelecimentoId),
            cidadeEntregaId,
            code: error?.code || "REGRA_PEDIDO_MINIMO_INVALIDA",
          });
          return res.status(409).json({
            success: false,
            code: "REGRA_ENTREGA_INDISPONIVEL",
            message: "A regra de entrega desta cidade está indisponível. Escolha outra cidade ou fale com a loja.",
          });
        }

        if (!regraEntregaCidade.permitido) {
          const minimo = (regraEntregaCidade.pedidoMinimoCentavos / 100)
            .toFixed(2)
            .replace(".", ",");
          const faltam = (regraEntregaCidade.faltamCentavos / 100)
            .toFixed(2)
            .replace(".", ",");
          return res.status(422).json({
            success: false,
            code: "PEDIDO_MINIMO_DELIVERY",
            pedidoMinimoCentavos: regraEntregaCidade.pedidoMinimoCentavos,
            faltamCentavos: regraEntregaCidade.faltamCentavos,
            message: `Para ${cidadeEntregaSelecionada.nome} - ${cidadeEntregaSelecionada.uf}, o delivery é feito somente a partir de R$ ${minimo}. Adicione mais R$ ${faltam} ao pedido para continuar.`,
          });
        }
      }

      const resumoFinanceiro = calcularTotaisPedidoComEntrega({
        subtotalProdutos: total,
        taxaEntregaCentavos: canal === "delivery"
          ? regraEntregaCidade.taxaEntregaCentavos
          : 0,
      });
      const subtotalProdutos = resumoFinanceiro.subtotalProdutos;
      const taxaEntregaCentavos = resumoFinanceiro.taxaEntregaCentavos;
      total = resumoFinanceiro.total;

      let planoPagamento;
      try {
        planoPagamento = montarPlanoPagamentoCatalogo(
          pagamentoRecebido,
          totalParaCentavos(total),
          {
            pixDisponivel: Boolean(
              configuracao.mercadoPago && configuracao.mercadoPago.conectado,
            ),
          },
        );
      } catch (error) {
        if (error?.code === "PUBLIC_PAYMENT_VALIDATION") {
          return res.status(422).json({
            success: false,
            code: error.code,
            message: error.message,
          });
        }
        throw error;
      }

      const formaPagamento = planoPagamento.formaPagamento;
      const pagamentos = planoPagamento.pagamentos;
      const valorDinheiroCentavos = valorFormaPagamentoCentavos(
        { total, formaPagamento, pagamentos },
        ["dinheiro"],
      );
      const precisaTroco = precisaTrocoSolicitado && valorDinheiroCentavos > 0;

      if (precisaTrocoSolicitado && valorDinheiroCentavos <= 0) {
        return res.status(422).json({
          success: false,
          code: "PUBLIC_PAYMENT_VALIDATION",
          message: "O troco só pode ser solicitado quando parte do pedido for paga em dinheiro.",
        });
      }

      const valorDinheiro = valorDinheiroCentavos / 100;
      if (precisaTroco && trocoParaRecebido < valorDinheiro) {
        return res.status(400).json({
          success: false,
          message:
            `O valor para troco deve ser igual ou maior que a parte em dinheiro de R$ ${valorDinheiro
              .toFixed(2)
              .replace(".", ",")}.`,
        });
      }

      const pedido =
        await printQueueService.criarPedidoComJobsAutomaticos({
          estabelecimentoId:
            configuracao.estabelecimentoId,

          cliente,
          emailCliente: "",
          telefoneCliente: telefone,
          telefoneNormalizado,

          canal,
          idempotencyKey: validacaoPedido.idempotencyKey,

          enderecoEntrega: canal === "delivery" ? enderecoEntrega : "",
          ruaEntrega: canal === "delivery" ? ruaEntrega : "",
          numeroEntrega: canal === "delivery" ? numeroEntrega : "",
          bairroEntrega: canal === "delivery" ? bairroEntrega : "",
          referenciaEntrega: canal === "delivery" ? referenciaEntrega : "",
          cidadeEntregaId: canal === "delivery"
            ? cidadeEntregaSelecionada._id
            : null,
          cidadeEntregaNome: canal === "delivery"
            ? cidadeEntregaSelecionada.nome
            : "",
          cidadeEntregaUf: canal === "delivery"
            ? cidadeEntregaSelecionada.uf
            : "",

          itens,
          observacao,
          subtotalProdutos,
          taxaEntregaCentavos,
          total,
          custo,

          status: "novo",

          pagamentoStatus:
            "pendente",

          formaPagamento,
          pagamentos,

          pagamentoInformadoEm:
            pagamentos.some(item => item.formaPagamento === "pix_online")
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
                  trocoParaRecebido - valorDinheiro,
                )
              : null,
        });

      const emailAviso = "";

      return res.status(201).json({
        success: true,

        message:
          pedido.idempotentReplay
            ? "Pedido já recebido anteriormente."
            : "Pedido enviado com sucesso.",
        idempotentReplay: Boolean(pedido.idempotentReplay),

        numeroPedido: numeroPedidoExibicao(pedido),
        codigoPublico: pedido.codigoPublico,
        emailAviso,
        acompanhamentoToken:
          pedido.acompanhamentoToken,
        acompanhamentoTokenExpiraEm:
          pedido.acompanhamentoTokenExpiraEm,

        canal,
        subtotalProdutos: Number(pedido.subtotalProdutos ?? subtotalProdutos),
        taxaEntregaCentavos: Number(pedido.taxaEntregaCentavos ?? taxaEntregaCentavos),
        total: Number(pedido.total ?? total),
        formaPagamento: pedido.formaPagamento || formaPagamento,
        pagamentos: Array.isArray(pedido.pagamentos)
          ? pedido.pagamentos.map(item => ({
              formaPagamento: String(item.formaPagamento || ""),
              valorCentavos: Number(item.valorCentavos || 0),
            }))
          : pagamentos,
      });
    } catch (error) {
      appLogger.error(
        "Erro ao criar pedido do catálogo:",
        error,
      );

      if (error?.code === "IDEMPOTENCY_CONFLICT") {
        return res.status(409).json({
          success: false,
          code: error.code,
          message: "Esta tentativa já foi usada com dados diferentes. Atualize a página e envie novamente.",
        });
      }

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

function hashAuditoriaAvaliacao(value = "") {
  const salt = String(process.env.AVALIACAO_AUDIT_SALT || process.env.SESSION_SECRET || "comanda-facil");
  return crypto.createHash("sha256").update(`${salt}:${String(value || "")}`).digest("hex");
}

function autorizacaoAvaliacaoSessao(req, pedido) {
  const agora = Date.now();
  const atual = req.session?.avaliacaoPedidos || {};
  const limpo = Object.fromEntries(
    Object.entries(atual).filter(([, item]) => Number(item?.expiraEm || 0) > agora)
  );
  limpo[String(pedido.codigoPublico || "")] = {
    pedidoId: String(pedido._id),
    estabelecimentoId: String(pedido.estabelecimentoId),
    expiraEm: agora + 30 * 60 * 1000,
  };
  req.session.avaliacaoPedidos = limpo;
}

function mascararEnderecoPublico(value = "") {
  const texto = String(value || "").trim();
  if (!texto) return "";
  const [logradouro = "", numero = ""] = texto.split(",");
  const palavras = logradouro.split(/\s+/).filter(Boolean).map((palavra, indice) =>
    indice === 0 || palavra.length < 3
      ? palavra
      : `${palavra[0]}${"*".repeat(Math.min(4, palavra.length - 1))}`);
  return `${palavras.join(" ")}${numero ? ", nº ***" : ""}`.slice(0, 180);
}

function serializarConsultaPublica(pedido, avaliados = new Set()) {
  const statusNormalizado = String(pedido.status || "");
  const podeAvaliar = pedido.pagamentoStatus === "pago"
    && ["entregue", "finalizado"].includes(statusNormalizado);
  return {
    numeroPedido: numeroPedidoExibicao(pedido),
    codigoPublico: String(pedido.codigoPublico || ""),
    podeAvaliar,
    data: pedido.createdAt,
    status: pedido.status,
    pagamentoStatus: pedido.pagamentoStatus,
    formaEntrega: pedido.canal,
    itens: (pedido.itens || []).slice(0, 100).map(item => ({
      produtoId: item.produtoId ? String(item.produtoId) : "",
      nome: String(item.nome || "Item").slice(0, 160),
      quantidade: Math.max(1, Number(item.quantidade) || 1),
      avaliado: item.produtoId ? avaliados.has(String(item.produtoId)) : false,
    })),
    subtotalProdutos: Number(
      pedido.subtotalProdutos
      || Math.max(0, Number(pedido.total || 0) - Number(pedido.taxaEntregaCentavos || 0) / 100),
    ),
    taxaEntregaCentavos: Number(pedido.taxaEntregaCentavos || 0),
    total: Number(pedido.total || 0),
    previsao: pedido.previsaoEntrega || null,
    enderecoResumido: pedido.canal === "delivery"
      ? mascararEnderecoPublico(pedido.enderecoEntrega)
      : "",
  };
}

exports.consultarPedidoPublico = async (req, res) => {
  const startedAt = Date.now();
  const generic = () => res.status(404).json({
    ok: false,
    code: "ORDER_LOOKUP_NOT_FOUND",
    message: "Não foi possível localizar o pedido com os dados informados.",
  });
  try {
    const telefone = normalizarTelefonePublico(req.body?.telefone);
    const codigoRecebido = normalizarCodigoPublico(
      req.body?.codigoCompleto || req.body?.codigoFinal,
    );
    const completo = Boolean(req.body?.codigoCompleto);
    if (telefone.length < 10
      || (completo ? !codigoPublicoValido(codigoRecebido) : !codigoFinalValido(codigoRecebido))) {
      return res.status(400).json({
        ok: false,
        code: "ORDER_LOOKUP_INVALID_INPUT",
        message: "Informe um telefone válido e quatro caracteres do pedido.",
      });
    }
    const configuracao = await Configuracao.findOne({ slug: req.params.slug })
      .select("estabelecimentoId timezone").lean();
    if (!configuracao) return generic();
    const filtro = {
      estabelecimentoId: configuracao.estabelecimentoId,
      telefoneNormalizado: telefone,
      excluido: { $ne: true },
      createdAt: { $gte: new Date(Date.now() - 90 * 86400000) },
      ...(completo
        ? { codigoPublico: codigoRecebido }
        : { codigoPublicoFinal: codigoRecebido }),
    };
    const pedidos = await Pedido.find(filtro)
      .select("numeroPedido codigoPublico createdAt status pagamentoStatus canal itens.produtoId itens.nome itens.quantidade subtotalProdutos taxaEntregaCentavos total previsaoEntrega enderecoEntrega estabelecimentoId")
      .sort({ createdAt: -1 }).limit(2).lean();
    if (!pedidos.length) return generic();
    if (!completo && pedidos.length > 1) {
      return res.status(409).json({
        ok: false,
        code: "ORDER_LOOKUP_FULL_CODE_REQUIRED",
        message: "Encontramos mais de um pedido. Informe o número completo do pedido.",
      });
    }
    const pedidoEncontrado = pedidos[0];
    const avaliacoes = await Avaliacao.find({
      estabelecimentoId: configuracao.estabelecimentoId,
      pedidoId: pedidoEncontrado._id,
    }).select("produtoId").lean();
    const avaliados = new Set(avaliacoes.map(item => String(item.produtoId)));
    autorizacaoAvaliacaoSessao(req, pedidoEncontrado);
    await new Promise(resolve => req.session.save(() => resolve()));
    return res.json({
      ok: true,
      pedido: serializarConsultaPublica(pedidoEncontrado, avaliados),
    });
  } catch (error) {
    appLogger.warn("order_public_lookup_failed", {
      correlationId: req.correlationId,
      stage: "lookup",
    });
    return res.status(500).json({
      ok: false,
      code: "ORDER_LOOKUP_FAILED",
      message: "Não foi possível consultar o pedido agora.",
    });
  } finally {
    const remaining = 180 - (Date.now() - startedAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  }
};

const ORDER_LOOKUP_GENERIC = {
  ok: true,
  code: "ORDER_LOOKUP_VERIFICATION_SENT",
  message: "Se os dados estiverem corretos, você receberá um código de verificação.",
};
const lookupHash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
function normalizeLookupIdentifier(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { type: "email", value: raw };
  const phone = normalizarTelefonePublico(raw);
  return phone.length >= 10 ? { type: "phone", value: phone } : null;
}
const lookupSessionHash = req => lookupHash(req.sessionID || "missing-session");
const codeDigest = (code, salt) => crypto.scryptSync(String(code), salt, 32).toString("hex");

exports.iniciarConsultaPedidos = async (req, res) => {
  const started = Date.now();
  try {
    const cfg = await Configuracao.findOne({ slug: req.params.slug }).select("estabelecimentoId").lean();
    const identifier = normalizeLookupIdentifier(req.body?.identificador);
    if (cfg && identifier) {
      const match = identifier.type === "email"
        ? { emailCliente: identifier.value }
        : { telefoneNormalizado: identifier.value };
      const order = await Pedido.findOne({
        estabelecimentoId: cfg.estabelecimentoId,
        ...match,
        excluido: { $ne: true },
        createdAt: { $gte: new Date(Date.now() - 90 * 86400000) },
      }).select("emailCliente").sort({ createdAt: -1 }).lean();
      const destination = String(order?.emailCliente || "").trim().toLowerCase();
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const salt = crypto.randomBytes(16).toString("hex");
      await OrderLookupVerification.create({
        estabelecimentoId: cfg.estabelecimentoId,
        identifierHash: lookupHash(`${identifier.type}:${identifier.value}`),
        sessionHash: lookupSessionHash(req),
        codeHash: codeDigest(code, salt),
        salt,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
        await enviarCodigoConsultaPedidos({ email: destination, codigo: code }).catch(() => {});
      }
    }
  } catch (error) {
    appLogger.warn("order_lookup_start_failed", { correlationId: req.correlationId, stage: "verification_start" });
  }
  const remaining = 250 - (Date.now() - started);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  return res.json(ORDER_LOOKUP_GENERIC);
};

exports.verificarConsultaPedidos = async (req, res) => {
  const cfg = await Configuracao.findOne({ slug: req.params.slug }).select("estabelecimentoId").lean();
  const identifier = normalizeLookupIdentifier(req.body?.identificador);
  const code = String(req.body?.codigo || "").trim();
  if (!cfg || !identifier || !/^\d{6}$/.test(code)) {
    return res.status(401).json({ ok: false, code: "ORDER_LOOKUP_CODE_INVALID", message: "Código inválido ou expirado." });
  }
  const verification = await OrderLookupVerification.findOne({
    estabelecimentoId: cfg.estabelecimentoId,
    identifierHash: lookupHash(`${identifier.type}:${identifier.value}`),
    sessionHash: lookupSessionHash(req),
    expiresAt: { $gt: new Date() },
    usedAt: null,
    attempts: { $lt: 5 },
  }).select("+codeHash +salt").sort({ createdAt: -1 });
  const received = verification ? codeDigest(code, verification.salt) : "";
  const valid = verification && crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(verification.codeHash, "hex"));
  if (!valid) {
    if (verification) await OrderLookupVerification.updateOne({ _id: verification._id }, { $inc: { attempts: 1 } });
    return res.status(401).json({ ok: false, code: "ORDER_LOOKUP_CODE_INVALID", message: "Código inválido ou expirado." });
  }
  verification.usedAt = new Date();
  await verification.save();
  req.session.orderLookup = {
    estabelecimentoId: String(cfg.estabelecimentoId),
    identifierType: identifier.type,
    identifierValue: identifier.value,
    expiresAt: Date.now() + 20 * 60_000,
  };
  await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  return res.json({ ok: true, code: "ORDER_LOOKUP_VERIFIED" });
};

exports.listarConsultaPedidos = async (req, res) => {
  const cfg = await Configuracao.findOne({ slug: req.params.slug }).select("estabelecimentoId timezone").lean();
  const lookup = req.session?.orderLookup;
  if (!cfg || !lookup || lookup.expiresAt <= Date.now()
    || String(cfg.estabelecimentoId) !== String(lookup.estabelecimentoId)) {
    return res.status(401).json({ ok: false, code: "ORDER_LOOKUP_SESSION_REQUIRED" });
  }
  const match = lookup.identifierType === "email"
    ? { emailCliente: lookup.identifierValue }
    : { telefoneNormalizado: lookup.identifierValue };
  const orders = await Pedido.find({
    estabelecimentoId: cfg.estabelecimentoId,
    ...match,
    excluido: { $ne: true },
    createdAt: { $gte: new Date(Date.now() - 90 * 86400000) },
  }).select("_id numeroPedido codigoPublico createdAt status pagamentoStatus canal itens.produtoId itens.nome itens.quantidade subtotalProdutos taxaEntregaCentavos total previsaoEntrega formaPagamento pagoEm")
    .sort({ createdAt: -1 }).limit(50).lean();
  return res.json({ ok: true, pedidos: orders.map(serializarPedidoPublico) });
};

exports.encerrarConsultaPedidos = async (req, res) => {
  delete req.session.orderLookup;
  await new Promise(resolve => req.session.save(() => resolve()));
  return res.json({ ok: true, code: "ORDER_LOOKUP_SIGNED_OUT" });
};

exports.acompanharPedidoCatalogo = async (req, res) => {
  try {
    const token = extrairBearerToken(req);
    const codigoSessao = String(req.body?.codigoPublico || "").trim().toUpperCase();
    const configuracao = await Configuracao.findOne({
      slug: req.params.slug,
    }).select("estabelecimentoId").lean();
    if (!configuracao) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado.",
      });
    }
    const pedido = await buscarPedidoPorToken({
      estabelecimentoId: configuracao.estabelecimentoId,
      token,
    });
    if (!pedido) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado.",
      });
    }
    return res.json({
      success: true,
      pedido: serializarPedidoPublico(pedido),
    });
  } catch (error) {
    appLogger.error("Erro ao acompanhar pedido público:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível acompanhar o pedido.",
    });
  }
};

exports.avaliarProdutoCatalogo = async (req, res) => {
  try {
    const token = extrairBearerToken(req);
    const codigoSessao = String(req.body?.codigoPublico || "").trim().toUpperCase();
    const configuracao = await Configuracao.findOne({
      slug: req.params.slug,
    }).select("estabelecimentoId").lean();
    if (!configuracao) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado.",
      });
    }
    let pedido = null;
    if (token) {
      pedido = await buscarPedidoPorToken({
        estabelecimentoId: configuracao.estabelecimentoId,
        token,
        lean: false,
      });
    } else {
      const permissao = req.session?.avaliacaoPedidos?.[codigoSessao];
      if (permissao
        && Number(permissao.expiraEm || 0) > Date.now()
        && String(permissao.estabelecimentoId) === String(configuracao.estabelecimentoId)) {
        pedido = await Pedido.findOne({
          _id: permissao.pedidoId,
          estabelecimentoId: configuracao.estabelecimentoId,
          codigoPublico: codigoSessao,
          excluido: { $ne: true },
        });
      }
    }
    if (!pedido) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado.",
      });
    }
    if (pedido.pagamentoStatus !== "pago"
      || !["entregue", "finalizado"].includes(String(pedido.status || ""))) {
      return res.status(403).json({
        success: false,
        message: "A avaliação é liberada quando o pedido estiver pago e entregue.",
      });
    }

    const produtoId = String(req.body?.produtoId || "").trim();
    const notaRecebida = Number(req.body?.nota);
    const nota = Number.isInteger(notaRecebida) ? notaRecebida : 0;
    if (!mongoose.isValidObjectId(produtoId) || nota < 1 || nota > 5) {
      return res.status(400).json({
        success: false,
        message: "Avaliação inválida.",
      });
    }
    const itemComprado = (pedido.itens || []).some(item =>
      String(item.produtoId) === produtoId);
    if (!itemComprado) {
      return res.status(403).json({
        success: false,
        message: "Este produto não pertence ao pedido informado.",
      });
    }
    const produtoDaLoja = await Produto.exists({
      _id: produtoId,
      estabelecimentoId: configuracao.estabelecimentoId,
    });
    if (!produtoDaLoja) {
      return res.status(404).json({
        success: false,
        message: "Produto não encontrado.",
      });
    }

    const comentario = String(req.body?.comentario || "").trim().slice(0, 500);
    const filtroAvaliacao = {
      estabelecimentoId: configuracao.estabelecimentoId,
      pedidoId: pedido._id,
      produtoId,
    };
    const atualizacaoAvaliacao = {
      $set: {
        estabelecimentoId: configuracao.estabelecimentoId,
        pedidoId: pedido._id,
        produtoId,
        cliente: pedido.cliente || "Cliente",
        nota,
        comentario,
        ipHash: hashAuditoriaAvaliacao(req.ip),
        dispositivoHash: hashAuditoriaAvaliacao(req.get("user-agent")),
      },
    };
    try {
      await Avaliacao.findOneAndUpdate(
        filtroAvaliacao,
        atualizacaoAvaliacao,
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const resultado = await Avaliacao.updateOne(
        filtroAvaliacao,
        atualizacaoAvaliacao,
        { runValidators: true },
      );
      if (!resultado?.matchedCount) throw error;
    }
    return res.json({
      success: true,
      message: "Obrigado pela sua avaliação!",
    });
  } catch (error) {
    appLogger.error("Erro ao avaliar produto do catálogo:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível salvar a avaliação.",
    });
  }
};

/* REMOTE PRINT AGENT */
const MAX_TENTATIVAS_CODIGO_AGENTE = 10;
const DURACAO_CODIGO_AGENTE_MS = 15 * 60 * 1000;

async function reservarCodigoAgente(lojaId, gerarCodigo = () =>
  String(crypto.randomInt(100000, 1000000))) {
  const agora = new Date();
  await PrintAgent.updateMany(
    {
      codigoVinculacao: { $ne: "" },
      codigoExpiraEm: { $lte: agora },
    },
    {
      $set: {
        codigoVinculacao: "",
        codigoExpiraEm: null,
      },
    },
  );

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_CODIGO_AGENTE; tentativa += 1) {
    const codigo = gerarCodigo();
    const expiraEm = new Date(Date.now() + DURACAO_CODIGO_AGENTE_MS);
    try {
      await PrintAgent.findOneAndUpdate(
        { estabelecimentoId: lojaId },
        {
          $set: {
            codigoVinculacao: codigo,
            codigoExpiraEm: expiraEm,
            ativo: true,
          },
          $setOnInsert: { tokenHash: "" },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      );
      return { codigo, expiraEm };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  throw new Error("Não foi possível reservar um código de vínculo único.");
}

exports.gerarCodigoAgente = async (req, res) => {
  try {
    const lojaId = estabelecimentoId(req);
    const { codigo, expiraEm } = await reservarCodigoAgente(lojaId);
    return res.json({ success: true, codigo, expiraEm });
  } catch (error) { return res.status(500).json({ success: false, message: "Não foi possível gerar o código." }); }
};

exports.statusAgente = async (req, res) => {
  const lojaId = String(estabelecimentoId(req));
  const agente = await PrintAgent.findOne({ estabelecimentoId: lojaId }).lean();
  let status = printAgentHub.currentStatus(lojaId);
  if (!status.connected && agente?.agentVersion && agente.protocolCompativel === false) {
    status = {
      ...status,
      status: "desatualizado",
      outdated: true,
      minimumAgentVersion: MINIMUM_AGENT_VERSION,
    };
  }
  return res.json({
    success: true,
    online: status.connected,
    status,
    agente: agente ? {
      nomeComputador: agente.nomeComputador,
      ultimaConexao: agente.ultimaConexao,
      impressoras: agente.impressoras || [],
    } : null,
  });
};

exports.downloadAgenteValidado = (req, res) => {
  try {
    const artifact = require("../services/agentDownloadService")
      .resolveValidatedArtifact(process.env);
    res.setHeader("Content-Type", "application/vnd.microsoft.portable-executable");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${artifact.fileName}"`,
    );
    res.setHeader("Content-Length", String(artifact.size));
    res.setHeader("X-Checksum-SHA256", artifact.checksum);
    res.setHeader("Cache-Control", "private, no-store");
    return res.sendFile(artifact.filePath);
  } catch (error) {
    return res.status(error.statusCode || 503).json({
      success: false,
      code: "AGENTE_NAO_DISPONIVEL",
      message: "O instalador validado ainda não está disponível.",
    });
  }
};

exports.streamStatusAgente = (req, res) => {
  const lojaId = String(estabelecimentoId(req));
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");

  const enviar = payload => {
    if (res.writableEnded) return;
    res.write(
      `event: print-agent-status\n`
      + `data: ${JSON.stringify(payload)}\n\n`,
    );
  };
  enviar(printAgentHub.currentStatus(lojaId));

  const unsubscribe = printAgentHub.subscribeStatus(lojaId, enviar);
  let validando = false;
  const heartbeat = setInterval(async () => {
    if (res.writableEnded || validando) return;
    validando = true;
    try {
      if (!await validarAcessoSse(req, res, "configurar_impressoras")) {
        clearInterval(heartbeat);
        unsubscribe();
        return;
      }
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    } finally {
      validando = false;
    }
  }, 5_000);
  heartbeat.unref?.();

  const unregisterSse = appState.registerSse(res, () => {
    clearInterval(heartbeat);
    unsubscribe();
  }, { sessionId: req.sessionID });
  req.on("close", () => {
    unregisterSse();
    if (!res.writableEnded) res.end();
  });
};

exports.impressorasAgente = async (req, res) => {
  try { const data = await printAgentHub.request(String(estabelecimentoId(req)), "printers:list", {}, 10000); return res.json({ success: true, printers: data }); }
  catch (error) { return res.status(503).json({ success: false, message: error.message }); }
};

exports.testarImpressoraRemota = async (req, res) => {
  try {
    const lojaId = String(estabelecimentoId(req));
    const configuracao = await Configuracao.findOne({ estabelecimentoId: lojaId }).lean();
    const requestedPrinterId = printQueueService.calcularImpressoraId(req.body?.impressora || {});
    const impressora = (configuracao?.impressoras || []).find(item =>
      printQueueService.calcularImpressoraId(item) === requestedPrinterId);
    if (!impressora) {
      return res.status(404).json({
        success: false,
        message: "Impressora não encontrada nas configurações deste estabelecimento.",
      });
    }
    const jobId = crypto.randomUUID();
    const leaseId = crypto.randomUUID();
    const data = await printAgentHub.requestPrintJob(
      lojaId,
      "printer:test",
      {
        protocolVersion: PROTOCOL_VERSION,
        jobId,
        leaseId,
        impressoraId: printQueueService.calcularImpressoraId(impressora),
        attempt: 1,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        impressora: printQueueService.sanitizarImpressora(impressora),
      },
      20000,
    );
    return res.status(data.pending ? 202 : 200).json({ success: true, ...data });
  }
  catch (error) { return res.status(503).json({ success: false, message: error.message }); }
};

const manualPrintRequestsInFlight = new Set();

exports.imprimirPedidoRemoto = async (req, res) => {
  const lojaId = String(estabelecimentoId(req));
  const pedidoId = String(req.params.id || "");
  const imprimirComandaMesa =
    req.body?.scope === "mesa_comanda"
    || req.body?.imprimirComandaMesa === true;

  if (imprimirComandaMesa) {
    try {
      const pedidoReferencia = await Pedido.findOne({
        _id: pedidoId,
        estabelecimentoId: lojaId,
        excluido: { $ne: true },
      }).select("_id canal mesaId").lean();

      if (!pedidoReferencia) {
        return res.status(404).json({
          success: false,
          code: "PEDIDO_REFERENCIA_NAO_ENCONTRADO",
          message: "Pedido de referência da comanda não encontrado.",
        });
      }

      if (String(pedidoReferencia.canal || "") !== "mesa" || !pedidoReferencia.mesaId) {
        return res.status(400).json({
          success: false,
          code: "PEDIDO_REFERENCIA_NAO_E_MESA",
          message: "O pedido informado não pertence a uma mesa aberta.",
        });
      }

      return responderImpressaoComandaMesa(req, res, {
        lojaId,
        mesaId: String(pedidoReferencia.mesaId),
      });
    } catch (error) {
      appLogger.error("Erro ao resolver pedido de referência da comanda:", error);
      return res.status(503).json({
        success: false,
        code: error?.code || "PRINT_TABLE_REFERENCE_FAILED",
        message: error?.message || "Não foi possível localizar a comanda da mesa.",
      });
    }
  }

  const requestLockKey = `${lojaId}:${pedidoId}`;

  if (manualPrintRequestsInFlight.has(requestLockKey)) {
    return res.status(409).json({
      success: false,
      code: "PRINT_REQUEST_IN_PROGRESS",
      message: "Já existe uma solicitação de impressão em andamento para este pedido.",
    });
  }

  manualPrintRequestsInFlight.add(requestLockKey);

  try {
    const [pedido, configuracao, dono] = await Promise.all([
      Pedido.findOne({
        _id: pedidoId,
        estabelecimentoId: lojaId,
        excluido: { $ne: true },
      }).populate("mesaId", "numero setor").lean(),
      Configuracao.findOne({ estabelecimentoId: lojaId }).lean(),
      registroModel.findById(lojaId).select("cpfCnpj").lean(),
    ]);
    if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
    if (["pix", "pix_online"].includes(String(pedido.formaPagamento || ""))
      && pedido.pagamentoStatus !== "pago") {
      return res.status(409).json({
        success: false,
        code: "PIX_PAYMENT_REQUIRED_FOR_PRINT",
        message: "A impressão do pedido Pix será liberada após a confirmação do pagamento.",
      });
    }
    const impressorasManuais = (configuracao?.impressoras || []).filter(item =>
      ["manual", "manual_automatica"].includes(item.modo));
    if (!impressorasManuais.length) {
      return res.status(400).json({
        success: false,
        message: "Nenhuma impressora manual está configurada.",
      });
    }

    const impressoras = impressorasManuais.filter(item =>
      printQueueService.impressoraAceitaPedido(item, pedido));
    if (!impressoras.length) {
      const origem = pedido.canal === "delivery"
        ? "Delivery"
        : pedido.canal === "mesa"
          ? "Mesa"
          : "Retirada";
      return res.status(400).json({
        success: false,
        code: "NO_PRINTER_FOR_ORDER_ORIGIN",
        message: `Nenhuma impressora manual está configurada para pedidos de ${origem}.`,
      });
    }

    const impressoraChaves = [...new Set(
      impressoras.map(item => printQueueService.calcularImpressoraChave(item)),
    )];
    const jobsExistentes = await PrintJob.find({
      estabelecimentoId: lojaId,
      impressoraChave: { $in: impressoraChaves },
      status: { $in: BLOCKING_PRINT_STATUSES },
      $or: [
        { pedidoId: pedido._id },
        { "pedido.comandaPedidoIds": String(pedido._id) },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(Math.max(50, impressoraChaves.length * 20))
      .select("jobId tipo status createdAt concluidoEm impressoraChave")
      .lean();

    const confirmReprint = req.body?.confirmReprint === true;
    const decision = evaluateManualPrintRequest({
      jobs: jobsExistentes,
      confirmReprint,
      now: Date.now(),
      cooldownMs: MANUAL_PRINT_COOLDOWN_MS,
    });

    if (decision.action === "confirm_reprint") {
      const latestAt = decision.latestJob?.concluidoEm || decision.latestJob?.createdAt || null;
      return res.status(409).json({
        success: false,
        code: "PRINT_REPRINT_CONFIRMATION_REQUIRED",
        message: latestAt
          ? `Este pedido já possui uma impressão registrada em ${new Date(latestAt).toLocaleString("pt-BR")}. Deseja imprimir outra via?`
          : "Este pedido já possui uma impressão registrada. Deseja imprimir outra via?",
        latestJobId: decision.latestJob?.jobId || "",
        latestStatus: decision.latestJob?.status || "",
        latestPrintedAt: latestAt,
      });
    }

    if (decision.action === "too_recent") {
      return res.status(409).json({
        success: false,
        code: "PRINT_REPRINT_TOO_SOON",
        message: `Uma impressão manual acabou de ser solicitada. Aguarde ${decision.retryAfterSeconds} segundo(s) antes de pedir outra via.`,
        retryAfterSeconds: decision.retryAfterSeconds,
        latestJobId: decision.latestJob?.jobId || "",
      });
    }

    const jobs = [];
    for (const impressora of impressoras) {
      jobs.push(await printQueueService.criarJobManual({
        pedido,
        impressora,
        configuracao,
        dono,
      }));
    }
    const agentOnline = printAgentHub.isOnline(lojaId);
    return res.status(202).json({
      success: true,
      status: agentOnline ? "pendente" : "aguardando_agente",
      jobId: jobs[0].jobId,
      jobIds: jobs.map(job => job.jobId),
      reprint: confirmReprint,
      message: agentOnline
        ? (confirmReprint ? "Reimpressão adicionada à fila." : "Impressão adicionada à fila.")
        : (confirmReprint
            ? "Reimpressão aguardando o agente reconectar."
            : "Impressão aguardando o agente reconectar."),
    });
  } catch (error) {
    return res.status(503).json({ success: false, message: error.message });
  } finally {
    manualPrintRequestsInFlight.delete(requestLockKey);
  }
};

async function responderImpressaoComandaMesa(req, res, { lojaId, mesaId }) {

  if (!mongoose.isValidObjectId(mesaId)) {
    return res.status(400).json({
      success: false,
      code: "MESA_ID_INVALIDO",
      message: "Mesa inválida.",
    });
  }

  const requestLockKey = `mesa:${lojaId}:${mesaId}`;

  if (manualPrintRequestsInFlight.has(requestLockKey)) {
    return res.status(409).json({
      success: false,
      code: "PRINT_REQUEST_IN_PROGRESS",
      message: "Já existe uma solicitação de impressão desta comanda em andamento.",
    });
  }

  manualPrintRequestsInFlight.add(requestLockKey);

  try {
    const [mesa, pedidos, configuracao, dono] = await Promise.all([
      Mesa.findOne({
        _id: mesaId,
        estabelecimentoId: lojaId,
      }).select("_id numero setor status").lean(),
      Pedido.find({
        estabelecimentoId: lojaId,
        canal: "mesa",
        mesaId,
        excluido: { $ne: true },
        pagamentoStatus: "pendente",
        status: { $ne: "cancelado" },
      }).sort({ createdAt: 1, _id: 1 }).lean(),
      Configuracao.findOne({ estabelecimentoId: lojaId }).lean(),
      registroModel.findById(lojaId).select("cpfCnpj").lean(),
    ]);

    if (!mesa) {
      return res.status(404).json({
        success: false,
        message: "Mesa não encontrada.",
      });
    }

    if (!pedidos.length) {
      return res.status(409).json({
        success: false,
        code: "MESA_SEM_PEDIDOS_ABERTOS",
        message: "Esta mesa não possui pedidos em aberto para imprimir.",
      });
    }

    const pixPendente = pedidos.find(pedido =>
      ["pix", "pix_online"].includes(String(pedido.formaPagamento || "").toLowerCase())
      && String(pedido.pagamentoStatus || "pendente") !== "pago");
    if (pixPendente) {
      return res.status(409).json({
        success: false,
        code: "PIX_PAYMENT_REQUIRED_FOR_PRINT",
        message: `A comanda contém o pedido #${String(pixPendente.codigoPublico || pixPendente._id).slice(-8).toUpperCase()} com Pix aguardando confirmação.`,
      });
    }

    const pedidoComanda = montarPedidoComandaMesaParaImpressao({
      pedidos,
      mesa,
      estabelecimentoId: lojaId,
    });

    const impressorasManuais = (configuracao?.impressoras || []).filter(item =>
      ["manual", "manual_automatica"].includes(item.modo));
    if (!impressorasManuais.length) {
      return res.status(400).json({
        success: false,
        message: "Nenhuma impressora manual está configurada.",
      });
    }

    const impressoras = impressorasManuais.filter(item =>
      printQueueService.impressoraAceitaPedido(item, pedidoComanda));
    if (!impressoras.length) {
      return res.status(400).json({
        success: false,
        code: "NO_PRINTER_FOR_ORDER_ORIGIN",
        message: "Nenhuma impressora manual está configurada para pedidos de Mesa.",
      });
    }

    const impressoraChaves = [...new Set(
      impressoras.map(item => printQueueService.calcularImpressoraChave(item)),
    )];

    const jobsExistentes = await PrintJob.find({
      estabelecimentoId: lojaId,
      impressoraChave: { $in: impressoraChaves },
      status: { $in: BLOCKING_PRINT_STATUSES },
      "pedido.documentoTipo": "comanda_mesa",
      "pedido.comandaChave": pedidoComanda.comandaChave,
    })
      .sort({ createdAt: -1 })
      .limit(Math.max(50, impressoraChaves.length * 20))
      .select("jobId tipo status createdAt concluidoEm impressoraChave")
      .lean();

    const confirmReprint = req.body?.confirmReprint === true;
    const decision = evaluateManualPrintRequest({
      jobs: jobsExistentes,
      confirmReprint,
      now: Date.now(),
      cooldownMs: MANUAL_PRINT_COOLDOWN_MS,
    });

    if (decision.action === "confirm_reprint") {
      const latestAt = decision.latestJob?.concluidoEm || decision.latestJob?.createdAt || null;
      return res.status(409).json({
        success: false,
        code: "PRINT_REPRINT_CONFIRMATION_REQUIRED",
        message: latestAt
          ? `Esta mesma versão da comanda já foi impressa em ${new Date(latestAt).toLocaleString("pt-BR")}. Deseja imprimir outra via?`
          : "Esta mesma versão da comanda já possui uma impressão registrada. Deseja imprimir outra via?",
        latestJobId: decision.latestJob?.jobId || "",
        latestStatus: decision.latestJob?.status || "",
        latestPrintedAt: latestAt,
      });
    }

    if (decision.action === "too_recent") {
      return res.status(409).json({
        success: false,
        code: "PRINT_REPRINT_TOO_SOON",
        message: `A comanda acabou de ser enviada para impressão. Aguarde ${decision.retryAfterSeconds} segundo(s) antes de pedir outra via.`,
        retryAfterSeconds: decision.retryAfterSeconds,
        latestJobId: decision.latestJob?.jobId || "",
      });
    }

    const jobs = [];
    for (const impressora of impressoras) {
      jobs.push(await printQueueService.criarJobManual({
        pedido: pedidoComanda,
        impressora,
        configuracao,
        dono,
      }));
    }

    const agentOnline = printAgentHub.isOnline(lojaId);
    const totalCentavos = Math.round(Number(pedidoComanda.total || 0) * 100);
    return res.status(202).json({
      success: true,
      status: agentOnline ? "pendente" : "aguardando_agente",
      jobId: jobs[0].jobId,
      jobIds: jobs.map(job => job.jobId),
      documentoTipo: "comanda_mesa",
      mesaId: String(mesa._id),
      mesaNumero: mesa.numero,
      quantidadePedidos: pedidos.length,
      totalCentavos,
      reprint: confirmReprint,
      message: agentOnline
        ? `Comanda da Mesa ${mesa.numero} adicionada à fila em uma única impressão por impressora.`
        : `Comanda da Mesa ${mesa.numero} aguardando o agente reconectar.`,
    });
  } catch (error) {
    appLogger.error("Erro ao imprimir comanda única da mesa:", error);
    return res.status(error?.statusCode || 503).json({
      success: false,
      code: error?.code || "PRINT_TABLE_TAB_FAILED",
      message: error?.message || "Não foi possível imprimir a comanda da mesa.",
    });
  } finally {
    manualPrintRequestsInFlight.delete(requestLockKey);
  }
}

exports.imprimirComandaMesaRemota = async (req, res) => responderImpressaoComandaMesa(
  req,
  res,
  {
    lojaId: String(estabelecimentoId(req)),
    mesaId: String(req.params.id || ""),
  },
);

exports.statusJobImpressao = async (req, res) => {
  let job = await PrintJob.findOne({
    jobId: req.params.jobId,
    estabelecimentoId: estabelecimentoId(req),
  });
  if (!job) {
    return res.status(404).json({ success: false, message: "Trabalho não encontrado." });
  }
  if (job.status === "resultado_desconhecido" && printAgentHub.isOnline(job.estabelecimentoId)) {
    const leaseId = String(job.ultimoLeaseId || job.leaseToken || "");
    if (leaseId) {
      try {
        job = await printAgentHub.reconcileUnknownJob(job) || job;
      } catch {
        // O GET continua somente-leitura do ponto de vista do dispositivo:
        // uma falha de consulta mantém o estado para nova tentativa.
      }
    }
  }
  job = job.toObject ? job.toObject() : job;
  const agentOnline = printAgentHub.isOnline(job.estabelecimentoId);
  const publicStatus = job.status === "pendente" && !agentOnline
    ? "aguardando_agente"
    : job.status;
  return res.json({
    success: true,
    job: {
      jobId: job.jobId,
      status: publicStatus,
      tentativas: job.tentativas,
      erro: job.erro || "",
      createdAt: job.createdAt,
      recebidoEm: job.recebidoEm,
      processandoEm: job.processandoEm,
      enviadoEm: job.enviadoEm,
      concluidoEm: job.concluidoEm,
      requerConciliacao: job.status === "resultado_desconhecido",
      agenteConectado: agentOnline,
    },
  });
};

exports.retryJobImpressao = async (req, res) => {
  try {
    const job = await PrintJob.findOne({
      jobId: req.params.jobId,
      estabelecimentoId: estabelecimentoId(req),
    });
    if (!job) {
      return res.status(404).json({ success: false, message: "Trabalho não encontrado." });
    }
    const updated = await printQueueService.retryJob(job);
    return res.status(202).json({
      success: true,
      jobId: updated.jobId,
      status: updated.status,
    });
  } catch (error) {
    return res.status(409).json({ success: false, message: error.message });
  }
};

exports.reconciliarJobImpressao = async (req, res) => {
  try {
    const job = await PrintJob.findOne({
      jobId: req.params.jobId,
      estabelecimentoId: estabelecimentoId(req),
    });
    if (!job) {
      return res.status(404).json({ success: false, message: "Trabalho não encontrado." });
    }
    const updated = await printQueueService.reconciliarJobManual(
      job,
      String(req.body?.action || ""),
    );
    return res.json({ success: true, jobId: updated.jobId, status: updated.status });
  } catch (error) {
    return res.status(409).json({ success: false, message: error.message });
  }
};

exports.buscarImpressorasRedeRemotas = async (req,res) => {
 try { const data=await printAgentHub.request(String(estabelecimentoId(req)), "network:scan", {}, 120000); return res.json({success:true,devices:data}); }
 catch(error){return res.status(503).json({success:false,message:error.message});}
};

exports.montarAcessoPainel =
  montarAcessoPainel;
exports.obterPeriodoRelatorio =
  obterPeriodoRelatorio;
exports.pedidoEntraNoFinanceiro =
  pedidoEntraNoFinanceiro;
exports.pedidoContaFinalizado =
  pedidoContaFinalizado;
exports.agregarRelatorios =
  agregarRelatorios;
exports.agregarDashboard =
  agregarDashboard;
exports._testing = {
  agregarRelatorios,
  criarResumoFormasPagamentoVazio,
  normalizarResumoFormasPagamento,
  etapasAgregacaoFormasPagamento,
  adicionarHistoricoFinanceiro,
  confirmarPedidoComEstoque,
  emailFuncionarioEmUso,
  exigirMovimentacaoEstoqueConcluida,
  montarFichaTecnicaProduto,
  montarGraficoAgregado,
  montarVendasPorCategoriaProduto,
  montarResumoVendasPorCategoria,
  normalizarAdicionais,
  normalizarImpressoras,
  reservarCodigoAgente,
  idsDeIngredientesDesativadosReferenciados,
  validarFichaAntesDeSalvar,
  normalizarPermissoesFuncionario,
  validarAdministracaoFuncionario,
  validarAcessoSse,
};
