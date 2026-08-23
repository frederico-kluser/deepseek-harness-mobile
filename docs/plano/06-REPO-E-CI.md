# 06 — Repositório e CI

**Assunto:** como transformar `/home/ondokai/Projects/deepseek-harness-mobile` — hoje 7 commits, sem
remote, sem LICENSE, sem CI — num repositório publicável, instalável e auditável para um plugin do
DeepSeek Harness que **expõe a UI de um agente de código à internet**.

Este documento é irmão dos outros de `docs/plano/`. Ele **não** define a arquitetura do gate, do
túnel ou do bot (`01-ARQUITETURA.md`, `02-SEGURANCA.md`), **não** define a estratégia de testes
(`04-TESTES.md`), **não** define estilo de código (`05-QUALIDADE-CODIGO.md`) e **não** define a
divulgação (`07-COMUNIDADE.md`). Ele define a **casca**: árvore de arquivos, arquivos de comunidade,
CI, release, publicação no npm, empacotamento DSH, supply chain e política de compatibilidade.

> **Regra de fonte deste documento.** Toda afirmação com URL foi verificada no dossiê de pesquisa
> desta rodada (ver `08-PESQUISA-E-FONTES.md`). Toda afirmação marcada **NÃO CONFIRMADO** é hipótese
> operacional que precisa de verificação humana antes de virar código ou promessa pública.
> Os quatro markdowns em `~/Documents/deepseek-harness` **não são fonte de API** aqui: são prosa
> gerada por LLM que acerta a arquitetura e erra nomes de pacote e assinaturas (§11.1).

---

## 0. Estado atual, sem maquiagem

| Item | Estado hoje | Consequência |
| --- | --- | --- |
| Commits | 7, o primeiro em 2026-08-19 | Reprova no gate do registro `awesome-dsh-plugin`, que exige repo com **≥1 dia de idade e ≥10 commits**, checado automaticamente por `scripts/check-submission.mjs` (`MIN_AGE_DAYS = 1`, `MIN_COMMITS = 10`) |
| `git remote` | nenhum | Não há repositório público: sem CI, sem descoberta, sem trusted publishing |
| `LICENSE` | ausente (só `"license": "MIT"` no `package.json`) | Sem o arquivo, o GitHub não detecta a licença e o *community profile* fica incompleto |
| `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `CHANGELOG.md` | ausentes | Ver §3 — aqui `SECURITY.md` é conteúdo técnico, não formulário |
| `.github/` | ausente | Sem CI, sem templates, sem `permissions` mínimos, sem CODEOWNERS |
| `package.json` → `repository` | ausente | Trusted publishing do npm **exige** esse campo batendo exatamente com o repo |
| `package.json` → `keywords` | `deepseek-harness, dsh, cordis, cordis-plugin` | Falta `dsh-plugin`, usada por 1.909 pacotes do ecossistema |
| `package.json` → `dsh` | ausente; a chave `//dsh` explica a omissão deliberada | Reprova no check #1 do registro — mas a solução não é a que a chave supõe (§9.1) |
| `types/@deepseek-ai/*` | `.d.ts` escritos à mão, com nomes **errados** | `@deepseek-ai/dsh-host-subprocess` **não existe no npm** (HTTP 404); o serviço real do webserver é `ctx.httpServer` / `HttpServerService`, não `ctx.webServer` / `WebServer` (§11.1) |
| Testes | `test/index.test.ts`, 2.105 linhas, `node --test` com dublês | Boa base. Falta rodar em CI, falta cobertura medida, falta teste de contrato contra os `.d.ts` reais |
| Tooling | `tsc` 5.9 + `node --test`. Sem lint, sem formatter, sem hooks | Ver §5 |
| `pnpm-lock.yaml` | commitado, 912 bytes (só devDeps) | Correto. Manter e passar a exigir `--frozen-lockfile` |

**O que se mantém.** `src/index.ts` (o conteúdo, não o tamanho), `test/index.test.ts`,
`cordis.patch.yml`, a separação `tsconfig.json` (typecheck, `noEmit`) × `tsconfig.build.json`
(emissão para `dist/`) — que já está certa e é exatamente o que o npm precisa —, `pnpm-lock.yaml`,
`.gitignore` e o conteúdo do `README.md` como matéria-prima.

**O que muda.** `package.json` (campos de publicação, bloco `dsh`, keywords, `repository`,
`peerDependencies`), `types/` (deixa de ser escrito à mão e passa a ser **gerado** dos tarballs
reais), `README.md` (reescrito segundo §4), `src/` (de módulo único de 1.836 linhas para módulos —
decisão de `01-ARQUITETURA.md`, refletida em §2 aqui), `.gitignore` (ganha `coverage/`, `*.tgz`,
`.cloudflared/`).

**O que é novo.** Tudo em `.github/`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.changeset/`, `scripts/`, `docs/*.md` (fora de `docs/plano/`),
`renovate.json`, configuração de lint, `.editorconfig`, `.gitattributes`, `.nvmrc`,
`pnpm-workspace.yaml`.

---

## 1. A tensão central, vista do repositório

O plugin existente foi construído para **travar** o DSH em loopback. O `README.md` atual diz,
textualmente: *"Exposição à rede faz-se sempre por proxy reverso TLS autenticado à frente do
loopback — nunca alargando o bind."* Agora o produto é **expor o DSH pela internet via Cloudflare
Tunnel**.

Isso não é contradição, e o repositório precisa dizer por que não é — em letras grandes, versionado,
e com um teste que falhe se alguém "resolver" a tensão do jeito errado:

1. O `cloudflared` abre uma conexão **de saída** e liga-se ao `127.0.0.1:3080`. O bind **continua**
   loopback. A invariante `assertSecureBind()` de `src/index.ts` **permanece válida e obrigatória** —
   ela não é afrouxada pelo túnel, ela é o que impede a exposição *dupla* (túnel **e** LAN).
   Fonte: *"cloudflared initiates an outbound connection through your firewall from the origin to the
   Cloudflare global network"*
   ([Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)).
2. **Mas** todo tráfego do túnel chega à origem **como loopback**. Portanto
   `trustedRemotes: ['127.0.0.1']` deixa de ser fronteira de segurança no instante em que o túnel
   sobe: o 403-antes-de-401 por origem passa a filtrar exatamente nada. **A partir daí a única
   barreira real é a credencial** (§4.3, e `02-SEGURANCA.md`).
3. E a URL do túnel **não é segredo**. Uma chamada gratuita e sem autenticação à API do urlscan.io
   (`https://urlscan.io/api/v1/search/?q=page.domain:trycloudflare.com`) devolve `total: 10000` e,
   nos primeiros 100 resultados, dezenas de hostnames distintos de quick tunnels — 18% deles ainda
   resolvendo em DNS no mesmo instante. Não é enumeração de tunnels vivos (o urlscan só indexa o que
   alguém submeteu, majoritariamente feeds antiphishing), mas prova o suficiente: **o hostname vira
   público assim que qualquer scanner o vê**.

Consequência concreta para este documento — três artefatos deixam de ser opcionais:
`docs/THREAT-MODEL.md` versionado, `SECURITY.md` com política de disclosure (§3.5), e um **teste de
invariante de bind** como *required check* no CI (§6.3).

---

## 2. Árvore completa do repositório

```text
dsh-guarded-bot-orchestrator/ (hoje: dsh-guard-messenger)
├── .changeset/
│   ├── config.json                  # Changesets: baseBranch master, access public, commit false
│   └── README.md                    # Boilerplate gerado por `changeset init`
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── config.yml               # blank_issues_enabled: false + contact_links p/ Security Advisories
│   │   ├── 01-bug.yml               # Form: versão do plugin, rc do DSH, Node, SO, log REDIGIDO
│   │   ├── 02-compat-break.yml      # Form dedicado "o DSH rc-X quebrou o plugin" (o caso mais frequente, §11)
│   │   └── 03-feature.yml           # Form de proposta, com campo obrigatório "impacto de segurança"
│   ├── workflows/
│   │   ├── ci.yml                   # Gate de PR: os 12 required checks do §6.5
│   │   ├── dsh-compat.yml           # Nightly: baixa .d.ts REAIS do npm, regenera types/, roda contrato (§11)
│   │   ├── live.yml                 # workflow_dispatch APENAS: túnel REAL, DSH_GUARD_LIVE_TESTS=1 (§6.4)
│   │   ├── release.yml              # Changesets: PR de versão; ao merge publica no npm via OIDC (§8)
│   │   ├── scorecard.yml            # OpenSSF Scorecard semanal, SARIF + badge
│   │   └── codeql.yml               # CodeQL javascript-typescript, semanal + em PR
│   ├── CODEOWNERS                   # Dono de tudo; os módulos de decisão de segurança e workflows exigem review
│   ├── dependabot.yml               # SÓ ecossistema `github-actions` (bump dos pins de SHA). npm fica no Renovate
│   └── PULL_REQUEST_TEMPLATE.md     # Checklist com item explícito "não alarguei o bind nem o escopo do gate"
├── docs/                            # NOMES CANÔNICOS — 09 §D5. Nome fora desta lista é violação
│   ├── THREAT-MODEL.md              # Quem é o atacante, o que ele ganha, o que mitigamos, o que não
│   ├── EXPOSURE.md                  # O que muda quando o túnel sobe (§1 em forma longa, para o usuário)
│   ├── INSTALL.md                   # Instalação passo a passo
│   ├── ONBOARDING-TELEGRAM.md       # O guia de conectar o Telegram (pareamento por código de 6 dígitos)
│   ├── TUNNEL.md                    # Quick vs named, TTL, o que a Cloudflare vê
│   ├── TROUBLESHOOTING.md           # Sintoma → causa → o que fazer
│   ├── COMPATIBILITY.md             # Tabela rc do DSH → versão do plugin. GERADA por CI (§11.2)
│   ├── ARCHITECTURE.md              # Costuras Cordis usadas: intercept, waterfall, effect, fiber, disposer
│   ├── TESTING.md                   # Como rodar cada nível de teste e o que cada um prova
│   ├── PROIBIDO.md                  # O que NUNCA se afirma em material público (07-COMUNIDADE §10)
│   ├── assets/
│   │   └── demo.gif                 # ≤20 s, ≤4 MB, auditado frame a frame por segredo (07 §4.1)
│   ├── manual-runs/                 # Registro dos roteiros manuais M1…M7 por release (04-TESTES §9)
│   ├── spikes/                      # Saída bruta dos spikes da Onda 0
│   └── plano/                       # ESTES documentos. Versionados; fora do tarball npm (§8.3)
│       └── 01-… .. 09-…
├── scripts/
│   ├── fetch-dsh-types.mjs          # Baixa tarballs npm PINADOS e extrai lib/types/*.d.ts para types/
│   ├── check-tarball.mjs            # Falha se faltar dist/index.js, dist/index.d.ts, dist/worker/telegram-bot.js,
│   │                                #   cordis.patch.yml ou LICENSE — ou se aparecer src/, types/, test/, docs/, .env
│   └── gen-compat-table.mjs         # Gera docs/COMPATIBILITY.md do resultado do dsh-compat.yml
├── src/                             # ÁRVORE CANÔNICA — 09-DECISOES-CANONICAS.md §D1, literal
│   ├── index.ts                     # Raiz de composição: name, inject, apply. Fia módulos, não implementa regra
│   ├── brand.ts                     # Branded IDs (SessionId, Nonce, SecretDigest) e construtores validadores
│   ├── errors.ts                    # Hierarquia de erro tipada + códigos estáveis
│   ├── contracts/                   # Interfaces congeladas em COMMIT PREP. Leitura livre, ESCRITA PROIBIDA
│   │   ├── auth.ts                  #   SecretStore, SessionStore, RateLimiter, AuditSink        [PREP 2]
│   │   ├── state.ts                 #   StateStore: leitura e escrita atômica do state.json      [PREP 2]
│   │   ├── tunnel.ts                #   TunnelState, TunnelInfo, TunnelDiscovery                 [PREP 3]
│   │   ├── ipc.ts                   #   Protocolo JSON-lines host↔worker                         [PREP 4]
│   │   └── control.ts               #   ControlIntent, transições legais, contrato do nonce      [PREP 5]
│   ├── dsh/
│   │   └── adapter.ts               # ÚNICO ponto que toca API do DSH (ctx.httpServer, ctx.subprocess). §11.3
│   ├── config/
│   │   ├── schema.ts                # interface Config — contrato congelado do cordis.patch.yml
│   │   ├── assert.ts                # assertValidConfig e os assertores primitivos
│   │   └── bind.ts                  # assertSecureBind, isWildcardBindHost — política de bind
│   ├── logging/
│   │   ├── logger.ts                # Wrapper de ctx.logger com LOG_SCOPE fixo
│   │   └── redact.ts                # Mascara `bot\d+:[\w-]+`, Authorization, Cookie, mk e a URL do túnel
│   ├── permissions/
│   │   └── deny.ts                  # canonicalizePermissionToken, requestsDeniedPermission
│   ├── http/
│   │   ├── auth-basic.ts            # verifyBasicAuth: parse do header + comparação em tempo constante
│   │   ├── origin.ts                # normalizeRemoteAddress, isTrustedRemote
│   │   ├── path.ts                  # canonicalRequestPath, isGuardedPath, routeMayServeGuardedPath
│   │   ├── responses.ts             # challengeBasicAuth, denyUntrustedOrigin, denyUpgrade — corpos idênticos
│   │   ├── gate.ts                  # createGuardedHandler, createGuardedUpgradeHandler
│   │   ├── intercept.ts             # Fiação de ctx.intercept('httpServer', …) sobre register/fallback/upgrade
│   │   ├── session-auth.ts          # Verificação do cookie de sessão dentro do gate
│   │   └── host-header.ts           # Validação do header Host (anti DNS rebinding)
│   ├── state/
│   │   ├── paths.ts                 # $XDG_STATE_HOME/dsh-guarded-bot + fallback + modos 0700/0600
│   │   ├── schema.ts                # Forma versionada do state.json (version: 1) e migração
│   │   └── store.ts                 # ÚNICO writer: tmp no mesmo dir + fsync + rename; recusa modo > 0600
│   ├── secret/
│   │   ├── generate.ts              # randomBytes(32) + base32 RFC 4648 sem padding + agrupamento visual
│   │   ├── canonical.ts             # canonicalizeSecret: upper, remove '-' e espaço
│   │   ├── store.ts                 # Persiste só o digest, via StateStore
│   │   ├── verify.ts                # Comparação de digests de 32 bytes em tempo constante
│   │   └── ott.ts                   # Token de uso único (128 bits, TTL 10 min) de /__guard/secret
│   ├── session/
│   │   ├── store.ts                 # Emissão, lookup, expiração (idle 60 min, absoluto 8 h). Disposer
│   │   ├── cookie.ts                # Serialização de __Host-dsh_sid
│   │   └── magic.ts                 # Store do mk do link mágico: 128 bits, TTL 120 s, uso único, em memória
│   ├── ratelimit/
│   │   ├── policy.ts                # Função pura falhas→atraso (full jitter), limiar de ban, teto NIST
│   │   ├── tracker.ts               # Contadores por identidade em memória. Disposer
│   │   └── restricted.ts            # Modo restrito: ativa aos 100, persiste, derruba o túnel
│   ├── audit/
│   │   ├── log.ts                   # Log append-only 0600, fora do workspace. Disposer
│   │   ├── format.ts                # Serialização do registro de auditoria
│   │   ├── events.ts                # Vocabulário fechado de eventos
│   │   └── notify.ts                # Notificação proativa (best-effort, sempre DEPOIS do log)
│   ├── proc/
│   │   ├── backoff.ts               # computeBackoffDelay — puro, full jitter, sem I/O
│   │   ├── env.ts                   # buildWorkerEnv (allowlist) e buildTunnelEnv — perfis distintos
│   │   ├── tree-kill.ts             # process.kill(-pid) sobre o grupo; ramo win32 isolado e inerte
│   │   └── supervisor.ts            # createWorkerSupervisor genérico; spawn(SubprocessSpawnSpec)
│   ├── tunnel/
│   │   ├── args.ts                  # argv do cloudflared: --metrics fixo, --token-file, proíbe debug
│   │   ├── supervisor.ts            # Ciclo de vida do cloudflared sob ctx.effect; orçamento
│   │   ├── probe.ts                 # Probe fail-closed de 4 sondas anônimas ANTES de subir
│   │   ├── ttl.ts                   # TTL (default 60 min, teto 480) com relógio injetado
│   │   ├── pidfile.ts               # Pidfile do cloudflared + varredura de órfão no boot (02 §9)
│   │   ├── discover.ts              # GET /quicktunnel + fallback regex em stderr; prefixa https://
│   │   └── readiness.ts             # Polling com timeout ≥30 s, abortado no 'close' do filho
│   ├── panel/
│   │   ├── routes.ts                # Rotas /__guard/* e a política por rota
│   │   ├── html.ts                  # Painel HTML autocontido: sem CDN, sem build, sem recurso externo
│   │   ├── api.ts                   # GET /api/state, POST /api/login, POST /api/tunnel/start|stop
│   │   ├── magic.ts                 # GET inerte + POST consumidor de /__guard/magic
│   │   ├── secret.ts                # GET /__guard/secret?ott=… — uma vez; 404 indistinguível
│   │   └── csrf.ts                  # Token anti-CSRF das rotas POST do painel
│   ├── telegram/
│   │   ├── onboarding.ts            # Detecção de estado da conexão + roteiro guiado passo a passo
│   │   ├── pairing.ts               # Código de pareamento de 6 dígitos, TTL 5 min, fecha permanente
│   │   └── ipc.ts                   # Lado HOST do protocolo JSONL host↔worker
│   └── control/
│       ├── controller.ts            # Máquina de estado ÚNICA; fila de intents; broadcast com seq
│       └── confirm.ts               # Nonce server-side (TTL 60 s) das ações que AUMENTAM exposição
├── worker/                          # O bot roda em PROCESSO SEPARADO (§2.1). Mesmo pacote, mesmo tarball
│   ├── telegram-bot.ts              # Entry do processo: long polling com grammY
│   ├── ipc.ts                       # Lado WORKER do protocolo JSONL sobre stdio
│   ├── lib/
│   │   ├── client.ts                # grammY: apiRoot, plugin de auto-retry, bot.catch
│   │   ├── polling.ts               # timeout 50, allowed_updates, drop_pending_updates, 409 → sair
│   │   └── keyboard.ts              # Teclado inline, answerCallbackQuery sempre, editMessageText
│   ├── auth/
│   │   ├── allowlist.ts             # Autorização por from.id E chat.id, fail-closed, descarte contado
│   │   ├── guard.ts                 # Revalidação de identidade em todo callback_query
│   │   └── pairing.ts               # Recepção de /parear <código>; segundo pareamento recusado
│   └── commands/
│       ├── router.ts                # comando → intent IPC; setMyCommands com a lista canônica
│       ├── onoff.ts                 # /ligar e /desligar
│       ├── access.ts                # /acessar e /rotacionar
│       └── status.ts                # /status e /emergencia
├── bin/
│   └── dsh-guard-setup.ts           # CLI de onboarding: provision(), senha + QR ASCII, --reset-pairing
├── examples/
│   └── minimal/                     # Exemplo executável. Aceite: 401 sem credencial, 200 com, pgrep vazio
├── test/                            # LAYOUT CANÔNICO — 09 §D1/§D15
│   ├── unit/<espelho de src/ ou worker/>/<arquivo>.test.ts
│   ├── integration/<área>/<caso>.test.ts
│   ├── contract/dsh-types.test.ts   # Compara símbolos de types/ com os .d.ts reais do npm (§11)
│   ├── security/<vetor>.test.ts     # Suíte adversarial. Bloqueia merge
│   ├── e2e/<fluxo>.test.ts          # OFFLINE, só dublês. BLOQUEIA PR
│   ├── live/<fluxo>.test.ts         # Rede real. DSH_GUARD_LIVE_TESTS=1, workflow_dispatch. NUNCA gate
│   ├── support/                     # clock, ctx-double, child-double, telegram-server, state-dir  [PREP 2]
│   └── bin/fake-cloudflared.mjs     # Dublê do cloudflared                                        [PREP 2]
├── types/
│   └── deepseek-ai/*.d.ts           # Shims @deepseek-ai/*. GERADOS dos tarballs reais, nunca à mão (§11.1)
├── .editorconfig                    # LF, UTF-8, 2 espaços, newline final. Fim da briga de whitespace
├── .gitattributes                   # `* text=auto eol=lf` + `pnpm-lock.yaml -diff` para não poluir PR
├── .gitignore                       # node_modules/, dist/, coverage/, *.tsbuildinfo, *.tgz, .env*
├── .npmrc                           # SÓ registry/auth. Config funcional do pnpm 11 vai no pnpm-workspace.yaml
├── .nvmrc                           # `24` — lido por setup via node-version-file
├── CHANGELOG.md                     # Gerado pelo Changesets. Não editar à mão
├── CODE_OF_CONDUCT.md               # Contributor Covenant 2.1 com o contato PREENCHIDO
├── CONTRIBUTING.md                  # Como rodar, testar, propor; e o que NUNCA se aceita em PR
├── LICENSE                          # MIT (§3.2)
├── README.md                        # §4
├── SECURITY.md                      # Política de disclosure. Documento crítico deste projeto (§3.5)
├── cordis.patch.yml                 # Manifesto de injeção. Vai no tarball
├── eslint.config.js                 # Flat config (ESLint 10 não lê .eslintrc). Só regras type-aware
├── oxlint.json                      # Gate rápido de lint: pre-commit e primeiro passo do CI
├── package.json                     # §8, §9
├── pnpm-lock.yaml                   # COMMITADO. `--frozen-lockfile` em todo CI
├── pnpm-workspace.yaml              # No pnpm 11 é aqui que mora a config funcional (não no .npmrc)
├── renovate.json                    # Updates npm, com regra especial para o escopo @deepseek-ai (§10)
├── tsconfig.json                    # Typecheck de src + types + test, noEmit
└── tsconfig.build.json              # Emissão de dist/ a partir de src/ E worker/ (§2.1)
```

### 2.1 Decisões de estrutura que precisam de justificativa

**Um pacote, não monorepo — e o worker do Telegram JÁ é um processo separado.** Plugin, worker do
bot e supervisor do túnel são um único artefato de **instalação**
(`dsh plugin --profile web add <pkg>`), mas **não** um único processo: por decisão canônica
(09 §D2), o bot roda em **subprocesso supervisionado** (`detached: true`), lançado por
`ctx.subprocess.spawn(spec)`, com IPC por **JSON-lines sobre stdio**. O código dele vive em
`worker/`, **no mesmo pacote npm**, e é compilado para `dist/worker/telegram-bot.js`.

Monorepo continua fora de escopo porque não há um segundo artefato **publicável** — e não porque o
bot seja in-process. A versão anterior desta seção colocava `src/telegram/bot.ts` dentro do plugin e
tratava "binário separado" como hipótese futura; isso foi corrigido.

Consequências que este documento tem que sustentar:

- `tsconfig.build.json` compila `src/` **e** `worker/`.
- O `argv` do spawn resolve `dist/worker/telegram-bot.js` relativo a `import.meta.url`, **nunca** por
  `cwd` — o `cwd` do DSH não é o do pacote.
- `files` continua sendo só `dist` (§8.3): `dist/worker/` vai junto.
- A allowlist de identidade do Telegram vive em `worker/auth/allowlist.ts`, **fora** de `src/`.
- **Por que isso é decisão de segurança e não de gosto:** in-process, `buildWorkerEnv` deixa de ser
  fronteira — o bot herdaria o `process.env` inteiro do DSH e a allowlist de ambiente desapareceria
  por construção. E um bot que trava, vaza memória ou é morto pelo OOM killer não pode derrubar o
  harness junto.

**`src/index.ts` deixa de ter 1.836 linhas.** Auto-contido foi razoável para um plugin de uma
responsabilidade. Com túnel + bot + sessão + rate limit, vira irrevisável em PR. Os limites exatos
vêm de `05-QUALIDADE-CODIGO.md` **§5.3** (400 linhas por arquivo é limite duro); aqui só se fixa que
`index.ts` continua sendo o **único** lugar com `export const name`, `export const inject` e
`export function apply`.

**`src/dsh/adapter.ts` é novo e é a peça mais importante desta reorganização.** Todo acesso a
serviço do DSH (`ctx.httpServer`, `ctx.subprocess`) passa por ele. Quando o upstream renomear um
serviço — e vai, está em `0.1.0-rc` com aviso explícito de breaking changes no README —, a mudança é
em um arquivo, não em nove. Ver §11.3.

**`test/` em seis níveis com custos diferentes** — e a palavra "e2e" tem **um** significado só
(09 §D10): `unit` e `integration` em todo push (é o `pnpm test` do gate); `security` e `contract` em
todo PR; **`e2e` é OFFLINE, só com dublês (`test/bin/fake-cloudflared.mjs`), roda em
`ubuntu-latest` e BLOQUEIA PR**; **`live` é o que sobe túnel real** — opt-in por
`DSH_GUARD_LIVE_TESTS=1`, `workflow_dispatch` apenas, nunca em PR, nunca no gate. A versão anterior
deste documento chamava de "e2e" o que agora se chama `live`, e isso significava o oposto do que
`04-TESTES.md` chamava de e2e; o conflito está fechado.

Motivo de `live` nunca rodar automático: um quick tunnel exposto é publicamente descobrível em
segundos (§1.3), o CI é ambiente compartilhado, e a própria pesquisa registra um caso em que subir
quick tunnel apontado para a porta errada publicou o DSH real por ~40 s.

**`docs/plano/` fica versionado** — é o registro da decisão — mas **fora do tarball** (§8.3).

---

## 3. Arquivos de comunidade

O GitHub mede README, `CODE_OF_CONDUCT`, `LICENSE`, `CONTRIBUTING`, política de segurança e templates
de issue no *community profile checklist*
([docs GitHub](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)).
Não é vaidade: é o que um avaliador olha em 20 segundos antes de decidir se instala um plugin que
abre a máquina dele para a internet.

**Fato que vira diferencial:** o upstream `deepseek-ai/deepseek-harness` **não tem** `SECURITY.md`
nem `CONTRIBUTING.md` (ambos 404) e não tem Private Vulnerability Reporting ligado — foi por isso que
a RCE não autenticada do control plane virou a discussão pública
[#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853) em vez de um advisory
coordenado. Publicar `SECURITY.md` e **ligar PVR** neste repo é diferencial concreto, não burocracia.

### 3.1 `README.md`

Ver §4 inteira. É o arquivo de maior alavancagem do repositório.

### 3.2 `LICENSE` — recomendação: **MIT**

| | MIT | Apache-2.0 |
| --- | --- | --- |
| Concessão de **patente** | **Não há cláusula expressa.** Existe, no máximo, licença implícita de patente sob a doutrina contratual — o que varia por jurisdição e não é garantia | **§3 concede expressamente** licença de patente perpétua, mundial e irrevogável, dos contribuidores para os usuários |
| Retaliação por litígio | Nenhuma | **§3 termina** a licença de patente de quem processar alegando que a obra infringe patente (*defensive termination*) |
| Obrigações extras | Manter o aviso de copyright | **§4**: manter o `NOTICE`, marcar arquivos modificados, incluir cópia da licença |
| Fricção para o adotante | Mínima | Baixa, mas não nula (`NOTICE` é passo a mais) |

**Decisão: MIT.** Três razões: (a) o upstream é MIT (`spdx_id: "MIT"` na API do GitHub) e o
ecossistema de plugins segue MIT; (b) o registro `awesome-dsh-plugin` **não exige** licença
específica; (c) a fricção de adoção importa mais do que a proteção de patente para um plugin de
~2.000 linhas sem invenção patenteável.

**Quando reconsiderar Apache-2.0:** se o projeto ganhar contribuidores corporativos, ou se alguém
implementar algo genuinamente novo no gate. Aí a concessão expressa do §3 deixa de ser abstração.
Trocar depois é possível para contribuições futuras, mas exige consentimento dos contribuidores
anteriores — decidir **antes** do primeiro PR externo custa zero; depois, custa e-mails.

O arquivo é o texto integral da MIT, com `Copyright (c) 2026 <nome do autor>`, e o
`package.json` mantém `"license": "MIT"`. Os dois têm de bater.

### 3.3 `CONTRIBUTING.md`

Responde às três perguntas que o guia oficial de open source manda responder — como reportar bug,
como sugerir feature, como montar o ambiente e rodar os testes
([opensource.guide](https://opensource.guide/starting-a-project/)) — e mais quatro específicas daqui:

1. **Setup em 4 comandos:** `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm run typecheck`,
   `pnpm run test`.
2. **Como rodar cada nível de teste** e por que `live` é opt-in (sobe túnel real) enquanto `e2e` é
   offline e obrigatório em PR.
3. **O que exige changeset** (`pnpm exec changeset`): qualquer mudança em `src/` ou
   `cordis.patch.yml`.
4. **O que nunca é aceito em PR**, explicitamente e sem eufemismo:
   - alargar o bind para além de loopback, ou tornar `assertSecureBind` configurável para `0.0.0.0`;
   - remover ou tornar opcional a autenticação quando o túnel está ativo;
   - logar credencial, token do Telegram ou a URL do túnel sem passar por `src/log/redact.ts`;
   - `?? valorPadrao` silencioso em qualquer caminho de política de segurança (a convenção do DSH é
     *fail loud at load*);
   - dependência de runtime nova sem justificativa escrita no PR (hoje o pacote tem **zero**).

### 3.4 `CODE_OF_CONDUCT.md`

Contributor Covenant **2.1**, versão corrente e recomendada pelo guia oficial. Duas obrigações que
quase todo mundo esquece: preencher o placeholder `[INSERT CONTACT METHOD]` (um e-mail que alguém
lê de verdade) e manter a linha de atribuição *"This Code of Conduct is adapted from the Contributor
Covenant, version 2.1, available at
https://www.contributor-covenant.org/version/2/1/code_of_conduct.html"*
([contributor-covenant.org](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)).

### 3.5 `SECURITY.md` — o arquivo crítico deste projeto

Este plugin é, por construção, o controle de acesso de um RCE-as-a-service. Se ele falhar, o atacante
ganha shell na máquina do usuário, o `~/.ssh`, os `.env`, as chaves de LLM e o código-fonte — o
padrão exato do ataque *s1ngularity* ao Nx (26/08/2025), que weaponizou agentes de código já
instalados invocando-os com as flags que desligam as travas e exfiltrou 2.349 credenciais de 1.079
máquinas. O `SECURITY.md` tem que refletir isso.

Esqueleto (o texto final é trabalho da onda R0):

```markdown
# Política de Segurança

## O que este plugin faz — e o que ele não faz
Ele é a única barreira entre a internet e um agente que executa código na sua máquina.
Ele NÃO conserta as vulnerabilidades do DSH upstream (#853 RCE não autenticada no control
plane, #1769 escape do sandbox bwrap): ele impede que sejam alcançáveis sem credencial.
O sandbox do DSH NÃO é fronteira de segurança enquanto essas discussões estiverem abertas.

## Versões suportadas
| Versão do plugin | Faixa de rc do DSH | Suporte de segurança |
| --- | --- | --- |
| 0.3.x  | 0.1.0-rc.7 .. rc.9 | Sim |
| 0.2.x  | 0.1.0-rc.6         | Só correções críticas |
| < 0.2  | —                  | Não |

## Como reportar
Use **GitHub Security Advisories** (aba Security → Report a vulnerability). O PVR está ligado.
NÃO abra issue pública. NÃO poste em Discussions. NÃO mande por Telegram.
Se preferir e-mail: <endereço>. Resposta em até 72 h; correção ou plano público em 90 dias.

## Escopo
Dentro: bypass do gate, vazamento de credencial/token, escape do supervisor de processo,
elevação via cordis.patch.yml, qualquer caminho que devolva 200 sem credencial.
Fora: vulnerabilidades do DSH upstream (reporte ao upstream — e nos avise),
vulnerabilidades do cloudflared (reporte à Cloudflare), e o fato conhecido e documentado
de que a URL do túnel não é segredo.

## Safe harbor
Pesquisa de boa-fé contra a sua própria instalação não será alvo de ação legal.
Não teste contra instalações de terceiros.
```

### 3.6 `CHANGELOG.md`

Gerado pelo Changesets (§7.2), formato *Keep a Changelog* com seções por versão. Regra própria deste
projeto: **toda entrada com impacto de segurança recebe o prefixo `SECURITY:`** e diz explicitamente
se exige ação do usuário (rotacionar senha, reinstalar o `cordis.patch.yml`, derrubar o túnel). O
usuário deste plugin lê o CHANGELOG antes de atualizar porque atualizar mexe no que está exposto na
internet dele.

### 3.7 Templates de issue e PR

Issue forms em `.github/ISSUE_TEMPLATE/*.yml` precisam de frontmatter YAML válido com `name:` e
`description:` (arquivos `.md` usam `name:` e `about:`)
([docs GitHub](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)).

- **`config.yml`**: `blank_issues_enabled: false` + `contact_links` apontando para Security
  Advisories ("relatou vulnerabilidade? não é aqui") e para Discussions (dúvidas de uso).
- **`01-bug.yml`**: campos obrigatórios `versão do plugin`, `versão rc do DSH`
  (`npx @deepseek-ai/dsh --version`), `Node`, `SO`, `log`. O campo de log traz o aviso, em maiúsculas,
  de **remover token do Telegram, senha e URL do túnel** antes de colar.
- **`02-compat-break.yml`**: o formulário mais usado deste repo. Pergunta a rc antiga, a rc nova, e o
  símbolo que sumiu/mudou. Alimenta `docs/COMPATIBILITY.md`.
- **`03-feature.yml`**: campo obrigatório *"impacto de segurança desta proposta"* — sem esse campo,
  toda proposta vira "e se o gate tivesse um modo sem senha para facilitar?".
- **`PULL_REQUEST_TEMPLATE.md`**: checklist curto — changeset adicionado; testes passam; não alarguei
  o bind; não removi nem tornei opcional a autenticação; nada logado sem redigir; documentação
  atualizada se mudou config.

---

## 4. Anatomia de um README que converte

O leitor típico chega por uma lista de plugins ou por um post, dá 15 segundos ao arquivo e decide.
Ele precisa entender **o que é**, **que é seguro**, e **como instalar** — nessa ordem.

### 4.1 Acima da dobra (primeiras ~25 linhas)

```markdown
# dsh-guarded-bot-orchestrator

Acesse seu DeepSeek Harness do celular, com senha, sem abrir porta nenhuma no roteador.

[CI] [npm] [downloads] [OpenSSF Scorecard]

![demo](docs/assets/demo.gif)

`dsh plugin --profile web add dsh-guarded-bot-orchestrator`

- **Senha de verdade no control plane.** Basic/sessão sobre `/api`, sobre o fallback da SPA
  **e sobre o handshake de WebSocket** — o caminho que quase todo gate esquece.
- **Túnel Cloudflare gerenciado.** Um link HTTPS; o bind continua `127.0.0.1`.
- **Liga/desliga pelo Telegram ou pelo painel.** Sem SSH, sem VPN.
- **Uma dependência de runtime** (`grammy`), e ela só é carregada pelo processo do bot.

> **Leia antes de expor:** a URL do túnel **não é segredo** e o DSH tem RCE não autenticada
> conhecida no control plane ([#853]). Este plugin é a barreira. [Modelo de ameaça](docs/THREAT-MODEL.md)
```

Quatro exigências, todas verificáveis:

1. **Uma frase de benefício, não de tecnologia.** "Acesse do celular, com senha, sem abrir porta" —
   não "plugin Cordis que intercepta o HttpServerService".
2. **GIF de demo com ≤ 20 s e ≤ 4 MB**, em `docs/assets/demo.gif` (limites e caminho canônicos,
   09 §D22; o roteiro de 5 cenas e a auditoria frame a frame por segredo estão em
   `07-COMUNIDADE.md` §4.1), mostrando o ciclo real: comando no Telegram → link chega → abre no
   celular → prompt de senha → UI do DSH. Grave com `asciinema`+`agg` para o terminal e captura de
   tela do celular lado a lado. GIF acima de ~5 MB não carrega no 3G e vira ruído.
3. **Install de uma linha, copiável, sem `sudo` e sem `git clone`.** O padrão canônico das 1.650
   entradas do registro é `dsh plugin --profile web add <pkg-npm>`
   ([awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)).
4. **O aviso de segurança acima da dobra, não no rodapé.** Um projeto que expõe agente à internet e
   esconde o risco no fim do README perde a única credibilidade que tem.

### 4.2 Quickstart de 30 segundos

Bloco único, sem ramificações, com a saída esperada mostrada:

```console
$ dsh plugin --profile web add dsh-guarded-bot-orchestrator
$ dsh web
[guarded-bot] senha gerada (aparece UMA vez): K7QF-2M9X-...-4TZP
[guarded-bot] bind 127.0.0.1:3080 — OK
[guarded-bot] túnel: https://xxxx-xxxx-xxxx-xxxx.trycloudflare.com
[guarded-bot] telegram: não configurado — rode /parear <código> no bot para ligar
```

**Nenhuma variável de credencial é exportada, e isso é deliberado (09 §D19).** O quickstart anterior
abria com `export ADMIN_USER=eu`, documentando publicamente o mecanismo que `02-SEGURANCA.md` está
removendo. A credencial é **gerada por CSPRNG pelo próprio plugin**, o digest vive no `state.json`, e
`ADMIN_USER`/`ADMIN_PASS` **deixam de existir no fluxo**. O usuário do Basic é fixo (`dsh`) e não é
segredo. O comando do bot é `/parear` — `/vincular` nunca existiu em lugar nenhum além daquele
quickstart, e a linha ainda mandava rodar no bot um comando **antes** de o bot existir; agora ela diz
o que a ferramenta local de fato imprime.

> **Sobre o túnel aparecer nessa saída:** ele só sobe se `exposure.mode: 'tunnel'` **e**
> `exposure.autoStart: true` — e o default de fábrica é `'loopback'` + `autoStart: false`
> (09 §D5, `04-TESTES.md` TENSAO-003). O bloco acima mostra a saída de quem **já** optou por expor;
> o README precisa dizer isso na mesma tela, senão promete exposição automática que o produto não
> faz — e não deve fazer.

Logo abaixo, o **teste de que funcionou** (o mesmo que o CI roda):

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/commands/execute
401   # correto: o gate está na frente
200   # ERRADO: ordem de carregamento — ver README §Ordem de carregamento
```

Esse par `401`/`200` é o melhor conteúdo do README atual e tem que sobreviver à reescrita: dá ao
usuário uma prova de 5 segundos de que a proteção está de pé.

### 4.3 Seção de segurança em destaque

Logo depois do quickstart, com título próprio e sem eufemismo, cobrindo:

- **O que muda quando o túnel sobe:** `trustedRemotes` deixa de filtrar (§1, item 2). A credencial é
  a única barreira. Isso precisa estar escrito na cara do usuário, não só no `THREAT-MODEL.md`.
- **A senha nunca vai pelo Telegram.** A entrega dela é **local**: terminal com QR ASCII no primeiro
  boot, ou `GET /__guard/secret?ott=<token>` com o token impresso no stdout. O que pode chegar pelo
  chat é o **link mágico de uso único** (TTL 120 s), e o README diz isso com todas as letras
  (09 §D3).
- **O túnel tem prazo.** `tunnel.ttlMinutes` é obrigatório: default 60 min, teto 480. Expirado,
  derruba o túnel e invalida todas as sessões (09 §D6).
- **A URL não é segredo** (§1, item 3), com a citação da própria Cloudflare: *"Quick Tunnels are intended
  for testing and development only"*
  ([TryCloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)).
- **Nunca mande segredo pelo Telegram.** Chat com bot **não é** end-to-end: *"Server-client
  encryption is used in Cloud Chats"* ([Telegram FAQ](https://telegram.org/faq#q-so-how-do-you-encrypt-data)),
  a Telegram armazena o histórico nos servidores dela e o próprio FAQ oficial diz *"any bot should be
  treated as a stranger — don't give them your passwords"*.
- **O token do bot é senha.** *"Keep your token secure and store it safely, it can be used by anyone
  to control your bot."* ([Bot features](https://core.telegram.org/bots/features#botfather)).
- **Como desligar tudo em um comando**, e o que acontece com o túnel (SIGTERM ao `cloudflared`
  encerra em ~2 s e a URL passa a devolver HTTP 530 — medido).

### 4.4 O resto, na ordem

Requisitos → Configuração (tabela de opções com default e efeito de segurança) → Ordem de
carregamento (o `401`/`200`) → Bundle vs Profile (§9) → Compatibilidade com rc do DSH (link para
`docs/COMPATIBILITY.md`) → Como funciona (5 parágrafos + diagrama) → Troubleshooting → Alternativas
(comparação honesta com `dsh-webui-auth`, ver `07-COMUNIDADE.md` §2) → Contribuir → Licença.

### 4.5 Badges: quais servem e quais são ruído

| Badge | Serve? | Por quê |
| --- | --- | --- |
| CI status (`master`) | **Sim** | É o único que responde "isso está de pé hoje?" |
| npm version | **Sim** | Diz que existe pacote publicado e qual é a versão corrente |
| npm downloads | **Sim** | Prova social honesta. Shields: intervalo `dw`/`dm`/`dy`/`d18m` ([shields.io](https://shields.io/badges/npm-downloads)) |
| OpenSSF Scorecard | **Sim** | Para um plugin de segurança é o badge mais relevante que existe (§10) |
| Node engine (`>=24`) | Talvez | Útil só porque `engines` alto é motivo real de falha de instalação |
| License | **Não** | O GitHub já mostra na barra lateral, e o `LICENSE` está na raiz |
| "PRs Welcome" / "Made with ❤️" / "Maintained: yes" | **Não** | Zero informação; "maintained: yes" envelhece e passa a mentir |
| Stars / forks | **Não** | Com mediana de **2 estrelas** por plugin do ecossistema, o número real desmotiva mais do que atrai |
| Coverage % | **Não, por ora** | Só depois que a cobertura tiver ratchet no CI; badge de cobertura estagnada é convite a crítica |

Quatro badges. Fileira de dez badges lê como preenchimento.

---

## 5. Qualidade local — o que o CI vai cobrar

Detalhe completo em `05-QUALIDADE-CODIGO.md`. Aqui só o que tem reflexo no repositório e no CI:

| Ferramenta | Versão de referência | Papel | Roda onde |
| --- | --- | --- | --- |
| `oxlint` | 1.79.0 | Gate rápido: 865+ regras, 50–100× mais rápido que ESLint | pre-commit + primeiro passo do CI |
| `eslint` + `typescript-eslint` | 10.8.1 | **Só** as regras type-aware que o oxlint não cobre | job `lint` |
| `tsc` | ver §5.1 | Typecheck (`noEmit`) e emissão (`dist/`) | jobs `typecheck` e `build` |
| `node --test` | Node 24/26 | Runner **único** de testes, zero dependência. Não há Vitest neste projeto (09 §D16) | jobs `test`, `test-security`, `test-e2e`, `test-contract`, `coverage` |
| `publint` + `@arethetypeswrong/cli` | 0.3.24 / 0.18.5 | Valida `exports`, `types`, dual-package | job `build` |
| `gitleaks` | action | Segredo commitado — o token do Telegram viaja **na URL** | job `secrets-scan` |

**ESLint 10 removeu `.eslintrc` de vez** — só flat config (`eslint.config.js`), e exige Node ≥ 20.19.
Não existe caminho de compatibilidade: nasça em flat config.

### 5.1 A questão do TypeScript 7

Fato verificado que muda a configuração do repositório: **TypeScript 7.0 chegou a GA em 08/07/2026**
como port em Go (8–12× mais rápido) **mas não tem API programática até o 7.1**
([devblogs Microsoft](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
Consequência direta: `typescript-eslint` declara suporte a `>=4.8.4 <6.1.0`
([typescript-eslint](https://typescript-eslint.io/users/dependency-versions)) — ou seja, **TS 7 fora**.

**Decisão:** instalar lado a lado, como a Microsoft recomenda:

```jsonc
"devDependencies": {
  "typescript":   "npm:@typescript/typescript6",  // binário tsc6, API 6.0 — é o que o eslint usa
  "typescript-7": "npm:typescript@7"              // tsc7 — typecheck rápido, informativo
}
```

> **Isto é ENTREGA DE T1.2, não estado do repositório (09 §D4).** Enquanto o projeto estiver em
> `typescript@^5.9.3`, os scripts `typecheck` e `build` usam o binário **`tsc`**. No commit de T1.2
> que instala o alias, os dois scripts passam a `tsc6` **no mesmo commit**. Nenhum script, workflow
> ou documento pode declarar `tsc6` antes disso: um job que chama binário inexistente deixa o gate
> vermelho por motivo errado. Versões de devDependency são **exatas**, sem `^` e sem `~` (09 §D18) —
> os `^` acima foram removidos por isso.

O repositório hoje está em `typescript@^5.9.3`. A migração para 6.0 é entrega de **T1.2** (Onda 1) e
**não é gratuita**: o TS 6.0/7.0 mudou defaults (`strict: true`, `module: esnext`, `target: es2025`,
`types: []` — passa a exigir `"node"` explícito —, `rootDir: "."`, que quebra layouts `src/`) e
removeu `target: es5`, `--outFile`, `--baseUrl`, `moduleResolution: node10/classic`. O
`tsconfig.json` atual já declara `types: ["node"]` e `rootDir` explícito no build, então o dano é
contido — **mas `baseUrl` está em uso** para resolver `@deepseek-ai/*` e **`--baseUrl` foi removido**.
A migração de `paths` para caminhos relativos ao `tsconfig.json` faz parte de R2.

**Armadilha do type stripping nativo** (importa porque `pnpm run test` roda `.ts` direto): o type
stripping do Node **não suporta `paths` do tsconfig**, nem enums, namespaces com runtime, parameter
properties ou decorators. Os imports de `@deepseek-ai/*` em `src/index.ts` são todos `import type` e
portanto são apagados — funciona hoje **por acidente feliz**. Se algum dia alguém escrever um
`import` de valor desses pacotes, o teste quebra em runtime com erro de resolução e não no
typecheck. Ação: regra de lint `consistent-type-imports` + um teste que roda o entry sob
`node --test` (já coberto pelo smoke do tarball, §6.3).

---

## 6. CI no GitHub Actions

### 6.1 Princípios

- **`permissions: {}` no topo de todo workflow**, com concessão mínima por job. É um dos 23 checks
  do OpenSSF Scorecard (`Token-Permissions`) e é a diferença entre um workflow comprometido conseguir
  ou não escrever no repositório.
- **Actions pinadas por SHA**, nunca por tag (`Pinned-Dependencies`). O Dependabot bumpa os SHAs.
- **`pnpm install --frozen-lockfile` sempre.** Instalação que "conserta" o lockfile em CI significa
  que o CI testou algo diferente do que o desenvolvedor testou.
- **Matriz enxuta.** Cada combinação vira um *required check* a mais e um bloqueio a mais.
- **Nada que precise de segredo roda em `pull_request` de fork.** Publicação e `live` vivem em
  workflows separados, com gatilhos próprios. `e2e` roda em PR porque é **offline**.
- **Nenhum job de PR fala com a internet além do registry.** Nada de subir túnel em PR.

### 6.2 Matriz de Node

| Versão | Entra? | Motivo |
| --- | --- | --- |
| 20.x | Não | EOL em 30/04/2026 |
| 22.x | Não | Em maintenance até 30/04/2027, mas o pacote declara `engines: node >=24`. Testar em 22 um pacote que declara `>=24` não é cobertura, é ruído |
| 24.x | **Sim** | Active LTS. Versão de referência (`.nvmrc`) |
| 26.x | **Sim** | Vira LTS em 28/10/2026. Entra agora para pegar quebra cedo. **A justificativa anterior ("a flag de type stripping foi removida nela") saiu**: essa afirmação não tem lastro em `08-PESQUISA-E-FONTES.md` e virou pergunta do spike da Onda 0 (09 §D24 item 6). A razão escrita da matriz é **apenas** `engines: node >=24` |
| macOS 24.x | **Sim, 1 combinação** | `detached` + `process.kill(-pid)` e reparenting têm semântica própria no darwin; o supervisor depende disso |

Decisão acoplada: **não dá para baixar `engines` para `>=22` sem mudar o comando de teste** (os
testes passariam a rodar contra `dist/` compilado em vez de `.ts`). Se `01-ARQUITETURA.md` exigir
Node 22, as duas coisas mudam juntas.

Windows: **fora da matriz**, deliberadamente. O supervisor de processo depende de grupos POSIX
(`detached: true` + `process.kill(-pid)`); suportar Windows exigiria `taskkill /PID <pid> /T /F` ou
Job Objects (que o Node não expõe). Declarar `"os": ["linux", "darwin"]` no `package.json` é mais
honesto do que fingir portabilidade não testada.

### 6.3 `ci.yml` — o gate de PR

```yaml
name: CI
on:
  push:    { branches: [master] }
  pull_request:
  workflow_dispatch:

# Nada por padrão. Cada job pede exatamente o que precisa (Scorecard: Token-Permissions).
permissions: {}

concurrency:
  # Cancela runs velhos do mesmo PR: economiza minutos e evita merge com CI defasado verde.
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>          # pinado por SHA, não por tag
      - uses: pnpm/setup@<SHA>                # action OFICIAL: instala pnpm 11+ E o runtime num passo,
        with: { node-version-file: .nvmrc }   # lendo packageManager/devEngines. Substitui
                                              # actions/setup-node + pnpm/action-setup (este, deprecado)
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint                        # = "oxlint . && eslint ." (09 §D4). O job chama o SCRIPT,
                                              # nunca os binários soltos: o gate de onda roda `pnpm lint`
                                              # e CI e local têm que ser a mesma coisa

  typecheck:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck                   # `tsc --noEmit` hoje; vira `tsc6 --noEmit` no commit de T1.2
      - run: pnpm exec tsc7 --noEmit          # TS 7.0: 8-12x mais rápido, pega erros novos
        continue-on-error: true               # INFORMATIVO enquanto a API 7.x não estabiliza (7.1)

  test:
    runs-on: ${{ matrix.os }}
    permissions: { contents: read }
    strategy:
      fail-fast: false                        # queremos ver TODAS as combinações que quebraram
      matrix:
        os: [ubuntu-latest]
        node: ['24', '26']
        include:
          - { os: macos-latest, node: '24' }  # semântica de process group no darwin
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/setup@<SHA>
        with: { node-version: ${{ matrix.node }} }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test                        # unit + integration. Cobertura é OUTRO job (`coverage`),
                                              # porque um `test` que também mede cobertura é dois
                                              # comandos disfarçados de um (09 §D4)

  # A invariante de bind NÃO é um script próprio: `test:invariants` foi absorvido por
  # `test:security` (09 §D4). O teste nomeado que falha quando alguém alarga o bind é
  # TENSAO-001 / mutante M-47 de `04-TESTES.md`, e ele roda no job abaixo.
  test-security:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:security               # suíte adversarial: lista fechada de ataques (04 §6)

  test-contract:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:contract               # símbolos reais dos .d.ts do npm (§11). Precisa de rede

  test-e2e:
    # OFFLINE. Só dublês (test/bin/fake-cloudflared.mjs). NUNCA sobe túnel real — isso é o
    # workflow `live.yml`, que não é required check (§6.4, 09 §D10).
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:e2e
      - name: Nenhum processo sobreviveu
        if: always()
        run: '! pgrep -f fake-cloudflared'     # vazar processo em teste é bug, não ruído

  coverage:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:cov                     # pisos globais: 90 linhas / 85 branches / 95 funções
      - name: Catraca
        # Falha se o número CAIR em relação ao valor commitado, mesmo acima do mínimo.
        # Piso por módulo de decisão de segurança é 95/90 (04-TESTES §11.1, 09 §D17):
        # src/http, src/secret, src/session, src/ratelimit, src/control, src/state, worker/auth.
        run: node scripts/coverage-ratchet.mjs

  build:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm exec publint                # exports/types/campos do package.json
      - run: pnpm exec attw --pack .          # 12 classes de problema de tipos (Masquerading as CJS/ESM…)
      - run: node scripts/check-tarball.mjs   # dist/ + cordis.patch.yml + LICENSE presentes; docs/plano fora
      - name: Smoke do artefato publicado
        # Instala o TARBALL, não o workspace. Pega erro de `files`, de `exports` e de ESM
        # que nenhum teste de unidade pega.
        run: |
          pnpm pack --pack-destination /tmp
          mkdir -p /tmp/smoke && cd /tmp/smoke && npm init -y >/dev/null
          npm i /tmp/dsh-guarded-bot-orchestrator-*.tgz
          node --input-type=module -e "const p=await import('dsh-guarded-bot-orchestrator'); if(typeof p.apply!=='function') process.exit(1)"

  changeset:
    # Cobra o changeset. Falha só se o PR mexeu em src/ ou cordis.patch.yml
    # sem changeset e sem a label `no-changeset`.
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: read }
    steps:
      - uses: actions/checkout@<SHA>
        with: { fetch-depth: 0 }              # `changeset status` precisa do histórico
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec changeset status --since=origin/master

  secrets-scan:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<SHA>
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@<SHA>   # regra custom: `bot\d+:[\w-]+` (token do Telegram vai na URL)
```

> `pnpm/setup@v2` é hoje o action oficial: instala pnpm 11+ **e** o runtime num passo, lendo a versão
> de `packageManager`/`devEngines`. `pnpm/action-setup` está deprecado (só pnpm ≤ 10). Se ficar com
> `actions/setup-node`, use `cache: 'pnpm'` e `node-version-file`
> ([actions/setup-node](https://github.com/actions/setup-node)).

### 6.4 Workflows separados

| Workflow | Gatilho | O que faz |
| --- | --- | --- |
| `dsh-compat.yml` | `schedule` diário + `workflow_dispatch` | Baixa os tarballs reais de `@deepseek-ai/*` em cada rc da faixa suportada, regenera `types/`, roda `test:contract` e **abre issue automática** se divergir (§11) |
| `release.yml` | `push` em `master` | Changesets: abre/atualiza o PR "Version Packages"; ao merge, publica no npm via OIDC (§8) |
| `scorecard.yml` | `schedule` semanal | OpenSSF Scorecard, upload de SARIF, `publish_results: true` para alimentar o badge |
| `codeql.yml` | `schedule` semanal + PR | CodeQL `javascript-typescript` |
| `live.yml` | **`workflow_dispatch` apenas**, e ainda exige `DSH_GUARD_LIVE_TESTS=1` | Roda `pnpm test:live` (`test/live/**`): sobe DSH + **túnel real**. Nunca automático: um quick tunnel exposto é descobrível em segundos (§1.3), e o CI é ambiente compartilhado. **Não** é required check. O que roda em PR é `test-e2e`, que é **offline** e usa `test/bin/fake-cloudflared.mjs` (09 §D10) |

### 6.5 Required checks e branch protection

`master` protegida, com:

- **Required status checks** — exatamente estes doze, nada mais (lista canônica de 09 §D14):
  `lint`, `typecheck`, `build`, `test (ubuntu-latest, 24)`, `test (ubuntu-latest, 26)`,
  `test (macos-latest, 24)`, `test-contract`, `test-security`, `test-e2e`, `coverage`,
  `changeset`, `secrets-scan`.

  **Não** são required: `dsh-compat` (nightly, depende de rede — falha abre issue),
  `live` (túnel real, `workflow_dispatch`), `scorecard`, `codeql` e `example-smoke`
  (informativo até a Onda 7).

  `test-security` e `coverage` entram na lista porque a suíte adversarial **é** o núcleo do produto —
  um PR que a quebre não pode entrar — e porque a catraca de cobertura protege exatamente os módulos
  de decisão de segurança. A versão anterior desta lista não tinha nenhum dos dois.
- **Require branches to be up to date before merging**: ligado.
- **Require a pull request before merging**, 1 aprovação, **dismiss stale approvals** a cada push.
- **Require review from Code Owners**, com `CODEOWNERS` cobrindo os módulos de decisão de segurança
  da árvore canônica: `src/http/**`, `src/secret/**`, `src/session/**`, `src/ratelimit/**`,
  `src/state/**`, `src/control/**`, `src/dsh/**`, `src/contracts/**`, `worker/auth/**`, além de
  `SECURITY.md`, `cordis.patch.yml` e `.github/workflows/**`. (`src/gate/**` não existe nesta
  árvore.)
- **Require signed commits**: ligado.
- **Require linear history** + squash merge apenas — combina com Conventional Commits no **título do
  PR** (§7.1).
- **Block force pushes**, **restrict deletions**.
- **Administradores incluídos** (`Do not allow bypassing`). Num repo de um autor só, sem essa trava a
  proteção é decorativa.

Rulesets e branch protection **coexistem** — todas as regras aplicáveis se somam, e branch protection
**não** está deprecado
([docs GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).
Use rulesets se quiser alternar enforcement sem apagar a regra; caso contrário a proteção clássica
basta.

---

## 7. Versionamento e release

### 7.1 Conventional Commits: sim — no título do PR

Com squash merge, o commit que entra na `master` **é o título do PR**. Logo, o enforcement vai num
job de lint do título do PR, não num `commitlint` de hook local (que só disciplina quem lembra de
instalar o hook). Tipos: `feat`, `fix`, `sec` (impacto de segurança — extensão local ao spec,
deliberada, porque neste projeto isso merece grepabilidade), `perf`, `docs`, `test`, `build`, `ci`,
`refactor`, `chore`.

### 7.2 Changesets, não semantic-release

**Escolha: `@changesets/cli` 3.0.1.**

| Critério | Changesets | semantic-release |
| --- | --- | --- |
| Quem decide o bump | Autor do PR, explicitamente | Inferido do prefixo do commit |
| Changelog | Escrito à mão, em prosa | Gerado da mensagem de commit |
| Prerelease / `0.x` acompanhando rc do upstream | Modo prerelease de primeira classe | Possível, mas é configuração de plugin |
| Release agrupada / atrasada | Natural (acumula changesets, versiona quando quiser) | Publica a cada merge |
| Fluxo de aprovação humana | PR "Version Packages" revisável | Nenhum |

Três razões específicas deste projeto:

1. **É um plugin de segurança.** "Isto é breaking?" não pode ser decidido pelo prefixo que alguém
   digitou às pressas. Mudar o gate de `401` para `403`, ou mudar o formato do hash da senha, é
   breaking para quem já instalou mesmo que o commit diga `fix:`.
2. **A versão do plugin é acoplada à rc do upstream** (§11). A mudança mais frequente vai ser
   *"nenhuma linha de código mudou, mas a faixa de compatibilidade mudou"* — um changeset `patch` com
   texto explicando. semantic-release não tem como inferir isso de um commit.
3. **Changelog legível importa aqui mais que na média**, porque atualizar mexe no que está exposto na
   internet do usuário.

Config (`.changeset/config.json`): `baseBranch: "master"` (o default do upstream é `master`, não
`main`), `access: "public"`, `commit: false`, `updateInternalDependencies: "patch"`.

**NÃO CONFIRMADO:** não encontrei documentação oficial do Changesets sobre interação com provenance/
OIDC do npm. O `release.yml` de §8.2 chama `changeset publish` com o npm CLI já autenticado por OIDC,
o que **deve** funcionar porque o publish é do próprio npm CLI — mas isso precisa ser validado numa
release de teste antes de virar promessa.

### 7.3 Esquema de versão

Enquanto o DSH estiver em developer preview, o plugin fica em **`0.x.y`**:

| Mudança | Bump |
| --- | --- |
| Quebra para instalações existentes (config, formato do segredo, comportamento do gate, schema do patch) | **minor** — em `0.x`, minor é o "major" |
| Adaptação a nova rc do DSH que **não** quebra o usuário | patch |
| Feature nova retrocompatível | patch (ou minor, se mudar a superfície de configuração) |
| Correção de segurança | patch, **e** entrada `SECURITY:` no CHANGELOG, **e** advisory se houver CVE |

`1.0.0` só quando o DSH sair de developer preview. Enquanto o README upstream disser *"expect
breaking changes"*, `1.0.0` seria promessa que não se pode cumprir.

### 7.4 Tags

Tags anotadas `v0.3.1`, criadas pelo `changeset publish` (`--git-tag`), assinadas (`git config
tag.gpgsign true`). Uma GitHub Release por tag, com o corpo puxado do CHANGELOG e o `.tgz` anexado
como asset — o tarball anexado também serve de fallback de instalação (`tarball:` no registro DSH) e
alimenta `Signed-Releases` do Scorecard.

---

## 8. Publicação no npm

### 8.1 O terreno mudou nos últimos 12 meses

| Fato | Data | Consequência aqui |
| --- | --- | --- |
| Tokens **classic** permanentemente revogados | 09/12/2025 | Não existe mais o caminho "cola `NPM_TOKEN` no secret e esquece" |
| Granular tokens com vida **máxima de 90 dias** | — | Token em secret vira rotação trimestral obrigatória — mais uma razão para OIDC |
| `npm login` dá sessão de **2 h** | — | Publicação manual é exceção, não processo |
| 2FA ligado por padrão em pacotes novos | — | Configurar 2FA **antes** do primeiro publish |
| Malware scanning no publish | desde 28/07/2026 | Atraso típico ~5 min, até 15+ em pico. Automação pós-publish precisa de **retry**, não de `sleep` fixo |
| Tokens GAT com bypass-2FA perderam operações sensíveis | 31/07/2026 | E perdem publish direto por volta de jan/2027 |

**Decisão: Trusted Publishing (OIDC), sem `NPM_TOKEN` em lugar nenhum.**

### 8.2 Trusted Publishing (OIDC) — pré-requisitos e esqueleto

Pré-requisitos, todos verificáveis antes de tentar:

1. npm CLI **≥ 11.5.1** no runner.
2. `permissions: { id-token: write }` no job de publish.
3. Campo `repository` no `package.json` batendo **exatamente** com o repo.
4. Configuração **por pacote** em `npmjs.com/package/<nome>/access`, apontando owner/repo/workflow.
5. Runner **cloud** (self-hosted não é suportado).

```yaml
name: Release
on:
  push: { branches: [master] }

permissions: {}

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # criar tag e GitHub Release
      pull-requests: write   # abrir/atualizar o PR "Version Packages"
      id-token: write        # OIDC do trusted publishing — o motivo de existir este job
    steps:
      - uses: actions/checkout@<SHA>
        with: { fetch-depth: 0 }
      - uses: pnpm/setup@<SHA>
        with: { node-version-file: .nvmrc }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build

      - name: npm >= 11.5.1 (exigência do trusted publishing)
        run: npm i -g npm@latest && npm --version

      - uses: changesets/action@<SHA>
        with:
          version: pnpm exec changeset version   # se há changesets: abre o PR de versão
          publish: pnpm exec changeset publish   # se não há: publica o que estiver versionado
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # SEM NPM_TOKEN. A autenticação é o OIDC do job.
          NPM_CONFIG_PROVENANCE: 'true'          # cinto e suspensório: sob trusted publishing a
                                                 # provenance é automática no GHA, mas há relatos
                                                 # consistentes de precisar do flag explícito
```

Depois do primeiro publish bem-sucedido, marcar **"Require 2FA and disallow tokens"** no pacote.
A partir daí, nem um token vazado publica.

**Staged publishing (opcional, avaliar depois do primeiro release):** `npm stage publish` →
`npm stage list/view/download` → `npm stage approve` com 2FA (npm CLI ≥ 11.15.0, Node ≥ 22.14.0). O
CI publica, o humano aprova. Para um plugin de segurança é o modelo certo a médio prazo; adotar já no
primeiro release adiciona um passo manual antes de haver rotina.

### 8.3 O que vai no tarball

O `files` atual publica `src/` e `types/`. **Isso muda.**

```jsonc
"files": [
  "dist",              // o que o Node carrega de node_modules
  "cordis.patch.yml",  // o manifesto de injeção; sem ele o pacote é inútil
  "README.md",
  "LICENSE",
  "CHANGELOG.md"
]
```

`README.md`, `LICENSE` e `package.json` o npm inclui sempre; declarar é documentação.

- **`src/` sai.** Não é carregado de `node_modules` (o Node recusa type stripping dentro de
  `node_modules`: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) e só engorda o pacote. Quem quer o
  fonte tem o repo e os `sourceMap` de `dist/`.
- **`types/` sai.** São shims de pacotes de terceiros para **compilar aqui**; publicá-los pode causar
  colisão de tipos no consumidor. Os tipos publicados são os `dist/*.d.ts`.
- **`docs/`, `test/`, `scripts/`, `.github/` ficam fora** por omissão.
- **`dist/worker/` vai junto.** O worker do Telegram é processo separado, mas mora no mesmo tarball
  (§2.1): `tsconfig.build.json` compila `src/` **e** `worker/`.
- Verificação em CI: `node scripts/check-tarball.mjs` roda `npm pack --dry-run --json` e falha se
  faltar `dist/index.js`, `dist/index.d.ts`, **`dist/worker/telegram-bot.js`**, `cordis.patch.yml` ou
  `LICENSE`, **ou** se aparecer qualquer coisa sob `src/`, `types/`, `test/`, `docs/` ou `.env`.
  Esta é a asserção canônica (09 §D13) e é a mesma que `04-TESTES.md` §10 item 4 verifica — o smoke
  de release e o CI checam o **mesmo** conjunto, invertido em relação à versão antiga (que exigia
  `src/` e `types/` **dentro** do tarball, contra o `files` que este documento define).

### 8.4 Por que publicar **pré-compilado** e não instalar por git

Quatro razões, em ordem de força:

1. **`pnpm ≥ 10` não roda scripts de build de dependência por padrão** — e o pnpm 11 endureceu mais
   (`allowBuilds` explícito). Instalar por `github:owner/repo` significa que o `prepare` que compila
   o TypeScript **não roda**, e o consumidor recebe um pacote sem `dist/`. Falha silenciosa e
   confusa. O mesmo vale para o npm v12, que passou a exigir `npm approve-scripts --allow-scripts-pending`.
2. **É o padrão canônico do ecossistema:** `dsh plugin --profile web add <pkg-npm>` nas 1.650 entradas
   do registro. Instalação por git é o caminho de exceção
   ([awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)).
3. **Velocidade e determinismo:** segundos contra um clone; tarball imutável contra um branch móvel.
4. **Provenance:** só o pacote npm carrega a attestation SLSA. `github:owner/repo` não carrega
   procedência de nada.

O nome `dsh-guarded-bot-orchestrator` estava **livre** no registry (HTTP 404 em 19/08/2026).
Publicar um `0.0.1` que só reserva o nome, antes de qualquer divulgação, é barato e evita
name-squatting.

---

## 9. Empacotamento específico do DSH

### 9.1 Bundle vs Profile — a decisão pendente, e a saída que não estava no mapa

Situação: o `package.json` omite `dsh.bundle` **de propósito**, e a chave `//dsh` documenta o
porquê — declarar registaria o mesmo `cordis.patch.yml` como Camada 1 (Bundle) além da Camada 2
(Profile), criando duas verdades sobre onde o manifesto entra.

O `contributing.md` do registro diz que `dsh.bundle` é o **check #1** e que *"declaring only
`dsh.client` fails here"*, com o exemplo marcando `"bundle": { "patch": "./cordis.patch.yml" }` como
`← required`. Daí a leitura natural — e **errada** — de que só existem três opções: declarar um patch
mínimo distinto, declarar o mesmo arquivo e aceitar a dupla camada, ou desistir do registro.

**O gate real não exige `.patch`.** O código que decide é
[`scripts/check-submission.mjs`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/check-submission.mjs):

```js
if (dsh.bundle) return { ok: true }                 // L193
if (dsh.bundle) { /* … */ return { ok: true, at: p } } // L153
```

Ele nunca lê `dsh.bundle.patch` e nunca verifica se o arquivo apontado existe. O `← required` do
`contributing.md` é prosa, não gate.

**Decisão: declarar `"dsh": { "bundle": {} }`.** Objeto vazio é truthy em JS, passa o check #1, e
preserva intacta a arquitetura de verdade única que a chave `//dsh` defende. O comentário `//dsh` é
reescrito para registrar isto — incluindo a data e o commit do `check-submission.mjs` conferido, para
que a decisão possa ser reavaliada se o gate mudar.

Duas ressalvas que precisam ficar escritas junto:

- Declarar `bundle.patch` apontando para o **mesmo** `cordis.patch.yml` hoje é ativamente perigoso, e
  não apenas redundante: o arquivo tem `id: '<ID-DA-ENTRADA-DO-SERVIDOR-WEB-NESTA-INSTALACAO>'`
  (placeholder). Com `id` que não casa, deixa de ser *whole-entry replace* e vira *insert* — segunda
  instância do servidor web, conflito de rota, boot rejeitado.
- Resolver o manifesto **não** faz a entrada aparecer no registro: os gates de idade (≥1 dia) e de
  commits (≥10) reprovam de qualquer forma hoje. São problemas independentes.

**NÃO CONFIRMADO:** que o `dsh-market` consiga instalar um pacote cujo `dsh.bundle` é `{}`. O que foi
verificado é que o **CI do registro** aceita. Antes do lançamento, validar uma instalação real pelo
market — e, se o market exigir `patch`, a decisão volta à mesa com um patch de Bundle *mínimo e
distinto* (só o que for seguro aplicar na camada de menor precedência), nunca o mesmo arquivo.

### 9.2 Campos DSH e npm no `package.json` (alvo)

```jsonc
{
  "name": "dsh-guarded-bot-orchestrator",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "repository": {                                 // EXIGIDO pelo trusted publishing; hoje ausente
    "type": "git",
    "url": "git+https://github.com/<owner>/dsh-guarded-bot-orchestrator.git"
  },
  "bugs":     { "url": "https://github.com/<owner>/dsh-guarded-bot-orchestrator/issues" },
  "homepage": "https://github.com/<owner>/dsh-guarded-bot-orchestrator#readme",
  "keywords": [
    "dsh-plugin",        // ← a que importa: 1.909 pacotes a usam; hoje FALTA
    "dsh", "cordis", "cordis-plugin", "deepseek-harness",
    "telegram-bot", "cloudflare-tunnel", "authentication"
  ],
  "dsh": { "bundle": {} },                        // §9.1
  "engines": { "node": ">=24" },
  "os": ["linux", "darwin"],                      // o supervisor depende de process group POSIX
  "packageManager": "pnpm@11.22.0",               // lido pelo pnpm/setup no CI
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "peerDependencies": {                           // §11.2
    "@deepseek-ai/cordis": ">=4.0.0 <5"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis": { "optional": true }   // o host injeta; não forçar instalação
  },
  "dependencies": { "grammy": "1.45.1" },         // UMA. Versão exata. Ver §10 e 09 §D23
  "bin": { "dsh-guard-setup": "./dist/bin/dsh-guard-setup.js" },  // (a) só é instalável com isto
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
}
```

> **PENDÊNCIA DECLARADA — o campo `bin` e a emissão de `bin/` (não resolvida aqui).** A capacidade
> (a) do pedido — *guiar o usuário a conectar o Telegram* — depende de o usuário conseguir rodar
> `dsh-guard-setup` depois de instalar o pacote, e para isso o `package.json` precisa de um campo
> `bin`. O campo está acima. **Mas** `09-DECISOES-CANONICAS.md` §D2 diz que `tsconfig.build.json`
> compila `src/` **e** `worker/` — **não menciona `bin/`**, que é um terceiro diretório de fonte na
> árvore canônica (§D1). Como consequência, `dist/bin/dsh-guard-setup.js` **não é emitido** pela
> regra escrita hoje, e o `bin` acima apontaria para um arquivo inexistente. Este documento **não
> decide sozinho**: registra que a emissão de `bin/` (ou a mudança do caminho do `bin`) precisa ser
> fechada no **COMMIT PREP 7**, junto com `exports` e `repository`, e que `scripts/check-tarball.mjs`
> tem que passar a verificar o alvo do `bin`. Sem isso, o smoke de release (`04-TESTES.md` §10,
> item 10) falha — que é exatamente o comportamento desejado: falhar cedo, não entregar uma CLI que
> não existe.

**Este bloco de `scripts` é o canônico de [09 §D4 e Apêndice A](09-DECISOES-CANONICAS.md), literal.**
Três coisas nele são consequência de decisão, não estilo:

1. **`lint` existe.** O gate de toda onda em `03-ONDAS.md` é
   `pnpm lint && pnpm typecheck && pnpm build && pnpm test`; enquanto o `package.json` não definisse
   `lint`, **toda onda falhava no gate por comando inexistente**. Era o defeito mais barato de
   corrigir e o mais caro de deixar passar.
2. **`tsc`, não `tsc6`.** A troca para `tsc6` é entrega de T1.2 e acontece **no mesmo commit** que
   instala o alias (§5.1).
3. **Um `test` só.** Cobertura vive em `test:cov`; `test:invariants` foi absorvido por
   `test:security`. Dois scripts `test` com semânticas diferentes em dois documentos era garantia de
   que o CI e o gate mediriam coisas distintas.

> **Armadilha operacional (09 §D4):** `node --test` com um glob que **não casa com nenhum arquivo**
> sai com código **1**. Todo diretório de teste criado por um COMMIT PREP nasce com um
> `_placeholder.test.ts` verde, apagado pela primeira sub-tarefa real do diretório.

Na ordem do `exports`: **`types` sempre primeiro, `default` sempre por último**, do mais específico
para o menos específico. `publint` + `attw` no CI existem para pegar exatamente isso.

### 9.3 `cordis.patch.yml`

Fica na **raiz** do repositório e **dentro** do tarball. Três regras que valem como critério de
revisão:

1. **Nenhum segredo literal, e nenhuma credencial vinda do ambiente.** Os valores de **credencial**
   **não** vêm mais de `!!js` lendo `ADMIN_USER`/`ADMIN_PASS`: a senha é gerada por CSPRNG pelo
   próprio plugin e o **digest** vive no `state.json`
   (`$XDG_STATE_HOME/dsh-guarded-bot/state.json`, modo `0600`); o usuário do Basic é fixo (`dsh`).
   O `!!js` continua válido **só** para valores **não sensíveis** de configuração, com IIFE que lança
   se a variável faltar (*fail loud at load*). Autoridade: 09 §D19 e `02-SEGURANCA.md` §8.2 regra 6.
   As linhas do `cordis.patch.yml` que hoje derivam credencial do ambiente são removidas nas
   sub-tarefas que possuem o arquivo (T1.3 / T3.3).
2. **O `id` do *whole-entry replace* é instalação-específica** e continua com placeholder. O
   `docs/INSTALL.md` tem que explicar como descobrir o `id` real, e o README tem que dizer o que
   acontece se ficar errado (vira insert, duplica o servidor web, boot rejeitado).
3. **Toda mudança nele exige changeset**, porque é a superfície de instalação: mudou o patch, mudou o
   que o usuário tem que reinstalar.

### 9.4 Descoberta: topics do GitHub

Adicionar as topics `dsh-plugin` (a que o `deepseek.com/harness` linka em "Community Plugins"),
`dsh`, `cordis`, `deepseek-harness`, `telegram-bot`, `cloudflare-tunnel`, `authentication`,
`self-hosted`. Limites: máximo 20 topics, ≤50 caracteres, só minúsculas/dígitos/hífens, só admins
adicionam
([docs GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)).

Expectativa calibrada: a topic `dsh-plugin` já tem ~8.398 repositórios, com o topo ocupado por
projetos de 12k–167k estrelas. Ela é **obrigatória** (o registro exige) e entrega **quase zero**
descoberta sozinha. O canal que descobre é o registro curado → `dsh-market`. Estratégia completa em
`07-COMUNIDADE.md`.

---

## 10. Supply chain

| Controle | Como | Por que aqui |
| --- | --- | --- |
| Lockfile commitado | `pnpm-lock.yaml` na raiz, `--frozen-lockfile` em todo CI | Sem isso, CI e dev testam árvores diferentes |
| **Uma dependência de runtime** | `"dependencies": { "grammy": "1.45.1" }`, versão **exata**; qualquer adição além dela exige justificativa escrita no PR | A frase "zero dependências de runtime" **saiu** deste documento, do README e de todo material de divulgação (09 §D23): cinco documentos do plano desenham contra a API do grammY (auto-retry lendo `retry_after`, `bot.catch` com `GrammyError`/`HttpError`, `apiRoot` para o dublê, `bot.start({drop_pending_updates})`), e trocar isso por um cliente artesanal na Onda 4 seria reescrever a integração mais chata para preservar um slogan. O argumento honesto e verificável passa a ser: **uma** dependência de runtime, carregada **apenas** pelo processo `worker/`; o plugin host continua usando só builtins `node:` |
| Regra do Renovate para `grammy` | PR separado, sem automerge, com o job `test-e2e` como gate | É a única dependência de runtime: um bump dela é mudança de superfície de rede, não rotina |
| Renovate | `renovate.json`, app Mend | Bump de devDeps. Regra especial: `@deepseek-ai/*` **nunca** automerge, sempre PR separado com o job `dsh-compat` como gate |
| Dependabot | `.github/dependabot.yml`, **só** `github-actions` | Bumpa os pins de SHA das actions (`Pinned-Dependencies` do Scorecard) sem duplicar o Renovate no npm |
| `minimumReleaseAge` | Default do pnpm 11: **1440 min (1 dia)** | Janela contra pacote comprometido recém-publicado. Não baixar. Interage com Renovate: PR de release fresca fica bloqueado por um dia — é intencional |
| `blockExoticSubdeps` | Default `true` no pnpm 11 | Bloqueia subdependência vinda de git/URL |
| Scripts de instalação | pnpm 11: `allowBuilds` explícito. npm v12: `npm approve-scripts` | Nenhuma dependência deste projeto deve precisar de build script; se um dia precisar, é sinal de alerta |
| `npm audit` | `pnpm audit --audit-level=high` no CI, não-bloqueante | Com zero deps de runtime é quase sempre verde; serve para pegar devDep comprometida |
| `npm audit signatures` | No job de release, pós-publish | Verifica assinaturas do registry e attestations Sigstore |
| SBOM | `npm sbom --sbom-format cyclonedx` anexado à GitHub Release | Nativo no CLI; barato de gerar e é o que um adotante corporativo pede |
| OpenSSF Scorecard | `scorecard.yml` semanal + badge | 23 checks. Os que este repo precisa mirar: `Branch-Protection`, `Token-Permissions`, `Pinned-Dependencies`, `Dangerous-Workflow`, `Signed-Releases`, `Dependency-Update-Tool` |
| Provenance | Automática sob trusted publishing no GHA (§8.2) | Liga o tarball ao commit e ao workflow que o produziu |
| `.npmrc` × `pnpm-workspace.yaml` | No pnpm 11, `.npmrc` é **só** auth/registry; config funcional migrou para `pnpm-workspace.yaml` | Errar isso faz a config ser silenciosamente ignorada |

Duas notas operacionais:

- **pnpm 11 exige Node 22+ e é ESM puro.** Compatível com a matriz (24/26).
- **O malware scanning do npm atrasa a disponibilidade do pacote** (~5 min, até 15+). O smoke test
  pós-release precisa de **retry com backoff**, não de `sleep 60` — senão a release fica vermelha por
  motivo errado.

---

## 11. Compatibilidade com um upstream em developer preview

O README do DSH avisa: *developer preview, expect breaking changes*. Todo o ecossistema está em
`0.0.1-rc` / `0.1.0-rc`. Isto não é um risco a mitigar depois; é a condição normal de operação do
repositório.

### 11.1 Regra fundadora: `types/` passa a ser **gerado**, nunca escrito

Os `.d.ts` em `types/` hoje foram escritos à mão a partir dos markdowns em `~/Documents/deepseek-harness`
e estão **errados**. O que a verificação contra os tarballs reais do npm mostrou:

| O que está em `types/` e no `src/` | O que existe de verdade | Efeito |
| --- | --- | --- |
| `@deepseek-ai/dsh-host-subprocess` | **404 no npm.** O real é `@deepseek-ai/dsh-subprocess` (definição) + `@deepseek-ai/dsh-subprocess-local` (implementação, usa `node-pty`) | Import quebra o build |
| `ctx.webServer`, tipo `WebServer`, `inject: ['webServer']`, `ctx.intercept('webServer', …)` | `ctx.httpServer`, classe `HttpServerService` (typings de `@deepseek-ai/dsh-host-webserver`: `interface Context { httpServer: HttpServerService }`). O símbolo `WebServer` **não existe** | O `inject` não resolve; o `intercept` não intercepta nada |
| `ctx.subprocess.spawn(cmd, args, opts)` | `abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle` — objeto único com `argv`, `cwd`, `stdio`, `graceMs` obrigatórios e `signal?` | Não há migração "por cima": toda chamada é reescrita |
| `dsh-host-frontend` | `@deepseek-ai/dsh-host-frontend-static` | Nome errado em documentação |
| `WebRoute` | **existe e está correto** | Nada a fazer |

O que **está certo** e se mantém: `ctx.intercept(name, config)`, `ctx.waterfall`, `ctx.parallel`,
`ctx.effect`, `inject`, `Service`, Fibers e disposers — todos confirmados nos `.d.ts` reais de
`@deepseek-ai/cordis@4.0.1`. O nível arquitetônico dos markdowns bate com o código; o nível de API,
não.

**Regra:** `scripts/fetch-dsh-types.mjs` baixa os tarballs npm **pinados por versão exata**, extrai
`lib/types/*.d.ts` para `types/deepseek-ai/` e falha se o hash mudar sem que o pin tenha mudado.
`types/` entra no `.gitattributes` como `linguist-generated=true`. Editar `types/` à mão vira falha
de review — está no `CONTRIBUTING.md`.

### 11.2 Como declarar a faixa suportada

Três camadas, porque nenhuma sozinha resolve:

1. **`peerDependencies` com `optional: true`** para `@deepseek-ai/cordis` (`>=4.0.0 <5`). Sinaliza
   intenção e aparece no npm, sem forçar instalação de um pacote que o host injeta.
   **Não** declarar peer de `dsh-host-webserver` com pin de rc: um pin exato como peer transformaria
   cada rc do upstream numa falha de instalação para o usuário. O pin exato vive no
   `scripts/fetch-dsh-types.mjs` (build-time), não no `peerDependencies`.
2. **`docs/COMPATIBILITY.md`, gerado.** Tabela `versão do plugin × faixa de rc do DSH × status`,
   produzida por `scripts/gen-compat-table.mjs` a partir do resultado do `dsh-compat.yml`. É a fonte
   de verdade citada pelo README e pelo `SECURITY.md`.
3. **Verificação em runtime por *forma*, não por número de versão.** No `apply()`, `src/dsh/adapter.ts`
   confere que os serviços têm a forma esperada (`typeof ctx.httpServer?.registerFallback ===
   'function'` etc.) e, se não tiverem, **lança no carregamento** com mensagem que nomeia o símbolo
   ausente e a faixa testada. Isso vale mais que checar string de versão: o upstream renomeia
   serviço sem bumpar major (está em `0.x`, pode).

   **NÃO CONFIRMADO:** que exista qualquer campo do `package.json` ou do `cordis.patch.yml` que o DSH
   leia para negociar compatibilidade (algo como `dsh.compatibility` ou `engines.dsh`). Nada nos
   `.d.ts` nem nos READMEs verificados sugere isso. Enquanto não for confirmado, a faixa suportada é
   **documentação + asserção em runtime**, não contrato declarativo.

### 11.3 Runbook: o upstream quebrou

Gatilho: `dsh-compat.yml` falha à noite, ou chega uma issue `02-compat-break`.

| Classe de quebra | Sinal | Ação |
| --- | --- | --- |
| Serviço renomeado (`webServer` → `httpServer`) | `test:contract` acusa símbolo ausente | Ajustar **só** `src/dsh/adapter.ts`; changeset `patch`; atualizar `COMPATIBILITY.md` |
| Assinatura mudou (`spawn(cmd,args,opts)` → `spawn(spec)`) | Typecheck quebra contra os `.d.ts` novos | Ajustar o adapter; se o **usuário** perceber diferença, o bump é minor |
| Evento removido (ex.: `http/auth-check`) | Contrato quebra; teste de integração fica verde falsamente | Prioridade máxima: um waterfall que não roda é gate que não protege. Ver `04-TESTES.md` |
| Schema do `cordis.patch.yml` mudou | O DSH rejeita o boot | Bump **minor** (o usuário tem que reinstalar o manifesto), aviso em destaque no CHANGELOG |
| Pacote novo/removido no escopo `@deepseek-ai` | `fetch-dsh-types.mjs` falha | Atualizar pins; investigar se há capability seam nova a usar |

Procedimento fixo:

1. Reproduzir com a rc pinada — nunca com `latest`.
2. Abrir issue rotulada `upstream-break` com a rc antiga, a rc nova e o símbolo afetado.
3. Corrigir **no adapter**, não espalhado.
4. Decidir a faixa: manter **N e N-1** rc suportadas. Mais que isso vira matriz insustentável.
5. Release com changeset e `COMPATIBILITY.md` regenerado.
6. Se a quebra for **de segurança** (ex.: o gate deixou de interceptar em silêncio): advisory,
   entrada `SECURITY:` no CHANGELOG, e nota no README dizendo qual faixa **não** deve ser usada
   exposta à internet.

**Política de pin do usuário:** o `INSTALL.md` recomenda instalar a rc do DSH **pinada por versão
exata**, não `latest`. É a única forma de o usuário não acordar com o gate desligado por um bump que
ele não pediu.

---

## 12. Onde este documento entra no plano de ondas

**Este documento NÃO define ondas.** A autoridade de sequenciamento é
[`03-ONDAS.md`](03-ONDAS.md), e ele é o único plano de execução consumido pelo `deep-orchestrator`
(decisão canônica 09 §D20). A versão anterior desta seção descrevia ondas próprias `R0–R4`, que
concorriam com as Ondas 0–7 de 03 e com as ondas `C0–C9` de `07-COMUNIDADE.md` — três
sequenciamentos incompatíveis para o mesmo trabalho.

O conteúdo de R0–R4 continua válido; o que muda é **onde ele acontece**:

| Onda antiga deste documento | Passa a ser | Observação |
| --- | --- | --- |
| **R0** — fundação do repositório (LICENSE, CoC, CONTRIBUTING, SECURITY.md, templates, CODEOWNERS, `.editorconfig`, topics) | **Onda 1, T1.4** | Junto com C1 de `07-COMUNIDADE.md` |
| **R0** — reservar o nome no npm com um `0.0.1` stub | **Onda 1, T1.4** | Reservar **cedo** é a decisão canônica (09 §D21): o risco é name-squatting entre o anúncio e a publicação, e o custo de reservar é uma publicação de 2 minutos |
| **R1** — verdade dos tipos (`fetch-dsh-types.mjs`, substituir `types/`, renomear `webServer`→`httpServer`, reescrever `spawn`) | **Onda 0, T0.1** (descoberta e contrato) **+ Onda 1, T1.1** (aplicação no código) | `test/contract/dsh-types.test.ts` é de T0.1 |
| **R2** — qualidade e CI (`oxlint`/`eslint`, `ci.yml`, branch protection, migração TS 6, remoção de `baseUrl`, `check-tarball.mjs`) | **Onda 1, T1.2** | T1.2 é dona de `package.json` e de `.github/workflows/**` na Onda 1 |
| **R3** — release e publicação (Changesets, trusted publishing, `release.yml`, Scorecard, SBOM) | **Onda 7, T7.2** | Com a ressalva de 09 §D25 item 23: T7.2 entrega `.changeset/**` e `release.yml`, e **T7.1** (dona do `package.json`) acrescenta `@changesets/cli` e o script `changeset`. T7.2 não escreve `package.json` |
| **R4** — manutenção contínua (Renovate, Dependabot, `dsh-compat.yml` nightly, `COMPATIBILITY.md` gerado, CodeQL) | **pós-T7.4**, ritual mensal | Documentado em `07-COMUNIDADE.md` §13.6. `docs/COMPATIBILITY.md` é **gerado**: o ritual roda o workflow, nunca edita o arquivo à mão |

Os critérios de aceite que estavam nas tabelas R0–R4 continuam válidos como **critérios de aceite das
sub-tarefas correspondentes de 03** e estão reproduzidos abaixo, agrupados por destino, para que
nenhum se perca na migração:

| Destino | Aceite verificável |
| --- | --- |
| T0.1 | `scripts/fetch-dsh-types.mjs` roda a partir do cache e falha se o hash divergir do pin; `pnpm typecheck` verde **sem** `paths` para `dsh-host-subprocess`; `test/contract/dsh-types.test.ts` falha de propósito ao renomear um símbolo no shim |
| T1.1 | `git grep -nE "webServer\|dsh-host-subprocess\|dsh-host-frontend"` devolve zero fora de tabela de correção; toda chamada de `spawn` está na forma `spawn(spec)`; typecheck verde |
| T1.2 | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` verdes; um PR de teste dispara os **doze** required checks do §6.5 e todos passam; push direto na `master` é recusado, inclusive para admin; o job `build` falha se `cordis.patch.yml` sair do `files` |
| T1.4 | GitHub community profile 100%; `gh repo view --json repositoryTopics` inclui `dsh-plugin`; abrir issue de teste mostra os 3 forms e nenhum blank issue; `npm view dsh-guarded-bot-orchestrator` retorna 200 |
| T7.1 / T7.2 | `changeset status` roda e o job `changeset` cobra changeset em PR que toca `src/`; um release `0.1.0-rc.0` publica **sem** `NPM_TOKEN` e com provenance; página `access` do pacote mostra repo/workflow; badge do Scorecard renderiza com score real; `.cdx.json` nos assets da Release |
| pós-T7.4 | PR de bump de `@deepseek-ai/*` fica aguardando review (sem automerge); PR de bump de SHA de action aparece; falha simulada do `dsh-compat` abre issue automática; `docs/COMPATIBILITY.md` bate com o último run |

---

## 13. Definition of Done do repositório

O repositório está "pronto para divulgar" quando **todas** estas afirmações forem verdadeiras:

1. `git clone` + `pnpm install --frozen-lockfile` + `pnpm lint` + `pnpm typecheck` + `pnpm build` +
   `pnpm test` passa numa máquina limpa com Node 24, **sem nenhuma variável de ambiente
   configurada** — em particular sem `ADMIN_USER`/`ADMIN_PASS`, que não existem mais no fluxo.
2. Um PR qualquer dispara os **doze** required checks do §6.5 e **nenhum deles precisa de segredo**
   (o único que fala com a rede é `test-contract`, contra o registry público).
3. `npm pack --dry-run` lista `dist/` (incluindo `dist/worker/telegram-bot.js` e
   `dist/bin/dsh-guard-setup.js`), `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md` e
   **nada mais** — sem `src/`, sem `types/`, sem `test/`, sem `docs/`.
4. `publint` e `attw --pack .` passam sem aviso.
5. `SECURITY.md` existe, PVR está ligado, e o `README.md` mostra o risco acima da dobra.
6. A tabela `docs/COMPATIBILITY.md` foi **gerada** por CI e não escrita à mão.
7. O `grep` por `webServer`, `dsh-host-subprocess` e `dsh-host-frontend` no repositório retorna zero
   (fora de tabela de correção histórica).
8. O `grep` por nome morto (09 §D5) retorna zero: `/__mobile`, `/__gate`, `mobile-gateway.json`,
   `ADMIN_USER`, `ADMIN_PASS`, `DSH_TELEGRAM_BOT_TOKEN`, `/vincular`, `/parar_bot`,
   `/desligar_servidor`, `/abrir_tunel`, `test:invariants`, `test/helpers/`.
9. Existe um teste nomeado que falha se alguém alargar o bind — **TENSAO-001**, na suíte
   `test:security` (o script `test:invariants` não existe mais; foi absorvido).
10. Existe um teste nomeado que falha se o túnel subir com o gate desarmado — o probe de 4 sondas
    (`04-TESTES.md` TUN-020…TUN-025).
11. Repo com ≥10 commits e ≥1 dia de idade (gate do registro). Com um COMMIT PREP por onda sendo
    commit próprio, o piso é atingido com folga (`03-ONDAS.md` §0).
12. Um release de teste publicou por OIDC, com provenance, sem `NPM_TOKEN` em lugar nenhum.
13. `examples/minimal/` existe e o job `example-smoke` roda: `401` sem credencial, `200` com,
    `pgrep` vazio ao fim (09 §D22).

---

## 14. Itens NÃO CONFIRMADOS usados neste documento

Lista fechada. Nenhum destes pode virar promessa pública nem critério de aceite sem verificação
humana antes.

| # | Item | Como verificar |
| --- | --- | --- |
| 1 | Que o `dsh-market` instala um pacote cujo `dsh.bundle` é `{}` (o CI do registro aceita — o market não foi testado) | Publicar um pacote de teste e instalar pelo market |
| 2 | Que `changeset publish` funciona sob trusted publishing/OIDC sem `NPM_TOKEN` (não há doc oficial do Changesets sobre isso) | Fazer um release `0.1.0-rc.0` de teste antes do lançamento |
| 3 | Que existe qualquer campo lido pelo DSH para negociar compatibilidade (`dsh.compatibility`, `engines.dsh`) | Ler o código de carregamento de plugin no monorepo clonado |
| 4 | Que `pnpm/setup@v2` lê `packageManager` exatamente como descrito e substitui `pnpm/action-setup` sem ajuste | Rodar o `ci.yml` uma vez e ler o log do step |
| 5 | O comportamento exato do `dsh plugin --profile web add` com pacote npm (o padrão vem das 1.650 entradas do registro, não de doc oficial do CLI) | `dsh plugin --help` na instalação local |
| 6 | Que TypeDoc suporta TS 7 (por isso o plano não inclui geração de API docs por ora) | Verificar o release do TypeDoc quando o TS 7.1 sair |
| 7 | O limite de 50 usuários do plano Zero Trust free (só encontrado em fontes de terceiros e num PDF de 2022) | Página de planos, logado na conta Cloudflare |
| 8 | Que `dsh plugin --profile web add` publica um `bin` no PATH do usuário (a CLI `dsh-guard-setup` depende disso para que a capacidade (a) seja utilizável) | Instalar o tarball numa máquina limpa e chamar `dsh-guard-setup` (`04-TESTES.md` §10, item 10) |
| 9 | Que o Node consegue **spawnar** `dist/worker/telegram-bot.js` a partir de `node_modules` resolvendo o caminho por `import.meta.url` (o `cwd` do DSH não é o do pacote) | Smoke do tarball: instalar e disparar o supervisor do worker |

Fatos que foram **refutados** durante a pesquisa e que este documento deliberadamente **não** usa:

- *"Zero dependência de runtime"* — **retirado deste documento, do README e de todo material
  público** (09 §D23). São **uma** dependência (`grammy`, versão exata), carregada só pelo processo
  do worker. O argumento de venda passa a ser esse, que é verdadeiro.
- *"`dsh.bundle.patch` é obrigatório"* — o gate real só testa `if (dsh.bundle)` (§9.1).
- *"Quick tunnels não suportam SSE, logo não servem para streaming de LLM"* — a citação da doc existe,
  mas foi refutada empiricamente: streaming por **POST** funciona; o bug de buffering é específico de
  **GET**. E este harness usa **WebSocket**, não SSE, no canal de telemetria. Os argumentos legítimos
  contra quick tunnel são outros (sem SLA, hostname rotativo, teto de 200 requisições, sem auth).
- *"Vazar o token do Telegram contorna completamente a allowlist"* — em desenho de long polling não
  contorna; dá personificação, roubo de fila e DoS, não execução local. O vetor real que sobra é o
  usuário legítimo clicar num botão forjado, mitigado por confirmação em duas etapas.
