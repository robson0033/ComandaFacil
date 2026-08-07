const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('catálogo não solicita e-mail e coleta endereço estruturado', () => {
  const view = read('src/views/catalogo-publico.ejs');
  assert.doesNotMatch(view, /id="emailPix"|name="emailPix"/);
  for (const field of ['ruaEntrega', 'numeroEntrega', 'bairroEntrega', 'referenciaEntrega']) {
    assert.match(view, new RegExp(`name="${field}"`));
  }
});

test('criação do pedido não exige e-mail do cliente', () => {
  const controller = read('src/controllers/adminRealController.js');
  assert.doesNotMatch(controller, /Informe um e-mail válido para gerar o pagamento Pix/);
  assert.match(controller, /ruaEntrega: canal === "delivery"/);
  assert.match(controller, /numeroEntrega: canal === "delivery"/);
  assert.match(controller, /bairroEntrega: canal === "delivery"/);
});

test('Pix usa e-mail técnico do servidor e mantém application_fee', () => {
  const controller = read('src/controllers/pagamentoController.js');
  assert.match(controller, /MERCADO_PAGO_PIX_PAYER_EMAIL/);
  assert.match(controller, /const payerEmail = getPixTechnicalPayerEmail\(\)/);
  assert.match(controller, /application_fee: centsToDecimal\(attempt\.platformFeeCents\)/);
  assert.match(controller, /payer: \{ email: payerEmail/);
});

test('configurações exige aceite da taxa antes do OAuth', () => {
  const view = read('src/views/admin-real.ejs');
  assert.match(view, /data-mercado-pago-connect/);
  assert.match(view, /platformFeeTermsCheckbox/);
  assert.match(view, /Continuar e conectar/);
  assert.match(view, /taxa de serviço de 1,5%/i);
  assert.match(view, /disabled>Continuar e conectar/);
});

test('cards de pedido não mostram e-mail do cliente', () => {
  const view = read('src/views/admin-real.ejs');
  const orderStart = view.indexOf('<article\n          class="order-card"');
  const employeeStart = view.indexOf('<div class="employee-details">');
  const orderSection = view.slice(orderStart, employeeStart > orderStart ? employeeStart : orderStart + 12000);
  assert.doesNotMatch(orderSection, /<strong>E-mail:<\/strong>/);
  assert.match(orderSection, /<strong>Rua:<\/strong>/);
  assert.match(orderSection, /<strong>Bairro:<\/strong>/);
  assert.match(orderSection, /<strong>Referência:<\/strong>/);
});
