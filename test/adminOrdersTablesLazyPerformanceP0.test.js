const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('Pedidos e Mesas carregam listas completas somente ao abrir a seção', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /const carregarPedidosPainel\s*=\s*[\s\S]*secaoSolicitada === "pedidos"/);
  assert.match(src, /const carregarMesasPainel\s*=\s*[\s\S]*secaoSolicitada === "mesas"/);
  assert.match(src, /carregarPedidosPainel\s*\? Pedido\.find\(\{/);
  assert.match(src, /carregarMesasPainel\s*\? Mesa\.find\(\{/);
});

test('Dashboard usa consulta própria limitada e contagens de mesas', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /Pedido\.find\(filtroDashboardLista\)[\s\S]*\.limit\(100\)/);
  assert.match(src, /Mesa\.countDocuments\(\{ estabelecimentoId: idEstabelecimento \}\)/);
  assert.match(src, /status: \{ \$in: \["ocupada", "aguardando_pagamento"\] \}/);
  assert.match(src, /pedidosLista:\s*\n\s*pedidosDashboardLista/);
});

test('aba Mesas busca apenas campos necessários para calcular a conta', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /carregarMesasPainel\s*\? Pedido\.find\(filtroPedidosMesaAbertos\)[\s\S]*?\.select\("mesaId total pagamentoStatus status"\)/);
  assert.match(src, /pedidosMesaAbertosContas\s*\n\s*\.filter/);
});

test('Pedidos paraleliza a leitura da comanda aberta e limita os campos transportados', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /const CAMPOS_PEDIDO_PAINEL = \[/);
  assert.match(src, /carregarPedidosPainel\s*\? Pedido\.find\(\{[\s\S]*?\.select\(CAMPOS_PEDIDO_PAINEL\)/);
  assert.match(src, /pedidosMesaAbertosPainel,[\s\S]*?pedidosMesaAbertosContas,[\s\S]*?Promise\.all\(\[/);
  assert.match(src, /carregarPedidosPainel\s*\? Pedido\.find\(filtroPedidosMesaAbertos\)[\s\S]*?\.select\(CAMPOS_PEDIDO_PAINEL\)/);
  assert.doesNotMatch(src, /const pedidosMesaAbertosPainel = carregarPedidosPainel\s*\? await Pedido\.find/);
  assert.match(src, /updatedAt: \{[\s\S]*?\$gt: dataInicial[\s\S]*?\.select\(CAMPOS_PEDIDO_PAINEL\)/);
});

test('Dashboard só consulta Mongo quando a própria seção é carregada', () => {
  const src = read('src/controllers/adminRealController.js');
  const view = read('src/views/admin-real.ejs');
  assert.match(src, /const carregarDashboardPainel =\s*podeDashboard/);
  assert.match(src, /carregarDashboardPainel\s*\? Pedido\.find\(filtroDashboardLista\)/);
  assert.match(src, /carregarDashboardPainel\s*\? await adminServerTiming\.measureAsync\([\s\S]*?"dashboard"/);
  assert.match(src, /dashboard: Boolean\(carregarDashboardPainel\)/);
  assert.match(view, /lazySectionsPainel\.dashboard \? '#dashboard' : '\/admin\?section=dashboard#dashboard'/);
});

test('view trata Pedidos e Mesas como seções sob demanda', () => {
  const view = read('src/views/admin-real.ejs');
  assert.match(view, /\/admin\?section=pedidos#pedidos/);
  assert.match(view, /data-lazy-section="pedidos"/);
  assert.match(view, /pode\('pedidos'\) && lazySectionsPainel\.pedidos/);
  assert.match(view, /\/admin\?section=mesas#mesas/);
  assert.match(view, /data-lazy-section="mesas"/);
  assert.match(view, /pode\('mesas'\) && lazySectionsPainel\.mesas/);
});

test('filtros de Pedidos preservam section=pedidos e realtime continua ativo', () => {
  const view = read('src/views/admin-real.ejs');
  assert.match(view, /name="section" value="pedidos"/);
  assert.match(view, /section=pedidos&pedidoPeriodo=hoje/);
  assert.match(view, /new EventSource\(\s*'\/admin\/api\/pedidos\/stream'/);
  assert.match(view, /\}, 60_000\);/);
});

test('estado lazy inclui Pedidos e Mesas sem remover etapas anteriores', () => {
  const src = read('src/controllers/adminRealController.js');
  for (const pattern of [
    /"pedidos-arquivados": Boolean\(carregarPedidosArquivados\)/,
    /relatorios: Boolean\(carregarRelatorios\)/,
    /estoque: Boolean\(carregarEstoquePainel/,
    /catalogo: Boolean\(carregarCatalogoPainel\)/,
    /funcionarios: Boolean\(carregarFuncionariosPainel\)/,
    /configuracoes: Boolean\(carregarConfiguracoesPainel\)/,
    /pedidos: Boolean\(carregarPedidosPainel\)/,
    /mesas: Boolean\(carregarMesasPainel\)/,
  ]) assert.match(src, pattern);
});
