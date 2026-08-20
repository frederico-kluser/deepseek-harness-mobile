# Máquina de estados do controlador (COMMIT PREP 5)

Diagrama e tabela congelados junto com `src/contracts/control.ts`. A **fonte
normativa** das transições é a tabela de `01-ARQUITETURA.md` §6, transcrita no
contrato como `TRANSICOES_LEGAIS`. O diagrama abaixo (03-ONDAS.md §10) é
ilustrativo; onde divergir da tabela, **vale a tabela** — as duas divergências
estão resolvidas e documentadas no contrato:

1. o diagrama desenha `STOPPING --falha--> FAILED` — a tabela não o lista e a
   borda **não existe**: `STOPPING` só sai para `STOPPED` (fail-closed: nunca
   se declara STOPPED um túnel que pode estar vivo);
2. o diagrama desenha `DEGRADED --backoff esgotou sem sucesso--> STOPPED` — a
   tabela não o lista e a borda **não existe**: a saída do `DEGRADED` é
   `FAILED` (orçamento esgotado) ou `STARTING` (re-tentativa).

```
        ┌──────────────┐  start()   ┌───────────┐  url pronta  ┌────────┐
        │   STOPPED    │───────────►│ STARTING  │─────────────►│ READY  │
        └──────────────┘            └───────────┘              └────────┘
              ▲   ▲                       │ falha                   │ stop()
              │   │                       ▼                         │ TTL expira
              │   │                 ┌────────────┐                  ▼
              │   └─────────────────│  DEGRADED  │◄─────────────┌───────────┐
              │   backoff esgotou   └────────────┘  morte súbita │ STOPPING  │
              │   sem sucesso            │ ▲  │                  └───────────┘
              │                          │ └──┘ re-tenta               │
              │                          │  (há orçamento)             │ falha
              │              orçamento    ▼                            ▼
              │              esgotado  ┌──────────┐                    │
              └────────────────────────│  FAILED  │◄───────────────────┘
                     reset()           └──────────┘
```

## Tabela normativa (transcrita em `TRANSICOES_LEGAIS`)

| De | Para | Gatilho |
| --- | --- | --- |
| STOPPED | STARTING | `start()` por bot\|UI (pre-condições: `exposure.mode: 'tunnel'`, segredo forte válido, probe L1 fail-closed passou) |
| STARTING | READY | URL em `/quicktunnel` **e** probe local responde |
| STARTING | DEGRADED | falha: timeout de readiness (≥30 s) ou `close` do processo |
| READY | DEGRADED | `close`/`error` do `cloudflared` |
| DEGRADED | STARTING | re-tentativa automática com backoff (orçamento não esgotado) |
| DEGRADED | FAILED | orçamento esgotado |
| STOPPED / STARTING / DEGRADED | FAILED | erro não-retryable (`ENOENT`, `EACCES`, config inválida) — CTL-013: sem passar por `STARTING` |
| READY / STARTING / DEGRADED | STOPPING | `stop()` por bot\|UI\|disposer **ou** TTL expirado |
| STOPPING | STOPPED | processo confirmado morto |
| FAILED | STOPPED | `reset()` explícito do dono — único caminho de saída |

## Transições de intent (não mudam de estado — idempotência e recusa)

- `start` em `STARTING`/`READY`: no-op idempotente; a resposta repete a URL vigente (CTL-002/003).
- `stop` em `STOPPED`: no-op idempotente (CTL-004).
- `start` em `STOPPING`: **rejeitado** com `SHUTDOWN_IN_PROGRESS`, sem fila (D29/CTL-007).
- `start` em `FAILED`: recusado com motivo — terminal é terminal (CTL-011).
- `start` com modo restrito ativo: recusado, nenhum spawn (CTL-015).
- `start` sem segredo forte: recusado (CTL-009).

## Decisão estruturante (03-ONDAS §10)

Existe **um único dono do estado**: `src/control/controller.ts` (T5.1).
Telegram, painel e UI nativa são **superfícies** — projeções — e nenhuma delas
chama o supervisor de túnel diretamente: toda superfície emite um
`ControlIntent` contra o controlador. É isso que torna T5.2/T5.3/T5.5
paralelizáveis com risco zero de estado divergente.

## Os seis estados (vocabulário em `src/contracts/tunnel.ts`, PREP 3)

`STOPPED | STARTING | READY | DEGRADED | STOPPING | FAILED` — em inglês em
código, teste e payload IPC; os rótulos em português existem só como texto de
UI ("desligado", "ligando", "online", "instável, tentando de novo",
"desligando", "falhou — precisa de ação sua").
