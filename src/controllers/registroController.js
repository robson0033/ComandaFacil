const { Registro } = require('../models/registroModel');

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
      req.flash('errors', registro.errors);
      req.flash('formData', {
        ...req.body,
        senha: '',
        confirmarSenha: '',
      });

      return req.session.save(() => {
        return res.redirect('/cadastro/index');
      });
    }

    req.flash('success', 'Cadastro realizado com sucesso.');

    return req.session.save(() => {
      return res.redirect('/login/index');
    });
  } catch (error) {
    console.error('Erro ao realizar cadastro:', error);

    req.flash(
      'errors',
      'Ocorreu um erro ao realizar o cadastro. Tente novamente.'
    );

    return req.session.save(() => {
      return res.redirect('/cadastro/index');
    });
  }
};
