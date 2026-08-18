"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const BACKUP_SUFFIX = ".bak-aprovacao-troca-mesa";
const contents = new Map();
const changed = [];

const TARGETS = [
  "route.js",
  "src/config/permissions.js",
  "src/models/painelModels.js",
  "src/controllers/adminRealController.js",
  "src/views/mesa-publica.ejs",
  "src/views/admin-real.ejs",
  "test/authAuthorizationAuditP0.test.js",
  "test/mesaPedidoTrocaP0.test.js",
];

function target(rel) {
  return path.join(ROOT, rel);
}

function load(rel) {
  if (contents.has(rel)) return contents.get(rel);
  const full = target(rel);
  if (!fs.existsSync(full)) throw new Error(`Arquivo não encontrado: ${rel}`);
  const value = fs.readFileSync(full, "utf8");
  contents.set(rel, value);
  return value;
}

function set(rel, value) {
  contents.set(rel, value);
}

function replaceOnce(rel, source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`${rel}: âncora inválida para ${label}. Esperado 1, encontrado ${count}. Nenhum arquivo foi gravado.`);
  }
  return source.replace(search, replacement);
}

function replaceRegexOnce(rel, source, regex, replacement, label) {
  const matches = source.match(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`));
  const count = matches ? matches.length : 0;
  if (count !== 1) {
    throw new Error(`${rel}: padrão inválido para ${label}. Esperado 1, encontrado ${count}. Nenhum arquivo foi gravado.`);
  }
  return source.replace(regex, replacement);
}

function patchPermissions() {
  const rel = "src/config/permissions.js";
  let source = load(rel);
  if (source.includes('AUTORIZAR_TROCA_MESA: "autorizar_troca_mesa"')) return;

  source = replaceOnce(
    rel,
    source,
    '  ARQUIVAR_PEDIDOS: "arquivar_pedidos",\n});',
    '  ARQUIVAR_PEDIDOS: "arquivar_pedidos",\n  AUTORIZAR_TROCA_MESA: "autorizar_troca_mesa",\n});',
    "nova permissão",
  );
  source = replaceOnce(
    rel,
    source,
    '  PERMISSIONS.ARQUIVAR_PEDIDOS,\n]);',
    '  PERMISSIONS.ARQUIVAR_PEDIDOS,\n  PERMISSIONS.AUTORIZAR_TROCA_MESA,\n]);',
    "permissão crítica",
  );
  set(rel, source);
}

function patchModels() {
  const rel = "src/models/painelModels.js";
  let source = load(rel);

  if (!source.includes("'autorizar_troca_mesa'")) {
    source = replaceOnce(
      rel,
      source,
      "            'configurar_impressoras',\n            'arquivar_pedidos',\n          ],",
      "            'configurar_impressoras',\n            'arquivar_pedidos',\n            'autorizar_troca_mesa',\n          ],",
      "enum de permissões do funcionário",
    );
  }

  if (!source.includes("remocaoSolicitacaoStatus:")) {
    const anchor = `      pagamentoStatus: {\n        type: String,\n        enum: ["pendente", "pago", "cancelado", "expiracao_pendente", "expirado"],\n        default: "pendente",\n      },\n`;
    const block = `${anchor}\n      remocaoSolicitacaoStatus: {\n        type: String,\n        enum: ["nenhuma", "pendente", "aprovada", "recusada"],\n        default: "nenhuma",\n      },\n      remocaoSolicitadaEm: { type: Date, default: null },\n      remocaoDecididaEm: { type: Date, default: null },\n      remocaoDecididaPor: {\n        type: mongoose.Schema.Types.ObjectId,\n        default: null,\n      },\n`;
    source = replaceOnce(rel, source, anchor, block, "campos da solicitação de troca");
  }

  set(rel, source);
}

function patchRoutes() {
  const rel = "route.js";
  let source = load(rel);

  const oldPublic = `route.post(\n  '/mesa/:token/pedidos/:pedidoId/remover',\n  respostaPedidoSemCache,\n  limitePedidoMesa,\n  anonymousSameOriginProtection,\n  admin.removerPedidoMesa\n);`;
  const newPublic = `route.post(\n  '/mesa/:token/pedidos/:pedidoId/remover',\n  respostaPedidoSemCache,\n  limitePedidoMesa,\n  anonymousSameOriginProtection,\n  admin.solicitarRemocaoPedidoMesa\n);`;
  if (source.includes(oldPublic)) {
    source = replaceOnce(rel, source, oldPublic, newPublic, "rota pública de solicitação");
  } else if (!source.includes("admin.solicitarRemocaoPedidoMesa")) {
    throw new Error(`${rel}: a funcionalidade anterior de remoção da mesa não foi encontrada. Aplique primeiro o pacote anterior.`);
  }

  if (!source.includes("/solicitacao-remocao/aprovar")) {
    const anchor = `route.post(\n  '/admin/pedidos/:id/forma-pagamento',\n  loginRequired,\n  carregarAssinatura,\n  assinaturaRequired,\n  permissao('pedidos'),\n  admin.alterarFormaPagamentoPedido\n);\n`;
    const addition = `${anchor}\nroute.post(\n  '/admin/pedidos/:id/solicitacao-remocao/aprovar',\n  loginRequired,\n  carregarAssinatura,\n  assinaturaRequired,\n  permissao('pedidos'),\n  permissao('autorizar_troca_mesa'),\n  admin.aprovarRemocaoPedidoMesa\n);\n\nroute.post(\n  '/admin/pedidos/:id/solicitacao-remocao/recusar',\n  loginRequired,\n  carregarAssinatura,\n  assinaturaRequired,\n  permissao('pedidos'),\n  permissao('autorizar_troca_mesa'),\n  admin.recusarRemocaoPedidoMesa\n);\n`;
    source = replaceOnce(rel, source, anchor, addition, "rotas administrativas de decisão");
  }

  set(rel, source);
}

function patchController() {
  const rel = "src/controllers/adminRealController.js";
  let source = load(rel);

  if (!source.includes("podeAutorizarTrocaMesa")) {
    source = replaceOnce(
      rel,
      source,
      `    podeArquivarPedidos:\n      pode("arquivar_pedidos"),\n`,
      `    podeArquivarPedidos:\n      pode("arquivar_pedidos"),\n    podeAutorizarTrocaMesa:\n      pode("autorizar_troca_mesa"),\n`,
      "acesso do painel",
    );
  }

  if (!source.includes("remocaoSolicitacaoStatus:\n            pedido.remocaoSolicitacaoStatus")) {
    const anchor = `          pagamentoStatus:\n            pedido.pagamentoStatus ||\n            'pendente',\n`;
    const addition = `${anchor}\n          remocaoSolicitacaoStatus:\n            pedido.remocaoSolicitacaoStatus ||\n            'nenhuma',\n\n          remocaoSolicitadaEm:\n            pedido.remocaoSolicitadaEm ||\n            null,\n`;
    source = replaceOnce(rel, source, anchor, addition, "payload de atualização dos pedidos");
  }

  if (!source.includes("remocaoSolicitacaoStatus: String(pedido.remocaoSolicitacaoStatus")) {
    const itemAnchor = `          status: pedido.status,\n          createdAt: pedido.createdAt,\n`;
    const itemAddition = `          status: pedido.status,\n          remocaoSolicitacaoStatus: String(pedido.remocaoSolicitacaoStatus || "nenhuma"),\n          remocaoSolicitadaEm: pedido.remocaoSolicitadaEm || null,\n          createdAt: pedido.createdAt,\n`;
    source = replaceOnce(rel, source, itemAnchor, itemAddition, "estado da solicitação na mesa pública");
  }

  if (source.includes("exports.removerPedidoMesa = async (req, res) => {")) {
    const start = source.indexOf("exports.removerPedidoMesa = async (req, res) => {");
    const endMarker = "\n\n\nexports.avaliarPedidoMesa = async (";
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) {
      throw new Error(`${rel}: não consegui delimitar o controller antigo de remoção.`);
    }

    const block = `exports.solicitarRemocaoPedidoMesa = async (req, res) => {\n  try {\n    const mesa = await Mesa.findOne({\n      token: req.params.token,\n      status: { $ne: "inativa" },\n    })\n      .select("_id estabelecimentoId numero status")\n      .lean();\n\n    if (!mesa) {\n      return res.status(404).json({\n        success: false,\n        code: "MESA_NAO_ENCONTRADA",\n        message: "Mesa não encontrada.",\n      });\n    }\n\n    const pedidoId = String(req.params.pedidoId || "").trim();\n    if (!mongoose.isValidObjectId(pedidoId)) {\n      return res.status(404).json({\n        success: false,\n        code: "PEDIDO_NAO_ENCONTRADO",\n        message: "Pedido não encontrado para esta mesa.",\n      });\n    }\n\n    const filtroBase = {\n      _id: pedidoId,\n      estabelecimentoId: mesa.estabelecimentoId,\n      mesaId: mesa._id,\n      canal: "mesa",\n      excluido: { $ne: true },\n    };\n\n    const pedido = await Pedido.findOneAndUpdate(\n      {\n        ...filtroBase,\n        pagamentoStatus: "pendente",\n        status: { $nin: ["cancelado", "finalizado"] },\n        $or: [\n          { remocaoSolicitacaoStatus: { $exists: false } },\n          { remocaoSolicitacaoStatus: "nenhuma" },\n        ],\n      },\n      {\n        $set: {\n          remocaoSolicitacaoStatus: "pendente",\n          remocaoSolicitadaEm: new Date(),\n          remocaoDecididaEm: null,\n          remocaoDecididaPor: null,\n        },\n      },\n      { returnDocument: "after", runValidators: true },\n    );\n\n    if (!pedido) {\n      const existente = await Pedido.findOne(filtroBase)\n        .select("_id pagamentoStatus status remocaoSolicitacaoStatus")\n        .lean();\n\n      if (!existente) {\n        return res.status(404).json({\n          success: false,\n          code: "PEDIDO_NAO_ENCONTRADO",\n          message: "Pedido não encontrado para esta mesa.",\n        });\n      }\n\n      if (String(existente.remocaoSolicitacaoStatus || "") === "pendente") {\n        return res.json({\n          success: true,\n          pedidoId: String(existente._id),\n          aguardandoAprovacao: true,\n          message: "A solicitação já foi enviada e aguarda autorização do estabelecimento.",\n        });\n      }\n\n      if (String(existente.remocaoSolicitacaoStatus || "") === "recusada") {\n        return res.status(409).json({\n          success: false,\n          code: "SOLICITACAO_JA_ANALISADA",\n          message: "Esta solicitação já foi analisada. Fale com um atendente para pedir uma nova alteração.",\n        });\n      }\n\n      return res.status(409).json({\n        success: false,\n        code: "PEDIDO_NAO_PODE_SOLICITAR_TROCA",\n        message: "Este pedido não pode mais ser alterado porque já foi pago, cancelado ou finalizado.",\n      });\n    }\n\n    return res.json({\n      success: true,\n      pedidoId: String(pedido._id),\n      aguardandoAprovacao: true,\n      message: "Solicitação enviada. Aguarde a autorização do estabelecimento.",\n    });\n  } catch (error) {\n    appLogger.error("Erro ao solicitar remoção de pedido da mesa:", error);\n    return res.status(500).json({\n      success: false,\n      code: "PEDIDO_MESA_SOLICITACAO_REMOCAO_FALHOU",\n      message: "Não foi possível enviar a solicitação agora.",\n    });\n  }\n};\n\nexports.aprovarRemocaoPedidoMesa = async (req, res) => {\n  try {\n    const idEstabelecimento = estabelecimentoId(req);\n    const pedidoId = String(req.params.id || "").trim();\n    if (!mongoose.isValidObjectId(pedidoId)) {\n      return res.status(404).json({ success: false, message: "Pedido não encontrado." });\n    }\n\n    const pedido = await Pedido.findOneAndUpdate(\n      {\n        _id: pedidoId,\n        estabelecimentoId: idEstabelecimento,\n        canal: "mesa",\n        excluido: { $ne: true },\n        pagamentoStatus: "pendente",\n        status: { $nin: ["cancelado", "finalizado"] },\n        remocaoSolicitacaoStatus: "pendente",\n      },\n      {\n        $set: {\n          status: "cancelado",\n          pagamentoStatus: "cancelado",\n          remocaoSolicitacaoStatus: "aprovada",\n          remocaoDecididaEm: new Date(),\n          remocaoDecididaPor: req.session.user.id,\n        },\n      },\n      { returnDocument: "after", runValidators: true },\n    );\n\n    if (!pedido) {\n      return res.status(409).json({\n        success: false,\n        code: "SOLICITACAO_NAO_ELEGIVEL",\n        message: "A solicitação não está mais disponível. O pedido pode ter sido pago ou alterado.",\n      });\n    }\n\n    await PrintJob.updateMany(\n      {\n        estabelecimentoId: idEstabelecimento,\n        pedidoId: pedido._id,\n        status: { $in: ["pendente", "aguardando_retry"] },\n      },\n      {\n        $set: {\n          status: "cancelado",\n          erro: "Troca de pedido da mesa aprovada pelo estabelecimento.",\n          lockedBy: "",\n          leaseToken: "",\n          leaseExpiresAt: null,\n          nextAttemptAt: null,\n        },\n      },\n    );\n\n    const possuiOutrosPedidos = await Pedido.exists({\n      estabelecimentoId: idEstabelecimento,\n      mesaId: pedido.mesaId,\n      excluido: { $ne: true },\n      _id: { $ne: pedido._id },\n      pagamentoStatus: "pendente",\n      status: { $nin: ["finalizado", "cancelado"] },\n    });\n\n    if (!possuiOutrosPedidos && pedido.mesaId) {\n      await Mesa.updateOne(\n        { _id: pedido.mesaId, estabelecimentoId: idEstabelecimento },\n        { $set: { status: "livre" } },\n      );\n    }\n\n    await registrarAuditoria({\n      estabelecimentoId: idEstabelecimento,\n      entidade: "pedido",\n      entidadeId: pedido._id,\n      acao: "troca_mesa_aprovada",\n      usuarioId: req.session.user.id,\n      usuarioTipo: req.session.user.tipo,\n      dadosResumidos: {\n        codigoPedido: String(pedido.codigoPublico || pedido._id)\n          .slice(pedido.codigoPublico ? 0 : -6)\n          .toUpperCase(),\n        mesaId: String(pedido.mesaId || ""),\n        pagamentoStatus: pedido.pagamentoStatus,\n      },\n      operationKey: \`auditoria:troca_mesa_aprovada:\${pedido._id}\`,\n    });\n\n    return res.json({\n      success: true,\n      pedidoId: String(pedido._id),\n      mesaId: String(pedido.mesaId || ""),\n      message: "Troca aprovada. O pedido foi cancelado e saiu da conta da mesa.",\n    });\n  } catch (error) {\n    appLogger.error("Erro ao aprovar troca de pedido da mesa:", error);\n    return res.status(500).json({\n      success: false,\n      code: "APROVACAO_TROCA_MESA_FALHOU",\n      message: "Não foi possível aprovar a troca agora.",\n    });\n  }\n};\n\nexports.recusarRemocaoPedidoMesa = async (req, res) => {\n  try {\n    const idEstabelecimento = estabelecimentoId(req);\n    const pedidoId = String(req.params.id || "").trim();\n    if (!mongoose.isValidObjectId(pedidoId)) {\n      return res.status(404).json({ success: false, message: "Pedido não encontrado." });\n    }\n\n    const pedido = await Pedido.findOneAndUpdate(\n      {\n        _id: pedidoId,\n        estabelecimentoId: idEstabelecimento,\n        canal: "mesa",\n        excluido: { $ne: true },\n        remocaoSolicitacaoStatus: "pendente",\n      },\n      {\n        $set: {\n          remocaoSolicitacaoStatus: "recusada",\n          remocaoDecididaEm: new Date(),\n          remocaoDecididaPor: req.session.user.id,\n        },\n      },\n      { returnDocument: "after", runValidators: true },\n    );\n\n    if (!pedido) {\n      return res.status(409).json({\n        success: false,\n        code: "SOLICITACAO_NAO_ELEGIVEL",\n        message: "A solicitação já foi analisada ou não existe mais.",\n      });\n    }\n\n    await registrarAuditoria({\n      estabelecimentoId: idEstabelecimento,\n      entidade: "pedido",\n      entidadeId: pedido._id,\n      acao: "troca_mesa_recusada",\n      usuarioId: req.session.user.id,\n      usuarioTipo: req.session.user.tipo,\n      dadosResumidos: {\n        codigoPedido: String(pedido.codigoPublico || pedido._id)\n          .slice(pedido.codigoPublico ? 0 : -6)\n          .toUpperCase(),\n        mesaId: String(pedido.mesaId || ""),\n        pagamentoStatus: pedido.pagamentoStatus,\n      },\n      operationKey: \`auditoria:troca_mesa_recusada:\${pedido._id}:\${Date.now()}\`,\n    });\n\n    return res.json({\n      success: true,\n      pedidoId: String(pedido._id),\n      mesaId: String(pedido.mesaId || ""),\n      message: "Solicitação recusada. O pedido continua na mesa.",\n    });\n  } catch (error) {\n    appLogger.error("Erro ao recusar troca de pedido da mesa:", error);\n    return res.status(500).json({\n      success: false,\n      code: "RECUSA_TROCA_MESA_FALHOU",\n      message: "Não foi possível recusar a solicitação agora.",\n    });\n  }\n};`;

    source = source.slice(0, start) + block + source.slice(end);
  } else if (!source.includes("exports.solicitarRemocaoPedidoMesa = async")) {
    throw new Error(`${rel}: controller antigo da remoção não encontrado.`);
  }

  if (!source.includes("Somente funcionários autorizados podem cancelar pedidos de mesa.")) {
    const anchor = `      if (!pedido) {\n        return erroERedirecionar(\n          req,\n          res,\n          "pedidos",\n          "Pedido não encontrado.",\n        );\n      }\n\n      if (status === "cancelado") {`;
    const replacement = `      if (!pedido) {\n        return erroERedirecionar(\n          req,\n          res,\n          "pedidos",\n          "Pedido não encontrado.",\n        );\n      }\n\n      if (\n        status === "cancelado"\n        && String(pedido.canal || "") === "mesa"\n        && req.session?.user?.tipo !== "proprietario"\n        && !Array.isArray(req.permissoesAtuais)\n      ) {\n        return erroERedirecionar(\n          req,\n          res,\n          "pedidos",\n          "Somente funcionários autorizados podem cancelar pedidos de mesa.",\n        );\n      }\n\n      if (\n        status === "cancelado"\n        && String(pedido.canal || "") === "mesa"\n        && req.session?.user?.tipo !== "proprietario"\n        && !req.permissoesAtuais.includes("autorizar_troca_mesa")\n      ) {\n        return erroERedirecionar(\n          req,\n          res,\n          "pedidos",\n          "Somente funcionários autorizados podem cancelar pedidos de mesa.",\n        );\n      }\n\n      if (status === "cancelado") {`;
    source = replaceOnce(rel, source, anchor, replacement, "bloqueio de cancelamento manual de mesa");
  }

  set(rel, source);
}

function patchMesaView() {
  const rel = "src/views/mesa-publica.ejs";
  let source = load(rel);

  source = source.replace(/Remover pedido/g, "Solicitar troca/remover");
  source = source.replace(/Removendo\.\.\./g, "Enviando...");

  if (!source.includes("data-removal-request-pending")) {
    const oldButton = `              <button\n                type="button"\n                class="remove-pending-order"\n                data-remove-mesa-order="<%= item.pedidoId %>"\n              >\n                Solicitar troca/remover\n              </button>`;
    const replacement = `              <% if (String(item.remocaoSolicitacaoStatus || 'nenhuma') === 'pendente') { %>\n                <span data-removal-request-pending style="font-size:11px;font-weight:900;color:#a85b00;text-align:right;">Aguardando autorização</span>\n              <% } else if (String(item.remocaoSolicitacaoStatus || 'nenhuma') === 'recusada') { %>\n                <span style="font-size:11px;font-weight:900;color:#8a3b2f;text-align:right;">Solicitação recusada</span>\n              <% } else { %>\n                <button\n                  type="button"\n                  class="remove-pending-order"\n                  data-remove-mesa-order="<%= item.pedidoId %>"\n                >\n                  Solicitar troca/remover\n                </button>\n              <% } %>`;
    source = replaceOnce(rel, source, oldButton, replacement, "estado do botão público");
  }

  source = source.replace(
    `'Remover este pedido da mesa?\\n\\nIsso só é permitido enquanto o pagamento estiver pendente. Se este envio tiver mais de um item, todos os itens enviados juntos serão removidos.'`,
    `'Solicitar a troca/remoção deste pedido?\\n\\nO pedido não será apagado agora. Um funcionário autorizado precisará aprovar. Se este envio tiver mais de um item, todos os itens enviados juntos fazem parte da mesma solicitação.'`,
  );
  source = source.replace(
    `throw new Error(result.message || 'Não foi possível remover o pedido.');`,
    `throw new Error(result.message || 'Não foi possível enviar a solicitação.');`,
  );
  source = source.replace(
    `showToast(result.message || 'Pedido removido.');`,
    `showToast(result.message || 'Solicitação enviada.');`,
  );
  source = source.replace(
    `alert(error.message || 'Não foi possível remover o pedido.');`,
    `alert(error.message || 'Não foi possível enviar a solicitação.');`,
  );

  if (!source.includes("mesaRemovalApprovalTimer")) {
    const anchor = `    document.addEventListener('click', async event => {\n      const button = event.target.closest('[data-remove-mesa-order]');`;
    const helper = `    let mesaRemovalApprovalTimer = null;\n\n    function agendarAtualizacaoSolicitacaoMesa() {\n      if (mesaRemovalApprovalTimer || !document.querySelector('[data-removal-request-pending]')) return;\n      mesaRemovalApprovalTimer = window.setInterval(async () => {\n        if (document.hidden || !document.querySelector('[data-removal-request-pending]')) return;\n        const atualizou = await atualizarPedidosMesaSemReload();\n        if (atualizou && !document.querySelector('[data-removal-request-pending]')) {\n          window.clearInterval(mesaRemovalApprovalTimer);\n          mesaRemovalApprovalTimer = null;\n        }\n      }, 4000);\n    }\n\n    agendarAtualizacaoSolicitacaoMesa();\n\n    document.addEventListener('click', async event => {\n      const button = event.target.closest('[data-remove-mesa-order]');`;
    source = replaceOnce(rel, source, anchor, helper, "polling da decisão na mesa");
  }

  if (!source.includes("agendarAtualizacaoSolicitacaoMesa();\n        showToast(result.message")) {
    source = replaceOnce(
      rel,
      source,
      `        await atualizarPedidosMesaSemReload();\n        showToast(result.message || 'Solicitação enviada.');`,
      `        await atualizarPedidosMesaSemReload();\n        agendarAtualizacaoSolicitacaoMesa();\n        showToast(result.message || 'Solicitação enviada.');`,
      "início do polling após solicitação",
    );
  }

  set(rel, source);
}

function patchAdminView() {
  const rel = "src/views/admin-real.ejs";
  let source = load(rel);

  if (!source.includes("'autorizar_troca_mesa'")) {
    source = replaceOnce(
      rel,
      source,
      `    'configurar_impressoras',\n    'arquivar_pedidos'\n  ];`,
      `    'configurar_impressoras',\n    'arquivar_pedidos',\n    'autorizar_troca_mesa'\n  ];`,
      "lista de permissões críticas da view",
    );

    const listPattern = /'configurar_impressoras',\n            'arquivar_pedidos'\n          \]\.filter\(podeDelegarPermissao\)/g;
    const occurrences = source.match(listPattern)?.length || 0;
    if (occurrences !== 2) {
      throw new Error(`${rel}: esperava 2 listas de permissões de funcionário, encontrei ${occurrences}.`);
    }
    source = source.replace(listPattern, `'configurar_impressoras',\n            'arquivar_pedidos',\n            'autorizar_troca_mesa'\n          ].filter(podeDelegarPermissao)`);

    const labelsPattern = /configurar_impressoras: 'Configurar impressoras',\n                arquivar_pedidos: 'Arquivar pedidos'/g;
    const labelOccurrences = source.match(labelsPattern)?.length || 0;
    if (labelOccurrences !== 2) {
      throw new Error(`${rel}: esperava 2 mapas de nomes de permissão, encontrei ${labelOccurrences}.`);
    }
    source = source.replace(labelsPattern, `configurar_impressoras: 'Configurar impressoras',\n                arquivar_pedidos: 'Arquivar pedidos',\n                autorizar_troca_mesa: 'Autorizar troca/remoção de pedido da mesa'`);
  }

  if (!source.includes("data-removal-request-box")) {
    const anchor = `                <% if (subpedido.observacao) { %>\n                  <div class="order-observation"><strong>Observação deste pedido:</strong> <%= subpedido.observacao %></div>\n                <% } %>\n\n                <div class="table-tab-note">Subtotal deste pedido: <strong><%= formatarMoeda(subpedido.total || 0) %></strong></div>`;
    const block = `                <% if (subpedido.observacao) { %>\n                  <div class="order-observation"><strong>Observação deste pedido:</strong> <%= subpedido.observacao %></div>\n                <% } %>\n\n                <% if (String(subpedido.remocaoSolicitacaoStatus || '') === 'pendente') { %>\n                  <div class="order-observation" data-removal-request-box style="border-color:#f1b45d;background:#fff8e8;">\n                    <strong>⚠ Cliente solicitou troca/remoção deste pedido.</strong>\n                    <div style="margin-top:6px;">O pedido continua ativo até um responsável autorizar.</div>\n                    <% if (pode('autorizar_troca_mesa')) { %>\n                      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">\n                        <button type="button" class="mini-button edit" data-removal-decision="aprovar" data-removal-order-id="<%= subpedido._id %>" data-removal-mesa-id="<%= comanda.mesaId %>">Aprovar troca</button>\n                        <button type="button" class="mini-button" data-removal-decision="recusar" data-removal-order-id="<%= subpedido._id %>" data-removal-mesa-id="<%= comanda.mesaId %>">Recusar</button>\n                      </div>\n                    <% } else { %>\n                      <small style="display:block;margin-top:8px;">Aguardando funcionário com permissão para autorizar troca de mesa.</small>\n                    <% } %>\n                  </div>\n                <% } %>\n\n                <div class="table-tab-note">Subtotal deste pedido: <strong><%= formatarMoeda(subpedido.total || 0) %></strong></div>`;
    source = replaceOnce(rel, source, anchor, block, "aviso de solicitação na comanda");
  }

  if (!source.includes("pode('autorizar_troca_mesa') ? '<option value=\"cancelado\"'")) {
    const oldOption = `                        <option value="cancelado" <%= subpedido.status === 'cancelado' ? 'selected' : '' %>>Cancelado</option>`;
    const replacement = `                        <% if (pode('autorizar_troca_mesa')) { %>\n                          <option value="cancelado" <%= subpedido.status === 'cancelado' ? 'selected' : '' %>>Cancelado</option>\n                        <% } %>`;
    source = replaceOnce(rel, source, oldOption, replacement, "opção Cancelado da comanda");
  }

  if (!source.includes("const podeAutorizarTrocaMesa")) {
    const anchor = `const podeArquivarPedidos =\n  <%- safeJsonForHtml(pode('arquivar_pedidos')); %>;\n`;
    const replacement = `${anchor}\nconst podeAutorizarTrocaMesa =\n  <%- safeJsonForHtml(pode('autorizar_troca_mesa')); %>;\n`;
    source = replaceOnce(rel, source, anchor, replacement, "flag JS da permissão de troca");
  }

  if (!source.includes("data-removal-decision" + "')")) {
    const anchor = `async function verificarNovosPedidos() {`;
    const handler = `document.addEventListener('click', async event => {\n  const button = event.target.closest('[data-removal-decision]');\n  if (!button || button.dataset.busy === 'true' || !podeAutorizarTrocaMesa) return;\n\n  const decisao = String(button.dataset.removalDecision || '');\n  const pedidoId = String(button.dataset.removalOrderId || '');\n  const mesaId = String(button.dataset.removalMesaId || '');\n  if (!['aprovar', 'recusar'].includes(decisao) || !pedidoId || !mesaId) return;\n\n  if (decisao === 'aprovar') {\n    const confirmou = window.confirm(\n      'Aprovar a troca e cancelar este pedido?\\n\\nSe ele já tiver sido impresso ou estiver em preparo, confirme com a cozinha antes de continuar.'\n    );\n    if (!confirmou) return;\n  }\n\n  const botoes = Array.from(document.querySelectorAll(\n    \`[data-removal-order-id="\${CSS.escape(pedidoId)}"]\`\n  ));\n  botoes.forEach(item => {\n    item.dataset.busy = 'true';\n    item.disabled = true;\n  });\n\n  try {\n    const response = await adminFetch(\n      \`/admin/pedidos/\${encodeURIComponent(pedidoId)}/solicitacao-remocao/\${decisao}\`,\n      {\n        method: 'POST',\n        skipAdminLoading: true,\n        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },\n        body: '{}',\n      }\n    );\n    const result = await response.json();\n    if (!response.ok || !result.success) {\n      throw new Error(result.message || 'Não foi possível analisar a solicitação.');\n    }\n    await atualizarComandaMesaSemReload(mesaId);\n    showToast(result.message || 'Solicitação analisada.');\n  } catch (error) {\n    alert(error.message || 'Não foi possível analisar a solicitação.');\n    await atualizarComandaMesaSemReload(mesaId);\n  } finally {\n    botoes.forEach(item => {\n      item.dataset.busy = '';\n      item.disabled = false;\n    });\n  }\n});\n\n${anchor}`;
    source = replaceOnce(rel, source, anchor, handler, "ações de aprovar/recusar");
  }

  const oldExisting = `          if (estaDentroDeComanda && deixouDeEstarAberto) {\n            const cardMesa = existing.closest('[data-mesa-open-card]');\n            const mesaId = pedido.mesaId || cardMesa?.dataset?.mesaOpenCard || '';\n            if (mesaId) mesasParaAtualizar.add(String(mesaId));\n            return;\n          }`;
  if (source.includes(oldExisting)) {
    const replacement = `          if (estaDentroDeComanda && pedido.canal === 'mesa') {\n            const cardMesa = existing.closest('[data-mesa-open-card]');\n            const mesaId = pedido.mesaId || cardMesa?.dataset?.mesaOpenCard || '';\n            if (mesaId) mesasParaAtualizar.add(String(mesaId));\n            return;\n          }`;
    source = replaceOnce(rel, source, oldExisting, replacement, "refresh de qualquer atualização da comanda");
  }

  set(rel, source);
}

function patchTests() {
  const authRel = "test/authAuthorizationAuditP0.test.js";
  let auth = load(authRel);
  if (auth.includes('inventário possui 94 rotas')) {
    auth = auth.replace(/inventário possui 94 rotas/g, "inventário possui 96 rotas");
    auth = auth.replace(/assert\.equal\(inventory\.length, 94\);/g, "assert.equal(inventory.length, 96);");
  } else if (!auth.includes('inventário possui 96 rotas')) {
    throw new Error(`${authRel}: esperava inventário de 94 rotas antes desta alteração.`);
  }
  if (!auth.includes('"autorizar_troca_mesa"')) {
    auth = replaceOnce(
      authRel,
      auth,
      `    "arquivar_pedidos",\n  ]) {`,
      `    "arquivar_pedidos",\n    "autorizar_troca_mesa",\n  ]) {`,
      "permissão no teste central",
    );
    auth = replaceOnce(
      authRel,
      auth,
      `  assert.equal(CRITICAL_PERMISSIONS.has("arquivar_pedidos"), true);`,
      `  assert.equal(CRITICAL_PERMISSIONS.has("arquivar_pedidos"), true);\n  assert.equal(CRITICAL_PERMISSIONS.has("autorizar_troca_mesa"), true);`,
      "criticidade da nova permissão",
    );
  }
  set(authRel, auth);

  const mesaRel = "test/mesaPedidoTrocaP0.test.js";
  const mesa = `"use strict";\n\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst test = require("node:test");\n\nfunction source(rel) {\n  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");\n}\n\ntest("cliente apenas solicita troca; cancelamento depende de funcionário autorizado", () => {\n  const routes = source("route.js");\n  const publicStart = routes.indexOf("/mesa/:token/pedidos/:pedidoId/remover");\n  assert.ok(publicStart >= 0);\n  const publicBlock = routes.slice(Math.max(0, publicStart - 60), publicStart + 500);\n  assert.match(publicBlock, /anonymousSameOriginProtection/);\n  assert.match(publicBlock, /admin\\.solicitarRemocaoPedidoMesa/);\n  assert.doesNotMatch(publicBlock, /admin\\.removerPedidoMesa/);\n\n  const controller = source("src/controllers/adminRealController.js");\n  assert.match(controller, /exports\\.solicitarRemocaoPedidoMesa = async/);\n  assert.match(controller, /remocaoSolicitacaoStatus: "pendente"/);\n  const publicFnStart = controller.indexOf("exports.solicitarRemocaoPedidoMesa = async");\n  const publicFnEnd = controller.indexOf("exports.aprovarRemocaoPedidoMesa = async", publicFnStart);\n  const publicFn = controller.slice(publicFnStart, publicFnEnd);\n  assert.doesNotMatch(publicFn, /status: "cancelado"/);\n  assert.doesNotMatch(publicFn, /PrintJob\\.updateMany/);\n});\n\ntest("aprovar e recusar exigem pedidos + permissão crítica de troca de mesa", () => {\n  const routes = source("route.js");\n  for (const action of ["aprovar", "recusar"]) {\n    const start = routes.indexOf(\`/solicitacao-remocao/\${action}\`);\n    assert.ok(start >= 0, action);\n    const block = routes.slice(Math.max(0, start - 120), start + 520);\n    assert.match(block, /permissao\\('pedidos'\\)/);\n    assert.match(block, /permissao\\('autorizar_troca_mesa'\\)/);\n  }\n\n  const permissions = source("src/config/permissions.js");\n  assert.match(permissions, /AUTORIZAR_TROCA_MESA: "autorizar_troca_mesa"/);\n  assert.match(permissions, /PERMISSIONS\\.AUTORIZAR_TROCA_MESA/);\n});\n\ntest("aprovação só cancela solicitação pendente de pedido de mesa ainda não pago", () => {\n  const controller = source("src/controllers/adminRealController.js");\n  const start = controller.indexOf("exports.aprovarRemocaoPedidoMesa = async");\n  const end = controller.indexOf("exports.recusarRemocaoPedidoMesa = async", start);\n  const block = controller.slice(start, end);\n  assert.match(block, /canal: "mesa"/);\n  assert.match(block, /pagamentoStatus: "pendente"/);\n  assert.match(block, /remocaoSolicitacaoStatus: "pendente"/);\n  assert.match(block, /status: "cancelado"/);\n  assert.match(block, /pagamentoStatus: "cancelado"/);\n  assert.match(block, /remocaoSolicitacaoStatus: "aprovada"/);\n  assert.match(block, /PrintJob\\.updateMany/);\n  assert.match(block, /status: \\{ \\$in: \\["pendente", "aguardando_retry"\\] \\}/);\n  assert.match(block, /registrarAuditoria/);\n});\n\ntest("cancelamento manual de pedido de mesa também exige a nova permissão", () => {\n  const controller = source("src/controllers/adminRealController.js");\n  assert.match(controller, /Somente funcionários autorizados podem cancelar pedidos de mesa/);\n  assert.match(controller, /req\\.permissoesAtuais\\.includes\\("autorizar_troca_mesa"\\)/);\n});\n\ntest("cardápio mostra solicitação e acompanha decisão sem recarregar", () => {\n  const view = source("src/views/mesa-publica.ejs");\n  assert.match(view, /Solicitar troca\\/remover/);\n  assert.match(view, /data-removal-request-pending/);\n  assert.match(view, /Aguardando autorização/);\n  assert.match(view, /mesaRemovalApprovalTimer/);\n  assert.match(view, /atualizarPedidosMesaSemReload/);\n  const start = view.indexOf("let mesaRemovalApprovalTimer");\n  const end = view.indexOf("let pedidoIdempotencyKeyAtual", start);\n  assert.ok(start >= 0 && end > start);\n  assert.doesNotMatch(view.slice(start, end), /window\\.location\\.reload\\(\\)/);\n});\n\ntest("painel mostra pedido solicitado e só autorizado recebe Aprovar/Recusar", () => {\n  const view = source("src/views/admin-real.ejs");\n  assert.match(view, /pode\\('autorizar_troca_mesa'\\)/);\n  assert.match(view, /Cliente solicitou troca\\/remoção deste pedido/);\n  assert.match(view, /data-removal-decision="aprovar"/);\n  assert.match(view, /data-removal-decision="recusar"/);\n  assert.match(view, /podeAutorizarTrocaMesa/);\n  assert.match(view, /atualizarComandaMesaSemReload\\(mesaId\\)/);\n});\n`;
  set(mesaRel, mesa);
}

function validatePatched() {
  const route = contents.get("route.js");
  const permissions = contents.get("src/config/permissions.js");
  const model = contents.get("src/models/painelModels.js");
  const controller = contents.get("src/controllers/adminRealController.js");
  const mesaView = contents.get("src/views/mesa-publica.ejs");
  const adminView = contents.get("src/views/admin-real.ejs");

  const checks = [
    [route.includes("admin.solicitarRemocaoPedidoMesa"), "rota pública não foi convertida em solicitação"],
    [route.includes("/solicitacao-remocao/aprovar"), "rota de aprovação ausente"],
    [route.includes("/solicitacao-remocao/recusar"), "rota de recusa ausente"],
    [permissions.includes('AUTORIZAR_TROCA_MESA: "autorizar_troca_mesa"'), "permissão central ausente"],
    [model.includes("remocaoSolicitacaoStatus:"), "campos do Pedido ausentes"],
    [controller.includes("exports.aprovarRemocaoPedidoMesa = async"), "controller de aprovação ausente"],
    [controller.includes("exports.recusarRemocaoPedidoMesa = async"), "controller de recusa ausente"],
    [!controller.includes("exports.removerPedidoMesa = async"), "controller antigo de remoção direta ainda existe"],
    [mesaView.includes("Aguardando autorização"), "estado público de espera ausente"],
    [adminView.includes("Cliente solicitou troca/remoção deste pedido"), "aviso no painel ausente"],
  ];
  for (const [ok, message] of checks) if (!ok) throw new Error(`Validação final falhou: ${message}`);
}

function saveAll() {
  for (const rel of TARGETS) {
    const original = fs.readFileSync(target(rel), "utf8");
    const next = contents.get(rel);
    if (typeof next !== "string" || next === original) continue;
    const backup = `${target(rel)}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, "utf8");
    fs.writeFileSync(target(rel), next, "utf8");
    changed.push(rel);
  }
}

try {
  TARGETS.forEach(load);

  if (load("src/config/permissions.js").includes('AUTORIZAR_TROCA_MESA: "autorizar_troca_mesa"')) {
    console.log("A aprovação de troca de mesa já parece estar aplicada. Nenhum arquivo foi alterado.");
    process.exit(0);
  }

  patchPermissions();
  patchModels();
  patchRoutes();
  patchController();
  patchMesaView();
  patchAdminView();
  patchTests();
  validatePatched();
  saveAll();

  console.log("\nAlteração aplicada com sucesso.");
  console.log("Cliente agora apenas SOLICITA a troca; somente proprietário ou funcionário autorizado decide.");
  console.log("\nArquivos alterados:");
  changed.forEach(rel => console.log(` - ${rel}`));
  console.log(`\nBackups: ${BACKUP_SUFFIX}`);
  console.log("\nTeste focado:");
  console.log("NODE_ENV=test node --test test/mesaPedidoTrocaP0.test.js test/authAuthorizationAuditP0.test.js test/funcionariosSessaoP0.test.js");
} catch (error) {
  console.error(`\nERRO: ${error.message}`);
  console.error("Nenhum arquivo foi gravado se o erro ocorreu antes da etapa final de gravação.");
  process.exitCode = 1;
}
