# S12 — Spike de interceptação real da camada HTTP do DSH

> **Pergunta.** Dado o serviço web REAL do DeepSeek Harness, qual é o mecanismo — se existe algum —
> para instalar uma **barreira de autenticação reversível** que cubra os três caminhos de registo
> (`register`, `registerFallback`, `registerUpgrade`), e sob que condição de ordem de carregamento
> ele funciona?
>
> **Regra de prova (Q-1).** A prosa não é a API. Toda afirmação abaixo sai (i) do **corpo publicado**
> do pacote, com ficheiro e linha, ou (ii) de um **experimento executado**, com saída bruta colada.
> Onde não houver nem um nem outro, o facto está marcado como NÃO CONFIRMADO na secção 12.

```
VEREDITO S12: CONFIRMADO — a troca de dono do despacho no `node:http.Server` do serviço `webServer` (captura dos listeners `request`/`upgrade`, substituição por um listener único que decide e delega) é o caminho viável para a barreira reversível, e é o único candidato medido que cobre os três caminhos sem exigência de ordem de carregamento.
  evidência: @deepseek-ai/dsh-host-webserver@0.1.0-rc.8 lib/index.js:121-131 (`this.server = createServer(...)`) e :132-165 (`this.server.on("upgrade", ...)`); experimento executado em `scripts/spike/intercept/experimento.mjs`, saída bruta em `scripts/spike/intercept/saidas/execucao.txt` — 35 asserções, 7 rotas reais passam de 200/upgrade para 401 e voltam a 200/upgrade após o disposer síncrono.
  arte prévia: `dsh-webui-auth@0.3.0` (publicado, MIT) resolve o mesmo problema pela via (b.2)+(e2); comparação medida em §7.1. (d) permanece preferível por cobrir rotas que a arte prévia não enumera e por não ter janela de reexame — mas o rescan e o `loopbackDeputy` dela são para copiar.
```

---

## 1. Achado que precede tudo: a versão medida estava errada

O prompt desta sub-tarefa e o relatório de T0.1 descrevem `HttpServerService` / `ctx.httpServer`, medidos em
`@deepseek-ai/dsh-host-webserver@0.0.1-rc.1`. Essa é a etiqueta `latest` do npm, e **ela está estagnada**:
o harness publicado não a usa.

```console
$ npm view @deepseek-ai/dsh-host-webserver dist-tags --json
{"latest":"0.0.1-rc.1","next":"0.1.0-rc.8"}

$ npm view @deepseek-ai/dsh dist-tags --json
{"next":"0.1.0-rc.8","latest":"0.1.0-rc.7"}
```

E o `package.json` do harness real (`@deepseek-ai/dsh@0.1.0-rc.7`, secção `devDependencies`) pede:

```json
"@deepseek-ai/dsh-host-frontend-static": "^0.1.0-rc.7",
"@deepseek-ai/dsh-host-webserver": "^0.1.0-rc.7",
```

O diff entre as duas linhas é puramente nominal, e foi medido:

```console
$ diff -u webserver-0.0.1-rc.1/lib/index.js webserver-0.1.0-rc.8/lib/index.js
-* server plus the `httpServer` service (HTTP and upgrade route registries,
+* server plus the `webServer` service (HTTP and upgrade route registries,
-var HttpServerService = class extends Service {
+var WebServer = class extends Service {
-		super(ctx, "httpServer");
+		super(ctx, "webServer");
-		}, "httpServer.listen");
+		}, "webServer.listen");
-export { HttpServerService, HttpServerService as default };
+export { WebServer, WebServer as default };

$ diff webserver-0.1.0-rc.7/lib/index.js webserver-0.1.0-rc.8/lib/index.js && echo IDENTICO
IDENTICO
$ diff webserver-0.1.0-rc.7/lib/types/index.d.ts webserver-0.1.0-rc.8/lib/types/index.d.ts && echo IDENTICO
IDENTICO
```

### De-para entre as duas linhas

| Facto | `0.0.1-rc.1`/`rc.2` (linha abandonada) | `0.1.0-rc.7`/`rc.8` (linha do harness) |
| --- | --- | --- |
| classe exportada | `HttpServerService` | `WebServer` |
| nome do serviço | `ctx.httpServer` | `ctx.webServer` |
| `declare module` | `interface Context { httpServer: HttpServerService }` | `interface Context { webServer: WebServer }` |
| `register` / `registerUpgrade` / `registerFallback` / `tapIndex` / `applyIndexTaps` | idênticos | idênticos |
| `match` (exact → longest-prefix) | idêntico | idêntico |
| corpo de `[Service.init]` | idêntico | idêntico |

**Consequência para a Onda 1.** O `src/index.ts` legado escreve `ctx.intercept('webServer', …)`: o **nome do
serviço está certo**; o que não existe é o mecanismo. E `@deepseek-ai/dsh-host-frontend-static@0.1.0-rc.3` já
injectava `['webServer']` (`lib/index.js:20`) contra um webserver que ainda provia `httpServer` — as duas
etiquetas `latest` são mutuamente incompatíveis. Fixar `0.1.0-rc.8` não é preferência: é a única combinação
que compõe.

**Todo o resto deste documento foi medido contra `@deepseek-ai/dsh-host-webserver@0.1.0-rc.8`.**

### 1.1 Porque é que o gate está verde hoje — e porque isso não prova nada

Medido no branch base desta worktree, sem nenhuma alteração minha a `src/**`:

```console
$ pnpm typecheck ; echo "exit=$?"
exit=0
$ pnpm build ; echo "exit=$?"
exit=0
$ pnpm test ; echo "exit=$?"
ℹ tests 93   ℹ pass 93   ℹ fail 0
exit=0
```

O gate não está vermelho. A razão é estrutural e é o próprio achado: `tsconfig.json` mapeia os
especificadores `@deepseek-ai/*` para `.d.ts` **escritos à mão neste repositório**:

```json
    "paths": {
      "@deepseek-ai/cordis": ["./types/cordis/index.d.ts"],
      "@deepseek-ai/dsh-host-webserver": ["./types/dsh-host-webserver/index.d.ts"],
```

E `types/cordis/index.d.ts:110-114` e `:154` declaram uma API que **não existe** no pacote publicado:

```ts
export type InterceptMethods<S> = {
  [K in keyof S]?: S[K] extends (...args: infer A) => infer R
    ? ((this: S, ...args: A) => R) | ((this: S, target: S, ...args: A) => R)
    : S[K]
}
…
  intercept<K extends ServiceName>(name: K, methods: InterceptMethods<Services[K]>): Context
```

Comparar com o corpo real em §3: o `intercept` publicado recebe `config: any` e faz merge de configuração.
`InterceptMethods` é uma invenção deste repositório. **O compilador está a validar `src/index.ts` contra uma
ficção que o próprio repositório escreveu**, e é por isso que o gate passa. Nenhuma quantidade de `tsc` neste
desenho pode detectar a deriva de API — é a regra **Q-1** na sua forma mais pura.

Os **nomes** vendorizados, esses, estão certos: `types/cordis/index.d.ts:87` declara `webServer: WebServer`,
que bate com a linha `0.1.0-rc.7/rc.8`. Errado é só o mecanismo.

**Entrada para a Onda 1:** substituir `types/**` por tipos derivados dos `.d.ts` publicados (ou consumir os
pacotes reais), sob pena de o gate continuar a certificar código que não corre.

---

## 2. Método e proveniência

```console
$ npm pack @deepseek-ai/cordis@4.0.1 \
           @deepseek-ai/dsh-host-webserver@0.1.0-rc.8 \
           @deepseek-ai/dsh-host-frontend-static@0.1.0-rc.8 \
           @deepseek-ai/dsh-client-connection@0.1.0-rc.8 \
           @deepseek-ai/dsh-web-app@0.1.0-rc.8 \
           @deepseek-ai/dsh-base@0.1.0-rc.7 \
           @deepseek-ai/dsh@0.1.0-rc.7
$ sha256sum *.tgz
31e96b8e13d5c55bfd4316c08ac8925510e0eed86d48a3a9cc86046623074613  deepseek-ai-cordis-4.0.1.tgz
b134154ea2c1c03e68747684bc89b9c5c569d1294084555ee02c7bf51793e3ac  deepseek-ai-dsh-host-webserver-0.1.0-rc.8.tgz
3c0c7964335d431aa9719de6de33edc07bd18ae6901a719c6475e905c0846d5c  deepseek-ai-dsh-host-frontend-static-0.1.0-rc.8.tgz
70a82e4cb59fad24c82c1b5a2bc9ee2817c4973f14caa783840468fed33f046b  deepseek-ai-dsh-client-connection-0.1.0-rc.8.tgz
af31ffd5424d0f6db0b215210c8c5b5ce4bfba1ed4a529b8964d6389d688899b  deepseek-ai-dsh-web-app-0.1.0-rc.8.tgz
d96842508eb4b30e7d0c33f8530804fd413a1e894a0cd90f88ef9ed93cd3b99a  deepseek-ai-dsh-base-0.1.0-rc.7.tgz
2f8f0b763d611ac536f7a9411ee43c0afc067c1b8732c3102c04dbe398bcacc5  deepseek-ai-dsh-0.1.0-rc.7.tgz
3e57a7926f9f181e1b538f4d6aafb0060bf6ec3c94879d2193b93b06a7953a80  deepseek-ai-dsh-host-webserver-0.0.1-rc.1.tgz  # a linha abandonada, para o de-para

$ npm pack dsh-webui-auth@0.3.0        # arte prévia — pacote NAO escopado
$ sha256sum dsh-webui-auth-0.3.0.tgz
05283cd3500891b13200ca1f1a2a5edc215b64805d799f73c439c67d89ab5aa2  dsh-webui-auth-0.3.0.tgz
```

O tarball de `@deepseek-ai/cordis@4.0.1` publica o **TypeScript-fonte** em `src/*.ts`, não só os `.d.ts`.
Todas as citações de cordis abaixo são desse fonte.

O laboratório executável vive em `scripts/spike/intercept/` e corre com `bash scripts/spike/intercept/run.sh`.
As dependências instalam-se em `scripts/spike/intercept/node_modules/` (ignorado pelo `.gitignore` da raiz);
o `package.json` do projeto não é tocado.

---

## 3. Q1 — `ctx.intercept` faz mesmo o que T0.1 diz? **CONFIRMADO, com o corpo**

`@deepseek-ai/cordis@4.0.1`, `src/context.ts:127-145` — o corpo inteiro, colado:

```ts
  /**
   * Add service-specific intercept config for plugins started below this
   * context.
   *
   * Plugins loaded under the returned context see `config` merged into the
   * service's resolved config (ancestor entries first; see
   * `Service[symbols.resolveConfig]`). The parent context is not affected.
   *
   * @param name — the service name whose config to intercept.
   * @param config — the intercept config to merge for that service.
   * @returns a child context carrying the additional intercept entry.
   */
  intercept<K extends InjectKey>(name: K, config: Context[K] extends { [symbols.config]: infer T } ? T : never): this
  intercept(name: string, config: any): this
  intercept(name: string, config: any) {
    const intercept = Object.create(this[symbols.intercept])
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
  }
```

São quatro linhas de corpo. Criam um objeto que herda prototipalmente do mapa de intercept do pai, gravam
`config` sob a chave `name`, e devolvem um **contexto filho**. Nenhum método é lido, envolvido ou substituído.

O único consumidor desse mapa em todo o cordis é `src/service.ts:86-102`, que o achata em **configuração**:

```ts
  [symbols.resolveConfig](base?: T, head?: T): T {
    let intercept = this.ctx[Context.intercept]
    const configs: any[] = []
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) {
        configs.unshift(intercept[this.name])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    if (base) configs.unshift(base)
    if (head) configs.push(head)
    if (this['Config']?.merge) {
      return this['Config'].merge(...configs)
    } else {
      return Object.assign({}, ...configs)
    }
  }
```

E o `WebServer` **nunca chama** `resolveConfig`:

```console
$ grep -n "resolveConfig" webserver-0.1.0-rc.8/lib/index.js
(nenhuma ocorrencia)
```

Ou seja: para o `webServer`, a config de intercept é inerte **até como config**. Medido em runtime
(`scripts/spike/intercept/falsificacao.mjs`):

```
==============================================================================
Q1 / OPCAO ZERO — `ctx.intercept('webServer', ...)` faz alguma coisa?
==============================================================================
  `intercept` aceitou config arbitraria sem lancar:       true
  `register` do alvo cru mudou de identidade?             false
  o contexto devolvido e o mesmo objeto?                  false
  onde a config foi parar (Context[symbols.intercept]):   ["register","authBarrier"]
  o WebServer chega a LER config de intercept?            resolveConfig herdado=true, chamado em lib/index.js=false (grep sem ocorrencias)
  plugin abaixo do intercept recebe o MESMO servico?      true
  GET /api/state depois do intercept -> 200 (barreira NAO instalada)
```

O experimento passou uma função `register` que **lança se for chamada**. Ela nunca é chamada, e uma
requisição HTTP real a `/api/state` responde 200 na mesma. **T0.1 está correto.** A segunda sobrecarga
(`intercept(name: string, config: any): this`, `src/context.ts:140`) é o que faz a chamada errada compilar
em silêncio.

---

## 4. Q2 — inventário exaustivo dos primitivos do Cordis

Lidos por inteiro: `src/context.ts` (146 l.), `src/reflect.ts` (418 l.), `src/service.ts` (115 l.),
`src/events.ts` (352 l.), `src/registry.ts` (337 l.), `src/utils.ts` (287 l.), `src/fiber.ts` (754 l.).

| Primitivo | Assinatura / origem | Serve de barreira? |
| --- | --- | --- |
| `ctx.intercept(name, config)` | `context.ts:141` | **Não.** Merge de config; ver §3. |
| `ctx.isolate(name, label?)` | `context.ts:121` | Parcial — cria um **realm** onde o serviço resolve noutro escopo. Não envolve o serviço existente; ver §5(e3). |
| `ctx.extend(meta)` | `context.ts:99` | Não. Metadados no contexto filho. |
| `ctx.reflect.provide(name, value, check?)` | `reflect.ts:277` | Só para nomes **livres**: `reflect.ts:289-291` lança `service "<name>" has been registered at <fiber>` se já houver dono no mesmo realm. |
| `ctx.reflect.set(name, value)` | `reflect.ts:254` | **Não.** `reflect.ts:260-262`: `cannot set property "<name>" in multiple fibers` — só o fiber que proveu pode substituir. Um plugin externo não pode trocar o valor do serviço. |
| `ctx.reflect.get(name, strict?)` | `reflect.ts:233` | Leitura. |
| `ctx.accessor(name, {get,set})` | `reflect.ts:345` | **Não** para um nome já provido: `reflect.ts:347-349` lança `property "<name>" is already declared as service`. |
| `ctx.mixin(source, mixins)` | `reflect.ts:364` | Expõe membros em `ctx`; não intercepta o serviço. |
| **`'internal/get'`** | `events.ts:345` — `(ctx, name, error, next) => any`, modo **waterfall**, disparado em `reflect.ts:153` a cada leitura de serviço pelo proxy do contexto | **Sim, em teoria** — um listener pode devolver uma fachada em vez do serviço. Ver §5(e1): descartado por medição de âmbito. |
| `'internal/set'` | `events.ts:347` — waterfall, `reflect.ts:191` | Escrita de serviço; não é o caminho da requisição. |
| `'internal/service'` | `events.ts:341` — *"Interception hook for a service binding (no core producer)"* | Notificação; sem `next`, não bloqueia nada. |
| `'internal/config'`, `'internal/update'` | `events.ts:339`, `:343` — waterfall sobre config de fiber | Config, não requisições. |
| `'internal/listener'` | `events.ts:349` — bail; um resultado não-nulo **substitui** o registo do listener | Interceção do próprio barramento de eventos, não do HTTP. |
| `ctx.effect(execute, label)` | `fiber.ts:415` | O contentor de reversibilidade. Disposers LIFO (`fiber.ts` — `disposables.splice(0).reverse()`). **É aqui que a barreira tem de viver.** |
| `symbols.original` | `utils.ts:54`, lido em `utils.ts:175` (`if (prop === symbols.original) return target`) | Desembrulha o Proxy "traceable" e devolve a instância crua do serviço. |

**Não existe** no Cordis: primitivo de decoração de serviço, cadeia de middleware HTTP, `wrap`, `around`,
`before`/`after`, prioridade de plugin, nem `insert-before`. O que mais perto chega de "interceção" é a
família `internal/*`, que é um seam do **container**, não da camada HTTP.

---

## 5. Q3 — como se instala uma barreira que cobre os três caminhos

O comportamento do roteador, que decide tudo (`webserver@0.1.0-rc.8`, `lib/index.js:104-120` e `:194-203`):

```js
		const handle = async (req, res) => {
			const rawPath = new URL(req.url ?? "/", "http://x").pathname;
			const route = this.match(rawPath);
			if (route !== void 0) {
				await route.handler(req, res);
				return;
			}
			const fallback = this.fallback;
			if (fallback === void 0) {
				res.writeHead(404);
				res.end();
				return;
			}
			await fallback(req, res);
		};
```

```js
	match(pathname) {
		const exact = this.exact.get(pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const [prefix, route] of this.prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === void 0 || prefix.length > best.path.length) best = route;
		}
		return best;
	}
```

Superfície real da composição Web (`@deepseek-ai/dsh-web-app@0.1.0-rc.8/cordis.patch.yml:115-160`), com os
donos medidos:

| Caminho | Registo | Dono |
| --- | --- | --- |
| `prefix /api` | `register` | `@deepseek-ai/dsh-client-connection` (`lib/index.js:551-562`) |
| `prefix /plugins` | `register` | `@deepseek-ai/dsh-client-modules` |
| `exact /__dsh_invariant_probe__` | `register` | sonda de invariante do próprio webserver (`lib/invariant.js:30`) |
| `upgrade /api/events.mux`, `/api/events.host` | `registerUpgrade` | `@deepseek-ai/dsh-client-connection` (`lib/index.js:567-586`) |
| assento de fallback | `registerFallback` | `@deepseek-ai/dsh-host-frontend-static` (`lib/index.js:73`) |

### (a) Monkey-patch de `register` / `registerFallback` / `registerUpgrade` — **INVIÁVEL**

Envolve o handler **no momento do registo**. Duas falhas medidas, e a segunda é fatal por si só:

```
  a.1 — guarda carregada ANTES de quem regista (ordem respeitada):
    GET /api/state -> 401 (guardado)
    apos disposer  -> 401 (rota JA registada continua envolvida? SIM — reversao INCOMPLETA)
  a.2 — guarda carregada DEPOIS de quem regista (ordem violada):
    GET /api/state               -> 200 (PASSOU AO LADO — rota registada antes da guarda)
    GET /                        -> 200 (PASSOU AO LADO — rota registada antes da guarda)
    GET /__dsh_invariant_probe__ -> 200 (PASSOU AO LADO — rota registada antes da guarda)
```

1. **Exige carregar ANTES de todos os registadores** — e essa ordem não é contratual (§6).
2. **Não é reversível.** Restaurar os três métodos não desfaz os handlers que já foram envolvidos e
   entregues às tabelas. Violação directa de **Q-2** (*tudo que aloca recurso devolve disposer*). Nem com
   a ordem respeitada o disposer funciona.

O serviço **é** acessível e mutável a partir do contexto do plugin (a escrita atravessa o Proxy "traceable",
`utils.ts:201-212`) — a inviabilidade não é de acesso, é de semântica.

### (b) Rotas `prefix` de captura ampla — **PARCIALMENTE VIÁVEL**; a minha primeira medição foi incompleta

Testei `path:'/'` e generalizei a família inteira para INVIÁVEL. **A generalização estava errada** e a
revisão adversarial apanhou-a. Os dois casos, medidos separadamente:

**(b.1) `path:'/'` — INVIÁVEL.**

```
  `register({kind:"prefix", path:"/"})` lancou? NAO
  o assento de fallback continua do frontend-static? true
  GET /                        -> 401 (capturado)
  GET /rota-spa                -> 200 (PASSOU AO LADO)
  GET /api/state               -> 200 (PASSOU AO LADO)
  GET /plugins/x/client.js     -> 200 (PASSOU AO LADO)
  GET /__dsh_invariant_probe__ -> 200 (PASSOU AO LADO)
```

Captura **exactamente um pathname: `/`**. A causa está em `lib/index.js:199`:

```js
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
```

Com `prefix = "/"` o teste torna-se `pathname.startsWith("//")`, que nunca é verdade para um pathname
normal.

**(b.2) `path:''` — VIÁVEL como captura da superfície não reclamada.** A mesma linha com `prefix = ''` vira
`pathname.startsWith('/')`, verdadeiro para todo o pathname. Medido na mesma composição:

```
  register({kind:"prefix", path:""}) lançou? NAO
  o assento de fallback continua do frontend-static? true
  GET /                          -> 401 (CAPTURADO)
  GET /rota-spa                  -> 401 (CAPTURADO)
  GET /assets/app.js             -> 401 (CAPTURADO)
  GET /api/state                 -> 200 (passou ao lado)
  GET /plugins/x/client.js       -> 200 (passou ao lado)
  GET /__dsh_invariant_probe__   -> 200 (passou ao lado)
  UPGRADE /api/events.mux            -> upgrade (o prefix "" nao ve upgrades)
```

É **API pública**, devolve **disposer nativo**, **não** colide com o assento de fallback e **não** leva o
`frontend-static` a FAILED. É exactamente o que a arte prévia usa (§7.1). O que **não** cobre, por
construção do `match()`: qualquer rota `exact` (ganha sempre, `:195-196`), qualquer `prefix` mais longo —
`/api` e `/plugins` inclusive (`:200`) — e **nenhum** upgrade, que nem passa por `match()`.

**O preço escondido:** o `prefix ''` intercepta o tráfego que ia para o assento de fallback, portanto a SPA
morre a menos que o handler **delegue** ao dono do assento. E a única forma de o fazer é ler
`ctx.webServer.fallback` — campo `private`. É o que a arte prévia faz (`dsh-webui-auth/index.js:1261`).
Medido:

```
  GET / sem credencial -> 302 location=/login
  GET / com credencial -> 200, applyIndexTaps preservado? true
  => a delegacao exigiu ler `ws.fallback` (campo `private`): a opcao (b) NAO e 100% API publica.
```

**Conclusão corrigida:** (b.2) é a melhor peça **pública** disponível e cobre a superfície SPA/estática com
um único registo. Não é uma barreira completa — deixa `/api`, `/plugins`, qualquer `exact` e todos os
upgrades por guardar — e o seu uso realista ainda toca um campo `private`. Entra na recomendação como
**componente do híbrido** (§9.4), não como alternativa a (d).

### (c) Tomar o assento de fallback primeiro — **INVIÁVEL**

```
  c.1 — assento JA tomado pelo frontend-static, guarda tenta reclamar:
    lancou: Error: webserver: fallback already registered
  c.2 — guarda toma o assento PRIMEIRO; o frontend-static entra depois:
    fiber do frontend-static: state=3 erro=webserver: fallback already registered
    GET / -> 401 "guarda"  (a SPA morreu; so a guarda responde)
```

Não degrada: **quebra**. O fiber do `frontend-static` termina em `FiberState = 3` (FAILED) e a SPA deixa de
existir. E mesmo que se aceitasse essa quebra, o assento de fallback **não cobre rotas nomeadas**: `/api`,
`/plugins` e a sonda `exact` são resolvidos por `match()` **antes** de o fallback ser sequer consultado
(`lib/index.js:108-119`). Uma barreira só no fallback deixa a API inteira exposta.

**Nota de correcção.** Isto refuta *tomar o assento*, não *cobrir a superfície do fallback*. Para essa
superfície existe a via pública (b.2), que a alcança **sem** disputar o assento e sem partir o
`frontend-static`. As duas coisas não são a mesma, e a minha primeira redacção confundia-as.

Quem tomar o assento fica ainda com uma obrigação herdada: `applyIndexTaps` é chamado **pelo dono do
fallback** (`frontend-static/lib/index.js:72`). Abandonar o assento sem reimplementar isso mata em silêncio
o manifesto de boot do host.

### (d) Envolver o servidor `node:http` por baixo — **VIÁVEL. É a recomendação.**

`server` é `private` **apenas em TypeScript**. No `lib/index.js` publicado é um campo de classe comum,
atribuído em `[Service.init]`:

```js
		this.server = createServer((req, res) => {
			handle(req, res).catch((err) => { … });
		});
		this.server.on("upgrade", (req, socket, head) => { … });
```

`createServer(cb)` regista `cb` como listener de `'request'`; a linha seguinte regista o listener de
`'upgrade'`. **Esses dois listeners são o topo absoluto do despacho** — `match()`, o assento de fallback e a
tabela `upgrades` vivem todos por baixo deles.

O mecanismo é: **capturar os listeners existentes, retirá-los do emissor, instalar um único listener nosso
que decide e só então delega.**

> Porque não `prependListener`: o `EventEmitter` do Node não tem waterfall nem veto. Um listener prepended
> corre primeiro mas **não impede** os seguintes de correr. Para **bloquear**, é preciso ser o dono do
> despacho. Esta é a razão técnica de a barreira remover-e-delegar em vez de prefixar.

Precondição única, medida:

```
  no momento em que `inject:["webServer"]` activa:
    {"temServer":true,"ehHttpServer":"Server","aEscutar":true,"listenersRequest":1,"listenersUpgrade":1,"propsVisiveisNoProxy":11}
  falha-alto quando o servidor ainda nao existe (servico fabricado sem `server`):
    BarreiraIndisponivel: barreira: nenhum node:http.Server encontrado no servico webServer (campos: nada)
```

Quando um plugin com `inject: ['webServer']` activa, o servidor já existe, já está a escutar, e tem
exactamente **1** listener de `request` e **1** de `upgrade`. A barreira é instalável a partir do primeiro
instante em que o plugin pode correr.

Implementação em `scripts/spike/intercept/barreira.mjs`; prova em §7.

### (e1) Fachada via waterfall `internal/get` — **INVIÁVEL por âmbito**

`reflect.ts:153` dispara `ctx.events.waterfall('internal/get', ctx, prop, error, …)` a cada leitura de
serviço, e um listener pode substituir o valor devolvido. Três medições matam a ideia:

1. `events.ts:166` — `const thisArg = typeof args[0] === 'object' … ? args.shift() : null`. A chamada passa
   a string `'internal/get'` como primeiro argumento, logo `thisArg = null`, logo `filter` é `null`
   (`events.ts:171-173`) e **todos** os listeners recebem o evento, de qualquer contexto. Uma fachada
   instalada assim é global e cobre leituras que não são nossas.
2. `reflect.ts:152` — `if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)`. Leituras a partir do
   contexto raiz **saltam o waterfall** por completo. Existe um caminho de fuga estrutural.
3. Mesmo funcionando, só intercepta **leituras futuras** do serviço. Quem já leu `ctx.webServer` e registou
   a rota não volta a ler. Herda a falha de janela da opção (a).

### (e2) Reescrever as tabelas de rota — **VIÁVEL mas inferior**

```
  GET /api/state               -> 401 (guardado)
  GET /                        -> 401 (guardado)
  GET /__dsh_invariant_probe__ -> 401 (guardado)
  GET /tardia/x (registada APOS a instalacao) -> 200 (PASSOU AO LADO — buraco de janela)
  apos disposer: GET /api/state -> 200
  campos `private` tocados: exact, prefixes, upgrades, fallback (4) + leitura de indexTaps
```

Funciona no instante da instalação e é reversível. Duas desvantagens medidas contra (d):

- **Buraco de janela:** qualquer rota registada **depois** da instalação fica por guardar.
- **Acoplamento a 4 campos `private`** em vez de 1. Cada renomeação futura reabre uma brecha em silêncio.

> **Correcção após revisão.** Chamei a isto "plano B" cedo demais: **é a arte prévia real.** O
> `dsh-webui-auth@0.3.0`, publicado no npm, usa exactamente este mecanismo — e **fecha o buraco de janela**
> com um rescan periódico de 2 s que transita para 10 s (`index.js:770-795`). A única desvantagem que eu
> tinha medido já tem solução publicada. O que o rescan faz é **reduzir** a janela, não eliminá-la — o
> próprio README do pacote declara-o —, e o modelo continua a não varrer a tabela `exact`. Análise completa,
> com medições próprias, em §7.1.

Continua a ser a alternativa a adoptar caso uma versão futura do `WebServer` deixe de expor um
`node:http.Server`; e o seu rescan é uma técnica a copiar mesmo usando (d) (§9.2).

### (e3) Realm `isolate` + fachada própria — **INVIÁVEL para este caso**

`editing-cordis-compositions/SKILL.md:82-99` documenta linhas de grupo com `isolate: { <serviço>: true }`.
Um grupo com `isolate: { webServer: true }` faria os filhos resolverem noutro realm — onde teríamos de
**prover** uma fachada. Mas isso exigiria mover para dentro desse grupo **todas** as linhas que registam
rotas (`connection`, `modules`, `web-runtime`), reescrevendo a composição do bundle do fornecedor a partir
da camada de Perfil. E `SKILL.md:99` mede o limite: *"`provide()` still throws on the second registration
under that symbol"*. O custo é reescrever a topologia da composição alheia; a opção (d) não pede nada disso.

---

## 6. Q4 — a ordem de carregamento é controlável? **NÃO**

`@deepseek-ai/dsh-base@0.1.0-rc.7/cordis.patch.yml:12-13`, colado:

```yaml
# Row order carries no load semantics (activation is service-availability
# driven); the grouping is for readers.
```

Campos que uma linha de patch aceita, lidos das composições publicadas: `id`, `name`, `config`, `disabled`,
`inject`, `group`, `isolate`, e a operação `insert`. **Não existe** `priority`, `before`, `after`, `order`
nem qualquer forma de fixar precedência entre irmãos. A `SKILL.md` oficial de composições (154 linhas, lida
por inteiro) também não menciona nenhuma.

O que se observa em runtime é que a activação segue a ordem de registo:

```
  linhas registadas A,B,C ANTES do webServer; activacao observada: A,B,C
  linhas registadas DEPOIS do webServer; activacao observada:   X,Y
```

Isso é **comportamento observado, não contrato** — e o comentário do fornecedor declara explicitamente o
contrário como intenção de desenho. Qualquer mecanismo que dependa de "carregar primeiro" é uma corrida
contra uma propriedade que o fornecedor se reservou o direito de mudar.

**É por isso que (a) está morta e (d) é a recomendação:** (d) é a única candidata cuja correção não depende
de ordem nenhuma.

---

## 7. Q5 — o que o próprio ecossistema faz

> **CORRECÇÃO DE UM FALSO NEGATIVO MEU.** A primeira versão desta secção afirmava que *"não existe
> middleware HTTP transversal em nenhum pacote publicado do DSH"* e classificava `dsh-webui-auth` como não
> encontrado. **Ambas as afirmações estavam erradas.** Procurei apenas sob o escopo `@deepseek-ai/`, que dá
> 404; **o pacote não é escopado**. A revisão adversarial apanhou-o e eu confirmei-o em primeira mão.

### 7.1 A arte prévia real: `dsh-webui-auth@0.3.0`

```console
$ npm view dsh-webui-auth version
0.3.0
$ npm pack dsh-webui-auth@0.3.0 && sha256sum dsh-webui-auth-0.3.0.tgz
05283cd3500891b13200ca1f1a2a5edc215b64805d799f73c439c67d89ab5aa2  dsh-webui-auth-0.3.0.tgz
```

MIT, autor `yuuz12`, 8 versões (`0.1.0` … `0.3.0`), a última publicada em 2026-08-18 — dois dias antes desta
medição. Descrição: *"Persistent WebUI authentication plugin for DeepSeek Harness"*. É um **bundle** com
`cordis.patch.yml` próprio (4 linhas, um `insert` de uma linha), `index.js` de 1343 linhas e uma metade de
cliente de 336 linhas, com zero dependências.

**Resolve o mesmo problema que este spike.** É arte prévia directa e a comparação honesta é obrigatória.

#### O que ele faz

Quatro camadas, todas por embrulho em runtime, declaradas no próprio README (`README.en.md:9-16`):

| Superfície | Mecanismo dele | Resposta |
| --- | --- | --- |
| SPA, `index.html`, `/assets/*` | regista `{kind:'prefix', path:''}` e, após validar a sessão, delega em `ctx.webServer.fallback` | 302 → login |
| `/plugins/*` | reescreve `route.handler` in-place em `ws.prefixes.get('/plugins')` | 401 |
| `/api` | reescreve `route.handler` in-place em `ws.prefixes.get('/api')` | 401 |
| WebSockets `/api/events.mux`, `/api/events.host` | reescreve `route.handler` in-place em `ws.upgrades.get(path)` | 401 no upgrade |

Ou seja: **a minha opção (e2), que eu tinha rotulado "plano B", é a arte prévia real** — combinada com a
opção (b.2) para a superfície do fallback. `installRouteGate` (`index.js:690-806`) é o coração.

#### O que ele faz melhor do que eu tinha medido

**Fecha o buraco de janela com rescan periódico.** A minha medição de (e2) mostrou que uma rota registada
depois da instalação fica por guardar. Ele resolve isso com um `setInterval` de 2 s que reexamina as
tabelas até tudo estar embrulhado, e depois **transita para 10 s** como rede permanente
(`index.js:770-795`), porque *"服务 fiber 重建时路由对象会换新"* — quando o fiber do serviço remonta, o objecto
de rota é substituído. Desiste ao fim de 150 tentativas (5 min) e regista o erro.

**É fail-closed a sério.** Se as rotas esperadas não aparecem, `setup`/`configure` **recusam activar a
autenticação** (`index.js:894-899`), com o raciocínio explícito: *"better unusable than 'login enabled with
an unprotected /api'"*. Isto é exactamente a política que eu recomendo em §9.2, e é bom ver a mesma
conclusão alcançada de forma independente.

**Marca os embrulhos com um `WeakSet`** para não embrulhar duas vezes o mesmo objecto de rota
(`index.js:738`) — a defesa correcta para um mecanismo que reexamina.

#### O que ele resolve e que eu tinha deixado em aberto: `loopbackDeputy`

Na primeira versão deixei uma nota solta a dizer que `isTrustedApiRequest` faz o DSH responder 403 em `/api`
atrás de um túnel. **Ele resolve isso com código**, e o comentário do autor documenta a medição
(`index.js:702-720`):

```js
      if (loopbackDeputy) {
        // Authenticated + this is the /api surface: present the request to the
        // core as loopback so PRIVILEGED_METHODS' strict fence (settings.*,
        // credentials.*, agentPreset.*, llm.discoverModels) admits it. Our
        // session gate already proved operator identity — strictly stronger
        // than the Host-header heuristic it replaces for these callers.
        req.headers.host = '127.0.0.1'
        // Origin/Fetch-Metadata 一并移除：以"非浏览器回环客户端"形状呈现。
        // 不能只改写 Origin 的 host——Host 带 127.0.0.1:3080 端口而改写后的
        // Origin 无端口时 host 比对仍不相等（实测 403）。删除后走 fence 的
        // 无-Origin 回环放行路径（实测 200）
        delete req.headers.origin
        delete req.headers['sec-fetch-site']
        delete req.headers['sec-fetch-mode']
        delete req.headers['sec-fetch-dest']
      }
```

Não aceitei a alegação de palavra: **executei a cerca real**. `scripts/spike/intercept/cerca-real.mjs`
recorta em runtime a região das funções da cerca do `lib/index.js` publicado de
`@deepseek-ai/dsh-client-connection@0.1.0-rc.8` e importa-a — sem vendorizar nada. Saída bruta:

```
  fonte: @deepseek-ai/dsh-client-connection/lib/index.js linhas 100..198 (sha256[0:16]=4f9d13d1d2891009)
  corpo executado, colado do pacote publicado:
    | function isTrustedApiRequest(request, trustedHosts) {
    | 	const host = header(request.headers, "host");
    | 	if (host === void 0) return false;
    | 	const hostUrl = parseAuthority(host);
    | 	if (hostUrl === void 0) return false;
    | 	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
    | 	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
    | 	const origin = header(request.headers, "origin");
    | 	if (origin === void 0) return true;
    | 	try {
    | 		return new URL(origin).host === hostUrl.host;
    | 	} catch {
    | 		return false;
    | 	}
    | }
  tunel cru: Host publico + Origin publico               -> RECUSADO (403)
  so Host reescrito para loopback, Origin mantido        -> RECUSADO (403)
  Host loopback COM porta + Origin reescrito SEM porta   -> RECUSADO (403)
  loopbackDeputy: Host loopback + Origin/sec-fetch APAGADOS -> PASSA (a rota responderia)
  sec-fetch-site: cross-site, resto loopback             -> RECUSADO (403)
```

**A alegação dele confirma-se em todos os pontos.** Reescrever só o `Origin` não basta, porque
`new URL(origin).host` (`"127.0.0.1"`) não iguala `hostUrl.host` (`"127.0.0.1:3080"`) — a comparação da
cerca inclui a porta. Apagar `origin` leva a cerca ao ramo `if (origin === void 0) return true`.

**Entrada directa para a Onda 3.** Se o plugin desta wave quiser que os métodos privilegiados
(`settings.*`, `credentials.*`, `agentPreset.*`, `llm.discoverModels`) funcionem atrás de um túnel, a
receita medida é: **depois** de validar a sessão, pôr `req.headers.host = '127.0.0.1'` e apagar `origin`,
`sec-fetch-site`, `sec-fetch-mode`, `sec-fetch-dest`. E a contrapartida de segurança tem de ficar escrita:
isto **desarma deliberadamente** a defesa contra DNS-rebinding e cross-site do núcleo, trocando-a pela nossa
sessão. Só é defensável se a sessão for provada **antes** — que é precisamente a ordem que a barreira (d)
garante.

> Limitação que ele próprio declara e que continua a valer para nós (`README.en.md:21,141`): o handshake de
> WebSocket ainda passa pela cerca do núcleo, portanto em implantações não-loopback é preciso acrescentar o
> hostname público a `client-connection.trustedHosts`.

#### Onde a cobertura dele fica aquém

`PROTECTED_PREFIXES` é `['/api', '/plugins']` (`index.js:740`), literal. **A tabela `ws.exact` nunca é
varrida.** Repliquei o modelo dele na minha composição e medi o buraco:

```
  tabela `exact` foi varrida pelo modelo? NAO — PROTECTED_PREFIXES so tem prefixos
  GET /api/state                 -> 401 (guardado)
  GET /plugins/x/client.js       -> 401 (guardado)
  GET /__dsh_invariant_probe__   -> 200 (DESCOBERTO — rota exact fora do modelo)
```

Qualquer rota `exact`, e qualquer `prefix` que não seja um destes dois literais, fica **fora da barreira**.
Uma barreira por inventário de rotas guarda o inventário que conhece; a barreira (d) guarda o despacho, e
por isso não tem inventário.

E a janela que o rescan mitiga **não fecha** — o próprio README admite-o (`README.en.md:140`):
*"Inherent runtime-wrapping window: between a route-object replacement (service hot-reload) and the next
rescan (≤10s) there is an unprotected window."* Medido por mim:

```
  apos o scan inicial: GET /api/state -> 401
  objeto de rota substituido (remonta de fiber), ANTES do proximo rescan:
    GET /api/state -> 200 (janela aberta ate ao proximo scan)
  depois do rescan: GET /api/state -> 401
```

#### Veredito da comparação

| Critério | `dsh-webui-auth@0.3.0` (b.2 + e2) | Recomendação (d) |
| --- | --- | --- |
| Cobre `prefix` `/api`, `/plugins` | Sim, por embrulho | Sim, sem os conhecer |
| Cobre **qualquer outro** `prefix` | **Não** — lista literal | Sim |
| Cobre rotas `exact` | **Não** — `ws.exact` nunca varrida | Sim |
| Cobre o fallback / SPA | Sim, via `prefix ''` + delegação | Sim |
| Cobre `registerUpgrade` | Sim, por embrulho dos dois paths conhecidos | Sim, todos |
| Rotas registadas depois | Sim, ≤2 s de atraso (depois ≤10 s) | Sim, **imediato** |
| Janela após remonta de fiber | **Sim, até 10 s** (declarada) | Nenhuma |
| Campos `private` tocados | `prefixes`, `upgrades`, `fallback` (3) | `server` (1) |
| API pública usada | `register` (para o `prefix ''`) | nenhuma |
| Reversível | Sim, restaura handlers e limpa intervalos | Sim, síncrono |
| Fail-closed | Sim, explícito | Sim, `BarreiraIndisponivel` |
| Maturidade | **Publicado, 8 versões, em uso** | Protótipo de spike |

**(d) continua preferível** por cobertura (não tem inventário a manter), por imediatismo (zero janela) e por
acoplamento (1 campo contra 3). Mas a arte prévia ganha em duas coisas que a Onda 1 tem de copiar: **o
rescan como rede de segurança** e o **`loopbackDeputy`**. E ganha na única coisa que nenhum spike compra:
está publicada e a correr.

### 7.2 O que o núcleo do DSH faz

**No núcleo não existe middleware HTTP transversal.** O que existe são guardas escritos **dentro de cada
handler**, repetidos por quem regista a rota. O precedente canónico é
`@deepseek-ai/dsh-client-connection@0.1.0-rc.8`, `lib/index.js:184-198` (corpo colado em §7.1). Chamado três
vezes, sempre no interior do handler: na rota `/api` (`:553`), em cada canal RPC (`:248`) e em cada
`registerUpgrade` (`:571`).

A conclusão continua de pé, agora com a redacção certa: **quem quer guardar HTTP no DSH tem de possuir o
handler — ou tomar o despacho.** O núcleo não oferece uma terceira via, e é por isso que tanto o
`dsh-webui-auth` como este spike acabam em mecanismos que tocam campos `private`.

O único primitivo de interceção que o núcleo publica é de **endpoint**, não de barreira —
`HostConnectionService.rpc.intercept(channel, matches, handler, options)` (`lib/index.js:257-278`): dono
único (lança na segunda tentativa), restrito ao canal `/api`, e só substitui os endpoints que o predicado
`matches` reclama. Não envolve o fallback do canal, não vê `/plugins`, não vê os WebSockets.

**Interação com a barreira recomendada.** A barreira é dona do despacho, portanto corre **antes** de
`isTrustedApiRequest`. O que ela recusa nunca chega à cerca de confiança; o que ela permite continua a
enfrentá-la intacta — provado pelas FASES C e D, onde as respostas 200 vêm dos handlers originais. As duas
camadas compõem-se e nenhuma enfraquece a outra, e é essa ordem que torna o `loopbackDeputy` defensável.

## 8. O experimento executável

```console
$ bash scripts/spike/intercept/run.sh
```

Ficheiros: `barreira.mjs` (o mecanismo, 217 l.), `composicao.mjs` (a composição Cordis mínima, 115 l.),
`http-lab.mjs` (cliente HTTP/upgrade cru, 70 l.), `cerca-real.mjs` (recorta e importa a cerca de confiança
publicada, 42 l.), `experimento.mjs` (a prova, 127 l.), `falsificacao.mjs` (as opções refutadas, 311 l.),
`posse.mjs` (posse do despacho e semântica de `upgrade`, 120 l.), `arte-previa.mjs` (medições sobre
`dsh-webui-auth`, 138 l.), `run.sh`, `saidas/execucao.txt` (a saída completa).

**São 35 asserções `PASS`**, cada uma um `res.statusCode` (ou um resultado de upgrade) de uma requisição
`node:http` real — contadas com `grep -cE '^  PASS  '`. Um `grep -c PASS` ingénuo devolve 44 porque apanha
também as 8 linhas `PASSOU AO LADO` da bateria de falsificação e a linha final `PASSARAM`; o número correcto
é 35.

A composição usa o **`WebServer` real** e o **`frontend-static` real** (o pacote publicado, a servir um
`index.html` de fixture pelo assento de fallback), e reproduz a superfície de rotas medida em §5.

### Saída bruta, colada

```
### node v24.15.0 | webserver 0.1.0-rc.8 | cordis 4.0.1

servidor real em http://127.0.0.1:39485
tabelas de rota enumeradas (campos `private` so no TypeScript):
  {"exact":["/__dsh_invariant_probe__"],"prefix":["/api","/plugins"],"upgrade":["/api/events.mux","/api/events.host"],"indexTaps":1,"fallbackClaimed":true}

FASE A — sem barreira (linha de base)
  PASS  A register prefix  (/api — dsh-client-connection)          -> 200
  PASS  A register prefix  (/plugins — dsh-client-modules)         -> 200
  PASS  A register exact   (sonda de invariante)                   -> 200
  PASS  A registerFallback (frontend-static, index)                -> 200
  PASS  A registerFallback (frontend-static, SPA)                  -> 200
  PASS  A registerUpgrade  (WebSocket mux)                         -> upgrade
  PASS  A registerUpgrade  (WebSocket host)                        -> upgrade
  PASS  A applyIndexTaps aplicado ao index                         -> true

FASE B — barreira instalada DEPOIS de todos os registos, sem credencial
  PASS  B register prefix  (/api — dsh-client-connection)          -> 401
  PASS  B register prefix  (/plugins — dsh-client-modules)         -> 401
  PASS  B register exact   (sonda de invariante)                   -> 401
  PASS  B registerFallback (frontend-static, index)                -> 401
  PASS  B registerFallback (frontend-static, SPA)                  -> 401
  PASS  B cabecalho WWW-Authenticate presente                      -> true
  PASS  B registerUpgrade  (WebSocket mux)                         -> resposta:401
  PASS  B registerUpgrade  (WebSocket host)                        -> resposta:401

FASE B2 — rota registada DEPOIS da barreira ja instalada
  PASS  B2 register prefix registado APOS a barreira               -> 401
  PASS  B2 registerUpgrade registado APOS a barreira               -> resposta:401
  PASS  B2 mesma rota com credencial valida                        -> 200

FASE C — barreira instalada, COM credencial valida
  PASS  C register prefix  (/api — dsh-client-connection)          -> 200
  PASS  C register prefix  (/plugins — dsh-client-modules)         -> 200
  PASS  C register exact   (sonda de invariante)                   -> 200
  PASS  C registerFallback (frontend-static, index)                -> 200
  PASS  C registerFallback (frontend-static, SPA)                  -> 200
  PASS  C registerUpgrade  (WebSocket mux)                         -> upgrade
  PASS  C registerUpgrade  (WebSocket host)                        -> upgrade
  PASS  C applyIndexTaps continua a correr sob a barreira          -> true

FASE D — disposer sincrono executado; sem credencial de novo
  PASS  D register prefix  (/api — dsh-client-connection)          -> 200
  PASS  D register prefix  (/plugins — dsh-client-modules)         -> 200
  PASS  D register exact   (sonda de invariante)                   -> 200
  PASS  D registerFallback (frontend-static, index)                -> 200
  PASS  D registerFallback (frontend-static, SPA)                  -> 200
  PASS  D registerUpgrade  (WebSocket mux)                         -> upgrade
  PASS  D registerUpgrade  (WebSocket host)                        -> upgrade
  PASS  D applyIndexTaps intacto apos reversao                     -> true

RESULTADO: TODAS AS ASSERCOES PASSARAM
```

O que cada fase prova:

- **A** — linha de base honesta: sem barreira, as sete rotas de outros plugins respondem, e o
  `applyIndexTaps` do host injecta a marca no index.
- **B** — a barreira foi instalada **depois** de toda a gente ter registado, e ainda assim os três caminhos
  ficam guardados. **Isto é a refutação executável da exigência de ordem de carregamento.**
- **B2** — uma rota e um upgrade registados **depois** da barreira já instalada também ficam guardados.
  A cobertura é do despacho, não do inventário de rotas.
- **C** — com credencial válida o tráfego passa **para os handlers originais** (200 vem deles, não de nós),
  e `applyIndexTaps` continua a correr: o manifesto de boot do host sobrevive.
- **D** — o disposer é síncrono e devolve o comportamento exacto de A.

A `falsificacao.mjs` produz o resto da saída bruta já colada em §3, §5 e §6.

---

## 9. RECOMENDAÇÃO DE DESENHO PARA A ONDA 1

### 9.1 O mecanismo

**Troca de dono do despacho no `node:http.Server` do serviço `webServer`.** O plugin declara
`inject: ['webServer']`; dentro de um `ctx.effect(…)`:

1. resolve o `node:http.Server` — `webServer.server`, com varrimento por `instanceof Server` sobre
   `Object.getOwnPropertyNames` como rede de segurança contra renomeação do campo;
2. captura `server.listeners('request')` e `server.listeners('upgrade')`;
3. **recusa instalar** se algum listener já existente trouxer a marca de posse — duas barreiras empilhadas
   são a origem do modo de falha de §9.5;
4. `server.removeAllListeners('request')` e instala **um** listener nosso, marcado com `MARCA_DE_POSSE`;
5. faz o mesmo para `'upgrade'` **apenas se já existia pelo menos um listener de upgrade** (§9.6);
6. devolve um **disposer síncrono** que, **depois de verificar que o despacho ainda é nosso**, remove os
   nossos e reinstala os capturados na ordem original; se a posse se perdeu, remove só o que é nosso e
   falha alto.

Referência executável e comentada: `scripts/spike/intercept/barreira.mjs`.

### 9.2 Condições de contorno, todas medidas

| Condição | Regra para a Onda 1 |
| --- | --- |
| **Ordem de carregamento** | **Nenhuma exigência.** Provado pela FASE B (instalação depois de todos) e FASE B2 (rotas depois da instalação). A linha do plugin pode ficar em qualquer posição do `cordis.patch.yml`. |
| **Precondição** | O `webServer` tem de estar ACTIVE. `inject: ['webServer']` garante-o: medido — `listening: true`, 1 listener `request`, 1 listener `upgrade`. |
| **Assento de fallback já tomado** | **Irrelevante — e é essa a vantagem.** A barreira nunca chama `registerFallback`. O `frontend-static` mantém o assento e continua a servir a SPA (FASES C e D). Nenhum `webserver: fallback already registered`. |
| **`applyIndexTaps`** | Continua a ser responsabilidade do `frontend-static`, que nunca a perde. Medido em C e D. Nada a reimplementar. |
| **Reversão** | Disposer síncrono, cumprindo **Q-2**. Restaura os listeners originais por identidade e ordem **desde que a barreira ainda seja a dona do despacho** — ver §9.5, que é uma ressalva real e não teórica. Idempotente contra chamadas repetidas (guarda `revertido`). FASE D volta ao comportamento exacto de A. |
| **Falha-alto** | Se o servidor não for localizável, lançar `BarreiraIndisponivel`. **Nunca degradar para "sem barreira"** — um `catch` silencioso aqui é uma credencial universal. |
| **Interação com `isTrustedApiRequest`** | A barreira corre antes; a cerca de confiança do DSH permanece intacta por baixo. As duas compõem-se (§7). |
| **Listeners de terceiros** | Se algo registar um listener `request` **adicional** entre a instalação e a reversão, ele não é guardado (o EventEmitter chama-o em paralelo) e sobrevive à reversão. Se um terceiro **tomar** o despacho (`removeAllListeners`), a reversão detecta-o e falha alto em vez de restaurar por cima — §9.5. Nenhum pacote medido da composição faz nenhuma das duas coisas. |
| **Acoplamento a `private`** | Exactamente **um** campo: `server`. Contra 4 na opção (e2). Prender a faixa suportada a `@deepseek-ai/dsh-host-webserver@0.1.0-rc.7 .. rc.9` e testar por contrato que o servidor continua localizável. |
| **Plano B** | Se uma versão futura deixar de expor um `node:http.Server`, cair para (e2) — reescrita das tabelas, o mecanismo da arte prévia — assumindo o buraco de janela e o acoplamento a 4 campos. |
| **Rede de segurança a copiar da arte prévia** | Um rescan de baixa frequência que reafirma a posse do despacho (`listeners('request')[0] === onRequest`). O `dsh-webui-auth` usa 2 s → 10 s pela mesma razão: o fiber do serviço pode remontar e substituir o que estava lá. Para (d) isto é barato — uma comparação de identidade, não um varrimento de tabelas. |
| **`loopbackDeputy` (Onda 3, não Onda 1)** | Para métodos privilegiados atrás de um túnel: **depois** de autorizar, `req.headers.host = '127.0.0.1'` e apagar `origin`, `sec-fetch-site`, `sec-fetch-mode`, `sec-fetch-dest`. Medido contra a cerca real em §7.1. Desarma deliberadamente a defesa anti-rebinding do núcleo — só admissível porque a barreira corre **antes**. |

### 9.3 Vereditos, lado a lado

| Opção | Veredito | Razão **medida** |
| --- | --- | --- |
| `ctx.intercept('webServer', …)` | **INVIÁVEL** | `context.ts:141-145` só faz merge de config; o `WebServer` nem sequer lê essa config (`grep resolveConfig` sem ocorrências). Compila em silêncio, não faz nada. |
| (a) monkey-patch dos 3 métodos | **INVIÁVEL** | Exige ordem não contratual **e** o disposer não desfaz handlers já envolvidos (a.1: 401 depois da reversão). |
| (b.1) rota `prefix '/'` | **INVIÁVEL** | Captura só `/`. `/rota-spa`, `/api`, `/plugins` e `exact` passam ao lado. |
| (b.2) rota `prefix ''` | **VIÁVEL, parcial** | Catch-all público sobre a superfície não reclamada (`/`, SPA, `/assets/*`). Não vê `exact`, nem prefixos mais longos (`/api`, `/plugins`), nem upgrades. Delegar à SPA obriga a ler `ws.fallback`. **Componente do híbrido**, não alternativa. |
| (c) assento de fallback | **INVIÁVEL** | Segunda chamada lança; tomar primeiro leva o `frontend-static` a FAILED (state=3). E não cobre rotas nomeadas. |
| (d) dono do despacho no `node:http.Server` | **VIÁVEL — recomendado** | Cobre os 3 caminhos, sem ordem, reversível, 1 campo `private`. |
| (e1) waterfall `internal/get` | **INVIÁVEL** | Sem filtro de contexto (`events.ts:166-173`), com fuga no contexto raiz (`reflect.ts:152`), e só apanha leituras futuras. |
| (e2) reescrita das tabelas | **VIÁVEL, inferior** | **É a arte prévia** (`dsh-webui-auth@0.3.0`). Funciona e reverte; o buraco de janela é mitigado por rescan 2 s→10 s mas não fechado, e o modelo não varre `ws.exact`. Acopla a 3-4 campos `private`. |
| (e3) realm `isolate` + fachada | **INVIÁVEL** | Exigiria reescrever a topologia da composição do fornecedor a partir da camada de Perfil. |

### 9.4 O híbrido público-parcial, e porque não é a recomendação

A arte prévia combina **(b.2) `prefix ''`** para a superfície não reclamada com **(e2)** para as rotas
nomeadas. É uma composição legítima e tem uma virtude que (d) não tem: a metade que cobre mais tráfego
(SPA, `index.html`, `/assets/*`) usa **API pública**, com disposer nativo e zero acoplamento.

Registado como alternativa de contingência, com a fronteira medida:

| Superfície | (b.2) `prefix ''` cobre? | Precisa de (e2) por cima? |
| --- | --- | --- |
| `/`, rotas SPA, `/assets/*` | **Sim** | Não (mas obriga a ler `ws.fallback` para delegar) |
| `prefix /api`, `prefix /plugins` | Não — prefixo mais longo ganha | **Sim** |
| qualquer rota `exact` | Não — `exact` ganha sempre | **Sim**, e a arte prévia não o faz |
| `registerUpgrade` | Não — nem passa por `match()` | **Sim** |

Não é a recomendação porque a soma continua a ser um mecanismo **por inventário**: cobre o que enumera. (d)
cobre o despacho e não enumera nada — é por isso que a FASE B2 guarda uma rota que ainda não existia quando
a barreira foi instalada.

**Quando escolher o híbrido em vez de (d):** se a Onda 1 decidir que tocar em `ws.server` é risco
inaceitável, o híbrido é a via de menor acoplamento *público*. Nesse caso, copiar da arte prévia o rescan e
o fail-closed, e **acrescentar** o varrimento de `ws.exact`, que ela não faz.

### 9.5 Posse do despacho: a ressalva que faltava à reversão

A primeira versão desta recomendação afirmava que o disposer era *"idempotente"* e que *"restaura os
listeners originais por identidade e ordem"*, **sem ressalva**. A ressalva existe e é séria.

Dentro de um fiber os disposers correm em LIFO e o problema não aparece. **Entre fibers distintos, aparece.**
Duas barreiras instaladas por donos diferentes e revertidas fora de ordem LIFO, medido com a versão ingénua
(exactamente o que o código fazia antes deste endurecimento):

```
  M1.a — o PERIGO, reproduzido com a versao ingenua (sem marca de posse):
    apos instalar A e B: listenerCount(request)=1
    apos a() (nao-LIFO):  listenerCount(request)=2 <- despacho DUPLICADO
    apos b():             listenerCount(request)=2
    GET /api/state -> 200 (BARREIRA DESAPARECEU)
    excecoes nao capturadas no processo: ["ERR_HTTP_HEADERS_SENT"] <- dupla escrita no mesmo res
```

Reverter A enquanto B está instalada reinstala o despacho original **a correr em paralelo** com o listener
de B. O resultado não é só "a barreira desaparece": é uma **dupla escrita no mesmo `res`**, que levanta um
`ERR_HTTP_HEADERS_SENT` **não capturável pelo cliente** e derruba o processo se nada o apanhar.

**A correcção fecha a classe inteira do problema, na instalação e não na reversão:**

1. **Marca de posse.** O listener instalado leva `Symbol.for('dsh-guard.barreira.dono')`. Uma segunda
   instalação no mesmo servidor é **recusada**:

```
  M1.b — a versao endurecida RECUSA o empilhamento na instalacao:
    marca de posse no listener instalado? true
    BarreiraIndisponivel: barreira: ja existe uma barreira instalada neste servidor.
    listenerCount(request)=1 (inalterado)
    apos reversao: listenerCount(request)=1, GET /api/state -> 200
```

2. **Verificação de posse na reversão.** Se um terceiro tomou o despacho ignorando a marca, o disposer
   remove apenas o que é nosso e **falha alto**, em vez de restaurar por cima:

```
  M1.c — perda de posse por terceiro: a reversao NAO restaura por cima, falha alto:
    BarreiraIndisponivel: barreira: o despacho ja nao e nosso no momento da reversao
    listenerCount(request)=1 (so o terceiro; sem duplicacao)
    GET /api/state -> 418 (o terceiro responde, nada duplicado)
```

**Regra para a Onda 1:** se a barreira detectar que já não é a dona do listener, **falhar alto** com
`BarreiraIndisponivel` — coerente com o resto da política. Nunca restaurar por cima de outro dono: uma
resposta duplicada é pior do que um erro visível. E **nunca** empilhar duas barreiras: o mecanismo recusa-o
por construção.

### 9.6 Semântica de `upgrade` sem listeners: uma correcção que favorece o desenho

Assumi inicialmente que um servidor sem listeners de `upgrade` fecharia a ligação. **Está errado no
Node 24**, e medi-o:

```
  M2 — Node 24: servidor com ZERO listeners de `upgrade` NAO fecha a ligacao
  listenerCount('upgrade') = 0
  pedido com Connection: Upgrade -> {"resultado":"resposta","status":200}
  com 1 listener de upgrade      -> {"resultado":"upgrade","status":101}
```

Sem listeners de `upgrade`, o pedido cai no caminho **`request`** — que a barreira já guarda.

Consequência directa no código, e era um defeito real: instalar um listener de `upgrade` onde não havia
nenhum mudaria a semântica do servidor **e** deixaria um upgrade autorizado a delegar numa lista vazia,
pendurando o socket. A barreira passa a instalar o listener de `upgrade` **apenas se já existia pelo menos
um**. Na composição Web real existe sempre (o `dsh-client-connection` regista dois), portanto o caminho
condicional só se exerce em composições sem WebSocket — onde a cobertura fica garantida pelo caminho
`request`.

---

## 10. O que fica impossível

1. **Guardar a superfície INTEIRA sem tocar em campo `private`.** Correcção à minha primeira redacção, que
   dizia que a API pública não oferecia *nenhum* ponto de observação: oferece um, e é (b.2)
   `{kind:'prefix', path:''}`, que captura tudo o que nenhuma rota `exact` nem nenhum prefixo mais longo
   reclamou (§5(b)). O que fica genuinamente impossível é o **resto**: rotas `exact`, prefixos mais longos
   (`/api`, `/plugins`) e todos os upgrades não têm ponto de observação público — `register` lança em
   caminho duplicado e `registerFallback` é dono único *"because two fallbacks cannot compose"*
   (`lib/index.js:75-81`). E mesmo (b.2) toca um campo `private` no uso realista, porque delegar à SPA
   obriga a ler `ws.fallback`. Qualquer barreira **completa** é, por construção, acoplamento a
   implementação; a recomendação minimiza-o a um campo, não o elimina.
2. **Guardar de forma diferenciada por rota sem enumerar as tabelas.** No ponto de despacho existe o `req`
   (método, pathname, cabeçalhos) mas não a identidade do plugin dono. Uma política do tipo "`/api` exige
   sessão, `/plugins` exige só origem" tem de ser escrita sobre o pathname, com as mesmas regras de
   precedência de `match()` — ou reconstruída lendo as tabelas, com o acoplamento que isso traz.
3. **Impedir que outro plugin tome o despacho.** Nada no Cordis protege a posse de um listener. Um segundo
   plugin que chame `removeAllListeners('request')` passa a ser o dono. O que **é** possível — e está
   implementado — é **detectar** e **não piorar**: recusar o empilhamento na instalação pela marca de posse,
   e falhar alto na reversão quando a posse se perdeu, em vez de restaurar por cima e duplicar o despacho
   (§9.5). Impedir, não; degradar em silêncio, também não.
4. **Barreira antes do `[Service.init]` do `WebServer`.** Existe uma janela entre `server.listen()` resolver
   e o nosso fiber activar. Nessa janela o servidor aceita ligações **sem barreira**. A janela é de uma
   volta de event loop e não é fechável a partir de um plugin — só o próprio `WebServer` poderia fechá-la.

## 11. Impacto em `02-SEGURANCA.md`

A cobertura recomendada é **total** sobre os três caminhos, portanto o modelo de ameaça **não precisa de ser
enfraquecido**. O que muda são cinco entradas que passam a ser afirmações verificáveis:

1. **A barreira cobre `register` (exact e prefix), `registerFallback` e `registerUpgrade`.** Trocar qualquer
   redação que fale em "barreira sobre o fallback" — essa versão deixaria `/api` e `/plugins` abertos, e
   isso está medido (§5(c)).
2. **Sem exigência de ordem de carregamento.** Eliminar qualquer requisito de "carregar antes de X": não é
   necessário e, pior, não é garantível (§6).
3. **Falha-alto é requisito de segurança, não de robustez.** `BarreiraIndisponivel` tem de derrubar o fiber.
   Um plugin que carregue com a barreira em falta é indistinguível de um plugin sem barreira.
4. **Janela de arranque declarada.** Entre o `listen()` do `WebServer` e a activação do nosso fiber há uma
   volta de event loop sem barreira (§10.4). Declarar, não fingir. Mitigação de composição, não de código:
   com bind em `127.0.0.1` e o túnel iniciado **depois** do boot, a janela não é alcançável de fora.
5. **A cerca de confiança do DSH permanece por baixo.** `isTrustedApiRequest` continua a correr para o
   tráfego que a barreira deixa passar (§7.2). As duas camadas compõem-se; documentar como defesa em
   profundidade, e nunca substituir uma pela outra.
6. **Empilhar barreiras é proibido, e a reversão pode falhar alto.** §9.5 mede que duas barreiras revertidas
   fora de ordem LIFO produzem despacho duplicado e `ERR_HTTP_HEADERS_SENT` não capturável. A política —
   recusar na instalação, falhar alto na reversão — tem de constar do modelo de ameaça, porque o modo de
   falha não é "barreira ausente", é "duas respostas na mesma ligação".
7. **`loopbackDeputy` é uma troca explícita, não uma conveniência.** Se a Onda 3 adoptar a normalização de
   cabeçalhos de §7.1, o documento tem de registar que ela **desarma** a defesa anti-DNS-rebinding e
   anti-cross-site do núcleo para o tráfego já autenticado, substituindo-a pela sessão. É defensável apenas
   porque a barreira prova a identidade **antes**; escrever essa ordem como invariante, não como detalhe.

## 12. Factos NÃO CONFIRMADOS (§7.4)

| # | Facto | Estado |
| --- | --- | --- |
| 1 | ~~`dsh-webui-auth` como plugin de autenticação publicado~~ | **RESOLVIDO — a minha primeira medição era um falso negativo.** O pacote **existe**, é `dsh-webui-auth@0.3.0` (NÃO escopado; procurar sob `@deepseek-ai/` dá 404), MIT, 8 versões, última em 2026-08-18. Lido por inteiro e medido em §7.1. |
| 2 | Comportamento de `0.1.0-rc.9` ou posterior | **NÃO CONFIRMADO.** Não publicado à data desta medição. A faixa suportada é `0.1.0-rc.7 .. rc.8`, ambas medidas byte a byte como idênticas no `lib/index.js` do webserver. |
| 3 | Ordem de activação entre linhas irmãs como contrato | **NÃO CONFIRMADO como contrato.** Observada como ordem de registo; o fornecedor declara o contrário em `dsh-base/cordis.patch.yml:12-13`. A recomendação não depende disto. |
| 4 | Quem regista `prefix /plugins` na composição real | Atribuído a `@deepseek-ai/dsh-client-modules` pelo comentário de `dsh-web-app/cordis.patch.yml:148-152`. O pacote **não** foi descarregado neste spike. **NÃO CONFIRMADO por leitura de fonte** — irrelevante para a recomendação, que não conhece rotas. |
| 5 | Comportamento sob HTTP/2 ou TLS | **NÃO CONFIRMADO.** O `WebServer` usa `node:http` `createServer` (`lib/index.js:121`), sem TLS nem HTTP/2 em nenhum caminho medido. |
| 6 | Se o `dsh-webui-auth` e um plugin baseado em (d) podem coexistir no mesmo processo | **NÃO CONFIRMADO.** Não medido. Em teoria não colidem (ele embrulha handlers, nós tomamos o despacho) e a nossa marca de posse não o veria, porque ele não instala listeners no servidor. Mas a composição não foi exercida e o resultado não é dedutível com segurança. |
| 7 | Frequência adequada do rescan de posse recomendado em §9.2 | **NÃO CONFIRMADO.** Os 2 s → 10 s vêm da arte prévia, ajustados ao custo de varrer tabelas. Para (d) a verificação é uma comparação de identidade e o intervalo apropriado não foi medido. |
