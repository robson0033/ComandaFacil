const crypto = require("crypto");
const { Assinatura, Configuracao, Pedido } = require("../models/painelModels");
const { registroModel } = require("../models/registroModel");

const MP_API = "https://api.mercadopago.com";
const valorPlano = () => Number(process.env.PLANO_MENSAL || 39.9);
const estabelecimentoId = (req) =>
  req.session.user.estabelecimentoId || req.session.user.id;
const baseUrl = (req) =>
  String(process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

function chaveCriptografia() {
  const segredo = process.env.TOKEN_ENCRYPTION_KEY;
  if (!segredo) throw new Error("TOKEN_ENCRYPTION_KEY não foi configurada.");
  return crypto.createHash("sha256").update(segredo).digest();
}

function criptografar(texto) {
  if (!texto) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", chaveCriptografia(), iv);
  const encrypted = Buffer.concat([cipher.update(String(texto), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64url")).join(".");
}

function descriptografar(valor) {
  if (!valor) return "";
  const [iv, tag, encrypted] = String(valor).split(".").map((v) => Buffer.from(v, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", chaveCriptografia(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

async function mp(path, options = {}, accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN) {
  if (!accessToken) throw new Error("Access Token do Mercado Pago não foi configurado.");
  const response = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `Erro Mercado Pago (${response.status})`);
  }
  return data;
}

async function assinaturaDoUsuario(req) {
  const id = estabelecimentoId(req);
  let assinatura = await Assinatura.findOne({ estabelecimentoId: id });
  if (!assinatura) {
    const inicio = new Date();
    assinatura = await Assinatura.create({
      estabelecimentoId: id,
      status: "teste",
      metodo: "teste",
      inicioTeste: inicio,
      fimTeste: new Date(inicio.getTime() + 7 * 86400000),
    });
  }
  return assinatura;
}

function manterTesteOuStatusAtual(assinatura) {
  const agora = Date.now();
  if (assinatura.fimTeste && new Date(assinatura.fimTeste).getTime() > agora) return "teste";
  if (assinatura.status === "ativa") return "ativa";
  return "pendente";
}

exports.pagina = async (req, res) => {
  try {
    const assinatura = await assinaturaDoUsuario(req);
    const dono = await registroModel.findById(estabelecimentoId(req)).lean();
    return res.render("assinatura", {
      assinatura: assinatura.toObject(),
      valorPlano: valorPlano(),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
      dono,
      pix: null,
      diasRestantes: res.locals.diasRestantes || 0,
    });
  } catch (e) {
    console.error(e);
    req.flash("errors", e.message);
    return req.session.save(() => res.redirect("/admin"));
  }
};

exports.assinarCartao = async (req, res) => {
  try {
    const id = estabelecimentoId(req);
    const assinatura = await assinaturaDoUsuario(req);
    const dono = await registroModel.findById(id).lean();
    const data = await mp("/preapproval", {
      method: "POST",
      body: JSON.stringify({
        reason: "Plano Profissional ComandaFácil",
        external_reference: String(id),
        payer_email: dono.email,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: valorPlano(),
          currency_id: "BRL",
        },
        back_url: `${baseUrl(req)}/assinatura/retorno`,
        status: "pending",
      }),
    });

    assinatura.metodo = "cartao";
    assinatura.status = manterTesteOuStatusAtual(assinatura);
    assinatura.mercadoPagoPreapprovalId = data.id;
    assinatura.ultimoStatusMercadoPago = data.status;
    await assinatura.save();

    return res.redirect(data.init_point);
  } catch (e) {
    console.error(e);
    req.flash("errors", e.message);
    return req.session.save(() => res.redirect("/assinatura"));
  }
};

exports.gerarPix = async (req, res) => {
  try {
    const id = estabelecimentoId(req);
    const assinatura = await assinaturaDoUsuario(req);
    const dono = await registroModel.findById(id).lean();
    const data = await mp("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        transaction_amount: valorPlano(),
        description: "Plano mensal ComandaFácil",
        payment_method_id: "pix",
        external_reference: String(id),
        notification_url: `${baseUrl(req)}/webhook/mercado-pago`,
        payer: { email: dono.email, first_name: dono.nome || "Cliente" },
      }),
    });

    assinatura.metodo = "pix";
    assinatura.status = manterTesteOuStatusAtual(assinatura);
    assinatura.mercadoPagoPaymentId = String(data.id);
    assinatura.ultimoStatusMercadoPago = data.status;
    await assinatura.save();

    return res.render("assinatura", {
      assinatura: assinatura.toObject(),
      valorPlano: valorPlano(),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || "",
      dono,
      diasRestantes: res.locals.diasRestantes || 0,
      pix: {
        qrCodeBase64: data.point_of_interaction?.transaction_data?.qr_code_base64 || "",
        copiaCola: data.point_of_interaction?.transaction_data?.qr_code || "",
        paymentId: data.id,
      },
    });
  } catch (e) {
    console.error(e);
    req.flash("errors", e.message);
    return req.session.save(() => res.redirect("/assinatura"));
  }
};

exports.retorno = async (req, res) => {
  req.flash("success", "Pagamento iniciado. Você continua usando o período gratuito até a confirmação ou até o vencimento real do teste.");
  return req.session.save(() => res.redirect("/admin"));
};

// OAuth do vendedor
exports.conectarMercadoPago = async (req, res) => {
  try {
    if (!process.env.MP_CLIENT_ID || !process.env.MP_REDIRECT_URI) {
      throw new Error("MP_CLIENT_ID e MP_REDIRECT_URI precisam ser configurados.");
    }
    const state = crypto.randomBytes(24).toString("hex");
    req.session.mpOauthState = state;
    await new Promise((resolve, reject) => req.session.save((e) => e ? reject(e) : resolve()));
    const url = new URL("https://auth.mercadopago.com/authorization");
    url.searchParams.set("client_id", process.env.MP_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("platform_id", "mp");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", process.env.MP_REDIRECT_URI);
    return res.redirect(url.toString());
  } catch (e) {
    req.flash("errors", e.message);
    return req.session.save(() => res.redirect("/admin#configuracoes"));
  }
};

exports.callbackMercadoPago = async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.mpOauthState) {
      throw new Error("Não foi possível validar a conexão com o Mercado Pago.");
    }
    const response = await fetch(`${MP_API}/oauth/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_secret: process.env.MP_CLIENT_SECRET,
        client_id: process.env.MP_CLIENT_ID,
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: process.env.MP_REDIRECT_URI,
      }),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(token.message || "Falha ao conectar a conta Mercado Pago.");

    await Configuracao.findOneAndUpdate(
      { estabelecimentoId: estabelecimentoId(req) },
      { $set: {
        "mercadoPago.conectado": true,
        "mercadoPago.userId": String(token.user_id || ""),
        "mercadoPago.publicKey": token.public_key || "",
        "mercadoPago.accessTokenCriptografado": criptografar(token.access_token),
        "mercadoPago.refreshTokenCriptografado": criptografar(token.refresh_token),
        "mercadoPago.tokenExpiraEm": token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null,
        "mercadoPago.conectadoEm": new Date(),
      }},
      { upsert: true, setDefaultsOnInsert: true },
    );
    delete req.session.mpOauthState;
    req.flash("success", "Conta Mercado Pago conectada com sucesso.");
    return req.session.save(() => res.redirect("/admin#configuracoes"));
  } catch (e) {
    console.error("OAuth Mercado Pago:", e);
    req.flash("errors", e.message);
    return req.session.save(() => res.redirect("/admin#configuracoes"));
  }
};

exports.desconectarMercadoPago = async (req, res) => {
  await Configuracao.findOneAndUpdate(
    { estabelecimentoId: estabelecimentoId(req) },
    { $set: {
      mercadoPago: {
        conectado: false, userId: "", publicKey: "",
        accessTokenCriptografado: "", refreshTokenCriptografado: "",
        tokenExpiraEm: null, conectadoEm: null,
      },
    }},
  );
  req.flash("success", "Conta Mercado Pago desconectada.");
  return req.session.save(() => res.redirect("/admin#configuracoes"));
};

async function configuracaoComToken(estabelecimento) {
  const cfg = await Configuracao.findOne({ estabelecimentoId: estabelecimento })
    .select("+mercadoPago.accessTokenCriptografado +mercadoPago.refreshTokenCriptografado");
  if (!cfg?.mercadoPago?.conectado || !cfg.mercadoPago.accessTokenCriptografado) {
    throw new Error("Este estabelecimento ainda não conectou a conta Mercado Pago.");
  }
  return { cfg, accessToken: descriptografar(cfg.mercadoPago.accessTokenCriptografado) };
}

exports.gerarPixPedido = async (req, res) => {
  try {
    const cfgPublica = await Configuracao.findOne({ slug: req.params.slug }).lean();
    if (!cfgPublica) return res.status(404).json({ success: false, message: "Estabelecimento não encontrado." });
    const pedido = await Pedido.findOne({ _id: req.params.pedidoId, estabelecimentoId: cfgPublica.estabelecimentoId });
    if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
    if (pedido.pagamentoStatus === "pago") return res.json({ success: true, aprovado: true });

    if (pedido.mercadoPagoPaymentId && pedido.pixCopiaCola) {
      return res.json({
        success: true, paymentId: pedido.mercadoPagoPaymentId,
        copiaCola: pedido.pixCopiaCola, qrCodeBase64: pedido.pixQrCodeBase64,
        status: pedido.mercadoPagoStatus || "pending",
      });
    }

    const { accessToken } = await configuracaoComToken(cfgPublica.estabelecimentoId);
    const emailCliente = String(pedido.emailCliente || "").trim().toLowerCase();
    const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCliente);

    if (!emailValido) {
      return res.status(400).json({
        success: false,
        message: "Informe um e-mail válido para gerar o pagamento Pix.",
      });
    }

    const data = await mp("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": `pedido-${pedido._id}` },
      body: JSON.stringify({
        transaction_amount: Number(pedido.total),
        description: `Pedido ${String(pedido._id).slice(-6).toUpperCase()} - ${cfgPublica.nomeEstabelecimento}`,
        payment_method_id: "pix",
        external_reference: `pedido:${pedido._id}`,
        notification_url: `${baseUrl(req)}/webhook/mercado-pago`,
        payer: { email: emailCliente, first_name: pedido.cliente || "Cliente" },
      }),
    }, accessToken);

    pedido.formaPagamento = "pix";
    pedido.mercadoPagoPaymentId = String(data.id);
    pedido.mercadoPagoStatus = data.status || "pending";
    pedido.pixCopiaCola = data.point_of_interaction?.transaction_data?.qr_code || "";
    pedido.pixQrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64 || "";
    pedido.pixExpiraEm = data.date_of_expiration ? new Date(data.date_of_expiration) : null;
    await pedido.save();

    return res.status(201).json({
      success: true, paymentId: data.id, status: data.status,
      copiaCola: pedido.pixCopiaCola, qrCodeBase64: pedido.pixQrCodeBase64,
      expiraEm: pedido.pixExpiraEm,
    });
  } catch (e) {
    console.error("Pix do pedido:", e);
    return res.status(400).json({ success: false, message: e.message });
  }
};

exports.statusPagamentoPedido = async (req, res) => {
  const cfg = await Configuracao.findOne({ slug: req.params.slug }).lean();
  if (!cfg) return res.status(404).json({ success: false, message: "Estabelecimento não encontrado." });
  const pedido = await Pedido.findOne({ _id: req.params.pedidoId, estabelecimentoId: cfg.estabelecimentoId }).lean();
  if (!pedido) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
  return res.json({ success: true, pagamentoStatus: pedido.pagamentoStatus, mercadoPagoStatus: pedido.mercadoPagoStatus });
};

exports.webhook = async (req, res) => {
  res.sendStatus(200);
  try {
    const type = req.body?.type || req.query?.type;
    const resourceId = req.body?.data?.id || req.query?.["data.id"];
    if (!resourceId) return;

    if (type === "payment") {
      const pedidoSalvo = await Pedido.findOne({ mercadoPagoPaymentId: String(resourceId) });
      if (pedidoSalvo) {
        const { accessToken } = await configuracaoComToken(pedidoSalvo.estabelecimentoId);
        const payment = await mp(`/v1/payments/${resourceId}`, {}, accessToken);
        pedidoSalvo.mercadoPagoStatus = payment.status || "";
        if (payment.status === "approved") {
          pedidoSalvo.pagamentoStatus = "pago";
          pedidoSalvo.pagoEm = payment.date_approved ? new Date(payment.date_approved) : new Date();
        } else if (["cancelled", "rejected", "refunded", "charged_back"].includes(payment.status)) {
          pedidoSalvo.pagamentoStatus = "cancelado";
        }
        await pedidoSalvo.save();
        return;
      }

      const payment = await mp(`/v1/payments/${resourceId}`);
      const id = payment.external_reference;
      if (!id || String(id).startsWith("pedido:")) return;
      const update = { mercadoPagoPaymentId: String(payment.id), ultimoStatusMercadoPago: payment.status, metodo: "pix" };
      if (payment.status === "approved") {
        const inicio = new Date();
        update.status = "ativa";
        update.planoInicio = inicio;
        update.planoExpira = new Date(inicio.getTime() + 30 * 86400000);
      }
      await Assinatura.findOneAndUpdate({ estabelecimentoId: id }, update, { upsert: true });
    }

    if (type === "subscription_preapproval") {
      const preapproval = await mp(`/preapproval/${resourceId}`);
      const id = preapproval.external_reference;
      if (!id) return;
      const update = { mercadoPagoPreapprovalId: preapproval.id, ultimoStatusMercadoPago: preapproval.status, metodo: "cartao" };
      if (preapproval.status === "authorized") {
        update.status = "ativa";
        update.planoInicio = new Date();
        update.planoExpira = preapproval.next_payment_date ? new Date(preapproval.next_payment_date) : null;
      } else if (preapproval.status === "cancelled") {
        const atual = await Assinatura.findOne({ estabelecimentoId: id });
        const testeAindaValido = atual?.fimTeste && new Date(atual.fimTeste) > new Date();
        update.status = testeAindaValido ? "teste" : "cancelada";
      }
      await Assinatura.findOneAndUpdate({ estabelecimentoId: id }, update, { upsert: true });
    }
  } catch (e) {
    console.error("Webhook Mercado Pago:", e.message);
  }
};

exports.assinaturaDoUsuario = assinaturaDoUsuario;
