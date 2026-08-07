# Revisão técnica de privacidade e retenção — Item 20

Data da revisão: 4 de agosto de 2026.

Este documento registra o estado técnico encontrado no ComandaFácil. Ele não substitui análise jurídica, contábil, fiscal ou trabalhista. Nenhum prazo de descarte deve virar exclusão automática antes de validação formal e backup testado.

## Escopo

A revisão cobriu dados de proprietários, clientes e funcionários, incluindo CPF/CNPJ, telefone, endereço, e-mail, salário, fotos, pedidos, snapshots de impressão, sessões, recuperação de senha, OAuth, auditoria, logs e backups.

## Controles já existentes

- isolamento multi-tenant por `estabelecimentoId`;
- permissões específicas para pedidos, funcionários, configurações e impressão;
- senhas armazenadas com hash;
- tokens do Mercado Pago criptografados e fora das seleções comuns;
- token público de acompanhamento armazenado apenas como hash e com validade limitada;
- resposta pública de pedidos baseada em lista permitida, sem telefone, e-mail, observações internas ou histórico financeiro;
- endereço público mascarado;
- TTL para sessão, estado OAuth e registros temporários de recuperação;
- auditoria interna com lista permitida para `dadosResumidos`;
- logger estruturado com remoção de segredos e, após esta revisão, também de e-mail, CPF/CNPJ, telefone, endereço, cliente, IP e user-agent em campos reconhecidos;
- alertas operacionais sem conteúdo integral de cliente.

## Achados que exigem retenção definida

### Pedidos e dados de clientes — risco alto

A coleção `pedidos` guarda nome, telefone, e-mail opcional, endereço estruturado e referência. O arquivamento atual é lógico e preserva os dados. Não existe anonimização automática.

Ação segura nesta etapa: manter o sistema sem exclusão automática, medir o volume por faixa de idade e definir com contador/jurídico quando os dados identificáveis deixam de ser necessários. Depois da aprovação do prazo, a implementação deve preferir anonimização dos campos pessoais, preservando dados financeiros e operacionais mínimos quando houver obrigação de conservação.

### Fila de impressão — risco alto

`printjobs` pode manter snapshots com telefone e endereço. A fila precisa de histórico para reconciliação, mas não deve funcionar como arquivo permanente de dados de entrega.

Ação recomendada: definir prazo curto após o estado terminal e, depois, remover ou anonimizar o snapshot. Jobs em estados pendentes, entregando ou desconhecidos não podem ser removidos automaticamente.

### Funcionários — risco alto

A coleção `funcionarios` guarda CPF, e-mail, telefone, endereço, salário e foto. A exclusão é manual. Os prazos trabalhistas e de defesa de direitos devem ser validados antes de automatizar descarte.

Ação recomendada: ao encerrar o vínculo, desativar imediatamente o acesso, encerrar sessões, registrar a decisão e aplicar a política aprovada de bloqueio, anonimização ou exclusão. Fotos e arquivos externos precisam entrar no mesmo procedimento.

### Proprietários e CPF/CNPJ — risco alto

`registros` guarda CPF/CNPJ em texto normal para cadastro e unicidade. Esse dado deve ficar restrito ao menor número possível de telas, permissões e processos. Uma futura migração para criptografia com hash auxiliar de busca deve ser planejada separadamente, com backup, migração e rollback; não foi aplicada neste item para evitar risco de indisponibilidade ou quebra de unicidade.

### Auditoria — risco médio

`auditoriaeventos` usa resumo por lista permitida, mas não possui TTL. O prazo deve equilibrar segurança, rastreabilidade e minimização.

### Backups e logs — risco alto

O backup contém dados reais e fica fora do Git. Deve existir calendário de expiração, cópia protegida, controle de acesso e descarte seguro. Logs no Render ou em qualquer provedor externo precisam de prazo configurado no próprio provedor.

## Matriz técnica atual

| Classe | Finalidade | Expiração atual | Próxima decisão |
|---|---|---:|---|
| Sessões | autenticação | automática/TTL | manter e revisar duração |
| OAuth state | proteger autorização | automática/TTL | manter |
| Recuperação de senha | redefinir acesso | automática/TTL | manter |
| Token público do pedido | acompanhamento | hash e validade limitada | manter; pedido continua retido |
| Pedidos/clientes | execução, suporte e conciliação | sem anonimização automática | validar prazo e estratégia |
| Print jobs | impressão e reconciliação | sem TTL central | prazo curto após estado terminal |
| Funcionários | acesso e gestão de equipe | exclusão manual | validar prazo trabalhista |
| Proprietários/CPF-CNPJ | conta e contrato | ciclo da conta | restringir e planejar criptografia |
| Auditoria | segurança e rastreabilidade | sem TTL | validar prazo |
| Backups | recuperação de desastre | manual | calendário e descarte seguro |
| Logs | diagnóstico e segurança | provedor | configurar retenção externa |

## Auditoria sem escrita

O comando abaixo faz a revisão estática e não conecta ao banco:

```bash
npm run audit:privacy
```

Para contar apenas quantos registros estão acima dos limites técnicos de triagem, sem exibir IDs ou dados pessoais:

```bash
ALLOW_READONLY_AUDIT=true npm run audit:privacy
```

Os limites são apenas marcadores de auditoria, não prazos legais nem comandos de exclusão. Podem ser ajustados pelas variáveis:

```text
PRIVACY_AUDIT_ACTIVE_ORDER_DAYS
PRIVACY_AUDIT_ARCHIVED_ORDER_DAYS
PRIVACY_AUDIT_PRINT_JOB_DAYS
PRIVACY_AUDIT_EVENT_DAYS
PRIVACY_AUDIT_INACTIVE_EMPLOYEE_DAYS
```

## Processo para solicitação de titular

1. confirmar identidade e legitimidade do solicitante sem pedir dados excessivos;
2. identificar se o ComandaFácil atua como controlador ou operador naquele conjunto de dados;
3. localizar dados por tenant e finalidade;
4. separar dados que podem ser corrigidos, exportados, bloqueados, anonimizados ou eliminados;
5. preservar apenas o que tiver obrigação aplicável ou necessidade de exercício de direitos;
6. registrar a decisão sem inserir dados pessoais desnecessários no log;
7. considerar cópias em backups e o ciclo de expiração desses backups.

## Pendências operacionais antes da aprovação jurídica

- publicar identificação legal e canal específico de privacidade na Política de Privacidade;
- validar prazos com contador e profissional jurídico;
- definir quem aprova solicitações de titulares;
- definir retenção de logs no Render e de backups fora do sistema;
- homologar uma rotina futura de anonimização em banco restaurado antes de produção;
- documentar incidente, comunicação e evidências.

## Critério do checklist

A revisão técnica do item 20 é considerada concluída quando:

```text
MAPA_DE_DADOS=CONCLUIDO
CONTROLES_EXISTENTES=REGISTRADOS
LACUNAS_DE_RETENCAO=REGISTRADAS
LOGS_COM_REMOCAO_DE_DADOS_PESSOAIS=SIM
AUDITORIA_SOMENTE_LEITURA=SIM
EXCLUSAO_AUTOMATICA_SEM_VALIDACAO=NAO
VALIDACAO_JURIDICA_DOS_PRAZOS=PENDENTE
ITEM_20_REVISAO_TECNICA_OK=SIM
```

A LGPD prevê o término do tratamento e hipóteses específicas de conservação. A ANPD também reconhece direitos de acesso, correção, anonimização, bloqueio e eliminação quando cabíveis. Referências oficiais:

- https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm
- https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados-1/direito-dos-titulares
- https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte
