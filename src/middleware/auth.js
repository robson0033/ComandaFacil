exports.loginRequired = (req, res, next) => {
  if (!req.session.user) {
    req.flash("errors", "Faça login para acessar o painel.");
    return req.session.save(() => res.redirect("/login/index"));
  }
  next();
};

exports.permissao = (modulo) => (req, res, next) => {
  const user = req.session.user;
  if (!user) return res.redirect("/login/index");
  if (user.tipo === "proprietario" || user.permissoes?.includes(modulo))
    return next();
  return res
    .status(403)
    .send("Você não tem permissão para acessar este módulo.");
};
