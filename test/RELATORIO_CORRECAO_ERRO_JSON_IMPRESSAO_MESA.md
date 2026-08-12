# Correção do erro JSON ao imprimir comanda da mesa

## Sintoma

Ao clicar em **Imprimir todos os pedidos**, o navegador mostrava:

`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

Isso acontece quando o frontend chama `response.json()`, mas o servidor devolve HTML (normalmente página 404/fallback/login) em vez de JSON.

## Correção aplicada

1. O botão da comanda deixou de depender da rota nova `/admin/agente/mesas/:id/imprimir-comanda`.
2. O frontend usa a rota já existente e estável `/admin/agente/pedidos/:id/imprimir` com `scope: "mesa_comanda"`.
3. O backend detecta esse `scope`, resolve a mesa do pedido de referência e chama a mesma rotina de impressão consolidada.
4. A rota dedicada antiga foi mantida como alias para compatibilidade.
5. O frontend verifica `Content-Type` antes de interpretar a resposta como JSON; respostas HTML não provocam mais `Unexpected token '<'`.
6. Continua sendo criado um único snapshot da comanda por impressora, reunindo todos os pedidos abertos da mesa e o total geral.

## Arquivos modificados nesta correção

- `src/controllers/adminRealController.js`
- `src/views/admin-real.ejs`
- `test/mesaComandaImpressaoP0.test.js`

## Validação

- `node --check src/controllers/adminRealController.js`: aprovado.
- Função JavaScript `imprimirPedidosDaMesa` extraída do EJS e compilada com `new Function`: aprovada.
- `node --test test/mesaComandaImpressaoP0.test.js`: 4/4 aprovado.
- `npm run test:syntax`: 149 arquivos JavaScript aprovados.
- A suíte completa depende de módulos npm que não estavam instalados no ambiente de empacotamento; por isso os testes que exigem dependências externas não foram usados como critério desta correção.
