# TESTING.md — como rodar cada nível de teste e o que cada um prova

Este documento é o roteiro de teste do plugin. Há quatro fronteiras (04-TESTES §2):
automático-offline, contrato (rede), live (rede real, opt-in) e **manual** (só humano,
pré-release). Este documento cobre os três primeiros; os roteiros M1..M7 estão em
`docs/manual-runs/`.

## 1. Roteiro de gate local

O gate de qualidade é **`pnpm lint && pnpm typecheck && pnpm build && pnpm test`** — com
o lint primeiro porque é o mais barato. Em seguida os critérios de aceite da onda:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm test:security && pnpm test:contract && pnpm test:e2e
```

> **Nota:** o script `test` corre `unit/**` e `integration/**`. Os scripts
> `test:security`, `test:contract` e `test:e2e` são corridos separadamente. O
> `test:live` **nunca** é gate: exige `DSH_GUARD_LIVE_TESTS=1` e rede real.
>
> **As suítes novas entram no gate sem comando extra** — os testes do adaptador
> discord e do registry de agentes vivem em `test/unit/**` e correm no `pnpm
> test` normal; o e2e do discord entra no `pnpm test:e2e`. Roteiro rápido da
> onda: `pnpm test -- --test-name-pattern "providers/discord"`,
> `pnpm test -- --test-name-pattern "agents"` e
> `pnpm test:e2e -- --test-name-pattern "discord"`.

## 2. Os níveis, o que cada um prova e como correr

| Nível | Comando | Executa | O que prova |
| --- | --- | --- | --- |
| Lint | `pnpm lint` | `oxlint . && eslint .` | estilo e regras (inclui gate de PR) |
| Typecheck | `pnpm typecheck` | `tsc --noEmit` (src, types, test, worker, bin) | os tipos casam em todo o projeto |
| Build | `pnpm build` | 3× `tsc -p` (build/worker/bin) → `dist/` | o pacote compila e emite os 3 artefatos |
| Unit+Integration | `pnpm test` | `node --test test/unit/** test/integration/**` | núcleo puro e fiação Cordis com servidor real em `:0` |
| Security | `pnpm test:security` | `test/security/**` (137 testes, adversarial) | tenta burlar o portão e falha se puder |
| Contract | `pnpm test:contract` | `test/contract/**` (precisa de rede) | os `types/` batem com os `.d.ts` reais do npm |
| E2E offline | `pnpm test:e2e` | `test/e2e/**`, processos/sockets reais | ciclo de vida, túnel com fake-cloudflared, worker (telegram **e** discord: `discord-boot.test.ts` spawna o processo real com `DSH_GUARD_PROVIDER=discord` contra um gateway falso — boot feliz, comando→resposta, clique→intent, token em argv recusado, 401 no boot) |
| Live | `pnpm test:live` | `test/live/**` com `DSH_GUARD_LIVE_TESTS=1` | túnel real; **nunca** em CI/PR |
| Coverage | `pnpm test:cov` | unit+integration+security | piso 90/85/95 |
| Mutation | `pnpm test:mutation` | `stryker run` | informativo (noturno, break desligado) |
| All | `pnpm test:all` | test + contract + security + e2e | conveniência local |

Node ≥ 24, Linux/macOS. O runner é `node:test` — zero dependência de runtime de
teste. O CI ainda valida, depois do e2e, que **não ficou nenhum** processo (pgrep vazio).

### Estrutura dos testes do worker

Desde o desacoplamento para provedores, a superfície neutra e os adaptadores têm caminhos
próprios em `test/unit/worker/`:

- `test/unit/worker/surface/**` — o contrato e o **núcleo neutro**: `contract.test.ts` (tipo-a-tipo),
  `contract.structural.test.ts` (o **cone de import**: prova que `worker/surface/**` só importa
  `src/contracts/ipc.ts` de `src/`, e nada de grammY/`worker/lib`), e os testes de `core`, `auth`,
  `commands`, `ids`, `outbox`, `text`, `actions` (incluindo os comandos de agentes: `/agente`,
  `/agentes`, `/parar-agente`, a confirmação em 2 etapas e os textos EXATOS da Onda 5);
- `test/unit/worker/providers/**` — os **adaptadores** e o registry: `registry.test.ts` (inclui a
  linha do discord e o `ProvedorDesconhecidoError`), `providers/telegram/**` (parse, teclado,
  token, transporte, cliente, polling, adapter) e `providers/discord/**` — parse, teclado, token,
  transporte, cliente, `gateway.test.ts` + `gateway-extra.test.ts` (close codes individuais,
  zombie, backoff, resume), `adapter.test.ts` + `adapter-extra.test.ts` e `interno.test.ts` —
  contra o **duble local** (telegram: `test/support/`; discord: o `apoio.ts` com REST+WS falsos
  em `:0`);
- `test/unit/agents/registry.test.ts` — o **dispatcher de agentes** do host com o harness FALSO
  injetado: allowlist default deny, teto de runs, cancelar, disposer LIFO, caminhos de falha
  pós-ack (skill inexistente, sem agente-pai, start rejeitado) e o relatório capado em 64
  (serializa sem lançar no codec real);
- `test/unit/worker/{ipc,telegram-bot}.test.ts` — o canal JSONL do worker e o boot genérico
  (com `WorkerRuntime` injectável, sem subprocesso).

O teste estrutural do cone é o guardião da fronteira de `§5.5`: se um ficheiro da superfície passar
a importar algo fora de `src/contracts/ipc.ts`, o `contract.structural.test.ts` falha vermelho.

> **Nota do `gateway.test.ts` em lote grande:** o `gateway.test.ts` e o `gateway-extra.test.ts`
> usam o **tempo real do WebSocket** (intervalos pequenos + esperas por `aguardar`; só o `sleep`
> do backoff é injetável, num teste próprio com FakeTime). Com muitos ficheiros de teste a correr
> em paralelo no mesmo batch, o runner fica carregado e estes dois **penduram** — é o motivo de
> terem sido partidos em duas levas (o `gateway-extra.test.ts` cobre o que o irmão não cobre).
> Rode-os **sozinhos ou com poucos ficheiros**:
>
> ```sh
> node --test test/unit/worker/providers/discord/gateway.test.ts test/unit/worker/providers/discord/gateway-extra.test.ts
> ```

## 3. A suíte de segurança (porquê é separada)

É uma categoria própria, adversarial, que **tenta burlar** o portão. Cada arquivo em
`test/security/` cobre um vetor:

- `path-bypass.test.ts` — contorno de rota/canonicalização (ADV-001..020);
- `panel-exemptions.test.ts` — superfície isenta de credencial e 404 byte-a-byte;
- `host-header.test.ts` — DNS rebinding via `Host`;
- `websocket-origin.test.ts` — cross-site WebSocket hijacking (CWE-1385);
- `header-forgery.test.ts` — forja de header/identidade;
- `secret-leak-canary.test.ts` — canário por valor (não por nome) de segredo;
- `desafio-401.test.ts` — o 401 do gate é byte-a-byte igual ao do painel;
- `ratelimit-oracle.test.ts` — o ban não vira oráculo;
- `nist-ceiling.test.ts` — teto NIST de 100 falhas e recuperação local;
- `timing-constante.test.ts` — prova estatística de comparação em tempo constante.

## 4. O que se decide por mutação (e por que o score de ferramenta não conta)

Esta secção reproduz o essencial operacional do `docs/mutantes.md` e regista o
veredito do spike de `@stryker-mutator/core@10` com `tap-runner`:

- O Stryker **não tem runner nativo para** `node:test` (feature request #5421); usa o
  `tap-runner`, que vê cada ficheiro de teste como uma unidade.
- Por isso o repo usa `coverageAnalysis: all` (suite por mutante) e `break: null`.
- **O critério de aceite é o checklist manual de 50 mutantes** em `docs/mutantes.md`,
  não o score de ferramenta. O job noturno de mutação não bloqueia PR.

## 5. Manual / pré-release

O que **só** dá para testar à mão: Telegram real (BotFather), Discord real (Developer Portal,
convite com permissão de mensagens, intent MESSAGE CONTENT), Cloudflare real, streaming de
token ponta a ponta, celular na rede móvel, e o ciclo de agentes contra um harness real
(allowlist declarada, dispatch, cancel, reinício do DSH a derrubar os runs). São os roteiros
M1..M7 em `docs/manual-runs/`, corridos antes de cada release com registo por passo.

## 6. Notas operacionais (T6.3)

Mantido o veredito do spike de T6.3: o `test:cov` inclui `test/security/**` na
EXECUÇÃO (o `--test-coverage-exclude` exclui só os ficheiros de teste do relatório).
Razão: medir cobertura sem correr a suíte de segurança subestima os módulos com pisos mais
rígidos (src/http, src/control).

LIMITE conhecido: o piso global de funções (95% em 04-TESTES §11.1) não é atingido (93.83%)
por ficheiros fora do escopo das ondas (ex.: `src/index.ts`, raiz de composição — que
04-TESTES §11.2 diz explicitamente **não** perseguir; e `worker/telegram-bot.ts`).
A catraca de regressão (coverage-ratchet) é pendência de CI.

## 7. Política de flake

Zero `retry` no CI. Teste intermitente é bug: vai para quarentena com issue aberta,
não para `retry: 3`. Nenhum teste usa `sleep`, porta fixa ou `Math.random`, e
a prova de que um processo morreu é sempre `ps`, nunca `child.killed`.
