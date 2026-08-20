const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('funcionários são consultados somente quando a seção é solicitada', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /const carregarFuncionariosPainel\s*=\s*[\s\S]*podeFuncionarios && secaoSolicitada === "funcionarios"/);
  assert.match(src, /carregarFuncionariosPainel\s*\?\s*Funcionario\.find\(/);
  assert.match(src, /funcionarios:\s*\n\s*carregarFuncionariosPainel\s*\? funcionarios/);
});

test('configurações completas, cidades e CPF só carregam ao abrir Configurações', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /const carregarConfiguracoesPainel\s*=\s*[\s\S]*secaoSolicitada === "configuracoes"/);
  assert.match(src, /const precisaConfiguracaoCompleta =\s*\n\s*podeConfiguracoes && carregarConfiguracoesPainel/);
  assert.match(src, /completa: precisaConfiguracaoCompleta/);
  assert.match(src, /podeConfiguracoes && carregarConfiguracoesPainel\s*\? CidadeEntrega\.find\(/);
  assert.match(src, /const donoPainel\s*=\s*\n\s*podeConfiguracoes && carregarConfiguracoesPainel/);
});

test('configuração mínima continua trazendo nome, foto, slug e impressoras necessárias', () => {
  const src = read('src/controllers/adminRealController.js');
  assert.match(src, /"nomeEstabelecimento"/);
  assert.match(src, /"fotoPerfil"/);
  assert.match(src, /"slug"/);
  assert.match(src, /"impressoras"/);
  assert.match(src, /"impressaoAutomatica"/);
  assert.match(src, /incluirImpressoras:\s*\n\s*podeImprimirPedidos \|\|\s*\n\s*podeConfigurarImpressoras/);
});

test('view recarrega Funcionários e Configurações sob demanda', () => {
  const view = read('src/views/admin-real.ejs');
  assert.match(view, /\/admin\?section=funcionarios#funcionarios/);
  assert.match(view, /data-lazy-section="funcionarios"/);
  assert.match(view, /pode\('funcionarios'\) && lazySectionsPainel\.funcionarios/);
  assert.match(view, /\/admin\?section=configuracoes#configuracoes/);
  assert.match(view, /data-lazy-section="configuracoes"/);
  assert.match(view, /lazySectionsPainel\.configuracoes/);
});

test('estado lazy preserva etapas anteriores e inclui funcionários/configurações', () => {
  const src = read('src/controllers/adminRealController.js');
  for (const pattern of [
    /"pedidos-arquivados": Boolean\(carregarPedidosArquivados\)/,
    /relatorios: Boolean\(carregarRelatorios\)/,
    /whatsapp: Boolean\(carregarWhatsAppPainel\)/,
    /estoque: Boolean\(carregarEstoquePainel/,
    /catalogo: Boolean\(carregarCatalogoPainel\)/,
    /funcionarios: Boolean\(carregarFuncionariosPainel\)/,
    /configuracoes: Boolean\(carregarConfiguracoesPainel\)/,
  ]) assert.match(src, pattern);
});
