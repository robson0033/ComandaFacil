"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("link do cardápio da mesa usa caminho relativo seguro", () => {
  const view = fs.readFileSync(
    path.join(root, "src/views/admin-real.ejs"),
    "utf8",
  );

  assert.match(view, /href="<%= safePublicUrl\(mesa\.caminhoPublico\) %>"/);
  assert.doesNotMatch(view, /href="<%= safePublicUrl\(mesa\.link\) %>"/);
});

test("controller fornece caminho relativo e link absoluto para QR Code", () => {
  const controller = fs.readFileSync(
    path.join(root, "src/controllers/adminRealController.js"),
    "utf8",
  );

  assert.match(
    controller,
    /const caminhoPublico = `\/mesa\/\$\{encodeURIComponent\(String\(mesa\.token \|\| ""\)\)\}`;/,
  );
  assert.match(controller, /const link = `\$\{baseUrl\}\$\{caminhoPublico\}`;/);
  assert.match(controller, /caminhoPublico,/);
});
