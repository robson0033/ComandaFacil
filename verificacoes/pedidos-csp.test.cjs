'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = fs.readFileSync(path.join(__dirname, '../src/views/admin-real.ejs'), 'utf8');

function extract(source) {
  const cardStart = source.indexOf('function criarCardPedido(');
  const cardEnd = source.indexOf('async function verificarPrintAgent()', cardStart);
  const upload = source.indexOf("const uploadInput = form.querySelector?.('[data-image-upload]');");
  const listenerStart = source.lastIndexOf("document.addEventListener('submit', async event => {", upload);
  const listenerEnd = source.indexOf("\n    document.addEventListener('click', async event => {", upload);
  assert.ok(cardStart > 0 && cardEnd > cardStart && listenerStart > 0 && listenerEnd > listenerStart);
  return source.slice(cardStart, cardEnd) + '\n' + source.slice(listenerStart, listenerEnd);
}

function fixtureScript(source, paymentMethod, paymentStatus) {
  return `
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => window.cspViolations.push(e.effectiveDirective));
    const podeArquivarPedidos=false, podeImprimirPedidos=false, printAgentConectado=false;
    const escaparHtml = v => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    const buildOrderSearchText = p => p.cliente;
    const criarHtmlItensPedido = () => '';
    const formatarDataPedido = v => String(v || '');
    const formatarMoedaPedido = v => Number(v || 0).toFixed(2);
    const textoFormaPagamentoPedido = p => p.formaPagamento;
    ${extract(source)}
    document.body.append(criarCardPedido({ id:'pedido-teste', numero:'0004', cliente:'Cliente teste',
      canal:'delivery', origem:{icone:'',tipo:'delivery',texto:'Delivery'}, status:'novo',
      formaPagamento:${JSON.stringify(paymentMethod)}, pagamentoStatus:${JSON.stringify(paymentStatus)},
      total:53, itens:[], createdAt:'2026-11-11T18:55:00Z' }));
  `;
}

test('cards dinâmicos usam o mesmo marcador CSP dos cards iniciais', () => {
  assert.doesNotMatch(extract(view), /\bonsubmit\s*=/i);
  assert.match(extract(view), /\? 'data-confirm-finalize-pending'/);
  assert.ok((view.match(/data-confirm-finalize-pending/g) || []).length >= 3);
  new vm.Script(fixtureScript(view, 'dinheiro', 'pendente'));
});


function renderCard(source, method, payment) {
  const script = fixtureScript(source, method, payment);
  const listeners = {};
  const document = { addEventListener: (type, callback) => { listeners[type] = callback; },
    createElement: () => ({ dataset:{}, innerHTML:'' }), body: { append(card) { this.card = card; } } };
  vm.runInNewContext(script, { window:{}, document });
  return { html: document.body.card.innerHTML, submit: listeners.submit };
}

async function submitCard({ method='dinheiro', payment='pendente', status='finalizado', accept=true } = {}) {
  const { html } = renderCard(view, method, payment);
  const markup = html.match(/<form[^>]*class="order-status-form"[\s\S]*?<\/form>/)[0];
  let confirms=0, prevented=false;
  const form = { elements:{status:{value:status}}, querySelector:()=>null,
    matches: selector => selector === '[data-confirm-finalize-pending]' && markup.includes('data-confirm-finalize-pending') };
  const upload = view.indexOf("const uploadInput = form.querySelector?.('[data-image-upload]');");
  const begin=view.lastIndexOf("document.addEventListener('submit', async event => {",upload);
  const end=view.indexOf("\n    document.addEventListener('click', async event => {",upload);
  let listener;
  vm.runInNewContext(view.slice(begin,end), {
    document:{addEventListener:(_,callback)=>{listener=callback;}},
    window:{confirm:()=>{confirms++;return accept;}}
  });
  await listener({target:form,preventDefault:()=>{prevented=true;}});
  return {confirms,prevented,markup};
}

test('card novo com dinheiro pendente contém marcador e não contém evento inline', () => {
  const { html }=renderCard(view,'dinheiro','pendente');
  assert.match(html,/data-confirm-finalize-pending/);
  assert.doesNotMatch(html,/\bon[a-z]+\s*=/i);
});

test('finalizar dinheiro pendente pede confirmação e aceita prosseguir', async () => {
  const result=await submitCard();assert.equal(result.confirms,1);assert.equal(result.prevented,false);
});

test('cancelar confirmação impede o envio', async () => {
  const result=await submitCard({accept:false});assert.equal(result.confirms,1);assert.equal(result.prevented,true);
});

test('cartão pendente usa a mesma confirmação', async () => {
  const result=await submitCard({method:'cartao'});assert.equal(result.confirms,1);assert.equal(result.prevented,false);
});

test('pedido pago finaliza sem aviso de pagamento pendente', async () => {
  const result=await submitCard({payment:'pago'});assert.equal(result.confirms,0);assert.equal(result.prevented,false);
});

test('mudar para preparo não pede confirmação de finalização', async () => {
  const result=await submitCard({status:'preparo'});assert.equal(result.confirms,0);assert.equal(result.prevented,false);
});

test('cards preservam CSRF e ação da atualização de status', () => {
  const {html}=renderCard(view,'dinheiro','pendente');
  assert.match(html,/action="\/admin\/pedidos\/pedido-teste\/status"/);
  assert.match(html,/name="_csrf"/);
});
