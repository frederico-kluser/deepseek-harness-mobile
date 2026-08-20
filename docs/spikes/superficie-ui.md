# T0.4 — Superfície de UI do DSH, enumeração de rotas e cookie `__Host-` local

Spikes fechados: **S4** (ponto de contribuição de UI para plugins) e **S10**
(cookie `Secure` com prefixo `__Host-` emitido por origem local).

Fonte da medição: o `.d.ts` e o `lib/*.js` dos tarballs **publicados no npm** e
a execução real desses pacotes num `Context` Cordis. Nenhuma conclusão vem de
markdown, de README ou de ausência de documentação.

**A lista de plugins não é escrita à mão.** `scripts/spike/ui/enumerate-routes.mjs`
lê `@deepseek-ai/dsh-web-app/cordis.patch.yml` — o manifesto publicado —, filtra
as linhas por evidência (só entra quem chama mesmo `webServer.register*`/`tapIndex`
no `lib/` instalado) e monta-as num `Context` real, na ordem do manifesto. Quem
regista as rotas são os próprios pacotes. O fecho instalado tem **196 pacotes
`@deepseek-ai`** na tag `next`.

## 0. Correção de fato sobre o ambiente — não há harness vivo na 3080

O enunciado da sub-tarefa afirma que existe um DeepSeek Harness respondendo em
`127.0.0.1:3080`. **Isso não se verifica neste host.** A medição:

```
$ awk 'NR>1 && $4=="0A" {split($2,a,":"); print strtonum("0x" a[2])}' /proc/net/tcp /proc/net/tcp6 | sort -n | uniq
53 631 5173 7681 8765 9050 9331 9332 9333 9334 11434 18080 36211 37031 45371
$ node -e "net.connect({host:'127.0.0.1',port:3080})"
ERROR ECONNREFUSED connect ECONNREFUSED 127.0.0.1:3080
$ node scripts/spike/ui/probe-live-instance.mjs
{"base":"http://127.0.0.1:3080","alcancavel":false,"detalhe":"TypeError: fetch failed",
 "conclusao":"AUSENCIA DE EVIDENCIA: nao ha instancia viva nesta origem; nada foi enumerado a partir dela."}
```

`/proc/net/tcp` lista o *namespace* real (aparecem sockets do `brave`, do
`gitkraken` e do `code` do operador), portanto a 3080 não está em escuta.
**Substituto usado, de força igual ou maior:** montar a composição publicada e
ler as tabelas de rota por dentro (seção 2). `probe-live-instance.mjs` fica no
repositório com a guarda de mutação exigida (só `GET`/`HEAD` mais lista de
padrões recusados antes do socket) para quando houver instância viva.

## 1. O que `HttpServerService` realmente expõe

O serviço não se chama `HttpServerService`: o nome injetado em `ctx` é
**`webServer`**, classe `WebServer extends Service`, de
`@deepseek-ai/dsh-host-webserver@0.1.0-rc.8`. Superfície lida do protótipo em runtime:
```
$ node scripts/spike/ui/enumerate-routes.mjs .spike-tmp/rt
webServer a escuta em 127.0.0.1:33577

===== 1. SUPERFICIE PUBLICA DO SERVICO webServer =====
  port: getter
  host: getter
  register: function
  registerUpgrade: function
  registerFallback: function
  tapIndex: function
  match: function
  applyIndexTaps: function
campos de instancia: ctx, name, config, exact, prefixes, upgrades, upgradedSockets, indexTaps, fallback, server, listenedPort
```

Assinaturas, de `lib/types/index.d.ts` do tarball publicado:
| Membro | `.d.ts` | Contrato |
|---|---|---|
| `register(route)` | 72 | rota `exact` ou `prefix`; **`(kind, path)` duplicado lança**; disposer |
| `registerUpgrade(route)` | 79 | `Connection: Upgrade`, **só `exact`**; duplicado lança |
| `registerFallback(handler)` | 88 | assento único; segundo registro lança |
| `tapIndex((html) => html)` | 95 | **transforma o `index.html` servido**; disposer |
| `applyIndexTaps(html)` | 106 | roda os taps em ordem; chamado pelo dono do fallback |
| `port` / `host` | 63 / 65 | getters da escuta |

**A camada de tipos local do repositório está desatualizada.**
`types/dsh-host-webserver/index.d.ts` afirma no cabeçalho que o pacote "NAO e
publicado no npm publico" — está publicado (`dist-tags` `latest=0.0.1-rc.1`,
`next=0.1.0-rc.8`) — e **omite `tapIndex` e `applyIndexTaps`**, os dois membros
que decidem S4. Corrigir isso é de T0.1, dona de `types/**`.

## 2. Existe forma de enumerar rotas já registradas?

**Não há API pública de listagem; há enumeração em runtime, por leitura dos
campos de instância.** As duas metades da frase são medidas, não inferidas.

```
$ node scripts/spike/ui/enumerate-routes.mjs .spike-tmp/rt
linhas de plugin no manifesto: 57
linhas que chamam a API de rotas: 5 -> client-hmr, modules, connection, ui-theme, web-runtime -> frontend-static
montadas com sucesso: client-hmr, modules, connection, ui-theme, web-runtime -> frontend-static

===== 2. ENUMERACAO DE ROTAS DA COMPOSICAO REAL =====
atribuicao por codigo, sobre 193 pacotes @deepseek-ai instalados:
  exact    /plugins/events      <- @deepseek-ai/dsh-client-hmr
  prefix   /plugins             <- @deepseek-ai/dsh-client-modules
  prefix   /api                 <- @deepseek-ai/dsh-client-connection
  upgrade  /api/events.mux      <- @deepseek-ai/dsh-client-connection
  upgrade  /api/events.host     <- @deepseek-ai/dsh-client-connection
  fallback  (assento unico)      <- @deepseek-ai/dsh-host-frontend-static

ordem de ACTIVACAO observada na montagem (nao e a mesma coisa que autoria):
  client-hmr -> (nada nesta linha)   modules -> exact /plugins/events, prefix /plugins, 1 tapIndex
  connection -> prefix /api, upgrade /api/events.mux, upgrade /api/events.host
  ui-theme   -> 1 tapIndex           web-runtime -> frontend-static -> fallback (assento unico)

tabela final, via campos de instancia (o `private` do TypeScript nao existe em runtime):
{"exact":["/plugins/events"],"prefix":["/plugins","/api"],"upgrade":["/api/events.mux","/api/events.host"],"fallbackClaimed":true,"indexTaps":2}
metodo publico de listagem no prototipo? NAO
```

A divergência entre as duas listas é ela própria um achado: **ordem de activação
não é autoria**. `/plugins/events` é registada por `dsh-client-hmr`
(`lib/index.js:133-135`, `EVENTS_ENDPOINT` em `:11`), mas o seu `ctx.effect` só
corre quando `client-modules` fornece `clientModules` — daí aparecer na montagem
da linha `modules`. A atribuição publicada é a **por código**.

O `.d.ts` marca `exact`, `prefixes`, `upgrades`, `indexTaps` e `fallback` como
`private` (linhas 53-58), mas `private` do TypeScript é apagado na emissão: em
`lib/index.js` são campos de classe comuns (`exact = new Map()`, linha 27) e
`Object.getOwnPropertyNames(web)` os devolve. Consequência, com duas ressalvas:

- A mitigação disponível é **mais forte** do que "só o aviso de ordem de
  carregamento": um plugin consegue ler a tabela de rotas viva. Isto refuta
  diretamente o que o plugin de hoje afirma por escrito em `src/index.ts:1620`
  e `:1632` e em `README.md:55` ("nada que permita enumerar rotas já
  registadas").
- É **acoplamento a campo privado**, que quebra sem aviso numa troca de versão.
  NÃO CONFIRMADO que estes nomes sobrevivam a `0.2.x`: não há contrato público
  que os garanta. O probe *fail-closed* de 4 sondas da Onda 3 continua
  necessário, porque mede comportamento observável em vez de ler estrutura
  interna.

### O modo de falha que a enumeração cobre, medido

Que uma barreira no fallback não cobre `/api` **já está no plano** em quatro
lugares (`02-SEGURANCA.md:1343`, `09-DECISOES-CANONICAS.md:586`,
`03-ONDAS.md:813`, `04-TESTES.md:1057`), incluindo com o incidente de ~40 s.
Isto aqui não é descoberta nova — é a mesma afirmação com número de linha e
código de status em vez de analogia.

O roteador consulta as tabelas nomeadas **antes** do fallback
(`lib/index.js:108-119`), e a composição real mostra quais são essas tabelas:
`/api`, `/plugins`, `/plugins/events` e os dois upgrades. Sobre a composição
viva, com o assento de fallback ocupado pelo `frontend-static`:

```
===== 5. QUEM E O DONO DO ASSENTO DE FALLBACK? =====
assento reivindicado pela composicao: SIM (frontend-static, montado pela linha web-runtime)
segundo registerFallback => lancou: webserver: fallback already registered
  /                          -> HTTP 200
  /qualquer-rota-spa         -> HTTP 200
  /api/state                 -> HTTP 404
  /plugins/x/client.js       -> HTTP 404
  /plugins/events            -> HTTP sem fecho (SSE, resposta mantida aberta)
```

`/` e `/qualquer-rota-spa` são servidas pelo fallback; as outras três são
servidas pelos seus donos nomeados e **não passam pelo assento de fallback**.

### Insumo direto para L2.5 (validação de `Host`)

O roteador do `webServer` **ignora o header `Host` por completo**: resolve o
caminho com `new URL(req.url ?? '/', 'http://x')` (`lib/index.js:107`), uma base
sintética. Medido:

Porém a validação **existe uma camada acima**, em
`@deepseek-ai/dsh-client-connection@0.1.0-rc.8`, cobrindo `/api` e o handshake
de WebSocket. `isTrustedApiRequest` (`lib/index.js:184`) exige `Host` de
loopback ou de `trustedHosts`, recusa `sec-fetch-site: cross-site` e exige
`Origin` do mesmo host quando presente. É aplicada na rota `/api` em `:554` e no
`registerUpgrade` em `:570`, com `rejectWebSocketUpgrade` no caminho negativo. O
comentário do próprio pacote diz: *"this fence is not an auth layer"*.

Medido sobre a composição real, com `trustedHosts: []` (o valor que um bind de
loopback produz):

```
===== 6. O ROTEADOR VALIDA O HEADER Host? =====
  Host: 127.0.0.1                          -> HTTP 404
  Host: attacker.example.com               -> HTTP 403
  Host: qualquer-coisa.trycloudflare.com   -> HTTP 403
```

O `404` é o `/api` a dizer que não conhece o método; os dois `403` são a cerca a
recusar o `Host`. A cerca funciona — e é por isso que é um problema para o túnel.

**Requisito duro para a Onda 3, medido e não inferido.** `resolveLanTrust`
(`dsh-web-app/lib/index.js:89-95`) deriva `trustedHosts` **apenas** de literais
IPv4 de LAN, e só quando o bind é `0.0.0.0`, mais os `--trusted-host`
explícitos:

```js
const lanAddresses = bindHost === ALL_INTERFACES_HOST ? Object.values(networkInterfaces())
  .flat().filter((i) => i !== void 0 && i.family === "IPv4" && !i.internal).map((i) => i.address) : []
return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
```

e a linha `connection` do manifesto liga `trustedHosts: !!js
ctx.webRuntime.trustedHosts` (`cordis.patch.yml:165-171`). Um hostname
`*.trycloudflare.com` **nunca** é derivado automaticamente — não é literal IPv4.
**Sem `--trusted-host <hostname-do-túnel>`, `/api` responde 403 e os dois
WebSockets são recusados; a Web UI carrega e o produto inteiro — acesso pelo
celular — não funciona.**

### CWE-1385 / `Origin` no handshake

O `webServer` despacha `upgrade` por igualdade exata de caminho
(`lib/index.js:145`) e **não valida `Origin` nem `Host`**. Quem valida é o dono
da rota. Um plugin que registre um `registerUpgrade` próprio herda zero
validação e precisa fazê-la à mão.

## 3. O prefixo `/__guard` está livre?

**Está livre.** Verificado por três meios, nenhum deles "não vi documentação":
(1) **enumeração da tabela de rotas** da composição real montada a partir dos
call-sites lidos nos `lib/index.js` publicados; (2) **tentativa de registro**,
que é o detector de colisão do próprio host — `register` lança em `(kind, path)`
duplicado (`lib/index.js:55`); (3) **requisição HTTP** à instância de teste.

```
===== 3. O PREFIXO /__guard ESTA LIVRE? =====
rotas ocupadas: ["/plugins/events","/plugins","/api","/api/events.mux","/api/events.host"]
colisoes com /__guard: nenhuma
register({kind:"prefix", path:"/__guard"}) => OK, sem excecao
segundo register /__guard => lancou: webserver: duplicate prefix route "/__guard"
  GET /__guard               -> HTTP 200  servido pelo handler /__guard
  GET /__guard/api/state     -> HTTP 200  servido pelo handler /__guard
  GET /__guardXYZ            -> HTTP 200  servido pelo fallback (SPA)
```

**Inventário da superfície HTTP de uma composição web real** — é esta a tabela
que T3.4 deve consumir para a sua tabela literal de isenções:

| Caminho | Tipo | Pacote que regista | Arquivo:linha |
|---|---|---|---|
| `/api` | `prefix` | `dsh-client-connection` | `lib/index.js:552` (registo em `:562`) |
| `/api/events.mux` | `upgrade` | `dsh-client-connection` | `lib/index.js:583` |
| `/api/events.host` | `upgrade` | `dsh-client-connection` | `lib/index.js:586` |
| `/plugins` | `prefix` | `dsh-client-modules` | `lib/index.js:287-290` |
| **`/plugins/events`** | `exact` | `dsh-client-hmr` | `lib/index.js:133-135` (`EVENTS_ENDPOINT` em `:11`) |
| (assento de fallback) | fallback | `dsh-host-frontend-static` | `lib/index.js:73` |

Duas correções face a uma leitura ingénua do código:

- **`/plugins/events` é SSE e está ocupado em toda instância web real.** O
  manifesto monta `client-hmr` como linha própria com o comentário literal
  *"The client-plugin reload chain, always mounted"* (`cordis.patch.yml:147-151`).
  Medido vivo: a requisição não fecha, porque a resposta fica aberta de
  propósito. Uma barreira que não a contabilize deixa um canal de eventos fora
  da conta.
- **`/__dsh_invariant_probe__` NÃO é rota ocupada — é um fantasma.**
  `dsh-host-webserver/lib/invariant.js:30-31` faz `server.register(probe)();`:
  regista e **invoca o disposer na mesma expressão**, como auto-teste da simetria
  registo/dispose (idem `/__dsh_invariant_upgrade_probe__` em `:36-37`). Não
  aparece na enumeração da composição viva; isentá-la seria isentar o que não existe.

Censo de call-sites sobre o **fecho transitivo completo (196 pacotes
`@deepseek-ai`)**, não sobre os poucos que eu tinha escolhido:

```
$ grep -rn --include='*.js' -E '\.(register|registerUpgrade|registerFallback|tapIndex)\(' \
    .spike-tmp/rt/node_modules/@deepseek-ai/ | grep -E 'webServer\.|server\.register'
@deepseek-ai/dsh-client-connection/lib/index.js:257:  return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
@deepseek-ai/dsh-client-connection/lib/index.js:562:  ctx.effect(() => ctx.webServer.register(route), "client-connection: /api route");
@deepseek-ai/dsh-client-connection/lib/index.js:567:      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
@deepseek-ai/dsh-client-hmr/lib/index.js:133:    const disposeRoute = ctx.webServer.register({
@deepseek-ai/dsh-client-modules/lib/index.js:287:    ctx.effect(() => ctx.webServer.register({
@deepseek-ai/dsh-client-modules/lib/index.js:292:    ctx.effect(() => ctx.webServer.tapIndex((html) => injectBootManifest(html, this.composed)), "client-modules: boot manifest injection");
@deepseek-ai/dsh-client-ui-theme/lib/index.js:76:    httpCtx.effect(() => httpCtx.webServer.tapIndex((html) => injectBootTheme(html, readPreference(ctx))), "client-ui-theme: initial theme bootstrap");
@deepseek-ai/dsh-host-frontend-static/lib/index.js:73:  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
@deepseek-ai/dsh-host-webserver/lib/invariant.js:30,31,36,37:  server.register(probe)();  (x4, auto-descartadas)

pacotes distintos: dsh-client-connection dsh-client-hmr dsh-client-modules dsh-client-ui-theme dsh-host-frontend-static dsh-host-webserver

$ grep -rn '__guard' .spike-tmp/rt/node_modules/@deepseek-ai/
(saida vazia = zero ocorrencias em 196 pacotes)
```

São **8 call-sites reais em 6 pacotes**; as 4 linhas de `invariant.js` são o
auto-teste que se descarta a si próprio.

Duas notas de precisão:

- O prefixo **não sangra**: `match` só casa `p` e `p/<algo>`
  (`lib/index.js:199`), logo `/__guardXYZ` cai no fallback, como a saída mostra.
- `dsh-client-connection` também registra **canais RPC genéricos** por prefixo,
  com caminho vindo de configuração (`lib/index.js:246-257`, validado contra
  `/^\/[A-Za-z0-9._~-]+$/`). Um canal chamado `__guard` é sintaticamente
  possível; NÃO CONFIRMADO que alguma composição publicada o declare — nenhuma
  das lidas declara. A defesa já existe: `register` lança na colisão em vez de
  sobrescrever em silêncio.

## 4. S4 — ponto de contribuição de UI para plugins

**Existe, e são dois mecanismos independentes, ambos com disposer.**

### 4.1 `tapIndex` — injeção no `index.html` (plano do host)

`tapIndex` está no `.d.ts` (linha 95) e o dono do assento de fallback o executa
em **toda** resposta de índice — `dsh-host-frontend-static/lib/index.js:72` é
`const renderIndex = async () => ctx.webServer.applyIndexTaps(await readFile(distIndex, 'utf8'))`,
usado em `/` e em cada fallback de rota do SPA. Medido sobre a composição real,
onde o meu tap **compõe com os dois taps que o próprio host já registou**:

```
===== 4. tapIndex — PONTO DE CONTRIBUICAO DE UI (injecao no index.html) =====
taps ja registados pela composicao: 2
GET / antes do meu tap: 1745 bytes
  contem __DSH_BOOT__ (tap do client-modules): SIM
  contem data-ds-dark-theme (tap do ui-theme):  SIM
GET / depois do meu tap: 1795 bytes
  ultimos 96 chars: "()</script><div id=\"root\"></div><button id=\"dsh-guard-tunnel\">Ligar tunel</button></body></html>"
injecao visivel na Web UI: SIM
GET / apos o disposer: reversivel = SIM
```

São **dois** os consumidores do ponto dentro do próprio host, ambos montados
incondicionalmente na composição publicada:
`dsh-client-modules/lib/index.js:292` (manifesto `__DSH_BOOT__`) e
`dsh-client-ui-theme/lib/index.js:76` (bootstrap de tema antes do primeiro
pintar). O plugin entra na mesma fila, com disposer, sem tocar em nenhum deles.


### 4.2 Registro de slot — o mecanismo de primeira classe (plano do cliente)

O DSH tem um sistema de plugins de UI completo e tipado:

- Um pacote declara `dsh.client` no `package.json` e exporta `./client` (parser
  em `dsh-client-modules/lib/index.js:119-145`; campos: `platform` obrigatório,
  `inject`, `external`, `immediately`).
- `ClientModuleRegistry` varre as entradas do Loader, compõe
  `window.__DSH_BOOT__` e serve o bundle em `/plugins/<pacote>/client.js?rev=<hash>`.
- No navegador, a metade cliente chama `ctx.slots.register(...)`. `ctx.slots` é
  `SlotRegistry` (`dsh-client-runtime/lib/types/client/index.d.ts:109`);
  `register` tem duas sobrecargas em
  `dsh-client-ui-slots/lib/types/index.d.ts:562` e `:575`, e **devolve disposer**.

Prova por exemplo publicado — um plugin oficial pondo controles na Web UI,
`@deepseek-ai/dsh-client-ui-message-feedback@0.1.0-rc.8`, cuja descrição no
`package.json` é *"Per-message feedback controls contributed to the
assistant-message action strip"*:

```js
// dsh-client-ui-message-feedback/lib/client.js:695
ctx.slots.inject("conversation.chat.assistant-actions", () => {
  const dispose = ctx.slots.register({
    name: "conversation.chat.assistant-actions", id: "feedback", order: 10,
    locale: NS, inject: (sessionId) => { /* ... */ }
  }, MessageFeedbackActions)
  return () => { dispose(); /* ... */ }
})
```

e a declaração que o faz chegar ao navegador, no `package.json` do mesmo pacote:

```json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-runtime", "..."], "platform": "web" } },
"exports": { "./client": { "default": "./lib/client.js" } }
```

São **33** os pacotes `@deepseek-ai/dsh-client-ui-*` no fecho instalado, e usam
esse caminho (`dsh-client-ui-jobs`, `dsh-client-ui-plan`, `dsh-client-ui-theme`,
entre outros).

**A varredura não filtra por escopo.** `ClientModuleRegistry` percorre
`ctx.loader.entries()` (`dsh-client-modules/lib/index.js:282` e `:413`) sem
qualquer restrição a `@deepseek-ai`: qualquer pacote carregado pelo Loader que
declare `dsh.client` e exporte `./client` entra no grafo. Um plugin de terceiro
— este — consegue mesmo contribuir UI, e não por acidente de implementação.

### 4.3 O que isto NÃO dispensa

O painel `/__guard` continua sendo a única superfície que sobrevive a uma troca
de versão do host: o registro de slot depende de `SlotMap` (nomes declarados por
*declaration merging* de pacotes `dsh-client-ui-*` versionados) e de React;
`tapIndex` depende de o dono do assento de fallback continuar chamando
`applyIndexTaps`.

**Correção de rota importante para T3.x: o assento de fallback não está livre e
não pode ser reivindicado.** Numa composição web real ele já é do
`frontend-static`, montado pela linha `web-runtime`
(`dsh-web-app/lib/index.js:176`), e `registerFallback` faz `throw`
incondicional na segunda chamada (`dsh-host-webserver/lib/index.js:82-83`).
Medido: `segundo registerFallback => lancou: webserver: fallback already registered`.

Logo, uma barreira **não reivindica o assento**. E também **não envolve os
métodos do serviço**: o plugin de hoje tenta fazê-lo com
`ctx.intercept('webServer', { registerFallback(…) {…}, register(…) {…} })`
(`src/index.ts:1745`), e esse primitivo **não existe**. No pacote publicado,
`intercept` é fusão de *configuração* por serviço, não envolvimento de método:

```ts
// @deepseek-ai/cordis@4.0.1 src/context.ts:141-145
intercept(name: string, config: any) {
  const intercept = Object.create(this[symbols.intercept])
  intercept[name] = config
  return this.extend({ [symbols.intercept]: intercept })
}
```

A sobrecarga `intercept(name: string, config: any): this` (`lib/types/context.d.ts:99`)
faz a chamada **compilar em silêncio**, e para este serviço a config nem sequer
é lida: `grep -c resolveConfig` no `lib/index.js` publicado do `webServer` dá
**0**, contra **11** no do próprio `cordis`. O gate deste repositório fica verde
porque `types/cordis/index.d.ts:110,154` declara um `InterceptMethods<S>` de
envolvimento de métodos que **não existe em nenhum pacote publicado** — o
compilador valida `src/index.ts` contra uma ficção local.

**O requisito de ordem de carregamento que uma leitura anterior deste relatório
derivava daqui não vem daí, porque o mecanismo não funciona de todo.** O veredito
sobre interceptação é de **T0.5 (S12)** e vive em `docs/spikes/interceptacao.md`;
em resumo, o que lá foi medido: o mecanismo que funciona é trocar o dono do
despacho no `node:http.Server` (capturar `listeners('request')`/`listeners('upgrade')`,
`removeAllListeners`, instalar um listener único que decide e delega, com
disposer síncrono que reinstala) — e esse, medido, **não tem exigência de ordem
de carregamento nenhuma**. Há ainda um caminho público **parcial**,
`register({ kind: 'prefix', path: '' })` com `path` **vazio** (não `'/'`), que
cobre a superfície SPA/estática mas **não vê** `/api`, `/plugins` nem os
upgrades, e que rouba o tráfego do assento de fallback — a SPA morre a menos que
o handler delegue lendo `ctx.webServer.fallback`, que é campo `private`.

Seja qual for o mecanismo escolhido, quem servir índice continua obrigado a
chamar `applyIndexTaps`, sob pena de matar em silêncio os dois taps do host.

```
VEREDITO S4: CONFIRMADO — há ponto de contribuição de UI para plugins, em dois mecanismos independentes.
  evidência: (a) `tapIndex(transform: (html: string) => string): () => void` em
  @deepseek-ai/dsh-host-webserver@0.1.0-rc.8 lib/types/index.d.ts:95, executado pelo dono do
  fallback em @deepseek-ai/dsh-host-frontend-static@0.1.0-rc.8 lib/index.js:72, e medido de
  ponta a ponta sobre HTTP (seção 4.1: botão injetado no `GET /`, reversível pelo disposer);
  (b) o registro de slot `ctx.slots.register(...)` de @deepseek-ai/dsh-client-ui-slots@0.1.0-rc.8
  lib/types/index.d.ts:562, com `ctx.slots: SlotRegistry` em
  @deepseek-ai/dsh-client-runtime@0.1.0-rc.8 lib/types/client/index.d.ts:109, alimentado pela
  declaração `dsh.client` do package.json que @deepseek-ai/dsh-client-modules@0.1.0-rc.8
  lib/index.js:119-145 parseia e serve em `/plugins/<pacote>/client.js`; exemplo publicado em
  @deepseek-ai/dsh-client-ui-message-feedback@0.1.0-rc.8 lib/client.js:696.
  A enumeração da instância viva em 3080 não foi possível: a porta não está em escuta
  (seção 0); o substituto foi montar a composição publicada de
  @deepseek-ai/dsh-web-app/cordis.patch.yml sobre o fecho transitivo de 196 pacotes e
  medir as tabelas de rota reais (seção 2).
```

**Consequência de replanejamento: T5.5 `w5-superficie-ui-nativa-dsh` nasce.**

## 5. S10 — cookie `__Host-…; Secure` emitido por origem local

Medido, não lido de especificação. Origem HTTP própria em porta efêmera
(`scripts/spike/ui/cookie-origin.mjs`), quatro cookies numa resposta; a medida é
o **reenvio do header `Cookie` na requisição seguinte** — `document.cookie` é
cego por `HttpOnly`, por construção. Cabeçalhos emitidos, verbatim:

```
Set-Cookie: __Host-dsh_sid=S10-host-secure; Secure; HttpOnly; Path=/; SameSite=Strict
Set-Cookie: dsh_secure=S10-secure-only; Secure; HttpOnly; Path=/; SameSite=Strict
Set-Cookie: __Host-dsh_bad=S10-host-nosecure; HttpOnly; Path=/; SameSite=Strict
Set-Cookie: dsh_plain=S10-plain; HttpOnly; Path=/; SameSite=Strict
```

As células 3 e 4 são controles: `__Host-` sem `Secure` tem de ser recusado (se
voltasse, a regra do prefixo não estaria a ser aplicada e as outras células não
valeriam nada); o cookie sem atributo confirma que há cookies de todo.

Resultado bruto, `http://127.0.0.1:<porta efêmera>`, Firefox:

```
$ node scripts/spike/ui/browser-cookie-probe.mjs --motor firefox --host 127.0.0.1
motor=firefox binario=firefox versao=Mozilla Firefox 149.0.2
origem de teste: http://127.0.0.1:41953
      "rawCookieHeader": "__Host-dsh_sid=S10-host-secure; dsh_secure=S10-secure-only; dsh_plain=S10-plain",
    "host_secure_reenviado": true,
    "secure_only_reenviado": true,
    "host_nosecure_reenviado": false,
    "plain_reenviado": true
```

Matriz completa, dois motores × três origens:
| Origem | Motor / versão | `__Host-…; Secure` | `Secure` só | `__Host-` sem `Secure` | controle |
|---|---|---|---|---|---|
| `http://127.0.0.1:<p>` | Firefox 149.0.2 | **reenviado** | reenviado | recusado | reenviado |
| `http://localhost:<p>` | Firefox 149.0.2 | **reenviado** | reenviado | recusado | reenviado |
| `http://192.168.122.1:<p>` | Firefox 149.0.2 | **recusado** | recusado | recusado | reenviado |
| `http://127.0.0.1:<p>` | Brave 149.1.91.180 | **reenviado** | reenviado | recusado | reenviado |
| `http://localhost:<p>` | Brave 149.1.91.180 | **reenviado** | reenviado | recusado | reenviado |
| `http://192.168.122.1:<p>` | Brave 149.1.91.180 | **recusado** | recusado | recusado | reenviado |

A linha da LAN é o que dá força ao resultado: mesmo cookie, mesmo servidor,
origem HTTP **não-loopback** — e aí `Secure` é recusado. O aceite em loopback é,
portanto, tratamento de origem confiável, não indiferença ao atributo `Secure`.

```
VEREDITO S10: CONFIRMADO — o navegador aceita e REENVIA `__Host-<nome>; Secure` emitido por origem HTTP de loopback.
  evidência: `Set-Cookie: __Host-dsh_sid=S10-host-secure; Secure; HttpOnly; Path=/; SameSite=Strict`
  emitido por `http://127.0.0.1:41953/step1`; a requisição seguinte a `/step2` chegou com
  `Cookie: __Host-dsh_sid=S10-host-secure; dsh_secure=S10-secure-only; dsh_plain=S10-plain`.
  Mozilla Firefox 149.0.2 e Brave Browser 149.1.91.180, ambos headless, mesmo resultado, e
  também em `http://localhost:<porta>`. Célula de controlo `__Host-dsh_bad` (sem `Secure`)
  recusada nos dois motores, o que confirma que a regra do prefixo está a ser aplicada.
  Célula de fronteira `http://192.168.122.1:<porta>` (HTTP não-loopback): recusado nos dois
  motores. Reprodutível por `node scripts/spike/ui/browser-cookie-probe.mjs --motor <m> --host <h>`.
```

**Consequência: T2.2 e T3.4 mantêm o cookie `__Host-dsh_sid` como caminho
principal, também no painel local em `http://127.0.0.1:3080`.** O caminho de
`Authorization` bearer não é forçado por S10. A regra L4 de `02-SEGURANCA.md`
("sessão autenticada SHALL NOT cair para `http`") não precisa de exceção
inventada: em loopback a origem é tratada como confiável e o cookie sobrevive.

### 5.1 Limitação: cobertura de navegadores

- **Chromium *stock* não está instalado neste host** (`chromium`,
  `chromium-browser`, `google-chrome`, `google-chrome-stable`, `microsoft-edge`
  ausentes do `PATH`). O motor Chromium foi medido via **Brave Browser
  149.1.91.180**, que é Chromium 149. NÃO CONFIRMADO que Chrome/Chromium stock
  na mesma versão se comporte igual: o binário medido foi o do Brave, e é isso
  que a evidência suporta.
- Safari/WebKit não foi medido: não há WebKit neste host.
- Os dois motores foram medidos **headless**. NÃO CONFIRMADO que o modo com
  cabeça difira; a medida é do lado do servidor e nenhuma diferença foi
  observada.
- A observação de sub-recurso (`<img src="/step-subresource">`) só apareceu nas
  execuções Chromium; no Firefox a navegação por `meta refresh` venceu a corrida.
  A observação de **navegação** ocorreu nas seis execuções, e é a que importa.

## 6. Reprodução

```
node scripts/spike/ui/fetch-packages.mjs .spike-tmp/rt \
  @deepseek-ai/dsh-web-app @deepseek-ai/dsh @deepseek-ai/dsh-host-frontend-static
node scripts/spike/ui/enumerate-routes.mjs .spike-tmp/rt
node scripts/spike/ui/browser-cookie-probe.mjs --motor firefox  --host 127.0.0.1
node scripts/spike/ui/browser-cookie-probe.mjs --motor chromium --host 127.0.0.1
node scripts/spike/ui/probe-live-instance.mjs http://127.0.0.1:3080
```

`fetch-packages.mjs` monta o fecho transitivo (`dependencies` **e**
`peerDependencies`, honrando o major declarado — sem isso `js-yaml@5` e
`schemastery@3.18.1-rc.4` entram e a árvore não arranca). Escreve só no diretório
de destino passado por argumento e não toca `package.json` nem `pnpm-lock.yaml`. Nenhum script emite requisição de
mutação contra instância alheia; os navegadores sobem com perfil descartável em
`tmpdir` e só o processo criado por eles é encerrado. O diretório de runtime
(`.spike-tmp/`) é material de medição descartável e não é versionado.
