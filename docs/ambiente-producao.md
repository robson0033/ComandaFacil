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

- `STORAGE_DRIVER=external`;
- `STORAGE_EXTERNAL_PROVIDER` (`s3` ou `cloudinary`);
- `STORAGE_EXTERNAL_BASE_URL`;
- `STORAGE_EXTERNAL_ADAPTER_MODULE`;
- `MERCADO_PAGO_ACCESS_TOKEN`;
- `MERCADO_PAGO_PUBLIC_KEY`;
- `MERCADO_PAGO_WEBHOOK_SECRET`;
- `MERCADO_PAGO_PLATFORM_USER_ID`;
- `MP_CLIENT_ID`, `MP_CLIENT_SECRET` e `MP_REDIRECT_URI`;
- `TOKEN_ENCRYPTION_KEY`;
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM`.

Nunca registre os valores dessas variáveis. O nome legado `SECRETSESSION` não é
usado no novo boot; configure `SESSION_SECRET`.

O `MemoryStore` só pode ser usado fora de produção com
`ALLOW_MEMORY_SESSION=true`. Quando MongoDB estiver disponível, o sistema usa o
mesmo cliente Mongoose no `connect-mongo`.

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
