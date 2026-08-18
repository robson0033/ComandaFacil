"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const patchRoot = path.join(__dirname, "patch-files");
const suffix = ".bak-correcao-item-pix";

const files = [
  "src/models/painelModels.js",
  "src/controllers/adminRealController.js",
  "src/views/mesa-publica.ejs",
  "src/views/admin-real.ejs",
  "test/mesaPedidoTrocaP0.test.js",
  "test/mesaPixPagamentoP0.test.js",
];

function fail(message) {
  console.error(`\nERRO: ${message}`);
  process.exitCode = 1;
}

for (const rel of files) {
  const source = path.join(patchRoot, rel);
  if (!fs.existsSync(source)) {
    fail(`Arquivo do patch ausente: ${rel}`);
    return;
  }
}

for (const rel of files) {
  const target = path.join(root, rel);
  if (!fs.existsSync(target)) {
    fail(`Arquivo do projeto ausente: ${rel}`);
    return;
  }
}

const changed = [];
try {
  for (const rel of files) {
    const source = path.join(patchRoot, rel);
    const target = path.join(root, rel);
    const backup = `${target}${suffix}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
    fs.copyFileSync(source, target);
    changed.push(rel);
  }
} catch (error) {
  console.error("\nFalha durante a aplicação. Restaurando arquivos já alterados...");
  for (const rel of changed.reverse()) {
    const target = path.join(root, rel);
    const backup = `${target}${suffix}`;
    if (fs.existsSync(backup)) fs.copyFileSync(backup, target);
  }
  throw error;
}

console.log("\nCorreção aplicada com sucesso.");
console.log("\nO que mudou:");
console.log(" - Modal do Pix agora tem X e botão Fechar sem cancelar o Pix.");
console.log(" - Solicitação de troca/remoção agora é por item, não pelo pedido inteiro.");
console.log(" - Aprovação remove somente o item escolhido e recalcula o total da conta.");
console.log(" - Os outros itens do mesmo pedido permanecem ativos.");
console.log(`\nBackups usam o sufixo ${suffix}.`);
console.log("\nRode:");
console.log("NODE_ENV=test node --test test/mesaPedidoTrocaP0.test.js test/mesaPixPagamentoP0.test.js");
