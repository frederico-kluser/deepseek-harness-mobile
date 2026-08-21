# TROUBLESHOOTING.md — sintoma → causa → o que fazer

Guia de resolução, ordenado por sintoma. Lê o sintoma, confere a causa e segue o
"o que fazer". Quando um passo envolve um [roteiro manual][manual], ele está em
`docs/manual-runs/`.

[manual]: manual-runs/README.md

## 1. O arranque falha ou o DSH não sobe

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| O plugin "grita" no load a dizer que o bind está fora da allowlist | O endereço de bind foi alargado (ex.: `--host 0.0.0.0`) ou um patch de camada superior o reabriu | Volta o bind a loopback; audita `$DSH_HOME/cordis.patch.yml` e `--patch` da CLI. O plugin **não** arranca degradado em silêncio em decisões de segurança. |
| A Fiber fica PENDING para sempre | Adicionaste `logger` ao `inject` | Não faças. `ctx.logger` está acessível sem injecção; `LoggerService` não é `Service`, entra como propriedade própria do Context e `ctx.get` devolve undefined para ele (ver `src/index.ts:344-364`). |
| O estado abre corrompido | `state.json` foi reescrito de forma não atómica, ou tem modo maior que 0600 | O `StateStore` é o único writer e recusa carga com erro acionável. Não uses editor no ficheiro do estado vivo; apaga-o e re-roda o setup se quiseres recomeçar. |

## 2. O portão não responde 401

| Sintoma | Causa provável | O que fazer |
| `curl /api` devolve `200` sem credencial | O plugin não instalou a barreira, ou um patch superior o anulou | Confirma que o `guarded-bot-orchestrator` é a única entrada ativa e que nenhum `http/auth-check` anterior devolve true. O `next` terminal repete a verificação (fail-closed quando não há ouvintes). Ver `docs/INSTALL.md` Passo 3. |
| Devolve `403` em vez de 401 | A origem da conexão está fora de `trustedRemotes` — não é a credencial | O 403 é "repetir a senha não ajuda". Verifica de onde o pedido vem (loopback esperado). |
| A SPA pede senha mas `/api` responde sem credencial | `guardedPrefixes` não cobre o que julgavas | Cada prefixo tem de começar por `/`. O fallback da SPA é guardado incondicionalmente. |

## 3. O túnel não sobe ou a URL não vem

| Sintoma | Causa provável | O que fazer |
| Demora mais de 30 s e não há URL | `cloudflared` sem rede/instalação, ou o probe falhou | Verifica o `cloudflared` por checksum (`docs/INSTALL.md` Passo 0). O probe fail-closed aborta se qualquer sonda não der 401. |
| A URL muda a cada vez | Comportamento normal do quick tunnel | Hostname novo a cada reinício. É do produto, não defeito. |
| O browser mostra `530` | O túnel caiu (TTL, kill, reinício) | Recarrega a URL ou liga de novo (URL nova). |
| `ps aux` mostra 2 `cloudflared` | Duas instâncias | Deve haver exatamente 1. Se o deixaste ligado numa sessão e ligaste noutra, derruba e liga de novo. |

## 4. O bot do Telegram

| Sintoma | Causa provável | O que fazer |
| O bot não responde a `/ligar` | Não pareaste o teu chat | `docs/ONBOARDING-TELEGRAM.md`: correr `dsh-guard-setup` e `/parear`. |
| `409 Conflict: terminated by other getUpdates request` | Há uma segunda instância de long-polling no mesmo token | Encontra-a e fecha-a. Duas instâncias no mesmo token conflitam. |
| `429` com `retry_after` | Rate limit da Bot API | O worker lê `retry_after` e recua sozinho. Se insistires, espera. |
| O comando confirmado gera "expirado/já usado" | O nonce/confirmação foi consumido | É o esperado: cada confirmação serve uma vez. Ação que aumenta exposição exige confirmação em duas etapas. |

## 5. Segurança / acessos estranhos

| Sintoma | Causa provável | O que fazer |
| Respostas `401` idênticas e depois lentidão | Rate limit / ban em progresso | Não há sinal delatado: o 401 é byte a byte idêntico. Espera; o ban não é permanente para a única conta. |
| `X-Forwarded-For` não faz efeito | `trustEdgeHeaders: false` (omissão) | Por omissão o plugin não acredita em headers de borda — o `X-Forwarded-For` é forjável. A identidade do rate limit é do socket. |
| Encontra-se um túnel "nu" (200 sem senha) | O probe não correu antes da URL | Se acontecer, para e reporta como grave: é o cenário que o probe fail-closed existe para impedir. |

## 6. Reverter / desinstalar

Ver `docs/INSTALL.md` §Desinstalar e reverter. Resumo:

```sh
dsh plugin remove dsh-guarded-bot-orchestrator
```

Deixa zero processos e a UI volta ao original. Para apagar também os dados locais, remove
`~/.dsh/guarded-bot` (irá apagar a senha, o pareamento e o estado).

## 7. Reportar um problema

Nunca abras issue pública com segredos. Redige logs e inclui: versão do plugin, rc do DSH,
Node, SO e o caminho exato do pedido. Ver `SECURITY.md`.

## Síntese do ciclo de vida a testar nos roteiros manuais

O `docs/TESTING.md` lista as quatro fronteiras de teste; os roteiros M1..M7 em
`docs/manual-runs/` são a camada manual pré-release.
