const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('admin não gera todos os QR Codes ao carregar', () => {
  const controller = read('src/controllers/adminRealController.js');
  const adminStart = controller.indexOf('const mesasComConta =');
  const dashboardStart = controller.indexOf('DASHBOARD COM FILTRO DE DATA', adminStart);
  const trecho = controller.slice(adminStart, dashboardStart);
  assert.ok(trecho.includes('qrCodeUrl'));
  assert.ok(!trecho.includes('QRCode.toDataURL'));
  assert.ok(!trecho.includes('Promise.all'));
});

test('QR da mesa é gerado sob demanda e isolado pela loja', () => {
  const controller = read('src/controllers/adminRealController.js');
  assert.ok(controller.includes('exports.qrCodeMesa = async'));
  assert.ok(controller.includes('estabelecimentoId: idEstabelecimento'));
  assert.ok(controller.includes('QRCode.toBuffer'));
  assert.ok(controller.includes('Cache-Control'));
});

test('rota do QR exige autenticação, assinatura e permissão', () => {
  const route = read('route.js');
  const start = route.indexOf("'/admin/api/mesas/:id/qrcode'");
  assert.ok(start >= 0);
  const trecho = route.slice(Math.max(0, start - 100), start + 320);
  assert.ok(trecho.includes('loginRequired'));
  assert.ok(trecho.includes('carregarAssinatura'));
  assert.ok(trecho.includes('assinaturaRequired'));
  assert.ok(trecho.includes("permissaoQualquer('mesas', 'pedidos')"));
  assert.ok(trecho.includes('admin.qrCodeMesa'));
});

test('painel só solicita o QR depois do clique', () => {
  const view = read('src/views/admin-real.ejs');
  assert.ok(view.includes('data-mesa-qr-url'));
  assert.ok(view.includes('data-mesa-qr-image'));
  assert.ok(view.includes('async function alternarQrCodeMesa'));
  assert.ok(view.includes("image.src = url"));
  const marker = view.indexOf('data-mesa-qr-image');
  const imgStart = view.lastIndexOf('<img', marker);
  assert.ok(marker >= 0 && imgStart >= 0, 'tag <img> do QR da mesa não encontrada');

  let cursor = imgStart;
  let imgEnd = -1;
  while (cursor < view.length) {
    if (view.startsWith('<%', cursor)) {
      const ejsEnd = view.indexOf('%>', cursor + 2);
      assert.ok(ejsEnd >= 0, 'bloco EJS não finalizado dentro da tag do QR');
      cursor = ejsEnd + 2;
      continue;
    }
    if (view[cursor] === '>') {
      imgEnd = cursor;
      break;
    }
    cursor += 1;
  }

  assert.ok(imgEnd > imgStart, 'fim da tag <img> do QR não encontrado');
  const qrImageTag = view.slice(imgStart, imgEnd + 1);
  assert.match(qrImageTag, /alt=["']QR Code da mesa <%= mesa\.numero %>["']/);
  assert.ok(/loading\s*=\s*["']eager["']/i.test(qrImageTag));
  assert.ok(!/loading\s*=\s*["']lazy["']/i.test(qrImageTag));
  assert.equal((view.match(/<%/g) || []).length, (view.match(/%>/g) || []).length);
  assert.ok(!view.includes('mesa.qrCode)'));
});
