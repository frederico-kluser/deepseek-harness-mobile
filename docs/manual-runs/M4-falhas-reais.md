# M4 — Falhas reais (7 min)

**Objetivo:** o comportamento sob falha real de rede/processo. Fonte: [`docs/plano/04-TESTES.md §9`](../plano/04-TESTES.md) linhas 1737-1746.

| # | Passo | Critério | Resultado | O que anotar |
| --- | --- | --- | --- | --- |
| 1 | Com o túnel `READY`, `kill -9` no `cloudflared` | Estado vai a `DEGRADED`; reinício com backoff; **URL nova** comunicada ao dono. Esgotado o orçamento, `FAILED` e não re-tenta | ☐ | backoff observado |
| 2 | Desligar o Wi-Fi por 30 s | Reconecta sozinho ao voltar, ou reporta orçamento esgotado com clareza | ☐ | — |
| 3 | Rodar uma segunda instância do bot em outro terminal | 409 `terminated by other getUpdates request`; a mensagem no log é **compreensível**, não um dump | ☐ | a linha |
| 4 | Renomear o binário do `cloudflared` e tentar `/ligar` | Erro imediato (ENOENT, não-retryable); **sem** crash-loop | ☐ | — |
| 5 | Preencher o disco do diretório de estado (ou `chmod 000`) | Falha clara; o plugin não sobe com estado corrompido | ☐ | — |
| 6 | `kill -9` no processo do DSH inteiro | Verificar com `ps` se sobrou `cloudflared` ou worker órfão (dead-man's switch) | ☐ | `ps` |

**Resultado global:** ☐ PASSOU ☐ FALHOU  — nota/issue se falhar:
