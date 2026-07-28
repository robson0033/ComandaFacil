# Ambiente de produção

O projeto usa Node.js 20.19.x e npm 10.x. Para preparar o ambiente local:

```bash
nvm install 20.19.5
nvm use
npm install -g npm@10
npm ci
```

## Variáveis obrigatórias

Em todos os ambientes:

- `NODE_ENV`: `development`, `test` ou `production`;
- `PORT`;
- `CONNECTIONSTRING`;
- `SESSION_SECRET`, com no mínimo 32 caracteres;
- `APP_URL`.

Em produção também são obrigatórias:

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

Nunca registre os valores dessas variáveis. O nome legado `SECRETSESSION` não é
usado no novo boot; configure `SESSION_SECRET`.

Um adaptador customizado continua opcional com `STORAGE_DRIVER=external`,
`STORAGE_EXTERNAL_PROVIDER`, `STORAGE_EXTERNAL_BASE_URL` e
`STORAGE_EXTERNAL_ADAPTER_MODULE`. Não existe fallback para disco local em
produção.

O `MemoryStore` só pode ser usado fora de produção com
`ALLOW_MEMORY_SESSION=true`. Quando MongoDB estiver disponível, o sistema usa o
mesmo cliente Mongoose no `connect-mongo`.

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

## Health checks

- `GET /health`: confirma que o processo responde; não consulta o banco.
- `GET /ready`: retorna 200 somente após ambiente, MongoDB, store de sessão,
  workers e listener HTTP estarem prontos. Durante boot ou shutdown retorna 503.

Ambas as respostas usam `Cache-Control: no-store` e não expõem configuração.

## Encerramento

`SIGTERM` e `SIGINT` retiram a aplicação do estado pronto, bloqueiam novos
trabalhos de impressão, encerram reconciliadores, rate limiters, SSE, Socket.IO,
HTTP, store de sessão e Mongoose. Há limite máximo de 25 segundos. Erros fatais
(`uncaughtException` e `unhandledRejection`) usam o mesmo fluxo e código de saída
1.
