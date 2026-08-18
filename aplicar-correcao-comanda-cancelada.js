"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const BACKUP_SUFFIX = ".bak-comanda-cancelada";

function file(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  const p = file(rel);
  if (!fs.existsSync(p)) throw new Error(`Arquivo não encontrado: ${rel}`);
  return fs.readFileSync(p, "utf8");
}

function backup(rel) {
  const src = file(rel);
  const dst = `${src}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
}

function write(rel, content) {
  backup(rel);
  fs.writeFileSync(file(rel), content, "utf8");
  console.log(`✓ ${rel}`);
}

function replaceOnce(content, before, after, rel, label) {
  if (content.includes(after)) {
    console.log(`• ${rel}: ${label} já aplicado`);
    return content;
  }
  const count = content.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${rel}: não encontrei exatamente 1 ocorrência para ${label} (encontrei ${count}). Nenhum arquivo adicional deve ser alterado antes de conferir o código atual.`);
  }
  return content.replace(before, after);
}

function patchController() {
  const rel = "src/controllers/adminRealController.js";
  let content = read(rel);
  const before = `    const idsPedidosAgrupadosMesa = new Set(\n      comandasMesaAbertasPainel.flatMap(comanda => comanda.pedidoIds || []),\n    );\n\n    // Pedidos de uma mesa com conta aberta deixam de virar vários cards.\n    // Eles continuam existindo individualmente no banco e aparecem dentro do\n    // único card da comanda da mesa. Pedidos já pagos/fechados seguem históricos.\n    const listaPedidosPainel = listaPedidos.filter(\n      pedido => !idsPedidosAgrupadosMesa.has(String(pedido._id)),\n    );\n`;
  const after = `    const idsPedidosAgrupadosMesa = new Set(\n      comandasMesaAbertasPainel.flatMap(comanda => comanda.pedidoIds || []),\n    );\n    const mesasComComandaAberta = new Set(\n      comandasMesaAbertasPainel.map(comanda => String(comanda.mesaId || \"\")),\n    );\n\n    // Pedidos de uma mesa com conta aberta deixam de virar vários cards.\n    // Se uma troca/remoção foi aprovada e ainda restam pedidos na mesma comanda,\n    // o item cancelado simplesmente sai da comanda e não vira um card separado.\n    // Se ele era o último pedido aberto da mesa, o cancelado continua visível\n    // como histórico operacional.\n    const listaPedidosPainel = listaPedidos.filter(pedido => {\n      if (idsPedidosAgrupadosMesa.has(String(pedido._id))) return false;\n\n      const mesaIdPedido = pedido?.mesaId?._id\n        ? String(pedido.mesaId._id)\n        : String(pedido?.mesaId || \"\");\n      const canceladoPorTrocaComMesaAindaAberta =\n        String(pedido?.canal || \"\") === \"mesa\"\n        && String(pedido?.remocaoSolicitacaoStatus || \"\") === \"aprovada\"\n        && (\n          String(pedido?.status || \"\") === \"cancelado\"\n          || String(pedido?.pagamentoStatus || \"\") === \"cancelado\"\n        )\n        && mesasComComandaAberta.has(mesaIdPedido);\n\n      return !canceladoPorTrocaComMesaAindaAberta;\n    });\n`;
  content = replaceOnce(content, before, after, rel, "ocultar cancelado de troca enquanto a mesa segue com comanda aberta");
  write(rel, content);
}

function patchView() {
  const rel = "src/views/admin-real.ejs";
  let content = read(rel);
  const before = `        const novoPedidoMesaAberto =\n          pedido.canal === 'mesa' &&\n          Boolean(pedido.mesaId) &&\n          pedido.pagamentoStatus === 'pendente' &&\n          pedido.status !== 'cancelado';\n\n        if (novoPedidoMesaAberto) {\n          if (pedido.mesaId) mesasParaAtualizar.add(String(pedido.mesaId));\n        } else {\n          if (ordersEmptyState) {\n            ordersEmptyState.remove();\n          }\n\n          if (ordersGrid) {\n            const card = criarCardPedido(pedido);\n            ordersGrid.prepend(card);\n            applyOrdersFilters();\n          }\n        }\n`;
  const after = `        const novoPedidoMesaAberto =\n          pedido.canal === 'mesa' &&\n          Boolean(pedido.mesaId) &&\n          pedido.pagamentoStatus === 'pendente' &&\n          pedido.status !== 'cancelado';\n\n        const canceladoPorTrocaComComandaAindaAberta =\n          pedido.canal === 'mesa' &&\n          Boolean(pedido.mesaId) &&\n          pedido.remocaoSolicitacaoStatus === 'aprovada' &&\n          (\n            pedido.status === 'cancelado' ||\n            pedido.pagamentoStatus === 'cancelado'\n          ) &&\n          Boolean(document.querySelector(\n            \`[data-mesa-open-card=\"\${CSS.escape(String(pedido.mesaId))}\"]\`\n          ));\n\n        if (novoPedidoMesaAberto) {\n          if (pedido.mesaId) mesasParaAtualizar.add(String(pedido.mesaId));\n        } else if (canceladoPorTrocaComComandaAindaAberta) {\n          // O item cancelado por troca já saiu da comanda aberta.\n          // Não crie um segundo card \"cancelado\" enquanto a mesa ainda\n          // possuir outros pedidos pendentes.\n          mesasParaAtualizar.add(String(pedido.mesaId));\n        } else {\n          if (ordersEmptyState) {\n            ordersEmptyState.remove();\n          }\n\n          if (ordersGrid) {\n            const card = criarCardPedido(pedido);\n            ordersGrid.prepend(card);\n            applyOrdersFilters();\n          }\n        }\n`;
  content = replaceOnce(content, before, after, rel, "não recriar card cancelado pelo polling em tempo real");
  write(rel, content);
}

function patchTest() {
  const rel = "test/mesaPedidoTrocaP0.test.js";
  let content = read(rel);
  const marker = `test("pedido cancelado por troca não vira card separado enquanto a mesa ainda tem comanda aberta"`;
  if (content.includes(marker)) {
    console.log(`• ${rel}: testes novos já presentes`);
    return write(rel, content);
  }
  const addition = `\n\ntest("pedido cancelado por troca não vira card separado enquanto a mesa ainda tem comanda aberta", () => {\n  const controller = source("src/controllers/adminRealController.js");\n  assert.match(controller, /const mesasComComandaAberta = new Set/);\n  assert.match(controller, /remocaoSolicitacaoStatus \\|\\| \"\"\\) === \"aprovada\"/);\n  assert.match(controller, /mesasComComandaAberta\\.has\\(mesaIdPedido\\)/);\n  assert.match(controller, /return !canceladoPorTrocaComMesaAindaAberta/);\n});\n\ntest("tempo real não recria card cancelado quando restam pedidos na mesma comanda", () => {\n  const view = source("src/views/admin-real.ejs");\n  const start = view.indexOf("const canceladoPorTrocaComComandaAindaAberta");\n  assert.ok(start >= 0);\n  const block = view.slice(start, start + 1800);\n  assert.match(block, /remocaoSolicitacaoStatus === 'aprovada'/);\n  assert.match(block, /data-mesa-open-card/);\n  assert.match(block, /else if \\(canceladoPorTrocaComComandaAindaAberta\\)/);\n  assert.match(block, /mesasParaAtualizar\\.add\\(String\\(pedido\\.mesaId\\)\\)/);\n  assert.ok(block.indexOf("canceladoPorTrocaComComandaAindaAberta") < block.indexOf("criarCardPedido(pedido)"));\n});\n`;
  content = content.trimEnd() + addition;
  write(rel, content);
}

try {
  patchController();
  patchView();
  patchTest();
  console.log("\nCorreção aplicada com sucesso.");
  console.log("Regra: se ainda houver pedido pendente na mesa, o cancelado por troca some da comanda e NÃO vira outro card.");
  console.log("Se o pedido cancelado era o último pedido aberto da mesa, ele continua visível como cancelado.");
  console.log("\nTeste focado:");
  console.log("NODE_ENV=test node --test test/mesaPedidoTrocaP0.test.js");
} catch (error) {
  console.error(`\nERRO: ${error.message}`);
  process.exitCode = 1;
}
