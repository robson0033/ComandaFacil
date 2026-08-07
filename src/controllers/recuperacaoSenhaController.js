const { logger: appLogger } = require("../utils/logger");

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const validator = require("validator");
const RecuperacaoSenha = require("../models/recuperacaoSenhaModel");
const { registroModel } = require("../models/registroModel");
const { Funcionario } = require("../models/painelModels");
const { enviarCodigoRecuperacao } = require("../services/emailService");
const { validatePassword } = require("../utils/passwordPolicy");
const {
  safeFlash,
  saveSessionOrRun,
} = require("../utils/safeFlash");

const DEZ_MINUTOS = 10 * 60 * 1000;
const QUINZE_MINUTOS = 15 * 60 * 1000;
const INTERVALO_REENVIO = 60 * 1000;
const MAXIMO_TENTATIVAS = 5;

function normalizarEmail(valor) {
  return String(valor || "").trim().toLowerCase();
}

function gerarCodigo() {
  return String(crypto.randomInt(100000, 1000000));
}

function gerarToken() {
  return crypto.randomBytes(32).toString("hex");
}

function criarHash(valor) {
  const segredo = String(process.env.SESSION_SECRET || "");
  if (segredo.length < 32) {
    throw new Error("SESSION_SECRET não configurada.");
  }
  return crypto
    .createHash("sha256")
    .update(`${valor}:${segredo}`)
    .digest("hex");
}

function compararHash(valor, hashSalvo) {
  const recebido = Buffer.from(criarHash(valor), "hex");
  const salvo = Buffer.from(String(hashSalvo || ""), "hex");

  if (recebido.length !== salvo.length) return false;
  return crypto.timingSafeEqual(recebido, salvo);
}

async function enviarCodigoPersistido({
  recuperacaoId,
  email,
  nome,
  codigo,
  enviar = enviarCodigoRecuperacao,
  RecuperacaoSenhaModel = RecuperacaoSenha,
}) {
  try {
    await enviar({ email, nome, codigo });
  } catch (erroEnvio) {
    try {
      await RecuperacaoSenhaModel.updateOne(
        { _id: recuperacaoId, usado: false },
        { $set: { usado: true } },
      );
    } catch (erroInvalidacao) {
      appLogger.error(
        "Erro ao invalidar recuperação após falha de e-mail:",
        erroInvalidacao,
      );
    }
    throw erroEnvio;
  }
}

async function localizarUsuario(email) {
  const proprietario = await registroModel.findOne({ email });

  if (proprietario) {
    return {
      usuario: proprietario,
      tipoUsuario: "proprietario",
      nome: proprietario.nome,
    };
  }

  const funcionario = await Funcionario.findOne({ email, ativo: true });

  if (funcionario) {
    return {
      usuario: funcionario,
      tipoUsuario: "funcionario",
      nome: funcionario.nome,
    };
  }

  return null;
}

function renderizar(res, pagina, dados = {}) {
  return res.render(pagina, {
    errors: [],
    success: [],
    ...dados,
  });
}

exports.paginaSolicitarCodigo = (req, res) => {
  return renderizar(res, "recuperar-senha", {
    email: req.session.recuperacaoEmail || "",
  });
};

exports.solicitarCodigo = async (req, res) => {
  try {
    const email = normalizarEmail(req.body.email);

    if (!validator.isEmail(email)) {
      return renderizar(res, "recuperar-senha", {
        email,
        errors: ["Informe um e-mail válido."],
      });
    }

    const usuarioEncontrado = await localizarUsuario(email);

    // Resposta neutra para não revelar quais e-mails estão cadastrados.
    if (!usuarioEncontrado) {
      return renderizar(res, "recuperar-senha", {
        email,
        success: [
          "Se esse e-mail estiver cadastrado, você receberá um código de recuperação.",
        ],
      });
    }

    const ultimaSolicitacao = await RecuperacaoSenha.findOne({
      email,
      usado: false,
    })
      .sort({ criadoEm: -1 })
      .lean();

    if (
      ultimaSolicitacao &&
      Date.now() - new Date(ultimaSolicitacao.criadoEm).getTime() <
        INTERVALO_REENVIO
    ) {
      req.session.recuperacaoEmail = email;
      return renderizar(res, "recuperar-senha", {
        email,
        errors: ["Aguarde 1 minuto antes de solicitar outro código."],
      });
    }

    await RecuperacaoSenha.updateMany(
      { email, usado: false },
      { $set: { usado: true } },
    );

    const codigo = gerarCodigo();

    const recuperacaoCriada = await RecuperacaoSenha.create({
      email,
      tipoUsuario: usuarioEncontrado.tipoUsuario,
      usuarioId: usuarioEncontrado.usuario._id,
      codigoHash: criarHash(codigo),
      expiraEm: new Date(Date.now() + DEZ_MINUTOS),
    });

    await enviarCodigoPersistido({
      recuperacaoId: recuperacaoCriada._id,
      email,
      nome: usuarioEncontrado.nome,
      codigo,
    });

    req.session.recuperacaoEmail = email;
    delete req.session.recuperacaoToken;

    return saveSessionOrRun(req, () =>
      res.redirect("/login/verificar-codigo"),
    );
  } catch (erro) {
    appLogger.error("Erro ao enviar código de recuperação:", erro);
    return renderizar(res, "recuperar-senha", {
      email: normalizarEmail(req.body.email),
      errors: [
        "Não foi possível enviar o código agora. Verifique a configuração do e-mail e tente novamente.",
      ],
    });
  }
};

exports.paginaVerificarCodigo = (req, res) => {
  if (!req.session.recuperacaoEmail) {
    return res.redirect("/login/recuperar-senha");
  }

  return renderizar(res, "verificar-codigo", {
    email: req.session.recuperacaoEmail,
  });
};

exports.verificarCodigo = async (req, res) => {
  try {
    const email = normalizarEmail(req.session.recuperacaoEmail);
    const codigo = String(req.body.codigo || "").replace(/\D/g, "");

    if (!email) {
      return res.redirect("/login/recuperar-senha");
    }

    if (codigo.length !== 6) {
      return renderizar(res, "verificar-codigo", {
        email,
        errors: ["Digite o código de 6 números enviado ao seu e-mail."],
      });
    }

    const recuperacao = await RecuperacaoSenha.findOne({
      email,
      usado: false,
      verificado: false,
      expiraEm: { $gt: new Date() },
    }).sort({ criadoEm: -1 });

    if (!recuperacao) {
      return renderizar(res, "verificar-codigo", {
        email,
        errors: ["O código expirou. Solicite um novo código."],
      });
    }

    if (recuperacao.tentativas >= MAXIMO_TENTATIVAS) {
      recuperacao.usado = true;
      await recuperacao.save();
      return renderizar(res, "verificar-codigo", {
        email,
        errors: ["Limite de tentativas atingido. Solicite outro código."],
      });
    }

    if (!compararHash(codigo, recuperacao.codigoHash)) {
      recuperacao.tentativas += 1;
      await recuperacao.save();

      const restantes = Math.max(
        0,
        MAXIMO_TENTATIVAS - recuperacao.tentativas,
      );

      return renderizar(res, "verificar-codigo", {
        email,
        errors: [`Código incorreto. Você ainda tem ${restantes} tentativa(s).`],
      });
    }

    const token = gerarToken();
    recuperacao.verificado = true;
    recuperacao.tokenHash = criarHash(token);
    recuperacao.expiraEm = new Date(Date.now() + QUINZE_MINUTOS);
    await recuperacao.save();

    req.session.recuperacaoToken = token;

    return saveSessionOrRun(req, () => res.redirect("/login/nova-senha"));
  } catch (erro) {
    appLogger.error("Erro ao verificar código:", erro);
    return res.status(500).render("404");
  }
};

exports.paginaNovaSenha = async (req, res) => {
  const email = normalizarEmail(req.session.recuperacaoEmail);
  const token = String(req.session.recuperacaoToken || "");

  if (!email || !token) {
    return res.redirect("/login/recuperar-senha");
  }

  const recuperacao = await RecuperacaoSenha.findOne({
    email,
    verificado: true,
    usado: false,
    expiraEm: { $gt: new Date() },
  }).sort({ criadoEm: -1 });

  if (!recuperacao || !compararHash(token, recuperacao.tokenHash)) {
    return res.redirect("/login/recuperar-senha");
  }

  return renderizar(res, "nova-senha", { email });
};

exports.salvarNovaSenha = async (req, res) => {
  try {
    const email = normalizarEmail(req.session.recuperacaoEmail);
    const token = String(req.session.recuperacaoToken || "");
    const senha = String(req.body.senha || "");
    const confirmarSenha = String(req.body.confirmarSenha || "");
    const errors = [];

    if (!email || !token) {
      return res.redirect("/login/recuperar-senha");
    }

    const passwordResult = validatePassword(senha);
    errors.push(...passwordResult.errors);

    if (senha !== confirmarSenha) {
      errors.push("As senhas não são iguais.");
    }

    if (errors.length > 0) {
      return renderizar(res, "nova-senha", { email, errors });
    }

    const recuperacao = await RecuperacaoSenha.findOne({
      email,
      verificado: true,
      usado: false,
      expiraEm: { $gt: new Date() },
    }).sort({ criadoEm: -1 });

    if (!recuperacao || !compararHash(token, recuperacao.tokenHash)) {
      return renderizar(res, "nova-senha", {
        email,
        errors: ["A autorização expirou. Solicite outro código."],
      });
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    if (recuperacao.tipoUsuario === "proprietario") {
      await registroModel.updateOne(
        { _id: recuperacao.usuarioId, email },
        { $set: { senha: senhaHash } },
      );
    } else {
      await Funcionario.updateOne(
        { _id: recuperacao.usuarioId, email },
        { $set: { senha: senhaHash } },
      );
    }

    recuperacao.usado = true;
    await recuperacao.save();

    await RecuperacaoSenha.updateMany(
      { email, _id: { $ne: recuperacao._id } },
      { $set: { usado: true } },
    );

    delete req.session.recuperacaoEmail;
    delete req.session.recuperacaoToken;

    safeFlash(req, "success", "Senha alterada com sucesso. Entre com a nova senha.");
    return saveSessionOrRun(req, () => res.redirect("/login/index"));
  } catch (erro) {
    appLogger.error("Erro ao redefinir senha:", erro);
    return res.status(500).render("404");
  }
};

exports._testing = Object.freeze({
  enviarCodigoPersistido,
});
