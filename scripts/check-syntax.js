"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOTS = ["server.js", "route.js", "src", "scripts", "test"];
const ignored = new Set(["node_modules", ".git", "public", "downloads"]);

function collect(target, result = []) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) return result;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (absolute.endsWith(".js")) result.push(absolute);
    return result;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    collect(path.join(absolute, entry.name), result);
  }
  return result;
}

const files = ROOTS.flatMap(target => collect(target));
let failures = 0;
for (const file of files) {
  const check = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (check.status !== 0) {
    failures += 1;
    process.stderr.write(check.stderr || check.stdout || `Falha de sintaxe: ${file}\n`);
  }
}

if (failures) {
  process.stderr.write(`${failures} arquivo(s) com erro de sintaxe.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${files.length} arquivo(s) JavaScript aprovados na verificação de sintaxe.\n`);
}
