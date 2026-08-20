# 04 — Estratégia de Testes

> Documento de **plano**. Não contém implementação final: contém a estratégia, os
> **casos nomeados com ID estável** (consumíveis como critério de aceite pelas ondas
> do `deep-orchestrator`), a **técnica concreta** de cada um, os roteiros manuais e
> o desenho de CI.
>
> Escopo: o plugin `dsh-guarded-bot-orchestrator` no estado atual (`src/index.ts`,
> 1836 linhas; `test/index.test.ts`, ~2100 linhas, `node --test`) **mais** as quatro
> capacidades novas — onboarding do Telegram, túnel Cloudflare, senha de acesso e
> liga/desliga nas duas superfícies.
>
> Documentos irmãos: [01-ARQUITETURA](01-ARQUITETURA.md) (máquina de estados,
> serviços, eventos), [02-SEGURANCA](02-SEGURANCA.md) (camadas L0–L8),
> [03-ONDAS](03-ONDAS.md) (ondas O0–O7 e mapa de propriedade),
> [05-QUALIDADE-CODIGO](05-QUALIDADE-CODIGO.md), [06-REPO-E-CI](06-REPO-E-CI.md).
>
> **Fonte única da verdade:** [09-DECISOES-CANONICAS](09-DECISOES-CANONICAS.md).
> Onde este documento divergir de 09, **09 vence e este arquivo é que muda**. A
> árvore de `src/`/`worker/`, o layout de `test/`, o bloco de `scripts`, os nomes
> de rota, de estado, de cookie e de comando do bot vêm todos de 09 (D1, D4, D5,
> D7) e são reproduzidos aqui sem reinterpretação.
>
> **Quatro prescrições refutadas por recon HTTP direto** (09, tabela E1–E4) que
> não podem reaparecer como forma correta em nenhum teste: `@deepseek-ai/dsh-host-subprocess`
> (o real é `@deepseek-ai/dsh-subprocess`); `ctx.webServer`/`WebServer`/`inject: ['webServer']`
> (o real é `ctx.httpServer`/`HttpServerService`/`inject: ['httpServer']`);
> `spawn(cmd, args, opts)` (o real é `spawn(spec: SubprocessSpawnSpec)`);
> `dsh-host-frontend` (o real é `@deepseek-ai/dsh-host-frontend-static`). Elas
> aparecem neste documento **apenas** como alvo de asserção negativa (§5.8) — que
> é exatamente o papel delas.

---

## 0. Resumo executivo

| Eixo | Decisão |
| --- | --- |
| Runner | `node:test` nativo, **em todo o projeto**. Já em uso, zero dependência de runtime de teste, zero superfície de supply chain. **Vitest não entra** — nem no núcleo puro (decisão canônica D16: não se troca o runner do projeto por causa de ferramenta de qualidade secundária). |
| Filosofia | Núcleo puro + costuras injetadas. Zero rede real, zero Telegram real, zero túnel real na suíte automatizada. |
| Fronteira do e2e local (`test/e2e/**`) | Processos reais (`node`, binário falso de `cloudflared`), servidor HTTP real em `127.0.0.1:0`, sockets reais. **Offline**, sem internet, sem segredo. **Bloqueia PR** (D10). |
| Fronteira do `live` (`test/live/**`) | Rede real: quick tunnel de verdade. **Opt-in** por `DSH_GUARD_LIVE_TESTS=1`, `workflow_dispatch` apenas, **nunca** em PR e **nunca** no gate (D10). |
| Fronteira do manual | Telegram real, Cloudflare real, streaming de token ponta a ponta, celular fora da rede. Roteiros em §9. |
| Gate de qualidade **da suíte** | Lista fechada de 50 mutações obrigatórias (§7) revisada como **checklist manual da Onda 6** — porque esta suíte **já passou 49/49 com o tree-kill quebrado**. Mutation testing por ferramenta roda em **job noturno não bloqueante** (D16). |
| Suíte de segurança | Categoria própria (§6), adversarial, roda em todo push, bloqueia merge, cobertura obrigatória de 100 % dos casos listados. |
| Determinismo | Relógio, aleatoriedade, `spawn`, `kill`, transporte HTTP e `platform` são **sempre** parâmetros. Nenhum teste usa `sleep`, porta fixa ou `Math.random`. |
| Política de flake | Zero retries no CI. Teste intermitente é bug: vai para quarentena com issue aberta, não para `retry: 3`. |

**A afirmação central deste documento:** cobertura de linha não prova nada neste
projeto. O bug mais grave já vivido aqui (§7.1) estava numa linha **coberta**,
executada por **oito** testes verdes. O que prova é: (a) dublê que replica o
comportamento real do runtime, (b) um e2e com processo de verdade por invariante
crítica, e (c) mutação que mate a suíte quando a suíte estiver mentindo.

---

## 1. Princípios

1. **Testar comportamento observável, não implementação.** O critério é
   "requisição sem credencial recebe 401 com `WWW-Authenticate: Basic realm=…`",
   nunca "a função `challengeBasicAuth` foi chamada".
2. **Toda dependência não determinística é costura injetada.** O código atual já
   acerta nisso: `SupervisorDeps { scheduler, random, now, platform, kill }`
   (`src/index.ts:546`). Toda capacidade nova segue o mesmo padrão — relógio,
   aleatoriedade, transporte HTTP, `spawn`, `process.kill`, leitura de disco e
   geração de segredo entram por parâmetro com default real.
3. **O dublê tem que mentir menos que o real.** Um dublê que simplifica o Node é
   bomba-relógio; ver §7.1, o caso vivido neste repositório. Regra derivada: todo
   dublê de `ChildProcess` tem um teste que verifica que **o dublê** se comporta
   como o Node (`test/support/child-double.contract.test.ts`).
4. **Fail-closed é testável duas vezes.** Cada caminho de negação tem (a) o teste
   de que ele nega e (b) o teste de que ele **continua negando quando o mecanismo
   de decisão some** — ouvinte removido, config vazia, serviço ausente, exceção no
   meio da avaliação. O teste `cascata http/auth-check › permanece fail-closed
   quando o ouvinte do plugin e removido` (`test/index.test.ts:944`) é o modelo.
5. **Segurança tem suíte própria, não é "mais um caso".** §6 é uma suíte
   adversarial que tenta ativamente burlar. Ela não pode ser diluída em
   `test/unit/http/path.test.ts`, porque diluída ela deixa de ser lida como lista
   de ataques.
6. **A prova de que algo morreu é `ps`, não `child.killed`.** Toda asserção de
   ciclo de vida de processo tem uma versão e2e que consulta o sistema
   operacional.

---

## 2. Pirâmide de testes deste projeto

```
                         ╔═══════════════════════╗
                         ║  MANUAL (§9)          ║   ~7 roteiros, 40 min
                         ║  Telegram real,       ║   não roda em CI
                         ║  Cloudflare real,     ║   pré-release obrigatório
                         ║  celular na 4G        ║
                         ╠═══════════════════════╣
                         ║  LIVE (test/live/**)  ║   rede REAL, opt-in
                         ║  quick tunnel de      ║   DSH_GUARD_LIVE_TESTS=1
                         ║  verdade              ║   workflow_dispatch, nunca gate
                         ╠═══════════════════════╣
                      ╔══╣  E2E LOCAL (§5.4.4,   ║   ~15 casos, <60 s
                      ║  ║  §5.6, §6)            ║   processos e sockets reais
                      ║  ║  fake-cloudflared,    ║   roda em todo push (Linux)
                      ║  ║  servidor 127.0.0.1:0 ║
                      ║  ╠═══════════════════════╣
                  ╔═══╣  INTEGRAÇÃO (§5.1–§5.6)  ║   ~90 casos, <10 s
                  ║   ║  ctx duplo + http real   ║   fiação Cordis, gate, IPC
                  ║   ║  transporte falso        ║
                  ║   ╠══════════════════════════╣
              ╔═══╣  UNIDADE (§5.1–§5.5)         ║   ~220 casos, <2 s
              ║   ║  funções puras, tabela,      ║   parsing, política, redutor
              ║   ║  property-based onde couber  ║
              ╚═══╩══════════════════════════════╝
                         MUTATION (§7) — nightly, sobre a base pura
                      CONTRATO (§5.8) — job com rede, versões pinadas
```

### 2.1 Classificação por componente

| Componente | Unidade | Integração | E2E local | Só manual |
| --- | --- | --- | --- | --- |
| `verifyBasicAuth`, `normalizeRemoteAddress`, `canonicalRequestPath`, `isGuardedPath`, `requestsDeniedPermission`, `computeBackoffDelay`, `buildWorkerEnv` | ✅ núcleo | — | — | — |
| Geração/hash do segredo, store de sessão, rate limit | ✅ com relógio e RNG injetados | ✅ contra `http` real | — | — |
| Gate HTTP (`createGuardedHandler`) | ✅ decisão | ✅ servidor real em `:0` | ✅ dentro da suíte adversarial | — |
| Gate de upgrade (WebSocket) | ✅ decisão | ✅ handshake cru sobre socket real | ✅ | — |
| Descoberta da URL do túnel (`tunnel/discover.ts`) | ✅ parser + polling com clock falso | ✅ contra `fake-cloudflared` | ✅ | latência real (6–7 s) |
| Supervisor do `cloudflared` | ✅ backoff, orçamento, estados | ✅ com `ctx.subprocess` duplo | ✅ tree-kill com neto real | queda de rede real |
| Bot Telegram — decisão (allowlist, comandos, confirmação) | ✅ **o grosso do valor está aqui** | ✅ com transporte falso e servidor local | — | UX do fluxo real |
| Bot Telegram — long polling, 409, 429 | — | ✅ contra servidor local que simula a Bot API | — | conflito real de duas instâncias |
| Onboarding (detecção de estado) | ✅ tabela de estados | ✅ CLI contra FS temporário | — | ✅ leigo consegue seguir? |
| Controlador liga/desliga | ✅ redutor puro + property | ✅ com supervisor duplo | ✅ ciclo completo | — |
| Ciclo de vida Cordis (`apply`/dispose/HMR) | ✅ contagem de disposers | ✅ ctx duplo | ✅ sem processo/timer vivo | — |
| Contrato com `@deepseek-ai/*` | — | — | — (job próprio, §5.8) | — |
| Cloudflare Access / Zero Trust | — | — | — | ✅ inteiramente |

### 2.2 O que **só** dá para testar manualmente — e por quê

| Item | Por que não automatiza |
| --- | --- |
| Fluxo do BotFather (`/newbot`, token) | Não há API para criar bot; o BotFather é uma conversa humana. `getMe` valida o token depois, e isso automatiza-se — a criação, não. |
| Entrega real de mensagem e notificação no celular | Depende do dispositivo, do app e da rede do usuário. |
| Latência real do quick tunnel (6–7 s medidos) | Depende da borda da Cloudflare. Automatizamos o **timeout** (≥30 s) e o **polling**, não o número. |
| Streaming de token através do túnel | Precisa de LLM real + túnel real. **Importante:** a pesquisa refutou a alegação de que quick tunnel não suporta SSE — POST com `text/event-stream` chega em streaming real, GET fica bufferizado (cloudflared issue #1449); e este harness usa **WebSocket** no downlink, não SSE (`src/index.ts:935`). Isso muda o risco, mas continua exigindo validação manual (roteiro M6). |
| Cloudflare Access / One-time PIN | Configuração de conta, domínio e IdP. Fora do alcance de um teste local. |
| "Um leigo consegue seguir o onboarding?" | É teste de usabilidade. Roteiro M1, com pessoa real que nunca viu o projeto. |
| Comportamento sob varredura hostil real | Não se simula a internet. Mitigado por §6 (ataques conhecidos) + observabilidade. |

---

## 3. Ferramental e convenções

### 3.1 Runner: `node:test`

Mantido. Justificativa verificada: `node:test` é estável desde o Node 20; snapshot
estável desde 23.4; mocking completo (`mock.fn`, `mock.method`, `mock.timers`);
isolamento por processo; reporters `spec`/`tap`/`junit`/`lcov`;
`--test-rerun-failures`; e thresholds de cobertura por CLI já estáveis
(`--test-coverage-lines`, `--test-coverage-branches`, `--test-coverage-functions`).
Segue **experimental** apenas a *coleta* de cobertura
(`--experimental-test-coverage`) e o watch mode. Para uma lib Node pura, sem DOM e
sem transform, isso significa zero dependência de runtime de teste.
`engines.node` do pacote já é `>=24`, então nada disso é aposta.

**Comandos: este documento NÃO define bloco de `scripts` próprio.** O bloco
canônico do `package.json` está em
[09-DECISOES-CANONICAS §D4 e Apêndice A](09-DECISOES-CANONICAS.md) e é o mesmo
consumido por `03-ONDAS.md` e por `06-REPO-E-CI.md`. Os scripts que este
documento cita pelo nome — e só pelo nome — são:

| Script | O que roda | Papel |
| --- | --- | --- |
| `pnpm test` | `test/unit/**` + `test/integration/**` | **gate de merge** intra-onda |
| `pnpm test:contract` | `test/contract/**` | aceite de onda + required check de PR |
| `pnpm test:security` | `test/security/**` | aceite de onda + required check de PR |
| `pnpm test:e2e` | `test/e2e/**`, `--test-concurrency=1`, offline | aceite de onda + required check de PR |
| `pnpm test:live` | `test/live/**`, rede real | **nunca** é gate; `workflow_dispatch` + `DSH_GUARD_LIVE_TESTS=1` |
| `pnpm test:cov` | cobertura sobre unit+integration | job `coverage`, com catraca (§11.1) |
| `pnpm test:all` | `test` + `test:contract` + `test:security` + `test:e2e` | conveniência local |

Há **um** `test` só, sem variante concorrente: cobertura vive em `test:cov`, e
não em `test` (D4). O comando de gate rodado no snapshot depois de cada
squash-merge é `pnpm lint && pnpm typecheck && pnpm build && pnpm test` — `lint`
primeiro porque é o mais barato.

> **Armadilha que precisa de tratamento literal (D4):** `node --test` com um glob
> que não casa com nenhum arquivo **sai com código 1**. Todo diretório de teste
> criado por um COMMIT PREP nasce com um `_placeholder.test.ts` de asserção
> trivial verde, apagado pela primeira sub-tarefa real do diretório. Sem isso o
> gate fica vermelho na Onda 1 por ausência de arquivo, não por defeito.

Execução de TypeScript: type stripping nativo do Node. Restrição derivada e
**normativa para todo o projeto**: sem `enum`, sem `namespace` com runtime, sem
parameter properties, sem decorators e sem `paths` do tsconfig no caminho
executado por testes. `verbatimModuleSyntax` ligado. Isso já está alinhado com
[05-QUALIDADE-CODIGO](05-QUALIDADE-CODIGO.md).

> **NÃO CONFIRMADO — spike obrigatório (Onda 0, T0.1):** a pesquisa não verificou
> o comportamento de type stripping na versão exata do Node que rodará no CI, e a
> afirmação "estável no 25.2, flag removida no 26" **não tem lastro em
> `08-PESQUISA-E-FONTES.md`** — ela foi removida deste documento por decisão
> canônica (D24 item 6) e **não pode ser usada como justificativa de matriz de
> Node**. A única razão escrita da matriz é `engines: node >=24` (D12). A Onda 0
> mede: se o stripping recusar algum arquivo, o fallback é
> `tsc -p tsconfig.build.json` antes de testar, com os testes rodando sobre
> `dist/`. Decisão registrada em `docs/spikes/`.

### 3.2 Estrutura de diretórios

O layout abaixo é o **canônico de [09 §D1](09-DECISOES-CANONICAS.md)**,
reproduzido literalmente. Ele não é negociável e não é "melhorável" aqui: quem
tem autoridade sobre árvore é 09, e quem tem autoridade sobre *quem escreve cada
arquivo* é `03-ONDAS.md`.

**Regra de propriedade (a de D1, que substitui a antiga regra de `03-ONDAS.md`
§4.2):** o dono de `src/x/y.ts` é o dono de `test/unit/x/y.test.ts` **e** dos
arquivos de `test/integration/x/**` que exercitam `y.ts`. Isso elimina a classe
inteira de conflito "um agente escreve, outro testa".

**Layout canônico (D1, literal):**

```
test/
  unit/<mesmo caminho de src/ ou worker/>/<arquivo>.test.ts   [dono = dono do fonte]
  integration/<área>/<caso>.test.ts                           [dono = dono do fonte principal do caso]
  contract/dsh-types.test.ts                                  [T0.1; roda em PR e no nightly]
  security/<vetor>.test.ts                                    [criado pelas T2.x; dono na Onda 6 é T6.3]
  e2e/<fluxo>.test.ts        OFFLINE, só dublês, BLOQUEIA PR  [T6.1, T6.2, T6.4]
  live/<fluxo>.test.ts       rede real, workflow_dispatch      [T6.1]
  support/{clock,ctx-double,child-double,telegram-server,state-dir}.ts   [PREP 2]
  bin/fake-cloudflared.mjs                                    [PREP 2]
```

`test/support/**` e `test/bin/**` são **prep-owned**: nascem no COMMIT PREP 2,
antes de a Onda 2 escrever o primeiro teste, e a partir daí são **somente
leitura** — nenhuma sub-tarefa os edita (D15). Os dublês vêm do
`test/index.test.ts` **pré-dissolução**, extraídos por T1.1 na Onda 1 e entregues
ao PREP 2.

**Instanciação do layout para este projeto** (deriva mecanicamente da árvore
canônica de `src/`/`worker/` em D1 — cada linha é `test/unit/` + o caminho do
fonte):

```
test/unit/
  brand.test.ts                    construtores validadores de SessionId, Nonce, SecretDigest
  errors.test.ts                   hierarquia de erro e estabilidade dos códigos
  dsh/adapter.test.ts              única superfície que toca API do DSH (ctx.httpServer, ctx.subprocess)
  config/schema.test.ts            forma de Config
  config/assert.test.ts            assertValidConfig e assertores primitivos
  config/bind.test.ts              assertSecureBind, isWildcardBindHost
  logging/logger.test.ts           wrapper de ctx.logger com LOG_SCOPE fixo
  logging/redact.test.ts           mascaramento de token, Authorization, Cookie, mk, URL do túnel
  permissions/deny.test.ts         canonicalizePermissionToken, requestsDeniedPermission
  http/auth-basic.test.ts          verifyBasicAuth — §5.1.1
  http/origin.test.ts              normalizeRemoteAddress, isTrustedRemote
  http/path.test.ts                canonicalRequestPath, isGuardedPath, routeMayServeGuardedPath
  http/responses.test.ts           corpos idênticos de negação
  http/gate.test.ts                decisão do handler (sem servidor)
  http/intercept.test.ts           fiação de ctx.intercept('httpServer', …)
  http/session-auth.test.ts        verificação do cookie de sessão dentro do gate
  http/host-header.test.ts         validação do header Host (anti DNS rebinding)
  state/paths.test.ts              resolução de $XDG_STATE_HOME + fallback + modos
  state/schema.test.ts             forma versionada e migração do state.json
  state/store.test.ts              escrita atômica, fsync, recusa de modo > 0600 — §5.2.1
  secret/generate.test.ts          entropia, alfabeto base32, agrupamento visual
  secret/canonical.test.ts         canonicalizeSecret
  secret/store.test.ts             só o digest é persistido
  secret/verify.test.ts            comparação de digests em tempo constante
  secret/ott.test.ts               token de uso único de /__guard/secret
  session/store.test.ts            emissão, lookup, expiração, disposer
  session/cookie.test.ts           serialização de __Host-dsh_sid
  session/magic.test.ts            store do mk do link mágico — §5.2.2
  ratelimit/policy.test.ts         falhas→atraso, full jitter, teto NIST
  ratelimit/tracker.test.ts        contadores por identidade, disposer
  ratelimit/restricted.test.ts     modo restrito — §5.1.4
  audit/log.test.ts                append-only 0600 fora do workspace
  audit/format.test.ts             serialização do registro de auditoria
  audit/events.test.ts             vocabulário fechado de eventos
  audit/notify.test.ts             notificação proativa, sempre DEPOIS do log
  proc/backoff.test.ts             computeBackoffDelay (existente, migrado)
  proc/env.test.ts                 buildWorkerEnv e buildTunnelEnv (existente, migrado)
  proc/tree-kill.test.ts           process.kill(-pid) e o ramo win32 inerte
  proc/supervisor.test.ts          supervisor genérico com spawn(SubprocessSpawnSpec)
  tunnel/args.test.ts              argv do cloudflared — §5.4.2
  tunnel/supervisor.test.ts        ciclo de vida, orçamento, não-retryable
  tunnel/probe.test.ts             ★ probe fail-closed de 4 sondas — §5.4.6
  tunnel/ttl.test.ts               ★ TTL do túnel com relógio injetado — §5.4.7
  tunnel/discover.test.ts          parser da URL + política de polling
  tunnel/readiness.test.ts         polling com timeout, abortado no 'close'
  panel/routes.test.ts             política por rota e isenções — §5.9
  panel/html.test.ts               painel autocontido, sem recurso externo
  panel/api.test.ts                /api/state, /api/login, /api/tunnel/start|stop
  panel/magic.test.ts              GET inerte + POST consumidor — §5.2.2
  panel/secret.test.ts             GET /__guard/secret?ott=… e o 404 indistinguível
  panel/csrf.test.ts               token anti-CSRF das rotas POST
  telegram/onboarding.test.ts      detecção de estado do onboarding — §5.3.4
  telegram/pairing.test.ts         ★ código de pareamento de 6 dígitos — §5.3.5
  telegram/ipc.test.ts             lado HOST do protocolo JSONL
  control/controller.test.ts       máquina de estado única, fila, idempotência — §5.5
  control/confirm.test.ts          nonce server-side das ações que aumentam exposição
  worker/ipc.test.ts               lado WORKER do protocolo JSONL
  worker/lib/client.test.ts        configuração do grammY (apiRoot, auto-retry, bot.catch)
  worker/lib/polling.test.ts       timeout 50, allowed_updates, 409 → sair do processo
  worker/lib/keyboard.test.ts      teclado inline, answerCallbackQuery, editMessageText
  worker/auth/allowlist.test.ts    ★ allowlist — o teste mais importante — §5.3.1
  worker/auth/guard.test.ts        revalidação de identidade em todo callback_query
  worker/auth/pairing.test.ts      recepção de /parear; segundo pareamento recusado
  worker/commands/router.test.ts   roteamento comando → intent; setMyCommands
  worker/commands/onoff.test.ts    /ligar e /desligar
  worker/commands/access.test.ts   /acessar e /rotacionar
  worker/commands/status.test.ts   /status e /emergencia
  bin/dsh-guard-setup.test.ts      provision(), QR ASCII, --reset-pairing

  # Quatro ausências DELIBERADAS nesta lista, e cada uma tem razão escrita:
  #   src/index.ts        raiz de composição — é fiação; teste unitário dela testa o dublê (§11.2)
  #   src/contracts/**    só tipos, congelados por COMMIT PREP; não há runtime para exercitar
  #   worker/telegram-bot.ts  entry de processo; coberto por test/integration/telegram/**
  #   test/support/**     dublês prep-owned; a exceção é o contrato do dublê de ChildProcess (§7.1),
  #                       cujo caminho canônico é pendência do PREP 2 — ver a nota abaixo

test/integration/
  http/gate-server.test.ts         servidor node:http real em 127.0.0.1:0
  http/upgrade.test.ts             handshake WebSocket cru
  panel/exempt-surface.test.ts     ★ superfície não autenticada — §5.9
  state/store-crash.test.ts        interrupção entre write e rename
  telegram/transport.test.ts       servidor local simulando api.telegram.org
  telegram/ipc.test.ts             protocolo JSONL host↔worker ponta a ponta
  tunnel/supervisor.test.ts        contra test/bin/fake-cloudflared.mjs
  tunnel/ttl.test.ts               expiração derruba o túnel e invalida sessões
  control/two-surfaces.test.ts     convergência bot ↔ painel
  lifecycle/apply-dispose.test.ts  disposers, HMR

test/e2e/          (OFFLINE, só dublês, bloqueia PR)
  tree-kill-real.test.ts           ★ pai + neto reais, verificação por `ps`  [dono: T6.4]
  tunnel-cycle.test.ts             start → READY → stop, sem processo órfão   [dono: T6.1]
  hmr-reload.test.ts               apply/dispose/apply na mesma porta         [dono: T6.2]

test/live/         (rede REAL, DSH_GUARD_LIVE_TESTS=1, workflow_dispatch, nunca gate)
  quick-tunnel.test.ts             quick tunnel de verdade                    [dono: T6.1]

test/security/
  path-bypass.test.ts              §6.1
  header-forgery.test.ts           §6.2
  websocket-noauth.test.ts         §6.3
  telegram-abuse.test.ts           §6.4
  secret-leak-canary.test.ts       §6.5

test/contract/
  dsh-types.test.ts                §5.8 — exige rede

test/support/      (PREP 2, congelado, somente leitura)
  clock.ts                         relógio e RNG determinísticos
  ctx-double.ts                    Context Cordis duplo (evoluído do atual)
  child-double.ts                  ChildProcess duplo fiel ao Node
  telegram-server.ts               servidor local com a forma da Bot API + fixtures
  state-dir.ts                     diretório de estado temporário com modo 0700

test/bin/          (PREP 2, congelado, somente leitura)
  fake-cloudflared.mjs             binário falso, modos por argv/env
```

> **DIVERGÊNCIA REGISTRADA — pendência do COMMIT PREP 2 (não resolvida aqui).**
> Três artefatos que este documento usa **não** constam da lista fechada de cinco
> arquivos prep-owned de D1/D15: (i) as fixtures do Telegram (§8.3), (ii) um
> helper de servidor HTTP efêmero e de requisição por socket cru (§6.1 exige
> socket cru, e `fetch` normaliza o caminho antes de enviar), e (iii) o **teste de
> contrato do dublê** `child-double`, que testa o próprio dublê (§7.1) e por isso
> é um `*.test.ts` dentro de território prep-owned. Este documento **não inventa**
> caminho novo para eles: registra que o PREP 2 precisa decidir entre absorvê-los
> nos cinco arquivos congelados ou acrescentá-los explicitamente à lista
> congelada. Enquanto a decisão não existir, os IDs `FIXTURE-001` e o contrato do
> dublê ficam **sem caminho canônico**, e isso é um bloqueio da Onda 2, não uma
> liberdade do implementador. Autoridade: `09-DECISOES-CANONICAS.md` D15 e
> `03-ONDAS.md` PREP 2.

### 3.3 Convenção de nome e ID

Todo caso tem **ID estável** no formato `AREA-NNN`, escrito no título. O ID é o
que as ondas citam como critério de aceite e o que a tabela de mutações (§7.2)
referencia. Renomear a descrição é livre; mudar o ID, não.

```ts
it('AUTH-014 · esquema `BASIC ` maiúsculo é aceito (RFC 7235 §2.1)', () => { … })
```

Áreas: `AUTH` (credencial/gate), `SESS` (sessão), `SECRET` (segredo), `MAG`
(link mágico de uso único), `STATE` (arquivo de estado), `RL` (rate limit e modo
restrito), `ORIG` (origem), `PATH` (canonicalização), `PERM` (veto de
permissão), `PANEL` (rotas `/__guard/**` e a superfície isenta de credencial),
`PAIR` (pareamento do dono no Telegram), `TG` (Telegram), `TUN` (túnel, incluindo
TTL e probe), `SUP` (supervisor), `CTL` (controle liga/desliga), `LIFE` (ciclo de
vida), `TENSAO` (invariantes da tensão loopback×túnel), `ADV` (adversarial),
`CONTRACT`, `E2E`, `LIVE` (rede real), `M` (manual).

Nenhuma área nova pode nascer fora desta lista sem passar por 09.

> **Faixas de ID (`AUTH-001…042`, `TG-001…089`, …) são rótulo de família, não
> promessa de numeração contínua.** A lista autoritativa de casos é sempre a
> **tabela** da seção correspondente; a faixa citada em §13 nomeia o intervalo em
> que a família vive. Há buracos deliberados (IDs reservados para casos que só
> nascem se um spike der positivo) e eles não são caso faltando. Um caso novo
> **nunca** reaproveita número já usado, mesmo que o antigo tenha sido removido.

### 3.4 Orçamento de tempo

| Suíte | Teto | Consequência de estourar |
| --- | --- | --- |
| `unit` | 2 s | Bug de design: algo não é puro. |
| `integration` | 10 s | Provavelmente há `sleep` disfarçado. |
| `security` | 5 s | — |
| `e2e` | 60 s | Reduzir número de casos, não aumentar o teto. |
| CI completo (1 versão do Node) | 3 min | — |

---

## 4. Reaproveitamento: o que já existe

A suíte atual (`test/index.test.ts`) tem valor real e **não se joga fora**. Ela já
cobre com qualidade: barreira Basic Auth sobre `registerFallback`, guarda das
rotas registradas via `register()` (mitigação da discussão #853), allowlist de
origem com normalização IPv6/IPv4-mapeado, veto de `danger-full-access` por token,
cascata `http/auth-check` fail-closed, backoff com jitter, supervisor com tree-kill
de grupo, `fail loud at load` para bind fora do loopback, e — criticamente — o
achado A-CRITICAL (`test/index.test.ts:1369`) que documenta o bug do `!child.killed`.

| Bloco atual | Destino | Ação |
| --- | --- | --- |
| `manifesto do plugin` (`:549`) | `test/unit/config/schema.test.ts` | **Muda.** O `inject` passa a `['httpServer','subprocess','logger']` após a Onda 0 (§5.8) — `'webServer'` é símbolo **refutado** (E2) e só pode aparecer como alvo de asserção negativa. O teste vira asserção do nome novo. |
| `barreira Basic Auth sobre registerFallback` (`:560`) | `test/integration/http/gate-server.test.ts` | **Mantém**, migrado. Ganha os casos AUTH-005…AUTH-020. |
| `allowlist de origens remotas` (`:673`) | `test/unit/http/origin.test.ts` | **Mantém.** Ganha ORIG-010…ORIG-014 (XFF forjado) e ORIG-015…ORIG-017 (§5.1.5: identidade forjável sob túnel). |
| `guarda das rotas registadas` (`:745`) | `test/integration/http/gate-server.test.ts` + `test/security/path-bypass.test.ts` | **Mantém e expande.** É a semente da suíte adversarial. |
| `veto de danger-full-access` (`:871`) | `test/unit/permissions/deny.test.ts` | **Mantém** sem alteração. |
| `cascata http/auth-check` (`:943`) | `test/integration/lifecycle/apply-dispose.test.ts` | **Mantém.** |
| `verifyBasicAuth` (`:986`) | `test/unit/http/auth-basic.test.ts` | **Mantém e expande** — hoje tem 3 casos, precisa de ~18 (§5.1.1). |
| `computeBackoffDelay` (`:1010`) | `test/unit/proc/backoff.test.ts` | **Mantém.** Já tem property de dispersão de jitter. |
| `supervisor do worker de long-polling` (`:1072`) | `test/integration/tunnel/supervisor.test.ts` + `test/unit/proc/*` | **Muda.** O mesmo supervisor passa a ter duas instâncias (worker do bot **e** `cloudflared`); os testes se parametrizam. |
| `ciclo de vida sob ctx.effect` (`:1280`) | `test/integration/lifecycle/apply-dispose.test.ts` | **Mantém e expande** com HMR (LIFE-020…). |
| `fail loud at load` (`:1319`) | `test/unit/config/bind.test.ts` + `test/unit/config/assert.test.ts` | **Mantém e expande** com a validação de exposição (§5.7). |
| `tree-kill do grupo de processos` (`:1369`) | `test/unit/proc/supervisor.test.ts` **+ novo** `test/e2e/tree-kill-real.test.ts` | **Muda.** Hoje é só com dublê. Ganha irmão e2e com processo real e verificação por `ps` — ver §7.1. |
| `falha de spawn (achado A-HIGH)` (`:1435`) | `test/unit/proc/supervisor.test.ts` | **Mantém.** Cobre ENOENT → `error` sem `exit`. |

**Três pontos onde a suíte atual mente e precisa ser corrigida na Onda 0:**

1. Ela valida `inject = ['webServer', …]` e o duplo de contexto expõe
   `ctx.webServer`. **As duas formas são refutadas (E2).** A verificação contra o
   `.d.ts` real do pacote npm `@deepseek-ai/dsh-host-webserver` mostra
   `interface Context { httpServer: HttpServerService }` — não existe símbolo
   `WebServer` no pacote (o tipo `WebRoute`, esse sim, existe). O teste verde de
   hoje prova apenas que o dublê concorda com o dublê. A forma correta em todo o
   projeto é `ctx.httpServer`, tipo `HttpServerService`, `inject: ['httpServer']`.
2. Os stubs em `types/dsh-host-subprocess/` referenciam um pacote que **não
   existe** no npm (HTTP 404). O real é `@deepseek-ai/dsh-subprocess` (definição)
   + `@deepseek-ai/dsh-subprocess-local` (implementação, depende de `node-pty`).
3. O duplo de `ctx.subprocess.spawn` aceita `(cmd, args, opts)`. A assinatura real
   é `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`, objeto único com
   `argv`, `cwd`, `stdio`, `graceMs` obrigatórios e `signal?`. Enquanto o dublê
   aceitar a forma antiga, **todo teste de spawn é decorativo**.

Por isso §5.8 (testes de contrato) é pré-requisito de tudo, não item opcional.

---

## 5. Como testar cada parte

### 5.1 Gate de autenticação

#### 5.1.1 Unidade — parsing e comparação (`test/unit/http/auth-basic.test.ts`)

Tabela dirigida. `EXPECTED` é sempre o booleano de `verifyBasicAuth`, e a
credencial de referência é a constante `FIXTURE_CRED = base64("u:p")`.

| ID | Entrada de `Authorization` | Esperado | Por quê |
| --- | --- | --- | --- |
| AUTH-001 | ausente (`undefined`) | `false` | caminho mais comum |
| AUTH-002 | `''` | `false` | string vazia ≠ ausente |
| AUTH-003 | `Basic <cred válida>` | `true` | caminho feliz |
| AUTH-004 | `Basic <cred errada, mesmo tamanho>` | `false` | mata mutante que compara comprimento |
| AUTH-005 | `Basic <cred errada, tamanho diferente>` | `false` **e não lança** | `timingSafeEqual` lança `RangeError` em buffers de tamanhos diferentes — por isso comparamos digests de 32 bytes fixos |
| AUTH-006 | `basic <válida>` (minúsculo) | `true` | RFC 7235 §2.1: auth-scheme é token case-insensitive |
| AUTH-007 | `BASIC <válida>` | `true` | idem |
| AUTH-008 | `BaSiC <válida>` | `true` | idem |
| AUTH-009 | `Bearer <válida>` | `false` | esquema errado |
| AUTH-010 | `Basic` (sem espaço nem payload) | `false` | |
| AUTH-011 | `Basic ` (só espaço) | `false` | |
| AUTH-012 | `Basic  <válida>` (dois espaços) | `false` | o payload não bate byte a byte; documenta a decisão |
| AUTH-013 | `Basic <válida>\t` / `\n` / ` ` (trailing) | `true` | o código faz `.trim()`; o teste **congela** essa decisão |
| AUTH-014 | `Basic <válida em maiúsculas>` | `false` | base64 é case-sensitive |
| AUTH-015 | `Basic !!!não-base64!!!` | `false` **e não lança** | não decodificamos; comparamos a string codificada |
| AUTH-016 | `Basic <base64 sem padding>` | `false` | idem — nada de normalizar base64 |
| AUTH-017 | `Basic <64 KiB de 'A'>` | `false` em < 5 ms | anti-DoS: o custo é 1 SHA-256, não um parse |
| AUTH-018 | `Basic <válida>` seguido de byte NUL e `extra` | `false` | injeção de NUL |
| AUTH-019 | array `['Basic a','Basic b']` (header duplicado) | `false` | ver AUTH-020 |
| AUTH-020 | requisição HTTP crua com **dois** headers `Authorization`, o segundo válido | `401` | ver nota abaixo |

> **AUTH-020 é um teste de integração, não de unidade, e é NÃO CONFIRMADO.** A
> pesquisa não verificou como o `node:http` trata `Authorization` duplicado
> (juntar com `, `? descartar o segundo? manter o primeiro?). O teste é escrito
> **primeiro como sonda**: envia dois headers por socket cru, imprime
> `req.headers.authorization` e falha se o resultado não for exatamente o que o
> código assume. A conclusão vira comentário no teste e, se necessário, uma
> rejeição explícita ("mais de um `Authorization` ⇒ 401") no gate. Nunca assumir.

#### 5.1.2 Integração — forma exata da resposta (`test/integration/http/gate-server.test.ts`)

Servidor `node:http` real em `127.0.0.1:0`, handler produzido por
`createGuardedHandler`, cliente `fetch` ou socket cru.

| ID | Cenário | Asserção |
| --- | --- | --- |
| AUTH-030 | sem credencial, origem confiável | `401`; header `WWW-Authenticate: Basic realm="…", charset="UTF-8"`; `Cache-Control: no-store`; corpo vazio |
| AUTH-031 | credencial errada | `401` **idêntico** ao AUTH-030 — byte a byte, incluindo corpo. Nenhuma diferença entre "usuário não existe" e "senha errada" (OWASP Authentication Cheat Sheet) |
| AUTH-032 | origem não confiável **sem** credencial | `403`, e **não** `401`. A ordem importa: origem antes de credencial, para não vazar a existência do realm a quem nem devia falar conosco |
| AUTH-033 | origem não confiável **com** credencial correta | `403` |
| AUTH-034 | credencial correta, origem confiável, rota guardada | pass-through: handler original chamado exatamente 1 vez, com o mesmo `req`/`res` |
| AUTH-035 | rota **fora** de `guardedPrefixes` | handler original chamado sem gate (invariante já testada em `:828`) |
| AUTH-036 | o gate não consome o corpo | `req` ainda legível pelo handler original (teste já existe em `:649`, migrar) |
| AUTH-037 | `realm` com aspas/`\`/controle | recusado em `assertValidConfig`, nunca escapado na resposta (o código já tem `UNSAFE_REALM_PATTERN`, `src/index.ts:1108`) |

#### 5.1.3 Timing-safe: o que dá e o que não dá para testar

**Não dá para medir timing de forma confiável em CI.** Runner compartilhado,
GC, turbo boost e escalonamento produzem ruído de ordem de grandeza maior que o
sinal que se quer detectar. Um teste estatístico de timing em GitHub Actions é
uma máquina de flake. Ataques de timing remoto são reais — Crosby/Wallach (ACM
TISSEC 2009) mediram eventos com 15–100 µs pela internet e 100 ns em LAN, e o
CWE-208 cobre exatamente isso — mas a defesa se prova por **construção**, não por
cronômetro.

O que testamos:

| ID | Técnica | Asserção |
| --- | --- | --- |
| AUTH-040 | leitura estrutural | `verifyBasicAuth` compara sempre dois `Buffer` de 32 bytes (SHA-256): teste chama com entradas de tamanhos 0, 1, 10³, 10⁵ e verifica que nenhuma lança |
| AUTH-041 | mutação (§7.2) | trocar `timingSafeEqual` por `===` **deve** matar um teste. Como `===` passa em todos os funcionais, o teste que mata é um teste de *código*: `assert.ok(fnSource.includes('timingSafeEqual'))` — feio, mas é a única asserção determinística. Alternativa preferida: `mock.method(crypto,'timingSafeEqual')` e verificar que foi chamado exatamente 1 vez por avaliação |
| AUTH-042 | benchmark **informativo**, fora do gate | script `bench/timing.mjs` com 10⁵ amostras, reportando p50/p99 de credencial-que-erra-no-1º-byte vs no-último-byte. Roda no nightly, **imprime**, nunca falha o build |

#### 5.1.4 Rate limit, lockout e modo restrito (`test/unit/ratelimit/{policy,tracker,restricted}.test.ts`)

Política pura, relógio injetado. Números normativos da pesquisa: NIST SP 800-63B
rev.4 §3.2.2 exige limitar tentativas falhas consecutivas por conta a **no máximo
100**, e sugere espera crescente ("30 segundos até uma hora"); fail2ban usa
`maxretry=5`, `findtime=10m`, `bantime=10m` como default; OWASP alerta que
lockout puro é DoS trivial — e com **um único usuário**, lockout permanente é
auto-brick.

| ID | Cenário | Esperado |
| --- | --- | --- |
| RL-001 | 4 falhas do mesmo IP em 1 min | sem atraso adicional |
| RL-002 | 5ª falha | atraso 1 s antes da resposta |
| RL-003 | 6ª, 7ª, 8ª | 2 s, 4 s, 8 s (progressão determinística com RNG injetado) |
| RL-004 | atraso satura | nunca acima do teto configurado (default 60 s) |
| RL-005 | 15 falhas | identidade banida por `bantime`; a resposta **continua sendo `401` idêntico** ao de senha errada. O teste compara **byte a byte** status, corpo e conjunto de headers com o 401 do RL-002 e assere **ausência de `Retry-After`**. O efeito do ban é atraso interno, nunca sinal para o atacante (D9; `02-SEGURANCA.md` §6.1) |
| RL-006 | ban expira (relógio avança) | próxima tentativa é avaliada normalmente |
| RL-007 | sucesso no meio | contador do identificador zera |
| RL-008 | 100 falhas consecutivas acumuladas na conta (teto NIST) | entra em **modo restrito**: (a) evento de auditoria emitido; (b) o **túnel é derrubado** — `pgrep -f fake-cloudflared` vazio; (c) requisição pela URL do túnel falha; (d) requisição de **loopback** com credencial correta passa; (e) o modo é persistido via `StateStore` e, após restart do plugin, **continua ativo** (lido do `state.json`). Não é lockout permanente: o dono recupera indo à máquina (D9) |
| RL-009 | 3 IPs distintos, 5 falhas cada | bans independentes; o contador de conta soma os três (OWASP: contador por conta, não só por IP — rotação de IP não deve zerar) |
| RL-010 | pico de 10⁴ tentativas | estrutura de estado limitada (LRU com teto); memória não cresce sem limite (o próprio rate limiter não pode virar o DoS) |
| RL-011 | credencial **correta** durante ban | negada, com o **mesmo `401` idêntico**. O ban é do identificador, não da credencial. Nenhuma resposta do caminho de autenticação distingue "banido" de "senha errada" — `429` está **proibido** no caminho de autenticação (o `429` continua válido só para tratar o `retry_after` **do Telegram**, que é outra coisa: TG-043) |
| RL-012 | tempo de resposta do atraso | usa o `scheduler` injetado, nunca `await sleep()` — teste avança o relógio e confirma que a resposta não saiu antes |
| RL-013 | custo de código do caminho de negação | o número de operações do caminho "banido" e do caminho "senha errada" é o mesmo: o teste conta chamadas ao digestor e ao comparador em ambos e exige igualdade. Aproximadamente constante por construção, não por cronômetro (§5.1.3) |
| RL-014 | modo restrito × `/ligar` | com modo restrito ativo, um `/ligar` vindo do bot **não** reabre o túnel: é recusado com motivo explícito e registrado em auditoria. Sem isso o controle é reversível por quem já controla o chat |
| RL-015 | saída do modo restrito | só por ação **local** (CLI `bin/dsh-guard-setup` na máquina); nenhum caminho remoto — nem painel autenticado pelo túnel, nem comando do bot — desativa o modo |
| RL-016 | persistência do modo restrito | escrita pelo `StateStore` (único writer, §5.2.1); o teste corrompe o `state.json` e confirma *fail loud* no boot, nunca "assume não restrito" |
| RL-017 | o link mágico está sob o mesmo limite | consumo de `POST /__guard/magic` com `mk` inválido conta para o **mesmo** teto de falhas do login (D3) |
| RL-018 | tentativas de `/parear` | contadas e limitadas por identidade de origem do Telegram; 6 dígitos com TTL de 5 min **sem** limite de tentativas é força bruta viável. Ver PAIR-007 |

#### 5.1.5 Identidade do cliente sob túnel — o eixo forjável (`test/unit/http/origin.test.ts`)

Sob `exposure.mode: 'tunnel'` **todo** tráfego chega do `cloudflared` em
loopback. A consequência é dupla e precisa estar em teste, não em prosa: (i)
`trustedRemotes` fica **inerte** como controle de rede (TENSAO-004), e (ii) a
identidade usada pelo rate limit e pelos alertas passa a depender de um header —
que é **controlado pelo atacante** enquanto a borda não o sobrescrever.

| ID | Cenário | Esperado |
| --- | --- | --- |
| ORIG-015 | `exposure.trustEdgeHeaders: false` (default) + `X-Forwarded-For` presente | header **ignorado**; a identidade do rate limit é derivada de `req.socket.remoteAddress`. Consequência aceita e documentada: sob túnel, todas as tentativas colapsam numa identidade só, e o teto NIST (RL-008) passa a ser o controle principal |
| ORIG-016 | `trustEdgeHeaders: false` + atacante rotacionando `X-Forwarded-For` a cada requisição | o backoff **acumula** normalmente; o teste prova que a evasão não funciona |
| ORIG-017 | `trustEdgeHeaders: false` + atacante enviando o IP do **dono** em `X-Forwarded-For` | o ban **não** é envenenado contra o dono; nenhum alerta é emitido com o IP forjado |

> **NÃO CONFIRMADO — spike obrigatório (S2, Onda 0).** Se o `cloudflared` repassa
> IP de cliente, **e sob que nome**, não está verificado; e a pergunta que faltava
> é a segunda: *o valor é sobrescrito pela borda ou é append?* Enquanto S2 não
> fechar, `exposure.trustEdgeHeaders` permanece `false` por padrão e **nenhum**
> teste pode assumir que existe identidade de cliente confiável sob túnel. Se S2
> concluir que existe cabeçalho confiável, ORIG-018…ORIG-020 nascem para provar a
> validação (o header só vale quando a conexão vem do processo `cloudflared`
> local **e** o valor é o último elemento escrito pela borda).

### 5.2 Segredo e sessão (capacidade nova)

Base normativa: ASVS 5.0 11.5.1 (L2) exige CSPRNG e ≥128 bits de entropia para
qualquer valor "não adivinhável", e diz explicitamente que **UUID não satisfaz**;
7.2.3 exige ≥128 bits para reference token de sessão; NIST SP 800-63B rev.4 §5.1
pede ≥64 bits para segredo de binding de sessão. RFC 4648: base32 carrega 5
bits/char, base64 6, hex 4 — 128 bits = 26 chars base32, 22 base64url, 32 hex.

| ID | Caso | Técnica |
| --- | --- | --- |
| SECRET-001 | comprimento e alfabeto | gerador com `randomBytes` injetado devolvendo bytes conhecidos ⇒ saída determinística e comparável literal |
| SECRET-002 | entropia mínima | ≥256 bits (`randomBytes(32)`); teste falha se a constante cair abaixo de 16 bytes |
| SECRET-003 | não usa `Math.random`/UUID | asserção por mock: `crypto.randomBytes` chamado; `Math.random` não |
| SECRET-004 | formato base32 sem ambiguidade | saída não contém `0`,`1`,`8`,`9`,`+`,`/`,`=` (RFC 4648 alfabeto A–Z2–7) |
| SECRET-005 | segredo nunca vai a disco em claro | após `generateAndPersist`, leitura do arquivo de estado contém `sha256:` e **não** contém a string do segredo |
| SECRET-006 | modo do arquivo | `fs.stat().mode & 0o777 === 0o600` |
| SECRET-007 | escrita atômica | tmp + `rename` no mesmo diretório; teste simula falha entre escrita e rename e confirma que o arquivo antigo permanece íntegro (a issue #441 do DSH documenta exatamente o bug de reescrita não atômica no hospedeiro — não replicar) |
| SECRET-008 | rotação invalida sessões | gerar novo segredo ⇒ toda sessão anterior rejeitada na requisição seguinte |
| SECRET-009 | segredo nunca aparece em log | ver §6.5 (canário) |
| SECRET-010 | comparação do segredo em repouso | SHA-256 + `timingSafeEqual` sobre os 32 bytes |
| SECRET-013 | canonicalização da entrada | `canonicalizeSecret` faz upper-case e remove `-` e espaço; `k7qf 2m9x…` e `K7QF-2M9X…` produzem o mesmo digest, e nada além disso é normalizado |
| SECRET-014 | entrega LOCAL no primeiro boot | `bin/dsh-guard-setup` imprime a senha **uma vez**, em texto **e** como QR code ASCII na mesma tela; a segunda execução **não** reimprime |
| SECRET-015 | `GET /__guard/secret?ott=<token>` com `ott` válido | 200 com a senha, **uma única vez**; o `ott` é de 128 bits, tem TTL de 10 min e é impresso no **stdout do terminal**, nunca enviado por nenhum canal remoto |
| SECRET-016 | `GET /__guard/secret` sem `ott`, com `ott` inválido, expirado ou já consumido | **404 idêntico**, byte a byte, ao de uma rota inexistente — o teste compara com a resposta de `/__guard/rota-que-nao-existe`. Nada distingue "rota morta" de "token errado" |
| SECRET-017 | consumo do `ott` | após o primeiro 200, a rota **deixa de existir**: a segunda requisição com o mesmo `ott` devolve o mesmo 404 indistinguível |
| SECRET-018 · **SEC-14** | a senha permanente **nunca** trafega por canal remoto | invariante testado sobre **todo** payload de `sendMessage`/`editMessageText`/`answerCallbackQuery` e sobre **todo** frame do IPC host↔worker: o canário (§6.5) não aparece em nenhum deles. É a mesma invariante que `03-ONDAS.md` cobra pelo nome `SEC-14`, e ela **não é negociável** (D3) |

> **NÃO CONFIRMADO — decisão de KDF.** O plano assume que, para um token gerado
> por máquina com ≥128 bits de entropia, hash rápido + comparação em tempo
> constante é suficiente e Argon2id é desnecessário. A pesquisa **refutou** a
> forma como essa regra foi atribuída: ASVS 5.0 6.5.2 fala de *lookup secrets*
> (códigos de backup de MFA), não de tokens em geral, e a ASVS é **silente**
> sobre armazenamento de reference tokens. Portanto isto é uma decisão de
> engenharia justificada (2¹²⁸ inviabiliza ataque offline; Argon2id a 19–46 MiB
> por tentativa abre vetor de DoS de memória), **não** uma exigência normativa.
> Teste correspondente: `SECRET-011` documenta a decisão em comentário e falha se
> alguém trocar o caminho por um KDF sem revisar o vetor de DoS. **Se um dia o
> humano escolher a senha**, Argon2id (m=19456, t=2, p=1) passa a ser obrigatório
> e SECRET-012 cobre isso.

Sessão (`test/unit/session/store.test.ts`), relógio injetado:

| ID | Caso | Esperado |
| --- | --- | --- |
| SESS-001 | ID de sessão | ≥128 bits de CSPRNG, opaco, sem estrutura decodificável |
| SESS-002 | nome e atributos do cookie | nome **exato** `__Host-dsh_sid` (D5) + `Secure` + `HttpOnly` + `SameSite=Strict` + `Path=/`, sem `Domain` (NIST 63B-4 §5.1.1). O nome é asserido literalmente, porque emitir dois nomes diferentes em dois módulos é a falha silenciosa clássica |
| SESS-003 | idle timeout | relógio avança além do limite ⇒ sessão rejeitada |
| SESS-004 | absolute timeout | idem, independente de atividade |
| SESS-005 | regeneração pós-login | ID muda após autenticação bem-sucedida |
| SESS-006 | CSRF | mutação (`POST`/`DELETE`) sem token anti-CSRF ⇒ `403`. Se a superfície usar `Authorization: Bearer` em vez de cookie, o teste vira "o header não é enviado automaticamente cross-site" e o caso CSRF é dispensado com justificativa escrita |
| SESS-007 | sessão não cai para HTTP | requisição sem TLS na borda ⇒ recusa (verificável só via header `X-Forwarded-Proto` do túnel — ver §6.2, esse header **também** é forjável, então o teste documenta a limitação) |
| SESS-008 | logout | invalida do lado do servidor, não só apaga cookie |
| SESS-009 | derrubar o túnel invalida sessões | `POST /__guard/api/tunnel/stop` (ou expiração do TTL, TUN-016) invalida **todas** as sessões emitidas; a requisição seguinte com o cookie antigo é rejeitada |
| SESS-010 | cookie `__Host-`/`Secure` no painel local em `http://127.0.0.1` | **NÃO CONFIRMADO — spike obrigatório.** `02-SEGURANCA.md` §L4 diz que sessão autenticada *SHALL NOT* cair para `http`, e o caminho local do produto é exatamente `http://127.0.0.1:3080`. O teste nasce como **sonda**: emite o cookie pelo caminho local, lê de volta pelo mesmo caminho e **imprime** o resultado; a decisão (aceitar `127.0.0.1` como origem segura, usar nome sem prefixo `__Host-` no modo loopback, ou recusar sessão fora do túnel) é congelada no COMMIT PREP 2 e só então o teste vira asserção |

#### 5.2.1 Arquivo de estado (`test/unit/state/**`, `test/integration/state/**`)

`src/state/store.ts` é o **único writer** do `state.json` (D1). Quatro módulos
leem e escrevem através dele — segredo (digest), sessão, modo restrito e estado
desejado do controlador — e é exatamente por isso que ele precisa de suíte
própria: escrita concorrente sem um dono é a receita para estado corrompido.

Caminho canônico (D5): `$XDG_STATE_HOME/dsh-guarded-bot/state.json`, com fallback
`~/.local/state/dsh-guarded-bot/state.json`; arquivo `0600`, diretório `0700`. O
nome `mobile-gateway.json` está **morto** e um teste garante que ele não
reaparece.

| ID | Caso | Esperado |
| --- | --- | --- |
| STATE-001 | resolução de caminho | `$XDG_STATE_HOME` definido ⇒ usa; ausente ⇒ `~/.local/state/`; nunca escreve dentro do workspace |
| STATE-002 | criação do diretório | modo `0700`; se já existir com modo mais frouxo, **recusa carregar** (*fail loud*), não conserta em silêncio |
| STATE-003 | modo do arquivo | `0600`; arquivo com modo > `0600` ⇒ recusa de carga com erro acionável |
| STATE-004 | escrita atômica | tmp **no mesmo diretório** + `fsync` + `rename`; nunca `write` em cima do arquivo vivo |
| STATE-005 | interrupção entre write e rename (integração) | o arquivo anterior permanece íntegro e legível; nenhuma janela em que o estado some |
| STATE-006 | JSON corrompido | *fail loud* no boot com mensagem acionável; **nunca** "assume estado vazio" — assumir vazio apaga o digest da senha e o modo restrito |
| STATE-007 | versionamento | `version: 1` presente; arquivo de versão desconhecida ⇒ recusa com instrução, nunca migração adivinhada |
| STATE-008 | escritores concorrentes | duas escritas disparadas no mesmo tick produzem um arquivo válido e a última escrita vence; nenhum JSON parcial |
| STATE-009 | nome morto | `git grep -n 'mobile-gateway.json'` no repositório devolve **zero** ocorrências fora de tabela de correção |
| STATE-010 | a URL do túnel **não** é persistida | após um ciclo start/stop, o `state.json` não contém nenhum hostname `trycloudflare.com` (TUN-015) |
| STATE-011 | segredos do bot | `TELEGRAM_BOT_TOKEN` e `TELEGRAM_OWNER_CHAT_ID` vivem em `$XDG_STATE_HOME/dsh-guarded-bot/secrets.env`, mesmo modo `0600`, **fora** do `state.json` e fora do workspace |

#### 5.2.2 Link mágico de uso único (`test/unit/session/magic.test.ts`, `test/unit/panel/magic.test.ts`)

Decisão canônica D3: a **senha** nunca trafega pelo Telegram; o **link mágico**
trafega, e ele é **ligado por padrão** quando `exposure.mode: 'tunnel'`
(`control.magicLink` default `true`; em `mode: 'loopback'`, default `false`). O
que viaja é um bearer `mk` de 128 bits, TTL 120 s, uso único, **só em memória**.
Não existe opt-in: existe opt-out.

| ID | Caso | Esperado |
| --- | --- | --- |
| MAG-001 | `GET /__guard/magic` | **inerte**: HTML estático que não consome nada, não emite sessão e não queima o `mk`. Um `GET` disparado por preview de link ou crawler não pode custar o token |
| MAG-002 | `POST /__guard/magic` com `mk` válido dentro do TTL | emite sessão (`__Host-dsh_sid`) e **queima** o `mk` |
| MAG-003 | segundo `POST` com o mesmo `mk` | rejeitado; evento de auditoria emitido; nenhuma sessão nova |
| MAG-004 | TTL | relógio avança 121 s ⇒ `POST` rejeitado |
| MAG-005 | `mk` só em memória | após reinício do processo, todo `mk` pendente é inválido; nada dele aparece no `state.json` |
| MAG-006 | consumo sem clique detectável (User-Agent de crawler / requisição sem interação) | **não** emite sessão, **não** queima o `mk` e registra `magic.crawler-suspect` no audit log |
| MAG-007 | transporte do `mk` | o `mk` viaja no **fragmento** (`#`) da URL, nunca em query string — o teste inspeciona o texto enviado ao Telegram e falha se encontrar `?mk=` ou `&mk=` |
| MAG-008 | preview desabilitado | a mensagem sai com `disable_web_page_preview: true` |
| MAG-009 | opt-out | com `control.magicLink: false`, `/acessar` responde com a instrução do caminho local (QR / `--reset`), e **nenhum** link é enviado |
| MAG-010 | o `mk` não é a senha | o payload do link mágico não contém o segredo permanente (SEC-14 / SECRET-018) e a sessão emitida por ele tem os **mesmos** timeouts das demais (SESS-003/004) |

> Dono dos arquivos: `src/session/magic.ts` é de **T2.2** (Onda 2, primitiva
> pura); `src/panel/magic.ts` é de **T3.4** (Onda 3, rota). Logo MAG-001…MAG-006
> se dividem entre as duas ondas conforme o arquivo exercitado, pela regra de
> propriedade de D1.

### 5.3 Bot do Telegram — sem bater na API real

**Onde mora o código sob teste (D1/D2):** o bot é um **subprocesso
supervisionado** (`detached: true`), no mesmo pacote npm, compilado para
`dist/worker/telegram-bot.js`. O código dele vive em `worker/**` — `worker/lib/**`
(grammY), `worker/auth/**` (allowlist, guard, recepção de `/parear`),
`worker/commands/**` (roteador e comandos) e `worker/ipc.ts`. **Não existe**
`src/telegram/bot.ts` nem `src/telegram/allowlist.ts`; o que fica no host é
`src/telegram/{onboarding,pairing,ipc}.ts`. Os testes seguem a árvore:
`test/unit/worker/**` e `test/unit/telegram/**`.

Regra absoluta: **nenhum teste automatizado fala com `api.telegram.org`.** Três
níveis de dublê, do mais barato ao mais fiel:

**Nível 1 — núcleo puro (a maior parte do valor).** A decisão do bot é uma
função pura:

```ts
// assinatura ilustrativa, não implementação
type Intent =
  | { kind: 'reply'; text: string }
  | { kind: 'answerCallback'; id: string; text?: string; showAlert?: boolean }
  | { kind: 'command'; cmd: ControlCommand; confirmToken?: string }
  | { kind: 'deny'; reason: 'not-allowlisted' | 'no-sender' | 'expired-token' }

function decide(update: Update, deps: { now: () => number; allowlist: readonly number[]; pending: PendingStore }): Intent[]
```

Zero I/O. Toda a matriz de allowlist, idempotência e confirmação vive aqui.

**Nível 2 — transporte falso.** Uma costura `ApiTransport { call(method, params):
Promise<unknown> }` com implementação de teste que grava chamadas e devolve
respostas de fixture. Prova que o intent virou a chamada certa
(`answerCallbackQuery` **sempre** chamado, `editMessageText` em vez de
`sendMessage`+`deleteMessage`, etc.).

**Nível 3 — servidor HTTP local com a forma da Bot API** (`test/support/telegram-server.ts`).
`http.createServer` em `127.0.0.1:0`, roteando `/bot<token>/<method>` e devolvendo
o envelope real `{ ok: true, result: … }` / `{ ok: false, error_code, description,
parameters }`. Usado para testar a biblioteca de verdade (long polling, retry de
429, tratamento de 409) sem internet.

> **NÃO CONFIRMADO:** o nome exato da opção do grammY para apontar a raiz da API
> para outro host (algo como `new Bot(token, { client: { apiRoot } })`) não foi
> verificado pela pesquisa. Spike da Onda 0: confirmar no `.d.ts` do pacote
> `grammy@1.45.1` e registrar em `docs/spikes/`. Se não existir, o nível 3 recua
> para "testar nosso wrapper de transporte", e o long polling real fica coberto
> apenas pelo roteiro manual M1.

Escolha de biblioteca (do dossiê, para justificar o desenho do dublê): grammY
1.45.1 (17/jul/2026), 3,1 M downloads/semana, suporte a Bot API 10.2 dois dias
após o anúncio, plugin oficial de auto-retry que lê `retry_after`. `telegraf`
está parado desde fev/2024 e não suporta Bot API 8/9/10.

#### 5.3.1 Allowlist — **o teste de segurança mais importante do projeto** (`test/unit/worker/auth/allowlist.test.ts`)

A Bot API **não oferece nada pronto**: a própria documentação coloca a
responsabilidade no backend ("Your backend should always verify that received
commands are valid and that the user was authorized to use them regardless of
scope"). Sem allowlist, qualquer pessoa que ache `t.me/seu_bot` executa
`/desligar`. Esta é a `L6` de [02-SEGURANCA](02-SEGURANCA.md).

Fixtures em `test/support/fixtures/telegram/`, IDs sintéticos:
`OWNER = 100000000000001`, `STRANGER = 100000000000002`.

| ID | Update | Esperado | Armadilha coberta |
| --- | --- | --- | --- |
| TG-001 | `message` de OWNER em DM | aceito | caminho feliz |
| TG-002 | `message` de STRANGER em DM | `deny:not-allowlisted`, **nenhum** efeito colateral | básico |
| TG-003 | `callback_query` de STRANGER sobre mensagem que o bot mandou em **grupo** | negado | ★ em grupo, qualquer membro aperta o botão; validar só `chat.id` está furado |
| TG-004 | `message` **sem** `from` (channel post) | negado | `message.from` é opcional; ausência ⇒ negação, nunca `undefined === undefined` |
| TG-005 | `from.id` = OWNER, `chat.id` = grupo não listado | negado | validar os **dois** eixos |
| TG-006 | `from.id` = STRANGER, `chat.id` = DM do OWNER | negado | idem, eixo invertido |
| TG-007 | allowlist vazia | nega **tudo**, inclusive OWNER | fail-closed, mesma semântica de `trustedRemotes: []` já implementada |
| TG-008 | `from.username` bate, `from.id` não | negado | username é mutável e sequestrável; a allowlist é **só numérica** |
| TG-009 | `from.id` como **string** `"100000000000001"` | negado (ou normalizado com asserção explícita) | evita `==` frouxo |
| TG-010 | `from.id` com 52 bits significativos | aceito, sem perda de precisão | IDs têm até 52 bits; `int32` quebra |
| TG-011 | `chat.id` negativo (supergrupo) | tratado como número, não como sinal | |
| TG-012 | `edited_message` de STRANGER | negado | superfície esquecida |
| TG-013 | `my_chat_member` / `chat_member` | ignorado ou negado, nunca executa comando | |
| TG-014 | update de tipo desconhecido/futuro | ignorado silenciosamente, sem exceção | Bot API evolui |
| TG-015 | `inline_query`, `channel_post` | negados | |
| TG-016 | **remoção** do ouvinte de allowlist (mutação) | pelo menos 1 teste falha | garantia contra "o gate sumiu e ninguém viu" |

#### 5.3.2 Confirmação em duas etapas para ação destrutiva (`test/unit/control/confirm.test.ts` + `test/unit/worker/auth/guard.test.ts`)

**Quem emite o nonce é o HOST.** `src/control/confirm.ts` (T5.1) emite e valida o
nonce server-side, com TTL de 60 s, para as ações que **aumentam exposição**; o
worker apenas o transporta opaco dentro do `callback_data`. Nenhum teste pode
escrever o contrário: `callback_data` não prova autorização, e um nonce validado
no worker seria validado do lado errado da fronteira (D2).

`callback_data` é **client-supplied** (1–64 **bytes**) — um cliente modificado
manda qualquer string, e a própria doc do Telegram avisa que a mensagem de origem
pode nem conter aquele botão. Portanto `callback_data` **nunca** é prova de
autorização.

| ID | Caso | Esperado |
| --- | --- | --- |
| TG-020 | `/desligar` | não executa; responde com teclado inline de confirmação contendo token efêmero opaco |
| TG-021 | confirmação com token válido, dentro do TTL, mesmo `from.id` | executa 1 vez |
| TG-022 | mesmo token de novo | rejeitado (uso único) |
| TG-023 | token expirado (relógio avança além do TTL) | rejeitado, com mensagem de reinício do fluxo |
| TG-024 | token válido, **outro** `from.id` | rejeitado — o token é ligado ao emissor |
| TG-025 | `callback_data` forjado com payload administrativo direto (`srv:off:v1`) sem passar pelo fluxo | rejeitado; nenhum comando destrutivo é acionável em uma etapa |
| TG-026 | `callback_data` > 64 bytes na **saída** | falha de construção detectada em teste, não em produção |
| TG-027 | `answerCallbackQuery` | chamado em **todos** os caminhos, inclusive negação — sem ele o cliente fica com barra de progresso girando |
| TG-028 | atualização de estado | usa `editMessageText` (1–4096 chars) e não `sendMessage`+`deleteMessage` |
| TG-029 | estilo dos botões | **NÃO CONFIRMADO — spike obrigatório (T0.3).** A existência do campo `InlineKeyboardButton.style` (valores `success`/`danger`/`primary`) **não foi verificada** contra a referência da Bot API; ela entrou no plano como fato sem lastro. Enquanto o spike não confirmar lendo a doc oficial, TG-029 é `skip` com TODO nomeado e **nenhuma entrega pode depender do campo** — o teclado se distingue por **texto** (`⛔ Desligar`), que é garantido. Se o spike confirmar, TG-029 vira asserção normal |

> Nota de honestidade herdada da pesquisa: a alegação "quem tem o token contorna
> **completamente** a allowlist" foi **refutada** como generalização. Sob long
> polling, o portador do token não tem endpoint para onde postar um update
> forjado, e bots não veem mensagens de outros bots. O que o vazamento dá é
> personificação do bot, roubo da fila via `getUpdates`, sequestro via
> `setWebhook` e DoS por 409 — confidencialidade e disponibilidade, não execução.
> O vetor **real** de execução é confuso-deputado: com o token, o atacante manda
> como o bot um teclado inline cujo `callback_data` é comando destrutivo, e se o
> **dono** clicar, passa. TG-020…TG-025 são exatamente a mitigação disso, e
> `ADV-030` (§6.4) é o teste que encena o ataque.

#### 5.3.3 Idempotência, entrega e limites

| ID | Caso | Esperado |
| --- | --- | --- |
| TG-040 | mesmo `update_id` processado duas vezes | efeito aplicado 1 vez (dedupe por `update_id` com janela) |
| TG-041 | `/ligar` com o túnel já `READY` | no-op; responde com o estado atual e a mesma URL; nenhum `spawn` novo |
| TG-042 | `/desligar` com o túnel já `STOPPED` | no-op idêntico |
| TG-043 | resposta 429 com `parameters.retry_after: 3` | espera exatamente 3 s pelo relógio injetado e repete 1 vez; não faz retry cego em loop |
| TG-044 | resposta 409 (`terminated by other getUpdates request`) | log de erro claro + **o processo do worker sai** (não há segundo consumidor legítimo); o host observa o `close` e reporta `DEGRADED`. **Não** entra em loop de reconexão agressiva |
| TG-045 | boot | descarta a fila pendente ao subir — updates ficam até 24 h no servidor, e um bot que liga/desliga servidor não pode executar uma avalanche de comandos velhos ao voltar. **Correção de fato:** `drop_pending_updates` **não** é parâmetro de `getUpdates`; ele é parâmetro de `setWebhook`/`deleteWebhook` e, no long polling do grammY, opção de `bot.start({ drop_pending_updates: true })`. O teste assere a chamada **onde ela realmente existe** e falha se alguém a colocar no `getUpdates` |
| TG-046 | `allowed_updates` | enviado explicitamente (`["message","callback_query"]`); teste garante que não é omitido — omitir **mantém a configuração anterior** no servidor, que é estado invisível |
| TG-047 | `timeout` do long polling | ≤50 (o servidor clampa em `LONG_POLL_MAX_TIMEOUT = 50`) |
| TG-048 | mensagem > 4096 chars | truncada/particionada antes de enviar, nunca estourando na API |
| TG-049 | 1 msg/s por chat | o emissor serializa; teste com relógio confirma espaçamento |

#### 5.3.4 Onboarding — detecção de estado (`test/unit/telegram/onboarding.test.ts`)

O detector de estado é puro: recebe um retrato do ambiente e devolve o próximo
passo. Fluxo real: BotFather → `/newbot` → nome + username terminando em `bot` →
token `<id>:<segredo>` → `getMe` → **pareamento por código** (§5.3.5) → gravação
em `secrets.env` `0600` dentro do diretório de estado canônico (D5), **nunca**
dentro do workspace.

| ID | Estado do ambiente | Próximo passo esperado |
| --- | --- | --- |
| TG-060 | sem `TELEGRAM_BOT_TOKEN` | instrução do BotFather, **com o texto exato a digitar**, sem jargão. O texto é artefato entregue e revisável de T4.1, não improviso do implementador |
| TG-061 | token presente, formato inválido (sem `:`, começa com `0`, >80 chars) | erro de formato **antes** de qualquer chamada de rede |
| TG-062 | token formalmente válido, `getMe` devolve 401 | "token revogado ou errado; use `/token` no BotFather" |
| TG-063 | `getMe` OK, **sem dono pareado** (`TOKEN_OK_SEM_DONO`) | exibe o **código de pareamento de 6 dígitos** no terminal (e no painel local) e instrui: "mande `/parear <código>` ao bot". **Não** instrui a mandar `/start`, e **nenhum** `/start` pareia ninguém (D8) |
| TG-064 | nenhum `/parear` chegou dentro do TTL de 5 min | código expira; a ferramenta oferece gerar outro; não trava e não abre janela permanente |
| TG-065 | `/parear` com o código **correto** | `from.id` **e** `chat.id` são lidos **do update que carrega o código correto** — nunca do primeiro update que chegar. Grava o dono e **fecha** o pareamento |
| TG-066 | dois updates com códigos diferentes, um correto | só o que carrega o código correto pareia; o outro é descartado em silêncio e contado |
| TG-067 | tudo configurado | "pronto"; a ferramenta é **idempotente** (rodar 2× não duplica nada, não regera segredo, não reabre pareamento) |
| TG-068 | `secrets.env` já existe | preserva as demais linhas; grava com modo `0600` no diretório de estado, fora do git |
| TG-069 | token no `argv` do processo | **recusado** com explicação — argv vaza em `ps` |
| TG-070 | o que o usuário **vê** em cada um dos 4 estados | cada estado do detector tem uma mensagem correspondente, em português, sem stack trace e sem nome de símbolo interno; o teste compara com o texto congelado (snapshot) e falha se alguém trocar por uma mensagem técnica |
| TG-071 | superfície do painel | o mesmo motor de onboarding responde por `GET /__guard/api/state` (campo de onboarding) — o usuário que chega pelo painel local vê o mesmo passo que veria na CLI, e não uma tela vazia |
| TG-072 | os 5 avisos obrigatórios | o roteiro de onboarding exibe, antes do primeiro túnel: (1) `trustedRemotes` fica inerte sob túnel; (2) o túnel fura o firewall; (3) a Cloudflare vê o tráfego em texto claro na borda; (4) a URL **não** é segredo; (5) `trycloudflare.com` tem reputação de malware em alguns filtros. O teste assere a presença dos cinco |

#### 5.3.5 Pareamento do dono (`test/unit/telegram/pairing.test.ts` + `test/unit/worker/auth/pairing.test.ts`)

Decisão canônica **D8**: vale `02-SEGURANCA.md` §7.2 integralmente. O anti-padrão
"o primeiro que der `/start` vira dono" é uma **corrida que o atacante ganha** —
nomes de bot são adivinháveis e o dono está lendo o tutorial enquanto o atacante
tem um script. `getUpdates` é só o **transporte**; a identidade vem do update que
carrega o código correto.

| ID | Caso | Esperado |
| --- | --- | --- |
| PAIR-001 | geração do código | 6 dígitos de CSPRNG, TTL 5 min, uso único, exibido **apenas** no terminal/painel local — nunca por mensagem |
| PAIR-002 | `/parear` com código correto dentro do TTL | pareia; grava `from.id` **e** `chat.id`; responde confirmando |
| PAIR-003 | `/parear` com código errado | **não** pareia; contado para o limite de tentativas (RL-018); resposta genérica que não diz quantos dígitos acertou |
| PAIR-004 | `/parear` com código expirado | não pareia |
| PAIR-005 | segundo `/parear`, depois de já haver dono | **recusado**, mesmo com código válido; reabrir exige `--reset-pairing` **na máquina** |
| PAIR-006 | `/start` de um estranho | responde boas-vindas inócua e **não** pareia ninguém; `/start` não aparece em `setMyCommands` |
| PAIR-007 | força bruta | tentativas de `/parear` de identidade não pareada são limitadas e atrasadas; 6 dígitos sem limite é enumerável em minutos |
| PAIR-008 | `--reset-pairing` | só funciona localmente, exige confirmação, invalida o dono anterior e emite evento de auditoria |
| PAIR-009 | corrida | dois `/parear` com o código correto no mesmo tick ⇒ **um** dono, resultado determinístico, o segundo recebe recusa |
| PAIR-010 | o código nunca vaza | o código de pareamento não aparece em log, em resposta HTTP nem em payload do Telegram (§6.5) |

#### 5.3.6 Vocabulário de comandos (`test/unit/worker/commands/router.test.ts`)

Lista canônica e fechada (D5), **nesta ordem**, publicada por `setMyCommands`:
`/ligar`, `/desligar`, `/status`, `/acessar`, `/rotacionar`, `/parear <código>`,
`/emergencia`. Os nomes `/parar`, `/parar_bot`, `/desligar_servidor`,
`/abrir_tunel` e `/vincular` estão **mortos** e não podem reaparecer.

| ID | Caso | Esperado |
| --- | --- | --- |
| TG-080 | `setMyCommands` | publica **exatamente** a lista acima, na ordem acima — o teste compara o array inteiro, não "contém" |
| TG-081 | comando morto | `/parar`, `/parar_bot`, `/desligar_servidor`, `/abrir_tunel`, `/vincular` não são roteados para nenhum intent; `git grep` deles no repositório devolve zero fora de tabela de correção |
| TG-082 | `/ligar` | dispara o fluxo de confirmação de 2 etapas (aumenta exposição): responde com teclado e **nonce emitido pelo host**; só a confirmação executa |
| TG-083 | `/desligar` | executa a redução de exposição; confirmação de 2 etapas conforme TG-020 (destrutiva do ponto de vista do usuário) |
| TG-084 | `/status` | responde estado atual, `seq`, se há túnel, há quanto tempo, e **quando o TTL expira**; não expõe segredo nem digest |
| TG-085 | `/acessar` | com `control.magicLink` ligado, envia o link mágico (§5.2.2); com opt-out, responde a instrução do caminho local. **Nunca** envia a senha |
| TG-086 | `/rotacionar` | gera nova senha, invalida sessões (SECRET-008), **não** envia a senha nova pelo chat: entrega o caminho local (QR/`ott`) e, se `magicLink` estiver ligado, um link mágico para o painel |
| TG-087 | `/emergencia` | derruba túnel **e** worker, entra em estado seguro e responde uma vez; é idempotente e não exige confirmação (é a ação que **reduz** exposição) |
| TG-088 | `/parear <código>` | ver PAIR-002…PAIR-005 |
| TG-089 | comando de identidade não pareada | descartado em **silêncio** e **contado** — nenhuma resposta que confirme a existência do bot para quem não é dono |

### 5.4 Supervisor do `cloudflared` — sem túnel real

#### 5.4.1 Binário falso (`test/bin/fake-cloudflared.mjs`)

Um script Node que imita as propriedades **medidas** do `cloudflared` 2026.7.3.
Modos por `argv`/env, para que cada teste escolha o comportamento:

| Modo | Comportamento |
| --- | --- |
| `--fake=happy` | após `FAKE_DELAY_MS` (default 300) escreve em **stderr** a caixa ASCII `… INF \|  https://xxx-yyy-zzz-www.trycloudflare.com   \|`, sobe um servidor de métricas em `--metrics` respondendo `GET /quicktunnel` com `{"hostname":"xxx-yyy-zzz-www.trycloudflare.com"}`, `GET /ready` com `{"status":200,"readyConnections":1,…}` e `GET /healthcheck` com `OK`; fica vivo até receber sinal |
| `--fake=silent` | nunca imprime URL, nunca sobe `/quicktunnel`; fica vivo (testa timeout) |
| `--fake=slow` | imprime a URL após 8 s (testa que o timeout é > isso e o polling persiste) |
| `--fake=crash` | imprime a URL, vive `FAKE_LIFETIME_MS` e sai com código 1 (testa crash-loop) |
| `--fake=instant-exit` | sai imediatamente com código 1, sem imprimir nada |
| `--fake=stdout-only` | imprime a URL em **stdout** — o teste TUN-005 exige que isso **não** seja aceito |
| `--fake=stubborn` | instala handler de `SIGTERM` que ignora o sinal (testa a escalada para `SIGKILL`) |
| `--fake=tree` | gera um neto (`sleep 300`) antes de imprimir a URL (testa tree-kill) |
| `--fake=partial-line` | emite a URL partida em dois chunks com 50 ms de intervalo (testa acumulação de buffer) |

O caminho do binário entra por config (`tunnel.binaryPath`), então o teste passa
`process.execPath` + o script. **Nenhum teste de `test/unit/**`,
`test/integration/**`, `test/security/**` ou `test/e2e/**` invoca o `cloudflared`
real** — nem localmente, nem no CI, nem no gate.

O `cloudflared` de verdade é exercitado em exatamente **dois** lugares, ambos
fora do gate (D10):

| Nível | Onde | Como roda |
| --- | --- | --- |
| `live` | `test/live/quick-tunnel.test.ts` | `pnpm test:live`, exige `DSH_GUARD_LIVE_TESTS=1`, workflow `live.yml` em `workflow_dispatch`. **Nunca** em PR, nunca em `push`, nunca no gate de onda |
| manual | roteiro **M2** (§9) | pessoa, máquina, celular na 4G |

Motivo, e ele é medido: subir quick tunnel em CI publica na internet o que
estiver na porta — a própria pesquisa registra que isso expôs o DSH real do
usuário por ~40 s. O aceite de onda que exigia "um `cloudflared` real" foi
substituído, por decisão canônica, pelo dublê + M2.

`test/bin/fake-cloudflared.mjs` é **prep-owned** (PREP 2): nenhuma sub-tarefa o
edita depois de congelado. Um modo novo de dublê é mudança de contrato, não
detalhe de teste.

#### 5.4.2 Descoberta da URL (`test/unit/tunnel/discover.test.ts` + integração)

Fato verificado empiricamente pela pesquisa (cloudflared 2026.7.3, medido nesta
máquina): o metrics server expõe `GET /quicktunnel` devolvendo
`{"hostname":"…trycloudflare.com"}` — **sem esquema**, é preciso prefixar
`https://`. Esse endpoint **não** está documentado na página oficial de métricas,
que só menciona `/metrics`. E a URL nos logs sai **100 % em stderr**: em duas
execuções medidas o stdout ficou com exatamente 0 bytes. `--output json` não
ajuda: a URL continua embutida na caixa ASCII dentro do campo `message`.

| ID | Caso | Esperado |
| --- | --- | --- |
| TUN-001 | `/quicktunnel` responde 200 com hostname | URL final é `https://` + hostname; caminho preferido |
| TUN-002 | hostname vem **sem** esquema | prefixo adicionado; nunca `https://https://` |
| TUN-003 | `/quicktunnel` responde 404 nas primeiras N tentativas e depois 200 | polling persiste até o deadline; sucesso |
| TUN-004 | `/quicktunnel` inalcançável (ECONNREFUSED) durante todo o warmup, mas a URL aparece no stderr | fallback por regex `https://[-a-z0-9]+\.trycloudflare\.com` funciona |
| TUN-005 | URL só em **stdout** | **não** é aceita — o parser lê stderr; congela a decisão e mata o mutante "ler as duas" |
| TUN-006 | URL partida entre dois chunks | acumulador de buffer casa a regex; sem perda |
| TUN-007 | linha com a caixa ASCII e barras verticais | extrai só a URL, sem barra vertical nem espaços |
| TUN-008 | duas URLs no mesmo buffer | usa a primeira e ignora as demais |
| TUN-009 | 30 s sem URL nem `/quicktunnel` (relógio injetado) | erro `TunnelReadinessTimeout`; supervisor mata o processo e transita para `DEGRADED` (falhou **e** ainda há orçamento) |
| TUN-010 | processo morre **durante** o warmup | o wait aborta imediatamente no `'close'`, sem esperar o deadline (`AbortController` abortado no `close`) |
| TUN-011 | `--metrics` | sempre passado explicitamente como `127.0.0.1:<porta>`; teste assere o argv. O default do 2026.7.3 é `localhost:0` (porta aleatória) com fallback em 20241–20245 — não confiar |
| TUN-012 | readiness completa | só transita para `READY` após a URL estar disponível **e** o probe de readiness (`src/tunnel/readiness.ts`) confirmar que a URL é utilizável. Porta aberta ≠ app pronta. **Readiness não é o probe de segurança**: o probe fail-closed de 4 sondas (§5.4.6) é **pré-condição de `STOPPED → STARTING`** e roda **antes**, não depois |
| TUN-013 | `--loglevel debug` | **proibido** — assere que não está no argv. O modo debug loga URLs, métodos e **todos** os headers, o que vaza credencial |
| TUN-014 | token de named tunnel | passado por `--token-file`, nunca por argv (argv vaza em `ps`); teste assere ausência do segredo em `spawn.argv` |
| TUN-015 | URL do túnel nunca é persistida em disco | ela muda a cada arranque; valor velho entrega link morto com confiança (ver STATE-010) |

#### 5.4.3 Ciclo de vida, backoff e crash-loop (`test/integration/tunnel/supervisor.test.ts`)

Reaproveita integralmente a mecânica já testada do supervisor do worker
(`test/index.test.ts:1072`), parametrizada.

| ID | Caso | Esperado |
| --- | --- | --- |
| SUP-001 | `--fake=crash` sai com 1 | reinício agendado com `computeBackoffDelay(1)` (piso `initialDelayMs`) |
| SUP-002 | 5 quedas seguidas | progressão 500 → 1000 → 2000 → 4000 → 8000 (com jitter por cima), saturando em 10000 |
| SUP-003 | jitter | com `random()` fixo em 0 e em 0,999, os dois extremos respeitam `[base, min(base*1.5, max)]` |
| SUP-004 | uptime saudável ≥ `resetAfterMs` | contador zera; a próxima queda volta ao atraso inicial |
| SUP-005 | orçamento `maxAttempts` esgotado | estado terminal; transita para `FAILED` (terminal, só sai com `reset()` humano — D7); log de erro; notificação ao dono; **sem** novo `spawn` |
| SUP-006 | `--fake=instant-exit` (falha determinística) | não faz retry infinito; ver SUP-005 |
| SUP-007 | ENOENT (binário inexistente) | evento `'error'`, **sem** `'exit'`; supervisor trata pelo `'close'` e classifica como **não-retryable** — sai do loop imediatamente |
| SUP-008 | EACCES | idem SUP-007 |
| SUP-009 | saída intencional (`signal.aborted`) | **não** reinicia (teste já existe em `:1132`) |
| SUP-010 | evento terminal | toda a lógica pendura em `'close'`, nunca só em `'exit'` — um supervisor que espera `'exit'` trava para sempre num ENOENT |
| SUP-011 | `AbortSignal` já abortado no `spawn` | o Node adia o kill para `process.nextTick`: `killed === false` logo após o `spawn`, `true` no tick seguinte. O teste **congela** esse comportamento assimétrico |
| SUP-012 | `AbortError` só é emitido se `child.kill()` devolver `true` | se o processo já saiu, `kill` devolve `false` e **não** há `AbortError`; o código não pode depender de sempre receber um |
| SUP-013 | `err.cause` do `AbortError` | é o `reason` passado a `abort(reason)` |
| SUP-014 | graça no shutdown | `SIGTERM` ao grupo → espera `graceMs` → `SIGKILL`. Com `--fake=stubborn`, o `SIGKILL` **tem** que chegar |
| SUP-015 | `--grace-period` do cloudflared | default 30 s; o nosso `graceMs` é configurado explicitamente e o teste assere o valor no `spawn` spec |

#### 5.4.4 Tree-kill de verdade (`test/e2e/tree-kill-real.test.ts`) ★

Este é o teste que a suíte atual **não tinha** e que deixou o bug do §7.1 passar.
Processos reais, verificação pelo sistema operacional.

**Localização e dono (D25 item 25):** o arquivo permanece em `test/e2e/` — são
processos **locais**, offline, sem rede — e o dono é **T6.4**. Ele bloqueia PR
como todo `test/e2e/**`.

```
1. spawn de test/bin/fake-child-tree.mjs com { detached: true,
   stdio: ['ignore','pipe','pipe'], signal }
2. o filho imprime em stdout: READY parent=<pid> child=<pid do neto>
3. teste lê os dois PIDs e confirma com `ps -o pid,ppid,pgid,sid -p <pid>`:
      PGID(filho) === PID(filho)   e   SID(filho) === PID(filho)
      PPID(neto)  === PID(filho)
4. supervisor.dispose()
5. aguarda 'close' do filho (evento terminal universal)
6. asserção final: `ps -p <pid do neto>` não devolve linha
   E `process.kill(netoPid, 0)` lança ESRCH
```

| ID | Caso | Esperado |
| --- | --- | --- |
| E2E-001 | o cenário acima | neto morto |
| E2E-002 | mesmo cenário **com a guarda `!child.killed` reintroduzida** | o teste **falha** — é o guardião do achado A-CRITICAL |
| E2E-003 | `spawn('sh', ['-c','sleep 300 & wait'])` + `child.kill('SIGTERM')` | neto **sobrevive** — documenta o limite do `kill()` simples |
| E2E-004 | mesmo comando com `{ shell: '/bin/bash' }` e comando único | o bash faz `exec` e **não** deixa processo intermediário; `child.kill()` **basta**. Ver nota abaixo |
| E2E-005 | `{ shell: true }` (dash neste host) | o dash **forka**; `sleep` sobrevive ao `child.kill()` |
| E2E-006 | filho **não** detached | `process.kill(-child.pid, 0)` lança ESRCH — `child.pid` não é PGID |
| E2E-007 | filho que chama `setsid` por conta própria (`spawn('setsid',['sleep','5'])`, `detached:false`) | ganha PGID próprio; `kill(-pid,0)` **sucede**. Contra-exemplo que impede a suíte de codificar a regra errada |
| E2E-008 | grupo já morto | `deps.kill` lança ESRCH e o disposer **engole** (teste já existe em `:1243`) |
| E2E-009 | `dispose()` 3× | 1 kill (idempotência; teste já existe em `:1411`) |
| E2E-010 | Windows | `platform: 'win32'` ⇒ nunca chama `process.kill(-pid)`; o caso e2e é `skip` fora do Linux/macOS |

> **Nota importante, e é correção de uma crença comum:** a doc do Node diz que
> "on Linux, child processes of child processes will not be terminated when
> attempting to kill their parent… with the use of the `shell` option". A citação
> é literal e atual, mas a conclusão "`child.kill()` **nunca** basta com shell" é
> **falsa**: depende do shell. O bash aplica a otimização de `exec` do último
> comando e frequentemente não deixa processo intermediário; o dash forka.
> E2E-004 e E2E-005 existem justamente para que a suíte registre a diferença em
> vez de assumir. O comportamento também não é exclusivo do Linux — é reparenting
> POSIX, vale em macOS/BSD.

#### 5.4.5 Órfãos e reaping

| ID | Caso | Esperado |
| --- | --- | --- |
| E2E-011 | supervisor sai normalmente sem `dispose()` | não deixa zumbi (libuv faz `waitpid` dos filhos que ele mesmo spawnou) |
| E2E-012 | supervisor morto com `SIGKILL` | o filho **sobrevive** — teste **documenta** o limite. A mitigação planejada (dead-man's switch: o filho se mata quando o pipe herdado fecha) tem seu próprio caso E2E-013 |
| E2E-013 | pipe do pai fecha | o worker/túnel se encerra sozinho em < 2 s |
| E2E-014 | reparenting | o órfão pode ir para `systemd --user` (subreaper), não necessariamente para PID 1; o teste **não** assere `ppid === 1` |

> **Dependência declarada, e ela é um bloqueio real.** E2E-012 e E2E-013 testam o
> **dead-man's switch** (o filho se encerra quando o pipe herdado fecha) e a
> derrubada de órfão no boot. Esses controles precisam existir do lado do
> `cloudflared` também, não só do worker do Telegram: o `cloudflared` é spawnado
> `detached: true`, que é precisamente o que faz o órfão sobreviver a um
> `SIGKILL` no supervisor. Se a sub-tarefa que entrega o supervisor do túnel
> **não** entregar o dead-man's switch e a verificação de órfão no boot, E2E-012
> e E2E-013 ficam vermelhos — e a resposta certa é **construir o controle**, nunca
> apagar o teste. Um teste sem implementação é um requisito com data; um teste
> apagado é um requisito perdido.

#### 5.4.6 Probe fail-closed antes de subir o túnel (`test/unit/tunnel/probe.test.ts`)

**Decisão canônica D11.** "A aplicação responde" e "o gate está armado" são
coisas diferentes, e a diferença é exatamente o que expôs o DSH real na pesquisa.
O modo de falha é **ordem de carregamento**: `/` vem do `registerFallback` de
`@deepseek-ai/dsh-host-frontend-static` e `/api` vem de outro registro — provar
`/` não prova `/api`.

Quatro sondas **anônimas** contra `127.0.0.1:<porta do DSH>`, todas obrigatórias,
executadas **antes** da transição `STOPPED → STARTING`:

| # | Sonda | Esperado |
| - | --- | --- |
| 1 | `GET /` (fallback da SPA) | 401 |
| 2 | `POST /api/<rpc de leitura>` com corpo vazio | 401 |
| 3 | `GET /` com `Upgrade: websocket` + `Connection: Upgrade` | socket destruído ou 401 |
| 4 | `GET /__guard/probe-canary-<aleatório>` (fora de `guardedPrefixes`) | 401 |

| ID | Caso | Esperado |
| --- | --- | --- |
| TUN-020 | sonda 1 devolve 200 (gate desarmado no fallback) | o túnel **não sobe**; nenhum `spawn` de cloudflared; estado vai para `FAILED`; a mensagem ao dono **nomeia a sonda que falhou** |
| TUN-021 | sonda 2 devolve 200 (gate cobre `/` mas não `/api`) | idem — e este é o caso realista, porque são registros diferentes |
| TUN-022 | sonda 3 completa o handshake de upgrade sem credencial | idem; a superfície de WebSocket desarmada é bloqueio de subida, não aviso |
| TUN-023 | sonda 4 devolve **404** em vez de 401 | idem: 404 significa que a requisição **não passou pelo gate**, e um canário fora de `guardedPrefixes` que não é barrado prova que o gate não é universal |
| TUN-024 | todas as 4 devolvem 401 | o túnel sobe; a decisão é registrada em auditoria com o resultado das quatro |
| TUN-025 | probe é fail-closed | exceção, timeout ou erro de rede **dentro** do probe conta como falha: o túnel não sobe. Nunca "não consegui medir, então deixa subir" |

#### 5.4.7 TTL do túnel (`test/unit/tunnel/ttl.test.ts` + `test/integration/tunnel/ttl.test.ts`)

**Decisão canônica D6.** `tunnel.ttlMinutes` é **obrigatório** no Modo A: default
`60`, teto `480`; `0` ou ausente é **config inválida recusada no load** (*fail
loud*). É o controle que limita a janela de exposição — a variável que mais
importa num quick tunnel público — e o único remédio contra o cenário "abri na
terça, fechei o notebook, o túnel viveu até domingo".

Relógio injetado (`test/support/clock.ts`); nenhum teste espera tempo real.

| ID | Caso | Esperado |
| --- | --- | --- |
| TUN-016 | expiração | avançado o relógio além de `ttlMinutes`, o processo do `cloudflared` morre (`pgrep -f fake-cloudflared` vazio) e o estado vai para `STOPPED` |
| TUN-017 | invalidação de sessões | **todas** as sessões emitidas deixam de autenticar após a expiração (SESS-009); o cookie antigo é rejeitado na requisição seguinte |
| TUN-018 | aviso ao dono | mensagem no Telegram informando que o túnel expirou e como reabrir; emitida **depois** do registro em auditoria |
| TUN-019 | validação de configuração | `ttlMinutes: 0`, ausente, negativo, não inteiro ou `> 480` ⇒ `assertValidConfig` recusa no load, com erro acionável; **nenhum** default silencioso |
| TUN-026 | renovação | um `/status` ou um acesso **não** estendem o TTL; só um novo `start` explícito abre nova janela |

### 5.5 Liga/desliga nas duas superfícies

Fonte única da verdade: um `SystemState` com `seq` monotônico
([01-ARQUITETURA §6](01-ARQUITETURA.md)). Bot e painel são **projeções**.

**Vocabulário canônico da máquina de estados (D7) — seis estados, em inglês:**

`STOPPED | STARTING | READY | DEGRADED | STOPPING | FAILED`

`DEGRADED` = falhou **e** ainda há orçamento (re-tenta sozinho com backoff).
`FAILED` = terminal (orçamento esgotado, `ENOENT`, `EACCES`, config inválida):
só sai com `reset()` humano. Os rótulos em português existem **apenas como texto
de UI** e **nunca** aparecem em código, em teste ou em payload de IPC — nenhum
caso deste documento pode usar `DESLIGADO`, `INICIANDO`, `ONLINE`, `DEGRADADO`
ou `DESLIGANDO` como valor.

**Unidade — controlador puro (`test/unit/control/controller.test.ts`).**

| ID | De → comando | Para | Nota |
| --- | --- | --- | --- |
| CTL-001 | `STOPPED` + `start` | `STARTING` | `seq++` |
| CTL-002 | `STARTING` + `start` | `STARTING`, `seq` inalterado | idempotência |
| CTL-003 | `READY` + `start` | `READY`, `seq` inalterado; resposta repete a URL vigente | idempotência |
| CTL-004 | `STOPPED` + `stop` | `STOPPED`, `seq` inalterado | idempotência |
| CTL-005 | `STARTING` + `stop` | `STOPPING` | cancela o warmup |
| CTL-006 | `READY` + `stop` | `STOPPING` | |
| CTL-007 | `STOPPING` + `start` | **`rejected`** com código `SHUTDOWN_IN_PROGRESS`; estado permanece `STOPPING`; `seq` inalterado; **nenhuma fila** | 09 §D29 — asserção, não sonda |
| CTL-008 | `DEGRADED` + orçamento esgotado | `FAILED` (terminal) | só sai com `reset()` humano |
| CTL-009 | `start` sem segredo forte configurado | recusado, com motivo explícito | §5.7 |
| CTL-010 | `seq` | estritamente crescente em toda sequência de comandos | invariante |
| CTL-011 | `FAILED` + `start` | `FAILED`; recusado com motivo | terminal é terminal |
| CTL-012 | `reset()` humano em `FAILED` | `STOPPED` | único caminho de saída |
| CTL-013 | probe reprovado (§5.4.6) | `STOPPED → FAILED`, sem passar por `STARTING` | pré-condição, não readiness |
| CTL-014 | TTL expirado em `READY` | `STOPPING → STOPPED` + sessões invalidadas | TUN-016/TUN-017 |
| CTL-015 | modo restrito ativo + `start` | recusado com motivo; nenhum `spawn` | RL-014 |

> **CTL-007 e a chave de idempotência foram RESOLVIDOS por `09-DECISOES-CANONICAS.md` §D29.**
> `start` recebido em `STOPPING` é **rejeitado** com `SHUTDOWN_IN_PROGRESS`. Não há fila
> e não há reconciliação posterior: quem quiser subir de novo manda `/ligar` outra vez,
> depois que o estado chegar a `STOPPED`. A razão é fail-closed — enfileirar faria o
> `/emergencia` derrubar o túnel e o túnel voltar sozinho, o que quebra o kill switch
> (02 §L8). A formulação anterior deste documento ("intenção enfileirada; ao concluir
> reconcilia para `STARTING`") está **revogada** e não pode reaparecer em teste nenhum.
>
> **Chave de idempotência:** é o **`requestId`** (ULID) gerado pela superfície que origina
> a intenção e propagado no `ControlIntent`; CTL-002 e CTL-003 asserem sobre ele. O
> **nonce** de `src/control/confirm.ts` é ortogonal — autoriza a ação que aumenta
> exposição e é de **uso único**: `requestId` repetido devolve o resultado da primeira
> execução, nonce repetido é **recusado**. O COMMIT PREP 5 **transcreve** D29 em
> `src/contracts/control.ts`; ele não decide mais nada aqui.


---

### 5.6 Paridade das superfícies, ciclo de vida e desmonte

**Integração — as duas superfícies contra o mesmo controlador
(`test/integration/control/parity.test.ts`).** O controlador roda de verdade; o
painel entra por requisição HTTP no servidor de teste e o bot entra por mensagem
IPC no dublê de worker. Nenhuma das duas fala com o supervisor de túnel direto —
provar isso é o objetivo de CTL-030.

| id | cenário | esperado |
| --- | --- | --- |
| CTL-016 | `start` pelo painel | estado converge para `READY` e o **bot** recebe broadcast com o mesmo `seq` |
| CTL-017 | `start` pelo bot | o **painel** reflete no próximo `GET /__guard/api/state`, com o mesmo `seq` |
| CTL-018 | `start` simultâneo das duas superfícies | **um único** `spawn` de `cloudflared`; a segunda intent é no-op idempotente e devolve a mesma URL |
| CTL-019 | `stop` pelo bot enquanto o painel mostra `READY` | painel converge para `STOPPED`; nenhuma superfície fica com estado obsoleto após o broadcast |
| CTL-020 | `requestId` repetido | devolve o resultado da primeira execução; **nenhum** segundo efeito colateral (D29) |
| CTL-021 | nonce de confirmação repetido | **recusado** (uso único), mesmo com `requestId` novo |
| CTL-022 | nonce expirado (TTL 60 s, relógio injetado) | recusado com motivo; nenhuma mudança de estado |
| CTL-023 | `/ligar` sem etapa de confirmação | recusado; o `spawn` **não** acontece |
| CTL-024 | `/desligar` e `/emergencia` | **não** exigem nonce — a ação que reduz exposição tem que funcionar de primeira |
| CTL-025 | `cloudflared` morto por fora, sem intent | o estado converge (reconciliação), em vez de continuar mentindo `READY` |
| CTL-026 | processo do túnel volta sozinho dentro do orçamento | `DEGRADED` durante a retentativa, `READY` ao voltar; `seq` avança em cada mudança |
| CTL-027 | broadcast perdido (worker reiniciado) | ao reconectar, o worker recebe o estado **completo** com o `seq` corrente, não um delta |
| CTL-028 | duas intents concorrentes na fila | serializadas; nunca há duas transições em voo (a fila é de um) |
| CTL-029 | intent originada por identidade não pareada | recusada antes de tocar a máquina de estado; contada no audit |
| CTL-030 | qualquer superfície chamando o supervisor de túnel direto | `git grep` prova que só `src/control/controller.ts` importa `src/tunnel/supervisor.ts`; o teste falha se aparecer um segundo importador |
| CTL-031 | origem da ação no audit | toda transição registra `telegram:<id>` ou `panel:<session_hash>`; nenhuma transição anônima |
| CTL-032 | modo restrito ativo + `/ligar` pelo bot | recusado com motivo (RL-014); idem pelo painel |
| CTL-033 | `exposure.autoStart: false` (default) | nenhum túnel sobe no boot, mesmo com estado anterior `READY` no `state.json` |
| CTL-034 | estado anterior `READY` no `state.json` + boot | reconciliação decide pelo **processo real**, não pelo arquivo |
| CTL-035 | `start` com config inválida | `FAILED` direto, com motivo; nunca `STARTING` |
| CTL-036 | `reset()` disparado pelo painel em `FAILED` | `STOPPED`; o bot recebe broadcast |
| CTL-037 | `reset()` disparado por identidade não pareada | recusado |
| CTL-038 | TTL expira enquanto o painel está aberto | painel converge para `STOPPED` e mostra o motivo (`TTL`), não um erro genérico |
| CTL-039 | notificação de mudança de estado | sai **depois** da escrita no `AuditSink`; falha do Telegram não impede a transição |
| CTL-040 | **paridade** | para cada ação de `/ligar`, `/desligar`, `/status`, existe a ação equivalente no painel e o resultado observável é **idêntico**. O teste enumera a lista canônica de comandos (D5) e falha se alguma não tiver par |

> Se **S4** der positivo e a superfície de UI nativa do DSH nascer (03 §2.1,
> T5.5), CTL-040 passa a exigir paridade das **três** superfícies. O caso é o
> mesmo; muda a lista que ele enumera.

**Ciclo de vida, disposers e fibers (`test/integration/lifecycle/*.test.ts`).**
Cordis desmonta por disposer LIFO dentro do fiber; o que este bloco prova é que
nenhuma parte do plugin sobrevive ao próprio desmonte.

| id | cenário | esperado |
| --- | --- | --- |
| LIFE-001 | `apply()` seguido de `dispose()` | todo recurso registrado é liberado; nada pendente no event loop (`--test-force-exit` **não** é usado) |
| LIFE-002 | ordem de desmonte | disposers rodam em **LIFO**; o teste registra a ordem e compara |
| LIFE-003 | `dispose()` chamado 2× | idempotente; nenhum efeito duplicado |
| LIFE-004 | disposer que lança | os demais **ainda** rodam; a exceção é logada, não engolida em silêncio |
| LIFE-005 | disposer síncrono | nenhum disposer retorna Promise (05 §1): o teste falha se algum retornar thenable |
| LIFE-006 | `dispose()` com túnel `READY` | `cloudflared` recebe `SIGTERM` no **grupo** e some antes do fim do teste |
| LIFE-007 | `dispose()` com worker do bot vivo | o worker morre junto; nenhum processo remanescente |
| LIFE-008 | `dispose()` durante `STARTING` | o warmup é abortado pelo `AbortSignal`; nenhum processo órfão |
| LIFE-009 | `dispose()` durante `STOPPING` | não reentra; a parada em voo conclui uma vez só |
| LIFE-010 | recarga a quente (HMR do fiber) | o interceptor é reinstalado e continua **armado** — uma requisição anônima recebe 401 depois da recarga |
| LIFE-011 | recarga a quente | não há vazamento de timer: contagem de handles antes e depois é igual |
| LIFE-012 | timer de TTL | é registrado como disposer e some no desmonte |
| LIFE-013 | tracker de rate limit | tem disposer; o mapa em memória é esvaziado |
| LIFE-014 | store de sessão | tem disposer; sessões vivas são invalidadas no desmonte |
| LIFE-015 | store do link mágico | é **só** memória; o desmonte não deixa nada em disco |
| LIFE-016 | `AuditSink` | fecha o descritor de arquivo; nenhum `fd` vazado (`/proc/self/fd` antes × depois) |
| LIFE-017 | `AbortController` único | um só por ciclo de vida do supervisor; abortar cancela readiness, probe e polling juntos |
| LIFE-018 | ordem `apply()` → `intercept` | o intercept é instalado antes de qualquer rota do plugin ser registrada |
| LIFE-019 | rota registrada **depois** do `apply()` por outro plugin | continua passando pelo gate; se não passar, o teste é o que avisa (02 §11 item 9) |
| LIFE-020 | estado persistido no desmonte | `state.json` fica consistente (escrita atômica, STATE-004); nunca truncado |
| LIFE-021 | `SIGTERM` no processo do DSH | disposers rodam **antes** da saída; nenhum órfão |
| LIFE-022 | `SIGKILL` no processo do DSH | disposers **não** rodam (é o limite documentado); a varredura de pidfile do boot seguinte é quem limpa (02 §9, T3.1) |
| LIFE-023 | teardown global da suíte | ao fim de `pnpm test`, zero processo `cloudflared` ou worker remanescente (`pgrep` no `after` global) |

---

### 5.7 Configuração, bind e recusa de exposição insegura

O que este bloco prova é que **configuração inválida falha alto no load**, e não
mais tarde, no meio de uma requisição. Arquivos: `test/unit/config/schema.test.ts`,
`test/unit/config/assert.test.ts`, `test/unit/config/bind.test.ts`. As sete
tensões abaixo são exatamente os pontos onde dois documentos deste plano já
divergiram; cada caso **congela** a decisão canônica e mata o mutante
correspondente de §7.2.

| id | tensão congelada | esperado |
| --- | --- | --- |
| TENSAO-001 | bind largo × túnel | `assertSecureBind` **recusa** `0.0.0.0`, `::` e qualquer host curinga **mesmo** com `exposure.mode: 'tunnel'`. O túnel fala com `127.0.0.1`; alargar o bind não é requisito dele. Mata o mutante **M-47** |
| TENSAO-002 | subir sem credencial | `start` é **recusado** enquanto não houver segredo forte configurado (CTL-009); o `spawn` não acontece. Mata o mutante **M-48** |
| TENSAO-003 | ligar o túnel exige opt-in explícito | `exposure.mode` tem **dois** valores canônicos, `'loopback'` e `'tunnel'` (D5), e o default é **`'loopback'`**; `exposure.autoStart` default `false`. O teste lê a configuração de fábrica e assere os dois. O valor `off` **não existe** e não pode reaparecer |
| TENSAO-004 | `trustedRemotes` como controle de rede | com o túnel de pé, `trustedRemotes` é **inerte**: quem protege é o **bind** em loopback, e nenhum documento pode atribuir valor residual a ele (02 §L3). O teste prova que uma requisição vinda da borda **não** é aceita por estar numa faixa "confiável" |
| TENSAO-005 | `trustEdgeHeaders` | default `false`; com `false`, `X-Forwarded-For` e `CF-Connecting-IP` são **ignorados** na derivação de identidade (ORIG-015…017). Mudar o default exige o veredito de **S2** |
| TENSAO-006 | TTL do túnel | `tunnel.ttlMinutes` ausente vira `60`; `0` e qualquer valor `> 480` são **config inválida recusada no load**, não silenciosamente corrigidos (D6) |
| TENSAO-007 | link mágico | `control.magicLink` default **`true`** quando `exposure.mode: 'tunnel'` (D3), e o documento assume a consequência: com ele ligado, o canal do Telegram é raiz de autenticação equivalente à senha (01 §9.5). O teste assere o default e a existência do opt-out |

Regra que vale para todos os sete: a mensagem de erro nomeia **a chave** e **o
valor recebido**, nunca "configuração inválida". Um erro que não diz o que
corrigir é um erro que o usuário resolve alargando o bind.

---

### 5.8 Contrato com `@deepseek-ai/*` (`test/contract/dsh-types.test.ts`)

Roda em `pnpm test:contract` — **job próprio, com rede**, em PR e no nightly
`dsh-compat.yml`. Não entra no gate de merge intra-onda (D4). Dono do diretório:
**T0.1**. É o único lugar deste documento onde os símbolos refutados E1–E4 podem
aparecer, e sempre como **alvo de asserção negativa**.

O que ele compara: o `.d.ts` extraído do tarball npm **pinado** contra o stub
local em `types/`. Divergiu, fica vermelho — e é assim que uma breaking change do
host vira um PR vermelho em vez de um plugin que carrega sem gate.

| id | asserção | como falha |
| --- | --- | --- |
| CONTRACT-001 | `@deepseek-ai/dsh-host-webserver` declara `interface Context { httpServer: HttpServerService }` | se o nome do serviço mudar, o `inject` do plugin para de resolver e o gate some em silêncio |
| CONTRACT-002 | `HttpServerService` expõe `register`, `registerFallback` e `registerUpgrade` | `registerUpgrade` é **bloqueador de segurança**: sem ele não há como guardar o WebSocket (08 L1) |
| CONTRACT-003 | o símbolo `WebServer` **não existe** no pacote | asserção negativa: se alguém reintroduzir `ctx.webServer`, este caso é o que avisa (E2) |
| CONTRACT-004 | `@deepseek-ai/dsh-host-subprocess` **não existe** no registry (404) | verificado |
| CONTRACT-005 | `@deepseek-ai/dsh-subprocess` existe e declara `interface Context { subprocess: SubprocessService }` | é o pacote real (E1) |
| CONTRACT-006 | `SubprocessService.spawn` tem a assinatura `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`, com `argv`, `cwd`, `stdio` e `graceMs` **obrigatórios** e `signal` opcional | a forma `spawn(cmd, args, opts)` é **refutada** (E3); o caso falha se ela voltar |
| CONTRACT-007 | `WebRoute` existe e mantém a forma usada pelo gate | é o único tipo do conjunto original que sobreviveu intacto |
| CONTRACT-008 | `@deepseek-ai/dsh-host-frontend-static` existe; `dsh-host-frontend` não | verificado |
| CONTRACT-009 | `@deepseek-ai/cordis` na versão pinada exporta `intercept`, `waterfall`, `parallel`, `effect`, `Service` e o ciclo de vida de `Fiber` com disposers LIFO | é a camada conceitual inteira sobre a qual o plugin é construído |

> Versões **exatas** (D27). Um contrato verde contra uma faixa não prova nada:
> `>=` deixaria o teste passar hoje e o plugin quebrar amanhã sem nenhum PR
> vermelho no meio.

---

### 5.9 Superfície do painel isenta de credencial (`test/unit/panel/exempt-surface.test.ts`)

Existe um conjunto pequeno de respostas que o plugin emite **antes** de saber
quem está do outro lado: o desafio de autenticação, o 404, a página do segredo
travada por `ott`, o `GET` inerte do link mágico e o canário do probe. Essa
superfície é a única coisa que um scanner anônimo enxerga com o túnel de pé, e
até esta revisão ela não tinha um único teste. A tabela de isenções de rota vive
em `src/panel/routes.ts` (T3.4) e é **enumerada**, nunca um padrão.

| id | requisição anônima | esperado |
| --- | --- | --- |
| PANEL-001 | `GET /__guard/` | `401` com `WWW-Authenticate`; **nenhum** byte do painel no corpo |
| PANEL-002 | `GET /__guard/api/state` | `401`; o corpo **não** revela estado, URL do túnel nem se existe túnel |
| PANEL-003 | `GET /__guard/rota-que-nao-existe` | `404` **byte a byte idêntico** ao de PANEL-004 |
| PANEL-004 | `GET /__guard/secret` sem `?ott=` (ou com `ott` inválido/já consumido) | `404` idêntico ao de PANEL-003 — a existência da rota não é oráculo (SEC-14) |
| PANEL-005 | `GET /__guard/secret?ott=<válido>` | `200` **uma vez**; a segunda tentativa com o mesmo token cai em PANEL-004 |
| PANEL-006 | `GET /__guard/magic?mk=<válido>` | inerte: `200` com uma página que **não** consome o token; nenhum `Set-Cookie` |
| PANEL-007 | `POST /__guard/magic` com `mk` válido | consome, emite sessão, e o mesmo `mk` deixa de valer (uso único) |
| PANEL-008 | `GET /__guard/probe-canary-<aleatório>` a partir da **borda** | o canário só responde ao probe local; da borda é `404` — se responder, o probe estaria validando a si mesmo |
| PANEL-009 | a lista de isenções | o teste enumera as rotas isentas do gate e compara com a tabela de `src/panel/routes.ts` por **igualdade de conjunto**; acrescentar uma isenção sem atualizar a tabela deixa o caso vermelho |
| PANEL-010 | corpo das respostas isentas | nenhuma delas inclui versão do plugin, versão do DSH, hostname, caminho de arquivo ou `Server` identificável — enumeração de versão é o primeiro passo de quem procura CVE |

> Estes dez casos são de **unidade** e rodam no gate. O equivalente adversarial —
> fuzzing de prefixo e canonicalização contra a mesma superfície — está em §6.1 e
> roda em `pnpm test:security`.

---

## 6. Suíte de segurança adversarial (categoria própria)

Roda em `test/security/`, em todo push, bloqueia merge. **Todo caso listado aqui é
obrigatório** — a suíte não é "cobertura", é uma lista fechada de ataques com
resultado esperado. Um caso removido exige justificativa no PR.

Contexto que justifica o peso desta seção: a discussão #853 do DSH é um relatório
público de RCE **não autenticado** no control plane da Web UI, verificado em
0.1.0-rc.6, e a #1769 documenta escape do sandbox `bwrap workspace-write`. Ambas
abertas. O sandbox do DSH **não é** fronteira de segurança durante este trabalho.

### 6.1 Bypass de rota e canonicalização (`test/security/path-bypass.test.ts`)

Todos contra o servidor real, por **socket cru** (não `fetch`, que normaliza o
caminho antes de enviar). Esperado uniforme: `401`/`403`, **nunca** pass-through.

| ID | Request-target enviado | Por quê |
| --- | --- | --- |
| ADV-001 | `/api/x` | baseline: guardado |
| ADV-002 | `/apinfo` | **não** guardado (fronteira de prefixo; já testado em `:857`) |
| ADV-003 | `//api/x` | barra dupla |
| ADV-004 | `/./api/x` | segmento ponto |
| ADV-005 | `/foo/../api/x` | traversal |
| ADV-006 | `/api/../public/x` | traversal saindo do prefixo |
| ADV-007 | `/%61pi/x` | percent-encoding de letra |
| ADV-008 | `/api%2fx` | barra codificada |
| ADV-009 | `/%2e%2e/api/x` | ponto-ponto codificado |
| ADV-010 | `/%252e%252e/api/x` | **duplo** encoding — o canonizador não pode decodificar duas vezes |
| ADV-011 | `/API/x` | maiúsculas (decisão explícita: caminho é case-sensitive em POSIX; o teste **congela** a escolha) |
| ADV-012 | `/api/x;jsessionid=1` | parâmetro de caminho |
| ADV-013 | `/api/x%00.png` | NUL byte |
| ADV-014 | `/api/x?a=/public` | query não altera a decisão (já testado em `:857`) |
| ADV-015 | `/api/x#frag` | fragmento |
| ADV-016 | `/api/x ` / `/api/x.` (espaço/ponto ao final) | normalização de FS do Windows |
| ADV-017 | `GET http://outro.host/api/x HTTP/1.1` (absolute-form) | request-target absoluto |
| ADV-018 | `/api//x` (escape unicode) | |
| ADV-019 | `/api/x` com `Content-Length` e `Transfer-Encoding` juntos | smuggling: aqui só se assere que o Node rejeita; **não é a nossa camada**, e o teste registra isso honestamente |
| ADV-020 | fuzz: 5000 caminhos aleatórios (bytes 0x00–0xFF, semente fixa) | **invariante**: `canonicalRequestPath` nunca devolve string contendo `..`, `%`, `\0` ou `//`; nunca lança |

### 6.2 Forja de cabeçalho e identidade (`test/security/header-forgery.test.ts`)

| ID | Ataque | Esperado |
| --- | --- | --- |
| ADV-021 | `X-Forwarded-For: 127.0.0.1` vindo de origem não confiável | **ignorado**. A decisão usa `req.socket.remoteAddress`, jamais header. Teste assere o 403 |
| ADV-022 | `X-Real-IP`, `Forwarded`, `CF-Connecting-IP` forjados | idem |
| ADV-023 | `Host: localhost` forjado | não altera a decisão |
| ADV-024 | `Origin: http://127.0.0.1:3080` forjado em requisição de fora | não altera a decisão (o gate não confia em `Origin` para autorizar; só o usa, se usar, para negar) |
| ADV-025 | `Cf-Access-Jwt-Assertion` forjado | se/quando o Access entrar (L0), o JWT **tem** que ser validado contra as chaves públicas do time (`kid`, `iss`, `aud`, `exp`); um JWT com assinatura inválida ⇒ 403. Enquanto L0 não existir, o teste é `skip` com TODO nomeado |
| ADV-026 | header `Authorization` duplicado | ver AUTH-020 |
| ADV-027 | `Connection: close` + credencial válida em pipeline | cada requisição é avaliada de novo; sem cache de decisão entre requisições da mesma conexão |
| ADV-028 | cookie de sessão de outro segredo (pós-rotação) | rejeitado (SECRET-008) |

### 6.3 WebSocket (`test/security/websocket-noauth.test.ts`)

Classe de bug que fulmina exatamente este desenho: WebSocket sem validação de
origem (CWE-1385). Precedentes reais: code-server < 4.10.1 → CVE-2023-26114
(CVSS 9.3); extensões do Claude Code 0.2.116–1.0.23 → CVE-2025-52882 (qualquer
página abria WS para o servidor local e lia arquivos arbitrários). E este harness
migrou o downlink de telemetria de SSE para **WebSocket dedicado**
(`src/index.ts:935`) — o canal transporta estado do control plane.

| ID | Ataque | Esperado |
| --- | --- | --- |
| ADV-040 | upgrade sem `Authorization` | `401` cru no socket, com `WWW-Authenticate`, seguido de `destroy()` |
| ADV-041 | upgrade de origem não confiável | `403` cru, `destroy()` |
| ADV-042 | upgrade com credencial válida | handshake segue para o handler original **exatamente 1 vez** |
| ADV-043 | upgrade para caminho **fora** de `guardedPrefixes` | **também** guardado — a superfície de upgrade é guardada **inteira**, porque WebSocket não está sujeito a same-origin policy e não há preflight |
| ADV-044 | `Origin` ausente | negado |
| ADV-045 | `Origin: null` | negado |
| ADV-046 | `Origin: https://evil.example` com credencial válida | negado (allowlist estrita de origem, não "qualquer origem com senha") |
| ADV-047 | exceção dentro do avaliador de upgrade | socket **destruído**, nunca handshake aprovado (fail-closed; o código já faz isso, `src/index.ts:1540`) |
| ADV-048 | resposta de negação | não vaza corpo, versão nem detalhe do erro |
| ADV-049 | meia-conexão | após negação, o socket é destruído e o cliente não fica pendurado |

### 6.4 Abuso pelo canal do Telegram (`test/security/telegram-abuse.test.ts`)

| ID | Ataque | Esperado |
| --- | --- | --- |
| ADV-030 | confuso-deputado: atacante com o token manda ao dono um teclado inline com `callback_data` destrutivo; o dono clica | o comando **não** executa em uma etapa: cai no fluxo de confirmação com token efêmero gerado **pelo servidor** (TG-020…TG-025) |
| ADV-031 | `callback_data` com payload de outro usuário | rejeitado (token ligado ao `from.id`) |
| ADV-032 | replay de `callback_query` antigo | rejeitado (uso único + TTL) |
| ADV-033 | comando via `message` com texto imitando confirmação | rejeitado; confirmação só por callback com token |
| ADV-034 | update com `from.id` de OWNER mas `chat` de outro grupo | negado (TG-005) |
| ADV-035 | flood de 1000 updates | rate limit próprio do bot; nenhuma execução repetida; sem crescimento de memória |
| ADV-036 | mensagem contendo o segredo | ver §6.5 |

### 6.5 Canário de segredo (`test/security/secret-leak-canary.test.ts`)

Técnica: em todo teste de integração/e2e, o segredo é a constante
`CANARY = 'CANARY-a1b2c3d4e5f6-DO-NOT-LEAK'`. Um coletor captura **tudo** que sai:
stdout e stderr do processo, chamadas ao logger, corpos e headers de resposta HTTP,
payloads enviados ao transporte do Telegram, **frames do IPC host↔worker** e o
conteúdo final dos arquivos de estado.

> **Por que o canário e não um `git grep`.** `03-ONDAS.md` promete um invariante
> de grep por `secret|senha|password`. Isso não pega `cred`, `pw`, `this.value`,
> nem interpolação — é heurística sobre nome de identificador, não sobre dado. O
> canário é o oposto: ele segue o **valor**, e por isso pega o vazamento
> independentemente de como a variável se chama. O grep continua útil como
> segunda rede, nunca como a primeira.

| ID | Asserção |
| --- | --- |
| ADV-050 | o canário **nunca** aparece em nenhum log capturado |
| ADV-051 | o canário nunca aparece em resposta HTTP (corpo ou header) |
| ADV-052 | o canário nunca aparece em payload enviado ao Telegram — nem em `sendMessage`, nem em `answerCallbackQuery`, nem em `editMessageText` |
| ADV-053 | o token do bot (padrão `\d+:[\w-]{30,}`) nunca aparece em log — ele viaja na **URL** da Bot API, então log de HTTP e APM são vetores |
| ADV-054 | o arquivo de estado contém apenas o **digest** do segredo (`sha256:…`), nunca o segredo |
| ADV-055 | `buildWorkerEnv` é uma **allowlist**, não uma negação por lista: o ambiente do worker contém **exatamente** as chaves permitidas e nada mais. O teste popula `process.env` com 30 chaves aleatórias (incluindo o canário e um par credencial-like) e assere igualdade de conjunto com a allowlist. `ADMIN_USER`/`ADMIN_PASS` **deixaram de existir no fluxo** (D19: a credencial é gerada por CSPRNG pelo plugin e vive como digest no `state.json`); o teste que garante isso é ADV-058, não uma linha de exclusão nominal |
| ADV-056 | em modo de erro (exceção não tratada), o stack trace não carrega o canário |
| ADV-057 | o canário nunca aparece em **nenhum frame do IPC** host↔worker (JSON-lines sobre stdio), em nenhuma direção. Junto com ADV-052 é o par que fecha a invariante **SEC-14** (SECRET-018) |
| ADV-058 | `git grep -nE 'ADMIN_USER\|ADMIN_PASS'` no repositório devolve **zero** ocorrências fora de tabela de correção histórica — nem no `cordis.patch.yml`, nem no README, nem no quickstart |
| ADV-059 | `buildTunnelEnv` é um perfil **distinto** de `buildWorkerEnv`: o processo do `cloudflared` não recebe o token do Telegram, e o worker do Telegram não recebe credencial de túnel |

Por que isso não é paranoia: chat de bot **não é** end-to-end criptografado
(cloud chat, criptografia servidor-cliente); a Telegram armazena o histórico nos
servidores dela (Política 3.3.1) e roda análise automatizada sobre mensagens de
cloud chat (5.3); e o FAQ oficial diz literalmente para tratar qualquer bot como
estranho e não lhe dar senhas. Além disso, **não existe** autodestruição para
bots (é feature de Secret Chat), `message_auto_delete_time` é somente leitura na
Bot API, e `deleteMessage` só funciona em mensagens com menos de **48 horas** —
"apago depois" não é controle de segurança.

---

## 7. Mutation testing — por que aqui não é luxo

### 7.1 O caso vivido neste projeto

O que aconteceu, na ordem exata:

1. O disposer do supervisor seguia o exemplo canônico da documentação:
   `if (child.pid && !child.killed) process.kill(-child.pid, 'SIGKILL')`.
2. O dublê de `ChildProcess` usado nos testes **ignorava** `options.signal`.
   Quando o supervisor chamava `abortController.abort()`, o dublê não fazia nada
   — `child.killed` permanecia `false`.
3. Com `killed === false`, a guarda `!child.killed` era **verdadeira** nos testes,
   o `process.kill(-pid)` era executado, o mock registrava a chamada e oito
   testes ficavam verdes. Suíte inteira: **49/49**.
4. No Node real, `abort()` chama `child.kill(killSignal)` de forma **síncrona**
   dentro do próprio `abort()`. Logo após a linha, `child.killed === true`.
   Portanto a guarda era **falsa** em produção e o `process.kill(-pid)` **nunca
   rodava**. Tree-kill: código morto.
5. Medição com processos reais confirmou:

   ```
   ANTES  do dispose()   filho 1326740 (pgid 1326740), neto 1326741
   DEPOIS do dispose()   filho MORTO,  neto 1326741 ppid=1830  ← ÓRFÃO
   ```

O bug estava numa linha **100 % coberta**, exercitada por 8 testes verdes. Nem
cobertura de linha, nem de branch, nem revisão humana pegaram. O que pega:

- **Mutação**: apagar `process.kill(-pid, 'SIGKILL')` inteiro **não quebrava
  nenhum teste**, porque o mock só verificava que o mock foi chamado. Um score de
  mutação teria acusado o mutante sobrevivente na hora.
- **E2E com processo real** (E2E-001): consulta `ps`, não `mock.calls`.
- **Teste de contrato do dublê** (`child-double.contract.test.ts`): assere que o
  dublê se comporta como o Node — `abort()` põe `killed = true` sincronicamente,
  `AbortError` só sai se `kill()` devolveu `true`, `err.cause` é o `reason`,
  ENOENT emite `error` + `close` sem `exit`, e signal já abortado adia o kill
  para `nextTick`. Esse arquivo é o antídoto estrutural: ele testa o **dublê**.

Regra permanente derivada: **toda invariante que depende do comportamento do
runtime tem um e2e com o runtime.** Mock prova fiação; só o SO prova morte.

### 7.2 Mutações que a suíte **tem** que matar

Lista fechada. Cada linha é um mutante que a Onda 6 introduz manualmente (ou o
Stryker gera) e verifica que **pelo menos um** teste falha.

| # | Mutação | Deve ser morta por |
| --- | --- | --- |
| M-01 | remover a guarda `pid === undefined` do tree-kill | SUP-007 |
| M-02 | reintroduzir `&& !child.killed` no tree-kill | **E2E-002** |
| M-03 | trocar `process.kill(-pid)` por `process.kill(pid)` | E2E-001 (neto sobrevive) |
| M-04 | trocar `SIGKILL` por `SIGTERM` no tree-kill final | SUP-014 (`--fake=stubborn`) |
| M-05 | remover o `try/catch` de ESRCH | E2E-008 |
| M-06 | `timingSafeEqual` → `===` | AUTH-041 |
| M-07 | comparar credencial crua em vez de digest | AUTH-005 (lança em tamanhos diferentes) |
| M-08 | remover o `.toLowerCase()` do esquema | AUTH-006/007/008 |
| M-09 | aceitar qualquer esquema (remover a checagem de prefixo) | AUTH-009 |
| M-10 | `isTrustedRemote`: `length === 0 → true` (lista vazia = todos) | ORIG (teste `:693`) |
| M-11 | remover a normalização IPv4-mapeado | teste `:620` |
| M-12 | `isGuardedPath`: `startsWith` sem fronteira de segmento | ADV-002 |
| M-13 | remover a decodificação percent em `canonicalRequestPath` | ADV-007/008 |
| M-14 | decodificar percent **duas** vezes | ADV-010 |
| M-15 | trocar 403 por 401 na negação de origem | AUTH-032 |
| M-16 | remover `WWW-Authenticate` do 401 | AUTH-030 |
| M-17 | responder 401 com corpo diferente para "usuário existe" | AUTH-031 |
| M-18 | `requestsDeniedPermission`: comparar substring em vez de token | teste `:903` |
| M-19 | remover o gate do handler de **upgrade** | ADV-040 |
| M-20 | guardar upgrade só nos `guardedPrefixes` | ADV-043 |
| M-21 | no `catch` do upgrade, chamar o handler original | ADV-047 |
| M-22 | allowlist do Telegram: validar `chat.id` e não `from.id` | TG-003 |
| M-23 | allowlist: `from` ausente ⇒ aceito | TG-004 |
| M-24 | allowlist: comparar `username` | TG-008 |
| M-25 | allowlist vazia ⇒ aceita tudo | TG-007 |
| M-26 | token de confirmação reutilizável | TG-022 |
| M-27 | token de confirmação sem TTL | TG-023 |
| M-28 | token não ligado ao `from.id` | TG-024 |
| M-29 | não chamar `answerCallbackQuery` no caminho de negação | TG-027 |
| M-30 | ler a URL do túnel do **stdout** | TUN-005 |
| M-31 | remover o prefixo `https://` do hostname | TUN-002 |
| M-32 | timeout de readiness `Infinity` | TUN-009 |
| M-33 | não abortar o wait no `close` do processo | TUN-010 |
| M-34 | `--metrics` sem host explícito | TUN-011 |
| M-35 | acrescentar `--loglevel debug` | TUN-013 |
| M-36 | supervisor pendurar em `exit` e não em `close` | SUP-007 (ENOENT) |
| M-37 | reiniciar mesmo com `signal.aborted` | SUP-009 |
| M-38 | `maxAttempts` ignorado (retry infinito) | SUP-005 |
| M-39 | `resetAfterMs` sempre zerando o contador | SUP-004 |
| M-40 | backoff sem teto (`maxDelayMs` ignorado) | teste `:1049` |
| M-41 | backoff sem jitter | teste `:1061` |
| M-42 | `seq` não incrementa | CTL-010 |
| M-43 | `start` em `READY` faz `spawn` novo | CTL-003 |
| M-44 | `dispose` não idempotente | E2E-009 / LIFE-008 |
| M-45 | `dispose` assíncrono | LIFE-002 |
| M-46 | `intercept` não desfeito no dispose | LIFE-007 |
| M-47 | `assertSecureBind` aceita `0.0.0.0` quando `exposure.mode='tunnel'` | TENSAO-001 |
| M-48 | permitir `up` sem segredo | TENSAO-002 |
| M-49 | segredo gravado em claro no arquivo de estado | SECRET-005 |
| M-50 | `buildWorkerEnv` fazendo `{...process.env}` | ADV-055 |

**Como isto entra no aceite (D16).** A lista acima é um **checklist manual de
revisão da Onda 6**, com meta de 50/50, verificado por leitura e por teste
dirigido — aplica-se o mutante, roda-se a suíte, exige-se falha, reverte-se. Um
sobrevivente é um buraco de teste nomeado, não uma métrica. O que **não** é
critério de aceite é score de ferramenta: mutation testing automatizado roda em
**job noturno separado**, com `break` desligado, e **não bloqueia PR**.

A lista é **fechada em 50** e não cresce nesta versão. Os controles acrescentados
por decisão canônica — TTL do túnel (TUN-016…019), probe de 4 sondas
(TUN-020…025), modo restrito (RL-008, RL-013…016), pareamento por código
(PAIR-001…010), link mágico (MAG-001…010) e a superfície isenta
(PANEL-001…010) — são cobertos por **teste nomeado**, e os mutantes
correspondentes entram na lista da v0.2, quando ela for reaberta com o mesmo rito
(lista fechada, revisada, assinada).

### 7.3 Ferramenta

Preferência: `@stryker-mutator/core` 10.0.0. Defaults de threshold: `high: 80`,
`low: 60`, `break: null` — ou seja, o build só quebra se `break` for setado
explicitamente. Modo incremental disponível para CI.

> **NÃO CONFIRMADO — e é um bloqueio real.** A pesquisa **não** encontrou suporte
> oficial do Stryker a `node:test` como test runner: a documentação lista
> jest, mocha, vitest, jasmine, karma e cucumber/tap. **Duas** saídas — e a
> terceira, que existia aqui antes, foi eliminada por decisão canônica:
>
> 1. **Command runner** do Stryker (executa `pnpm test` e usa exit code). Perde
>    o mapeamento por teste e fica lento, mas funciona com qualquer runner.
> 2. **Mutação manual**, com a tabela §7.2 como checklist executado uma vez por
>    release: aplica o patch, roda a suíte, exige falha, reverte.
>
> **Vitest está fora, inclusive "só para o núcleo puro" (D16).** Trocar o runner
> do projeto inteiro por causa de uma ferramenta de qualidade secundária é custo
> desproporcional numa Onda 6 que já é a mais pesada, e um projeto com dois
> runners tem duas semânticas de mock, dois formatos de relatório e duas fontes
> de flake. O runner é `node:test`, ponto.
>
> Recomendação do plano: **(1) num job noturno, com `break` desligado, + (2) como
> rede de segurança na release**. Quebrar PR por score de mutação antes de a suíte
> estabilizar produz o pior incentivo possível (testes escritos para matar
> mutante, não para descrever comportamento).
>
> **Spike e dependência têm dono.** O spike de 1 h sobre o suporte do Stryker a
> `node:test` é de **T6.3**, e é T6.3 que possui o `package.json` da Onda 6 — quem
> precisa da dependência é quem pode instalá-la. Se o spike concluir que não há
> suporte viável, o item **sai do aceite** e vira nota em `docs/TESTING.md`.

---

## 8. Dados de teste, fixtures e anti-flakiness

### 8.1 Relógio e aleatoriedade injetáveis

`test/support/clock.ts`:

```ts
// esboço ilustrativo
export function createTestClock(startMs = 1_700_000_000_000) {
  let now = startMs
  const queue: Array<{ at: number; fn: () => void; id: number }> = []
  return {
    now: () => now,
    scheduler: { setTimeout(fn, delay) { … }, clearTimeout(h) { … } },
    advance(ms: number) { /* executa callbacks em ordem de `at`, atualizando `now` */ },
    pending: () => queue.length,   // ← usado por LIFE-004
  }
}

export function seededRandom(seed: number): () => number  // LCG; determinístico e imprimível
```

Regras:

- **Nenhum teste chama `setTimeout` real, `Date.now()` real ou `Math.random()`.**
  Um lint rule custom (ou `grep` no CI) proíbe esses identificadores em
  `test/unit/` e `test/integration/`.
- `clock.pending()` no `afterEach` de toda suíte: saldo ≠ 0 ⇒ falha com a
  mensagem "timer vazado".
- A semente do RNG é impressa no output de todo teste property-based, para
  reprodução exata.
- Alternativa disponível: `mock.timers` do `node:test`. **Não** usada como
  padrão, porque ela mocka globais e esconde o fato de o código estar chamando
  `setTimeout` global em vez da costura injetada — exatamente o tipo de mentira
  que causou o §7.1. A costura explícita é preferida.

### 8.2 Portas, diretórios e processos

| Recurso | Regra |
| --- | --- |
| Porta | **sempre** `listen(0)` e ler `server.address().port`. Zero portas fixas em qualquer arquivo de teste (grep no CI). |
| Diretório | `fs.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-'))`, removido em `after()` com `rm -rf` tolerante a falha. |
| `worker.cwd` | aponta para o tmpdir do teste (a validação `assertExistingDirectory` já existe, `src/index.ts:1202`). |
| Processo | todo `spawn` de teste é registrado num `ProcessRegistry` do arquivo; `after()` global mata o grupo de qualquer sobrevivente e **falha o teste** se houver sobrevivente — vazar processo em teste é bug. |
| Evento terminal | esperar **sempre** `'close'`, nunca `'exit'` (ENOENT emite `error` + `close`, sem `exit`). |
| Concorrência | `--test-concurrency=1` na suíte e2e (processos e `ps` não convivem bem em paralelo); paralelo livre em `unit`. |

### 8.3 Fixtures

```
test/support/fixtures/telegram/
  message-owner-dm.json
  message-stranger-dm.json
  message-no-from.json           (channel post)
  callback-owner.json
  callback-stranger-group.json
  callback-forged-data.json
  edited-message-stranger.json
  unknown-update-type.json
  api-error-429.json             { ok:false, error_code:429, parameters:{retry_after:3} }
  api-error-409-getupdates.json
  api-error-401-getme.json
  getme-ok.json
  getupdates-empty.json
  getupdates-two-senders.json
```

Regras das fixtures:

1. **Nenhum dado real.** IDs sintéticos documentados no topo do diretório
   (`README.md` da pasta). Tokens são `999999999:FIXTURE-NOT-A-REAL-TOKEN`.
2. Fixtures **gravadas** de tráfego real (se um dia forem) passam por um script
   de sanitização (`scripts/sanitize-fixture.mjs`) que substitui IDs, nomes,
   usernames e tokens. O script tem seu próprio teste.
3. Fixture é JSON puro, sem lógica. Variação vem de um `builder` em TypeScript
   (`makeUpdate({ fromId, chatId, text })`), para que o teste diga o que importa.
4. Toda fixture citada em algum teste tem que existir: um teste `FIXTURE-001`
   varre o diretório e o código, e falha em fixture órfã ou referência quebrada.

### 8.4 Regras anti-flake

| Regra | Motivo |
| --- | --- |
| Zero `sleep`/`setTimeout` de espera em teste | Fonte nº 1 de flake. Substituto: `waitFor(predicate, { deadline, poll })` com o relógio injetado em unit e polling real curto (25 ms) em e2e. |
| Zero retry no CI | Retry esconde bug de concorrência. Teste intermitente vai para `test/quarantine/` com issue aberta, e a quarentena roda no nightly sem bloquear. |
| Timeout por teste explícito | `it('…', { timeout: 5000 }, …)` em e2e; sem timeout implícito longo. |
| Fator de lentidão do CI | `TEST_TIMEOUT_FACTOR` (default 1, CI usa 3) multiplica só os timeouts de e2e. Nunca muda asserção. |
| Ordem independente | Nenhum teste depende da execução de outro. Verificação periódica com `--test-shuffle` se disponível; senão, execução em ordem invertida no nightly. |
| Estado global | Nenhum. `process.env` alterado em teste é restaurado no `afterEach`. |
| `ps` no e2e | Comando com timeout próprio e tratamento de saída vazia; ausência de linha é resultado válido, não erro. |

---

## 9. Testes manuais / exploratórios

Executados por uma pessoa antes de cada release. Registro em
`docs/manual-runs/AAAA-MM-DD.md` com resultado por passo. Um roteiro falho
bloqueia o release.

**Pré-requisitos (M0):** máquina Linux com DSH instalado, `cloudflared`
verificado por checksum, conta Telegram, celular com dados móveis (**não** o
Wi-Fi de casa — a rede local mascara o teste inteiro).

Verificação do `cloudflared` antes de qualquer coisa: a release do GitHub publica
o sha256 nas release notes, e o próprio binário **loga o próprio checksum** no
startup (`Version 2026.7.3 (Checksum 9d71…)`), o que permite auditar o binário em
execução. Alternativa preferida: repo apt assinado (`pkg.cloudflare.com`, chave
`cloudflare-main.gpg`), que dá verificação automática.

### M1 — Onboarding do Telegram do zero (10 min)

| # | Passo | Critério de aceite |
| --- | --- | --- |
| 1 | Sem estado prévio, rodar `dsh-guard-setup` | Mostra o passo 1 (BotFather) com o **texto exato a digitar**, sem jargão |
| 2 | Criar o bot no BotFather (`/newbot`, nome, username terminando em `bot`) | Recebe token `<id>:<segredo>` |
| 3 | Colar o token quando pedido | Ferramenta valida com `getMe` e mostra o `@username` do bot para conferência |
| 4 | Colar um token **errado** de propósito | Erro claro, sem stack trace, com instrução de `/token` no BotFather |
| 5 | A ferramenta exibe o **código de pareamento de 6 dígitos** | Código aparece **só no terminal** (e no painel local), com TTL de 5 min visível e a instrução `/parear <código>` |
| 6 | Mandar `/start` ao bot **antes** de parear | Bot responde boas-vindas inócua e **não** pareia ninguém. Se `/start` parear, **PARE — é bug de segurança** (D8) |
| 7 | Mandar `/parear <código errado>` | Recusa genérica; a tentativa é contada; nada é gravado |
| 8 | Mandar `/parear <código correto>` | Pareia; a ferramenta confirma o `@username` e o `chat` e **fecha** o pareamento |
| 9 | Mandar `/parear` de novo, ou de outra conta | **Recusado**. Reabrir exige `--reset-pairing` na máquina |
| 10 | Conferir `$XDG_STATE_HOME/dsh-guarded-bot/secrets.env` | Modo `0600`, **fora do workspace** e fora do git; contém `TELEGRAM_BOT_TOKEN` e `TELEGRAM_OWNER_CHAT_ID` |
| 11 | Conferir a senha do painel | Impressa **uma vez**, em texto e como QR ASCII; a segunda execução não reimprime; a senha **não** está em nenhuma mensagem do Telegram |
| 12 | Rodar `dsh-guard-setup` de novo | Diz "já configurado", não duplica linha, não regera segredo, não reabre pareamento |
| 13 | Ler os 5 avisos de exposição | `trustedRemotes` inerte sob túnel; o túnel fura o firewall; a Cloudflare vê o tráfego em claro na borda; a URL não é segredo; `trycloudflare.com` tem reputação de malware em alguns filtros |
| 14 | Pedir a uma pessoa que nunca viu o projeto para fazer 1→11 | Conclui sem perguntar nada ao autor. **Este é o critério real** |

### M2 — Primeiro túnel (8 min)

| # | Passo | Critério |
| --- | --- | --- |
| 1 | DSH rodando em `127.0.0.1:3080`; estado inicial | `STOPPED`. **Nada** exposto por padrão |
| 2 | `/ligar` pelo bot | Pede confirmação (2 etapas, nonce do host); confirmada, resposta em ≤2 s e estado `STARTING` |
| 3 | Aguardar | URL chega em ~6–7 s (medido). Se passar de 30 s, é falha |
| 4 | Verificar que a URL veio do `/quicktunnel` e não de scraping | Log do plugin registra a fonte |
| 4b | Antes de a URL existir, conferir o log do **probe de 4 sondas** | As quatro registraram 401 (§5.4.6). Se alguma tiver registrado 200 e o túnel tiver subido assim mesmo, **PARE — é o bug que já expôs o DSH real** |
| 5 | Abrir a URL no **celular, na 4G**, em janela anônima | Prompt/tela de senha. **Se abrir a UI direto, PARE — é o pior bug possível** |
| 6 | Senha errada 3× | 401 idêntico nas três; a partir da 5ª, atraso perceptível |
| 7 | Senha certa | UI do DSH carrega |
| 8 | Codificar de fato: abrir um arquivo, pedir uma edição ao agente | Funciona ponta a ponta |
| 9 | `ps aux \| grep cloudflared` | Exatamente 1 processo; `--metrics` em `127.0.0.1`; **sem** `--loglevel debug`; sem token em argv |
| 10 | `curl 127.0.0.1:<metrics>/quicktunnel` e `/ready` | Respondem; confirmam o que o plugin reportou |
| 11 | Deixar passar o `ttlMinutes` configurado (use um valor baixo para o teste) | O túnel cai sozinho; a sessão aberta no celular deixa de autenticar; o bot avisa. Este é o único teste manual do controle que limita a janela de exposição |

### M3 — Desligar pelas duas superfícies (5 min)

| # | Passo | Critério |
| --- | --- | --- |
| 1 | Com o túnel `READY`, `/desligar` pelo bot | Pede confirmação, não executa direto. O botão é identificado pelo **texto** (`⛔ Desligar`); estilo de botão é NÃO CONFIRMADO (TG-029) |
| 2 | Confirmar | Estado `STOPPING` → `STOPPED` em ≤5 s |
| 3 | Recarregar a URL no celular | Erro de conexão / 530 |
| 4 | `ps aux \| grep cloudflared` | Nenhum processo |
| 5 | Ligar pela UI; desligar pelo bot | Ambas as superfícies mostram o mesmo estado e o mesmo `seq` |
| 6 | Ligar pelo bot; observar a UI **sem** recarregar | Atualiza sozinha |
| 7 | Apertar o mesmo botão de confirmação de novo | "expirado/já usado", sem segundo efeito |
| 8 | Apertar "ligar" com o túnel já ligado | Repete a URL vigente; nenhum processo novo |

### M4 — Falhas reais (7 min)

| # | Passo | Critério |
| --- | --- | --- |
| 1 | Com o túnel `READY`, `kill -9` no `cloudflared` | Estado vai a `DEGRADED`; reinício com backoff; **URL nova** comunicada ao dono. Esgotado o orçamento, vai a `FAILED` e **não** re-tenta |
| 2 | Desligar o Wi-Fi por 30 s | Reconecta sozinho ao voltar, ou reporta orçamento esgotado com clareza |
| 3 | Rodar uma segunda instância do bot em outro terminal | 409 `terminated by other getUpdates request`; a mensagem no log tem que ser **compreensível**, não um dump |
| 4 | Renomear o binário do `cloudflared` e tentar `/ligar` | Erro imediato (ENOENT, não-retryable); **sem** crash-loop |
| 5 | Preencher o disco do diretório de estado (ou `chmod 000`) | Falha clara; o plugin não sobe com estado corrompido |
| 6 | `kill -9` no processo do DSH inteiro | Verificar com `ps` se sobrou `cloudflared` ou worker órfão. Este é o cenário que só o dead-man's switch cobre (E2E-012/013) |

### M5 — Segurança na prática (7 min)

| # | Passo | Critério |
| --- | --- | --- |
| 1 | `curl -H 'X-Forwarded-For: 127.0.0.1' <URL>/api/…` de fora | 401/403. XFF ignorado |
| 2 | `curl <URL>/api/../public/x` e `<URL>/api%2fx` | Bloqueados |
| 3 | `wscat`/`websocat` no endpoint de WS **sem** credencial | 401 cru, socket fechado |
| 4 | Abrir a URL num navegador limpo e olhar o DevTools | Nenhum segredo em `localStorage`, cookie sem `HttpOnly`, ou corpo de resposta |
| 5 | `grep -R "$SENHA" ~/.dsh/logs/ /var/log/` | Zero ocorrências |
| 6 | Verificar o histórico do Telegram | A **senha permanente não está lá, em nenhuma forma** — a entrega dela é **local**: terminal com QR ASCII, ou `GET /__guard/secret?ott=<token>` com o `ott` impresso no stdout. O que **pode** chegar pelo Telegram é o **link mágico de uso único** (`control.magicLink`, ligado por padrão em `exposure.mode: 'tunnel'`, com `mk` de 128 bits, TTL 120 s, no fragmento da URL). Ver [09 §D3](09-DECISOES-CANONICAS.md) e [02 §5.3](02-SEGURANCA.md). Se a senha aparecer no chat, **PARE — é violação do invariante SEC-14** |
| 6b | Clicar o link mágico duas vezes | Só a primeira emite sessão; a segunda falha e gera alerta |
| 6c | Errar a senha 15× pelo túnel | As 15 respostas são `401` **idênticos**, sem `Retry-After` e sem nada que revele o ban; só o tempo muda |
| 7 | Buscar a URL do túnel no urlscan.io/Google | Registrar o resultado. A URL **não é segredo** — é premissa do modelo de ameaças, não surpresa |
| 8 | Deixar o túnel aberto 30 min e revisar o log de acesso | Toda requisição registrada; primeiro acesso não reconhecido gera alerta |

### M6 — Streaming e canal de downlink (5 min)

Existe por causa de uma alegação **refutada** pela pesquisa e que, portanto, não
pode ser aceita nem descartada de papel:

| # | Passo | Critério |
| --- | --- | --- |
| 1 | Pelo túnel, pedir ao agente uma resposta longa | Tokens aparecem **incrementalmente**, não de uma vez no fim |
| 2 | No DevTools, identificar o canal do downlink | Confirmar se é WebSocket (esperado, `src/index.ts:935`) ou SSE |
| 3 | Se for SSE por **GET** | Esperar bufferização (bug conhecido do edge, cloudflared #1449). Registrar e escalar |
| 4 | Se for SSE por **POST** | Streaming funciona (medido pela pesquisa: eventos a cada ~0,5 s, espaçamento igual ao da origem) |
| 5 | Sessão de 10 min com uso contínuo | Sem queda. Lembrar do teto de 200 requisições em voo do quick tunnel (excedido ⇒ 429) |

### M7 — Ciclo de vida (3 min)

| # | Passo | Critério |
| --- | --- | --- |
| 1 | Recarregar o plugin (HMR do DSH) com o túnel ligado | Comportamento **documentado** ocorre (derruba e reabre com URL nova, **ou** recusa com motivo) — nunca dois túneis |
| 2 | `ps` após o reload | Um `cloudflared`, um worker do bot. Nada duplicado |
| 3 | Desativar o plugin no perfil e reiniciar o DSH | Nenhum processo remanescente; UI do DSH volta ao comportamento original (sem gate) |

---

## 10. Smoke test pós-release

Executado sobre o artefato **publicado**, em máquina limpa (container ou VM), não
sobre o working tree.

| # | Verificação | Comando / critério |
| --- | --- | --- |
| 1 | Pacote instalável | `npm pack` + `npm i ./dsh-guarded-bot-orchestrator-x.y.z.tgz` num diretório vazio |
| 2 | `exports` corretos | `npx publint` sem erro |
| 3 | Tipos corretos | `npx @arethetypeswrong/cli --pack .` sem "Masquerading" nem "No types" |
| 4 | Conteúdo do tarball | `npm pack --dry-run` (e `scripts/check-tarball.mjs`): **contém** `dist/index.js`, `dist/index.d.ts`, `dist/worker/telegram-bot.js`, `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md`; e **não contém** `src/`, `types/`, `test/`, `docs/`, `.env`. A asserção é essa, invertida em relação à versão anterior deste documento: `files` canônico é `["dist","cordis.patch.yml","README.md","LICENSE","CHANGELOG.md"]` (D13), porque `src/` publicado é inútil dentro de `node_modules` (o Node recusa type stripping lá: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) e `types/` são shims de terceiros que podem colidir no consumidor |
| 5 | Provenance | `npm audit signatures` verifica assinatura e attestation |
| 6 | Instalação no DSH | `dsh plugin --profile web add dsh-guarded-bot-orchestrator` (forma canônica das entradas do registro) |
| 7 | Boot | DSH sobe; log do plugin registra bind loopback validado; **sem** warning novo |
| 8 | Gate ativo | `curl 127.0.0.1:3080/api/…` sem credencial ⇒ 401 |
| 9 | Estado inicial | `STOPPED`. Nada exposto por padrão |
| 10 | Onboarding detecta | `dsh-guard-setup` reconhece config existente e é idempotente. Ele vem do próprio pacote (campo `bin`), e `dist/worker/telegram-bot.js` está no tarball — sem isso, (a) não é instalável |
| 11 | Ciclo mínimo | `/ligar` → confirmação → URL → abre com senha → `/desligar` → processo morto |
| 11b | Ciclo mínimo pela **outra** superfície | `POST /__guard/api/tunnel/start` → URL → `POST /__guard/api/tunnel/stop`. As duas superfícies mostram o mesmo `seq` (CTL-040) |
| 12 | Desinstalação limpa | `dsh plugin remove`: sem processo remanescente, sem timer, sem rota órfã |
| 13 | Versão anterior convive | Instalar a versão anterior por cima e voltar: estado em disco migra ou é rejeitado com mensagem clara |
| 14 | README bate com a realidade | Cada comando do README é executado literalmente; comando que não funciona é bug de release |
| 15 | Suíte contra o pacote instalado | `test/contract/` roda apontando para o `node_modules` da máquina limpa |

---

## 11. Cobertura: metas e não-metas

### 11.1 Metas

| Escopo | Linhas | Branches | Funções | Justificativa |
| --- | --- | --- | --- | --- |
| `src/http/**`, `src/control/**` | **95 %** | **90 %** | 100 % | Decisão de segurança e de estado. Branch não coberto aqui é bypass não testado |
| `src/secret/**`, `src/session/**`, `src/ratelimit/**` | **95 %** | **90 %** | 100 % | idem |
| **`worker/auth/**`** | **95 %** | **90 %** | 100 % | É onde vive a allowlist do Telegram (D2/D17): módulo de decisão de segurança como qualquer outro, só que num processo separado |
| `src/state/**` | **95 %** | **90 %** | 100 % | Único writer do `state.json`; um branch não coberto aqui é estado corrompido em produção |
| `src/proc/**`, `src/tunnel/**` | 90 % | 85 % | 95 % | Alguns caminhos dependem do SO e são cobertos por e2e, que não entra no relatório de cobertura unitária |
| Projeto inteiro (gate de CI, `pnpm test:cov`) | **90 %** | **85 %** | **95 %** | Valor de referência para lib TS; sobe por catraca, nunca desce |

Catraca (job `coverage`, D17): o CI compara com o valor commitado e **falha se
cair**, mesmo que ainda esteja acima do mínimo. Subir o piso é decisão de PR, com
nota. O piso por **módulo de decisão de segurança** é 95 %/90 % **com catraca** —
não os ≥90 %/≥85 % globais, que valem para o resto do projeto.

O módulo `src/telegram/authz.ts` **não existe** nesta árvore: a allowlist vive em
`worker/auth/allowlist.ts` (D1/D2), e é assim que ela aparece na tabela acima.

### 11.2 O que **não** perseguir

| Não perseguir | Por quê |
| --- | --- |
| 100 % global | Empurra para testes de getter e para `/* istanbul ignore */`. O custo marginal do último 5 % é maior que o valor |
| Cobertura de `src/index.ts` (raiz de composição) | É fiação. Coberta indiretamente por integração; teste unitário dela testa o dublê |
| Cobertura dos dublês e helpers de `test/support/` | Exceto `child-double.contract.test.ts`, que testa o dublê **de propósito** |
| Cobertura de branches de plataforma (`win32`) | Não temos runner Windows no gate. Os caminhos são cobertos por injeção de `platform`, e a cobertura real fica marcada como lacuna conhecida |
| Cobertura como prova de qualidade | Ver §7.1: 100 % de linha, 8 testes verdes, tree-kill morto. A prova é mutação + e2e |
| Cobertura no relatório de e2e | O e2e roda em processo separado; misturar os relatórios produz número bonito e sem significado |

---

## 12. Como isso roda no CI

Detalhes completos de repositório e workflows em
[06-REPO-E-CI](06-REPO-E-CI.md). Aqui, só a parte de teste.

### 12.1 Jobs

Os nomes de job abaixo são **literais** e casam um a um com os *required status
checks* de `master` definidos em [09 §D14](09-DECISOES-CANONICAS.md). Nome de job
que não casa com required check é branch protection que não protege nada.

| Job | Roda em | Node / SO | Precisa de rede | Precisa de segredo | Required check |
| --- | --- | --- | --- | --- | --- |
| `lint` | todo push/PR | 24, ubuntu | não | não | ✅ |
| `typecheck` | todo push/PR | 24, ubuntu | não | não | ✅ |
| `build` | todo push/PR | 24, ubuntu | não | não | ✅ |
| `test (ubuntu-latest, 24)` | todo push/PR | 24, ubuntu | não | não | ✅ |
| `test (ubuntu-latest, 26)` | todo push/PR | 26, ubuntu | não | não | ✅ |
| `test (macos-latest, 24)` | todo push/PR | 24, macOS | não | não | ✅ |
| `test-contract` | todo push/PR + nightly | 24, ubuntu | **sim** | não | ✅ |
| `test-security` | todo push/PR | 24, ubuntu | não | não | ✅ **sempre** |
| `test-e2e` | todo push/PR | 24, `ubuntu-latest` | não | não | ✅ |
| `coverage` | todo push/PR | 24, ubuntu | não | não | ✅ (catraca) |
| `changeset` | todo PR | — | não | não | ✅ |
| `secrets-scan` | todo push/PR | — | não | não | ✅ |
| `dsh-compat` | nightly | 24 | sim | não | ❌ (falha abre issue) |
| `live` | `workflow_dispatch` | 24, ubuntu | **sim (túnel real)** | não | ❌ **nunca** |
| `mutation` | nightly | 24 | não | não | ❌ (relatório, `break` desligado) |
| `scorecard`, `codeql` | agendado | — | sim | não | ❌ |
| `example-smoke` | push/PR | 24 | não | não | ❌ (informativo até a Onda 7) |
| `smoke-release` | após publish | 24 | sim (registry) | sim | ❌ (pós-release) |

Matriz de Node canônica (D12): **`ubuntu-latest` × 24**, **`ubuntu-latest` × 26**,
**`macos-latest` × 24**. Node 22 fica **fora** — testar em 22 um pacote que
declara `engines: node >=24` não é cobertura, é ruído. Windows fica fora
(`"os": ["linux","darwin"]`). A justificativa escrita da matriz é **apenas**
`engines: node >=24`; a afirmação sobre versões de type stripping **não pode** ser
usada como razão (§3.1).

`test/live/**` **nunca** é gate: exige `DSH_GUARD_LIVE_TESTS=1`, roda só por
`workflow_dispatch` no workflow `live.yml`, e publica um túnel real na internet —
o que é aceitável sob supervisão humana e inaceitável num PR.

### 12.2 Segredos e PR de fork

Regra: **nenhum job que roda em PR pode exigir segredo.** Isso não é preferência,
é consequência: `secrets` não são expostos a workflows disparados por
`pull_request` de fork, e um job que precisa deles falha de forma confusa para o
contribuidor externo.

| Item | Onde vive | Consequência |
| --- | --- | --- |
| Token do Telegram | **Nunca** no CI | Todo teste de Telegram usa dublê ou servidor local. Nenhuma exceção |
| Credencial da Cloudflare | **Nunca** no CI | `fake-cloudflared.mjs`. Túnel real só em M2 |
| Segredo de acesso | Gerado no próprio teste | `CANARY` fixo, sem valor fora do teste |
| Publicação npm | Trusted Publishing por OIDC (`permissions: id-token: write` **só** no job de publish) | Tokens classic foram revogados em 09/12/2025; granular tokens duram no máx. 90 dias |
| Registry npm (para `test-contract`) | Acesso público de leitura | Job não roda em PR de fork por causa da flakiness de rede, não por segredo |

Higiene de workflow: `permissions: {}` no topo, permissão mínima por job,
actions pinadas por SHA (pontua em `Pinned-Dependencies` do OpenSSF Scorecard),
`pnpm/setup@v2` (o `pnpm/action-setup` está deprecado para pnpm ≥11), lockfile
commitado e install `--frozen-lockfile`.

### 12.3 Fluxo por evento

```
gate de onda (snapshot, após CADA squash-merge — 03-ONDAS §0):
  pnpm lint && pnpm typecheck && pnpm build && pnpm test
  ─ test:security, test:contract e test:e2e NAO entram aqui: são
    critério de aceite DA ONDA (rodados uma vez, no fim) e required
    check de PR. test:live nunca é gate.

PR (inclusive de fork):
  lint · typecheck · build ·
  test (ubuntu 24) · test (ubuntu 26) · test (macos 24) ·
  test-contract · test-security · test-e2e · coverage ·
  changeset · secrets-scan
  ─ tudo offline exceto test-contract, tudo determinístico, tudo bloqueante

push em master:
  o acima

nightly:
  dsh-compat (falha ⇒ abre issue) · mutation (break desligado) · quarentena ·
  bench de timing (informativo) · suíte em ordem invertida (caça a
  acoplamento entre testes) · e2e em macOS

workflow_dispatch, sob supervisão humana:
  live (DSH_GUARD_LIVE_TESTS=1, túnel REAL)

tag de release:
  o acima + checklist dos 50 mutantes (§7.2) revisado e assinado +
  roteiros manuais M1..M7 (checklist humano) + smoke-release pós-publish
```

### 12.4 Detalhes operacionais

- Reporter `spec` local, `junit` no CI (`--test-reporter=junit
  --test-reporter-destination=junit.xml`) para anotação no PR.
- Artefatos preservados em falha de e2e: stdout/stderr do `fake-cloudflared`,
  saída de `ps`, arquivo de estado. Debugar processo sem esses três é adivinhação.
- `TEST_TIMEOUT_FACTOR=3` no CI, só para e2e.
- `test-e2e` roda só em `ubuntu-latest`. macOS no nightly (comportamento de
  processo é POSIX, mas subreaper e `ps` diferem). Windows **não** roda e2e — o
  caminho `win32` é coberto por injeção de `platform`, e isso está registrado
  como lacuna conhecida em §14.
- Diretório de teste recém-criado por COMMIT PREP nasce com `_placeholder.test.ts`
  verde. `node --test` com glob que não casa **sai 1**, e um gate vermelho por
  ausência de arquivo treina a equipe a ignorar gate vermelho (§3.1).

---

## 13. Mapeamento onda → critério de aceite

Cada onda de [03-ONDAS](03-ONDAS.md) fecha com uma lista de IDs verdes. O
orquestrador usa isto como gate de integração.

| Onda | Critério de aceite (IDs) |
| --- | --- |
| **O0** — reconhecimento | `CONTRACT-001…009` verdes (dono do diretório: T0.1); `docs/spikes/` com respostas para: nome do serviço (`httpServer`), pacote do subprocess, assinatura do `spawn`, pacote do frontend estático, suporte do Stryker a `node:test`, opção de `apiRoot` do grammY, type stripping na versão do Node do CI, header `Authorization` duplicado, **repasse e confiabilidade de IP pelo `cloudflared` (S2)** e **existência de `InlineKeyboardButton.style`** |
| **O1** — fundação | Suíte atual migrada para o layout §3.2 **sem perda de caso**; contrato do dublê de `ChildProcess` verde; `inject: ['httpServer','subprocess','logger']` com CONTRACT-001/002 verdes; nenhum arquivo de `src/`, `worker/` ou `test/` acima de **400 linhas** |
| **O2** — primitivas de auth e estado | `STATE-001…011`, `AUTH-001…042`, `SECRET-001…018`, `SESS-001…010`, `RL-001…018`, `MAG-001…010` (parte de store, em `src/session/magic.ts`), `ORIG-015…017` |
| **O3** — túnel, probe, TTL e fiação | `TUN-001…026` (inclui **probe de 4 sondas** TUN-020…025 e **TTL** TUN-016…019/026), `SUP-001…015`, `TENSAO-001…007`, `PANEL-001…010`, `MAG-001…010` (parte de rota, em `src/panel/magic.ts`) |
| **O4** — Telegram | `TG-001…089`, `PAIR-001…010`, `ADV-030…036` |
| **O5** — liga/desliga | `CTL-001…040`, `LIFE-001…023` |
| **O6** — integração ponta a ponta | `E2E-001…014`, `ADV-001…059`, **checklist dos 50 mutantes de §7.2 revisado e assinado** (não score de ferramenta), cobertura nas metas §11.1 **com catraca** |
| **O7** — empacotamento | Smoke test §10 completo; roteiros M1…M7 registrados em `docs/manual-runs/`; `pnpm test:live` executado **uma vez**, à mão, com resultado registrado |

**Os quatro pedidos do usuário, e o teste que prova cada um.** Nenhuma linha
desta tabela pode ficar sem ID verde — é o que impede o plano de entregar quatro
capacidades "descritas".

| Capacidade pedida | Onde é provada |
| --- | --- |
| **(a)** guiar o usuário a conectar o Telegram | `TG-060…TG-072` (detector + textos + painel + 5 avisos), `PAIR-001…010` (pareamento seguro por código), roteiro **M1** com pessoa que nunca viu o projeto, item 10 do smoke §10 (a CLI vem no pacote) |
| **(b)** subir o túnel e devolver o link para codificar | `TUN-001…026` (descoberta, readiness, probe, TTL), `SUP-001…015`, `E2E` `tunnel-cycle`, roteiro **M2** (inclui codificar de fato pelo celular na 4G) |
| **(c)** senha que impede terceiros, com as seguranças necessárias | `SECRET-001…018` (inclui entrega local e **SEC-14**), `SESS-001…010`, `RL-001…018` (inclui modo restrito), `MAG-001…010`, `PANEL-001…010`, toda a §6 adversarial, roteiro **M5** |
| **(d)** ligar/desligar pelo bot **e** pela UI | `CTL-001…040` (com **CTL-040** exigindo paridade das duas superfícies), `TG-080…089`, roteiro **M3** |

> **Desvio do pedido, declarado (C1 B15).** O usuário pediu "pela extensão/UI". O
> plano entrega um **painel próprio** em `/__guard/**`, porque o spike S4 (existe
> ponto de contribuição de UI no DSH?) está **aberto**. Isso é uma decisão
> defensável e está aqui explicitamente para não passar por acidente: se S4 der
> positivo, a superfície de UI nativa é trabalho **adicional**, não substituto — e
> nesse caso `CTL-040` passa a exigir paridade das **três** superfícies. Este
> documento não decide S4; ele registra a consequência de cada resposta.

---

## 14. Lacunas e itens NÃO CONFIRMADOS

Lista honesta. Nenhum destes pode virar premissa silenciosa de implementação.

| # | Item | Estado | Como resolver |
| --- | --- | --- | --- |
| 1 | Stryker suporta `node:test` como runner | **NÃO CONFIRMADO** — docs listam jest/mocha/vitest/jasmine/karma/cucumber-tap | Spike O0; plano B em §7.3 |
| 2 | Opção do grammY para apontar a raiz da API a um servidor local | **NÃO CONFIRMADO** | Spike O0 contra o `.d.ts` de `grammy@1.45.1` |
| 3 | Comportamento do `node:http` com `Authorization` duplicado | **NÃO CONFIRMADO** | Teste-sonda AUTH-020 escrito antes da decisão |
| 4 | Type stripping nativo na versão exata do Node do CI | **NÃO CONFIRMADO** | Spike O0; fallback compilar antes de testar |
| 5 | Cloudflare Access não pode cobrir um quick tunnel (exige `zone_id`/domínio) | **Fato de Confiança Alta**, com documentação da Cloudflare registrada em `08-PESQUISA-E-FONTES.md` §1.3/§7.4 e fato #8 do ledger (D24 item 1). **Não é mais item de dúvida** | Pode ser usado como base de L0. O que **é** roadmap v0.2 é a **validação do `Cf-Access-Jwt-Assertion`**; o transporte named tunnel (`--token-file`) está na v0.1 (D6) |
| 6 | Limite de 50 usuários do Zero Trust free | **NÃO CONFIRMADO** — só em fontes de terceiros e num PDF de 2022 | Irrelevante para 1 usuário; não citar como fato |
| 7 | Cobertura real do caminho `win32` | Lacuna conhecida | Coberta por injeção de `platform`; e2e Windows fora de escopo, registrado no README |
| 8 | Comportamento sob carga real (200 requisições em voo do quick tunnel) | Não testável localmente | Roteiro M6 passo 5; documentar o teto para o usuário |
| 9 | Benchmarks do `jcode` e o pacote `pi2dsh` | **NÃO CONFIRMADO** pela pesquisa | Não usar em nenhum teste, doc ou material de divulgação |
| 10 | Segurança do `deleteMessage` como mitigação | **Refutado** — só funciona < 48 h, não é remoção segura | Nunca tratar "apago depois" como controle; ADV-036 cobre a alternativa correta |
| 11 | "Token vazado contorna a allowlist completamente" | **Refutado** como generalização | O vetor real é confuso-deputado; ADV-030 é o teste correto |
| 12 | "Quick tunnel não suporta SSE" | **Refutado** — POST funciona, GET buffera; este harness usa WebSocket | M6 valida na prática; não descartar quick tunnel por esse motivo |
| 13 | "`child.kill()` nunca basta quando há shell" | **Refutado** — depende do shell (bash faz exec, dash forka) | E2E-004 e E2E-005 congelam os dois comportamentos |
| 14 | `InlineKeyboardButton.style` (`success`/`danger`/`primary`) | **NÃO CONFIRMADO — spike obrigatório (T0.3)**. Entrou no plano como fato de confiança "Alta" sem verificação contra a referência da Bot API | Até confirmar: TG-029 é `skip`, o teclado se distingue por **texto**, e nenhuma entrega pode depender do campo |
| 15 | `drop_pending_updates` como parâmetro de `getUpdates` | **Corrigido**: é parâmetro de `setWebhook`/`deleteWebhook`; no long polling é opção de `bot.start()` do grammY | TG-045 assere a chamada onde ela existe e falha se alguém a puser no `getUpdates` |
| 16 | `start` durante `STOPPING`: rejeitar (`SHUTDOWN_IN_PROGRESS`, 01 §9.2) ou enfileirar (versão anterior de CTL-007) | **RESOLVIDO — 09 §D29: rejeitar.** Fail-closed; enfileirar quebraria o kill switch | CTL-007 é asserção. O PREP 5 transcreve D29, não decide |
| 17 | Chave de idempotência de `ControlIntent`: `requestId` (ULID + janela) **ou** só `nonce` | **RESOLVIDO — 09 §D29: `requestId`.** O nonce é ortogonal (autoriza, não deduplica) | CTL-002/CTL-003 asserem sobre `requestId`; nonce repetido é recusado |
| 18 | Cookie `__Host-`/`Secure` emitido pelo painel local em `http://127.0.0.1:3080` | **NÃO CONFIRMADO** — `02 §L4` diz *SHALL NOT* cair para `http`, e o caminho local é http | SESS-010 nasce como sonda; decisão no PREP 2 |
| 19 | Repasse de IP do cliente pelo `cloudflared`, e se o valor é **controlado pelo atacante** | **NÃO CONFIRMADO** — S2 pergunta só a primeira metade | ORIG-015…017 assumem `trustEdgeHeaders: false`; nada mais pode ser assumido antes de S2 |
| 20 | Dead-man's switch e verificação de órfão para o **`cloudflared`** (não só para o worker) | Testado por E2E-012/E2E-013 sem dono de implementação declarado | O teste **fica**; a resposta certa é construir o controle. Ver a nota de §5.4.5 |
| 21 | Caminho canônico de `test/support/fixtures/**`, do helper de HTTP e do teste de contrato do dublê | **Pendência do COMMIT PREP 2** — não constam da lista fechada de 5 arquivos prep-owned de D15 | Ver a nota de §3.2. Sem isso, `FIXTURE-001` não tem caminho |
| 22 | Emissão de `bin/` para `dist/` e o campo `bin` do `package.json` | **Pendência do COMMIT PREP 7** — a regra canônica manda `tsconfig.build.json` compilar `src/` e `worker/`, e **não cita `bin/`**, que é o terceiro diretório de fonte | Sem isso a CLI de onboarding não existe no pacote instalado e a capacidade **(a)** não é entregável. O item 10 do smoke §10 é o teste que falha, e ele **deve** falhar até a pendência fechar |

---

## 15. Fontes

Documentação e medições que sustentam as afirmações técnicas deste documento.

- Node.js `child_process` (eventos `spawn`/`exit`/`close`/`error`, `detached`,
  `signal`, limites de `kill` com shell): <https://nodejs.org/api/child_process.html>
- Node.js `crypto` (`randomBytes`, `timingSafeEqual`, `argon2` desde v24.7.0):
  <https://nodejs.org/api/crypto.html>
- Telegram Bot API (`getUpdates`, `setWebhook`, `answerCallbackQuery`,
  `callback_data`, `deleteMessages`, `BotCommand`):
  <https://core.telegram.org/bots/api>
- Telegram — BotFather e segurança do token:
  <https://core.telegram.org/bots/features#botfather>
- Telegram — criptografia de cloud chats: <https://telegram.org/faq#q-so-how-do-you-encrypt-data>
  e política de privacidade <https://telegram.org/privacy>
- Cloudflare — TryCloudflare / quick tunnels (uso só para teste e
  desenvolvimento, limites):
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>
- Cloudflare — métricas do túnel (a página oficial **não** documenta
  `/quicktunnel`; o endpoint foi verificado empiricamente):
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/>
- Cloudflare — políticas do Access: <https://developers.cloudflare.com/cloudflare-one/policies/access/>
- OWASP ASVS 5.0 — V11 Cryptography (11.5.1, 11.2.4):
  <https://github.com/OWASP/ASVS/blob/master/5.0/en/0x20-V11-Cryptography.md>
- OWASP ASVS 5.0 — V7 Session Management (7.2.3):
  <https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md>
- OWASP Authentication Cheat Sheet (mensagem de erro genérica, lockout logado):
  <https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html>
- NIST SP 800-63B rev.4 (§3.2.2 limite de 100 tentativas; §5.1.1 cookies e CSRF;
  timeouts de reautenticação): <https://pages.nist.gov/800-63-4/sp800-63b.html>
- fail2ban — defaults `maxretry=5`, `findtime=10m`, `bantime=10m`:
  <https://github.com/fail2ban/fail2ban/blob/master/config/jail.conf>
- RFC 4648 (base32/base64): <https://www.rfc-editor.org/rfc/rfc4648.html>
- RFC 7617 (Basic auth exige TLS): <https://www.rfc-editor.org/rfc/rfc7617.html>
- Stryker Mutator (thresholds, incremental): <https://github.com/stryker-mutator/stryker-js>
- libuv — reaping só de filhos diretos: <https://github.com/libuv/libuv/issues/4179>
- cloudflared — bufferização de SSE em GET: <https://github.com/cloudflare/cloudflared/issues/1449>
- Discussões de segurança do DSH (todas verificadas, HTTP 200): #853 (RCE não
  autenticado no control plane da Web UI, 0.1.0-rc.6), #1769 (escape do sandbox
  `bwrap`), #3144, #441 (escrita não atômica do `cordis.yml`).
- Medições locais (cloudflared 2026.7.3, Node v24.15.0, Linux 6.18) reportadas no
  dossiê de pesquisa: `/quicktunnel`, stderr-only, 6–7 s até a URL, shutdown em
  ~2 s com SIGTERM, PGID/SID de filhos detached, ENOENT → `error` + `close`.
