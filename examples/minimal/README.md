# examples/minimal — exemplo mínimo instalável do proxy do túnel

Um servidor Node http **guardado pelo proxy REAL do plugin** (os módulos compilados em
`dist/`). Demonstra o contrato central do projeto novo — **o acesso local abre direto; o
túnel só entra por sessão ou pela chave no link `?key=`** — sem um DeepSeek Harness
completo à volta, e sem tocar a rede. É o mínimo que prova o que o README promete.

## Critério de aceite (verificável, offline)

| Verificação | Esperado |
| --- | --- |
| acesso **local** a `GET /api/state` | abre (sem barreira, sem desafio) |
| pedido a `GET /api/state` pela superfície do **túnel** **sem** sessão e **sem** `?key=` | `401` TEXTO PURO, sem desafio de login |
| pedido **com** a **chave no link** (`/?key=<DEMO_SECRET>` ou sessão) | `200` |
| após desligar, `pgrep -f examples/minimal/server.mjs` | **vazio** (nenhum processo sobrante) |

## Correr

```sh
./run.sh        # constrói dist/ se faltar, sobe o servidor, corre o critério, desliga
# ou, em passos:
node server.mjs # sobe e imprime instruções de curl; Ctrl-C para desligar
```

Pré-requisito: Node ≥ 24 na raiz do repositório (é lá que está o `dist/`).

## O que acontece por baixo

- `server.mjs` importa `dist/http/gate.js`, `dist/http/intercept.js` e
  `dist/http/session-auth.js` — o **mesmo proxy** que o plugin usa no produto — e monta a
  barreira sobre um `node:http.Server` real em `127.0.0.1:0`.
- O modelo é o **expose-port / local-aberto**: quem autentica é a barreira do túnel. O
  valor de demonstração (`DEMO_SECRET`) ocupa o papel da **chave no link** (`?key=`), que
  no produto é gerada por CSPRNG e guardada como **digest** em estado — em caso nenhum o
  valor fica em claro em disco, e ele é **revogável** (rotacionar / fechar o túnel).
- `run.sh` corre as verificações de cima (local abre; superfície sem chave → 401; com
  `?key=`/sessão → 200) e confirma que, ao desligar, não fica nenhum processo (`pgrep`
  vazio).

> Nota: para ver o **túnel**, o **Telegram** e o **liga/desliga**, o destino é o DSH real —
> vê [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) e os roteiros manuais em
> [`docs/manual-runs/`](../../docs/manual-runs/). Este exemplo isola só o proxy do túnel.