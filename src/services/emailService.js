const nodemailer = require("nodemailer");

function criarTransportador() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const porta = Number(process.env.SMTP_PORT || 587);
  const usuario = String(process.env.SMTP_USER || "").trim();
  const senha = String(process.env.SMTP_PASS || "");

  if (!host || !usuario || !senha) {
    throw new Error(
      "Configure SMTP_HOST, SMTP_PORT, SMTP_USER e SMTP_PASS para enviar e-mails.",
    );
  }

  return nodemailer.createTransport({
    host,
    port: porta,
    secure: porta === 465,
    auth: {
      user: usuario,
      pass: senha,
    },
  });
}

async function enviarCodigoRecuperacao({ email, nome, codigo }) {
  const transportador = criarTransportador();
  const remetente = String(
    process.env.SMTP_FROM || process.env.SMTP_USER || "",
  ).trim();

  const nomeSeguro = String(nome || "cliente").trim();

  await transportador.sendMail({
    from: remetente,
    to: email,
    subject: "Código para redefinir sua senha — Comanda Fácil",
    text: [
      `Olá, ${nomeSeguro}.`,
      "",
      "Recebemos uma solicitação para redefinir sua senha no Comanda Fácil.",
      `Seu código de recuperação é: ${codigo}`,
      "",
      "O código expira em 10 minutos.",
      "Se você não solicitou a alteração, ignore este e-mail.",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;background:#f7f3f0;padding:32px;color:#1d1d1f">
        <div style="max-width:560px;margin:auto;background:#fff;border:1px solid #eadfd8;border-radius:18px;padding:32px">
          <h1 style="margin:0 0 12px;font-size:26px;color:#111827">Redefinição de senha</h1>
          <p style="line-height:1.6">Olá, <strong>${nomeSeguro}</strong>.</p>
          <p style="line-height:1.6">Use o código abaixo para criar uma nova senha no Comanda Fácil:</p>
          <div style="font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;background:#fff4e8;color:#d94b16;border-radius:14px;padding:20px;margin:24px 0">${codigo}</div>
          <p style="line-height:1.6"><strong>Validade:</strong> 10 minutos.</p>
          <p style="line-height:1.6;color:#6b7280">Se você não solicitou esta alteração, ignore esta mensagem. Sua senha atual continuará funcionando.</p>
        </div>
      </div>
    `,
  });
}

module.exports = {
  enviarCodigoRecuperacao,
};
