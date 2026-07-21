const bcrypt = require('bcryptjs');
const { Funcionario } = require('../models/painelModels');
exports.login = async (req,res) => {
 const user=await Funcionario.findOne({email:String(req.body.email||'').toLowerCase(),ativo:true});
 if(!user || !(await bcrypt.compare(req.body.senha||'',user.senha))){req.flash('errors','E-mail ou senha inválidos.'); return req.session.save(()=>res.redirect('/login/index'));}
 req.session.user={id:user._id,estabelecimentoId:user.estabelecimentoId,nome:user.nome,email:user.email,tipo:'funcionario',funcao:user.funcao,permissoes:user.permissoes};
 req.session.save(()=>res.redirect('/admin'));
};
