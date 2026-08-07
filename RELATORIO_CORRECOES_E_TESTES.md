# Relatório de correções e testes — Comanda Fácil

Data da revisão: 02/08/2026

## Situação final

As correções de código identificadas na auditoria foram aplicadas ao projeto. O pacote entregue contém o projeto completo corrigido e um segundo ZIP com somente os arquivos modificados.

A liberação pública ainda depende de validações externas que não podem ser concluídas neste ambiente: instalação limpa das dependências, auditoria do registro npm, conexão com o MongoDB de produção, integrações reais e impressora física.

## Correções aplicadas

### Runtime, instalação e CI

- Runtime fixado em Node.js `24.18.1` por `.nvmrc` e `package.json`.
- Faixas de Node e npm declaradas em `engines`.
- Pipeline de CI criado em `.github/workflows/ci.yml`.
- Scripts adicionados para sintaxe, testes, auditoria e migração de índices.
- `.gitignore` e `.env.example` adicionados.
- Documentação e checklist de produção atualizados.
- Arquivo incorreto chamado `node_modules` removido do projeto.
- Imagens locais de teste removidas de `public/uploads`; os diretórios permanecem com `.gitkeep`.

### Segurança e abuso

- Rate limit adicionado a login, cadastro, recuperação de senha, pedidos públicos, pagamentos, OAuth e webhooks.
- Em produção, o rate limit usa MongoDB compartilhado e falha de forma segura se o armazenamento ficar indisponível.
- Identificadores usados no rate limit são armazenados como SHA-256, não em texto puro.
- Proteção de mesma origem/CSRF adicionada aos formulários anônimos e pedidos públicos.
- Limites explícitos de tamanho para corpos JSON e formulários.
- Cabeçalho `X-Powered-By` removido.
- Socket.IO passou a usar todas as origens autorizadas.
- Política de senha elevada para 12 a 64 caracteres, respeitando o limite de bytes do bcrypt e bloqueando senhas comuns.
- Logger estruturado com remoção de segredos, tokens, senhas e credenciais.
- CSP reforçada com nonce para elementos `<style>`.

Observação: `style-src-attr 'unsafe-inline'` foi preservado porque a interface existente ainda possui muitos atributos `style` dinâmicos. Removê-lo nesta etapa exigiria uma refatoração visual ampla e teria risco alto de regressão.

### Pedidos públicos

- Quantidade validada como número inteiro entre 1 e 99.
- Bloqueio de `Infinity`, decimais, números negativos e valores excessivos.
- Limite de 50 linhas de itens, 200 unidades totais e 20 adicionais por item.
- Limites de tamanho aplicados a nome, telefone, e-mail, endereço e observações.
- Idempotência adicionada à criação de pedidos do catálogo e da mesa.
- Reenvio legítimo da mesma solicitação retorna o pedido já criado.
- Reutilização da mesma chave com conteúdo diferente retorna conflito `409`.
- Índice único parcial criado para impedir duplicação no banco.
- Token de acompanhamento passou a ser determinístico para o mesmo pedido idempotente.
- Código antigo e não utilizado de criação de pedido removido.

### MongoDB e prontidão

- Novo índice de idempotência incluído no script de migração.
- Inicialização em produção verifica a presença e equivalência dos índices críticos.
- O servidor não fica pronto para tráfego se os índices necessários estiverem ausentes ou divergentes.
- O endpoint de prontidão agora acompanha o estado dos índices.
- `WEB_CONCURRENCY=1` é exigido enquanto a conexão em tempo real com o agente de impressão permanecer vinculada a uma única instância.

### Interface e estoque

- Quantidades restantes em kg passaram a ser formatadas sem resíduos de ponto flutuante.
- Exemplo: `7.8400000000000003 kg` aparece como `7,84 kg`.
- A correção funciona tanto nas opções renderizadas pelo servidor quanto nas adicionadas dinamicamente no navegador.

## Testes executados

### Verificação de sintaxe

Resultado:

```text
118 arquivos JavaScript aprovados
0 erros de sintaxe
```

### Testes novos de endurecimento

Resultado:

```text
12 testes executados
12 aprovados
0 falhas
```

Eles cobrem:

- política de senha;
- quantidades e limites de pedidos;
- UUID de idempotência;
- hash e token determinísticos;
- rate limit local e MongoDB em produção;
- aplicação de rate limit e CSRF às rotas críticas;
- idempotência no navegador, controller, serviço, schema e migração;
- formatação das quantidades do estoque;
- limites do servidor e validação dos índices;
- remoção de segredos nos logs;
- CSP com nonce;
- gates de Node.js e produção.

### Suíte completa disponível no projeto

Resultado neste ambiente:

```text
140 testes contabilizados
105 aprovados
35 não puderam ser carregados
0 falhas de asserção
0 erros de sintaxe
```

As 35 ocorrências foram exclusivamente `MODULE_NOT_FOUND`, porque as dependências do projeto não puderam ser instaladas neste ambiente:

```text
mongoose: 19
express-session: 6
qrcode: 5
validator: 2
express: 1
dotenv: 1
ejs: 1
```

Portanto, essas 35 ocorrências não indicam que as regras testadas falharam; os respectivos arquivos de teste nem chegaram a iniciar.

### Instalação limpa e auditoria npm

`npm ci` foi tentado, mas o proxy de pacotes deste ambiente respondeu `404` ao arquivo `yargs-parser-18.1.3.tgz`.

`npm audit --omit=dev --audit-level=high` também foi tentado, mas o endpoint de auditoria do mesmo proxy respondeu `404`.

O ambiente de execução disponível usa Node.js `22.16.0` e npm `10.9.2`. Por isso, a validação real no Node.js 24 ficou preparada no projeto e no CI, mas não pôde ser executada aqui.

## Validações obrigatórias antes da publicação

1. Em uma máquina ou CI com Node.js 24.18.1, executar:

```bash
npm ci
npm run test:production
npm run audit:production
```

2. Fazer backup do banco e inspecionar os índices:

```bash
npm run indexes:dry-run
```

3. Após revisar o resultado, aplicar os índices:

```bash
ALLOW_INDEX_MIGRATION=true npm run indexes:apply
```

4. Reiniciar o serviço e confirmar `/health` e `/ready`.

5. Validar em homologação:

- login, logout e recuperação de senha;
- cadastro de proprietário e funcionário;
- pedido no catálogo e na mesa;
- reenvio do mesmo pedido sem duplicação;
- PIX, cartão, dinheiro e webhooks do Mercado Pago;
- envio de e-mails;
- upload e remoção no Cloudinary;
- impressão manual, automática, reconexão e retry;
- restauração de backup do MongoDB;
- logs e alertas sem exposição de segredos.

## Conclusão

O código foi endurecido e os bloqueadores identificados foram tratados. O projeto não deve ser chamado de “100% pronto para produção” até que a instalação limpa, a suíte completa, a auditoria npm, a migração no banco real e os testes das integrações externas sejam aprovados no ambiente de homologação/produção.
