# M6 — Streaming e canal de downlink (5 min)

**Objetivo:** validar o streaming de token pelo túnel e identificar o canal de downlink.
Existe por causa de uma alegação **refutada** pela pesquisa sobre a falta de suporte de SSE no túnel (detalhe e refutação: [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) linhas 1763-1774) —
que não pode ser aceite nem descartada de papel.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | Pelo túnel, pedir ao agente uma resposta longa | Tokens aparecem **incrementalmente**, não de uma vez no fim | ☐ | — |
| 2 | No DevTools, identificar o canal do downlink | Confirmar se é WebSocket (esperado, `src/index.ts:935`) ou SSE | ☐ | qual |
| 3 | Se for SSE por **GET** | Esperar bufferização (bug conhecido do edge, cloudflared #1449). Registar e escalar | ☐ | — |
| 4 | Se for SSE por **POST** | Streaming funciona (medido: eventos a cada ~0,5 s, espaçamento igual ao da origem) | ☐ | — |
| 5 | Sessão de 10 min com uso contínuo | Sem queda. Lembrar do teto de 200 requisições em voo do quick tunnel (acima disso, 429) | ☐ | — |

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar:
