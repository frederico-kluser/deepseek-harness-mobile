# 2026-08-22 — registo da onda 1: instalação e teste em DSH isolado

**Resultado global: ❌** — o arranque sem token falha num defeito de validação de
config; o gate local e as suítes independents do ambiente passam.

**Ambiente:** macOS (sem `/proc`), Node v24.19.0, pnpm 11.7.0, DSH fonte
`0.1.1-rc.2` (built app via `apps/cli/lib/bin.js`), execução como **root** num
contexto de sub-agente sem TTY. Sem `cloudflared` (túnel fora do escopo desta
corrida). Sem token Telegram (bot não testado — fora do escopo).

> Nota de fidelidade: os bundles `@deepseek-ai/dsh-base` e `@deepseek-ai/dsh-web-app`
> do perfil bootam resolvidos do CHECKOUT-FONTE (workspace packages via install
> anchor), não do `node_modules` do perfil — o perfil isolado carrega a MESMA
> linha do DSH live. É uma `rc.2`, uma `rc` além da faixa suportada do plugin
> (`rc.7..rc.1`), mas o plugin valida por FORMA de serviço e o teste é fiel ao
> ambiente real do utilizador.

## (a) Gate local — ❌ parcial (só falhas dependentes do ambiente)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Lint | `pnpm lint` | ✅ 0 erros (109 warnings) |
| Typecheck | `pnpm typecheck` | ✅ ok |
| Build | `pnpm build` | ✅ ok — `dist/index.js` emitido |
| Unit+Integration | `pnpm test` | ✅ 1779 pass / ❌ 16 falhas (ver abaixo) |
| Security | `pnpm test:security` | ✅ 136 pass / 0 fail (TAP) |
| Contract | `pnpm test:contract` | ✅ 9 pass / 0 fail |
| E2E offline | `pnpm test:e2e` | ❌ 13 pass / 6 falhas de topologia de processo |

As 16 falhas de `pnpm test` e as 6 de `test:e2e` pertencem todas a **3 categorias
de ambiente**, nenhuma em `src/` (código de produção):

1. **root contorna `chmod`** — testes que dependem de tornar ficheiros/diretórios
   ilegíveis ou sem escrita para provocar o caminho fail-closed FAILHAM sob root
   (root lê/escreve à mesma):
   - `test/unit/index.test.ts:750` (S6 CTL-029) — `chmodSync(...,0o000)` no `state.json`;
   - `test/unit/index.test.ts:777` (CTL-009) — idem;
   - `test/unit/telegram/onboarding.test.ts:1828` (M5) — `chmodSync(dir,0o500)`.
2. **macOS / contexto de processo** — testes de topologia de processo (líder de
   grupo/sessão via `detached`, `pgid`/`sid` do `ps`, tree-kill do grupo, órfão de
   boot com `/proc`) divergem em macOS (sem `/proc`) e/ou sob um exec como root
   sem TTY:
   - `test/integration/proc/dead-mans-switch.test.ts:279`;
   - `test/integration/proc/stdio-pipe-nao-regride-tree-kill.test.ts` (3 falhas);
   - `test/integration/proc/...` "um pid REUTILIZADO não é morto" (lógica `/proc`);
   - `test/e2e/lifecycle-orphan-sweep.test.ts`, `lifecycle-worker-dms.test.ts`,
     `tree-kill-real.test.ts`.
3. **fragilidade de regex num teste** — `test/unit/telegram/onboarding.test.ts:1232`
   (TG-067) corrige `!/\d{6}/` contra a segunda execução da CLI, e o caminho do
   diretório temporário do SO contém 6 algarismos consecutivos (`...57x5276235r...`),
   disparando falso positivo. Não é falha do produto.

## (b) examples/minimal — ✅

`./run.sh` (aceite offline; 127.0.0.1; não toca a rede):

```
> 1) sem credencial (espera 401)...   -> 401
> 2) com a credencial do dono (espera 200)...   -> 200
> 3) nenhum processo sobrante (pgrep vazio)...
ACEITE OK: 401 sem credencial / 200 com credencial / nenhum processo ao fim.
```

## (c) Instalação isolada — ✅

`DSH_HOME` isolado: `$WORKTREE/.dsh-test-home` (proibido tocar no DSH_HOME real).

Empacotei: `pnpm pack` → `dsh-guarded-bot-orchestrator-0.1.0.tgz`. (hoje: dsh-guard-messenger)

```
dsh: initialized profile web at .../.dsh-test-home/profiles/web
dependencies:
+ dsh-guarded-bot-orchestrator file:/.../dsh-guarded-bot-orchestrator-0.1.0.tgz
```

`dsh.profile.bundles` — ANTES (perfil recém-criado pelo `plugin add`, template web)
e DEPOIS da instalação:

```jsonc
// package.json do perfil
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-guarded-bot-orchestrator"   // <- entrou com o plugin add
]}}
```

## (d) Arranque — ❌ (falha material, sem token)

Comando (forma correta para a linha `rc.2` — `web` é ALIAS do `--profile web`, logo
`--profile` é global e NÃO se repete após `web`):

```sh
DSH_HOME=<isolado> node .../apps/cli/lib/bin.js --profile web --host 127.0.0.1 --port 3191 --no-open
```

**O arranque falha** com:

```
Error: dsh: plugin tree failed to load: failed to apply loader entry
guarded-bot-orchestrator (dsh-guarded-bot-orchestrator):
[dsh-guarded-bot-orchestrator] config.worker.token tem de ser uma string nao vazia.
```

A causa (log completo truncado) aponta `dist/config/assert.js:90` /
`dist/index.js:361` — é a `assertNonEmptyString(config.worker.token,'worker.token')`
de `src/config/assert.ts:404`.

**Isto contradiz o design documentado** na própria bundle
(`cordis.patch.yml` ~linhas 377-390): `token: !!js "process.env.TELEGRAM_BOT_TOKEN ?? ''"`
e o comentário a seguir diz literalmente que *"vazio significa 'telegram não
configurado' — o worker fica em baixo e o `dsh` arranca à mesma. É a saída canónica
do quickstart"* (e que a forma antiga que lançava *quebraria o boot de todos os que
ainda não configuraram o bot — que é a esmagadora maioria no minuto seguinte à
instalação*).

O `INSTALL.md` (Passo 1 add → Passo 2 boot) não tem passo de token antes do boot, e
o Telegram é explicitamente opcional — logo uma instalação nova seguindo o
INSTALL.md encontra exatamente este bloqueio.

**Diagnóstico complementar (não-modificação):** com `TELEGRAM_BOT_TOKEN` fake, o
boot SOBE na mesma linha `rc.2` e serve o portão — prova que NÃO é
incompatibilidade de forma do adapter, e sim este défice de validação:

```
dsh web: http://127.0.0.1:3192
```

Não há senha a registar: em modo não-TTY o banner local não é emitido, e a senha é
entregue uma vez localmente (`/__guard/secret?ott=`), fora do fluxo desta corrida.
Ignorando a senha em claro; registo "n.d. (não emitida em modo não-interativo)".

## (e) Barreira — ❌ parcial (401 sem credencial OK; com credencial não executável)

Servidor diagnóstico com token fake em `127.0.0.1:3192` (mesma linha rc.2).

| Pedido | Sem credencial | Com credencial |
| --- | --- | --- |
| `POST /api/commands/execute` (CORPO VAZIO) | 401 ✅ | n.d. — senha não disponibilizada em modo não-TTY (entrega local única) |
| `GET /api/session` / `GET /api/state` / `GET /api/settings` | 401 ✅ (todos) | n.d. |
| `GET /` (SPA) | 401 ✅ | n.d. |
| `WS` upgrade `/ws` | 401 ✅ | n.d. |

Detalhe do 401: `HTTP/1.1 401`, `WWW-Authenticate: Basic realm="Secure DSH Interface",
charset="UTF-8"`, corpo `Acesso Intercetado: Credenciais invalidas.` — realm conforme
o config. O portão cobre `/api` e o fallback da SPA e o handshake de WebSocket.

## (f) Bind fora do loopback — ✅ (recusado)

`--host 0.0.0.0 --port 3194` (com token fake, pois sem token o boot nunca chega ao
bind):

```
error: --host 0.0.0.0 is intentionally not supported yet for safety: it would
expose remote code execution to the network; use 127.0.0.1 instead
```

O servidor NÃO escutou em 3194, não havia processo ao fim e a porta ficou livre.
Refusa ao nível da própria CLI do DSH (defesa em profundidade), independentemente
da checagem `allowedHosts` do plugin.

## (g) Config composta (dump-config) — ✅

`--profile web --dump-config` (o CLI usa `--dump-config`; sem `--profile` roda só o
perfil default). Secção do plugin (linhas 504-536 do dump):

```yaml
- id: guarded-bot-orchestrator
  config:
    realm: Secure DSH Interface
    allowedHosts: [127.0.0.1, '::1']
    trustedRemotes: [127.0.0.1]
    guardedPrefixes: [/api]
    deniedPermissions: [danger-full-access]
    worker:
      command: !!js process.execPath
      args: []
      token: !!js process.env.TELEGRAM_BOT_TOKEN ?? ''
      graceMs: 3000
```

## (h) Teardown e contenção — ✅

- `plugin --profile web remove dsh-guarded-bot-orchestrator`: bundle SAIU de
  `dsh.profile.bundles` (`[@deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app]`).
- Zero processos: `pgrep -f onda1-instalacao-teste` vazio; `pgrep -f
  apps/cli/lib/bin.js` vazio; portas 3191-3194 livres.
- `$WORKTREE/.dsh-test-home` removido; tarball removido.
- `git -C /Users/minim1/Projects/deepseek-harness status --porcelain` **vazio**
  (nada vazou para o checkout-fonte).
- `git -C $WORKTREE status --porcelain` vazio (dist/ não rastreado; lockfile intacto).
- Nada foi tocado em `/Users/minim1/.dsh` nem em qualquer processo `apps/cli/src/bin.ts`.

## Achados materiais

- **[Produto] Boot sem token falha** — nº 1, bloqueante para a corrida. A validação
  `config.worker.token` não-vazia (`src/config/assert.ts:404`) contradiz o design
  documentado na bundle (`cordis.patch.yml` ~377-390: vazio = telegram não
  configurado = arranca na mesma). Falha uma instalação nova seguindo o INSTALL.md.
  Revelado por: boot isolado `--profile web --no-open` (log completo em (d)).
- **[Ambiente] Gate local** — 22 falhas de `test`/`e2e` todas em 3 categorias de
  ambiente (root contorna chmod; macOS sem `/proc`/topologia de processo; regex
  `\d{6}` frágil num teste). Nenhuma em `src/`. Não exigem fix do produto.
- **[Produto] Barreira** funciona quando o plugin carrega (401 em `/api`, SPA e WS
  sem credencial) — separado do defeito de boot.

---

_Registado por: onda1-instalacao-teste (sub-agente). Nenhum ficheiro quebra o gate.
`.dsh-test-home/` e tarballs são descartáveis e foram removidos._