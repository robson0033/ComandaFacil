const { readFlash } = require("../utils/safeFlash");

exports.middlewareGlobal = (req,res,next) => {
  res.locals.errors = readFlash(req, "errors");
  res.locals.success = readFlash(req, "success");
  res.locals.user = req.session?.user || null;
  next();
};
