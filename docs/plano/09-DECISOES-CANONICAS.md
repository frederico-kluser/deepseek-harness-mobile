# 09 — DECISÕES CANÔNICAS (fonte única da verdade)

> Este arquivo é a **fonte única da verdade** do plano. Os documentos 01–08 foram escritos em
> paralelo por agentes que não se viram e contradizem uns aos outros em pontos que tornam o plano
> inexecutável; aqui cada ponto em conflito tem **uma** decisão, e **em qualquer divergência futura
> entre este arquivo e os demais, este arquivo vence** — os outros é que são corrigidos.

**Como usar.** Cada seção traz: o CONFLITO, a DECISÃO, a JUSTIFICATIVA e a lista literal de
**o que muda em qual arquivo** (`arquivo → seção → de X para Y`). Os dois agentes de correção
executam essas listas ao pé da letra, sem reinterpretar. Nada aqui é sugestão.

**Fatos verificados que ficam acima de qualquer texto dos 8 arquivos** (recon por HTTP direto):

| # | Prescrição ERRADA que não pode sobreviver | Forma REAL, obrigatória |
| --- | --- | --- |
| E1 | `@deepseek-ai/dsh-host-subprocess` (404 no npm) | `@deepseek-ai/dsh-subprocess` |
| E2 | `ctx.webServer`, tipo `WebServer`, `inject: ['webServer']` | `ctx.httpServer`, tipo `HttpServerService`, `inject: ['httpServer']` (o tipo `WebRoute` existe e permanece) |
| E3 | `spawn(cmd, args, opts)` | `spawn(spec: SubprocessSpawnSpec)` com `argv`, `cwd`, `stdio`, `graceMs` obrigatórios e `signal` opcional |
| E4 | `dsh-host-frontend` | `@deepseek-ai/dsh-host-frontend-static` |

Aparecer na **coluna "errado"** de uma tabela de correção está CERTO e deve permanecer. Aparecer
como forma **prescrita** (código de exemplo, `inject`, assinatura recomendada) é defeito e sai.

---

## D1 · ÁRVORE `src/` CANÔNICA

**Conflito.** Três árvores mutuamente incompatíveis: `03-ONDAS.md` §4.2 (dono por arquivo, mas
grossa e sem `state/`, `brand`, `errors`, `logging`, `dsh/`), `05-QUALIDADE-CODIGO.md` §5.4 (fina e
com responsabilidade por arquivo, mas **sem `contracts/`** e com `telegram/allowlist.ts` no host) e
`06-REPO-E-CI.md` §2 (`gate/`, `supervisor/`, `log/`, `dsh/adapter.ts`, bot in-process). O mapa de
propriedade das ondas quebra arquivo por arquivo.

**DECISÃO.** Vale a árvore abaixo, e só ela. Ela deriva de 03 (autoridade sobre *quem escreve*),
absorve a granularidade e as responsabilidades de 05, absorve `dsh/adapter.ts` e `logging/redact.ts`
de 06, e acrescenta `state/` (exigido por `01-ARQUITETURA.md` §6 e por T2.5, que hoje não tem
diretório em nenhuma árvore).

**Justificativa.** É o único documento que o `deep-orchestrator` consome literalmente é o 03, então
a árvore precisa ter dono por arquivo; mas a árvore de 03 deixa quatro módulos sem dono e omite o
writer de estado, o que faz três sub-tarefas da Onda 2 disputarem o mesmo arquivo. A granularidade
de 05 é o que mantém o teto de 400 linhas por arquivo exigido pelo aceite da Onda 1.

```
src/
  index.ts                 Raiz de composição: name, inject, apply. Fia módulos, não implementa regra.  [SINGLETON: T1.1 → T3.3 → T4.3 → T5.1]
  brand.ts                 Branded IDs (SessionId, Nonce, SecretDigest) e construtores validadores.     [T1.1]
  errors.ts                Hierarquia de erro tipada + códigos estáveis (05 §6.1).                      [T1.1]
  contracts/               Interfaces congeladas em COMMIT PREP. Leitura livre, ESCRITA PROIBIDA.       [prep]
    auth.ts                SecretStore, SessionStore, RateLimiter, AuditSink.                           [PREP 2]
    state.ts               StateStore: leitura e escrita atômica do state.json.                         [PREP 2]
    tunnel.ts              TunnelState, TunnelInfo, TunnelDiscovery.                                    [PREP 3]
    ipc.ts                 Protocolo JSON-lines host↔worker.                                            [PREP 4]
    control.ts             ControlIntent, transições legais, contrato do nonce de confirmação.          [PREP 5]
  dsh/
    adapter.ts             ÚNICO ponto do repositório que toca API do DSH (ctx.httpServer, ctx.subprocess). [T1.1]
  config/
    schema.ts              interface Config — contrato congelado do cordis.patch.yml.                   [T1.1 → T3.3]
    assert.ts              assertValidConfig e os assertores primitivos que ela usa.                    [T1.1 → T3.3]
    bind.ts                assertSecureBind, isWildcardBindHost — política de bind.                     [T1.1]
  logging/
    logger.ts              Wrapper de ctx.logger com LOG_SCOPE fixo.                                    [T1.1]
    redact.ts              redact(): mascara bot<n>:<token>, Authorization, Cookie, mk e URL do túnel.  [T1.1]
  permissions/
    deny.ts                canonicalizePermissionToken, requestsDeniedPermission.                       [T1.1]
  http/
    auth-basic.ts          verifyBasicAuth: parse do header + comparação em tempo constante.            [T1.1]
    origin.ts              normalizeRemoteAddress, isTrustedRemote.                                     [T1.1]
    path.ts                canonicalRequestPath, isGuardedPath, routeMayServeGuardedPath.               [T1.1]
    responses.ts           challengeBasicAuth, denyUntrustedOrigin, denyUpgrade — corpos idênticos.     [T1.1]
    gate.ts                createGuardedHandler, createGuardedUpgradeHandler.                           [T1.1 → T3.3]
    intercept.ts           Fiação de ctx.intercept('httpServer', …) sobre register/fallback/upgrade.    [T1.1]
    session-auth.ts        Verificação do cookie de sessão dentro do gate.                              [T3.3]
    host-header.ts         Validação do header Host (L2.5 — anti DNS rebinding).                        [T3.3]
  state/
    paths.ts               Resolve $XDG_STATE_HOME/dsh-guarded-bot + fallback + modos 0700/0600.        [T2.5]
    schema.ts              Forma versionada do state.json (version: 1) e migração.                      [T2.5]
    store.ts               ÚNICO writer: tmp no mesmo dir + fsync + rename; recusa modo > 0600.         [T2.5]
  secret/
    generate.ts            CSPRNG randomBytes(32) + base32 RFC 4648 sem padding + agrupamento visual.   [T2.1]
    canonical.ts           canonicalizeSecret: upper, remove '-' e espaço.                              [T2.1]
    store.ts               Persiste só o digest, via StateStore. Nunca o segredo em claro.              [T2.1]
    verify.ts              Comparação de digests de 32 bytes em tempo constante.                        [T2.1]
    ott.ts                 Token de uso único (128 bits, TTL 10 min) que destrava /__guard/secret.      [T2.1]
  session/
    store.ts               Emissão, lookup e expiração (inatividade 60 min, absoluto 8 h). Disposer.    [T2.2]
    cookie.ts              Serialização de __Host-dsh_sid com os atributos obrigatórios.                [T2.2]
    magic.ts               Store do mk do link mágico: 128 bits, TTL 120 s, uso único, só em memória.   [T2.2]
  ratelimit/
    policy.ts              Função pura falhas→atraso (full jitter), limiar de ban, teto NIST.           [T2.3]
    tracker.ts             Contadores por identidade em memória. Disposer.                              [T2.3]
    restricted.ts          Modo restrito: ativa aos 100, persiste via StateStore, derruba o túnel.      [T2.3]
  audit/
    log.ts                 Log append-only 0600, fora do workspace. Disposer.                           [T2.4]
    format.ts              Serialização de {ts, evento, resultado, ip_normalizado, sessao_id_hash}.     [T2.4]
    events.ts              Vocabulário fechado de eventos de auditoria e de notificação.                [T5.4]
    notify.ts              Composição da notificação proativa (best-effort, sempre DEPOIS do log).      [T5.4]
  proc/
    backoff.ts             computeBackoffDelay — puro, full jitter, sem I/O.                            [T1.1]
    env.ts                 buildWorkerEnv (allowlist) e buildTunnelEnv — perfis de ambiente distintos.  [T1.1 → T4.3]
    tree-kill.ts           process.kill(-pid) sobre o grupo; ramo win32 isolado e inerte.               [T1.1]
    supervisor.ts          createWorkerSupervisor genérico; chama spawn(SubprocessSpawnSpec).           [T1.1 → T3.1 → T4.3]
  tunnel/
    args.ts                argv do cloudflared: --metrics fixo, --token-file, proíbe --loglevel debug.  [T3.1]
    supervisor.ts          Ciclo de vida do cloudflared sob ctx.effect; orçamento; não-retryable.       [T3.1]
    probe.ts               Probe fail-closed de 4 sondas anônimas ANTES de subir (ver D11).             [T3.1]
    ttl.ts                 Timer de TTL (default 60 min, teto 480) com relógio injetado (ver D6).       [T3.1]
    pidfile.ts             Pidfile do cloudflared + varredura de órfão no boot (02 §9).                 [T3.1]
    discover.ts            GET /quicktunnel + fallback regex em stderr; prefixa https://.               [T3.2]
    readiness.ts           Polling com timeout ≥30 s, abortado no 'close' do filho.                     [T3.2]
  panel/
    routes.ts              Registro das rotas /__guard/* e a política por rota da tabela de D5.         [T3.4 → T5.3]
    html.ts                Painel HTML autocontido: sem CDN, sem build, sem recurso externo.            [T3.4 → T5.3]
    api.ts                 GET /api/state, POST /api/login, POST /api/tunnel/start|stop.                [T3.4 → T5.3]
    magic.ts               GET inerte + POST consumidor de /__guard/magic.                              [T3.4]
    secret.ts              GET /__guard/secret?ott=… — uma vez; 404 idêntico ao de rota inexistente.    [T3.4]
    csrf.ts                Token anti-CSRF das rotas POST do painel.                                    [T3.4]
  telegram/
    onboarding.ts          Detecção de estado da conexão + roteiro guiado passo a passo.                [T4.1]
    pairing.ts             Código de pareamento de 6 dígitos, TTL 5 min, fechamento permanente.         [T4.1]
    ipc.ts                 Lado HOST do protocolo JSONL host↔worker.                                    [T4.3]
  control/
    controller.ts          Máquina de estado ÚNICA; fila de intents; idempotência; broadcast com seq.   [T5.1]
    confirm.ts             Nonce server-side (TTL 60 s) das ações que AUMENTAM exposição.               [T5.1]
worker/
  telegram-bot.ts          Entry do processo separado: long polling com grammY.                         [T4.2]
  ipc.ts                   Lado WORKER do protocolo JSONL sobre stdio.                                  [T4.3]
  lib/
    client.ts              Configuração do grammY: apiRoot, plugin de auto-retry, bot.catch.            [T4.2]
    polling.ts             timeout 50, allowed_updates, drop_pending_updates, 409 → sair do processo.   [T4.2]
    keyboard.ts            Teclado inline, answerCallbackQuery sempre, editMessageText in-place.        [T4.2]
  auth/
    allowlist.ts           Autorização por from.id E chat.id, fail-closed, descarte silencioso contado. [T4.4]
    guard.ts               Revalidação de identidade em todo callback_query (callback_data não prova nada). [T4.4]
    pairing.ts             Recepção de /parear <código>; segundo pareamento é recusado.                 [T4.4]
  commands/
    router.ts              Roteamento comando → intent IPC; setMyCommands com a lista de D5.            [T5.2]
    onoff.ts               /ligar e /desligar (com confirmação de 2 etapas em /ligar).                  [T5.2]
    access.ts              /acessar e /rotacionar.                                                      [T5.2]
    status.ts              /status e /emergencia.                                                       [T5.2]
bin/
  dsh-guard-setup.ts       CLI de onboarding: provision(), senha + QR ASCII, --reset-pairing.           [T4.1]
```

**Layout de `test/` (canônico, ver também D4 e D15):**

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

**Regra derivada, reescrita (substitui a de `03-ONDAS.md` §4.2):** o dono de `src/x/y.ts` é o dono
de `test/unit/x/y.test.ts` **e** dos arquivos de `test/integration/x/**` que exercitam `y.ts`.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | §4.2 (bloco de árvore) | árvore atual | a árvore de D1, integralmente |
| `03-ONDAS.md` | §4.2 (regra derivada) | "dono de `src/x/y.ts` é dono de `test/x/y.test.ts`" | a regra derivada reescrita acima |
| `03-ONDAS.md` | §4.1 tabela de singletons | linha `src/contracts/**` | acrescentar linhas para `.github/workflows/**`, `README.md` e `worker/**`; ver D28 |
| `03-ONDAS.md` | §7 (Onda 2) | T2.5 sem diretório declarado | T2.5 possui `src/state/**` e `test/unit/state/**` |
| `05-QUALIDADE-CODIGO.md` | §5.4 | árvore própria | substituir pela árvore de D1 (a coluna de dono some; 05 descreve *o que* cada arquivo é, 03 diz *quem* escreve) |
| `05-QUALIDADE-CODIGO.md` | §5.4 | `telegram/allowlist.ts` em `src/` | `worker/auth/allowlist.ts` (ver D2) |
| `05-QUALIDADE-CODIGO.md` | §5.4 | ausência de `contracts/` | acrescentar `src/contracts/**` como prep-owned |
| `05-QUALIDADE-CODIGO.md` | §5.4 | `control/confirm.ts` sem dono | `src/control/confirm.ts` [T5.1] |
| `06-REPO-E-CI.md` | §2 (bloco `src/` e `test/`) | `src/gate/**`, `src/supervisor/**`, `src/log/redact.ts`, `src/telegram/bot.ts`, `src/telegram/commands.ts`, `src/config.ts` | a árvore de D1: `src/http/**`, `src/proc/**`, `src/logging/redact.ts`, `worker/**`, `src/config/**` |
| `06-REPO-E-CI.md` | §2 (bloco `test/`) | `test/{unit,integration,contract,e2e}` flat | o layout de `test/` de D1, incluindo `security/`, `live/`, `support/`, `bin/` |
| `06-REPO-E-CI.md` | §6.5 CODEOWNERS | `src/gate/**` | `src/http/**`, `src/secret/**`, `src/session/**`, `src/ratelimit/**`, `src/dsh/**` |
| `04-TESTES.md` | §3.2 | árvore de `test/` própria | o layout de `test/` de D1 (acrescenta `live/`; `support/` e `bin/` passam a ser prep-owned) |

---

## D2 · ARQUITETURA DO BOT: SUBPROCESSO

**Conflito.** `01-ARQUITETURA.md` §5 e `03-ONDAS.md` (Onda 4) decidem **subprocesso** `detached`
com IPC JSONL; `05-QUALIDADE-CODIGO.md` acompanha; `06-REPO-E-CI.md` §2/§2.1 contradiz, pondo
`src/telegram/bot.ts` dentro do plugin e tratando binário separado como hipótese futura;
`04-TESTES.md` testa os dois modelos ao mesmo tempo.

**DECISÃO.** O bot do Telegram é um **subprocesso supervisionado**, `detached: true`, lançado por
`ctx.subprocess.spawn(spec)` a partir do supervisor genérico, com IPC por **JSON-lines sobre
stdio**. O código do worker mora em `worker/`, **no mesmo pacote npm**, e é compilado para
`dist/worker/telegram-bot.js`. Não existe `packages/`, não existe monorepo, não existe binário
publicado à parte.

**Justificativa.** É a única topologia em que `buildWorkerEnv` é uma fronteira real: in-process a
allowlist de ambiente desaparece por construção, porque o bot herda o `process.env` do DSH. Um bot
que trava, vaza memória ou é morto pelo OOM killer também não pode derrubar o harness junto.

**Consequências obrigatórias:**
- `tsconfig.build.json` compila `src/` **e** `worker/`; o `argv` do spawn resolve
  `dist/worker/telegram-bot.js` relativo a `import.meta.url`, nunca por `cwd`.
- `files` do `package.json` continua sendo só `dist` — `dist/worker/` vai junto (ver D13).
- A allowlist de identidade do Telegram vive em `worker/auth/allowlist.ts`, não em `src/telegram/`.
- O **nonce** de confirmação de 2 etapas é emitido e validado no HOST (`src/control/confirm.ts`,
  T5.1); o worker apenas o transporta opaco dentro do `callback_data`. `callback_data` nunca é
  prova de autorização.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `06-REPO-E-CI.md` | §2 árvore | `src/telegram/bot.ts`, `src/telegram/commands.ts` | `worker/telegram-bot.ts`, `worker/lib/**`, `worker/auth/**`, `worker/commands/**`, `worker/ipc.ts` |
| `06-REPO-E-CI.md` | §2.1 "Um pacote, não monorepo" | "Se o worker do Telegram virar binário separado, aí sim nasce `packages/`" | "O worker do Telegram **já é um processo separado**, no mesmo pacote e no mesmo tarball (`dist/worker/`). Monorepo continua fora de escopo porque não há segundo artefato **publicável**." |
| `06-REPO-E-CI.md` | §5.1 / §9.2 | `tsconfig.build.json` só sobre `src/` | incluir `worker/` na emissão |
| `04-TESTES.md` | §3.2 | `test/unit/telegram/authz.test.ts`, `test/unit/telegram/commands.test.ts` | `test/unit/worker/auth/allowlist.test.ts`, `test/unit/worker/commands/router.test.ts` |
| `04-TESTES.md` | §5 (casos TG-*) | referências a `src/telegram/` | `worker/` conforme a árvore de D1 |
| `03-ONDAS.md` | §9 (T4.4) | "allowlist de identidade + nonce 2-step" | "allowlist de identidade (`worker/auth/**`); o nonce de confirmação é de T5.1 (`src/control/confirm.ts`, contrato congelado no PREP 5)" |
| `03-ONDAS.md` | §10 (T5.2) | "depende de: … contrato de T5.1" | "depende de: T4.2, T4.4, **PREP 5**" |
| `05-QUALIDADE-CODIGO.md` | §5.4 | `telegram/allowlist.ts` | remover de `src/`; consta em `worker/auth/allowlist.ts` |

---

## D3 · ENTREGA DA SENHA E DO LINK

**Conflito.** Três caminhos. `01-ARQUITETURA.md` §9.5: só local, magic link inexistente.
`02-SEGURANCA.md` §4.4/§5.3: magic link é caminho normal e `control.magicLink` é `true` por padrão
em `mode: 'tunnel'`. `03-ONDAS.md` §10: magic link opt-in, flag desligada por padrão.
`04-TESTES.md` M5 passo 6: afirma que a entrega **é** por magic link.

**DECISÃO.** Vale `02-SEGURANCA.md`. São dois artefatos com dois canais, e nenhum deles é opt-in:

1. **Senha permanente — canal LOCAL, sempre, sem exceção.** Terminal do `bin/dsh-guard-setup` no
   primeiro boot, em texto **e** como QR code ASCII na mesma tela; ou
   `GET http://127.0.0.1:3080/__guard/secret?ott=<token>`, onde o `ott` é um token de uso único de
   128 bits **impresso no stdout do terminal**, TTL de 10 min, rota que deixa de existir após o
   primeiro consumo. Sem `ott` válido a rota devolve **404 idêntico** ao de rota inexistente. A
   senha **NUNCA** trafega pelo Telegram, por e-mail ou por qualquer mensagem — é invariante
   testada (SEC-14) e não é negociável.
2. **URL do túnel — canal Telegram + painel, sempre.** Não é segredo; a mensagem tem que dizer isso
   com todas as letras (caso `PWR-12`).
3. **Link mágico de uso único — canal Telegram, LIGADO POR PADRÃO em `exposure.mode: 'tunnel'`.**
   `control.magicLink` default `true` quando `mode === 'tunnel'`, default `false` em
   `mode: 'loopback'`. O que trafega é um bearer `mk` de 128 bits, TTL 120 s, uso único, em
   memória do processo. **O opt-in não existe; o que existe é opt-out** (`control.magicLink: false`),
   e nesse caso o caminho para o celular passa a ser o QR do caminho 1, lido antes de sair de casa.

**Justificativa.** `02-SEGURANCA.md` é o documento normativo de segurança e o único que analisou o
comportamento previsível do usuário: sem um caminho utilizável para o celular — que é o produto
inteiro —, o dono cola a senha permanente no chat, exatamente o que o plano proíbe. O invariante de
grep de `03-ONDAS.md` §10 **não é violado**: o `mk` não é o segredo, e SEC-14 testa a ausência do
segredo permanente em qualquer payload de `sendMessage` ou de IPC.

**Controles obrigatórios do magic link (os três, sem exceção):** `GET /__guard/magic` é **inerte**
(HTML estático que não consome nada; o consumo é um `POST` disparado por clique); a mensagem sai com
`disable_web_page_preview: true`; consumo sem clique detectável não emite sessão, não queima o `mk`
e registra `magic.crawler-suspect` no audit log. O `mk` viaja no **fragmento** (`#`), nunca em query
string. O link mágico está sob o mesmo rate limit e conta para o mesmo teto de falhas do login.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | §10, tabela "Entrega da senha e do link", linha "Magic link" | "Telegram, **atrás de flag explícita, desligada por padrão**" | "Telegram, `control.magicLink` **ligado por padrão** quando `exposure.mode: 'tunnel'`; desligável por opt-out. Ver `09-DECISOES-CANONICAS.md` D3" |
| `03-ONDAS.md` | §9, item 4 da lista de fatos do Telegram | "opcionalmente e atrás de flag explícita, um magic link" | "por padrão em `mode: 'tunnel'`, um magic link de uso único com TTL de 120 s" |
| `01-ARQUITETURA.md` | §9.5 | omite o mecanismo | acrescentar subseção "Link mágico de uso único" descrevendo o fluxo de `02-SEGURANCA.md` §5.3 e os três controles de anti-consumo automático |
| `01-ARQUITETURA.md` | §3(e) tabela de rotas | já correta | manter; corrigir a frase de aceite logo abaixo: `POST /__guard/tunnel/up` → `POST /__guard/api/tunnel/start` |
| `02-SEGURANCA.md` | §5.3, diagrama | `/__gate/magic` (3 ocorrências) | `/__guard/magic` |
| `04-TESTES.md` | §M5 passo 6 | "a entrega é por link mágico de uso único" | "a entrega da **senha** é local (terminal/QR/`/__guard/secret?ott=`); o que pode chegar pelo Telegram é o **link mágico** (`control.magicLink`, ligado por padrão em `mode: 'tunnel'`)" |
| `04-TESTES.md` | §5 | falta cobertura | acrescentar casos `MAG-001…MAG-006`: GET inerte; POST consome; segundo POST falha e alerta; TTL 120 s; `mk` só em memória (some no restart); User-Agent de crawler não queima o token |

---

## D4 · GATE, BLOCO DE SCRIPTS E ORDEM DE EXECUÇÃO

**Conflito.** `03-ONDAS.md` §0.2 exige `pnpm typecheck && pnpm build && pnpm test && pnpm lint`,
mas o `package.json` canônico de `06-REPO-E-CI.md` §9.2 **não define `lint`**; `04-TESTES.md` §3.1
propõe um bloco de `scripts` concorrente, com dois `test` diferentes e sem `typecheck`/`build`/`lint`.

**DECISÃO.**

*Bloco de scripts canônico* (é o de `06-REPO-E-CI.md` §9.2, com `lint` acrescentado e os scripts de
`04-TESTES.md` fundidos dentro dele; `test:invariants` é absorvido por `test:security`):

```jsonc
"scripts": {
  "lint":           "oxlint . && eslint .",
  "typecheck":      "tsc --noEmit",
  "build":          "tsc -p tsconfig.build.json",
  "test":           "node --test --test-reporter=spec 'test/unit/**/*.test.ts' 'test/integration/**/*.test.ts'",
  "test:contract":  "node --test 'test/contract/**/*.test.ts'",
  "test:security":  "node --test --test-reporter=spec 'test/security/**/*.test.ts'",
  "test:e2e":       "node --test --test-concurrency=1 'test/e2e/**/*.test.ts'",
  "test:live":      "node --test --test-concurrency=1 'test/live/**/*.test.ts'",
  "test:cov":       "node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=85 --test-coverage-functions=95 --test-coverage-exclude='test/**' 'test/unit/**/*.test.ts' 'test/integration/**/*.test.ts'",
  "test:all":       "pnpm test && pnpm test:contract && pnpm test:security && pnpm test:e2e",
  "types:fetch":    "node scripts/fetch-dsh-types.mjs",
  "package:check":  "publint && attw --pack . && node scripts/check-tarball.mjs",
  "prepublishOnly": "pnpm run build && pnpm run package:check"
}
```

*Comando de gate canônico*, rodado no snapshot depois de **cada** squash-merge:

```
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

`lint` vem primeiro porque é o mais barato. `test:security`, `test:contract` e `test:e2e` **não**
entram no gate de merge intra-onda: eles são **critério de aceite de onda** (rodados uma vez, no fim
da onda, e listados no aceite) e **required check de PR** no CI (D14). `test:live` nunca é gate.

*Armadilha que precisa ser tratada literalmente:* `node --test` com um glob que não casa com nenhum
arquivo **sai com código 1**. Portanto, todo diretório de teste criado por um COMMIT PREP recebe um
`_placeholder.test.ts` com uma asserção trivial verde, que a primeira sub-tarefa real do diretório
apaga. Sem isso o gate fica vermelho na Onda 1 por ausência de arquivos, não por defeito.

*Nomes de `tsc`:* enquanto o repositório estiver em `typescript@^5.9.3`, os scripts usam `tsc`. A
troca para o binário `tsc6` (`typescript: npm:@typescript/typescript6`) é uma entrega **de T1.2** e,
quando ela acontecer, `typecheck` e `build` mudam de `tsc` para `tsc6` **no mesmo commit**. Nenhum
documento pode declarar `tsc6` antes disso.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | §0, regra 2 | `pnpm typecheck && pnpm build && pnpm test && pnpm lint` | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` |
| `03-ONDAS.md` | §0, regra 2 (nova frase) | — | "`pnpm test:security`, `pnpm test:contract` e `pnpm test:e2e` são critério de aceite **da onda**, não do merge; `pnpm test:live` nunca é gate" |
| `06-REPO-E-CI.md` | §9.2 `scripts` | bloco atual (sem `lint`, com `test:invariants`, com `tsc6`) | o bloco canônico de D4 |
| `06-REPO-E-CI.md` | §5.1 | "instalar `tsc6` lado a lado" como fato do repositório | manter como **entrega de T1.2**, com a nota de que até lá os scripts usam `tsc` |
| `04-TESTES.md` | §3.1 | bloco `scripts` próprio | remover o bloco e referenciar D4: "o bloco canônico está em `09-DECISOES-CANONICAS.md` D4" |
| `04-TESTES.md` | §3.1 | `test` com `--test-reporter=spec` vs `--experimental-test-coverage` | um `test` só, o de D4; cobertura fica em `test:cov` |
| `06-REPO-E-CI.md` | §6.3 `ci.yml` | jobs chamando `pnpm exec oxlint .` e `eslint .` direto | job `lint` chamando `pnpm lint` |

---

## D5 · NOMES CANÔNICOS

**Conflito.** Rota, arquivo de estado, cookie, comandos do bot, variáveis de ambiente e nomes de
doc divergem entre 01, 02, 03, 04, 06 e 07 (C4 itens 4, 24, 25, 26, 27, 28).

**DECISÃO.** Um nome por conceito. A coluna "morto" nunca pode reaparecer em código, teste ou doc,
**exceto** dentro de uma tabela de correção que mostre explicitamente o que está errado.

| Conceito | NOME CANÔNICO | Mortos (não podem reaparecer como prescrição) |
| --- | --- | --- |
| Prefixo de rota do plugin | `/__guard` | `/__mobile`, `/__gate` |
| Painel HTML | `GET /__guard/` | — |
| Estado em JSON | `GET /__guard/api/state` | `/__guard/state` |
| Login | `POST /__guard/api/login` | `POST /__guard/login` |
| Ligar túnel | `POST /__guard/api/tunnel/start` | `/__guard/tunnel/up`, `/__mobile/tunnel/up` |
| Desligar túnel | `POST /__guard/api/tunnel/stop` | `/__guard/tunnel/down`, `/__mobile/tunnel/down` |
| Link mágico | `GET /__guard/magic` (inerte) + `POST /__guard/magic` (consome) | `/__gate/magic` |
| Página do segredo | `GET /__guard/secret?ott=<token>` | `/__gate/secret` |
| Canário do probe | `GET /__guard/probe-canary-<aleatório>` | — |
| Arquivo de estado | `$XDG_STATE_HOME/dsh-guarded-bot/state.json` (fallback `~/.local/state/dsh-guarded-bot/state.json`), arquivo `0600`, diretório `0700` | `mobile-gateway.json` |
| Arquivo de segredos do bot | `$XDG_STATE_HOME/dsh-guarded-bot/secrets.env` (mesmo modo) | — |
| Cookie de sessão | `__Host-dsh_sid` | "`__Host-` + atributos" sem nome |
| Usuário do Basic Auth | `dsh` (fixo, não é segredo) | `ADMIN_USER`, `eu` |
| Var. de ambiente do token do bot | `TELEGRAM_BOT_TOKEN` | `DSH_TELEGRAM_BOT_TOKEN` |
| Var. de ambiente do chat do dono | `TELEGRAM_OWNER_CHAT_ID` | — |
| Var. de ambiente que libera teste de rede real | `DSH_GUARD_LIVE_TESTS=1` | — |
| Comandos do bot (`setMyCommands`, nesta ordem) | `/ligar`, `/desligar`, `/status`, `/acessar`, `/rotacionar`, `/parear <código>`, `/emergencia` | `/parar`, `/parar_bot`, `/desligar_servidor`, `/abrir_tunel`, `/vincular` |
| Nome do pacote npm | `dsh-guarded-bot-orchestrator` | — |
| Nome do plugin (`export const name`) | `dsh-guarded-bot-orchestrator` | — |
| `id` da entrada do plugin em `cordis.patch.yml` | `guarded-bot-orchestrator` | — |
| `id` do interceptor em `cordis.patch.yml` | `core-auth-interceptor` | — |
| `id` da entrada do servidor web (placeholder) | `<ID-DA-ENTRADA-DO-SERVIDOR-WEB-NESTA-INSTALACAO>` | — |
| Escopo de log | `guarded-bot` (`LOG_SCOPE`) | — |
| Chaves de config | `exposure.mode` (`'loopback' \| 'tunnel'`), `exposure.autoStart`, `exposure.trustEdgeHeaders`, `control.magicLink`, `control.stateDir`, `tunnel.mode` (`'quick' \| 'named'`), `tunnel.ttlMinutes`, `tunnel.tokenFile`, `tunnel.metricsPort` | — |
| Estados da máquina | `STOPPED \| STARTING \| READY \| DEGRADED \| STOPPING \| FAILED` (ver D7) | `DESLIGADO/INICIANDO/ONLINE/DEGRADADO/DESLIGANDO` em código, teste ou IPC |
| Docs de usuário | `docs/INSTALL.md`, `docs/THREAT-MODEL.md`, `docs/EXPOSURE.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/COMPATIBILITY.md` (**gerado**), `docs/ONBOARDING-TELEGRAM.md`, `docs/TUNNEL.md`, `docs/TROUBLESHOOTING.md`, `docs/PROIBIDO.md` | `docs/onboarding-telegram.md`, `docs/seguranca.md`, `docs/tunnel.md`, `docs/troubleshooting.md`, `docs/compat.md`, `docs/user/**`, `docs/divulgacao/PROIBIDO.md` |
| GIF de demo | `docs/assets/demo.gif`, ≤20 s, ≤4 MB | `docs/demo.gif`, ≤15 s / ≤3 MB |
| Dublê do cloudflared | `test/bin/fake-cloudflared.mjs` | `scripts/e2e/shared/fake-cloudflared.mjs` |
| Diretório de dublês | `test/support/**` | `test/helpers/**` |

Notas que valem como decisão:
- `docs/seguranca.md` de 07 é absorvido por `docs/THREAT-MODEL.md` + `docs/EXPOSURE.md`.
- `docs/COMPATIBILITY.md` é **gerado** por `scripts/gen-compat-table.mjs` a partir do resultado do
  `dsh-compat.yml`. O ritual mensal de `07-COMUNIDADE.md` §13.6 atualiza a **fonte** (roda o
  workflow), **nunca** o arquivo à mão. Editar `docs/COMPATIBILITY.md` manualmente é violação.
- `/start` continua existindo como gatilho de boas-vindas do Telegram, **sem efeito** e sem
  aparecer em `setMyCommands`; ele não pareia ninguém (ver D8).

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `01-ARQUITETURA.md` | §3(e), texto após a tabela | `POST /__guard/tunnel/up` | `POST /__guard/api/tunnel/start` |
| `01-ARQUITETURA.md` | §9.4 / §6 | `/parar_bot`, `/emergencia` | vocabulário de D5 (`/desligar`, `/emergencia`; "parar o worker do bot" é o `/emergencia` documentado) |
| `02-SEGURANCA.md` | §5.3, §L8, §4.3, §L6 | `/parar`, `/desligar_servidor`, `/abrir_tunel` | `/desligar`, `/ligar` |
| `02-SEGURANCA.md` | §7.2 passo 1 | `$DSH_TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` |
| `02-SEGURANCA.md` | §5.3 diagrama | `/__gate/magic` | `/__guard/magic` |
| `03-ONDAS.md` | T2.2 | `POST /__guard/login` | `POST /__guard/api/login`; e a rota sai dos entregáveis de T2.2 (ver D28) |
| `04-TESTES.md` | §5 (TG-*) | `/desligar` já correto; falta `/status`, `/acessar`, `/rotacionar`, `/parear`, `/emergencia` | acrescentar um caso por comando canônico e um caso que asserta que `setMyCommands` publica **exatamente** a lista de D5 |
| `06-REPO-E-CI.md` | §4.2 quickstart | `/vincular` | `/parear` |
| `06-REPO-E-CI.md` | §2 árvore de `docs/` | nomes atuais | acrescentar `ONBOARDING-TELEGRAM.md`, `TUNNEL.md`, `TROUBLESHOOTING.md`, `PROIBIDO.md`, `assets/demo.gif` |
| `07-COMUNIDADE.md` | §4.3, §13.6, §12.1 | `docs/onboarding-telegram.md`, `seguranca.md`, `tunnel.md`, `troubleshooting.md`, `compat.md` | os nomes de D5, e o ritual mensal roda o workflow em vez de editar `COMPATIBILITY.md` |
| `03-ONDAS.md` | T7.4 | `docs/divulgacao/PROIBIDO.md` | `docs/PROIBIDO.md` |

---

## D6 · MODO DO TÚNEL E TTL

**Conflito.** Todos recomendam quick como default; só `02-SEGURANCA.md` impõe TTL obrigatório
(default 60 min, teto 8 h) e controles de named tunnel como critério de aceite; `03-ONDAS.md` não
tem sub-tarefa para nenhum dos dois e lista named+Access entre os itens adiados; `07-COMUNIDADE.md`
anuncia named+Access como roadmap; `04-TESTES.md` já testa `--token-file` (TUN-014).

**DECISÃO — modo.** `tunnel.mode` tem dois valores e ambos existem na v0.1:
- `'quick'` — **default**, é o único com onboarding automatizado, e é o único que o README promete.
- `'named'` — **suportado como transporte**: `tunnel.tokenFile` entregue por `--token-file` (nunca
  `--token` em argv), sem onboarding automatizado; o usuário configura conta, domínio e política de
  Access **fora do plugin**.
- A **validação do header `Cf-Access-Jwt-Assertion`** (`kid`, `iss`, `aud`, `exp`) é **adiada para
  v0.2** e vira item de roadmap declarado. Adiá-la não enfraquece a linha de base porque **L4 (o
  portão de credencial) continua obrigatório no Modo B** — não existe, e nunca vai existir, flag
  "tenho Access, dispensa senha".

**DECISÃO — TTL.** `tunnel.ttlMinutes` é **obrigatório** no Modo A: default `60`, teto `480`,
`0`/ausente é config inválida recusada no load (*fail loud*). Ao expirar: derruba o túnel, invalida
**todas** as sessões emitidas e avisa no Telegram. Dono: **T3.1**, arquivo `src/tunnel/ttl.ts`,
testes `TUN-016…TUN-019` com relógio injetado (`test/support/clock.ts`). **Sim, vale como critério
de aceite da Onda 3** — sem isso a Onda 3 fecha verde violando o checklist §10.2 de 02.

**Justificativa.** `02-SEGURANCA.md` é normativo e o TTL é o controle que limita a janela de
exposição, que é a variável que mais importa num quick tunnel público. Já a validação do JWT do
Access é defesa em profundidade sobre uma borda que o usuário configura sozinho: adiá-la é honesto
e mantém 02, 03, 04 e 07 dizendo a mesma coisa.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | §8, T3.1 (entrega) | sem TTL | acrescentar: "TTL do túnel (`src/tunnel/ttl.ts`): default 60 min, teto 480, `0`/ausente inválido; expirar derruba o túnel e invalida sessões" e o arquivo na coluna de arquivos exclusivos |
| `03-ONDAS.md` | §8, aceite da Onda 3 | sem item de TTL | acrescentar: "Teste com relógio injetado prova que, expirado o `ttlMinutes`, o processo do cloudflared morre e toda sessão emitida deixa de autenticar" |
| `03-ONDAS.md` | §19 "itens adiados" | "Named tunnel + Cloudflare Access como caminho padrão" | "**Validação do `Cf-Access-Jwt-Assertion`** e onboarding automatizado de named tunnel. O transporte named (`tunnel.mode: 'named'` + `--token-file`) **está na v0.1**" |
| `03-ONDAS.md` | PREP 3 | "a decisão de modo (quick vs named) registrada com base no resultado de S3" | "modo default `quick` já decidido em `09-DECISOES-CANONICAS.md` D6; o PREP 3 apenas congela `tunnel.mode` no contrato. S3 é relatório de T0.2 e não bloqueia o prep" |
| `02-SEGURANCA.md` | §10.2 | "Modo B valida `Cf-Access-Jwt-Assertion` … `exp`" como item de aceite | mover para uma subseção "Roadmap v0.2" do mesmo §10.2, marcada como **fora do aceite da v0.1** |
| `07-COMUNIDADE.md` | §9.6, §12.2 | "named+Access está no roadmap" (tudo) | "o **transporte** named tunnel está na v0.1; a **validação do JWT do Access** é roadmap v0.2" |
| `04-TESTES.md` | TUN-014 | mantém | mantém; acrescentar TUN-016…TUN-019 (TTL) e TUN-020…TUN-023 (probe, D11) |

---

## D7 · VOCABULÁRIO DA MÁQUINA DE ESTADOS

**Conflito.** `01-ARQUITETURA.md` §6 e `04-TESTES.md` usam
`DESLIGADO/INICIANDO/ONLINE/DEGRADADO/DESLIGANDO`; `03-ONDAS.md` PREP 3 e §10 congelam
`STOPPED | STARTING | READY | STOPPING | FAILED`, **sem `DEGRADED`**.

**DECISÃO.** Vale o vocabulário já congelado em `01-ARQUITETURA.md` §6: **seis estados, em inglês**:

`STOPPED | STARTING | READY | DEGRADED | STOPPING | FAILED`

`DEGRADED` = falhou **e** ainda há orçamento: re-tenta sozinho com backoff. `FAILED` = terminal
(orçamento esgotado, `ENOENT`, `EACCES`, config inválida): só sai com `reset()` humano. Os rótulos
em português existem **apenas como texto de UI** e nunca aparecem em código, teste ou payload IPC.

**Justificativa.** `DEGRADED` é usado por transições que o próprio 03 descreve (backoff, orçamento
esgotado) e por casos de teste já nomeados (CTL-008, TG-044, M4); o contrato de 03 nasceria sem um
estado que o resto do plano exige. Inglês porque é o enum de código e de protocolo.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | PREP 3 (§8) | `TunnelState (STOPPED \| STARTING \| READY \| STOPPING \| FAILED)` | `TunnelState (STOPPED \| STARTING \| READY \| DEGRADED \| STOPPING \| FAILED)` |
| `03-ONDAS.md` | §10, diagrama ASCII | 5 caixas | acrescentar `DEGRADED` entre `STARTING`/`READY` e `FAILED`, com as arestas de `01-ARQUITETURA.md` §6 |
| `04-TESTES.md` | §5.5 e casos CTL-*, TG-*, M2, M4 | `DESLIGADO/INICIANDO/ONLINE/DEGRADADO/DESLIGANDO` | os seis nomes em inglês |
| `01-ARQUITETURA.md` | §6, "O que é persistido" | `desiredState` com valores `ONLINE`/`DESLIGADO` no texto | `READY`/`STOPPED` |

---

## D8 · PAREAMENTO DO DONO NO TELEGRAM

**Conflito.** `02-SEGURANCA.md` §7.2 exige código de pareamento de 6 dígitos exibido só no
terminal; `01-ARQUITETURA.md` §9.5, `03-ONDAS.md` T4.1 e `04-TESTES.md` (TG-063…065, M1) descrevem
`/start` do dono + `getUpdates` → `chat.id` + confirmação humana — exatamente a corrida que 02
chama de anti-padrão.

**DECISÃO.** Vale `02-SEGURANCA.md` §7.2, integralmente e nos 7 passos. `getUpdates` é apenas o
**transporte** que traz a mensagem `/parear 123456`; `from.id` e `chat.id` são lidos **do update que
carrega o código correto**, nunca do primeiro `/start` que chegar. Segundo `/parear` é recusado;
reabrir exige `--reset-pairing` **na máquina**. `/start` responde uma mensagem de boas-vindas
inócua e não pareia ninguém.

**Justificativa.** É um controle de segurança com ameaça nomeada (T4). "O primeiro que der `/start`
vira dono" é uma corrida que o atacante ganha se o username do bot for previsível; o código de 6
dígitos amarra a identidade do Telegram à posse do terminal, que é a raiz de confiança real.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | §9, T4.1 (entrega) | fluxo `/start` + `getUpdates` | os 7 passos de `02-SEGURANCA.md` §7.2; acrescentar `src/telegram/pairing.ts` aos arquivos exclusivos de T4.1 |
| `03-ONDAS.md` | §9, T4.4 (entrega) | — | acrescentar `worker/auth/pairing.ts` (recepção de `/parear`, recusa do segundo) |
| `01-ARQUITETURA.md` | §9.5 | `/start` do dono + `getUpdates` + confirmação humana | código de pareamento de 6 dígitos, TTL 5 min, exibido só no terminal/painel local (a tabela de estados de §9.5 já cita `TOKEN_OK_SEM_DONO`: alinhar o resto do texto a ela) |
| `04-TESTES.md` | TG-063…065, M1 | pareamento por `/start` | pareamento por código: código errado não pareia; código expirado não pareia; segundo `/parear` recusado; `/start` de estranho não vira dono |

---

## D9 · RATE LIMIT, LOCKOUT E MODO RESTRITO

**Conflito.** `02-SEGURANCA.md` §6.1 exige **sempre 401 genérico**, corpo idêntico, custo
constante, sem revelar ban; `04-TESTES.md` RL-005/RL-011 exigem que após 15 falhas a resposta passe
a `429` com `Retry-After`. `02-SEGURANCA.md` §6.1/§10.4 exige **modo restrito** aos 100 (túnel
derrubado, só loopback, persistido); `04-TESTES.md` RL-008 testa só "alerta, nunca lockout".

**DECISÃO.** Vale `02-SEGURANCA.md` nos dois pontos.
1. **Toda** resposta de falha de autenticação é `401` com corpo **idêntico**, sem `Retry-After`, sem
   distinguir ban de senha errada. O ban se manifesta como **atraso interno**, com custo de código
   aproximadamente constante. `429` está proibido no caminho de autenticação (continua válido para
   o tratamento do `retry_after` **do Telegram**, que é outra coisa).
2. Aos **100 falhas consecutivas**: entra em **modo restrito** — o gate deixa de aceitar credencial
   pelo túnel, aceita só loopback, o **túnel é derrubado**, o bot avisa, e o modo **persiste no
   `state.json` entre reinícios**. Não é lockout permanente e não há auto-DoS: o dono recupera indo
   à máquina.

**Justificativa.** `429 + Retry-After` é literalmente o oráculo que 02 §6.1 proíbe: revela ao
atacante que ele foi detectado e qual é a janela. E testar só a metade "alerta" do requisito dos 100
deixa sem cobertura justamente a parte que **é** o controle: derrubar a exposição e persistir.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `04-TESTES.md` | RL-005, RL-011 | "após 15 falhas a resposta passa a 429 com Retry-After" | "após 15 falhas a resposta continua sendo **401 idêntico**; o efeito do ban é atraso interno. O teste asserta corpo e headers **byte a byte iguais** ao 401 de senha errada e ausência de `Retry-After`" |
| `04-TESTES.md` | RL-008 | "alerta de auditoria emitido, mas nunca lockout permanente" | "aos 100: modo restrito ativo; `pgrep -f cloudflared` vazio; requisição pela URL pública falha; requisição de loopback com credencial correta passa; após restart do plugin o modo restrito **continua ativo** (lido do `state.json`)" |
| `03-ONDAS.md` | §7, T2.3 | sem modo restrito | acrescentar `src/ratelimit/restricted.ts` aos arquivos exclusivos e o modo restrito à entrega |

---

## D10 · `cloudflared` REAL: `e2e` OFFLINE × `live` MANUAL

**Conflito.** `03-ONDAS.md` (aceite da Onda 3 e T6.1) exige "teste que sobe um `cloudflared`
**real**"; `04-TESTES.md` §5.4.1 afirma que **nenhum** teste automatizado invoca o cloudflared real
e §12.2 põe túnel real só no roteiro manual M2; `06-REPO-E-CI.md` §6.4 põe e2e em
`workflow_dispatch`. Além disso "e2e" significa coisas opostas em 04 e 06.

**DECISÃO.** Dois níveis com nomes distintos, e a palavra "e2e" passa a ter um significado só:
- **`e2e`** = `test/e2e/**`, **offline**, só dublês (`test/bin/fake-cloudflared.mjs`,
  `test/support/telegram-server.ts`), roda em `ubuntu-latest`, **bloqueia PR**.
- **`live`** = `test/live/**`, **rede real** (quick tunnel de verdade), opt-in por
  `DSH_GUARD_LIVE_TESTS=1`, `workflow_dispatch` apenas, **nunca** em PR, nunca no gate.

O aceite da Onda 3 troca "cloudflared real" por `fake-cloudflared` + o roteiro manual **M2**.

**Justificativa.** Subir quick tunnel em CI publica na internet o que estiver na porta — a própria
pesquisa registra que isso expôs o DSH real do usuário por ~40 s. E, como está, o gate da Onda 3
exige exatamente o que a Onda 6 (T6.1 Q3) proíbe.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | §8, aceite da Onda 3, 1º item | "Teste que sobe um `cloudflared` **real** …" | "Teste que sobe o `test/bin/fake-cloudflared.mjs`, extrai a URL pelos **dois** caminhos (`/quicktunnel` e regex em stderr) e derruba, com `pgrep -f fake-cloudflared` vazio. O túnel **real** é exercitado só pelo roteiro manual **M2** e por `test/live/**`" |
| `03-ONDAS.md` | §8, aceite da Onda 3, 2º item | "prova 401 na URL pública" | "prova 401 pela URL do túnel **falso**; a prova pela URL pública real é item do roteiro manual M2" |
| `03-ONDAS.md` | §11, T6.1 | "e2e túnel real" | "e2e túnel com dublê (`test/e2e/**`) + suíte `test/live/**` marcada `workflow_dispatch`" |
| `04-TESTES.md` | §2, §12.1 | "e2e = processos locais + fake-cloudflared, offline, bloqueia PR" | mantém; acrescentar o nível `live` com a definição de D10 |
| `06-REPO-E-CI.md` | §2, §6.4 | "`e2e` = túnel real, opt-in, workflow_dispatch" | "`e2e` = offline, bloqueia PR (job `test-e2e`); `live` = túnel real, `workflow_dispatch`, `DSH_GUARD_LIVE_TESTS=1` (workflow `live.yml`)" |

---

## D11 · PROBE FAIL-CLOSED ANTES DE SUBIR O TÚNEL

**Conflito.** `02-SEGURANCA.md` §L1 exige probe de **quatro** superfícies anônimas, todas devendo
devolver 401, e qualquer `200` aborta a subida; `01-ARQUITETURA.md` §7.1, `03-ONDAS.md` T3.2 e
`04-TESTES.md` TUN-012 definem readiness como "a aplicação responde". `02-SEGURANCA.md` §10.2 ainda
tem a versão antiga de uma sonda só.

**DECISÃO.** Vale a versão de quatro sondas de `02-SEGURANCA.md` §L1, e ela é **pré-condição da
transição `STOPPED → STARTING`**, não readiness:

| # | Sonda (anônima, contra `127.0.0.1:<porta>`) | Esperado |
| - | --- | --- |
| 1 | `GET /` (fallback da SPA) | 401 |
| 2 | `POST /api/<rpc de leitura>` com corpo vazio | 401 |
| 3 | `GET /` com `Upgrade: websocket` + `Connection: Upgrade` | socket destruído ou 401 |
| 4 | `GET /__guard/probe-canary-<aleatório>` (fora de `guardedPrefixes`) | 401 |

Qualquer `200`, ou a sonda 4 devolvendo 404 sem passar pelo gate, significa **gate não armado**: o
túnel não sobe, o estado vai para `FAILED` e a mensagem ao dono diz **qual** sonda falhou. Dono:
**T3.1**, arquivo `src/tunnel/probe.ts`, testes `TUN-020…TUN-023`. `readiness.ts` (T3.2) continua
existindo, mas é outra coisa: mede quando a URL do túnel está utilizável, **depois** do probe.

**Justificativa.** "Responde" e "está com o gate armado" são coisas diferentes, e a diferença é
precisamente o que expôs o DSH real na pesquisa. O modo de falha real é **ordem de carregamento**:
`/` vem do `registerFallback` de `@deepseek-ai/dsh-host-frontend-static` e `/api` vem de outro
registro — provar `/` não prova `/api`.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | §8, T3.1 | sem probe | acrescentar `src/tunnel/probe.ts` aos arquivos exclusivos e as 4 sondas à entrega |
| `03-ONDAS.md` | §8, aceite da Onda 3 | — | acrescentar: "teste que, com o gate desarmado artificialmente, prova que o túnel **não sobe** e o estado vai para `FAILED` nomeando a sonda" |
| `01-ARQUITETURA.md` | §7.1 | "probe local responde" | "probe fail-closed de 4 superfícies (`02-SEGURANCA.md` §L1); readiness é etapa posterior" |
| `04-TESTES.md` | TUN-012 | "aplicação responde" | probe de 4 sondas; acrescentar TUN-020…TUN-023, uma por sonda |
| `02-SEGURANCA.md` | §10.2, 1º item | "Túnel não sobe se o probe anônimo em `/` não devolver 401" | "Túnel não sobe se **qualquer uma das 4 sondas** de §L1 falhar; a mensagem ao dono nomeia a sonda" |

---

## D12 · MATRIZ DE NODE

**Conflito.** `03-ONDAS.md` T1.2, `04-TESTES.md` §12.1, `07-COMUNIDADE.md` §13 e
`08-PESQUISA-E-FONTES.md` §5.2 usam matriz 22/24/26; `06-REPO-E-CI.md` §6.2 exclui 22 e usa
24/26 + 1 macOS.

**DECISÃO.** Matriz canônica: **`ubuntu-latest` × Node 24**, **`ubuntu-latest` × Node 26**,
**`macos-latest` × Node 24**. Node 22 fica fora. Windows fica fora
(`"os": ["linux", "darwin"]`). A justificativa escrita passa a ser **apenas** `engines: node >=24`
— a afirmação sobre "type stripping estável no 25.2 / flag removida no 26" não pode ser usada como
razão enquanto o spike da Onda 0 não fechar (ver D26).

**Justificativa.** Testar em 22 um pacote que declara `>=24` não é cobertura, é ruído; e `>=24` já
é citado por 02, 03 e 04.

**O que precisa mudar:** `03-ONDAS.md` T1.2, `04-TESTES.md` §12.1, `07-COMUNIDADE.md` §13 e
`08-PESQUISA-E-FONTES.md` §5.2: `22/24/26` → `24 (ubuntu), 26 (ubuntu), 24 (macos)`.
`06-REPO-E-CI.md` §6.2: manter a matriz, trocar a justificativa da linha 26.x de "a flag de type
stripping foi removida nela" para "vira LTS em 28/10/2026; entra para pegar quebra cedo".

---

## D13 · CONTEÚDO DO TARBALL npm

**Conflito.** `06-REPO-E-CI.md` §8.3 define `files` = `dist`, `cordis.patch.yml`, `README.md`,
`LICENSE`, `CHANGELOG.md` (com `src/` e `types/` **fora**, por razão técnica); `04-TESTES.md` §10
item 4 testa que o tarball contém `dist/`, `src/`, `types/`, `cordis.patch.yml`, `README.md`.

**DECISÃO.** Vale `06-REPO-E-CI.md` §8.3. `files` canônico:

```jsonc
"files": ["dist", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md"]
```

`dist/` contém `dist/index.js`, `dist/index.d.ts` **e** `dist/worker/telegram-bot.js` (D2).
`scripts/check-tarball.mjs` falha se faltar qualquer um desses quatro ou o `cordis.patch.yml`, **ou**
se aparecer qualquer coisa sob `docs/`, `test/`, `src/`, `types/` ou `.env`.

**Justificativa.** `src/` publicado é inútil dentro de `node_modules` (o Node recusa type stripping
lá: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) e `types/` são shims de terceiros que podem
colidir no consumidor. O smoke de 04 falharia contra o pacote que 06 manda publicar.

**O que precisa mudar:** `04-TESTES.md` §10 item 4 → asserção invertida: o tarball **tem**
`dist/index.js`, `dist/index.d.ts`, `dist/worker/telegram-bot.js`, `cordis.patch.yml`, `LICENSE`,
`README.md`, `CHANGELOG.md` e **não tem** `src/`, `types/`, `test/`, `docs/`.
`package.json` do repositório: remover `"src"`, `"types"` e `"!types/__smoke__.ts"` de `files`.

---

## D14 · JOBS OBRIGATÓRIOS DE CI

**Conflito.** `04-TESTES.md` §12.1 exige `test-security` e `coverage` bloqueando merge;
`06-REPO-E-CI.md` §6.5 lista required checks sem nenhum dos dois.

**DECISÃO.** `06-REPO-E-CI.md` é o dono da forma (`ci.yml` e branch protection); `04-TESTES.md` é o
dono do conteúdo. Lista canônica de **required status checks** em `master`:

`lint`, `typecheck`, `build`, `test (ubuntu-latest, 24)`, `test (ubuntu-latest, 26)`,
`test (macos-latest, 24)`, `test-contract`, `test-security`, `test-e2e`, `coverage`, `changeset`,
`secrets-scan`.

**Não** são required: `dsh-compat` (nightly, depende de rede — falha abre issue), `live` (rede
real, `workflow_dispatch`), `scorecard`, `codeql`, `example-smoke` (informativo até a Onda 7).

**Justificativa.** A suíte adversarial de segurança é o núcleo do produto: um PR que a quebre não
pode entrar. A catraca de cobertura protege exatamente os módulos de decisão de segurança.

**O que precisa mudar:** `06-REPO-E-CI.md` §6.5 → a lista acima; §6.3 `ci.yml` ganha os jobs
`test-contract`, `test-security`, `test-e2e` e `coverage`. `04-TESTES.md` §12.1 → adotar os nomes
de job acima, literais, para que casem com os required checks.

---

## D15 · DUBLÊS, LAYOUT DE `test/` E QUEM CONGELA

**Conflito.** `04-TESTES.md` §3.2 usa `test/support/**` e `test/bin/fake-cloudflared.mjs`;
`03-ONDAS.md` congela `test/helpers/**` e `scripts/e2e/shared/fake-cloudflared.mjs` no **PREP 6** —
e o próprio 03 já cita `test/support/**` no PREP 2, contradizendo a si mesmo. Pior: o PREP 6
manda migrar "os dublês que já existem dentro do `test/index.test.ts` atual", arquivo que T1.1
dissolve na Onda 1.

**DECISÃO.**
- Diretório canônico: **`test/support/**`**. `test/helpers/**` está morto.
- Dublê do cloudflared: **`test/bin/fake-cloudflared.mjs`**, caminho único.
- Congelamento no **COMMIT PREP 2**, não no 6: `test/support/{clock,ctx-double,child-double,telegram-server,state-dir}.ts`
  e `test/bin/fake-cloudflared.mjs` nascem no PREP 2, **antes** de a Onda 2 escrever o primeiro
  teste. Os dublês vêm do `test/index.test.ts` **pré-dissolução**, extraídos por T1.1 na Onda 1 e
  entregues ao PREP 2 — não do arquivo dissolvido.
- Layout de `test/` é o de D1, e a regra de propriedade é a regra derivada reescrita em D1.

**Justificativa.** Congelar o diretório de dublês quatro ondas depois de os testes começarem
garante quatro conjuntos divergentes e uma "migração sem alteração de comportamento" que na verdade
é reescrita. E o PREP 6 referencia um arquivo que não existe mais desde a Onda 1.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `03-ONDAS.md` | PREP 6 (§16 e §11) | congela `test/helpers/**` e `scripts/e2e/shared/fake-cloudflared.mjs`; migra dublês do `test/index.test.ts` | PREP 6 **não** congela diretório de dublês; passa a congelar só a lista fechada de 50 mutantes e a config de mutation (D16) |
| `03-ONDAS.md` | PREP 2 (§7) | "`test/support/**`" genérico | enumerar os 5 arquivos de `test/support/` + `test/bin/fake-cloudflared.mjs`, todos prep-owned e somente-leitura a partir da Onda 2 |
| `03-ONDAS.md` | §6, T1.1 (entrega) | — | acrescentar: "extrai os dublês do `test/index.test.ts` para o relatório de handoff do PREP 2 **antes** de dissolver o arquivo" |
| `04-TESTES.md` | §3.2 | `test/support/**` (já correto) | manter; declarar que `test/support/**` e `test/bin/**` são **prep-owned** e nenhuma sub-tarefa os edita |

---

## D16 · MUTATION TESTING

**Conflito.** `04-TESTES.md` §7.2/§13 faz de 50/50 mutantes mortos critério de aceite da Onda 6 e
recomenda trocar o runner para Vitest no núcleo puro; `03-ONDAS.md` Onda 6 quer score ≥60% em job
noturno com `break` desligado e proíbe trocar o runner. E a dependência do Stryker não tem dono: o
singleton `package.json` da Onda 6 é T6.2, mas quem precisa dela é T6.3.

**DECISÃO.**
- **Política (03 vence):** mutation testing roda em **job noturno separado**, `break` desligado,
  **não** bloqueia PR. O runner do projeto continua sendo `node:test`; **não** se introduz Vitest.
- **Conteúdo (04 vence):** a lista fechada de **50 mutantes** vira um **checklist manual** de
  revisão da Onda 6, com meta de 50/50, verificada por leitura e por teste dirigido — não por
  ferramenta bloqueante.
- **Dependência:** o singleton `package.json` da Onda 6 passa de **T6.2 para T6.3** (é ela que
  precisa do Stryker), e a ordem de merge da Onda 6 passa a ser
  `T6.1 → T6.2 → T6.4 → **T6.3**`. Se o spike de 1 h de T6.3 concluir que o Stryker não suporta
  `node:test` na versão da matriz, o item some do aceite e vira nota em `docs/TESTING.md`.

**Justificativa.** Critério declaradamente não bloqueante não é critério de aceite; e trocar o
runner do projeto inteiro por causa de uma ferramenta de qualidade secundária é custo
desproporcional numa Onda 6 que já é a mais pesada.

**O que precisa mudar:** `03-ONDAS.md` §11 (aceite da Onda 6) → remover "mutation score ≥60%" do
aceite e substituir por "checklist dos 50 mutantes de `04-TESTES.md` §7.2 revisado e assinado";
§4.1 tabela de singletons, coluna O6 → `T6.3`; §13.1 ordem da Onda 6 → `T6.1 → T6.2 → T6.4 → T6.3`.
`04-TESTES.md` §7.2/§13 → remover a recomendação de Vitest e a exigência de gate; manter os 50
mutantes como checklist.

---

## D17 · METAS DE COBERTURA

**Conflito.** `04-TESTES.md` §11.1 exige 95% linhas / 90% branches em `http/**`, `secret/**`,
`session/**`, `ratelimit/**`, `control/**`, com catraca; `03-ONDAS.md` aceita ≥90%/≥85% nos mesmos
módulos, sem catraca.

**DECISÃO.** Vale `04-TESTES.md`. Piso global (`test:cov`): 90% linhas / 85% branches / 95%
funções. Piso **por módulo de decisão de segurança** (`src/http/**`, `src/secret/**`,
`src/session/**`, `src/ratelimit/**`, `src/control/**`, `worker/auth/**`, `src/state/**`): **95%
linhas / 90% branches**, com **catraca** — o job `coverage` falha se o número cair em relação ao
valor commitado. `worker/auth/**` entra na lista por decisão de D2 (é onde vive a allowlist);
`src/state/**` entra porque é o **único writer** do `state.json` (D1, T2.5) e um branch não coberto
ali é estado corrompido em produção, não teste faltando.

**Justificativa.** 03 aceitaria como verde um módulo de decisão de segurança abaixo do piso que 04
define; num projeto cujo produto **é** o gate, o piso mais alto é o certo.

**O que precisa mudar:** `03-ONDAS.md` Onda 2 e Onda 6 → `≥90%/≥85%` nos módulos de segurança vira
`≥95%/≥90% com catraca`, citando D17. `04-TESTES.md` §11.1 → acrescentar `worker/auth/**` à lista.

---

## D18 · PINS E `peerDependencies`

**Conflito.** `05-QUALIDADE-CODIGO.md` §2 exige versões exatas, sem `^` e sem `~`, em
devDependencies **e** peerDependencies; `06-REPO-E-CI.md` §9.2/§11.2 usa
`"@deepseek-ai/cordis": ">=4.0.0 <5"` como peer, argumentando que pin exato transformaria cada rc
numa falha de instalação.

**DECISÃO.** Vale `06-REPO-E-CI.md` para peers, vale `05-QUALIDADE-CODIGO.md` para o resto:
- `peerDependencies`: faixa — `"@deepseek-ai/cordis": ">=4.0.0 <5"`, com
  `peerDependenciesMeta.optional: true`.
- `devDependencies`: **versões exatas**, sem `^` e sem `~`.
- `dependencies` (runtime): **versão exata** (ver D27).
- Os tarballs baixados por `scripts/fetch-dsh-types.mjs`: **exatos**, com `sha256` registrado.

**O que precisa mudar:** `05-QUALIDADE-CODIGO.md` §2 → restringir a regra de pin exato a
`devDependencies`, `dependencies` e ao `fetch-dsh-types.mjs`; declarar peers como faixa, com a
justificativa de 06 §11.2 copiada.

---

## D19 · `ADMIN_USER` / `ADMIN_PASS` SAEM

**Conflito.** `02-SEGURANCA.md` §8.2 regra 6 determina que o `cordis.patch.yml` deixe de derivar
credencial de `ADMIN_USER`/`ADMIN_PASS` via `!!js`, passando a ler o `state.json`;
`06-REPO-E-CI.md` §4.2 abre o quickstart do README com `export ADMIN_USER=eu` e §9.3 mantém "os
valores vêm de `!!js` lendo o ambiente, como já está".

**DECISÃO.** Vale `02-SEGURANCA.md`. A credencial é **gerada por CSPRNG pelo próprio plugin** e o
digest vive no `state.json`; `ADMIN_USER`/`ADMIN_PASS` deixam de existir no fluxo. O usuário do
Basic é fixo (`dsh`). O quickstart do README não exporta variável nenhuma de credencial.

Quickstart canônico do README:

```console
$ dsh plugin --profile web add dsh-guarded-bot-orchestrator
$ dsh web
[guarded-bot] senha gerada (aparece UMA vez): K7QF-2M9X-...-4TZP
[guarded-bot] bind 127.0.0.1:3080 — OK
[guarded-bot] túnel: https://xxxx-xxxx-xxxx-xxxx.trycloudflare.com
[guarded-bot] telegram: não configurado — rode /parear <código> no bot para ligar
```

O par `401`/`200` do `curl` contra `POST /api/commands/execute` **fica**: é a melhor prova de 5
segundos do README.

**O que precisa mudar:** `06-REPO-E-CI.md` §4.2 → o bloco acima; §9.3 regra 1 → "os valores de
credencial **não** vêm mais do ambiente por `!!js`; vêm do `state.json` gerenciado pelo plugin. O
`!!js` continua válido só para valores **não sensíveis** de configuração".
`cordis.patch.yml` (linhas 238 e 419) → tarefa de T1.3 / T3.3, conforme D28.

---

## D20 · TRÊS PLANOS DE ONDAS CONCORRENTES

**Conflito.** `03-ONDAS.md` (Ondas 0–7), `06-REPO-E-CI.md` §12 (R0–R4) e `07-COMUNIDADE.md` §5
(C0–C9) descrevem três sequenciamentos incompatíveis do mesmo trabalho.

**DECISÃO.** **`03-ONDAS.md` é o único plano de execução.** R0–R4 e C0–C9 deixam de ser ondas e
viram **sub-itens dentro das sub-tarefas de 03**, com este mapeamento literal:

| Onda externa | Passa a ser |
| --- | --- |
| C0 (desbloqueio de API) | Onda 0, T0.1 |
| R1 (verdade dos tipos) | Onda 0, T0.1 + Onda 1, T1.1 |
| R0 (fundação do repo) e C1 | Onda 1, T1.4 |
| R2 (qualidade e CI) | Onda 1, T1.2 |
| C3 (README/mensagem) e C4 (GIF) | Onda 7, T7.3 |
| R3 (release e publicação) e C2 (reserva do nome npm) | Onda 7, T7.2 (com a ressalva de D23) |
| C5–C8 (anúncios, registro, awesome-list) | **pós-T7.4**, fora do orquestrador: são ações humanas com terceiros |
| R4 (manutenção contínua) | pós-T7.4, ritual mensal documentado em `07-COMUNIDADE.md` §13.6 |

**O que precisa mudar:** `06-REPO-E-CI.md` §12 → substituir a seção por uma tabela de mapeamento
para as sub-tarefas de 03, com a frase "este documento **não** define ondas; a autoridade de
sequenciamento é `03-ONDAS.md`". `07-COMUNIDADE.md` §5 → idem.

---

## D21 · RESERVA DO NOME NO npm

**Conflito.** `06-REPO-E-CI.md` (Onda R0) e `07-COMUNIDADE.md` C2 querem reservar cedo;
`03-ONDAS.md` PREP 7 posterga para imediatamente antes da Onda 7.

**DECISÃO.** Reservar **cedo**: publicar `0.0.1` (stub documentado, sem código funcional) como
entrega de **T1.4**, na Onda 1. O risco real é name-squatting entre o anúncio e a publicação
(B5 de 07), e o custo de reservar é uma publicação de 2 minutos.

**O que precisa mudar:** `03-ONDAS.md` §6 T1.4 → acrescentar "publica `dsh-guarded-bot-orchestrator@0.0.1`
como stub documentado, para reservar o nome"; PREP 7 → remover "nome do pacote reservado no npm com
`0.0.1` stub" da lista de bloqueios (vira verificação, não entrega).

---

## D22 · GIF, BADGES E `examples/minimal/`

**GIF (C4 #29).** Vale `07-COMUNIDADE.md`: `docs/assets/demo.gif`, ≤20 s, ≤4 MB, com o roteiro de 5
cenas e a auditoria frame a frame por segredo. `06-REPO-E-CI.md` §4.1 ajusta caminho e limites.

**Badges (C4 #30).** Vale `06-REPO-E-CI.md`: 4 badges — CI, npm version, npm downloads, OpenSSF
Scorecard. **Sem** badge de licença (o GitHub já a exibe). `07-COMUNIDADE.md` §4.2 remove a linha.

**`examples/minimal/` (C4 #33).** Vale `07-COMUNIDADE.md` para o conteúdo: o diretório existe, com
critério de aceite `401` sem credencial / `200` com credencial e `pgrep` vazio ao fim. Dono:
**T7.3**. Job de CI `example-smoke`: dono **T7.2**, **não** required (D14). Acrescentar
`examples/minimal/**` à árvore de `06-REPO-E-CI.md` §2.

---

## D23 · DEPENDÊNCIA DE RUNTIME: grammY

**Conflito (não listado em C4, mas bloqueante).** `06-REPO-E-CI.md` §9.2 declara
`"dependencies": {}` — "ZERO, é argumento de venda e de supply chain" — enquanto 01, 02, 03, 04 e 08
escolhem **grammY** como biblioteca do bot, e `08-PESQUISA-E-FONTES.md` L23 flutua a hipótese de
escrever um cliente próprio da Bot API.

**DECISÃO.** **grammY é dependência de runtime**, com versão exata:

```jsonc
"dependencies": { "grammy": "1.45.1" }
```

A frase "zero dependências de runtime" **sai** do README, do `06-REPO-E-CI.md` §9.2/§10 e de
qualquer material de divulgação, no mesmo commit em que a dependência entra. O argumento de venda
passa a ser o correto e verificável: **uma** dependência de runtime, sem dependências transitivas
de rede além do `fetch` nativo, e `dependencies` do plugin **host** vazias — o grammY é carregado
apenas pelo processo `worker/`.

**Justificativa.** Cinco documentos desenham contra a API do grammY (auto-retry lendo `retry_after`,
`bot.catch` com `GrammyError`/`HttpError`, `apiRoot` para o dublê, `bot.start({drop_pending_updates})`).
Trocar isso por um cliente artesanal na Onda 4 é reescrever a parte mais chata da integração para
preservar um slogan. Se o cliente próprio for feito algum dia, é onda própria.

**O que precisa mudar:** `06-REPO-E-CI.md` §9.2 → `"dependencies": { "grammy": "1.45.1" }` e a nota
de "ZERO" reescrita; §10 → a política de supply chain passa a cobrir 1 dependência (Renovate com
regra própria para `grammy`); §4.1/§4.5 do README → remover "zero dependências".
`08-PESQUISA-E-FONTES.md` L23 → rebaixar de "decisão de dependência zero" para "hipótese não
adotada; ver `09-DECISOES-CANONICAS.md` D23".

---

## D24 · FATOS (alinhamento com `08-PESQUISA-E-FONTES.md`)

| # | Afirmação | DECISÃO | Muda em |
| --- | --- | --- | --- |
| 1 | "Access não pode ficar na frente de quick tunnel" | **Fato de Confiança Alta** (08 §1.3, §7.4, fato #8, com doc da Cloudflare). Pode ser usado como base de L0 | `04-TESTES.md` §14 item 5: remover "sem citação de doc oficial; validar antes de prometer" |
| 2 | `ctx.webServer` / tipo `WebServer` | **Refutados** (E2). Só podem aparecer em coluna "errado" | `05-QUALIDADE-CODIGO.md` §1.6 e §4.4: trocar `ctx.webServer.register`/`WebServer['register']` por `ctx.httpServer.register`/`HttpServerService['register']`. `src/index.ts`: é o refactor de T1.1 |
| 3 | Thresholds de cobertura do `node:test` | **Estáveis** por CLI; só a *coleta* (`--experimental-test-coverage`) segue experimental (08 §5.2 dá razão a 04) | `05-QUALIDADE-CODIGO.md` §12: remover o item 7 da lista de NÃO CONFIRMADOS |
| 4 | Hostnames do urlscan | **73** (08 é o ledger) | `02-SEGURANCA.md` §2.2: `72` → `73` |
| 5 | Estrelas da awesome-list | **Nenhum número absoluto vai para material público.** O texto usa "~10 mil ★, medido em <data>" e o ledger 08 §6 registra **uma** medição, com data e URL | `07-COMUNIDADE.md` §7.1 e `08-PESQUISA-E-FONTES.md` §6.1/§6.2: unificar numa linha só |
| 6 | "Type stripping estável no 25.2, flag removida no 26" | **Suposição.** Vira pergunta do spike T0.1 e sai do texto normativo até fechar | `04-TESTES.md` §3.1 e `06-REPO-E-CI.md` §6.2: remover a claim; a matriz de D12 se sustenta em `engines: >=24` |
| 7 | `AGENTS.md` do upstream como norma | **Conceitual, a confirmar na Onda 0 (T0.1)** — não é "condição de aceitação" | `05-QUALIDADE-CODIGO.md` §1: rebaixar de "não negociáveis" para "conceituais, a confirmar em T0.1", como o próprio 05 §12 já faz com `dsh-brand` e `tsx/esm` |

---

## D25 · CORREÇÕES ESTRUTURAIS DE `03-ONDAS.md` (executabilidade)

Estas são condições para o `deep-orchestrator` abrir as worktrees sem colisão. Todas em
`03-ONDAS.md`, todas literais.

**Posse de arquivo:**
1. §6, T1.3, coluna "arquivos exclusivos": **remover toda menção a `package.json`**. O bloco `dsh`
   vira linha de handoff: "entrega o bloco `dsh` como texto no relatório, para T1.2 aplicar".
2. §6, T1.1, coluna "arquivos exclusivos": `src/**` → `src/** exceto src/contracts/**`; `test/**` →
   `test/** exceto test/support/** e test/bin/**`.
3. §6: `README.md` passa a ser arquivo exclusivo de **T1.4** na Onda 1 (T1.3 não pode editá-lo);
   na Onda 7 continua sendo de T7.3. Acrescentar `README.md` à tabela de singletons §4.1.
4. §9, T4.3: acrescentar `test/unit/proc/**` e `test/integration/proc/**` aos arquivos exclusivos
   (T4.3 muda o `stdio` de `src/proc/supervisor.ts` e hoje não pode tocar o teste dele).
5. §8, T3.3: acrescentar `test/unit/config/**` (T3.3 amplia `Config` e hoje o teste não tem dono).
6. §5, T0.1: acrescentar `test/contract/**` aos arquivos exclusivos, e `CONTRACT-001…009` verdes ao
   aceite da Onda 0.
7. §7, T2.2: **remover a entrega de rota HTTP**. T2.2 entrega o `SessionStore` puro (coerente com
   "Onda 2 = primitivas sem fiação"); `POST /__guard/api/login` é entrega de **T3.4**.
8. §10, T5.4: acrescentar a posse do gancho de emissão do evento "primeiro acesso não reconhecido"
   — `src/audit/events.ts` já é dela; o ponto de chamada em `src/http/gate.ts` é **congelado no
   PREP 5** como assinatura de evento, e T5.4 só implementa o consumidor.
9. §4.1: acrescentar linhas de singleton para `.github/workflows/**` (O1 = T1.2, O7 = T7.2),
   `README.md` (O1 = T1.4, O7 = T7.3) e `worker/**` (O4 = subdiretórios disjuntos, O5 = T5.2).
10. §7, T2.4: trocar o glob negativo `src/audit/** (exceto notify.ts/events.ts)` por enumeração
    positiva: `src/audit/log.ts`, `src/audit/format.ts`.

**Dependências e preps:**
11. §10, T5.2 e T5.3: coluna "depende de" — `contrato de T5.1` → `PREP 5`.
12. §12, T7.2 e T7.4: `contrato de T7.1` / `contrato de T7.3` → **PREP 7**, que passa a congelar
    `exports` + `repository` do `package.json` e o texto-base do README.
13. §6, T1.2: declarar a aresta de handoff `T1.3 → T1.2` (bloco `dsh`) na coluna "depende de".
14. §16, PREP 0: **remover** `remote origin` como pré-requisito da Onda 0 — `git worktree` não
    exige remote (verificado). O remote passa a ser pré-requisito do **PREP 7** (publicação).
15. §16, PREP 1: acrescentar "reconciliação do prefixo de rota concluída: `/__guard` em todos os
    documentos" — hoje está no PREP 5, quatro ondas depois de as rotas nascerem. Remover o item do
    PREP 5.
16. §16, PREP 2: passa a congelar `test/support/**` e `test/bin/fake-cloudflared.mjs` (D15) e
    `src/contracts/state.ts` (D1).

**Aceite objetivo:**
17. Onda 0: trocar os 3 critérios não executáveis por comandos: `pnpm typecheck`;
    `git status --porcelain` vazio; `test -s docs/spikes/api-dsh.md`; e
    `! grep -rniE 'provavelmente|deve ser|acredito' docs/spikes/`.
18. Onda 1: `~400 linhas` → **400 linhas exatas**, com o comando
    `find src worker test -name '*.ts' -exec wc -l {} + | awk '$2!="total" && $1>400 {print; f=1} END{exit f}'`
    (sai 0 quando nenhum arquivo passa de 400; imprime os infratores quando falha).
19. Onda 2: `pnpm ls --prod --depth 0 inalterado` → comparar com o snapshot
    `docs/spikes/deps-baseline.txt`, commitado pelo PREP 2.
20. Onda 7: "revisor tenta achar uma afirmação não sustentada" → "toda afirmação numérica do README
    e do material de divulgação tem uma linha correspondente em `08-PESQUISA-E-FONTES.md` §8, com
    URL e data; o revisor lista as que não têm". E escrever como **invariante** que cada COMMIT PREP
    é um commit separado (já é a regra §0.4), que é o que garante o piso de ≥10 commits.

**Ordem de merge (§13.1):**
21. Onda 2: `qualquer ordem` → `T2.5 → T2.1 → T2.2 → T2.3 → T2.4` (a Onda 2 tem **cinco**
    sub-tarefas; a tabela hoje lista quatro).
22. Onda 6: `T6.3 → T6.4 → T6.1 → T6.2` → `T6.1 → T6.2 → T6.4 → T6.3` (D16 move o singleton para
    T6.3).
23. Onda 7: `T7.3 → T7.4 → T7.1 → T7.2` → `T7.3 → T7.4 → T7.2 → T7.1`, com handoff explícito
    T7.2 → T7.1: T7.2 entrega `.changeset/**` e `release.yml`, e **T7.1** (singleton) acrescenta
    `@changesets/cli` a `devDependencies` e o script `changeset`. T7.2 não escreve `package.json`.

**Convenção de caminho:**
24. Substituir em todo o 03: `test/http/**` → `test/unit/http/**` (+ `test/integration/http/**`),
    `test/proc/**` → `test/unit/proc/**`, `test/tunnel/**` → `test/unit/tunnel/**`,
    `test/panel/**` → `test/unit/panel/**`, `test/control/**` → `test/unit/control/**`,
    `test/audit/**` → `test/unit/audit/**`, `test/session/**` → `test/unit/session/**`,
    `test/worker/**` → `test/unit/worker/**`, `test/e2e/tunnel/**` → `test/e2e/**`.
25. `04-TESTES.md`: `test/e2e/tree-kill-real.test.ts` → `test/live/tree-kill-real.test.ts` **se**
    depender de processos reais em rede; se for só processo local, permanece em `test/e2e/`. Decisão:
    **permanece em `test/e2e/`** (processos locais, offline) e ganha dono: **T6.4**.

---

## D26 · TYPE STRIPPING DO NODE — REMISSÃO

**Estado.** `D26` é citada por outros documentos (e por `09` §D6) como se fosse seção própria. Ela
não é uma decisão nova: é **exatamente o item 6 de D24**.

**DECISÃO (repetida aqui para que a referência resolva).** A afirmação *"type stripping estável no
Node 25.2, flag removida no 26"* é **suposição não verificada**. Ela sai de todo texto normativo,
vira **pergunta do spike S1 (T0.1)** e só volta como fato se o veredito for `CONFIRMADO`. A matriz
de Node de D12 não depende dela: sustenta-se em `engines: ">=24"` mais o build `tsc`. Qualquer
documento que use type stripping como premissa de execução de `.ts` em teste ou em runtime está em
violação até o spike fechar. Ver também `08-PESQUISA-E-FONTES.md` §5.3.

---

## D27 · PINS DE `dependencies` — REMISSÃO

**Estado.** `D27` é citada por D18 e por `06-REPO-E-CI.md`. Não é decisão nova: é a conjunção de
**D18** (política de pins) com **D23** (grammY é dependência de runtime).

**DECISÃO (repetida para que a referência resolva).** Em `dependencies` (runtime) a versão é
**exata**, sem `^` e sem `~`: `"grammy": "1.45.1"`. Em `devDependencies` e nos tarballs de tipos
baixados por `scripts/fetch-dsh-types.mjs`, também **exata**. Em `peerDependencies` a versão é
**faixa**: `"@deepseek-ai/cordis": ">=4.0.0 <5"`, com `peerDependenciesMeta.optional: true`. O
`pnpm-lock.yaml` é commitado e é parte do gate. Bump de pin exato é PR próprio, nunca carona.

---

## D28 · CORREÇÕES ESTRUTURAIS DE `03-ONDAS.md` — REMISSÃO

**Estado.** `D28` é citada por D1 (§4.1, singletons) e por D5 (rota de T2.2). Não é decisão nova:
é **D25 inteira**.

**DECISÃO (repetida para que a referência resolva).** Toda menção a `D28` neste ou em qualquer
outro documento deve ser lida como **`D25`**. Os três pontos concretos que as remissões cobram:

1. `03-ONDAS.md` §4.1 ganha linhas de singleton para `.github/workflows/**` (T1.2 na Onda 1, T7.2
   na Onda 7), `README.md` (T1.4 na Onda 1, T7.3 na Onda 7) e `worker/**` (T1.1 na Onda 1, T4.2 na
   Onda 4) — **aplicado**.
2. `POST /__guard/api/login` sai dos entregáveis de T2.2 e migra para T3.4 — **aplicado**.
3. As linhas 238 e 419 do `cordis.patch.yml` viram tarefa de T1.3 / T3.3 — **aplicado**.

---

## D29 · `start` DURANTE `STOPPING`: REJEITAR, NÃO ENFILEIRAR

**Conflito.** `01-ARQUITETURA.md` §9.2 fixa que `tunnel.up` recebido no estado `STOPPING` é
**`rejected`** com código `SHUTDOWN_IN_PROGRESS`. `04-TESTES.md` CTL-007 (versão anterior) dizia
"intenção enfileirada; ao concluir reconcilia para `STARTING`". Os dois não podem valer.

**DECISÃO.** Vale `01-ARQUITETURA.md` §9.2: **`rejected`**, com o código de erro
`SHUTDOWN_IN_PROGRESS`, e nenhuma fila.

**Justificativa (é de segurança, não de estilo).** Enfileirar um `start` durante o desligamento
transforma o kill switch numa operação com resultado incerto: o usuário manda `/emergencia`, vê o
túnel cair, e o túnel **volta sozinho** porque havia um `start` na fila. Todo controle temporal
deste plano (TTL, modo restrito, invalidação de sessão) pressupõe que derrubar a exposição é
terminal até uma nova ação explícita do dono. Rejeitar é a opção fail-closed; enfileirar é
fail-open. O custo é uma mensagem a mais para o usuário ("desligando; mande `/ligar` de novo em
alguns segundos"), que o painel e o bot já sabem renderizar.

**O que precisa mudar:**

| Arquivo | Seção | De | Para |
| --- | --- | --- | --- |
| `04-TESTES.md` | CTL-007 | "DIVERGÊNCIA ABERTA" | `rejected` + `SHUTDOWN_IN_PROGRESS`; asserção, não sonda |
| `04-TESTES.md` | §14 item 16 | "divergência aberta, congelar no PREP 5" | resolvido por D29 |
| `03-ONDAS.md` | COMMIT PREP 5 | "congelar a divergência de `start` em `STOPPING`" | o PREP 5 **transcreve** D29 em `src/contracts/control.ts`; não decide nada |

**Chave de idempotência** (a segunda metade da divergência aberta): a chave é o **`requestId`**
gerado pela superfície (painel ou bot) e propagado no `ControlIntent`. O **nonce de confirmação** de
`src/control/confirm.ts` é ortogonal: ele autoriza a ação que aumenta exposição, não a deduplica.
Um `requestId` repetido devolve o resultado da primeira execução; um nonce repetido é **recusado**.

---

## Apêndice A — bloco de `scripts` canônico do `package.json`

```jsonc
"scripts": {
  "lint":           "oxlint . && eslint .",
  "typecheck":      "tsc --noEmit",
  "build":          "tsc -p tsconfig.build.json",
  "test":           "node --test --test-reporter=spec 'test/unit/**/*.test.ts' 'test/integration/**/*.test.ts'",
  "test:contract":  "node --test 'test/contract/**/*.test.ts'",
  "test:security":  "node --test --test-reporter=spec 'test/security/**/*.test.ts'",
  "test:e2e":       "node --test --test-concurrency=1 'test/e2e/**/*.test.ts'",
  "test:live":      "node --test --test-concurrency=1 'test/live/**/*.test.ts'",
  "test:cov":       "node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=85 --test-coverage-functions=95 --test-coverage-exclude='test/**' 'test/unit/**/*.test.ts' 'test/integration/**/*.test.ts'",
  "test:all":       "pnpm test && pnpm test:contract && pnpm test:security && pnpm test:e2e",
  "types:fetch":    "node scripts/fetch-dsh-types.mjs",
  "package:check":  "publint && attw --pack . && node scripts/check-tarball.mjs",
  "prepublishOnly": "pnpm run build && pnpm run package:check"
}
```

Campos vizinhos que a decisão também fixa:

```jsonc
"files": ["dist", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md"],
"engines": { "node": ">=24" },
"os": ["linux", "darwin"],
"dsh": { "bundle": {} },
"dependencies": { "grammy": "1.45.1" },
"peerDependencies": { "@deepseek-ai/cordis": ">=4.0.0 <5" },
"peerDependenciesMeta": { "@deepseek-ai/cordis": { "optional": true } }
```

**Comando de gate (rodado no snapshot após cada squash-merge):**

```
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```
