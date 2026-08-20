# Spike T0.1 — a API real do DeepSeek Harness

**Onda 0 (Reconhecimento). Fecha S1, S9 e S11.** Execução: 2026-08-19/20, Linux,
Node v24.15.0, pnpm 11.7.0, rede disponível. **Alvo medido:
`@deepseek-ai/dsh-*@0.1.0-rc.7` + `@deepseek-ai/cordis@4.0.1`**; faixa suportada
`@deepseek-ai/dsh 0.1.0-rc.7 .. rc.9` (`06-REPO-E-CI.md`).

> **Q-1 (`05-QUALIDADE-CODIGO.md`): a prosa não é a API.** Nenhuma assinatura
> abaixo vem de um markdown: cada uma vem do `.d.ts` publicado dentro de um
> tarball cujo `sha256` está registado aqui.

> **⚠ ARMADILHA Nº 1 — leia antes de tocar num pino.** A tag `latest` dos
> subpacotes `@deepseek-ai/dsh-*` aponta para a publicação **MAIS ANTIGA**
> (`dsh-host-webserver` `latest` = `0.0.1-rc.1`, 2026-08-10; a linha viva é
> `next` = `0.1.0-rc.8`, 2026-08-19). Pinar por `latest` mede uma API que
> nenhuma composição executa. Esta spike caiu nisso na 1.ª passagem;
> `CONTRACT-003` existe para que ninguém volte a cair.

---

## 1. Qual linha de versão, e porquê

### 1.1 Tabela de dist-tags com datas de publicação (saída bruta)

```
$ npm view @deepseek-ai/dsh dist-tags --json
{ "next": "0.1.0-rc.7", "latest": "0.1.0-rc.7" }

$ for p in <os 5 subpacotes>; do npm view "@deepseek-ai/$p" dist-tags --json; done
<todos: latest = 0.0.1-rc.*, next = 0.1.0-rc.8 — ver a tabela abaixo>

$ npm view @deepseek-ai/dsh-host-webserver time --json     # datas, uma por versão
0.0.1-rc.1 2026-08-10  <- `latest`   |  0.0.1-rc.2/rc.3/rc.5 2026-08-11..12
0.1.0-rc.2/rc.3/rc.6 2026-08-13      |  0.1.0-rc.7 2026-08-17
0.1.0-rc.8 2026-08-19  <- `next`

$ npm view @deepseek-ai/dsh time --json                    # o harness, mesma forma
0.1.0-rc.7     2026-08-17      <- `latest`
0.1.0-rc.7     2026-08-19      <- `next`
```

**`latest` é a publicação mais antiga em todos os subpacotes `dsh-*`.** O cordis
é a exceção: `4.0.1` é `latest` *e* é o que o harness pede.

### 1.2 Qual linha o harness resolve de facto (saída bruta)

```
$ npm view @deepseek-ai/dsh@0.1.0-rc.7 dependencies --json | head
{ "@deepseek-ai/cordis": "^4.0.1", "@deepseek-ai/dsh-base": "^0.1.0-rc.7",
  "@deepseek-ai/dsh-web-app": "^0.1.0-rc.7",
  "@deepseek-ai/dsh-home-paths": "^0.1.0-rc.7", ... }

$ npm install @deepseek-ai/dsh@0.1.0-rc.7 --package-lock-only --ignore-scripts
$ node -e '<lê package-lock.json e imprime as versões resolvidas>'
@deepseek-ai/cordis  4.0.1
@deepseek-ai/dsh-{home-paths,host-frontend-static,host-webserver,subprocess,
                  subprocess-local,storage,base,invariants}   0.1.0-rc.8
```

O `^0.1.0-rc.7` do harness resolve hoje para `0.1.0-rc.8`, a publicação mais
recente da linha viva. **Pinamos `0.1.0-rc.7`** — a versão que o harness `latest`
nomeia literalmente, dentro da faixa `0.1.0-rc.7 .. rc.9` de `06-REPO-E-CI.md`.
Porquê rc.7 e não rc.8, com evidência em §5.4: os `.d.ts` que espelhamos são
**byte-idênticos** entre as duas, e rc.8 é jovem demais para a política de
supply-chain do pnpm, que faz o gate inteiro falhar.

### 1.3 O sinal que denunciava o pino incoerente sem sair dos ficheiros

O `peerDependencies` de `dsh-host-frontend-static@0.0.1-rc.3` exige
`dsh-host-webserver: ^0.0.1-rc.3` — inválido contra `0.0.1-rc.1`; e o JSDoc desse
pacote diz *"context carrying the **webServer** service"*, contradizendo o
espelho irmão. **Dois espelhos byte-exatos a dizerem coisas opostas é sinal de
pino incoerente**, verificável sem rede.

---

## 2. Os pacotes: download, `sha256`, `.d.ts` extraído

```
$ for n in <os 5 subpacotes>; do curl -sSL -O ".../$n-0.1.0-rc.7.tgz"; done
$ curl -sSL -O ".../cordis/-/cordis-4.0.1.tgz"
$ sha256sum *.tgz          # digests na coluna `sha256` da tabela abaixo
```

| pacote | versão | `sha256` | `.d.ts` extraído | destino |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.1` | `31e96b8e…074613` | `lib/types/*.d.ts` (9) | `types/cordis/` |
| `@deepseek-ai/dsh-host-webserver` | `0.1.0-rc.7` | `b5fee946…3ca545` | `{index,invariant}.d.ts` | `types/dsh-host-webserver/` |
| `@deepseek-ai/dsh-subprocess` | `0.1.0-rc.7` | `71d951f6…661b72` | `{index,types,invariant}.d.ts` | `types/dsh-subprocess/` |
| `@deepseek-ai/dsh-subprocess-local` | `0.1.0-rc.7` | `ce00c135…42c67f` | `{index,spawn,process-inspector}.d.ts` | `types/dsh-subprocess-local/` |
| `@deepseek-ai/dsh-host-frontend-static` | `0.1.0-rc.7` | `c0c7364e…96ccb5` | `{index,invariant}.d.ts` | `types/dsh-host-frontend-static/` |
| `@deepseek-ai/dsh-home-paths` | `0.1.0-rc.7` | `a496c609…c41484` | `{index,invariant}.d.ts` | `types/dsh-home-paths/` |

Fontes primárias adicionais, citadas adiante:
`dsh-timeout@0.1.0-rc.8` `sha256 b3b3e42b…fa6c03` (o tecto de `graceMs`) ·
`dsh-terminal-bash@0.1.0-rc.8` (o default de `graceMs`) ·
`dsh-base@0.1.0-rc.8` `sha256 1101c901…1d0e3`.

`terminal.d.ts` e `windows-inspector.d.ts` de `dsh-subprocess-local` NÃO são
espelhados: são os únicos que importam `node-pty`/`koffi` (nativos, com
`postinstall`), e o plugin não os usa. Pelo mesmo motivo `dsh-subprocess-local`
é o único dos seis fora de `devDependencies` — espelhado, **não instalado**.

**Consequência de cobertura, dita por extenso:** sem `node_modules` não há como
comparar `types/dsh-subprocess-local/*.d.ts` (261 linhas) byte-a-byte dentro de
`pnpm test`. CONTRACT-003 verifica nesses três ficheiros o cabeçalho de
proveniência (versão + `sha256`) e o uso de `SubprocessRuntime`; **a igualdade
byte-a-byte só é feita por `pnpm types:fetch --check`, que NÃO corre dentro de
`pnpm test`** (comando manual, ou tarefa de CI a decidir em T1.2). Os outros
cinco pacotes são comparados byte-a-byte contra `node_modules`.

Cada ficheiro espelhado leva o cabeçalho exigido por `05-QUALIDADE-CODIGO.md:277`
(`FONTE`, `VERIFICADO EM`, `DIVERGÊNCIAS DELIBERADAS`) mais `TARBALL`, `SHA256` e
a faixa suportada; `node scripts/fetch-dsh-types.mjs --check` sai rc 0.

---

## 3. De-para entre as duas linhas — **E2 do plano é FALSO na faixa suportada**

Varredura das **9 versões** do `dsh-host-webserver` e das **8** do
`dsh-subprocess`, lendo `package/lib/types/index.d.ts` de cada tarball:

```
$ for v in 0.0.1-rc.1 0.0.1-rc.2 0.0.1-rc.3 0.0.1-rc.5 0.1.0-rc.2 0.1.0-rc.3 0.1.0-rc.6 0.1.0-rc.7 0.1.0-rc.7; do
    curl -sSL -o ws-$v.tgz ".../dsh-host-webserver-$v.tgz"
    tar -xzOf ws-$v.tgz package/lib/types/index.d.ts | grep -E 'Server: |declare class'; done
0.0.1-rc.1    httpServer: HttpServerService   class HttpServerService   registerUpgrade=1
0.0.1-rc.2    httpServer: HttpServerService   class HttpServerService   registerUpgrade=1
0.0.1-rc.3    webServer: WebServer            class WebServer           registerUpgrade=1
0.0.1-rc.5 … 0.1.0-rc.8   webServer: WebServer   class WebServer        registerUpgrade=1   (6 versões)

$ <o mesmo para dsh-subprocess>
0.0.1-rc.1/rc.2           subprocess: SubprocessService   abstract spawn(spec: SubprocessSpawnSpec)
0.0.1-rc.5 … 0.1.0-rc.8   subprocess: SubprocessRuntime   abstract spawn(spec: SubprocessSpawnSpec)
```

| símbolo | linha morta `0.0.1-rc.1/rc.2` | **faixa suportada `0.1.0-rc.7..rc.9`** | desde |
| --- | --- | --- | --- |
| propriedade do Context | `ctx.httpServer` | **`ctx.webServer`** | `0.0.1-rc.3` (2026-08-12) |
| classe do serviço web | `HttpServerService` | **`WebServer`** | `0.0.1-rc.3` |
| assento de subprocessos | `SubprocessService` | **`SubprocessRuntime`** | `0.0.1-rc.5` (2026-08-12) |
| `spawn(spec)`; `register`/`registerFallback`/`registerUpgrade`/`tapIndex`/`applyIndexTaps`; `WebRoute`/`WebUpgradeRoute`/`WebRouteKind` | presentes | presentes | sempre |

**Consequência: `ctx.webServer`, `WebServer` e `inject: ['webServer']` do
`src/index.ts` atual estão CERTOS na versão que o host instala.** E2 descreve a
linha `0.0.1-rc.1/rc.2`, abandonada em 2026-08-12; reescrever `src/index.ts`
para o nome dessa linha teria quebrado um plugin que funciona.

---

## 4. De-para símbolo a símbolo (`src/index.ts` atual → faixa suportada)

| # | símbolo usado hoje em `src/index.ts` | linha | existe? | símbolo real |
| --- | --- | --- | --- | --- |
| 2 | `Disposer` de `@deepseek-ai/cordis` | 52 | **NÃO** (0 ocorrências em `cordis@4.0.1`) | `Disposable<T = any> = () => T`, `types/cordis/fiber.d.ts:50` |
| 4 | **`WebServer`** de `@deepseek-ai/dsh-host-webserver` | 53 | **SIM — E2 INVERTIDO** | `export declare class WebServer extends Service`, `index.d.ts:59`. **Nada a mudar.** |
| 5 | `WebUpgradeHandler` de `@deepseek-ai/dsh-host-webserver` | 53 | **NÃO** (0 ocorrências nas **9** versões) | sem tipo nomeado: `WebUpgradeRoute['handler']`, `index.d.ts:39,43` |
| 6 | `from '@deepseek-ai/dsh-host-subprocess'` | 54 | **NÃO — 404 em todas as versões** | `@deepseek-ai/dsh-subprocess` (+ `-local`) |
| 7 | `ChildProcess` desse módulo | 54 | **NÃO** | `SubprocessHandle`, `types/dsh-subprocess/types.d.ts:163` |
| 8 | `inject = ['webServer','subprocess','logger']` | 74 | **`webServer` CERTO** | `logger` é serviço nuclear mixado em todo o contexto; declará-lo é inócuo |
| 9 | **`ctx.webServer`** (10 usos) | 1567,1637,1721… | **SIM — E2 INVERTIDO** | augmentation em `types/dsh-host-webserver/index.d.ts:23-27`. **Nada a mudar.** |
| 10 | `ctx.webServer.host: string` | 1567,1637 | **tipo mais estreito** | `get host(): Config['host']` = `'127.0.0.1' \| '0.0.0.0'`, `index.d.ts:48,74` |
| 11-14 | `ctx.webServer.port`; `register`/`registerFallback`/`registerUpgrade`; `Parameters<WebServer['register']>[0]`; `Parameters<WebServer['registerUpgrade']>[0]` | 1637,145,148 | **sim** | `index.d.ts:72,81,97,88`; os dois `Parameters<>` resolvem para `WebRoute`/`WebUpgradeRoute`. **Nada a mudar.** |
| 15 | `ctx.subprocess` | 798,1026… | **sim** | `SubprocessRuntime`, `types/dsh-subprocess/index.d.ts:49` |
| 16 | `ctx.subprocess.spawn(command, args, options)` | 798 | **NOME sim, ARIDADE não** | `abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle`, `index.d.ts:100` |
| 17 | `spawned.on('exit'\|'error')`, `.removeListener()` | 970-989 | **NÃO** | `SubprocessHandle.done: Promise<SubprocessOutcome>`, `types.d.ts:175` |
| 18 | `child.killed`, `process.kill(-pid,'SIGKILL')` | 756 | **`killed` NÃO** | `terminate(): void`, `types.d.ts:182` — escopo de árvore em todas as plataformas |
| 19 | `ctx.intercept('webServer', {…métodos…})` | 1745 | **NOME sim, SEMÂNTICA não** | `intercept(name, config)`, `types/cordis/context.d.ts:105,108` — ver §6 |
| 20 | `ctx.waterfall`/`parallel`/`on`/`effect`/`get`; `Context`; `WebRoute` | — | **sim** | `events.d.ts:86,44,97` · `fiber.d.ts:17,166` · `reflect.d.ts:23` · `context.d.ts:24,49` · `dsh-host-webserver/index.d.ts:31` |
| 21 | `ctx.logger.info(scope, msg, …)` | 25 usos | **sim, contrato diferente** | `LoggerMethod = (format: any, …param: any[]) => void`, `logger.d.ts:21` — printf |

### 4.1 Resposta explícita: que símbolos deixam de existir?

**Cinco**, e só cinco:

1. `Disposer` (`@deepseek-ai/cordis`) → `Disposable`.
2. `WebUpgradeHandler` (`dsh-host-webserver`) → sem tipo nomeado nas 9 versões.
3. O módulo `@deepseek-ai/dsh-host-subprocess` → 404 sempre (**E1 mantém-se**).
4. A **aridade** `spawn(command, args, options)` → o real é `spawn(spec)` sempre (**E3 mantém-se**).
5. A superfície `EventEmitter` do filho (`on`/`removeListener`/`killed`) → `SubprocessHandle` não a tem.

Mais dois itens que **não são "deixar de existir"** mas mudam código:
`SubprocessService` → **`SubprocessRuntime`** (só afeta quem nomeie o tipo do
assento; `src/index.ts` não o nomeia) e a **semântica** de `ctx.intercept` (§6).
**E2 (`ctx.webServer`/`WebServer` "não existem") é FALSO na faixa suportada** e
sai da lista. **E4** mantém-se (`dsh-host-frontend` 404; `-static` 200).

### 4.2 Erros de compilação exatos (medição, não conserto)

```
$ npx tsc --noEmit --pretty false
src/index.ts(52,24): error TS2305: Module '"@deepseek-ai/cordis"' has no exported member 'Disposer'.
src/index.ts(53,36): error TS2614: Module '"@deepseek-ai/dsh-host-webserver"' has no exported member 'WebUpgradeHandler'. Did you mean to use 'import WebUpgradeHandler from "@deepseek-ai/dsh-host-webserver"' instead?
src/index.ts(54,35): error TS2307: Cannot find module '@deepseek-ai/dsh-host-subprocess' or its corresponding type declarations.
src/index.ts(798,58): error TS2554: Expected 1 arguments, but got 3.
src/index.ts(972,15): error TS2339: Property 'removeListener' does not exist on type 'SubprocessHandle'.
src/index.ts(973,15): error TS2339: Property 'removeListener' does not exist on type 'SubprocessHandle'.
src/index.ts(983,15): error TS2339: Property 'on' does not exist on type 'SubprocessHandle'.
src/index.ts(988,13): error TS2339: Property 'on' does not exist on type 'SubprocessHandle'.
src/index.ts(989,13): error TS2339: Property 'on' does not exist on type 'SubprocessHandle'.

$ npx tsc --noEmit --pretty false | cut -d'(' -f1 | sort | uniq -c
      9 src/index.ts
     21 test/index.test.ts
      0 types/**
```

**30 erros: 9 em `src/index.ts`, 21 em `test/index.test.ts`, 0 em `types/**`.**
A medição anterior desta spike reportava 47 (25 + 22) — **16 dos 25 eram do pino
errado, não da API**: os três `Property 'webServer' does not exist` e a cascata
de 12 `'route' is of type 'unknown'` desapareceram ao corrigir a linha. Os 9 que
sobram são reais e nenhum `types/**` honesto os apaga. `types/__smoke__.ts`,
reescrito contra a faixa suportada, compila com 0 erros.

---

## 5. `SubprocessSpawnSpec`, `graceMs` e o bypass do fallback

### 5.1 Forma exata (`types/dsh-subprocess/types.d.ts:76-105`, verbatim)

```ts
export interface SubprocessSpawnSpec {
    /** Executable and arguments; `argv[0]` is the program. Never shell-interpreted here. */
    argv: readonly string[];
    /** Working directory for the child. */
    cwd: string;
    /** Per-stream stdio dispositions. */
    stdio: SubprocessStdio;
    graceMs: number;          // + JSDoc: "Positive finite grace period in milliseconds,
                              //   no greater than `MAX_TIMER_DELAY_MS`"
    signal?: AbortSignal | undefined;
    env?: NodeJS.ProcessEnv | undefined;
}
```

`SubprocessStdio` = `{ stdin: 'ignore'|'pipe'|{readonly data:string}; stdout:
'pipe'|'inherit'|SubprocessCollect; stderr: idem }`. O tipo é **byte-idêntico**
entre `0.0.1-rc.1` e `0.1.0-rc.8` (o único `diff` são duas referências de
JSDoc): E3 vale nas duas linhas.

### 5.2 `graceMs`: que valor, e de onde sai

O código atual **não tem valor nenhum a usar**: `Config.worker` (`src/index.ts:114-140`)
só tem `command/args/cwd/token/backoff`, e `backoff.*` é reinício, não escalada
de terminação; `cordis.patch.yml:343-391` também não fornece grace.

O default publicado na faixa suportada e o seu tecto:

```
$ grep -n 'disposeGraceMs' dsh-terminal-bash@0.1.0-rc.8/lib/index.js
52:  disposeGraceMs: z.number().default(3e3)
846:  graceMs: this.config.disposeGraceMs,
$ grep -n 'MAX_TIMER_DELAY_MS' dsh-timeout@0.1.0-rc.8/lib/types/index.d.ts
22:export declare const MAX_TIMER_DELAY_MS = 2147483647;
$ grep -n 'graceMs' dsh-subprocess-local@0.1.0-rc.8/lib/index.js
784: if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) throw ...
```

**`graceMs: 3000`.** É valor herdado de outro pacote, não contrato deste plugin:
**T1.1 tem de acrescentar `worker.graceMs` à `interface Config`** e a chave
correspondente ao manifesto. (Na rodada 1 citei `dsh-bash-local` para o mesmo
número — esse pacote só existe em `0.0.1-rc.1`, linha morta; a fonte válida é a
acima.)

### 5.3 Onde a barreira NÃO pode ser instalada — três caminhos medidos

**Correção de uma prescrição errada desta spike.** A versão anterior dizia *"a
barreira instala-se com `register({ kind: 'prefix', path: '/api' })` e
`registerUpgrade`"*. **Isso lança no arranque** — código publicado
(`node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js`):

```js
:53  register(route) {
:54    const table = route.kind === "exact" ? this.exact : this.prefixes;
:55    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
:67  registerUpgrade(route) {
:68    if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
:82  registerFallback(handler) {
:83    if (this.fallback !== void 0) throw new Error("webserver: fallback already registered");
```

Numa composição real esses assentos já têm dono (`/api` e `/api/events.mux` no
`dsh-client-connection`; o fallback no `dsh-host-frontend-static`), e os três
`register*` **lançam na segunda chamada**. **T0.5** refutou a mesma prescrição
por medição independente; **T1.1 segue T0.5, não a versão anterior desta secção.**

#### O despacho real, e porque o fallback não vê `/api`

`[Service.init]` (`lib/index.js:103-165`) cria **um** `node:http.Server` com um
listener de `request` (`:121`) e um de `upgrade` (`:132`). O de `request` chama
`match(pathname)` (`:194-203`, verbatim):

```js
match(pathname) {
  const exact = this.exact.get(pathname);           // 1º: tabela exata
  if (exact !== void 0) return exact;
  let best;                                          // 2º: maior prefixo ganha
  for (const [prefix, route] of this.prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    if (best === void 0 || prefix.length > best.path.length) best = route;
  }
  return best;                                       // 3º: undefined -> fallback
}
```

Exata primeiro, maior-prefixo depois, e **só se nada casar** o fallback corre.
Daí o efeito medido: `/` e `/rota-spa` passam pelo fallback (401 com a barreira
lá) enquanto `/api/state` e `/plugins/x/client.js` são servidos pelas rotas
nomeadas dos seus donos, **sem tocar no fallback**. Os upgrades são tabela à
parte (`this.upgrades`, correspondência **exata**), invisível ao fallback.

#### O que T1.1 deve fazer: trocar o dono do despacho

Conclusão medida de T0.5: capturar `server.listeners('request')` e
`server.listeners('upgrade')`, `removeAllListeners` em ambos, instalar **um**
listener que decide e delega para os capturados, e devolver disposer **síncrono**
que reinstala os originais. É a única forma de cobrir as três superfícies sem
colidir com os donos existentes.

#### Caminho público parcial, e a diferença entre `''` e `'/'`

Existe um caminho público que a arte prévia usa: `register({ kind: 'prefix',
path: '' })` — `path` **vazio**, não `'/'`. Reproduzindo a `match()` acima
verbatim sobre tabelas de prefixos controladas:

```
prefixos ["" ]                 -> "" apanha /, /rota-spa, /api/state, /plugins/x/client.js
prefixos ["/"]                 -> só o literal /; os restantes dão null
prefixos ["", "/api", "/plugins"]  (composição real)
   /  e  /rota-spa   -> ""        /api/state -> "/api"        /plugins/x/y -> "/plugins"
```

`''` casa tudo (`startsWith('' + '/')` é verdade para qualquer caminho
absoluto); `'/'` só casa o literal `/`, porque exigiria `startsWith('//')`.
**Numa composição real `''` perde para `/api` e `/plugins`**, prefixos mais
longos já registados, e continua a não ver os upgrades: serve a superfície
SPA/estática, **não** o plano de controlo.

---

## 5.4 O lockfile inteiro, o peer da linha morta, e porque o pino é `rc.7`

**(a) O peer que arrastava a linha morta.** Os quatro `dsh-*` declaram
`peerDependencies: { "@deepseek-ai/dsh-invariants": "^0.1.0-rc.7" }`. Sem pino
direto, a resolução desse peer **rebaixava-o para `0.0.1-rc.5`** — que não
satisfaz o próprio `^0.1.0-rc.7`. O lockfile commitado instalava a linha morta
por dentro do grafo com os cinco pinos diretos corretos, e nenhum CONTRACT o
via. Correção: `dsh-invariants@0.1.0-rc.7` passa a **devDependency direta e
exata**; `CONTRACT-003` varre agora o **lockfile inteiro**
(`/@deepseek-ai\/[a-z0-9-]+@0\.0\.1-rc\.[0-9]+/g`) **e** lê a versão
**efetivamente instalada** de `node_modules/<pkg>/package.json`, em vez do
literal do próprio ficheiro de teste, que era o que a versão anterior comparava.

**(b) Porque o pino é `0.1.0-rc.7` e não `0.1.0-rc.8`.** O pnpm 11 aplica uma
política de idade mínima (~24 h) às entradas do lockfile, e **corre um install
implícito antes de cada script**. Com os pinos em `0.1.0-rc.8` (publicados a
`2026-08-19T15:2x–15:41Z`), `pnpm test` falhava com

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 5 lockfile entries failed verification
… published at 2026-08-19T15:31:51Z, within the minimumReleaseAge cutoff (2026-08-19T03:54:28Z)
pnpm: Command failed with exit code 1
```

— **o gate inteiro vermelho**, não um aviso. Contornar exigiria um `.npmrc` ou
`pnpm-workspace.yaml` a relaxar a política (fora da fronteira desta sub-tarefa) e
daria um lockfile que só instala limpo com a política enfraquecida. `0.1.0-rc.7`
(2026-08-17) passa a política, é a versão que o harness `latest` nomeia
literalmente, e está na faixa suportada.

**(c) A troca é segura, e foi medida.** `diff -r` dos `lib/types/` rc.7 vs rc.8:
`dsh-host-webserver`, `dsh-subprocess`, `dsh-host-frontend-static` e
`dsh-home-paths` **IDÊNTICOS**; `dsh-subprocess-local` difere em `terminal.d.ts`
e ganha `windows-inspector.d.ts` em rc.8 — **mas os três ficheiros que
espelhamos (`index`/`spawn`/`process-inspector.d.ts`) são idênticos**, e os
outros dois estão fora do espelho por importarem `node-pty`/`koffi`. Nenhum
ficheiro de `types/**` muda de conteúdo: só o `sha256` e a versão no cabeçalho.
Resultado com os pinos em rc.7: `grep -c '0.0.1-rc' pnpm-lock.yaml` → `0`;
`pnpm install` sem aviso de política; `pnpm-workspace.yaml` ausente (nada foi
commitado para silenciar nada).

---

## 6. Achado que se mantém: `ctx.intercept` não é interceptação de métodos

Assinatura real (`types/cordis/context.d.ts:105-108`) e corpo publicado
(`cordis-4.0.1.tgz`, `package/src/context.ts:141-144`):

```ts
    intercept<K extends InjectKey>(name: K, config: Context[K] extends {
        [symbols.config]: infer T; } ? T : never): this;
    intercept(name: string, config: any): this;
```
```js
  intercept(name: string, config: any) {
    const intercept = Object.create(this[symbols.intercept])
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
```

O argumento entra num mapa de **configuração por serviço**, lido por
`Service[symbols.resolveConfig]` (`package/src/service.ts:86-93`) e fundido na
config que o serviço vê para plugins carregados abaixo. **Nenhum método é
substituído.** Para `webServer` (que estende `Service`, logo `Service<never>`) a
sobrecarga tipada colapsa `config` em `never`: nenhum objeto de métodos a
satisfaz, e a chamada só compila pela sobrecarga `config: any` — **compila e não
faz nada**. Falha silenciosa. Corroboração: a `SKILL.md` oficial de plugins
Cordis dentro de `@deepseek-ai/dsh` (420 linhas) e o `README.md` do cordis não
mencionam `intercept` uma única vez — o mecanismo documentado para posse de
recursos é `ctx.effect()`. Reforça §5.3: a barreira troca o dono do despacho.

---

## 7. Vereditos

```
VEREDITO S1: CONFIRMADO — na faixa suportada 0.1.0-rc.7..rc.9 o servico web chama-se WebServer (ctx.webServer) e expoe register/registerFallback/registerUpgrade/tapIndex/applyIndexTaps; SubprocessSpawnSpec exige argv/cwd/stdio/graceMs.
  evidência: types/dsh-host-webserver/index.d.ts:25 (`webServer: WebServer`), :59 (`export declare class WebServer extends Service`), :81 (`register(route: WebRoute): () => void`), :97 (`registerFallback(handler: WebRoute['handler']): () => void`), :88 (`registerUpgrade(route: WebUpgradeRoute): () => void`), :104 (`tapIndex`), :115 (`applyIndexTaps`), extraído de dsh-host-webserver-0.1.0-rc.7.tgz sha256 b5fee946c818859bd19d808b8aea492420a1e57e2a074f2f3a6d16ce943ca545; e types/dsh-subprocess/types.d.ts:76-105 mais types/dsh-subprocess/index.d.ts:100 (`abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle`), extraídos de dsh-subprocess-0.1.0-rc.7.tgz sha256 71d951f6d7f34076c9c8f30f931635e87fb2bed4b7959d46f5522016f0661b72. O BLOQUEADOR DE SEGURANCA esta levantado: registerUpgrade existe nas 9 versoes publicadas, logo o handshake de WebSocket e guardavel. DUAS RESSALVAS: (a) uma barreira em registerFallback nao cobre /api nem /plugins, porque as tabelas nomeadas sao consultadas antes do fallback (seccao 5.3); (b) ctx.intercept nao envolve metodos (seccao 6).
VEREDITO S9: CONFIRMADO — o host publica um helper canonico de caminhos, @deepseek-ai/dsh-home-paths, e ele e dependencia direta declarada do harness.
  evidência: `npm view @deepseek-ai/dsh@0.1.0-rc.7 dependencies` lista `"@deepseek-ai/dsh-home-paths": "^0.1.0-rc.7"`, que resolve para 0.1.0-rc.7. O modulo (types/dsh-home-paths/index.d.ts, extraído de dsh-home-paths-0.1.0-rc.7.tgz sha256 a496c60906b636f1236b2a9de00217e7f5c85a1547066e733e7bba1795c41484) exporta funcoes puras — nao e um servico do Cordis: :16 `DSH_HOME_DIR_NAME = ".dsh"`, :18 `DEFAULT_DSH_HOME_DISPLAY = "~/.dsh"`, :20 `DSH_HOME_ENV = "DSH_HOME"`, :39 `defaultDshHome(): string`, :45 `expandHomePath(path: string): string`, :57 `resolveDshHome(configured?: string, env?: Record<string, string | undefined>): string`, :63 `dshHomePath(...segments: string[]): string`, :72 `dshHomeDisplay(resolvedHome: string): string`, :34 `canonicalizeWatchPath(path: string): Promise<string>`. A precedencia esta escrita no JSDoc de resolveDshHome: configurado > $DSH_HOME > ~/.dsh, com $DSH_HOME vazio tratado como ausente. Reconcilia com o que a composicao faz: dsh-base@0.1.0-rc.7 usa `root: !!js dshHomePath('sessions')` no cordis.patch.yml. NAO existe diretorio de estado POR PLUGIN nem namespacing automatico: o helper resolve a raiz e junta segmentos, e a escolha do subdiretorio e do chamador. CORRECAO DE UM VEREDITO ANTERIOR DESTA MESMA SPIKE: a primeira emissao disse NAO CONFIRMADO por ter sondado nomes inventados (dsh-state, dsh-paths, dsh-host-paths, ...) em vez de partir das dependencias declaradas do harness; enumerar palpites e concluir ausencia foi o erro de metodo. RECOMENDACAO PARA T2.5: o default $XDG_STATE_HOME/dsh-guarded-bot/ deixa de ser escolha livre — ou passa a usar dshHomePath('guarded-bot'), ou justifica por escrito por que diverge do unico contrato de caminhos que o host publica.
VEREDITO S11: CONFIRMADO — crypto.argon2() e crypto.argon2Sync() existem nativamente no Node >= 24.7.0, e funcionam no Node local v24.15.0.
  evidência: doc oficial nodejs.org/api/crypto — «crypto.argon2 … Added in: v24.7.0», assinaturas `crypto.argon2(algorithm, parameters, callback)` e `crypto.argon2Sync(algorithm, parameters)`. Execucao local, saida bruta: `node -e 'const c=require("node:crypto"); console.log(typeof c.argon2, typeof c.argon2Sync)'` -> `function function`; e `c.argon2Sync("argon2id",{message:Buffer.from("pw"),nonce:Buffer.alloc(16),parallelism:1,tagLength:32,memory:65536,passes:3})` devolveu 32 bytes sem emitir ExperimentalWarning. Node local: v24.15.0 (`node --version`). RESSALVA: a matriz do plano e «>=24.7.0» e so a v24.15.0 foi executada nesta maquina; a versao de introducao v24.7.0 vem da documentacao oficial, nao de execucao.
```

---

## 8. Ficheiros produzidos

`types/{cordis(9),dsh-host-webserver(2),dsh-subprocess(3),dsh-subprocess-local(3),dsh-host-frontend-static(2),dsh-home-paths(2)}/*.d.ts`
— espelhos literais, cada um com cabeçalho `FONTE`/`VERIFICADO EM`/`DIVERGÊNCIAS`/`SHA256`.
`types/__smoke__.ts` (reescrito, 0 erros) · `test/contract/dsh-types.test.ts`
(CONTRACT-001…009) · `scripts/fetch-dsh-types.mjs` (`pnpm types:fetch`) ·
`tsconfig.json` (`paths` reais + `dsh-home-paths`; sem `dsh-host-subprocess`) ·
`package.json` (exatos D18, peer `>=4.0.0 <5` opcional, `test:contract`,
`types:fetch`, e o novo pino direto `@deepseek-ai/dsh-invariants@0.1.0-rc.7`) ·
`pnpm-lock.yaml` (regenerado: zero `0.0.1-rc.*` no grafo inteiro).
**Apagado:** `types/dsh-host-subprocess/` — o nome dá 404 em todas as versões.
