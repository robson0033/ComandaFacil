const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('admin adia relatórios, arquivados e WhatsApp até a seção ser solicitada', () => {
  const src = read('src/controllers/adminRealController.js');

  assert.match(src, /const carregarPedidosArquivados\s*=\s*[\s\S]*secaoSolicitada === "pedidos-arquivados"/);
  assert.match(src, /const carregarRelatorios\s*=\s*[\s\S]*secaoSolicitada === "relatorios"/);
  assert.match(src, /const carregarWhatsAppPainel\s*=\s*[\s\S]*secaoSolicitada === "whatsapp"/);

  assert.match(src, /carregarPedidosArquivados\s*\?\s*Pedido\.find\(/);
  assert.match(src, /\]\s*=\s*carregarRelatorios\s*\?\s*await Promise\.all\(/);
  assert.match(src, /const whatsappConfiguracao = carregarWhatsAppPainel/);
  assert.match(src, /const whatsappConversas = carregarWhatsAppPainel/);
});

test('filtros de relatório continuam carregando dados mesmo sem section explícita', () => {
  const src = read('src/controllers/adminRealController.js');
  for (const nome of ['filtro', 'dataInicio', 'dataFim', 'canal']) {
    assert.match(src, new RegExp(`temQuery\\("${nome}"\\)`));
  }
});

test('painel recarrega apenas se uma seção sob demanda ainda não foi carregada', () => {
  const view = read('src/views/admin-real.ejs');

  assert.match(view, /secoesSobDemandaCarregadas/);
  assert.match(view, /secaoSobDemandaPrecisaCarregar/);
  assert.match(view, /urlSecaoSobDemanda/);
  assert.match(view, /window\.location\.assign\(urlSecaoSobDemanda\(pageName\)\)/);
  assert.match(view, /window\.location\.replace\(urlSecaoSobDemanda\(initialPage\)\)/);
});

test('atalhos de relatórios e arquivados apontam para carregamento sob demanda', () => {
  const view = read('src/views/admin-real.ejs');
  assert.match(view, /\/admin\?section=relatorios#relatorios/);
  assert.match(view, /\/admin\?section=pedidos-arquivados#pedidos-arquivados/);
});

test('troca de seção lazy não carrega filtros antigos de outras telas', () => {
  const src = read('src/controllers/adminRealController.js');
  const view = read('src/views/admin-real.ejs');
  assert.match(src, /secaoSolicitada === "pedidos" \|\|[\s\S]*?!secaoSolicitada &&/);
  assert.match(src, /secaoSolicitada === "relatorios" \|\|[\s\S]*?!secaoSolicitada &&/);
  assert.match(view, /new URL\('\/admin', window\.location\.origin\)/);
  assert.match(view, /new URLSearchParams\(window\.location\.search\)\.get\('section'\)/);
});
