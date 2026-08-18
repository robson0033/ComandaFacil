"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const BACKUP_SUFFIX = ".bak-troca-mesa";
const changed = [];

function file(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  const target = file(rel);
  if (!fs.existsSync(target)) {
    throw new Error(`Arquivo não encontrado: ${rel}`);
  }
  return fs.readFileSync(target, "utf8");
}

function write(rel, content, original) {
  const target = file(rel);
  const backup = `${target}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, "utf8");
  fs.writeFileSync(target, content, "utf8");
  changed.push(rel);
}

function replaceOnce(rel, source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`${rel}: não encontrei âncora única para ${label} (encontradas: ${count}). Nenhum arquivo adicional foi alterado.`);
  }
  return source.replace(search, replacement);
}

function patchRoute() {
  const rel = "route.js";
  const original = read(rel);
  if (original.includes("/mesa/:token/pedidos/:pedidoId/remover")) return;

  const anchor = `route.post(\n  '/mesa/:token/pedidos',\n  respostaPedidoSemCache,\n  limitePedidoMesa,\n  limitePedidoMesaHora,\n  anonymousSameOriginProtection,\n  admin.criarPedidoMesa\n);\n`;

  const addition = `${anchor}\nroute.post(\n  '/mesa/:token/pedidos/:pedidoId/remover',\n  respostaPedidoSemCache,\n  limitePedidoMesa,\n  anonymousSameOriginProtection,\n  admin.removerPedidoMesa\n);\n`;

  const next = replaceOnce(rel, original, anchor, addition, "rota de pedido da mesa");
  write(rel, next, original);
}

function patchController() {
  const rel = "src/controllers/adminRealController.js";
  const original = read(rel);
  if (original.includes("exports.removerPedidoMesa = async")) return;

  const anchor = `exports.avaliarPedidoMesa = async (`;
  const functionBlock = `exports.removerPedidoMesa = async (req, res) => {\n  try {\n    const mesa = await Mesa.findOne({\n      token: req.params.token,\n      status: { $ne: "inativa" },\n    })\n      .select("_id estabelecimentoId numero status")\n      .lean();\n\n    if (!mesa) {\n      return res.status(404).json({\n        success: false,\n        code: "MESA_NAO_ENCONTRADA",\n        message: "Mesa não encontrada.",\n      });\n    }\n\n    const pedidoId = String(req.params.pedidoId || "").trim();\n    if (!mongoose.isValidObjectId(pedidoId)) {\n      return res.status(404).json({\n        success: false,\n        code: "PEDIDO_NAO_ENCONTRADO",\n        message: "Pedido não encontrado para esta mesa.",\n      });\n    }\n\n    const filtroPedidoMesa = {\n      _id: pedidoId,\n      estabelecimentoId: mesa.estabelecimentoId,\n      mesaId: mesa._id,\n      canal: "mesa",\n      excluido: { $ne: true },\n    };\n\n    // A troca é autorizada exclusivamente enquanto o pagamento continua pendente.\n    // O filtro atômico também impede que uma requisição atrasada cancele um pedido\n    // que tenha sido pago/cancelado/finalizado em outra aba no mesmo instante.\n    const pedido = await Pedido.findOneAndUpdate(\n      {\n        ...filtroPedidoMesa,\n        pagamentoStatus: "pendente",\n        status: { $nin: ["cancelado", "finalizado"] },\n      },\n      { $set: { status: "cancelado" } },\n      { returnDocument: "after", runValidators: true },\n    );\n\n    if (!pedido) {\n      const existente = await Pedido.findOne(filtroPedidoMesa)\n        .select("_id pagamentoStatus status")\n        .lean();\n\n      if (!existente) {\n        return res.status(404).json({\n          success: false,\n          code: "PEDIDO_NAO_ENCONTRADO",\n          message: "Pedido não encontrado para esta mesa.",\n        });\n      }\n\n      return res.status(409).json({\n        success: false,\n        code: "PEDIDO_NAO_PODE_SER_TROCADO",\n        message: "Este pedido não pode mais ser removido porque já foi pago, cancelado ou finalizado.",\n      });\n    }\n\n    // Jobs que ainda não chegaram ao agente podem ser cancelados com segurança.\n    // Estados em que o agente já pode ter recebido o trabalho não são alterados,\n    // evitando assumir que uma impressão física já enviada possa ser desfeita.\n    await PrintJob.updateMany(\n      {\n        estabelecimentoId: mesa.estabelecimentoId,\n        pedidoId: pedido._id,\n        status: { $in: ["pendente", "aguardando_retry"] },\n      },\n      {\n        $set: {\n          status: "cancelado",\n          erro: "Pedido removido pelo cliente antes do pagamento.",\n          lockedBy: "",\n          leaseToken: "",\n          leaseExpiresAt: null,\n          nextAttemptAt: null,\n        },\n      },\n    );\n\n    const aindaTemPedidosAbertos = await Pedido.exists({\n      estabelecimentoId: mesa.estabelecimentoId,\n      mesaId: mesa._id,\n      canal: "mesa",\n      excluido: { $ne: true },\n      pagamentoStatus: "pendente",\n      status: { $ne: "cancelado" },\n    });\n\n    if (!aindaTemPedidosAbertos) {\n      await Mesa.updateOne(\n        { _id: mesa._id, estabelecimentoId: mesa.estabelecimentoId },\n        { $set: { status: "livre" } },\n      );\n    }\n\n    return res.json({\n      success: true,\n      pedidoId: String(pedido._id),\n      message: "Pedido removido. Agora você pode escolher outro item.",\n    });\n  } catch (error) {\n    appLogger.error("Erro ao remover pedido pendente da mesa:", error);\n    return res.status(500).json({\n      success: false,\n      code: "PEDIDO_MESA_REMOCAO_FALHOU",\n      message: "Não foi possível remover o pedido.",\n    });\n  }\n};\n\n\n`;

  const next = replaceOnce(rel, original, anchor, functionBlock + anchor, "controller avaliarPedidoMesa");
  write(rel, next, original);
}

function patchMesaView() {
  const rel = "src/views/mesa-publica.ejs";
  const original = read(rel);
  let next = original;

  if (!next.includes(".remove-pending-order")) {
    const cssAnchor = `    .pending-order-item small {\n      display: block;\n      margin-top: 4px;\n      color: var(--muted);\n    }\n`;
    const cssAddition = `${cssAnchor}\n    .pending-order-actions {\n      display: grid;\n      justify-items: end;\n      gap: 8px;\n      min-width: 112px;\n    }\n\n    .remove-pending-order {\n      min-height: 34px;\n      padding: 7px 11px;\n      border: 1px solid #efb7a2;\n      border-radius: 10px;\n      background: #fff3ee;\n      color: #b72e18;\n      font-size: 11px;\n      font-weight: 900;\n    }\n\n    .remove-pending-order:hover {\n      background: #ffe8df;\n    }\n\n    .remove-pending-order:disabled {\n      opacity: .55;\n      cursor: wait;\n    }\n`;
    next = replaceOnce(rel, next, cssAnchor, cssAddition, "CSS dos pedidos pendentes");

    const mobileAnchor = `      .pending-order-item > strong {\n        grid-column: 2;\n      }\n`;
    const mobileAddition = `      .pending-order-item > strong {\n        grid-column: auto;\n      }\n\n      .pending-order-actions {\n        grid-column: 2;\n        grid-template-columns: 1fr auto;\n        align-items: center;\n        justify-items: end;\n        width: 100%;\n      }\n`;
    next = replaceOnce(rel, next, mobileAnchor, mobileAddition, "CSS mobile dos pedidos pendentes");
  }

  if (!next.includes("data-remove-mesa-order")) {
    const itemOpen = `          <div class="pending-order-item">`;
    next = replaceOnce(
      rel,
      next,
      itemOpen,
      `          <div class="pending-order-item" data-pedido-id="<%= item.pedidoId %>">`,
      "data-pedido-id",
    );

    const priceBlock = `            <strong>\n              <%= Number(item.subtotal || 0).toLocaleString(\n                'pt-BR',\n                {\n                  style: 'currency',\n                  currency: 'BRL'\n                }\n              ) %>\n            </strong>`;
    const actionsBlock = `            <div class="pending-order-actions">\n              <strong>\n                <%= Number(item.subtotal || 0).toLocaleString(\n                  'pt-BR',\n                  {\n                    style: 'currency',\n                    currency: 'BRL'\n                  }\n                ) %>\n              </strong>\n              <button\n                type="button"\n                class="remove-pending-order"\n                data-remove-mesa-order="<%= item.pedidoId %>"\n              >\n                Remover pedido\n              </button>\n            </div>`;
    next = replaceOnce(rel, next, priceBlock, actionsBlock, "botão Remover pedido");
  }

  if (!next.includes("async function atualizarPedidosMesaSemReload")) {
    const jsAnchor = `    const csrfTokenPublico = <%- safeJsonForHtml(csrfToken) %>;\n`;
    const jsBlock = `${jsAnchor}\n    async function atualizarPedidosMesaSemReload() {\n      try {\n        const response = await fetch(window.location.href, {\n          method: 'GET',\n          cache: 'no-store',\n          headers: { Accept: 'text/html' },\n        });\n        if (!response.ok) return false;\n\n        const html = await response.text();\n        const pagina = new DOMParser().parseFromString(html, 'text/html');\n\n        for (const selector of ['.pending-orders', '.account-card']) {\n          const atual = document.querySelector(selector);\n          const novo = pagina.querySelector(selector);\n          if (atual && novo) {\n            atual.replaceWith(document.importNode(novo, true));\n          }\n        }\n        return true;\n      } catch (error) {\n        console.error('Não foi possível atualizar os pedidos da mesa:', error);\n        return false;\n      }\n    }\n\n    document.addEventListener('click', async event => {\n      const button = event.target.closest('[data-remove-mesa-order]');\n      if (!button || button.dataset.busy === 'true') return;\n\n      const pedidoId = String(button.dataset.removeMesaOrder || '').trim();\n      if (!pedidoId) return;\n\n      const confirmado = window.confirm(\n        'Remover este pedido da mesa?\\n\\nIsso só é permitido enquanto o pagamento estiver pendente. Se este envio tiver mais de um item, todos os itens enviados juntos serão removidos.'\n      );\n      if (!confirmado) return;\n\n      const botoesDoPedido = Array.from(document.querySelectorAll('[data-remove-mesa-order]'))\n        .filter(item => String(item.dataset.removeMesaOrder || '') === pedidoId);\n      botoesDoPedido.forEach(item => {\n        item.dataset.busy = 'true';\n        item.disabled = true;\n        item.textContent = 'Removendo...';\n      });\n\n      try {\n        const response = await fetch(\n          \`/mesa/<%= mesa.token %>/pedidos/\${encodeURIComponent(pedidoId)}/remover\`,\n          {\n            method: 'POST',\n            headers: {\n              'Accept': 'application/json',\n              'Content-Type': 'application/json',\n              'X-CSRF-Token': csrfTokenPublico,\n            },\n            body: '{}',\n          },\n        );\n\n        const result = await response.json();\n        if (!response.ok) {\n          throw new Error(result.message || 'Não foi possível remover o pedido.');\n        }\n\n        await atualizarPedidosMesaSemReload();\n        showToast(result.message || 'Pedido removido.');\n      } catch (error) {\n        alert(error.message || 'Não foi possível remover o pedido.');\n        botoesDoPedido.forEach(item => {\n          item.dataset.busy = '';\n          item.disabled = false;\n          item.textContent = 'Remover pedido';\n        });\n      }\n    });\n`;
    next = replaceOnce(rel, next, jsAnchor, jsBlock, "JS de remoção do pedido");
  }

  if (!next.includes("await atualizarPedidosMesaSemReload();\n            showToast(result.message);")) {
    const orderSuccess = `            closeCart();\n            showToast(result.message);\n            openRating(result);`;
    const orderSuccessNew = `            closeCart();\n            await atualizarPedidosMesaSemReload();\n            showToast(result.message);\n            openRating(result);`;
    next = replaceOnce(rel, next, orderSuccess, orderSuccessNew, "atualização da mesa após novo pedido");
  }

  if (next !== original) write(rel, next, original);
}

function patchAdminView() {
  const rel = "src/views/admin-real.ejs";
  const original = read(rel);
  let next = original;

  if (!next.includes("async function atualizarComandaMesaSemReload")) {
    const anchor = `async function verificarNovosPedidos() {`;
    const helper = `const atualizacoesComandaMesa = new Map();\n\nasync function atualizarComandaMesaSemReload(mesaId) {\n  const id = String(mesaId || '').trim();\n  if (!id) return null;\n  if (atualizacoesComandaMesa.has(id)) {\n    return atualizacoesComandaMesa.get(id);\n  }\n\n  const promise = (async () => {\n    try {\n      const response = await adminFetch(\n        \`\${window.location.pathname}\${window.location.search}\`,\n        {\n          skipAdminLoading: true,\n          headers: { Accept: 'text/html' },\n        }\n      );\n      if (!response.ok) return null;\n\n      const html = await response.text();\n      const pagina = new DOMParser().parseFromString(html, 'text/html');\n      const selector = \`[data-mesa-open-card="\${CSS.escape(id)}"]\`;\n      const atual = document.querySelector(selector);\n      const novo = pagina.querySelector(selector);\n\n      if (novo) {\n        const cardNovo = document.importNode(novo, true);\n        if (atual) {\n          atual.replaceWith(cardNovo);\n        } else if (ordersGrid) {\n          document.querySelector('#ordersEmptyState')?.remove();\n          ordersGrid.prepend(cardNovo);\n        }\n      } else if (atual) {\n        atual.remove();\n      }\n\n      applyOrdersFilters();\n      if (typeof atualizarResumoMesas === 'function') {\n        await atualizarResumoMesas({ force: true });\n      }\n      return novo;\n    } catch (error) {\n      if (!sessionRedirectInProgress) {\n        console.error('Não foi possível atualizar a comanda da mesa:', error);\n      }\n      return null;\n    }\n  })().finally(() => atualizacoesComandaMesa.delete(id));\n\n  atualizacoesComandaMesa.set(id, promise);\n  return promise;\n}\n\n${anchor}`;
    next = replaceOnce(rel, next, anchor, helper, "helper de atualização da comanda");
  }

  const oldLet = `    let recarregarComandasMesa = false;`;
  if (next.includes(oldLet)) {
    next = replaceOnce(rel, next, oldLet, `    const mesasParaAtualizar = new Set();`, "controle de atualização das comandas");
  }

  const oldExisting = `          if (estaDentroDeComanda && deixouDeEstarAberto) {\n            // Outra sessão/funcionário pode ter pago ou cancelado a conta.\n            // Recarrega para reconstruir a comanda com o total correto.\n            recarregarComandasMesa = true;\n            return;\n          }`;
  if (next.includes(oldExisting)) {
    const newExisting = `          if (estaDentroDeComanda && deixouDeEstarAberto) {\n            const cardMesa = existing.closest('[data-mesa-open-card]');\n            const mesaId = pedido.mesaId || cardMesa?.dataset?.mesaOpenCard || '';\n            if (mesaId) mesasParaAtualizar.add(String(mesaId));\n            return;\n          }`;
    next = replaceOnce(rel, next, oldExisting, newExisting, "remoção dinâmica da comanda");
  }

  const oldNewMesa = `        if (novoPedidoMesaAberto) {\n          // A estrutura da comanda contém todos os pedidos abertos da mesa.\n          // Um reload curto é mais seguro do que montar apenas o pedido novo e\n          // correr o risco de exibir um total parcial quando 2 celulares enviam\n          // ao mesmo tempo.\n          recarregarComandasMesa = true;\n        } else {`;
  if (next.includes(oldNewMesa)) {
    const newNewMesa = `        if (novoPedidoMesaAberto) {\n          if (pedido.mesaId) mesasParaAtualizar.add(String(pedido.mesaId));\n        } else {`;
    next = replaceOnce(rel, next, oldNewMesa, newNewMesa, "novo pedido de mesa sem reload");
  }

  const oldReload = `    if (recarregarComandasMesa) {\n      window.setTimeout(() => {\n        window.location.reload();\n      }, 350);\n    }`;
  if (next.includes(oldReload)) {
    const newReload = `    if (mesasParaAtualizar.size) {\n      await Promise.all(\n        [...mesasParaAtualizar].map(mesaId => atualizarComandaMesaSemReload(mesaId))\n      );\n    }`;
    next = replaceOnce(rel, next, oldReload, newReload, "substituição do reload por atualização parcial");
  }

  if (next !== original) write(rel, next, original);
}

function patchRouteCountTest() {
  const rel = "test/authAuthorizationAuditP0.test.js";
  const target = file(rel);
  if (!fs.existsSync(target)) return;
  const original = read(rel);
  if (original.includes("inventário possui 94 rotas")) return;

  const pattern = /test\("inventário possui (\d+) rotas e não contém método\/path duplicado", \(\) => \{\n  const inventory = routeInventory\(\);\n  assert\.equal\(inventory\.length, (\d+)\);/;
  const match = original.match(pattern);
  if (!match) {
    console.warn(`Aviso: ${rel} não tem o formato esperado; ajuste manualmente a contagem de rotas em +1 se esse teste existir.`);
    return;
  }
  const titleCount = Number(match[1]);
  const assertionCount = Number(match[2]);
  if (titleCount !== assertionCount) {
    throw new Error(`${rel}: título e assert de rotas já estão divergentes.`);
  }
  if (titleCount !== 93) {
    console.warn(`Aviso: ${rel} esperava ${titleCount} rotas. Como a suíte verde atual esperava 93 antes desta feature, não alterei automaticamente essa contagem.`);
    return;
  }
  const nextCount = 94;
  const replacement = `test("inventário possui ${nextCount} rotas e não contém método/path duplicado", () => {\n  const inventory = routeInventory();\n  assert.equal(inventory.length, ${nextCount});`;
  const next = original.replace(pattern, replacement);
  write(rel, next, original);
}

function addRegressionTest() {
  const rel = "test/mesaPedidoTrocaP0.test.js";
  const target = file(rel);
  if (fs.existsSync(target)) return;
  const content = `"use strict";\n\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst test = require("node:test");\n\nfunction source(rel) {\n  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");\n}\n\ntest("mesa possui rota pública protegida para remover somente pedido pendente", () => {\n  const routes = source("route.js");\n  const routeStart = routes.indexOf("/mesa/:token/pedidos/:pedidoId/remover");\n  assert.ok(routeStart >= 0);\n  const routeBlock = routes.slice(Math.max(0, routeStart - 50), routeStart + 450);\n  assert.match(routeBlock, /respostaPedidoSemCache/);\n  assert.match(routeBlock, /limitePedidoMesa/);\n  assert.match(routeBlock, /anonymousSameOriginProtection/);\n  assert.match(routeBlock, /admin\.removerPedidoMesa/);\n\n  const controller = source("src/controllers/adminRealController.js");\n  assert.match(controller, /exports\\.removerPedidoMesa = async/);\n  assert.match(controller, /pagamentoStatus:\\s*"pendente"/);\n  assert.match(controller, /status:\\s*\\{ \\$nin: \\["cancelado", "finalizado"\\] \\}/);\n  assert.match(controller, /estabelecimentoId:\\s*mesa\\.estabelecimentoId/);\n  assert.match(controller, /mesaId:\\s*mesa\\._id/);\n  assert.match(controller, /canal:\\s*"mesa"/);\n  assert.match(controller, /PrintJob\\.updateMany/);\n  assert.match(controller, /status:\\s*\\{ \\$in: \\["pendente", "aguardando_retry"\\] \\}/);\n});\n\ntest("cardápio permite remover e atualiza lista/total sem reload", () => {\n  const view = source("src/views/mesa-publica.ejs");\n  assert.match(view, /data-remove-mesa-order/);\n  assert.match(view, /Remover pedido/);\n  assert.match(view, /async function atualizarPedidosMesaSemReload/);\n  assert.match(view, /DOMParser/);\n  assert.match(view, /pedidos\\/\\$\\{encodeURIComponent\\(pedidoId\\)\\}\\/remover/);\n  assert.match(view, /await atualizarPedidosMesaSemReload\\(\\);/);\n});\n\ntest("painel atualiza a comanda da mesa por HTML parcial sem window.location.reload", () => {\n  const view = source("src/views/admin-real.ejs");\n  assert.match(view, /async function atualizarComandaMesaSemReload/);\n  assert.match(view, /const mesasParaAtualizar = new Set\\(\\)/);\n  assert.match(view, /atualizarComandaMesaSemReload\\(mesaId\\)/);\n\n  const start = view.indexOf("async function verificarNovosPedidos()");\n  const end = view.indexOf("if (menuPedidos)", start);\n  assert.ok(start >= 0 && end > start);\n  const polling = view.slice(start, end);\n  assert.doesNotMatch(polling, /window\\.location\\.reload\\(\\)/);\n});\n`;
  fs.writeFileSync(target, content, "utf8");
  changed.push(rel);
}

try {
  patchRoute();
  patchController();
  patchMesaView();
  patchAdminView();
  patchRouteCountTest();
  addRegressionTest();

  console.log("\nAlteração aplicada com sucesso.");
  if (changed.length) {
    console.log("Arquivos alterados/criados:");
    changed.forEach(item => console.log(` - ${item}`));
  } else {
    console.log("A alteração já estava aplicada; nenhum arquivo precisou mudar.");
  }
  console.log("\nBackups dos arquivos substituídos usam o sufixo .bak-troca-mesa.");
  console.log("Teste focado sugerido:");
  console.log("NODE_ENV=test node --test test/mesaPedidoTrocaP0.test.js test/authAuthorizationAuditP0.test.js");
} catch (error) {
  console.error(`\nERRO: ${error.message}`);
  process.exitCode = 1;
}
