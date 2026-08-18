"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const BACKUP_SUFFIX = ".bak-reenvio-troca-mesa";
const files = new Map();

const TARGETS = [
  "route.js",
  "src/controllers/adminRealController.js",
  "src/views/mesa-publica.ejs",
  "src/views/admin-real.ejs",
  "test/mesaPedidoTrocaP0.test.js",
];

function full(rel) { return path.join(ROOT, rel); }
function load(rel) {
  if (files.has(rel)) return files.get(rel);
  if (!fs.existsSync(full(rel))) throw new Error(`Arquivo não encontrado: ${rel}`);
  const value = fs.readFileSync(full(rel), "utf8");
  files.set(rel, value);
  return value;
}
function set(rel, value) { files.set(rel, value); }
function replaceOnce(rel, source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${rel}: âncora inválida em ${label}; esperado 1, encontrado ${count}. Nada foi gravado.`);
  return source.replace(search, replacement);
}

function patchRoute() {
  const rel = "route.js";
  let source = load(rel);
  const oldBlock = `route.post(\n  '/mesa/:token/pedidos/:pedidoId/remover',\n  respostaPedidoSemCache,\n  limitePedidoMesa,\n  anonymousSameOriginProtection,\n  admin.solicitarRemocaoPedidoMesa\n);`;
  const newBlock = `route.post(\n  '/mesa/:token/pedidos/:pedidoId/remover',\n  respostaPedidoSemCache,\n  limitePedidoMesa,\n  limitePedidoMesaHora,\n  anonymousSameOriginProtection,\n  admin.solicitarRemocaoPedidoMesa\n);`;
  if (source.includes(oldBlock)) source = replaceOnce(rel, source, oldBlock, newBlock, "limite horário da solicitação");
  else if (!source.includes("limitePedidoMesaHora,\n  anonymousSameOriginProtection,\n  admin.solicitarRemocaoPedidoMesa")) {
    throw new Error(`${rel}: rota de solicitação da troca não encontrada. Aplique primeiro o pacote de aprovação de troca.`);
  }
  set(rel, source);
}

function patchController() {
  const rel = "src/controllers/adminRealController.js";
  let source = load(rel);

  const oldOr = `        $or: [\n          { remocaoSolicitacaoStatus: { $exists: false } },\n          { remocaoSolicitacaoStatus: "nenhuma" },\n        ],`;
  const newOr = `        $or: [\n          { remocaoSolicitacaoStatus: { $exists: false } },\n          { remocaoSolicitacaoStatus: "nenhuma" },\n          { remocaoSolicitacaoStatus: "recusada" },\n        ],`;
  if (source.includes(oldOr)) source = replaceOnce(rel, source, oldOr, newOr, "permitir nova solicitação após recusa");
  else if (!source.includes('{ remocaoSolicitacaoStatus: "recusada" },')) {
    throw new Error(`${rel}: filtro da solicitação não encontrado.`);
  }

  const oldRefusedFallback = `      if (String(existente.remocaoSolicitacaoStatus || "") === "recusada") {\n        return res.status(409).json({\n          success: false,\n          code: "SOLICITACAO_JA_ANALISADA",\n          message: "Esta solicitação já foi analisada. Fale com um atendente para pedir uma nova alteração.",\n        });\n      }\n\n`;
  if (source.includes(oldRefusedFallback)) {
    source = replaceOnce(rel, source, oldRefusedFallback, "", "remover bloqueio antigo de nova solicitação");
  }

  const oldNoPedido = `    if (!pedido) {\n      return res.status(409).json({\n        success: false,\n        code: "SOLICITACAO_NAO_ELEGIVEL",\n        message: "A solicitação já foi analisada ou não existe mais.",\n      });\n    }`;
  const newNoPedido = `    if (!pedido) {\n      const existente = await Pedido.findOne({\n        _id: pedidoId,\n        estabelecimentoId: idEstabelecimento,\n        canal: "mesa",\n        excluido: { $ne: true },\n      })\n        .select("_id mesaId remocaoSolicitacaoStatus")\n        .lean();\n\n      if (String(existente?.remocaoSolicitacaoStatus || "") === "recusada") {\n        return res.json({\n          success: true,\n          pedidoId: String(existente._id),\n          mesaId: String(existente.mesaId || ""),\n          idempotent: true,\n          message: "A solicitação já estava recusada. O pedido continua na mesa.",\n        });\n      }\n\n      return res.status(409).json({\n        success: false,\n        code: "SOLICITACAO_NAO_ELEGIVEL",\n        message: "A solicitação já foi analisada ou não existe mais.",\n      });\n    }`;

  // Existem dois blocos semelhantes (aprovar e recusar). Altere somente o que fica dentro de recusarRemocaoPedidoMesa.
  const recusarStart = source.indexOf("exports.recusarRemocaoPedidoMesa = async (req, res) => {");
  if (recusarStart < 0) throw new Error(`${rel}: controller recusarRemocaoPedidoMesa não encontrado.`);
  const recusarEnd = source.indexOf("\n\n\nexports.avaliarPedidoMesa", recusarStart);
  if (recusarEnd < 0) throw new Error(`${rel}: final do controller de recusa não encontrado.`);
  const before = source.slice(0, recusarStart);
  let recusar = source.slice(recusarStart, recusarEnd);
  const after = source.slice(recusarEnd);
  if (recusar.includes(oldNoPedido)) recusar = replaceOnce(rel, recusar, oldNoPedido, newNoPedido, "recusa idempotente");
  else if (!recusar.includes("idempotent: true")) throw new Error(`${rel}: bloco de recusa idempotente não pôde ser localizado.`);
  source = before + recusar + after;

  set(rel, source);
}

function patchMesaView() {
  const rel = "src/views/mesa-publica.ejs";
  let source = load(rel);

  const oldRefused = `              <% } else if (String(item.remocaoSolicitacaoStatus || 'nenhuma') === 'recusada') { %>\n                <span style="font-size:11px;font-weight:900;color:#8a3b2f;text-align:right;">Solicitação recusada</span>\n              <% } else { %>`;
  const newRefused = `              <% } else if (String(item.remocaoSolicitacaoStatus || 'nenhuma') === 'recusada') { %>\n                <span style="font-size:11px;font-weight:900;color:#8a3b2f;text-align:right;">Solicitação recusada</span>\n                <button\n                  type="button"\n                  class="remove-pending-order"\n                  data-remove-mesa-order="<%= item.pedidoId %>"\n                >\n                  Solicitar novamente\n                </button>\n              <% } else { %>`;
  if (source.includes(oldRefused)) source = replaceOnce(rel, source, oldRefused, newRefused, "botão para refazer solicitação");
  else if (!source.includes("Solicitar novamente")) throw new Error(`${rel}: estado recusado da mesa não encontrado.`);

  set(rel, source);
}

function patchAdminView() {
  const rel = "src/views/admin-real.ejs";
  let source = load(rel);

  const listenerAnchor = `document.addEventListener('click', async event => {\n  const button = event.target.closest('[data-removal-decision]');`;
  if (!source.includes("function mostrarFeedbackTrocaMesa(message)")) {
    const helper = `function mostrarFeedbackTrocaMesa(message) {\n  const container = document.querySelector('#orderToastContainer');\n  if (!container) return;\n\n  const toast = document.createElement('div');\n  toast.className = 'order-toast';\n\n  const icon = document.createElement('div');\n  icon.className = 'order-toast-icon';\n  icon.textContent = '✓';\n\n  const text = document.createElement('div');\n  text.className = 'order-toast-text';\n\n  const title = document.createElement('strong');\n  title.textContent = 'Solicitação atualizada';\n\n  const detail = document.createElement('span');\n  detail.textContent = String(message || 'Solicitação analisada.');\n\n  text.append(title, detail);\n  toast.append(icon, text);\n  container.appendChild(toast);\n  window.setTimeout(() => toast.remove(), 4500);\n}\n\n${listenerAnchor}`;
    source = replaceOnce(rel, source, listenerAnchor, helper, "feedback seguro sem showToast");
  }

  source = source.replace(
    `    showToast(result.message || 'Solicitação analisada.');`,
    `    mostrarFeedbackTrocaMesa(result.message || 'Solicitação analisada.');`,
  );

  set(rel, source);
}

function patchTests() {
  const rel = "test/mesaPedidoTrocaP0.test.js";
  let source = load(rel);
  if (source.includes("cliente pode refazer solicitação depois de uma recusa")) return set(rel, source);

  source += `\n\ntest("cliente pode refazer solicitação depois de uma recusa enquanto o pedido segue pendente", () => {\n  const controller = source("src/controllers/adminRealController.js");\n  const start = controller.indexOf("exports.solicitarRemocaoPedidoMesa = async");\n  const end = controller.indexOf("exports.aprovarRemocaoPedidoMesa = async", start);\n  const block = controller.slice(start, end);\n  assert.match(block, /\\{ remocaoSolicitacaoStatus: "recusada" \\}/);\n  assert.match(block, /remocaoSolicitacaoStatus: "pendente"/);\n  assert.match(block, /remocaoDecididaEm: null/);\n  assert.match(block, /remocaoDecididaPor: null/);\n  assert.doesNotMatch(block, /SOLICITACAO_JA_ANALISADA/);\n\n  const view = source("src/views/mesa-publica.ejs");\n  assert.match(view, /Solicitação recusada/);\n  assert.match(view, /Solicitar novamente/);\n});\n\ntest("recusar duas vezes é idempotente e não quebra o painel", () => {\n  const controller = source("src/controllers/adminRealController.js");\n  const start = controller.indexOf("exports.recusarRemocaoPedidoMesa = async");\n  const end = controller.indexOf("exports.avaliarPedidoMesa = async", start);\n  const block = controller.slice(start, end);\n  assert.match(block, /remocaoSolicitacaoStatus \\|\\| ""\\) === "recusada"/);\n  assert.match(block, /idempotent: true/);\n  assert.match(block, /A solicitação já estava recusada/);\n});\n\ntest("painel usa feedback próprio na decisão e não depende de showToast", () => {\n  const view = source("src/views/admin-real.ejs");\n  const start = view.indexOf("function mostrarFeedbackTrocaMesa(message)");\n  const end = view.indexOf("async function verificarNovosPedidos", start);\n  assert.ok(start >= 0 && end > start);\n  const block = view.slice(start, end);\n  assert.match(block, /mostrarFeedbackTrocaMesa\\(result\\.message/);\n  assert.doesNotMatch(block, /showToast\\(/);\n});\n`;
  set(rel, source);
}

function writeAll() {
  const backups = [];
  for (const rel of TARGETS) {
    const current = fs.readFileSync(full(rel), "utf8");
    const next = files.get(rel) ?? current;
    if (next === current) continue;
    const backup = `${full(rel)}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(full(rel), backup);
      backups.push(path.relative(ROOT, backup));
    }
  }
  for (const rel of TARGETS) {
    const current = fs.readFileSync(full(rel), "utf8");
    const next = files.get(rel) ?? current;
    if (next !== current) fs.writeFileSync(full(rel), next, "utf8");
  }
  return backups;
}

try {
  for (const rel of TARGETS) load(rel);
  patchRoute();
  patchController();
  patchMesaView();
  patchAdminView();
  patchTests();
  const backups = writeAll();
  console.log("✅ Correção aplicada com sucesso.");
  console.log("- cliente pode solicitar novamente após recusa, se o pedido continuar pendente");
  console.log("- recusa repetida é idempotente");
  console.log("- painel não depende mais de showToast nesta ação");
  console.log("- rota pública também usa limite horário contra abuso");
  if (backups.length) console.log(`Backups criados: ${backups.length}`);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
}
