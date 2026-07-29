const { Registro } = require('../models/registroModel');
const {
  safeFlash,
  saveSessionOrRun,
} = require('../utils/safeFlash');

const VERSAO_DOCUMENTOS_LEGAIS = '2026-07-24';

exports.cadastro = (req, res) => {
  res.render('index');
};

exports.registro = async (req, res) => {
  try {
    const registro = new Registro(req.body, {
      versaoTermos: VERSAO_DOCUMENTOS_LEGAIS,
      ipAceite: req.ip,
      userAgentAceite: req.get('user-agent') || '',
    });

    await registro.register();

    if (registro.errors.length > 0) {
      safeFlash(req, 'errors', registro.errors);
      safeFlash(req, 'formData', {
        ...req.body,
        senha: '',
        confirmarSenha: '',
      });

      return saveSessionOrRun(req, () => {
        return res.redirect('/cadastro/index');
      });
    }

    safeFlash(req, 'success', 'Cadastro realizado com sucesso.');

    return saveSessionOrRun(req, () => {
      return res.redirect('/login/index');
    });
  } catch (error) {
    console.error('Erro ao realizar cadastro:', error);

    safeFlash(
      req,
      'errors',
      error?.code === 11000
        ? 'E-mail, CPF ou CNPJ já cadastrado.'
        : 'Ocorreu um erro ao realizar o cadastro. Tente novamente.'
    );

    return saveSessionOrRun(req, () => {
      return res.redirect('/cadastro/index');
    });
  }
};
