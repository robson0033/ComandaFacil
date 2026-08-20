const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('estoque e catálogo administrativo são carregados somente quando solicitados', () => {
  const src = read('src/controllers/adminRealController.js');

  assert.match(src, /const carregarEstoquePainel\s*=\s*[\s\S]*secaoSolicitada === "estoque"[\s\S]*secaoSolicitada === "catalogo"/);
  assert.match(src, /const carregarCatalogoPainel\s*=\s*[\s\S]*secaoSolicitada === "catalogo"/);
  assert.match(src, /carregarEstoquePainel\s*\?\s*Estoque\.find\(/);
  assert.match(src, /carregarCatalogoPainel\s*\?\s*Produto\.find\(/);
});

test('catálogo continua recebendo estoque para ficha técnica quando permitido', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /podeEstoque && \(secaoSolicitada === "estoque" \|\| secaoSolicitada === "catalogo"\)/);
  assert.match(src, /ingredientesDesativadosReferenciados:\s*\n\s*carregarCatalogoPainel \? ingredientesDesativadosReferenciados : \[\]/);
});

test('view não renderiza blocos pesados de estoque e catálogo antes do carregamento', () => {
  const view = read('src/views/admin-real.ejs');
  assert.match(view, /pode\('estoque'\) && lazySectionsPainel\.estoque/);
  assert.match(view, /pode\('catalogo'\) && lazySectionsPainel\.catalogo/);
  assert.match(view, /\/admin\?section=estoque#estoque/);
  assert.match(view, /\/admin\?section=catalogo#catalogo/);
  assert.match(view, /data-lazy-section="estoque"/);
  assert.match(view, /data-lazy-section="catalogo"/);
});

test('estado lazy preserva seções anteriores e inclui estoque e catálogo', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /"pedidos-arquivados": Boolean\(carregarPedidosArquivados\)/);
  assert.match(src, /relatorios: Boolean\(carregarRelatorios\)/);
  assert.match(src, /whatsapp: Boolean\(carregarWhatsAppPainel\)/);
  assert.match(src, /estoque: Boolean\(carregarEstoquePainel/);
  assert.match(src, /catalogo: Boolean\(carregarCatalogoPainel\)/);
});
