#!/usr/bin/env bash
set -euo pipefail

if [[ "${NODE_ENV:-}" != "test" ]]; then
  echo '[BLOQUEADO] Rode com NODE_ENV=test.' >&2
  echo 'Exemplo: NODE_ENV=test bash scripts/codex-testes-reais.sh' >&2
  exit 2
fi

if [[ -z "${CONNECTIONSTRING:-}" ]]; then
  echo '[BLOQUEADO] CONNECTIONSTRING não está exportada no processo.' >&2
  echo 'Ela pode vir do .env, mas para máxima segurança confirme antes de executar.' >&2
fi

echo '== 1/4 Validando MongoDB de teste =='
node scripts/verificar-banco-teste.js

echo '== 2/4 Sintaxe =='
if npm run | grep -q 'test:syntax'; then
  npm run test:syntax
else
  echo '[INFO] script test:syntax não existe; pulando.'
fi

echo '== 3/4 Testes existentes =='
npm test

echo '== 4/4 Testes E2E reais =='
if [[ -d test-real ]]; then
  shopt -s nullglob
  files=(test-real/*.test.js test-real/**/*.test.js)
  if (( ${#files[@]} > 0 )); then
    node --test "${files[@]}"
  else
    echo '[INFO] test-real existe, mas ainda não há *.test.js.'
  fi
else
  echo '[INFO] A pasta test-real ainda não existe.'
  echo '[INFO] Peça ao Codex para seguir CODEX_TESTE_REAL_COMPLETO.md e criá-la.'
fi
