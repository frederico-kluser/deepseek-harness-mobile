# M7 — Ciclo de vida (3 min)

**Objetivo:** o comportamento no reload/desativação do plugin. Fonte: [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) linhas 1776-1782.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | Recarregar o plugin (HMR do DSH) com o túnel ligado | Comportamento **documentado** ocorre (derruba e reabre com URL nova, **ou** recusa com motivo) — nunca dois túneis | ☐ | qual |
| 2 | `ps` após o reload | Um `cloudflared`, um worker do bot. Nada duplicado | ☐ | — |
| 3 | Desativar o plugin no perfil e reiniciar o DSH | Nenhum processo remanescente; a Web UI do DSH volta ao comportamento original (sem portão) | ☐ | — |

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar:
