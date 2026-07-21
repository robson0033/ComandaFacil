const crypto = require('crypto');
const { Assinatura } = require('../models/painelModels');
const { registroModel } = require('../models/registroModel');

const MP_API = 'https://api.mercadopago.com';
const valorPlano = () => Number(process.env.PLANO_MENSAL || 39.90);
const estabelecimentoId = req => req.session.user.estabelecimentoId || req.session.user.id;
const baseUrl = req => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

async function mp(path, options = {}) {
  if (!process.env.MERCADO_PAGO_ACCESS_TOKEN) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não foi configurado no .env.');
  }
  const response = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Erro Mercado Pago (${response.status})`);
  return data;
}

async function assinaturaDoUsuario(req) {
  const id = estabelecimentoId(req);
  let assinatura = await Assinatura.findOne({ estabelecimentoId: id });
  if (!assinatura) {
    const inicio = new Date();
    const fim = new Date(inicio.getTime() + 7 * 24 * 60 * 60 * 1000);
    assinatura = await Assinatura.create({ estabelecimentoId: id, inicioTeste: inicio, fimTeste: fim });
  }
  return assinatura;
}

exports.pagina = async (req, res) => {
  try {
    const assinatura = await assinaturaDoUsuario(req);
    const dono = await registroModel.findById(estabelecimentoId(req)).lean();
    return res.render('assinatura', {
      assinatura: assinatura.toObject(),
      valorPlano: valorPlano(),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || '',
      dono,
      pix: null
    });
  } catch (e) {
    console.error(e);
    req.flash('errors', e.message);
    return req.session.save(() => res.redirect('/admin'));
  }
};

exports.assinarCartao = async (req, res) => {
  try {
    const id = estabelecimentoId(req);
    const dono = await registroModel.findById(id).lean();
    const data = await mp('/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: 'Plano Profissional ComandaMix',
        external_reference: String(id),
        payer_email: dono.email,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: valorPlano(),
          currency_id: 'BRL'
        },
        back_url: `${baseUrl(req)}/assinatura/retorno`,
        status: 'pending'
      })
    });
    await Assinatura.findOneAndUpdate(
      { estabelecimentoId: id },
      { metodo: 'cartao', status: 'pendente', mercadoPagoPreapprovalId: data.id, ultimoStatusMercadoPago: data.status },
      { upsert: true }
    );
    return res.redirect(data.init_point);
  } catch (e) {
    console.error(e);
    req.flash('errors', e.message);
    return req.session.save(() => res.redirect('/assinatura'));
  }
};

exports.gerarPix = async (req, res) => {
  try {
    const id = estabelecimentoId(req);
    const dono = await registroModel.findById(id).lean();
    const idempotency = crypto.randomUUID();
    const data = await mp('/v1/payments', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': idempotency },
      body: JSON.stringify({
        transaction_amount: valorPlano(),
        description: 'Plano mensal ComandaMix',
        payment_method_id: 'pix',
        external_reference: String(id),
        notification_url: `${baseUrl(req)}/webhook/mercado-pago`,
        payer: { email: dono.email, first_name: dono.nome || 'Cliente' }
      })
    });
    await Assinatura.findOneAndUpdate(
      { estabelecimentoId: id },
      { metodo: 'pix', status: 'pendente', mercadoPagoPaymentId: String(data.id), ultimoStatusMercadoPago: data.status },
      { upsert: true }
    );
    const assinatura = await assinaturaDoUsuario(req);
    return res.render('assinatura', {
      assinatura: assinatura.toObject(),
      valorPlano: valorPlano(),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || '',
      dono,
      pix: {
        qrCodeBase64: data.point_of_interaction?.transaction_data?.qr_code_base64 || '',
        copiaCola: data.point_of_interaction?.transaction_data?.qr_code || '',
        paymentId: data.id
      }
    });
  } catch (e) {
    console.error(e);
    req.flash('errors', e.message);
    return req.session.save(() => res.redirect('/assinatura'));
  }
};

exports.retorno = async (req, res) => {
  req.flash('success', 'Pagamento recebido. A liberação será confirmada automaticamente pelo Mercado Pago.');
  return req.session.save(() => res.redirect('/assinatura'));
};

exports.webhook = async (req, res) => {
  res.sendStatus(200);
  try {
    const type = req.body?.type || req.query?.type;
    const resourceId = req.body?.data?.id || req.query?.['data.id'];
    if (!resourceId) return;

    if (type === 'payment') {
      const payment = await mp(`/v1/payments/${resourceId}`);
      const id = payment.external_reference;
      if (!id) return;
      const update = { mercadoPagoPaymentId: String(payment.id), ultimoStatusMercadoPago: payment.status, metodo: 'pix' };
      if (payment.status === 'approved') {
        const inicio = new Date();
        update.status = 'ativa';
        update.planoInicio = inicio;
        update.planoExpira = new Date(inicio.getTime() + 30 * 24 * 60 * 60 * 1000);
      }
      await Assinatura.findOneAndUpdate({ estabelecimentoId: id }, update, { upsert: true });
    }

    if (type === 'subscription_preapproval') {
      const preapproval = await mp(`/preapproval/${resourceId}`);
      const id = preapproval.external_reference;
      if (!id) return;
      const update = { mercadoPagoPreapprovalId: preapproval.id, ultimoStatusMercadoPago: preapproval.status, metodo: 'cartao' };
      if (preapproval.status === 'authorized') {
        update.status = 'ativa';
        update.planoInicio = new Date();
        update.planoExpira = preapproval.next_payment_date ? new Date(preapproval.next_payment_date) : null;
      } else if (preapproval.status === 'cancelled') {
        update.status = 'cancelada';
      }
      await Assinatura.findOneAndUpdate({ estabelecimentoId: id }, update, { upsert: true });
    }
  } catch (e) {
    console.error('Webhook Mercado Pago:', e.message);
  }
};

exports.assinaturaDoUsuario = assinaturaDoUsuario;
