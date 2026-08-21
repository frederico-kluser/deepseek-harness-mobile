# M3 — Desligar pelas duas superfícies (5 min)

**Objetivo:** o kill switch pelo bot E pelo painel, com paridade de estado. Fonte: [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) linhas 1724-1735.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | Com o túnel `READY`, `/desligar` pelo bot | Pede confirmação, não executa direto. O botão é identificado pelo **texto** (`⛔ Desligar`) | ☐ | — |
| 2 | Confirmar | Estado `STOPPING` → `STOPPED` em ≤5 s | ☐ | tempo |
| 3 | Recarregar a URL no celular | Erro de conexão / 530 | ☐ | — |
| 4 | `ps aux \| grep cloudflared` | Nenhum processo | ☐ | — |
| 5 | Ligar pela UI; desligar pelo bot | Ambas as superfícies mostram o mesmo estado e o mesmo `seq` | ☐ | o `seq` |
| 6 | Ligar pelo bot; observar a UI **sem** recarregar | Atualiza sozinha | ☐ | — |
| 7 | Apertar o mesmo botão de confirmação de novo | "expirado/já usado", sem segundo efeito | ☐ | — |
| 8 | Apertar "ligar" com o túnel já ligado | Repete a URL vigente; nenhum processo novo | ☐ | — |

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar:
