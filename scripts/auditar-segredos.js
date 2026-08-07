"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TEXT_EXTENSIONS = new Set([
  "", ".js", ".cjs", ".mjs", ".json", ".md", ".ejs", ".txt", ".yml", ".yaml",
]);
const EXAMPLE_FILES = [
  ".env.development.example",
  ".env.test.example",
  ".env.production.example",
];
const SECRET_NAMES = new Set([
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
]);

function normalizeRelative(file) {
  return file.split(path.sep).join("/").replace(/^\.\//, "");
}

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error("Não foi possível consultar os arquivos rastreados pelo Git.");
  }

  return result.stdout.split("\0").filter(Boolean).map(normalizeRelative);
}

function readText(relative) {
  const absolute = path.resolve(ROOT, relative);
  if (!absolute.startsWith(`${ROOT}${path.sep}`) && absolute !== ROOT) {
    throw new Error(`Caminho fora do projeto: ${relative}`);
  }
  const stat = fs.statSync(absolute);
  if (stat.size > 2 * 1024 * 1024) return null;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function parseEnv(text) {
  const values = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function isTrackedRuntimeEnv(file) {
  const base = path.posix.basename(file);
  if (!base.startsWith(".env")) return false;
  if (base === ".env.example" || /^\.env\.[A-Za-z0-9_-]+\.example$/.test(base)) return false;
  return true;
}

function isPlaceholderMongoUri(raw) {
  try {
    const parsed = new URL(raw);
    const username = decodeURIComponent(parsed.username || "").toLowerCase();
    const password = decodeURIComponent(parsed.password || "").toLowerCase();
    const hostname = String(parsed.hostname || "").toLowerCase();
    const placeholderUsers = new Set(["u", "user", "usuario", "username", "test", "teste"]);
    const placeholderPasswords = new Set(["p", "pass", "password", "senha", "secret", "segredo", "test", "teste"]);
    const placeholderHost = hostname === "localhost"
      || hostname.startsWith("127.")
      || hostname.endsWith(".internal")
      || hostname.endsWith(".example")
      || hostname.endsWith(".test")
      || hostname === "host";
    return placeholderHost || (placeholderUsers.has(username) && placeholderPasswords.has(password));
  } catch {
    return false;
  }
}

function highConfidenceSecretFindings(file, text) {
  const findings = [];
  const mongoPattern = /mongodb(?:\+srv)?:\/\/[^\s"']+/gi;
  for (const match of String(text).matchAll(mongoPattern)) {
    const uri = match[0].replace(/[),.;]+$/, "");
    if (uri.includes("@") && !isPlaceholderMongoUri(uri)) {
      findings.push(`${file}:MONGODB_URI_COM_CREDENCIAL`);
      break;
    }
  }

  const patterns = [
    ["DISCORD_WEBHOOK_REAL", /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d{10,}\/[A-Za-z0-9_-]{20,}/gi],
    ["SLACK_WEBHOOK_REAL", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{20,}/gi],
    ["MERCADO_PAGO_TOKEN_REAL", /\b(?:APP_USR|TEST)-[A-Za-z0-9_-]{30,}\b/g],
    ["CHAVE_PRIVADA", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ["GITHUB_TOKEN", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
    ["AWS_ACCESS_KEY", /\bAKIA[0-9A-Z]{16}\b/g],
  ];

  for (const [code, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${file}:${code}`);
  }
  return findings;
}

function assertContains(errors, text, fragment, label) {
  if (!text.includes(fragment)) errors.push(`${label}: ausente ${fragment}`);
}

function run() {
  const errors = [];
  const warnings = [];
  const tracked = gitTrackedFiles();

  const runtimeEnvFiles = tracked.filter(isTrackedRuntimeEnv);
  for (const file of runtimeEnvFiles) {
    errors.push(`Arquivo de ambiente real rastreado pelo Git: ${file}`);
  }

  const gitignore = readText(".gitignore") || "";
  for (const rule of [".env", ".env.*", "!.env.example", "!.env.*.example"]) {
    if (!gitignore.split(/\r?\n/).includes(rule)) {
      errors.push(`.gitignore não contém a regra exata: ${rule}`);
    }
  }

  const expectedNodeEnv = {
    ".env.development.example": "development",
    ".env.test.example": "test",
    ".env.production.example": "production",
  };

  for (const file of EXAMPLE_FILES) {
    if (!tracked.includes(file)) {
      errors.push(`Modelo de ambiente não rastreado: ${file}`);
      continue;
    }
    const values = parseEnv(readText(file) || "");
    if (values.get("NODE_ENV") !== expectedNodeEnv[file]) {
      errors.push(`${file}: NODE_ENV deve ser ${expectedNodeEnv[file]}`);
    }
    for (const name of SECRET_NAMES) {
      if (!values.has(name)) {
        errors.push(`${file}: variável secreta ausente do inventário: ${name}`);
      } else if (values.get(name) !== "") {
        errors.push(`${file}: ${name} deve permanecer sem valor`);
      }
    }
    for (const [name, value] of values) {
      if (/ALLOW_[A-Z0-9_]+/.test(name) && String(value).toLowerCase() !== "false") {
        errors.push(`${file}: ${name} deve permanecer false`);
      }
    }
  }

  const secretFindings = [];
  for (const file of tracked) {
    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    let text;
    try {
      text = readText(file);
    } catch {
      continue;
    }
    if (text === null) continue;
    secretFindings.push(...highConfidenceSecretFindings(file, text));
  }
  for (const finding of secretFindings) {
    errors.push(`Possível segredo real em arquivo rastreado: ${finding}`);
  }

  const environmentDoc = readText("docs/segredos-por-ambiente.md") || "";
  const rotationDoc = readText("docs/rotacao-segredos.md") || "";
  for (const fragment of ["Desenvolvimento", "Testes", "Produção", "Render > Environment", "npm run audit:secrets"]) {
    assertContains(errors, environmentDoc, fragment, "docs/segredos-por-ambiente.md");
  }
  for (const phase of ["Preparar", "Aplicar", "Validar", "Revogar", "Rollback"]) {
    assertContains(errors, rotationDoc, phase, "docs/rotacao-segredos.md");
  }
  for (const name of SECRET_NAMES) {
    assertContains(errors, rotationDoc, name, "docs/rotacao-segredos.md");
  }

  const localEnv = path.join(ROOT, ".env");
  if (fs.existsSync(localEnv)) {
    const localValues = parseEnv(fs.readFileSync(localEnv, "utf8"));
    if (String(localValues.get("NODE_ENV") || "").trim().toLowerCase() === "production") {
      errors.push("O .env local está marcado como NODE_ENV=production.");
    }
    const localAppUrl = String(localValues.get("APP_URL") || "").trim().toLowerCase();
    if (localAppUrl.includes("onrender.com")) {
      warnings.push("O APP_URL local aponta para onrender.com; confirme que o .env não contém credenciais de produção.");
    }
  } else {
    warnings.push("Nenhum .env local encontrado; a verificação estática continua válida.");
  }

  console.log(`ARQUIVOS_RASTREADOS=${tracked.length}`);
  console.log(`ARQUIVOS_ENV_REAIS_RASTREADOS=${runtimeEnvFiles.length}`);
  console.log(`MODELOS_DE_AMBIENTE=${EXAMPLE_FILES.length}`);
  console.log(`POSSIVEIS_SEGREDOS_REAIS=${secretFindings.length}`);
  console.log(`AVISOS=${warnings.length}`);
  for (const warning of warnings) console.log(`AVISO=${warning}`);
  console.log(`ERROS=${errors.length}`);
  for (const error of errors) console.log(`ERRO=${error}`);
  console.log("VALORES_SECRETOS_EXIBIDOS=NAO");
  console.log(`ITEM_18_STATIC_OK=${errors.length === 0 ? "SIM" : "NAO"}`);

  if (errors.length > 0) process.exitCode = 1;
}

try {
  run();
} catch (error) {
  console.error(`ERRO_AUDITORIA=${String(error?.message || error).slice(0, 300)}`);
  console.error("VALORES_SECRETOS_EXIBIDOS=NAO");
  process.exitCode = 1;
}
