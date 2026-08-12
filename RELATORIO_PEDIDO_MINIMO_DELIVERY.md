# Pedido mínimo de Delivery por cidade

## O que foi adicionado

Cada cidade de entrega agora possui quatro configurações financeiras:

1. **Taxa normal de entrega** — já existia e continua sendo usada normalmente.
2. **Pedido mínimo para delivery** — `R$ 0,00` significa sem mínimo.
3. **Regra abaixo do mínimo**:
   - `Não aceitar o delivery`;
   - `Aceitar com taxa especial`.
4. **Taxa especial abaixo do mínimo** — usada somente no segundo modo e substitui temporariamente a taxa normal.

## Exemplos

### Cidade A — bloquear abaixo do mínimo

- Taxa normal: R$ 7,00
- Pedido mínimo: R$ 30,00
- Abaixo do mínimo: Não aceitar

Pedido de R$ 20,00:
- catálogo mostra aviso;
- informa que faltam R$ 10,00;
- backend recusa o envio mesmo se o navegador for adulterado.

Pedido de R$ 30,00 ou mais:
- pedido aceito;
- taxa de entrega aplicada: R$ 7,00.

### Cidade B — aceitar com taxa especial

- Taxa normal: R$ 8,00
- Pedido mínimo: R$ 40,00
- Abaixo do mínimo: Aceitar com taxa especial
- Taxa especial: R$ 20,00

Pedido de R$ 25,00:
- pedido é aceito;
- catálogo avisa que está abaixo do mínimo;
- taxa aplicada: R$ 20,00.

Pedido de R$ 40,00 ou mais:
- taxa volta automaticamente para R$ 8,00.

## Segurança

A regra é recalculada no servidor usando:

- cidade ativa da própria loja;
- preços atuais dos produtos;
- adicionais atuais;
- quantidade real;
- pedido mínimo salvo no MongoDB;
- taxa normal/taxa especial salva no MongoDB.

O navegador não envia nem controla o pedido mínimo nem a taxa aplicada. Alterações por F12 não conseguem burlar a regra.

## Compatibilidade

Cidades antigas que ainda não possuem os novos campos continuam funcionando como antes:

- pedido mínimo = R$ 0,00;
- sem bloqueio;
- taxa normal preservada.

Não é necessária migração manual do MongoDB.

## Arquivos principais alterados

- `src/models/painelModels.js`
- `src/services/cidadeEntregaService.js`
- `src/controllers/adminRealController.js`
- `src/views/admin-real.ejs`
- `src/views/catalogo-publico.ejs`

Também foram atualizados/adicionados testes de regressão.

## Validação executada

- 21/21 testes direcionados de cidades, taxa de entrega e pedido mínimo aprovados.
- 150 arquivos JavaScript aprovados em `node --check`.
- JavaScript principal embutido no catálogo validado após substituição segura dos placeholders EJS.
