# Segredos separados por ambiente

## Objetivo

O ComandaFácil usa credenciais diferentes em desenvolvimento, testes e produção. Nenhum valor secreto deve ser copiado de um ambiente para outro, armazenado no Git ou enviado por chat, captura de tela, log ou relatório.

## Fontes de configuração

| Ambiente | Fonte permitida | Fonte proibida |
|---|---|---|
| Desenvolvimento | `.env` local ignorado pelo Git, baseado em `.env.development.example` | Render, credenciais reais de produção, arquivo rastreado |
| Testes | valores falsos injetados pelos próprios testes; banco descartável quando necessário | `.env` de desenvolvimento, Render, webhook/SMTP/pagamento reais |
| Produção | `Render > Environment` | `.env.production`, arquivo no repositório, valor escrito em comando versionado |

Os arquivos `.env.development.example`, `.env.test.example` e `.env.production.example` são apenas inventários sem segredos. Eles podem ser rastreados pelo Git.

## Regras obrigatórias

1. `NODE_ENV` identifica o comportamento técnico, mas não transforma uma credencial em segura. Cada ambiente precisa de valores próprios.
2. O banco de desenvolvimento usa usuário, senha e banco diferentes da produção.
3. Testes automatizados não enviam e-mail, pagamento, upload ou alerta real.
4. O Render guarda somente valores de produção.
5. URLs de webhook são segredos: quem possui a URL consegue publicar no canal.
6. Flags `ALLOW_*` permanecem `false` e são habilitadas somente durante uma operação controlada.
7. Backups, arquivos `.env`, chaves privadas e relatórios que contenham dados reais ficam fora do Git.

## Inventário

### Segredos críticos

| Variável ou credencial | Desenvolvimento | Testes | Produção |
|---|---|---|---|
| `CONNECTIONSTRING` | usuário e banco de desenvolvimento | banco descartável ou mock | usuário e banco de produção no Render |
| `SESSION_SECRET` | valor aleatório exclusivo | valor falso gerado pelo teste | valor aleatório exclusivo no Render |
| `TOKEN_ENCRYPTION_KEY` | chave exclusiva | chave falsa gerada pelo teste | chave exclusiva no Render |
| `AVALIACAO_AUDIT_SALT` | valor exclusivo | valor falso | valor exclusivo no Render |
| `MERCADO_PAGO_ACCESS_TOKEN` | credencial de teste | mock | credencial real da plataforma |
| `MERCADO_PAGO_WEBHOOK_SECRET` | segredo do webhook de teste | mock | segredo real do webhook |
| `MP_CLIENT_SECRET` | aplicativo de teste | mock | aplicativo de produção |
| `CLOUDINARY_API_SECRET` | conta/pasta de desenvolvimento ou vazio | mock | segredo real no Render |
| `SMTP_PASS` | conta de desenvolvimento/captura | mock | senha de aplicativo de produção |
| `ALERT_WEBHOOK_URL` | webhook de desenvolvimento ou vazio | vazio/mock | webhook privado do Discord no Render |
| `ALERT_WEBHOOK_BEARER_TOKEN` | token de desenvolvimento ou vazio | vazio/mock | token do endpoint próprio, quando usado |

### Configurações sensíveis ao ambiente

Não são necessariamente senhas, mas não devem ser copiadas sem revisão:

- `APP_URL`, `ALLOWED_ORIGINS`, `MP_REDIRECT_URI`;
- `MERCADO_PAGO_PUBLIC_KEY`, `MERCADO_PAGO_PLATFORM_USER_ID`, `MP_CLIENT_ID`;
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`;
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`;
- `ALERT_ENVIRONMENT`, `RATE_LIMIT_STORE`, `STORAGE_DRIVER`;
- `PLATFORM_PIX_FEE_ENABLED`, `PLATFORM_PIX_FEE_PERCENT`.

## Agente de impressão

O token do agente não deve ser copiado entre lojas ou ambientes. A rotação é feita revogando/revinculando o agente e gerando um novo código de vínculo. O token não deve ser colocado em `.env` nem compartilhado manualmente.

## Fluxo local seguro

1. Copiar `.env.development.example` para `.env`.
2. Preencher somente credenciais de desenvolvimento.
3. Confirmar que `.env` está ignorado:

```bash
git check-ignore -v .env
```

4. Executar a auditoria:

```bash
npm run audit:secrets
```

5. Antes de qualquer commit, conferir:

```bash
git status --short
git diff --cached --check
```

## Produção no Render

- Cada segredo é cadastrado individualmente em `Environment`.
- Valores nunca são copiados para `.env.production`.
- Alterações são aplicadas em deploy controlado.
- Depois do deploy, validar `/ready`, login, pedido, pagamento, e-mail, upload, impressão e alertas conforme o segredo alterado.
- O valor antigo só é revogado depois da validação do novo.

## Testes

Os testes devem criar e restaurar `process.env` dentro do próprio processo. Quando uma integração real for indispensável, use conta de teste separada e uma flag `ALLOW_*` temporária. O padrão continua sendo nenhuma chamada externa real.
