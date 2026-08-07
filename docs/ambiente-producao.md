# Ambiente de produção

O projeto usa **Node.js 24.18.1 LTS** e npm 11 ou 12. Prepare o ambiente com:

```bash
nvm install 24.18.1
nvm use
npm install -g npm@11
npm ci
npm run test:production
npm run audit:production
```

Não use `npm install` no deploy. O `npm ci` deve respeitar integralmente o
`package-lock.json` e o deploy deve parar quando instalação, testes ou auditoria
falharem.

## Variáveis obrigatórias

Em todos os ambientes:

- `NODE_ENV`: `development`, `test` ou `production`;
- `PORT`;
- `CONNECTIONSTRING`;
- `SESSION_SECRET`, com no mínimo 32 caracteres;
- `APP_URL`.

Em produção também são obrigatórias:

- `WEB_CONCURRENCY=1`;
- `RATE_LIMIT_STORE=mongo` (é o padrão em produção, mas deixe explícito);
- `STORAGE_DRIVER=cloudinary`;
- `CLOUDINARY_CLOUD_NAME`;
- `CLOUDINARY_API_KEY`;
- `CLOUDINARY_API_SECRET`;
- `MERCADO_PAGO_ACCESS_TOKEN`;
- `MERCADO_PAGO_PUBLIC_KEY`;
- `MERCADO_PAGO_WEBHOOK_SECRET`;
- `MERCADO_PAGO_PLATFORM_USER_ID`;
- `MP_CLIENT_ID`, `MP_CLIENT_SECRET` e `MP_REDIRECT_URI`;
- `TOKEN_ENCRYPTION_KEY`;
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM`.

`ALLOWED_ORIGINS` é opcional quando existe apenas o domínio de `APP_URL`. Para
mais de uma origem, use uma lista separada por vírgulas, sempre com HTTPS e sem
caminho:

```env
APP_URL=https://app.exemplo.com.br
ALLOWED_ORIGINS=https://www.exemplo.com.br,https://servico.onrender.com
```

Nunca registre os valores dessas variáveis. O nome legado `SECRETSESSION` não é
usado no novo boot; configure `SESSION_SECRET`.

Um adaptador customizado continua opcional com `STORAGE_DRIVER=external`,
`STORAGE_EXTERNAL_PROVIDER`, `STORAGE_EXTERNAL_BASE_URL` e
`STORAGE_EXTERNAL_ADAPTER_MODULE`. Não existe fallback para disco local em
produção.

O `MemoryStore` só pode ser usado fora de produção com
`ALLOW_MEMORY_SESSION=true`. Quando MongoDB estiver disponível, o sistema usa o
mesmo cliente Mongoose no `connect-mongo`.

## Índices obrigatórios antes do primeiro boot de produção

A criação automática de índices críticos permanece desligada para evitar uma
migração única acidental em uma base existente. Execute primeiro em homologação:

```bash
npm run indexes:dry-run
```

Resolva toda duplicidade exibida. Depois aplique de forma controlada:

```bash
ALLOW_INDEX_MIGRATION=true npm run indexes:apply
```

O servidor de produção agora verifica esses índices após conectar ao MongoDB e
**recusa o boot** quando algum índice crítico estiver ausente ou divergente.
Isso inclui a unicidade da criação pública de pedidos por chave de idempotência.

## Limite de instâncias

Mantenha `WEB_CONCURRENCY=1`. O rate limit usa MongoDB em produção e é
compartilhado, porém a conexão em tempo real com o agente de impressão ainda é
local ao processo. Escala horizontal exige um adaptador compartilhado para o
Socket.IO/agente e uma estratégia de roteamento apropriada.

## Homologação controlada do Cloudinary

O teste externo é exclusivamente manual, usa a fixture descartável
`test/fixtures/cloudinary-test.png` e não inicia servidor nem acessa MongoDB.
As credenciais devem estar no `.env` local; não as inclua no comando ou em
logs.

```bash
ALLOW_EXTERNAL_STORAGE_TEST=true \
NODE_ENV=development \
STORAGE_DRIVER=cloudinary \
CLOUDINARY_TEST_ESTABELECIMENTO_ID=000000000000000000000001 \
node scripts/testar-cloudinary-homologacao.js
```

O script processa a fixture pelo mesmo `imageProcessor`, cria uma chave nova no
namespace `estabelecimentos/<id>/testes/<uuid>.webp`, valida o upload e remove o
recurso duas vezes para confirmar a idempotência. Ele nunca executa durante
boot, testes ou importação.

Os códigos de saída são: `0` para upload e limpeza confirmados; `1` para
configuração/fixture inválida; `2` para processamento inválido; `3` para falha
conhecida de upload; `4` para resultado ambíguo; e `5` para falha de remoção ou
limpeza.

Quando o upload terminar com `STORAGE_RESULTADO_DESCONHECIDO`, não repita o
upload nem gere outra chave. Use a mesma `storageKey` exibida no log para uma
consulta manual separada:

```bash
ALLOW_EXTERNAL_STORAGE_RECONCILIATION=true \
NODE_ENV=development \
STORAGE_DRIVER=cloudinary \
CLOUDINARY_TEST_ESTABELECIMENTO_ID=000000000000000000000001 \
node scripts/testar-cloudinary-homologacao.js --reconcile \
estabelecimentos/000000000000000000000001/testes/UUID-DA-EXECUCAO.webp
```

Por padrão, a reconciliação apenas consulta. Para remover um recurso cuja
existência foi confirmada, repita o comando adicionando
`ALLOW_EXTERNAL_STORAGE_RECONCILIATION_REMOVE=true`. O script recusa chaves de
outro estabelecimento ou fora do namespace `testes`.

## Homologação controlada do runtime

O teste de runtime é exclusivamente manual e deve usar um database dedicado de
homologação. Ele inicia duas instâncias sequenciais do boot real para validar
MongoDB, MongoStore, `/health`, `/ready`, persistência e remoção de sessão e
graceful shutdown. Não usa login ou dados de clientes.

As variáveis `CONNECTIONSTRING`, `SESSION_SECRET`, `APP_URL`, `PORT` e a
configuração de storage devem vir do `.env` local. Não inclua seus valores no
comando ou em logs.

```bash
ALLOW_RUNTIME_HOMOLOGATION=true \
RUNTIME_TEST_DATABASE_CONFIRMATION=true \
RUNTIME_TEST_PORT=3100 \
node scripts/testar-runtime-homologacao.js
```

O database é aceito automaticamente quando o nome contém `homolog`, `staging`
ou `test`. Para outro nome exclusivamente técnico, a confirmação adicional
acima é obrigatória. Nomes ou hosts com indicação de produção continuam
bloqueados, assim como qualquer execução com `NODE_ENV=production`.

Durante a execução, as rotas sob `/__homologacao` existem apenas com a flag
exata e em desenvolvimento. Elas exigem um token efêmero mantido em memória,
criam somente marcadores técnicos e são removidas do boot normal.

Os códigos de saída são: `0` para homologação aprovada; `1` para ambiente
inválido; `2` para falha de boot; `3` para health/readiness inválido; `4` para
falha de sessão; `5` para falha no reinício; `6` para falha de shutdown; e `7`
para falha de limpeza.

## Health checks

- `GET /health`: confirma que o processo responde; não consulta o banco.
- `GET /ready`: retorna 200 somente após ambiente, MongoDB, índices críticos,
  store de sessão, workers e listener HTTP estarem prontos. Durante boot ou
  shutdown retorna 503.

Ambas as respostas usam `Cache-Control: no-store` e não expõem configuração.

## Encerramento

`SIGTERM` e `SIGINT` retiram a aplicação do estado pronto, bloqueiam novos
trabalhos de impressão, encerram reconciliadores, rate limiters, SSE, Socket.IO,
HTTP, store de sessão e Mongoose. Há limite máximo de 25 segundos. Erros fatais
(`uncaughtException` e `unhandledRejection`) usam o mesmo fluxo e código de saída
1.

## Alertas operacionais

Os alertas internos usam um webhook externo e independente do SMTP. A variável
`ALERT_WEBHOOK_URL` é opcional durante a implantação, mas o item de alertas não
está homologado enquanto ela não estiver configurada e testada.

Variáveis disponíveis:

```env
ALERT_WEBHOOK_URL=https://endereco-secreto-do-canal
ALERT_WEBHOOK_BEARER_TOKEN=
ALERT_SERVICE_NAME=ComandaFacil
ALERT_ENVIRONMENT=production
ALERT_COOLDOWN_MS=900000
ALERT_5XX_THRESHOLD=5
ALERT_5XX_WINDOW_MS=300000
ALERT_QUEUE_STUCK_MS=180000
ALERT_QUEUE_CHECK_INTERVAL_MS=60000
ALERT_WEBHOOK_TIMEOUT_MS=5000
```

Consulte `docs/alertas-operacionais.md` para configuração, segurança,
homologação do canal e monitor externo de `/ready`.

## Segredos por ambiente e rotação

Os valores reais de produção ficam exclusivamente em `Render > Environment`. Não crie nem envie um arquivo `.env.production` ao servidor.

Modelos sem valores reais:

- `.env.development.example`;
- `.env.test.example`;
- `.env.production.example`.

Regras e inventário: `docs/segredos-por-ambiente.md`.

Procedimentos de troca e revogação: `docs/rotacao-segredos.md`.

Antes de commit ou deploy, execute:

```bash
npm run audit:secrets
```

O comando verifica arquivos `.env` rastreados, modelos com valores secretos, padrões de credenciais reais em arquivos versionados e a presença da documentação de rotação. Ele nunca imprime os valores do `.env` local.

## Item 20 — privacidade e retenção

A revisão técnica está documentada em `docs/privacidade-retencao.md`. Execute `npm run audit:privacy` para a revisão estática. A contagem opcional no banco exige `ALLOW_READONLY_AUDIT=true` e não realiza escrita nem exibe dados pessoais.

A revisão não habilita exclusão automática. Os prazos de pedidos, print jobs, auditoria, funcionários, logs e backups precisam de validação jurídica, contábil/fiscal e trabalhista antes da implantação de anonimização ou descarte.
