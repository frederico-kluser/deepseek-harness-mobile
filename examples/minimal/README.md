# examples/minimal — exemplo mínimo instalável do portão

Um servidor Node http **guardado pelo portão REAL do plugin** (os módulos compilados em
`dist/`). Demonstra o contrato central do projeto — *sem credencial não se passa; com a
credencial do dono passa-se* — sem um DeepSeek Harness completo à volta, e sem tocar a
rede. É o mínimo que prova o que o README promete.

## Critério de aceite (verificável, offline)

| Verificação | Esperado |
| --- | --- |
| pedido a `GET /api/state` **sem** credencial | `401` |
| pedido **com** a credencial do dono (`dsh:<DEMO_SECRET>`) | `200` |
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
  `dist/http/session-auth.js` — o **mesmo portão** que o plugin usa no produto — e monta
  a barreira sobre um `node:http.Server` real em `127.0.0.1:0`.
- A credencial do dono é a constante `DEMO_SECRET` (valor **descartável**, não é a tua
  senha real), provisionada como **digest** no estado — como o produto faz com a senha
  gerada por CSPRNG. Em caso nenhum o segredo fica em claro em disco.
- `run.sh` corre as duas verificações (401/200) e confirma que, ao desligar, não fica
  nenhum processo (`pgrep` vazio).

> Nota: para ver o **túnel**, o **Telegram** e o **liga/desliga**, o destino é o DSH real —
> vê [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) e os roteiros manuais em
> [`docs/manual-runs/`](../../docs/manual-runs/). Este exemplo isola só o portão.
