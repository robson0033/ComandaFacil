"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SECRET_NAMES = [
  "CONNECTIONSTRING",
  "SESSION_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "AVALIACAO_AUDIT_SALT",
  "MERCADO_PAGO_ACCESS_TOKEN",
  "MERCADO_PAGO_WEBHOOK_SECRET",
  "MP_CLIENT_SECRET",
  "CLOUDINARY_API_SECRET",
  "SMTP_PASS",
  "ALERT_WEBHOOK_URL",
  "ALERT_WEBHOOK_BEARER_TOKEN",
];

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function parseEnv(relative) {
  const values = new Map();
  for (const rawLine of source(relative).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

test("git ignora ambientes reais e permite somente modelos sem segredo", () => {
  const rules = new Set(source(".gitignore").split(/\r?\n/));
  for (const rule of [".env", ".env.*", "!.env.example", "!.env.*.example"]) {
    assert.equal(rules.has(rule), true, rule);
  }

  const tracked = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(tracked.status, 0);
  const files = tracked.stdout.split("\0").filter(Boolean);
  const invalid = files.filter(file => {
    const name = path.posix.basename(file);
    if (!name.startsWith(".env")) return false;
    return name !== ".env.example" && !/^\.env\.[A-Za-z0-9_-]+\.example$/.test(name);
  });
  assert.deepEqual(invalid, []);
});

test("modelos separam development, test e production sem preencher segredos", () => {
  const models = new Map([
    [".env.development.example", "development"],
    [".env.test.example", "test"],
    [".env.production.example", "production"],
  ]);
  for (const [file, expectedEnvironment] of models) {
    const values = parseEnv(file);
    assert.equal(values.get("NODE_ENV"), expectedEnvironment, file);
    for (const name of SECRET_NAMES) {
      assert.equal(values.has(name), true, `${file}:${name}`);
      assert.equal(values.get(name), "", `${file}:${name} precisa estar vazio`);
    }
    for (const [name, value] of values) {
      if (name.startsWith("ALLOW_")) assert.equal(value, "false", `${file}:${name}`);
    }
  }
});

test("documentação define fontes permitidas e proíbe compartilhar produção", () => {
  const environment = source("docs/segredos-por-ambiente.md");
  for (const required of [
    "Desenvolvimento",
    "Testes",
    "Produção",
    "Render > Environment",
    ".env.development.example",
    ".env.test.example",
    ".env.production.example",
    "npm run audit:secrets",
  ]) {
    assert.match(environment, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(environment, /não compartilh|não devem ser copiad/i);
});

test("rotação cobre preparação, validação, revogação e rollback dos segredos críticos", () => {
  const rotation = source("docs/rotacao-segredos.md");
  for (const phase of ["Preparar", "Aplicar", "Validar", "Revogar", "Rollback"]) {
    assert.match(rotation, new RegExp(`\\b${phase}\\b`, "i"));
  }
  for (const name of SECRET_NAMES) assert.match(rotation, new RegExp(name));
  assert.match(rotation, /TOKEN_ENCRYPTION_KEY[\s\S]{0,500}migra|reconexão OAuth/i);
  assert.match(rotation, /SESSION_SECRET[\s\S]{0,500}sessões existentes/i);
});

test("auditoria não modifica integrações e nunca imprime valores do env", () => {
  const audit = source("scripts/auditar-segredos.js");
  assert.doesNotMatch(audit, /writeFileSync|unlinkSync|rmSync|renameSync|mongoose|fetch\s*\(/);
  assert.match(audit, /VALORES_SECRETOS_EXIBIDOS=NAO/);
  assert.match(audit, /gitTrackedFiles/);
  assert.match(audit, /highConfidenceSecretFindings/);
  assert.doesNotMatch(audit, /console\.(?:log|error)\([^\n]*(?:process\.env|localValues\.get)/);
});

test("comando de auditoria está registrado e conclui sem expor segredo", () => {
  const packageJson = JSON.parse(source("package.json"));
  assert.equal(packageJson.scripts["audit:secrets"], "node scripts/auditar-segredos.js");

  const result = spawnSync(process.execPath, ["scripts/auditar-segredos.js"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /VALORES_SECRETOS_EXIBIDOS=NAO/);
  assert.match(output, /ITEM_18_STATIC_OK=SIM/);
  assert.doesNotMatch(output, /mongodb(?:\+srv)?:\/\/[^\s]+@|discord(?:app)?\.com\/api\/webhooks\/\d+\//i);
});
