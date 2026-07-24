const VERSAO_DOCUMENTOS_LEGAIS = '2026-07-24';

exports.index = (req, res) => {
  res.render('index');
};

exports.termos = (req, res) => {
  res.render('termos', {
    versao: VERSAO_DOCUMENTOS_LEGAIS,
  });
};

exports.privacidade = (req, res) => {
  res.render('privacidade', {
    versao: VERSAO_DOCUMENTOS_LEGAIS,
  });
};
