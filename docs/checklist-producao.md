# Checklist de liberação para produção

## Gate automatizado

- [ ] CI executado com Node definido em `.nvmrc`.
- [ ] `npm ci` concluído sem alteração do lockfile.
- [ ] `npm run test:production` aprovado integralmente.
- [ ] `npm run audit:production` sem vulnerabilidade alta ou crítica não tratada.

## Banco de dados

- [ ] Backup recente criado.
- [ ] Restauração do backup testada em banco separado.
- [ ] `npm run indexes:dry-run` sem conflitos não resolvidos.
- [ ] `ALLOW_INDEX_MIGRATION=true npm run indexes:apply` concluído.
- [ ] Boot de produção confirma `indexesReady` e `/ready` retorna HTTP 200.

## Configuração do deploy

- [ ] `NODE_ENV=production`.
- [ ] `WEB_CONCURRENCY=1`.
- [ ] `RATE_LIMIT_STORE=mongo`.
- [ ] `APP_URL` corresponde ao domínio aberto pelo usuário.
- [ ] `ALLOWED_ORIGINS` contém somente origens HTTPS realmente utilizadas.
- [ ] OAuth e webhook usam o domínio final.
- [ ] Todos os segredos são diferentes de desenvolvimento/homologação.
- [ ] `CSRF_ORIGIN_DIAGNOSTICS` está desligado.

## Homologações externas

- [ ] Cloudinary: upload, leitura e remoção aprovados.
- [ ] SMTP: recuperação de senha entregue e links/códigos válidos.
- [ ] Mercado Pago: OAuth, Pix aprovado, recusado, expirado e webhook repetido.
- [ ] Duas lojas de teste confirmam isolamento de credenciais e dados.
- [ ] Agente testado na impressora real, inclusive offline, reconexão e retry.

## Operação

- [ ] Alertas para 5xx e indisponibilidade de `/ready`.
- [ ] Alertas para webhook inválido/falhando, fila presa e falha de e-mail.
- [ ] Política de retenção e exclusão de dados revisada.
- [ ] Responsável e procedimento de rollback definidos.
