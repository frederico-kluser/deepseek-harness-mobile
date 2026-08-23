# 05 — Padrões de Qualidade de Código

> **Escopo deste arquivo.** Como escrever o código deste plugin. Não é o *o quê*
> (`01-ARQUITETURA.md`), não é o *quando* (`03-ONDAS.md`), não é o *como provar*
> (`04-TESTES.md`), não é o *como publicar* (`06-REPO-E-CI.md`). Aqui ficam as
> regras que qualquer sub-tarefa de qualquer onda tem que respeitar para o
> código ser aceito no merge.
>
> **Público.** Os agentes do `deep-orchestrator`. Cada regra abaixo é escrita para
> ser verificável por outro agente lendo o diff, sem contexto da conversa.
>
> **Fonte única da verdade:** [09-DECISOES-CANONICAS](09-DECISOES-CANONICAS.md).
> Onde este documento divergir de 09, **09 vence e este arquivo é que muda**. Em
> particular: a árvore de `src/`/`worker/` (§5.4) é a de 09 §D1, reproduzida
> literalmente; o bloco de `scripts` e o comando de gate são os de 09 §D4; os
> nomes de rota, estado, cookie e comando são os de 09 §D5.
>
> **Quatro símbolos refutados por recon HTTP direto** (09, tabela E1–E4) que
> **não podem aparecer como forma prescrita** em nenhum exemplo deste documento:
> `@deepseek-ai/dsh-host-subprocess` (real: `@deepseek-ai/dsh-subprocess`);
> `ctx.webServer` / tipo `WebServer` / `inject: ['webServer']` (real:
> `ctx.httpServer` / `HttpServerService` / `inject: ['httpServer']`; o tipo
> `WebRoute` existe e permanece); `spawn(cmd, args, opts)` (real:
> `spawn(spec: SubprocessSpawnSpec)`); `dsh-host-frontend` (real:
> `@deepseek-ai/dsh-host-frontend-static`). Eles aparecem aqui **apenas** na
> coluna "o que a prosa diz" da tabela de §2 — que é o lugar certo para eles.

---

## 0. As cinco regras que valem mais que todo o resto

Se um agente só ler cinco linhas deste arquivo, que sejam estas.

| # | Regra | Falha típica que ela evita |
| --- | --- | --- |
| **Q-1** | **A fonte de verdade da API é o `.d.ts` do tarball npm, nunca prosa.** Nenhum símbolo de `@deepseek-ai/*` entra no código sem ter sido lido em `lib/types/*.d.ts`. | `ctx.webServer` (não existe; é `ctx.httpServer`), `@deepseek-ai/dsh-host-subprocess` (404 no npm) |
| **Q-2** | **Tudo que aloca recurso devolve disposer, e o disposer é síncrono.** Sem exceção: timer, socket, processo, listener, arquivo aberto. | Timer que ressuscita o worker depois do `dispose()` |
| **Q-3** | **Fail loud at load.** Config inválida ou insegura faz `throw` no `apply()`. Nunca `?? valor_padrão` numa decisão de segurança. | Bind em `0.0.0.0` porque a chave veio `undefined` |
| **Q-4** | **Segredo nunca em argv, nunca em log, nunca em mensagem de Telegram, nunca em disco em claro.** | Credencial legível via `/proc/<pid>/environ` do processo do bot; senha permanente colada num chat "só desta vez" |
| **Q-5** | **Nada de `await` de rede dentro de listener de evento do Cordis.** Listener retorna imediatamente; trabalho longo vira `setTimeout`/`ctx.effect` com handle guardado. | `ctx.waterfall` congelando o ciclo de dedução do agente |

Tudo abaixo é o detalhamento dessas cinco.

---

## 1. Convenções herdadas do DSH/Cordis (conceituais, a confirmar em T0.1)

Estas vêm do `AGENTS.md` do upstream e da arquitetura do Cordis, descritas nos
markdowns em `/home/ondokai/Documents/deepseek-harness`.

> **Rebaixamento deliberado (09 §D24 item 7).** A versão anterior desta seção
> dizia que estas regras eram "condição de aceitação de plugin no ecossistema" e
> "não negociáveis". Isso **não está verificado**: a mesma pesquisa que sustenta
> este plano mostra que a camada de API desses markdowns está **contaminada**
> (E1–E4), e nenhum agente leu o `AGENTS.md` real do repositório upstream. Logo
> elas valem no **nível conceitual** — são boas regras de engenharia e coerentes
> com o Cordis verificado — e ficam **a confirmar na Onda 0 (T0.1)**, exatamente
> como este mesmo documento já trata `dsh-brand` (§1.4) e `tsx/esm` (§3.4) em §12.
> O que **é** não negociável são as regras Q-1…Q-5 de §0, que se sustentam em
> fatos verificados e no modelo de ameaça, não em prosa de terceiro.

### 1.1 ESM puro, sem CommonJS

`"type": "module"` no `package.json` (**já está**). Consequências obrigatórias:

- Nenhum `require()`, nenhum `module.exports`, nenhum `__dirname`/`__filename`
  cru — use `import.meta.url` + `node:url`/`node:path`.
- Todo import relativo carrega **extensão explícita**. Isso não é estilo, é
  resolução de módulo ESM.
- Dependência que só publica CJS é motivo para não adotar a dependência. Se for
  inevitável, o import fica isolado num único módulo de fronteira (`src/vendor/`)
  com comentário `PORQUÊ` explicando por que não havia alternativa ESM.

O upstream arranca com `node --import tsx/esm` (per o *Guia de Contribuição*), o
que reforça a intransigência: código que só carrega sob CJS simplesmente não sobe.

### 1.2 `explicit > implicit` — falhar alto no carregamento

Do `AGENTS.md`, via *Guia de Contribuição*, §33: nenhuma constante que afete
mecânica pode ser *hardcoded*; ela pertence à interface `Config` exportada. E:
config malformada ou credencial omitida **inviabiliza o nó no instante da
instanciação**, em vez de propagar `undefined` para uma falha difusa horas depois.

Traduzido em regras de diff:

```ts
// PROIBIDO — decisão de segurança com default silencioso
const host = config.bindHost ?? '0.0.0.0'
const maxAttempts = config.worker?.backoff?.maxAttempts ?? 5

// OBRIGATÓRIO — a ausência é um erro de configuração, e o erro diz o que fazer
assertNonEmptyString(config.bindHost, 'worker.bindHost')
assertSecureBind(config.bindHost, config.allowedHosts)
```

**Onde `??` é aceitável:** somente em valor puramente cosmético (rótulo de log,
texto de UI) e sempre com comentário dizendo por que a ausência é benigna.
Em qualquer campo que participe de autenticação, bind, allowlist, TTL de sessão,
rate limit ou ciclo de vida de processo, `??` é rejeição automática de PR.

> O plugin atual **já cumpre isto**: `assertValidConfig` e `assertSecureBind`
> lançam no `apply()`. O trabalho da Onda 1 é preservar essa propriedade ao
> fatiar o arquivo, não reintroduzir defaults ao mover código.

### 1.3 Validação nas fronteiras, confiança no interior

O `AGENTS.md` é explícito (via *Guia de Contribuição*, §85): o TypeScript é
confiado **dentro** do processo; a validação em runtime é dirigida às
**fronteiras** — JSON vindo do LLM, I/O, workers, limites processuais externos.
Revalidar dentro de contratos tipados intra-processuais é ciclo redundante.

Fronteiras deste plugin, e o que cada uma valida:

| Fronteira | Entrada não confiável | Validação obrigatória |
| --- | --- | --- |
| `apply(ctx, config)` | `cordis.patch.yml` editável a mão | `assertValidConfig` — forma, tipos, invariantes de segurança |
| Handler HTTP | `req.url`, `req.headers`, `req.socket.remoteAddress` | canonicalização de path, parse de `Authorization`, `Origin`/`Host` allowlist |
| Handshake WebSocket | mesmo, sem same-origin policy | mesma validação, e explicitamente separada — o upgrade não passa pelo handler HTTP |
| Update do Telegram | payload arbitrário da internet | `from.id` numérico na allowlist **e** `chat.id` na allowlist; `callback_data` tratado como dado hostil |
| stdout do `cloudflared` | texto de processo de terceiro | parse tolerante, com o endpoint `/quicktunnel` como fonte primária |
| IPC host ↔ worker | processo separado | esquema explícito, mensagem desconhecida é descartada com log `warn` |

**Regra derivada:** uma função que valida fronteira nunca retorna `boolean` para
uma decisão de segurança sem que o chamador seja obrigado a tratar o `false`.
Prefira `asserts` (lança) ou um resultado tipado; `boolean` solto é fácil de
ignorar no chamador.

### 1.4 Branded IDs em vez de `string`

O `AGENTS.md` (via *Guia de Contribuição*, §85) proíbe identificadores baseados
no tipo primitivo puro e manda usar **Branded IDs**, importados de um pacote
dedicado citado como `dsh-brand`.

> **NÃO CONFIRMADO:** o pacote `@deepseek-ai/dsh-brand` **não** aparece na
> amostra do registry npm verificada no dossiê (que lista `dsh-base`,
> `dsh-app-boot`, `dsh-sandbox`, `dsh-subagent`, etc.). O *conceito* é do
> `AGENTS.md`; o *pacote* não foi verificado. **Spike da Onda 0:** checar
> `https://registry.npmjs.org/@deepseek-ai/dsh-brand`. Se existir, importar dele;
> se não existir, declarar o brand localmente em `src/brand.ts` com o mesmo
> padrão, e **não** inventar o import.

Padrão local, caso o pacote não exista:

```ts
// src/brand.ts
declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type SessionId   = Brand<string, 'SessionId'>
export type TelegramUserId = Brand<number, 'TelegramUserId'>
export type TunnelUrl   = Brand<string, 'TunnelUrl'>
export type SecretHashHex = Brand<string, 'SecretHashHex'>
```

Onde isso paga o custo neste plugin, concretamente:

- `TelegramUserId` vs `TelegramChatId`: os dois são `number` de até 52 bits
  significativos. Trocar um pelo outro numa allowlist é **exatamente** o bug de
  segurança que o dossiê descreve (validar `chat.id` mas não `from.id` deixa
  qualquer membro de um grupo apertar o botão destrutivo). O compilador impede.
- `SecretHashHex` vs a senha em claro: assinaturas tipadas tornam impossível
  passar o segredo cru para a função que só deveria ver o digest.
- `TunnelUrl`: marca explicitamente um valor que **não é segredo** (ver §9,
  anti-padrão A-11), o que documenta a decisão no tipo.

Construtores de brand ficam num único lugar e são a **única** fronteira de
conversão — `asTelegramUserId(raw: unknown): TelegramUserId` valida e converte.
Nunca `as SessionId` espalhado pelo código.

### 1.5 Listeners waterfall chamam `next()`

O Cordis expõe `DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'`
(verificado no `.d.ts` real de `@deepseek-ai/cordis@4.0.1`, `events.d.ts:25`).

Num `waterfall`, cada subscritor recebe `next` e é responsável por continuar a
cascata. Regras:

```ts
// Gate de autenticação: negar é decisão TERMINAL — não chama next()
ctx.on('http/auth-check', async (req, next) => {
  if (!isAuthenticated(req)) return false   // corta a cascata, deliberadamente
  return next()                             // não é a minha decisão: passa adiante
})
```

- **Todo caminho de retorno é explícito.** Ou `return next()`, ou `return <valor terminal>`.
  Um `return` implícito (`undefined`) num waterfall é bug: quebra a cascata sem
  dizer que quebrou.
- **Cortar a cascata exige comentário** dizendo por que essa decisão é terminal.
- **Nunca `await` de rede antes de `next()`** (§9, A-4). O waterfall bloqueia
  todos os subscritores seguintes enquanto você espera.
- Eventos declarados por *declaration merging* trazem a anotação do modo:

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode waterfall */
    'http/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
  }
}
```

O `/** @mode waterfall */` é **obrigatório** em toda entrada de `Events` — a
assinatura sozinha não distingue `waterfall` de `serial`, e o modo muda o
contrato de quem implementa.

### 1.6 Efeitos sempre reversíveis via `ctx.effect`

Do *Guia Definitivo*, §28: qualquer recurso **fora** das APIs do Cordis —
`setInterval`, WebSocket, watcher de arquivo, processo filho — tem que ser
criado dentro de `ctx.effect()`, que exige o retorno de um disposer. O motor
executa os disposers em ordem **rigorosamente inversa** ao registro (LIFO).

Neste plugin, o que **obrigatoriamente** vive dentro de `ctx.effect`:

| Recurso | Módulo dono | Disposer faz |
| --- | --- | --- |
| Worker do Telegram (subprocesso) | `src/proc/supervisor.ts` | abort + tree-kill do grupo + `clearTimeout` |
| `cloudflared` (subprocesso) | `src/tunnel/supervisor.ts` | mesma coisa, e derruba a URL pública |
| Timer de rotação de segredo | `src/secret/` | `clearInterval` |
| GC de sessões expiradas | `src/session/` | `clearInterval` |
| Janelas de rate limit | `src/ratelimit/` | `clearInterval` + esvaziar mapa |
| Handle de arquivo do log de auditoria | `src/audit/` | `close()` **síncrono** |

E o que **não** precisa (o Cordis já reverte): `ctx.on`, `ctx.intercept`,
`ctx.httpServer.register` / `registerFallback` — desde que o disposer nativo
devolvido seja **propagado**, nunca descartado.

> O nome do serviço é `httpServer`. `ctx.webServer` **não existe** (E2) e não pode
> aparecer como forma prescrita em nenhum arquivo deste repositório — nem em
> exemplo, nem em `inject`, nem em tipo. O único ponto do repositório autorizado a
> tocar essa API é `src/dsh/adapter.ts` (§5.4).

---

## 2. Regra Q-1, detalhada: a prosa não é a API

Esta é a regra de qualidade mais cara deste projeto, porque já custou código
quebrado.

O dossiê de pesquisa verificou, contra os tarballs reais do npm, que os quatro
markdowns em `/home/ondokai/Documents/deepseek-harness` acertam a **arquitetura**
e erram a **API**:

| O que a prosa diz | O que o `.d.ts` real diz | Impacto |
| --- | --- | --- |
| `ctx.webServer`, tipo `WebServer` | `ctx.httpServer`, classe `HttpServerService` | `inject`, `intercept` e todos os tipos do gate |
| `@deepseek-ai/dsh-host-subprocess` | `@deepseek-ai/dsh-subprocess` (+ `-local`) | import 404, build quebra |
| `ctx.subprocess.spawn(cmd, args, opts)` | `spawn(spec: SubprocessSpawnSpec)` — objeto único com `argv`, `cwd`, `stdio`, `graceMs` obrigatórios | reescrita do supervisor inteiro |
| `dsh-host-frontend` | `dsh-host-frontend-static` | fallback de dist |

`WebRoute` está correto. `ctx.intercept`, `ctx.waterfall`, `ctx.parallel`,
`ctx.effect`, `inject`, `Service` e Fibers estão **todos confirmados** no `.d.ts`
real do `@deepseek-ai/cordis@4.0.1`.

**Procedimento obrigatório antes de escrever qualquer linha que toque a API:**

```bash
# 1. Baixar o tarball do pacote real (foi assim que o dossiê verificou tudo)
npm pack @deepseek-ai/dsh-host-webserver@0.1.0-rc.8
npm pack @deepseek-ai/dsh-subprocess
npm pack @deepseek-ai/cordis@4.0.1

# 2. Ler os typings — esta é a fonte de verdade
tar -xzOf deepseek-ai-dsh-host-webserver-*.tgz package/lib/types/index.d.ts

# 3. Só então atualizar os stubs locais em types/
```

**Consequência de qualidade:** os arquivos em `types/` deste repositório
(`types/cordis/`, `types/dsh-host-webserver/`, `types/dsh-host-subprocess/`)
deixam de ser "o que eu acho que a API é" e passam a ser **transcrição verificada**.
Cada um ganha, no topo, um cabeçalho:

```ts
/**
 * FONTE: @deepseek-ai/dsh-host-webserver@0.1.0-rc.8, package/lib/types/index.d.ts
 * VERIFICADO EM: <data> por <tarefa>
 * DIVERGÊNCIAS DELIBERADAS: nenhuma | <lista, com PORQUÊ>
 */
```

Stub sem esse cabeçalho não passa no review. E `types/dsh-host-subprocess/`
muda de nome para `types/dsh-subprocess/` — o diretório atual perpetua o nome errado.

**Pinagem de versão (09 §D18).** Todo o ecossistema está em `0.0.1-rc`/`0.1.0-rc`
e o README upstream avisa "developer preview, expect breaking changes". A regra
de pin exato vale onde ela protege, e **não** vale onde ela quebraria instalação:

| Campo | Regra | Por quê |
| --- | --- | --- |
| `devDependencies` | versão **exata**, sem `^` e sem `~` | build reprodutível; é a nossa máquina |
| `dependencies` (runtime) | versão **exata** — hoje `"grammy": "1.45.1"` | supply chain: uma dependência, pinada |
| tarballs baixados por `scripts/fetch-dsh-types.mjs` | versão **exata**, com `sha256` registrado | o stub é transcrição verificada de um artefato específico |
| `peerDependencies` | **faixa**: `"@deepseek-ai/cordis": ">=4.0.0 <5"`, com `peerDependenciesMeta.optional: true` | pin exato de peer transformaria **cada rc do upstream** numa falha de instalação para o usuário. O peer declara compatibilidade, não reprodutibilidade |

A versão exata continua registrada no cabeçalho de cada stub. Retrabalho é
esperado; retrabalho silencioso não é.

---

## 3. TypeScript: configuração e o porquê de cada flag

### 3.1 O que já está certo e se mantém

O `tsconfig.json` atual já é rigoroso. Mantém-se, com justificativa registrada:

| Flag | Valor | Por que, neste plugin especificamente |
| --- | --- | --- |
| `strict` | `true` | Base. Em TS 6.0/7.0 passa a ser o **default** (dossiê), então isso deixa de ser opção. |
| `noUncheckedIndexedAccess` | `true` | `config.allowedHosts[0]` vira `string \| undefined`. Numa allowlist de segurança, indexar fora do range e receber `undefined` tipado como `string` é como se produz um bypass. |
| `exactOptionalPropertyTypes` | `true` | Distingue "chave ausente" de "chave presente com `undefined`". Crítico porque o patch do DSH é *whole-entry replace*, não *deep merge*: chave omitida é chave **apagada**, e o tipo tem que refletir isso. |
| `useUnknownInCatchVariables` | `true` | Obriga a estreitar o erro antes de ler `.message`. Ver §6. |
| `noImplicitOverride` | `true` | Se algum dia herdarmos de `Service` do Cordis, impede sobrescrita acidental de método do framework. |
| `noFallthroughCasesInSwitch` | `true` | A máquina de estados de liga/desliga (`src/control/controller.ts`) é um `switch`; fallthrough acidental ali é mudança de estado não intencional. |
| `skipLibCheck` | `false` | Deliberadamente contrário ao default popular. Como os stubs em `types/` são **escritos por nós** a partir dos `.d.ts` reais, checá-los é o único jeito de pegar transcrição errada. |
| `module` / `moduleResolution` | `NodeNext` | ESM puro com semântica do Node. |
| `forceConsistentCasingInFileNames` | `true` | Linux vs macOS. |

### 3.2 O que acrescentar

| Flag | Valor | Por quê |
| --- | --- | --- |
| `noImplicitReturns` | `true` | Waterfall listener com caminho de retorno faltando (§1.5) vira erro de compilação em vez de bug silencioso. **Alto valor aqui.** |
| `noPropertyAccessFromIndexSignature` | `true` | Força `env['TELEGRAM_BOT_TOKEN']` em vez de `env.TELEGRAM_BOT_TOKEN` — deixa visível no diff toda leitura de ambiente. |
| `verbatimModuleSyntax` | `true` | Obrigatório se o plugin for carregado por *type stripping* nativo do Node (dossiê: sem enums, sem namespaces com runtime, sem parameter properties, sem `paths`). Também elimina a classe de bug "import de tipo virou import de runtime". |
| `isolatedModules` | `true` | Garante que cada arquivo é transformável isoladamente — pré-requisito de qualquer *type stripping* e de qualquer bundler. |
| `noUnusedLocals` / `noUnusedParameters` | `true` | Ao fatiar 1836 linhas em ~20 arquivos, import órfão é o resíduo mais comum. |

### 3.3 A tensão TS 6 vs TS 7 (do dossiê)

- TS 7.0 é GA (08/07/2026), port em Go, 8–12× mais rápido, mas **sem API
  programática até o 7.1**.
- `typescript-eslint` declara suporte a `>=4.8.4 <6.1.0` — ou seja, **TS 7 fora**.
- TS 6.0/7.0 mudaram defaults: `strict:true`, `module:esnext`, `target:es2025`,
  `types:[]` (precisa listar `"node"` explicitamente), `rootDir:"."` (quebra layout `src/`).

**Decisão desta seção:** o typecheck **normativo** passa a rodar em TypeScript
6.0 (via alias `"typescript": "npm:@typescript/typescript6"`, recomendação da
Microsoft), porque é a versão que o `typescript-eslint` suporta. O `tsc7 --noEmit`
roda como job **informativo** no CI — sinaliza incompatibilidade futura sem
bloquear merge. Isso está alinhado com `06-REPO-E-CI.md` §5.

> **Quando, exatamente (09 §D4).** Isto é **entrega de T1.2**, não estado atual do
> repositório. Enquanto o projeto estiver em `typescript@^5.9.3`, os scripts
> `typecheck` e `build` usam o binário **`tsc`**. No commit de T1.2 que instala o
> alias, `typecheck` e `build` passam a `tsc6` **no mesmo commit**. **Nenhum
> documento, script ou workflow pode declarar `tsc6` antes disso** — um script que
> chama um binário inexistente deixa o gate vermelho por motivo errado e treina a
> equipe a ignorar gate vermelho.

Os defaults novos exigem revisão explícita do `tsconfig.json` ao migrar:
`types: ["node"]` já está declarado (bom), mas `rootDir` precisa ser fixado em
`"src"` no `tsconfig.build.json` para não quebrar o layout.

### 3.4 A decisão que precisa de spike: extensão dos imports relativos

Ao fatiar `src/index.ts`, aparece um problema real de ESM que não existia com
arquivo único: **qual extensão escrever no import relativo?**

| Modo de consumo | `import './config.ts'` | `import './config.js'` |
| --- | --- | --- |
| Node com *type stripping* nativo (carrega `.ts` direto) | funciona | quebra (arquivo `.js` não existe) |
| `node --import tsx/esm` (o que o boot do DSH usa) | funciona | funciona |
| `dist/` emitido por `tsc` | quebra | funciona |

Escolher errado quebra o boot do plugin — e o sintoma é `ERR_MODULE_NOT_FOUND`
no carregamento, não um erro de compilação.

> **SPIKE OBRIGATÓRIO (Onda 0) — e ele precisa estar registrado em `03-ONDAS.md`
> §2 junto com S1–S6, senão não tem dono.** Este documento é o único lugar do
> plano onde este spike aparece, e ele **bloqueia T1.1** (§5.2): fatiar 1836
> linhas com a extensão errada é migrar 60 arquivos depois. Registrado aqui como
> pendência explícita, não como suposição de que alguém vai lembrar.
>
> Determinar como o DSH carrega este plugin —
> `src/` via `tsx/esm`, `src/` via type stripping nativo, ou `dist/`. Só então
> escolher a extensão. **NÃO CONFIRMADO pela pesquisa:** o dossiê registra que o
> boot usa `node --import tsx/esm` (vindo da prosa do *Guia de Contribuição*),
> mas isso **não** foi verificado contra o código real. Também **NÃO CONFIRMADO**
> pelo dossiê: a flag `rewriteRelativeImportExtensions` do TypeScript, que
> resolveria escrever `.ts` e emitir `.js`. Verificar contra `tsc --help` da
> versão exata antes de depender dela.

**Regra provisória até o spike — e ela mudou de premissa.** A regra anterior
("escrever `.ts` porque o plugin é distribuído do fonte, já que `files` inclui
`src`") **perdeu o apoio**: por decisão canônica (09 §D13), `files` é
`["dist","cordis.patch.yml","README.md","LICENSE","CHANGELOG.md"]` — **`src/` e
`types/` não vão no tarball**, e o motivo é técnico e verificado: o Node **recusa**
type stripping dentro de `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Ou seja, o pacote **instalado** é
consumido a partir de `dist/`, não do fonte.

Consequência para esta decisão: a linha "`dist/` emitido por `tsc`" da tabela
acima **é o modo de consumo real do usuário final**, e o modo "carrega `.ts`
direto" só vale para desenvolvimento local dentro deste repositório.

**Regra provisória, reescrita:** escrever `.ts` nos imports relativos e manter
`allowImportingTsExtensions: true` **somente se** o spike confirmar que existe uma
emissão que reescreve a extensão (`rewriteRelativeImportExtensions`, ainda
**NÃO CONFIRMADO**, §12 item 3). Se o spike não confirmar, a regra vira `.js` nos
imports relativos — que é a forma que funciona no artefato publicado, que é o que
o usuário roda. **Esta é uma decisão de bloqueio da Onda 1:** o fatiamento de
T1.1 não pode começar antes dela, porque migrar 60 arquivos de extensão depois é
um `sed` com risco de colisão em string literal.

---

## 4. Regras de design de plugin Cordis

### 4.1 Disposer: contrato duro

```ts
export interface Disposable {
  /** SÍNCRONO. Sem async, sem Promise, sem await interno. */
  dispose(): void
}
```

Cinco invariantes, todas verificáveis em review:

1. **Síncrono.** O disposer não retorna `Promise`. Motivo: o Cordis executa
   disposers assíncronos de forma **concorrente** (*Guia de Contribuição*, §14),
   e etapas de desmontagem dependentes precisam de linearidade. Um disposer
   síncrono é trivialmente linear. Se você *precisa* de trabalho assíncrono no
   teardown, isso é sinal de que o recurso está mal modelado.
2. **Idempotente.** Chamar duas vezes não lança e não mata duas vezes de forma
   observável. Guarda `if (disposed) return; disposed = true` no topo.
3. **Total.** Libera *todos* os recursos que a função alocou, incluindo os que
   ela alocou indiretamente (timers agendados por callbacks).
4. **Não lança.** Erro no teardown é logado, nunca propagado — um `throw` no
   disposer aborta a cadeia LIFO e vaza tudo que vinha depois. O `catch` **tem
   comentário** dizendo por que engolir é correto ali (é a única exceção à regra
   "nunca engula exceção", §6.3).
5. **Ordem interna também é LIFO.** Dentro de um disposer com várias etapas,
   desfaça na ordem inversa da alocação. O disposer atual do supervisor já faz
   certo: (a) `clearRestartTimer`, (b) `abort`, (c) tree-kill — cancela o futuro
   antes de matar o presente.

### 4.2 Nada de estado global de módulo

```ts
// PROIBIDO
let currentTunnelUrl: string | undefined
const sessions = new Map<string, Session>()

// OBRIGATÓRIO
export function createSessionStore(deps: SessionDeps): SessionStore & Disposable { … }
```

Motivo que não é dogma: o Cordis faz **HMR**. O módulo é recarregado; um `Map`
de topo de módulo sobrevive à Fiber antiga ou é recriado sem que o disposer o
tenha esvaziado — as duas coisas são bug. Estado vive dentro do closure de uma
factory chamada pelo `apply()`, e morre com o disposer.

**Corolário para os testes:** factory com dependências injetadas é o que torna o
supervisor testável sem processo real (o `SupervisorDeps` atual já faz isso, com
`scheduler`, `kill`, `now`, `random`, `platform`). Esse padrão se estende a
**todos** os módulos novos: tunnel, session, ratelimit, audit.

### 4.3 Config nunca hardcoded

Toda constante que afeta mecânica entra em `Config` e no `cordis.patch.yml`.
Constantes que **podem** ficar no código: as que são fato do protocolo, não
política. Exemplos concretos:

| Fica no código | Vai para `Config` |
| --- | --- |
| `64` (limite de bytes de `callback_data`, fato da Bot API) | `telegram.allowedUserIds` |
| `50` (clamp de `timeout` do `getUpdates` no servidor) | `telegram.pollTimeoutSec` |
| `4096` (limite de `sendMessage`) | `session.idleTimeoutMs` |
| `32` (bytes do digest SHA-256) | `ratelimit.maxFailuresPerIp` |
| Alfabeto base32 do RFC 4648 | `secret.lengthBytes` |

Constante de protocolo ganha comentário com a fonte:
`// Bot API: callback_data é 1–64 BYTES. https://core.telegram.org/bots/api#inlinekeyboardbutton`

### 4.4 `ctx.intercept` e propagação de disposer

O gate atual envolve o serviço via `ctx.intercept` e envolve `registerFallback`
**e** `register`. Isso se mantém — muda só o nome do serviço
(`'webServer'` → `'httpServer'`, per Q-1).

Regra: **todo** método interceptado devolve ao chamador o disposer nativo do
método original, sem modificação. Envolver e devolver `undefined` desregistra o
plugin do ciclo de vida do Cordis silenciosamente.

```ts
// O disposer nativo é o valor de retorno — não pode ser descartado
const wrapped: HttpServerService['register'] = (route: WebRoute) =>
  target.register(guard(route))
//  ^ retorna Disposer, propagado
```

O tipo é `HttpServerService`; `WebServer` **não existe** (E2). `WebRoute`, esse
sim, existe e é o tipo correto do parâmetro.

---

## 5. Quebra de arquivos

### 5.1 O estado atual, sem eufemismo

`src/index.ts` tem **1836 linhas**. `test/index.test.ts` tem **2105**.

Isso **foi correto** no entregável anterior: o requisito era um plugin
auto-contido, e o cabeçalho do arquivo documenta a decisão ("três
responsabilidades, um só módulo **por desenho**"). Não é dívida acidental; é uma
decisão que tinha uma razão.

**A razão expirou.** Três motivos, nesta ordem de peso:

1. **Paralelismo.** O `03-ONDAS.md` roda com `max-parallel=5` (a Onda 2 tem cinco
   sub-tarefas; as demais, quatro) — e o teto real **não** é a capacidade do
   orquestrador, é a **propriedade de arquivo**. Enquanto for um arquivo só,
   **toda onda tem paralelismo 1**: dois agentes editando o mesmo arquivo geram
   conflito irreconciliável. O custo de não fatiar é o plano inteiro.
2. **Superfície nova.** As três capacidades novas (túnel, senha/sessão, bot com
   liga/desliga) adicionam facilmente outras 1500–2500 linhas. 4000 linhas num
   arquivo não é um arquivo, é um repositório sem diretórios.
3. **Blast radius do review.** Hoje qualquer mudança toca o mesmo arquivo, então
   qualquer diff exige reler o contexto de segurança inteiro.

**Decisão: fatiar, na Onda 1, antes de qualquer feature nova.**

### 5.2 O risco de fatiar, e como mitigar

Fatiar não é grátis. Riscos reais, cada um com mitigação:

| Risco | Por que é real aqui | Mitigação |
| --- | --- | --- |
| Quebrar o carregamento do plugin | Extensão do import relativo (§3.4) | Spike da Onda 0 **antes** do fatiamento; teste de smoke que importa `src/index.ts` do jeito que o DSH importa |
| Perder o contexto de segurança | Os comentários longos (`PORQUE NÃO !==`, divergências deliberadas) são o ativo mais valioso do arquivo | O comentário **viaja com a função**. Mover código sem mover o comentário é rejeição de PR |
| Fatiar e refatorar ao mesmo tempo | Impossível revisar; um bug de segurança entra escondido num "movi de lugar" | **Regra dura:** o commit de fatiamento é `git mv` semântico — *zero* mudança de lógica. Diff de conteúdo tem que ser vazio módulo imports/exports. Qualquer correção vai em commit **separado**, depois |
| Ciclo de import | `http/gate.ts` querer `config.ts` que quer `http/auth.ts` | Grafo de dependência acíclico obrigatório, com direção fixa: `index → domínio → primitivas`. Primitiva **nunca** importa domínio |
| `package.json#files` desatualizado | `files` **não** lista `src` (09 §D13): o tarball leva só `dist`, `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md`. Fatiar em 60 arquivos aumenta a chance de algum ficar fora da emissão | `tsconfig.build.json` compila `src/` **e** `worker/`; `scripts/check-tarball.mjs` falha se faltar `dist/index.js`, `dist/index.d.ts`, `dist/worker/telegram-bot.js` ou `cordis.patch.yml`, **ou** se aparecer qualquer coisa sob `src/`, `types/`, `test/`, `docs/` ou `.env`. `exports` continua com **um** ponto de entrada (`.`): módulo interno não é API pública |

**Teste que prova que o fatiamento não quebrou nada:** a suíte atual de 2105
linhas roda **sem alteração** contra o código fatiado, mudando só os imports.
Se um teste precisou mudar de lógica, o fatiamento não foi neutro.

### 5.3 Critérios objetivos de divisão

Não são métricas por métricas — cada uma existe porque prevê um problema:

| Métrica | Limite mole (revisar) | Limite duro (bloqueia merge) | Por quê |
| --- | --- | --- | --- |
| Linhas por arquivo `src/` | 300 | 400 | Acima disso não cabe na cabeça de um revisor numa sessão |
| Linhas por função | 40 | 60 | `handleTermination` atual já está no limite e é a função mais difícil do código |
| Parâmetros por função | 3 | 4 (acima: objeto de opções) | Chamada com 5 posicionais é onde se troca `chatId` por `userId` |
| Profundidade de aninhamento | 3 | 4 | Guard clause resolve quase sempre |
| Complexidade ciclomática | 10 | 15 | |
| Exports públicos por arquivo | 5 | 8 | Mais que isso é o arquivo tendo duas responsabilidades |
| Linhas por arquivo de teste | 500 | 800 | Espelha o módulo testado |

**O critério que manda sobre todos:** *uma responsabilidade por arquivo*. O teste
prático — se o nome do arquivo precisa de "e" ou "utils"/"helpers"/"common" para
descrever o conteúdo, ele tem duas responsabilidades. Arquivos chamados
`utils.ts`, `helpers.ts`, `common.ts`, `misc.ts` são **proibidos por nome**.

Um arquivo pode passar do limite mole sem se dividir se — e só se — cortar
quebraria uma invariante que o compilador não consegue expressar. Isso exige
comentário no topo dizendo qual é a invariante.

### 5.4 Árvore alvo do `src/` — a CANÔNICA de 09 §D1

Esta é a árvore de [09-DECISOES-CANONICAS §D1](09-DECISOES-CANONICAS.md),
**reproduzida literalmente**. A versão anterior desta seção tinha uma árvore
própria — sem `contracts/`, sem `state/`, sem `dsh/`, e com a allowlist do
Telegram dentro de `src/` — que contradizia `03-ONDAS.md` e `06-REPO-E-CI.md`
arquivo por arquivo. Ela foi substituída, não melhorada.

Divisão de autoridade: **09 diz qual é a árvore**, **03 diz quem escreve cada
arquivo** (os marcadores `[T*]` abaixo são de 03 e estão aqui só para leitura),
e **este documento diz o que cada arquivo é e como ele tem que estar escrito**.

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

**Layout de `test/`** (canônico, 09 §D1/§D15; detalhe em `04-TESTES.md` §3.2):

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

**Cinco pontos desta árvore que são regra de qualidade, não organização:**

1. **`src/contracts/**` é território do COMMIT PREP.** Leitura livre, **escrita
   proibida** para toda sub-tarefa. É o que permite que quatro agentes escrevam
   contra a mesma interface sem se ver. Um PR que edite `contracts/` fora de um
   prep é rejeitado sem discussão.
2. **`src/dsh/adapter.ts` é o único ponto que toca API do DSH.** Todo
   `ctx.httpServer`, todo `ctx.subprocess`, todo tipo importado de
   `@deepseek-ai/*` passa por ele. É o que transforma um breaking change do
   upstream (que é *developer preview*, e vai acontecer) numa correção de **um**
   arquivo em vez de uma varredura por 60. Qualquer outro arquivo que importe
   `@deepseek-ai/*` diretamente é rejeição de PR.
3. **`src/state/store.ts` é o único writer do `state.json`.** Quatro assuntos
   escrevem lá — digest do segredo, sessões, modo restrito, estado desejado — e um
   único escritor é o que evita duas escritas concorrentes que se sobrescrevem.
   Ninguém mais chama `fs.writeFile` nesse caminho.
4. **A allowlist do Telegram vive em `worker/auth/allowlist.ts`, não em `src/`.**
   O bot é um **subprocesso** (09 §D2), e é isso que faz `buildWorkerEnv` ser uma
   fronteira real: in-process a allowlist de ambiente desaparece por construção,
   porque o bot herdaria o `process.env` do DSH. A versão anterior desta seção
   listava `src/telegram/allowlist.ts` — errado, e removido.
5. **O nonce de confirmação é emitido e validado no HOST**
   (`src/control/confirm.ts`), nunca no worker. O worker só transporta o valor
   opaco dentro do `callback_data`, e `callback_data` **não prova nada** (§A-13).

**Mapa de origem — de onde cada arquivo novo sai do `index.ts` atual:**

| Arquivo novo | Vem das linhas atuais |
| --- | --- |
| `http/auth-basic.ts` | `verifyBasicAuth` (~179–207) |
| `http/origin.ts` | `normalizeRemoteAddress`, `isTrustedRemote` (~208–260) |
| `http/path.ts` | `extractPathname`, `safeDecodeURIComponent`, `canonicalRequestPath`, `isGuardedPath`, `routeMayServeGuardedPath` (~261–413) |
| `permissions/deny.ts` | `canonicalizePermissionToken`, `requestsDeniedPermission` (~414–466) |
| `proc/backoff.ts` | `computeBackoffDelay` (~505–516) |
| `proc/env.ts` | `WORKER_ENV_ALLOWLIST`, `buildWorkerEnv` (~565–639) |
| `proc/supervisor.ts` | `createWorkerSupervisor` (~640–1044) — **maior peça, ~400 linhas, já no limite duro; `tree-kill.ts` sai daqui** |
| `config/bind.ts` | `isWildcardBindHost`, `assertSecureBind` (~1045–1109, ~1311–1327) |
| `config/assert.ts` | `assertNonEmptyString` … `assertValidConfig` (~1110–1310) |
| `http/responses.ts` | `denyUntrustedOrigin`, `challengeBasicAuth`, `denyUpgrade` (~1328–1371, ~1451–1490) |
| `http/gate.ts` | `createGuardedHandler`, `createGuardedUpgradeHandler` (~1372–1450, ~1491–1545) |
| `index.ts` | `name`, `inject`, `Events`, `apply` (~1546–1836) |

Resultado estimado: `index.ts` cai de 1836 para **~200 linhas** de fiação pura.

### 5.5 Regra de import

```
index.ts → domínio      (http/, proc/, tunnel/, telegram/, control/, panel/)
         → primitivas   (config/, state/, secret/, session/, ratelimit/, audit/,
                         permissions/, brand, errors, logging/)
         → contratos    (contracts/ — só tipos, congelados por COMMIT PREP)
         → adaptador    (dsh/adapter.ts — a única fronteira com @deepseek-ai/*)

worker/  → worker/lib, worker/auth, worker/commands, worker/ipc
         → contracts/ipc.ts (tipos apenas)
         ✗ NUNCA importa nada de src/ além de contracts/ — é outro processo
```

Direção única. Primitiva **nunca** importa domínio. Domínio **nunca** importa
outro domínio diretamente — se precisar, o `index.ts` faz a mediação, ou o
contrato compartilhado desce para uma primitiva. `contracts/` não importa nada.
`dsh/adapter.ts` é importado por domínio e por `index.ts`, e não importa domínio.

**O `worker/` é processo separado, e o grafo respeita isso:** um `import` de
`worker/` para dentro de `src/` que não seja um tipo de `src/contracts/` é
rejeição de PR — ele compila, roda em teste unitário, e falha em produção
carregando metade do plugin dentro do processo do bot.

Isso não é elegância: é o que impede que uma sub-tarefa da Onda 4 (Telegram)
precise editar um arquivo da Onda 3 (túnel) e estoure o mapa de propriedade.

---

## 6. Tratamento de erro

### 6.1 Erros tipados com código estável

```ts
// src/errors.ts
export type GuardErrorCode =
  | 'CONFIG_INVALID'      // cordis.patch.yml malformado
  | 'CONFIG_INSECURE'     // válido na forma, inaceitável na política (bind wildcard)
  | 'SECRET_WEAK'         // entropia abaixo do mínimo
  | 'TUNNEL_SPAWN'        // cloudflared não subiu
  | 'TUNNEL_TIMEOUT'      // subiu mas não publicou URL a tempo
  | 'WORKER_SPAWN'        // ENOENT/EACCES no worker
  | 'WORKER_EXHAUSTED'    // orçamento de restart esgotado (estado terminal)
  | 'IPC_PROTOCOL'        // mensagem host↔worker fora do esquema

export class GuardError extends Error {
  constructor(
    readonly code: GuardErrorCode,
    message: string,
    options?: { cause?: unknown; readonly remediation?: string },
  ) { super(message, options); this.name = 'GuardError' }
}
```

Por que código e não só mensagem: mensagem é para humano e pode mudar de texto;
código é para máquina (teste, log estruturado, painel) e **não pode**. O teste
afirma sobre `code`, nunca sobre a string da mensagem — senão melhorar a redação
quebra a suíte.

### 6.2 Mensagem acionável

Toda mensagem de erro responde três perguntas: **o quê**, **onde**, **o que fazer**.

```ts
// RUIM
throw new Error('invalid config')

// BOM
throw new GuardError(
  'CONFIG_INSECURE',
  `Bind inseguro: host "${host}" não está em allowedHosts [${allowed.join(', ')}]. ` +
  `Expor o control plane fora do loopback sem o gate ativo reproduz a discussão #853 ` +
  `(RCE não autenticado, verificado em 0.1.0-rc.6). ` +
  `Corrija a chave "allowedHosts" em cordis.patch.yml (entrada id: guarded-bot-orchestrator).`, (hoje: dsh-guard-messenger)
)
```

O código atual já faz isso bem — os assertores nomeiam o `path` da chave. Manter.

**Nunca interpolar segredo na mensagem.** Interpola-se o *nome* da chave, o
*comprimento*, o *formato esperado* — nunca o valor.

### 6.3 Nunca engolir exceção — com duas exceções nomeadas

`catch {}` vazio é rejeição automática. Existem exatamente **duas** situações em
que engolir é correto, e as duas exigem comentário explicando:

1. **`ESRCH` no tree-kill.** O processo já morreu; o objetivo do `kill` já está
   cumprido. O código atual documenta isso corretamente.
2. **Erro dentro de um disposer.** Propagar aborta a cadeia LIFO e vaza tudo que
   vinha depois (§4.1, invariante 4). Loga em `warn` e segue.

Em todo outro lugar: ou trata, ou re-lança com `cause`, ou converte em `GuardError`
com contexto. `catch (e) { ctx.logger.error(...) }` sem re-lançar só é aceitável
se o chamador **não puder** fazer nada — e isso vai no comentário.

Com `useUnknownInCatchVariables`, a forma correta é:

```ts
catch (error) {
  throw new GuardError('TUNNEL_SPAWN', 'cloudflared não arrancou.', { cause: error })
}
```

`cause` preserva a stack original. Nunca `new Error(String(error))` — destrói o rastro.

### 6.4 Níveis de log

| Nível | Quando | Exemplo neste plugin |
| --- | --- | --- |
| `error` | Estado terminal ou perda de função. Exige ação humana. | Orçamento de restart esgotado; falha de bind |
| `warn` | Degradação recuperável, ou evento de segurança que não é ataque confirmado | Tentativa de auth falhada; `start()` repetido; STDERR do worker |
| `info` | Transição de ciclo de vida que o operador quer ver | Túnel aberto (com a URL); worker arrancado; plugin descarregado |
| `debug` | Diagnóstico de desenvolvimento | STDOUT do worker; abort intencional |

Três armadilhas específicas:

- **Abort intencional não é `error`.** O `AbortError` que o Node emite em todo
  desligamento limpo, se logado como `error`, produz um erro falso a cada
  descarregamento — e treina o operador a ignorar erros de verdade. O código
  atual já trata isso; preservar ao fatiar.
- **Tentativa de auth falhada é `warn`, não `error`.** Um scanner gera milhares.
  `error` deve significar "algo está quebrado", não "alguém bateu na porta".
- **O log de auditoria não é o log de aplicação.** Decisões de autorização
  (concedido/negado, identidade, origem, timestamp) vão para `src/audit/log.ts`,
  append-only, fora do Telegram — porque quem controla o bot não deve conseguir
  apagar o próprio rastro.

### 6.5 Nunca logar segredo — e como garantir isso mecanicamente

Confiar na disciplina não basta. `src/logging/logger.ts` envolve `ctx.logger` e aplica
redação **antes** de qualquer emissão:

```ts
const REDACTIONS: readonly [RegExp, string][] = [
  [/bot\d+:[\w-]+/g, 'bot<REDACTED>'],                   // token do Telegram (dossiê)
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic <REDACTED>'],   // credencial Basic
  [/[?&](token|secret|password|key)=[^&\s]+/gi, '$1=<REDACTED>'],
]
```

Cuidado documentado no dossiê: o token do Telegram vai na **URL** das chamadas à
Bot API — então basta um log de HTTP, um APM ou um proxy para vazar. Por isso a
regra é redação no **wrapper**, não no ponto de chamada.

Complementos obrigatórios:

- Nenhum módulo importa `ctx.logger` diretamente; todos passam por `src/logging/logger.ts`,
  e a função de mascaramento vive em `src/logging/redact.ts`.
  Isso é verificável por regra de lint (`no-restricted-properties`).
- Teste da Onda 2 alimenta o wrapper com um token e uma credencial reais em
  formato válido e afirma que a saída não os contém.
- **A URL do túnel NÃO é segredo** (§9, A-11) — logar `info` com a URL é correto
  e desejável, porque o operador precisa dela. O que não se loga é a senha.

---

## 7. Nomeação e comentários

### 7.1 Nomeação

Prefixos com significado fixo — o nome diz o contrato:

| Prefixo | Contrato | Exemplo |
| --- | --- | --- |
| `assertX` | Lança se inválido; estreita o tipo (`asserts`) | `assertSecureBind` |
| `isX` / `hasX` | Retorna `boolean`, puro, sem efeito | `isTrustedRemote` |
| `createX` | Factory; retorna objeto **com `dispose()`** | `createWorkerSupervisor` |
| `buildX` | Puro; constrói valor, sem alocar recurso | `buildWorkerEnv` |
| `computeX` | Puro; cálculo determinístico (exceto jitter injetado) | `computeBackoffDelay` |
| `canonicalizeX` / `normalizeX` | Transforma para forma comparável | `canonicalRequestPath` |
| `denyX` / `challengeX` | Escreve resposta HTTP de recusa | `denyUpgrade` |

**`createX` sem `dispose()` é bug de nomeação:** se cria e não devolve disposer,
ou não deveria ser `create`, ou está vazando.

Outras regras:

- Arquivos em `kebab-case.ts`. Tipos e classes em `PascalCase`. Funções e
  variáveis em `camelCase`. Constantes de módulo em `SCREAMING_SNAKE_CASE`.
- Booleano é afirmativo: `isAuthenticated`, nunca `notAuthenticated` — dupla
  negação em condição de segurança é onde o bypass mora.
- Unidade no nome quando há unidade: `idleTimeoutMs`, `graceMs`, `lengthBytes`.
  O `Ms` do código atual já segue isso; manter em tudo que é novo.
- Nada de abreviação inventada (`cfg`, `svc`, `mgr`). `config`, `service`,
  `manager` custam três teclas.

### 7.2 Comentários: o PORQUÊ, nunca o QUÊ

```ts
// RUIM — reescreve o código em português
// Incrementa attempts
attempts += 1

// BOM — explica a decisão que o código não consegue expressar
// Uptime saudável zera o orçamento: uma falha isolada depois de horas de
// serviço não deve consumir o orçamento reservado a crash-loops.
if (uptimeMs >= backoff.resetAfterMs) attempts = 0
```

O `src/index.ts` atual é, nesse ponto, **exemplar** — os comentários são o ativo
mais valioso do arquivo, porque registram medições reais e armadilhas do POSIX
que nenhum tipo captura. **Fatiar não pode diluí-los.** O comentário viaja com a
função; mover código e deixar o comentário para trás é rejeição de PR.

### 7.3 Quando o comentário é obrigatório

Cinco situações. Em todas, ausência de comentário bloqueia o merge:

1. **Divergência deliberada de uma fonte canônica.** Formato fixo:

```
/**
 * DIVERGÊNCIA DELIBERADA de <fonte, com URL ou caminho>.
 * A fonte diz: <o que ela diz>
 * Nós fazemos: <o que fazemos>
 * PORQUÊ: <razão, com evidência medida se houver>
 * NÃO "corrigir" de volta.
 */
```

Já há dois casos assim no código (a guarda `!child.killed` e o auto-desregisto
inexistente) e ambos estão bem escritos. Os novos que virão: `ctx.httpServer` vs
a prosa que diz `ctx.webServer`; a assinatura de objeto único do `spawn`; e a
refutação sobre SSE em quick tunnel.

2. **Engolir exceção** (§6.3) — qual erro, por que é benigno.
3. **Constante de protocolo** — a URL da spec que a fixa.
4. **Fato medido empiricamente** — o que foi medido, como, com números. O
   dossiê tem vários (`/quicktunnel` retorna hostname sem esquema; URL sai em
   stderr e stdout fica com 0 bytes; 6–7s até a URL aparecer); todos entram como
   comentário no ponto de uso.
5. **Ordem que importa e não é óbvia.** Ex.: em `dispose()`, cancelar o timer
   **antes** de matar; em `spawnOnce`, liberar o filho anterior **antes** de
   criar o novo.

### 7.4 Anotação de fato não confirmado

Quando o código depende de algo que a pesquisa não confirmou, isso vive no
código, não só no plano:

```ts
// NÃO CONFIRMADO: o dossiê registra que ctx.subprocess.spawn no Windows executa
// `taskkill /T /F` internamente. Isso veio da prosa, não do .d.ts. Se o spike da
// Onda 0 refutar, este ramo precisa de tree-kill próprio no win32.
if (deps.platform === 'win32') return
```

Isso é o que impede que uma suposição vire fato por decurso de prazo.

---

## 8. Lint e formatação

Decisão alinhada com `06-REPO-E-CI.md` §5, com a justificativa vinda do dossiê:

| Camada | Ferramenta | Justificativa |
| --- | --- | --- |
| Gate rápido | **oxlint 1.79** | 865+ regras, 50–100× mais rápido que ESLint (número oficial), já faz lint type-aware via `tsgo`; usado em produção por Kibana, Sentry, Renovate, Preact. Roda em pre-commit sem incomodar |
| Regras type-aware | **ESLint 10.8.1 + typescript-eslint**, flat config | ESLint 10 (fev/2026) removeu `.eslintrc` de vez e exige Node ≥20.19. Só as regras que precisam do type checker |
| Formatação | `oxlint --fix` | Não adicionar Prettier separado. Menos uma dependência de supply chain |

**Por que não Biome:** Biome 2.5.9 (~500 regras) é alternativa legítima, mas o
oxlint tem mais regras e já faz type-aware. Ficar com um único gate rápido evita
duas configurações concorrentes. *Não é decisão irreversível* — trocar oxlint por
Biome é mudar um arquivo de config.

**Por que não só ESLint:** velocidade. Um gate que demora não roda em pre-commit,
e um gate que não roda em pre-commit não existe.

**Como as duas ferramentas são invocadas (09 §D4).** Por **um** script:

```jsonc
"lint": "oxlint . && eslint ."
```

O gate de onda e o job `lint` do CI chamam `pnpm lint`, nunca `pnpm exec oxlint .`
e `pnpm exec eslint .` soltos. Isso não é preferência: enquanto o gate de
`03-ONDAS.md` exigir um script `lint` que o `package.json` não define, **toda onda
falha no gate por comando inexistente** — que foi exatamente a inconsistência que
09 §D4 fechou. `lint` roda **primeiro** no comando de gate porque é o mais barato:
`pnpm lint && pnpm typecheck && pnpm build && pnpm test`.

**Restrição:** `typescript-eslint` declara suporte a TypeScript `>=4.8.4 <6.1.0`
— TS 7 está fora. É a razão de o typecheck normativo ficar em TS 6.0 (§3.3).

### Regras não-default que este projeto exige

```jsonc
// eslint.config.js — as que valem o custo do type checker
"@typescript-eslint/no-floating-promises":       "error",  // promessa órfã em listener = trabalho que some
"@typescript-eslint/no-misused-promises":        "error",  // async onde se espera void (listener de evento!)
"@typescript-eslint/await-thenable":             "error",
"@typescript-eslint/switch-exhaustiveness-check":"error",  // máquina de estado do liga/desliga
"@typescript-eslint/no-unnecessary-condition":   "warn",   // pega guarda morta como o !child.killed
"no-restricted-syntax": ["error", {
  "selector": "CatchClause[body.body.length=0]",
  "message": "catch vazio proibido. Ver 05-QUALIDADE-CODIGO.md §6.3."
}]
```

`no-unnecessary-condition` merece destaque: é a regra que teria pego
`!child.killed` — a guarda que tornava o tree-kill código morto (§9, A-2).
Ela sozinha justifica o custo de manter o ESLint type-aware ao lado do oxlint.

---

## 9. Anti-padrões deste domínio

Cada um destes já causou dano ou está documentado no dossiê como causa provável.
Não são hipóteses de manual.

### A-1 · `tree-kill` sem `detached: true` → `ESRCH` engolido

`process.kill(-pid, SIG)` só funciona se `pid` for um **PGID**, e o filho só é
líder do próprio grupo com `detached: true` (que invoca `setsid`). Sem a flag, a
chamada falha com `ESRCH`, o `catch` engole, e **o tree-kill simplesmente não
acontece** — os netos sobrevivem como órfãos.

Medido no código atual, com `detached` presente:
`filho 1326740 (pgid 1326740), neto 1326741` → depois do dispose, o grupo morre.
Sem `detached`, o neto ficaria reparentado (`ppid=1830`, `systemd --user`).

**Regra:** `detached: true` e `process.kill(-pid)` são **um par indivisível**.
Quem mexer num tem que justificar o outro no mesmo diff. Teste obrigatório: spawn
de pai que cria neto, `dispose()`, afirmar que o **neto** morreu.

> **Cuidado na migração:** a nova assinatura `spawn(spec: SubprocessSpawnSpec)`
> tem campos obrigatórios `argv`, `cwd`, `stdio`, `graceMs`. **NÃO CONFIRMADO** se
> ela aceita `detached`. Se não aceitar, esta invariante inteira precisa ser
> repensada — é o item de maior risco do spike da Onda 0.

### A-2 · Guarda `!child.killed` que torna o tree-kill código morto

```ts
// O exemplo canônico da documentação:
if (child.pid && !child.killed) process.kill(-child.pid, 'SIGKILL')
```

O Node chama `child.kill()` **sincronamente** ao processar `abort()`, então
`child.killed === true` **antes** desta linha. A condição nunca é verdadeira no
único caminho que importa. `killed` significa "um sinal foi entregue ao filho",
não "o filho e a descendência não existem".

**Regra:** tree-kill é sempre tentado quando há `pid`. `ESRCH` é o caminho
esperado quando já morreu, e é engolido com comentário.

### A-3 · Espalhar `process.env` para subprocesso de terceiro

`{ ...process.env }` entrega `ADMIN_USER`/`ADMIN_PASS` do control plane a um
binário que consome input arbitrário da internet. Bot comprometido lê
`/proc/self/environ` e autentica no control plane — exatamente o pivô
remoto→local que o plugin existe para impedir.

**Regra:** o ambiente do filho é **construído** por allowlist (`buildWorkerEnv`),
nunca herdado. Vale para o `cloudflared` também, não só para o bot. Acrescentar
variável exige justificativa no comentário; o critério é "sem isto o processo não
arranca ou não fala TLS", não "é cômodo ter".

### A-4 · `await` de rede dentro de listener de evento

`ctx.parallel` aguarda o retorno exaustivo de todos os subscritores;
`ctx.waterfall` bloqueia a cascata inteira. Reter o retorno esperando a rede
congela o subsistema e, por arrasto, o ciclo de dedução do agente.

Precedente real no DSH: a telemetria começou em SSE sobre `events.mux`/`events.host`;
como o HTTP/1.1 do browser tolera ~6 sessões por origem, os canais eternos
esgotavam o pool e as RPCs utilitárias ficavam retidas na fila. A correção
arquitetônica foi migrar o downlink para WebSocket dedicado.

**Regra:** listener retorna imediatamente. Trabalho longo vira `setTimeout`
fire-and-forget com o handle **guardado** e cancelado no disposer. Isso ganha
peso nas ondas novas: o handler HTTP não pode esperar o `cloudflared` subir
(6–7s medidos), e o comando do Telegram não pode esperar o servidor arrancar.

### A-5 · Sobrepor a referência do filho sem liberar a anterior

`child = spawned` sem liberar o valor antigo tira o filho anterior da
contabilidade do disposer. Sondado no código atual: com dois `start()`,
`filhos=2` mas `kills=[[-222,...]]` — o primeiro nunca era morto.

**Regra:** `releaseCurrentChild()` antes de qualquer atribuição nova. Vale
igualmente para o supervisor do túnel.

### A-6 · Remover listeners de `'error'` sem deixar absorvedor

Um `EventEmitter` que emite `'error'` sem nenhum listener **lança** no processo
hospedeiro. Como o `abort()` do disposer faz o Node emitir exatamente um
`'error'` (AbortError), retirar os listeners sem deixar ninguém no lugar
transforma um desligamento limpo numa exceção não capturada que derruba o DSH.

**Regra:** todo `removeListener('error', …)` é seguido de `on('error', () => {})`.

### A-7 · Escutar só `'exit'`

Com `command` ou `cwd` inexistente, o Node emite `error(ENOENT) → close(code=-2)`
e **nunca** `'exit'`. Resultado medido: uma linha de log e o worker permanentemente
morto, sem restart, sem consumir orçamento, sem sinal ao operador.

**Regra:** `'close'` é o único evento terminal universal. `'error'` classifica a
causa; `'exit'` é informação opcional. Uma flag `settled` garante que o orçamento
é consumido uma vez por instância. Isso vale em dobro para o `cloudflared`, que é
um binário externo que pode nem estar instalado.

### A-8 · Segredo em `argv`

`argv` é legível por qualquer processo local via `/proc/<pid>/cmdline`. Vale para
o token do Telegram e para o token do túnel (o dossiê é explícito: prefira
`--token-file` a `--token` no `cloudflared`, porque o token em argv vaza no `ps`).

**Regra:** segredo entra por ambiente construído ou por arquivo a 0600. Nunca argv.

### A-9 · Comparação de credencial timing-unsafe

`!==` em string termina no primeiro byte diferente — o tempo de resposta revela
quantos bytes iniciais o atacante já acertou. Ataque de timing remoto é medível:
Crosby/Wallach mediram 15–100 µs pela internet, 100 ns em LAN. CWE-208.

E a armadilha do remédio: `crypto.timingSafeEqual` **lança `RangeError`** se os
buffers tiverem comprimentos diferentes — e essa exceção (ou o `return false`
antecipado que a evitaria) vaza o **comprimento** do segredo.

**Regra:** compare sempre **digests de tamanho fixo** (SHA-256 = 32 bytes), nunca
o material bruto. O código atual já faz isso corretamente; o módulo novo
`secret/verify.ts` herda a mesma disciplina.

### A-10 · Fazer scraping do stdout do `cloudflared`

Medido no dossiê: a URL do quick tunnel sai **100% em stderr**; stdout fica com
**0 bytes**. Script que captura só stdout nunca vê a URL. E `--output json` não
ajuda: a URL continua embutida numa caixa ASCII dentro do campo `message`.

**Regra:** a fonte primária é `GET /quicktunnel` no metrics server local, que
devolve `{"hostname":"xxx.trycloudflare.com"}` — determinístico, sem regex.
Duas armadilhas que viram comentário no código: (a) o hostname vem **sem esquema**,
prefixe `https://`; (b) fixe `--metrics 127.0.0.1:PORT` explicitamente, porque o
default no 2026.7.3 é porta aleatória. O parse de stderr fica como fallback,
com a regex `https://[-a-z0-9]+\.trycloudflare\.com`.

Timeout de readiness ≥ 30s (medido: 6–7s até a URL aparecer, mas o próprio
binário avisa que "may take some time").

> **NÃO CONFIRMADO:** o endpoint `/quicktunnel` **não** está na documentação
> oficial de métricas da Cloudflare. Foi verificado empiricamente com
> cloudflared 2026.7.3. Depender dele exige o fallback por stderr, não é opcional.

### A-11 · Tratar a URL do túnel como segredo

A URL não é credencial. O dossiê mostra que uma única chamada gratuita à API do
urlscan.io devolve dezenas de hostnames `*.trycloudflare.com`, e que ~18% deles
ainda resolviam em DNS naquele instante. DNS funciona como oráculo de liveness.

**Regra:** o modelo de ameaça assume a URL pública **desde o segundo zero**. Toda
a segurança vem da senha, da sessão, do rate limit e do log de auditoria — nunca
da obscuridade. O tipo `TunnelUrl` documenta isso; comentário no ponto de emissão
reforça.

### A-12 · Autorizar por `username` do Telegram, ou por `chat.id` só

Username é mutável e sequestrável. E `callback_query` chega com
`callback_query.from` — em grupo, **qualquer membro** pode apertar o botão de uma
mensagem que o bot mandou; quem validou só `chat.id` está furado.

**Regra:** allowlist de **IDs numéricos**, validando `from.id` **e** `chat.id`.
`message.from` é opcional (ausente em channel posts) — ausência é negação.
Fail closed, default deny. Os tipos `TelegramUserId`/`TelegramChatId` (§1.4)
tornam a troca impossível de compilar.

### A-13 · Tratar `callback_data` como prova de autorização

`callback_data` é fornecido pelo cliente; um cliente modificado manda qualquer
string. Limite de **64 bytes** (bytes, não chars — acento consome 2).

**Regra:** `callback_data` carrega uma chave curta opaca (`srv:on:v1`); a
autorização é **sempre** revalidada por `from.id`. Ação destrutiva exige
confirmação em duas etapas com token efêmero gerado no servidor e TTL curto
(`src/control/confirm.ts`). E `answerCallbackQuery` é **obrigatório** sempre,
mesmo sem texto — sem ele o cliente mostra barra de progresso indefinidamente.

### A-14 · Usar os markdowns como fonte de API

Já coberto em §2, repetido aqui porque é o anti-padrão mais caro do projeto:
os quatro documentos são paráfrase gerada por LLM sobre um projeto real —
acertam a arquitetura, erram nome de pacote, nome de serviço e assinatura de
função. Credibilidade macro escondendo erro micro é o pior tipo de fonte.

**Regra:** prosa para conceito, `.d.ts` para API. Sempre.

### A-15 · Reduzir o gate porque "tem Cloudflare Access na frente"

Access sozinho não protege se alguém alcançar a origem direto. Se houver Access,
a origem **valida o JWT** (`Cf-Access-Jwt-Assertion`, header e não cookie — o
cookie não é garantido). E a senha da aplicação **nunca** é removida por causa
disso: misconfiguração de política e rota de bypass são o modo de falha comum.

**Regra:** as camadas são independentes e cumulativas. Remover uma exige
justificativa escrita no plano, não no código.

---

## 10. Definition of Done de uma sub-tarefa

Checklist objetivo. Todo item é verificável por outro agente lendo o diff. Uma
sub-tarefa que não fecha todos **não vai para o merge**.

### Correção
- [ ] **O comando de gate canônico passa** (09 §D4), na ordem exata, no snapshot: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`. `lint` é `oxlint . && eslint .` — chamado pelo script, nunca pelos binários soltos, para que gate local e CI sejam a mesma coisa.
- [ ] Zero `@ts-ignore`/`@ts-expect-error` sem comentário com PORQUÊ.
- [ ] Todo símbolo novo de `@deepseek-ai/*` foi verificado contra o `.d.ts` do tarball (Q-1), veio por `src/dsh/adapter.ts`, e o stub em `types/` traz o cabeçalho de proveniência.
- [ ] Nenhum `?? default` em campo de segurança, ciclo de vida ou rede.
- [ ] Nenhum símbolo refutado (E1–E4) introduzido: `git grep -nE "webServer|dsh-host-subprocess|dsh-host-frontend([^-]|$)"` no diff devolve zero fora de tabela de correção.

### Ciclo de vida
- [ ] Todo recurso alocado devolve disposer **síncrono**, idempotente, que não lança.
- [ ] Timers criados têm handle guardado e são cancelados no disposer.
- [ ] Nenhum estado de topo de módulo (`let`/`Map`/`Set` fora de factory).
- [ ] Disposer nativo de `ctx.on`/`ctx.intercept`/`register*` propagado, nunca descartado.

### Testes (detalhe em `04-TESTES.md`)
- [ ] Teste unitário para todo caminho de decisão de segurança, incluindo o negativo.
- [ ] Teste que prova o disposer: alocar → dispor → afirmar que o recurso sumiu (para processo: o **neto** morreu).
- [ ] Teste afirma sobre `error.code`, nunca sobre o texto da mensagem.
- [ ] Nenhum teste novo depende de rede real, relógio real ou porta fixa.

### Erro e log
- [ ] Nenhum `catch` vazio; os dois casos legítimos (§6.3) têm comentário.
- [ ] Erros novos são `GuardError` com `code` da união e `cause` preservado.
- [ ] Mensagem diz o quê + onde + o que fazer.
- [ ] Nenhum log direto em `ctx.logger` — tudo via `src/logging/logger.ts`.
- [ ] Nenhum segredo em mensagem, log, argv ou disco em claro.

### Forma
- [ ] Arquivo ≤ 400 linhas; função ≤ 60; aninhamento ≤ 4; ≤ 4 parâmetros.
- [ ] Uma responsabilidade por arquivo; nome não contém "utils/helpers/common/misc".
- [ ] Sem ciclo de import; direção `index → domínio → primitiva` respeitada.
- [ ] Comentários explicam PORQUÊ; os cinco casos obrigatórios (§7.3) cobertos.
- [ ] Todo fato não verificado marcado `NÃO CONFIRMADO` **no código**, não só no plano.

### Contrato
- [ ] Mudança em `Config` refletida em `cordis.patch.yml` **e** no README, no mesmo commit.
- [ ] Evento novo declarado por *declaration merging* com `/** @mode … */`.
- [ ] Se tocou o mapa de propriedade de arquivo do `03-ONDAS.md` §4, isso está anotado no relatório da sub-tarefa.
- [ ] **Nada em `src/contracts/**` foi editado** fora de um COMMIT PREP.
- [ ] Nenhum nome morto reintroduzido (09 §D5): `/__mobile`, `/__gate`, `mobile-gateway.json`, `ADMIN_USER`, `ADMIN_PASS`, `DSH_TELEGRAM_BOT_TOKEN`, `/parar`, `/parar_bot`, `/desligar_servidor`, `/abrir_tunel`, `/vincular`, `DESLIGADO`/`INICIANDO`/`ONLINE`/`DEGRADADO`/`DESLIGANDO` como valor de estado.
- [ ] Se o arquivo mora em `worker/`, ele **não** importa nada de `src/` além de tipos de `src/contracts/`.

---

## 11. Reaproveitamento: o que se mantém, muda e nasce

| Ativo atual | Veredito | Detalhe |
| --- | --- | --- |
| `verifyBasicAuth` e a disciplina de comparação por digest | **Mantém** | Vira `src/http/auth-basic.ts` sem mudança de lógica |
| `normalizeRemoteAddress`, `isTrustedRemote` | **Mantém** | Vira `src/http/origin.ts` |
| `canonicalRequestPath`, `isGuardedPath`, `routeMayServeGuardedPath` | **Mantém** | Vira `src/http/path.ts` |
| `assertValidConfig`, `assertSecureBind` | **Muda** | Lógica preservada; ganha as chaves novas (túnel, sessão, rate limit, Telegram) e a política de bind é reescrita pela tensão central |
| `createWorkerSupervisor` | **Muda** | Estrutura e invariantes preservadas; a chamada de `spawn` é reescrita para a assinatura de objeto único (Q-1) |
| `buildWorkerEnv`, `computeBackoffDelay` | **Mantém** | Viram `src/proc/env.ts` e `src/proc/backoff.ts` |
| Fiação do `ctx.intercept` sobre `register`/`registerFallback` | **Muda** | Mesma técnica, serviço renomeado para `httpServer` |
| Veto de elevação de permissão | **Mantém** | Vira `src/permissions/deny.ts` |
| Comentários de divergência deliberada e medição | **Mantém, obrigatoriamente** | Viajam com a função |
| `src/index.ts` de 1836 linhas | **Muda** | Vira ~200 linhas de fiação pura |
| `types/dsh-host-subprocess/` | **Muda** | Renomeia para `types/dsh-subprocess/` e é reescrito a partir do tarball real |
| `src/errors.ts`, `src/logging/{logger,redact}.ts`, `src/brand.ts`, `src/dsh/adapter.ts`, `src/state/**`, `src/contracts/**` | **Nasce** | Não existem hoje |
| `src/tunnel/`, `src/secret/`, `src/session/`, `src/ratelimit/`, `src/audit/`, `src/control/`, `src/panel/`, `src/telegram/` | **Nasce** | Capacidades novas |

---

## 12. Itens NÃO CONFIRMADOS usados nesta seção

Registrados explicitamente para que ninguém os trate como fato:

1. **`@deepseek-ai/dsh-brand`** — o conceito de Branded IDs vem do `AGENTS.md`
   citado na prosa; o pacote não aparece na amostra do npm verificada. Spike da
   Onda 0. Plano B: `src/brand.ts` local (§1.4).
2. **Como o DSH carrega este plugin** (`src/` via `tsx/esm`, `src/` via type
   stripping nativo, ou `dist/`). Decide a extensão dos imports relativos e é
   pré-requisito do fatiamento (§3.4).
3. **`rewriteRelativeImportExtensions`** do TypeScript — não aparece no dossiê.
   Verificar contra `tsc --help` da versão exata antes de depender.
4. **`SubprocessSpawnSpec` aceita `detached`.** Os campos obrigatórios
   confirmados são `argv`, `cwd`, `stdio`, `graceMs` (+ `signal?`). Se `detached`
   não existir, a invariante A-1 inteira precisa ser repensada. **Maior risco
   isolado do plano.**
5. **`ctx.subprocess` faz `taskkill /T /F` no Windows.** Veio da prosa. O ramo
   `win32` do tree-kill depende disso.
6. **`GET /quicktunnel`** não está documentado oficialmente; foi verificado
   empiricamente em cloudflared 2026.7.3. Por isso o fallback por stderr é
   obrigatório, não opcional (A-10).
7. ~~Thresholds de cobertura via CLI do `node --test`~~ — **item removido: o fato
   está confirmado** (09 §D24 item 3). `--test-coverage-lines`,
   `--test-coverage-branches` e `--test-coverage-functions` são **estáveis**; o que
   segue experimental é apenas a *coleta* (`--experimental-test-coverage`).
   `08-PESQUISA-E-FONTES.md` §5.2 dá razão a `04-TESTES.md` §3.1, e este documento
   estava errado ao listá-lo como não confirmado.
8. **`InlineKeyboardButton.style`** (`success`/`danger`/`primary`) — usado por
   outros documentos do plano como fato de confiança "Alta" e **não verificado**
   contra a referência da Bot API. Spike da Onda 0 (T0.3). Nenhuma entrega deste
   plugin pode depender do campo até lá; o teclado se distingue por **texto**.
9. **Repasse de IP do cliente pelo `cloudflared`, e se o valor é controlável pelo
   atacante** (spike S2). Enquanto não fechar, `exposure.trustEdgeHeaders`
   permanece `false` e nenhum módulo pode tratar `X-Forwarded-For`,
   `CF-Connecting-IP` ou `Forwarded` como identidade confiável — é a diferença
   entre um rate limit e um canal de spam operado pelo atacante.
