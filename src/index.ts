/**
 * =============================================================================
 * dsh-guarded-bot-orchestrator
 * Plugin Cordis v4 para o DeepSeek Harness (DSH) v0.1
 * =============================================================================
 *
 * O QUE ESTE FICHEIRO FAZ (tres responsabilidades, um so modulo por desenho:
 * o entregavel e um plugin auto-contido, carregado pelo motor a partir do
 * fonte):
 *
 *   1. INTERCECAO HTTP REVERSIVEL
 *      Envolve `ctx.webServer` atraves de `ctx.intercept` e impoe uma barreira
 *      de Basic Auth avaliada por `ctx.waterfall('http/auth-check', ...)`.
 *      Nenhuma biblioteca externa: so `node:http` (tipos) e `node:crypto`.
 *
 *   2. ORQUESTRACAO ATOMICA DO WORKER DE LONG-POLLING
 *      O processo filho (binario Python) vive dentro de um `ctx.effect()`,
 *      cujo disposer SINCRONO aborta, mata a arvore processual e cancela o
 *      temporizador de reinicio. A Fiber do Cordis erradica tudo em LIFO.
 *
 *   3. ENDURECIMENTO DO PLANO DE CONTROLO
 *      Bind de loopback obrigatorio, allowlist de origens remotas fail-closed,
 *      guarda explicita sobre as rotas `/api` (que NAO passam pelo fallback) e
 *      sobre o handshake de WebSocket (que nao esta sujeito a same-origin
 *      policy). O veto de elevacoes para `danger-full-access` existe como
 *      DEFESA EM PROFUNDIDADE -- nao como travao principal: ver a nota extensa
 *      no ouvinte `security/permission-elevate` em `apply()`.
 *
 * PORQUE E QUE ISTO EXISTE
 *   A discussao oficial #853 ("unauthenticated local/remote code execution via
 *   the dsh web UI control plane", verificada em 0.1.0-rc.6) demonstra que a
 *   sub-estacao `/api` do DSH responde a sockets SEM qualquer credencial. Entre
 *   as suas mais de 60 rotas RPC esta `commands/execute`, capaz de injetar
 *   `/permission danger-full-access` e derrubar o confinamento
 *   `workspace-write` do Sandbox (fuga documentada em #1769). Este plugin e o
 *   portao que fecha essa superficie.
 *
 * CONVENCOES DO AGENTS.md DO DSH APLICADAS AQUI
 *   - "fail loud at load": configuracao invalida ou bind inseguro fazem
 *     `throw` no `apply()`. Nunca `?? valor_por_omissao` silencioso.
 *   - "explicit > implicit": tudo o que e politica de seguranca vem da
 *     configuracao, nada e inferido.
 *   - Reversibilidade atomica: TODO registo propaga o disposer nativo.
 * =============================================================================
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { statSync } from 'node:fs'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context, Disposer } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer, WebUpgradeHandler } from '@deepseek-ai/dsh-host-webserver'
import type { ChildProcess } from '@deepseek-ai/dsh-host-subprocess'

/* ========================================================================== */
/* Manifesto do plugin                                                        */
/* ========================================================================== */

/**
 * Nome do PLUGIN (identidade do modulo perante o motor Cordis).
 *
 * NOTA: nao confundir com o `id` usado no `cordis.patch.yml`
 * (`guarded-bot-orchestrator`). O `id` identifica a ENTRADA de configuracao
 * numa camada de patch; o `name` identifica o pacote/modulo a resolver.
 */
export const name = 'dsh-guarded-bot-orchestrator'

/**
 * Injecao de dependencias (composicao espacial). O motor so ativa a Fiber
 * deste plugin depois de `ctx.webServer`, `ctx.subprocess` e `ctx.logger`
 * estarem disponiveis -- e descarta-a de novo se alguma desaparecer.
 */
export const inject = ['webServer', 'subprocess', 'logger']

/** Escopo usado em todas as chamadas ao `ctx.logger`. */
const LOG_SCOPE = 'guarded-bot'

/* ========================================================================== */
/* Eventos tipados (module augmentation)                                      */
/* ========================================================================== */

/**
 * Expansao estatica global do mapa `Events`. E isto que da VALIDACAO PELO
 * COMPILADOR aos despachos: `ctx.waterfall('http/auth-check', req, next)` so
 * compila porque a assinatura abaixo existe. `Events` nasce vazia no Cordis e
 * cada plugin declara os eventos que emite/consome.
 *
 * (Este ficheiro tem `import`/`export` de topo, logo e um MODULO -- condicao
 * indispensavel para que `declare module` funcione como *augmentation* em vez
 * de redeclarar o modulo por inteiro.)
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode waterfall */
    'http/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
    /** @mode waterfall */
    'security/permission-elevate'(command: string, next: () => Promise<boolean>): Promise<boolean>
  }
}

/* ========================================================================== */
/* Configuracao (CONTRATO CONGELADO)                                          */
/* ========================================================================== */

/**
 * Forma exata da entrada `config` do `cordis.patch.yml` (id
 * `guarded-bot-orchestrator`). Como a resolucao de patches do DSH e
 * *whole-entry replace* e nao *deep merge*, cada chave aqui tem de existir
 * literalmente no YAML: uma chave omitida e uma chave APAGADA, nao herdada.
 *
 * NAO renomear, NAO omitir, NAO acrescentar chaves.
 */
export interface Config {
  /** Par `utilizador:senha` ja codificado em base64 (o que segue `Basic `). */
  encodedAuthString: string
  /** Texto do desafio devolvido em `WWW-Authenticate` nas respostas 401. */
  realm: string
  /** Interfaces de bind aceites para `ctx.webServer.host` (allowlist do BIND). */
  allowedHosts: string[]
  /** Origens remotas confiadas (`req.socket.remoteAddress`). Vazio = nega tudo. */
  trustedRemotes: string[]
  /** Prefixos de rota que exigem autenticacao (ex.: `/api`). */
  guardedPrefixes: string[]
  /** Niveis de permissao recusados mesmo a pedidos autenticados. */
  deniedPermissions: string[]
  /** Worker de long-polling executado fora do event loop central. */
  worker: {
    command: string
    args: string[]
    cwd: string
    token: string
    backoff: {
      initialDelayMs: number
      maxDelayMs: number
      maxAttempts: number
      resetAfterMs: number
    }
  }
}

/** Atalho para o sub-objeto de recuo exponencial. */
export type BackoffConfig = Config['worker']['backoff']

/** Forma do argumento de `ctx.webServer.register` (rota exata ou por prefixo). */
type RouteRegistration = Parameters<WebServer['register']>[0]

/** Forma do argumento de `ctx.webServer.registerUpgrade` (handshake WebSocket). */
type UpgradeRegistration = Parameters<WebServer['registerUpgrade']>[0]

/* ========================================================================== */
/* 1. PRIMITIVAS DE SEGURANCA (puras, exportadas para serem testaveis)        */
/* ========================================================================== */

/**
 * Comparacao de credencial em TEMPO CONSTANTE.
 *
 * PORQUE NAO `!==`: o exemplo canonico da documentacao compara as strings com
 * `!==`. Isso e *timing-unsafe* -- a comparacao de strings do V8 termina no
 * primeiro byte diferente, pelo que o tempo de resposta revela quantos bytes
 * iniciais o atacante ja acertou, permitindo recuperar a credencial byte a
 * byte com medicoes estatisticas.
 *
 * PORQUE COMPARAR DIGESTS EM VEZ DO MATERIAL BRUTO: `crypto.timingSafeEqual`
 * LANCA `RangeError` se os buffers tiverem comprimentos diferentes -- e essa
 * excecao (ou o `return false` antecipado que a evitaria) vazaria o COMPRIMENTO
 * do segredo. Reduzir ambos os lados a um SHA-256 da sempre 32 bytes fixos, o
 * que torna a comparacao total e de duracao independente da entrada.
 *
 * ESQUEMA COMPARADO SEM DIFERENCIAR MAIUSCULAS (RFC 7235, seccao 2.1): o
 * *auth-scheme* e um token case-insensitive, pelo que `basic <credencial>` e
 * `BASIC <credencial>` sao pedidos legitimos. Comparar o esquema com `Basic `
 * literal produzia um 401 indevido a clientes conformes (curl com `--user`
 * envia `Basic`, mas bibliotecas HTTP e proxies normalizam cabecalhos de formas
 * diferentes). O PAYLOAD base64 que se segue continua a ser comparado byte a
 * byte, sensivel a maiusculas -- ai a sensibilidade e obrigatoria, porque
 * base64 distingue `A` de `a`.
 */
export function verifyBasicAuth(
  authorizationHeader: string | undefined,
  encodedAuthString: string,
): boolean {
  if (typeof authorizationHeader !== 'string') return false

  const prefix = 'basic '
  // O esquema em si nao e segredo: compara-lo em tempo variavel nao vaza nada.
  if (authorizationHeader.slice(0, prefix.length).toLowerCase() !== prefix) return false

  const presented = authorizationHeader.slice(prefix.length).trim()
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(encodedAuthString, 'utf8').digest()

  return timingSafeEqual(presentedDigest, expectedDigest)
}

/**
 * Normaliza um endereco de socket para uma forma canonica comparavel.
 *
 * O Node entrega enderecos IPv4 em sockets dual-stack no formato IPv6-mapeado
 * (`::ffff:127.0.0.1`). Sem normalizacao, uma allowlist com `'127.0.0.1'`
 * falharia contra o MESMO cliente so por causa da representacao.
 *
 * O loopback IPv6 (`::1`) e colapsado para `127.0.0.1` porque e a MESMA origem
 * local: assim a allowlist nao precisa de duplicar entradas. As proprias
 * entradas de `trustedRemotes` passam por esta funcao, logo escrever `'::1'`
 * no YAML continua a funcionar.
 */
export function normalizeRemoteAddress(address: string | undefined | null): string | undefined {
  if (typeof address !== 'string') return undefined

  let value = address.trim().toLowerCase()
  if (value.length === 0) return undefined

  // Zone id de link-local (`fe80::1%eth0`) nao faz parte da identidade do par.
  const zoneIndex = value.indexOf('%')
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex)

  // Forma entre parenteses rectos usada em autoridades de URL (`[::1]`).
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)

  // IPv4 mapeado em IPv6.
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)

  // Loopback IPv6, nas duas grafias possiveis.
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') value = '127.0.0.1'

  return value.length === 0 ? undefined : value
}

/**
 * Politica de sub-rede confiada.
 *
 * SEMANTICA FAIL-CLOSED EXPLICITA E INTENCIONAL:
 *   `trustedRemotes: []` significa NINGUEM E CONFIADO -- nega tudo, incluindo o
 *   proprio loopback. Nao ha "lista vazia = toda a gente", que e a interpretacao
 *   permissiva que produz exatamente a falha #853. Quem quiser servir o
 *   loopback tem de escrever `['127.0.0.1']` no `cordis.patch.yml`; a permissao
 *   e sempre um ato deliberado do administrador, nunca um efeito colateral de
 *   uma omissao.
 *
 * Um socket sem `remoteAddress` (ja destruido, ou transporte nao-IP) tambem e
 * negado: na duvida, fecha-se.
 */
export function isTrustedRemote(
  address: string | undefined | null,
  trustedRemotes: readonly string[],
): boolean {
  if (trustedRemotes.length === 0) return false

  const remote = normalizeRemoteAddress(address)
  if (remote === undefined) return false

  return trustedRemotes.some((entry) => normalizeRemoteAddress(entry) === remote)
}

/**
 * Extrai o caminho de um URL cru de requisicao/registo, descartando query
 * string e fragmento. Sem `new URL(...)`: o `req.url` do `node:http` e um
 * caminho relativo e nao um URL absoluto.
 */
function extractPathname(rawUrl: string | undefined): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return '/'

  const withoutFragment = rawUrl.split('#', 1)[0] ?? ''
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? ''

  return withoutQuery.length === 0 ? '/' : withoutQuery
}

/**
 * `decodeURIComponent` que nao rebenta. Uma sequencia percent malformada
 * (`%zz`, `%` solto) lanca `URIError`; num caminho de decisao de seguranca uma
 * excecao seria pior do que a string por decodificar, por isso devolve-se a
 * entrada intacta e deixa-se a normalizacao seguinte tratar dela.
 */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Reduz um caminho (de requisicao OU de registo) a uma CHAVE DE COMPARACAO
 * canonica. Nao e um caminho utilizavel para servir ficheiros -- e apenas a
 * forma normalizada com que se decide se algo cai sob um prefixo guardado.
 *
 * O que e neutralizado, e porque (cada item corresponde a um contorno real da
 * barreira observado em laboratorio):
 *
 *   - percent-encoding, aplicado ATE ESTABILIZAR (limite de 3 passagens):
 *     `/%61pi` e `/%2561pi` designam `/api` depois de uma e de duas
 *     descodificacoes. O limite existe para nao dar ao atacante um ciclo
 *     arbitrario a custo zero;
 *   - barras invertidas -> barras normais: `\api` e uma grafia aceite por
 *     varias pilhas HTTP e por navegadores em Windows;
 *   - barras repetidas colapsadas: `//api/x` e `/api/x` sao o mesmo recurso
 *     para um encaminhador por prefixo;
 *   - segmentos `.` e `..` resolvidos: `/x/../api` nao pode escapar a guarda;
 *   - caixa: comparacao insensivel a maiusculas. Isto SOBRE-GUARDA (`/API`
 *     passa a ser tratado como guardado mesmo onde o encaminhador do DSH e
 *     sensivel a maiusculas), o que e a direcao segura: guardar a mais devolve
 *     401 a um pedido que nao existiria; guardar a menos e a #853.
 */
export function canonicalRequestPath(rawUrl: string | undefined): string {
  let pathname = extractPathname(rawUrl)

  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = safeDecodeURIComponent(pathname)
    if (decoded === pathname) break
    pathname = decoded
  }

  pathname = pathname.replace(/\\/gu, '/')

  const segments: string[] = []
  for (const segment of pathname.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  return `/${segments.join('/')}`.toLowerCase()
}

/**
 * Decide se um caminho cai sob um dos prefixos guardados (relacao
 * DESCENDENTE: o caminho esta DENTRO do prefixo).
 *
 * A fronteira e feita ao SEGMENTO e nao ao caractere: `/api` guarda `/api` e
 * `/api/commands/execute`, mas NAO guarda `/apinfo` -- que e um recurso
 * distinto e cuja captura acidental produziria 401 em rotas legitimas.
 *
 * Ambos os lados passam por {@link canonicalRequestPath}, pelo que `//api`,
 * `/API`, `/%61pi` e `/x/../api` sao todos reconhecidos como `/api`.
 */
export function isGuardedPath(
  rawUrl: string | undefined,
  guardedPrefixes: readonly string[],
): boolean {
  const pathname = canonicalRequestPath(rawUrl)

  return guardedPrefixes.some((rawPrefix) => {
    const prefix = canonicalRequestPath(rawPrefix)
    if (prefix === '/') return true // prefixo `/` guarda o servidor inteiro
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}

/**
 * Decide, no momento do REGISTO, se uma rota tem de ser embrulhada pelo portao.
 *
 * PORQUE NAO BASTA {@link isGuardedPath}: a decisao de registo nao pode olhar
 * so para rotas DENTRO do prefixo guardado. Uma rota registada como
 * `kind: 'prefix'` num ANCESTRAL do prefixo -- no caso limite, em `/` -- serve
 * `/api/commands/execute` sem nunca ter `/api` no seu proprio `path`. Provado
 * em laboratorio: com `guardedPrefixes: ['/api']`, uma rota `prefix` em `/`
 * respondia 200 a um POST nao autenticado para `/api/commands/execute`.
 *
 * Logo guarda-se a rota em DUAS situacoes:
 *   - DESCENDENTE: o caminho registado esta dentro de um prefixo guardado
 *     (`/api/health` sob `/api`) -- a rota so serve superficie guardada;
 *   - ANCESTRAL: o caminho registado esta ACIMA de um prefixo guardado e o
 *     registo e por prefixo (`/` ou `/a` como `prefix`, com `/api` guardado) --
 *     a rota PODE servir superficie guardada.
 *
 * Uma rota `exact` num ancestral nao entra: por definicao serve exatamente
 * aquele caminho e nunca alcanca `/api/...`.
 */
export function routeMayServeGuardedPath(
  route: { kind: string; path: string },
  guardedPrefixes: readonly string[],
): boolean {
  const path = canonicalRequestPath(route.path)

  return guardedPrefixes.some((rawPrefix) => {
    const prefix = canonicalRequestPath(rawPrefix)
    if (prefix === '/') return true

    // Descendente (a relacao que ja existia).
    if (path === prefix || path.startsWith(`${prefix}/`)) return true

    // Ancestral: so um registo por prefixo alcanca caminhos abaixo de si.
    if (route.kind !== 'prefix') return false
    return path === '/' || prefix.startsWith(`${path}/`)
  })
}

/**
 * Reduz um token a uma forma canonica comparavel.
 *
 * As quatro normalizacoes correspondem, uma a uma, a evasoes que a versao
 * anterior deixava passar (todas verificadas):
 *
 *   1. percent-decoding iterado -> `danger%2Dfull%2Daccess` e
 *      `danger%252Dfull%252Daccess` colapsam em `danger-full-access`;
 *   2. caixa -> `DANGER-FULL-ACCESS`;
 *   3. separadores equivalentes (`_`, `.`, `+`, espaco em branco) reescritos
 *      como `-` -> `danger_full_access`, `danger.full.access` e
 *      `danger+full+access` (o `+` e a grafia de espaco em corpos
 *      `application/x-www-form-urlencoded`);
 *   4. pontuacao nas BORDAS removida -> `.danger-full-access` e
 *      `danger-full-access.`.
 *
 * O que NAO se normaliza (de proposito): pontuacao INTERIOR que nao seja
 * separador. `danger-full-access-audit` continua a ser um token distinto, e
 * tem de continuar: e uma permissao diferente e captura-la seria um falso
 * positivo que quebraria fluxos legitimos.
 */
function canonicalizePermissionToken(rawToken: string): string {
  let value = rawToken

  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = safeDecodeURIComponent(value)
    if (decoded === value) break
    value = decoded
  }

  value = value.toLowerCase().replace(/[\s._+]+/gu, '-')

  // Pontuacao nas bordas: tudo o que nao seja alfanumerico e descartado nas
  // extremidades (o interior fica intacto, ver nota acima).
  value = value.replace(/^[^a-z0-9]+/u, '').replace(/[^a-z0-9]+$/u, '')

  return value
}

/**
 * Deteta se um comando pede uma permissao recusada.
 *
 * A analise e por TOKEN e nao por `includes()` de substring: `includes` daria
 * falso positivo em `danger-full-access-audit` e falso negativo perante
 * espacamento diferente. Devolve a permissao encontrada (para o registo de
 * auditoria) ou `undefined`.
 *
 * O `%` entra no alfabeto de token de proposito: sem ele,
 * `danger%2Dfull%2Daccess` era PARTIDO em tres tokens (`danger`, `2dfull`,
 * `2daccess`) e nenhum casava com a agulha. Com o `%` dentro do token, a
 * descodificacao em {@link canonicalizePermissionToken} reconstitui a palavra.
 * As proprias entradas de `deniedPermissions` passam pela mesma canonicalizacao,
 * para que escrever `danger_full_access` no YAML continue a barrar
 * `danger-full-access`.
 */
export function requestsDeniedPermission(
  command: string,
  deniedPermissions: readonly string[],
): string | undefined {
  const tokens = new Set(
    command
      .split(/[^A-Za-z0-9._%+-]+/u)
      .map((token) => canonicalizePermissionToken(token))
      .filter((token) => token.length > 0),
  )

  for (const permission of deniedPermissions) {
    const needle = canonicalizePermissionToken(permission)
    if (needle.length > 0 && tokens.has(needle)) return permission
  }

  return undefined
}

/* ========================================================================== */
/* 2. RECUO EXPONENCIAL                                                       */
/* ========================================================================== */

/**
 * Calcula o atraso antes da tentativa `attempt` (1 = primeiro reinicio).
 *
 * Base: `initialDelayMs * 2^(attempt-1)`, saturada em `maxDelayMs` -- os
 * valores nominais documentados do DSH sao 500 ms e 10.000 ms
 * (`reconnect.initialDelayMs` / `reconnect.maxDelayMs` do cliente MCP). O teto
 * evita latencias impraticaveis depois de longos periodos fora do ar; a
 * progressao evita a reinterrogacao compulsiva que satura o event loop.
 *
 * O JITTER E SOMADO POR CIMA DA BASE, NUNCA SUBTRAIDO DELA. Esta e uma
 * correcao deliberada face a variante "equal jitter" (`base/2 + random*base/2`)
 * usada antes: com ela, o atraso da PRIMEIRA tentativa caia para 250 ms com
 * `random()` proximo de 0 -- metade do `initialDelayMs: 500` que o DSH
 * prescreve como base cronologica inicial imposta. Um piso abaixo do minimo
 * documentado e um crash-loop mais agressivo do que o configurado, exatamente
 * no cenario em que o worker esta a falhar de imediato.
 *
 * Contrato desta funcao, agora verdadeiro para QUALQUER `random()`:
 *
 *   base <= atraso <= min(base * 1.5, maxDelayMs)
 *
 * ou seja, o piso e a base nominal (`initialDelayMs` na primeira tentativa) e
 * o teto absoluto continua a ser `maxDelayMs`, com saturacao. Com
 * `random() === 0` a sequencia degenera exatamente na progressao nominal
 * (500, 1000, 2000, ..., 10000, 10000), o que torna a funcao verificavel de
 * forma determinista nos testes.
 *
 * PORQUE HA JITTER DE TODO: sem ele, N instancias do DSH que percam o mesmo
 * servico remoto voltam TODAS no mesmo milissegundo (*thundering herd*),
 * reconstruindo a sobrecarga que o backoff pretendia dissipar. Nota honesta: na
 * saturacao (base ja igual a `maxDelayMs`) o teto absorve a margem de jitter e
 * o atraso volta a ser deterministico -- e o preco de manter `maxDelayMs` como
 * limite duro, e nao um descuido.
 */
export function computeBackoffDelay(
  attempt: number,
  backoff: BackoffConfig,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  const base = Math.min(backoff.initialDelayMs * 2 ** exponent, backoff.maxDelayMs)
  const jitter = random() * (base / 2)

  return Math.round(Math.min(base + jitter, backoff.maxDelayMs))
}

/* ========================================================================== */
/* 3. AGENDADOR INJETAVEL                                                     */
/* ========================================================================== */

/**
 * Handle opaco de temporizador. Opaco DE PROPOSITO: permite injetar um
 * agendador falso nos testes sem depender do tipo `NodeJS.Timeout`.
 */
export type TimerHandle = unknown

/** Costura minima sobre `setTimeout`/`clearTimeout`. */
export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/** Implementacao real, assente nos temporizadores do Node. */
export const nodeScheduler: Scheduler = {
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return globalThis.setTimeout(callback, delayMs)
  },
  clearTimeout(handle: TimerHandle): void {
    // O handle so pode ter vindo do `setTimeout` acima; a asercao devolve-lhe
    // o tipo concreto que a API do Node exige.
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

/** Dependencias externas do supervisor, todas substituiveis nos testes. */
export interface SupervisorDeps {
  scheduler: Scheduler
  random: () => number
  now: () => number
  platform: NodeJS.Platform
  kill: (pid: number, signal: NodeJS.Signals) => void
}

/** Dependencias reais (processo Node corrente). */
export const defaultSupervisorDeps: SupervisorDeps = {
  scheduler: nodeScheduler,
  random: Math.random,
  now: Date.now,
  platform: process.platform,
  kill: (pid: number, signal: NodeJS.Signals): void => {
    process.kill(pid, signal)
  },
}

/* ========================================================================== */
/* 4. AMBIENTE MINIMO DO WORKER                                               */
/* ========================================================================== */

/**
 * Variaveis de ambiente que o worker RECEBE. Tudo o resto e cortado.
 *
 * PORQUE UMA ALLOWLIST E NAO `{ ...process.env }`: o plano de controlo do DSH
 * corre com `ADMIN_USER`/`ADMIN_PASS` no ambiente (e o `cordis.patch.yml` que
 * as le para montar a credencial de Basic Auth). Herdar `process.env` inteiro
 * entregava essas duas variaveis a um binario Python de terceiros que consome
 * input arbitrario da Internet (long-polling do Telegram). Comprometido o bot,
 * o atacante le `ADMIN_PASS` do seu proprio `/proc/self/environ` e autentica-se
 * no plano de controlo -- exatamente o pivo remoto->local que este plugin
 * existe para impedir. O ambiente e portanto CONSTRUIDO, nunca herdado.
 *
 * O criterio de inclusao e "sem isto um processo Python nao arranca ou nao
 * fala TLS", nao "e comodo ter". Quem precisar de mais (um proxy corporativo,
 * por exemplo) acrescenta aqui explicitamente -- de novo, "explicit > implicit".
 */
const WORKER_ENV_ALLOWLIST: readonly string[] = [
  // Indispensaveis para localizar e executar o interpretador.
  'PATH',
  'HOME',
  'TMPDIR',
  // Localizacao / formatacao (evita UnicodeDecodeError em locales exoticos).
  'LANG',
  'TZ',
  // Interpretador.
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'PYTHONDONTWRITEBYTECODE',
  // Raizes de confianca TLS (sem elas o cliente HTTPS do bot falha a validar).
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  // Windows: sem SystemRoot/ComSpec o proprio arranque do processo falha.
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
]

/** Prefixos aceites em bloco (as `LC_*` do POSIX sao dezenas). */
const WORKER_ENV_PREFIXES: readonly string[] = ['LC_']

/**
 * Monta o ambiente do worker: allowlist + o token do bot.
 *
 * O token entra por ambiente e NUNCA por argv, porque `argv` e legivel por
 * qualquer processo local em `/proc/<pid>/cmdline`.
 *
 * As chaves sao comparadas em maiusculas porque o Windows trata os nomes de
 * variaveis de forma insensivel a caixa (`SystemRoot` == `SYSTEMROOT`).
 */
export function buildWorkerEnv(source: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue

    const upper = key.toUpperCase()
    const allowed =
      WORKER_ENV_ALLOWLIST.includes(upper) ||
      WORKER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))

    if (allowed) env[key] = value
  }

  env['TELEGRAM_BOT_TOKEN'] = token

  return env
}

/* ========================================================================== */
/* 5. SUPERVISOR DO WORKER DE LONG-POLLING                                    */
/* ========================================================================== */

/** Superficie publica do supervisor. `dispose` e SINCRONO por contrato. */
export interface WorkerSupervisor {
  /** Arranca o worker imediatamente (primeira instanciacao). */
  start(): void
  /** Disposer SINCRONO: cancela reinicio, aborta e faz tree-kill. */
  dispose(): void
  /** Numero de reinicios ja consumidos do orcamento (observabilidade/testes). */
  readonly attempts: number
  /**
   * Estado TERMINAL: o orcamento `maxAttempts` esgotou-se e a recuperacao
   * automatica cessou definitivamente. Ver a nota de divergencia em
   * {@link createWorkerSupervisor}.
   */
  readonly exhausted: boolean
}

/**
 * Cria o supervisor do processo filho.
 *
 * REQUISITO DURO DE CONCORRENCIA (ver `apply` para o contexto completo):
 * nenhuma funcao aqui faz `await` de uma operacao dependente da rede ou do
 * reinicio. O tratador de `exit` e SINCRONO e o reagendamento e
 * *fire-and-forget* via `setTimeout`.
 *
 * -----------------------------------------------------------------------------
 * DIVERGENCIA DELIBERADA DO EXEMPLO CANONICO DA DOCUMENTACAO (nao "corrigir"
 * de volta): o disposer do doc-fonte escreve
 *
 *     if (child.pid && !child.killed) process.kill(-child.pid, 'SIGKILL')
 *
 * e essa guarda `!child.killed` TORNA O TREE-KILL CODIGO MORTO. Razao: o Node,
 * ao processar `abortController.abort()`, chama `child.kill()` de forma
 * SINCRONA, o que poe `child.killed = true` ANTES de a linha seguinte correr.
 * A condicao nunca e verdadeira no unico caminho em que interessa. Medido com
 * processos reais (pai `detached` + neto):
 *
 *     ANTES  do dispose()   filho 1326740 (pgid 1326740), neto 1326741
 *     DEPOIS do dispose()   filho MORTO,  neto 1326741 ppid=1830 <- ORFAO
 *
 * Removida a guarda, o neto morre com o grupo. Aqui o tree-kill e portanto
 * SEMPRE tentado quando ha `pid`, independentemente de `killed`.
 *
 * `killed` significa apenas "um sinal foi entregue com sucesso ao filho", e nao
 * "o filho e a sua descendencia ja nao existem" -- so o kill do GRUPO garante a
 * segunda coisa. (Ressalva honesta: se o grupo ja tiver terminado por completo,
 * o `pid` podia em teoria ter sido reutilizado pelo sistema; POSIX so garante a
 * nao-reutilizacao do pgid enquanto o grupo existir. E o mesmo risco residual
 * do exemplo canonico, e o custo de o nao correr -- netos orfaos a consumir
 * descritores e memoria ate ao fim do processo hospedeiro -- e maior.)
 * -----------------------------------------------------------------------------
 *
 * DIVERGENCIA DOCUMENTADA #2 -- ORCAMENTO ESGOTADO: a tabela do cliente MCP
 * descreve `reconnect.maxAttempts` como cessando a recuperacao E
 * "desregistando ativamente o plugin ate o utilizador recarregar manualmente".
 * A superficie tipada desta distribuicao (`types/cordis/index.d.ts`) NAO expoe
 * qualquer forma de auto-desregisto: `Context` oferece `intercept`, `waterfall`,
 * `parallel`, `on`, `effect` e `get` -- nada que remova a propria Fiber. Em vez
 * de inventar API inexistente, implementa-se o que a superficie permite: um
 * ESTADO TERMINAL explicito e observavel (`supervisor.exhausted`) mais um erro
 * inequivoco no log. Ver README.md, seccao "Divergencias assumidas".
 */
export function createWorkerSupervisor(
  ctx: Context,
  config: Config,
  deps: SupervisorDeps = defaultSupervisorDeps,
): WorkerSupervisor {
  const { worker } = config
  const { backoff } = worker

  /**
   * Um unico AbortController para todo o ciclo de vida: a sua intencao de
   * anulacao e canalizada nativamente para cada `spawn` e serve tambem de
   * marcador para distinguir "morreu sozinho" de "nos matamo-lo".
   */
  const abortController = new AbortController()

  let child: ChildProcess | undefined
  /** Remove os ouvintes que ESTE supervisor pos no filho corrente. */
  let detachChildListeners: (() => void) | undefined
  let restartTimer: TimerHandle | undefined
  let attempts = 0
  let disposed = false
  let started = false
  let exhausted = false

  /** Cancela (e esquece) o temporizador de reinicio pendente, se existir. */
  const clearRestartTimer = (): void => {
    if (restartTimer === undefined) return
    deps.scheduler.clearTimeout(restartTimer)
    restartTimer = undefined
  }

  /**
   * Tree-kill do GRUPO de processos de um filho concreto.
   *
   * O sinal negativo alveja o grupo inteiro -- possivel apenas porque o spawn
   * usou `detached: true` (ver o comentario extenso em `spawnOnce`). Sem guarda
   * por `killed`: ver a divergencia documentada no cabecalho desta funcao.
   */
  const treeKill = (target: ChildProcess): void => {
    const { pid } = target
    if (pid === undefined) return

    if (deps.platform === 'win32') {
      // `process.kill(-pid, ...)` NAO EXISTE no Windows: nao ha grupos de
      // processos POSIX. Nessa plataforma o proprio `ctx.subprocess` executa
      // `taskkill /T /F` internamente (comportamento documentado no pacote
      // `lsp-stdio`), pelo que basta o abort.
      return
    }

    try {
      deps.kill(-pid, 'SIGKILL')
    } catch {
      // ESRCH: o processo (ou o grupo) ja nao existe na tabela. Excecao
      // mitigada de proposito -- o objetivo ja esta cumprido.
    }
  }

  /**
   * Larga o filho corrente: desliga os ouvintes e mata a arvore.
   *
   * PORQUE EXISTE (e nao se limita a `child = spawned`): sobrepor a variavel
   * sem libertar o valor anterior tirava o filho antigo da contabilidade do
   * disposer. Sondado: com dois `start()`, `filhos=2` mas `kills=[[-222,...]]`
   * -- o primeiro filho nunca era morto. Chamada UMA VEZ por instancia (ou na
   * substituicao, ou no disposer), o que mantem o `dispose()` idempotente.
   */
  const releaseCurrentChild = (): void => {
    const current = child
    child = undefined

    detachChildListeners?.()
    detachChildListeners = undefined

    if (current === undefined) return
    treeKill(current)
  }

  const spawnOnce = (): void => {
    if (disposed || abortController.signal.aborted || exhausted) return

    // Substituicao segura: o filho e o temporizador anteriores sao libertados
    // ANTES de existir um novo, para que nunca haja dois fora de contabilidade.
    releaseCurrentChild()
    clearRestartTimer()

    const startedAt = deps.now()

    ctx.logger.info(
      LOG_SCOPE,
      `Alocando subprocesso isolado de longa duracao: ${worker.command} ${worker.args.join(' ')}`,
    )

    const spawned = ctx.subprocess.spawn(worker.command, worker.args, {
      // Isolamento dos canais stdio: o worker nao satura o terminal do DSH e
      // stdin fica fechado (um long-poller nao le do operador).
      stdio: ['ignore', 'pipe', 'pipe'],
      // A intencao de anulacao transita nativamente para o filho.
      signal: abortController.signal,
      cwd: worker.cwd,
      // Ambiente CONSTRUIDO a partir de uma allowlist, nunca herdado inteiro:
      // `process.env` levava `ADMIN_USER`/`ADMIN_PASS` do plano de controlo
      // para dentro do worker. Ver `buildWorkerEnv`.
      env: buildWorkerEnv(process.env, worker.token),
      /**
       * ARMADILHA CRITICA -- `detached: true` NAO E OPCIONAL AQUI.
       *
       * O disposer faz `process.kill(-pid, 'SIGKILL')`, e o `-pid` do POSIX
       * significa "todo o GRUPO de processos cujo id e pid". Isso so e um
       * grupo valido se o filho for LIDER DO SEU PROPRIO GRUPO -- e um filho
       * so se torna lider de grupo com `detached: true` (que invoca `setsid`).
       *
       * Sem esta flag, `-pid` nao corresponde a grupo nenhum, a chamada falha
       * com ESRCH, o `catch` engole silenciosamente o erro e o tree-kill
       * SIMPLESMENTE NAO ACONTECE: os netos do worker (interpretadores,
       * shells, clientes HTTP) sobrevivem a transicao da Fiber como zumbis,
       * consumindo descritores de ficheiro e memoria ate ao fim do processo
       * hospedeiro.
       *
       * NAO chamamos `child.unref()`: continuamos a querer rastrear o filho e
       * a receber o seu `exit`. `detached` cria o grupo, `unref` desligaria a
       * contabilidade -- sao coisas distintas.
       */
      detached: true,
    })

    child = spawned

    /**
     * DESARME POR INSTANCIA. Um mesmo filho pode notificar a sua morte por
     * mais do que um evento: numa FALHA DE SPAWN o Node emite `'error'` e
     * `'close'` mas NUNCA `'exit'`; noutros casos `'error'` e `'exit'` chegam
     * ambos. Esta bandeira garante que o orcamento e consumido -- e o reinicio
     * agendado -- UMA SO VEZ por instancia.
     */
    let settled = false

    const onStdout = (chunk: Buffer): void => {
      ctx.logger.debug(LOG_SCOPE, `[Worker STDOUT]: ${chunk.toString().trim()}`)
    }

    const onStderr = (chunk: Buffer): void => {
      ctx.logger.warn(LOG_SCOPE, `[Worker STDERR]: ${chunk.toString().trim()}`)
    }

    /**
     * Caminho UNICO de terminacao: serve tanto a saida normal (`'exit'`) como
     * a falha de spawn (`'error'`).
     *
     * PORQUE UNIFICADO: antes so se escutava `'exit'`. Com `worker.command`
     * inexistente ou `worker.cwd` inexistente o Node emite
     * `error(ENOENT) -> close(code=-2)` e nunca `'exit'` -- resultado medido:
     * uma linha de log e o worker PERMANENTEMENTE morto, sem reinicio, sem
     * consumir `maxAttempts` e sem qualquer sinal ao operador. Agora a falha de
     * spawn percorre exatamente o mesmo caminho de backoff/orcamento.
     */
    const handleTermination = (description: string): void => {
      if (settled) return
      settled = true

      // Os ouvintes desta instancia deixam de interessar: sem isto, cada
      // reinicio acumulava mais um conjunto de ouvintes vivos sobre objetos
      // que ja ninguem consulta.
      detachChildListeners?.()
      detachChildListeners = undefined

      // Desligamento intencional (disposer ja correu, ou o sinal de abort ja
      // foi emitido): a Fiber esta a ser descartada, NAO se reinicia nada.
      if (disposed || abortController.signal.aborted) {
        ctx.logger.info(LOG_SCOPE, 'Worker terminado a pedido do disposer; sem reinicio.')
        return
      }

      // Uptime saudavel zera o orcamento: uma falha isolada ao fim de horas
      // de servico nao deve consumir o orcamento reservado a crash-loops.
      const uptimeMs = deps.now() - startedAt
      if (uptimeMs >= backoff.resetAfterMs) attempts = 0

      attempts += 1

      if (attempts > backoff.maxAttempts) {
        // Orcamento finito esgotado: cessa-se a recuperacao e entra-se em
        // ESTADO TERMINAL (ver a divergencia #2 no cabecalho da funcao: o
        // auto-desregisto do plugin exigiria API que a superficie tipada desta
        // distribuicao nao possui). Falhar alto e visivelmente e melhor do que
        // reiniciar para sempre em silencio.
        exhausted = true
        ctx.logger.error(
          LOG_SCOPE,
          `Orcamento de reinicios esgotado (${backoff.maxAttempts}). ${description} ` +
            'Recuperacao automatica CESSADA em definitivo (estado terminal): ' +
            'o worker NAO volta a arrancar ate o plugin ser recarregado a mao. ' +
            'Esta distribuicao do Cordis nao expoe auto-desregisto do plugin.',
        )
        return
      }

      const delayMs = computeBackoffDelay(attempts, backoff, deps.random)

      ctx.logger.warn(
        LOG_SCOPE,
        `${description} Reinicio ${attempts}/${backoff.maxAttempts} ` +
          `agendado para daqui a ${delayMs} ms.`,
      )

      // RE-VERIFICACAO IMEDIATAMENTE ANTES DE AGENDAR. `disposed` foi lido no
      // inicio deste tratador, mas entre esse instante e este ha logging (e,
      // num host real, ouvintes de terceiros) que pode desencadear o descarte
      // da Fiber. Sem esta segunda leitura, o disposer ja teria feito o seu
      // `clearTimeout` e mesmo assim ficaria um temporizador vivo a ressuscitar
      // o worker depois de DISPOSED.
      if (disposed || abortController.signal.aborted) return

      /**
       * REAGENDAMENTO FIRE-AND-FORGET -- e AQUI que mora o requisito duro.
       *
       * Este tratador retorna IMEDIATAMENTE. Em nenhum ponto se faz
       * `await sleep(...)` nem se espera pelo restabelecimento do worker
       * dentro de um ouvinte de evento do Cordis.
       *
       * PORQUE: `ctx.parallel` aguarda o retorno EXAUSTIVO de todos os
       * subscritores e `ctx.waterfall` bloqueia a cascata inteira. Reter um
       * retorno a espera da rede congela o subsistema todo e, por arrastamento,
       * interrompe o ciclo de deducao do agente.
       *
       * Ha precedente real e documentado no DSH: o canal de telemetria comecou
       * em Server-Sent Events sobre `events.mux`/`events.host`; como o HTTP/1.1
       * dos navegadores tolera ~6 sessoes concorrentes por origem, os canais
       * eternos esgotavam esse pool e as RPCs utilitarias ficavam retidas
       * indefinidamente na fila do browser. A correcao arquitetonica foi migrar
       * o downlink para um WebSocket dedicado. A licao transposta para aqui:
       * uma operacao de longa duracao NUNCA se hospeda no caminho de espera de
       * outra pessoa.
       *
       * O handle e guardado e o disposer faz `clearTimeout` -- de outro modo,
       * descarregar o plugin deixaria um temporizador pendurado que
       * ressuscitaria o worker depois da Fiber ja estar DISPOSED.
       */
      clearRestartTimer()
      restartTimer = deps.scheduler.setTimeout((): void => {
        restartTimer = undefined
        spawnOnce()
      }, delayMs)
    }

    const onError = (error: Error): void => {
      // Anulacao intencional: com a opcao `signal`, o Node emite `'error'` com
      // um AbortError sempre que o controlador aborta. Registar isso como
      // `logger.error` produzia um erro FALSO em cada desligamento limpo do
      // plugin -- ruido que treina o operador a ignorar erros a serio.
      if (disposed || abortController.signal.aborted) {
        ctx.logger.debug(LOG_SCOPE, `Worker abortado a pedido do disposer: ${error.message}`)
        handleTermination('Anulacao intencional.')
        return
      }

      ctx.logger.error(LOG_SCOPE, `Falha na costura de subprocesso: ${error.message}`)
      handleTermination(`Falha ao alocar o worker: ${error.message}.`)
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      handleTermination(`Worker encerrado (code=${String(code)} signal=${String(signal)}).`)
    }

    detachChildListeners = (): void => {
      spawned.stdout?.removeListener('data', onStdout)
      spawned.stderr?.removeListener('data', onStderr)
      spawned.removeListener('error', onError)
      spawned.removeListener('exit', onExit)

      /**
       * ABSORVEDOR OBRIGATORIO. Um `EventEmitter` que emite `'error'` SEM
       * qualquer ouvinte LANCA a excecao no processo hospedeiro. Como o
       * `abortController.abort()` do disposer faz o Node emitir exatamente um
       * `'error'` (AbortError) no filho, retirar os nossos ouvintes sem deixar
       * ninguem no lugar transformaria um desligamento limpo numa excecao nao
       * capturada que derrubava o DSH inteiro.
       */
      spawned.on('error', (): void => {})
    }

    spawned.stdout?.on('data', onStdout)
    spawned.stderr?.on('data', onStderr)
    spawned.on('error', onError)
    spawned.on('exit', onExit)
  }

  /**
   * Arranque UNICO. `start()` repetido nao instancia um segundo worker: o
   * ciclo de vida deste supervisor tem exatamente um filho vivo de cada vez, e
   * a reentrancia acidental (dois `ctx.effect`, um `start()` manual em cima do
   * arranque do `apply`) deixava o primeiro filho fora de qualquer disposer.
   */
  const start = (): void => {
    if (started) {
      ctx.logger.warn(LOG_SCOPE, 'start() repetido ignorado: o supervisor ja tem um worker.')
      return
    }
    started = true
    spawnOnce()
  }

  const dispose = (): void => {
    // Reentrancia: o Cordis nao repete disposers, mas um `dispose()` manual
    // seguido do descarte da Fiber e cenario plausivel. Tudo o que se segue
    // corre UMA so vez, pelo que chamar o disposer 2x ou 3x nao lanca nem mata
    // duas vezes de forma observavel.
    if (disposed) return
    disposed = true

    ctx.logger.info(LOG_SCOPE, 'Descarregando o plugin; abortando processo filho...')

    // (a) Cancelar o reinicio pendente ANTES de matar, para nao correr o risco
    //     de o temporizador disparar entre o kill e o fim do disposer.
    clearRestartTimer()

    // (b) O sinal de abort transita assincronamente pela arvore do processo e
    //     marca, para o tratador de terminacao, que a saida foi intencional.
    //     NOTA: o Node chama `child.kill()` SINCRONAMENTE aqui dentro.
    abortController.abort()

    // (c) Tree-kill de ultima instancia. `ctx.subprocess` ja implementa
    //     mecanismos internos e o abort de (b) ja entregou um SIGTERM ao
    //     FILHO -- mas so o SIGKILL no GRUPO alcanca os NETOS, que de outro
    //     modo sobrevivem reparentados ao init.
    releaseCurrentChild()
  }

  return {
    start,
    dispose,
    get attempts(): number {
      return attempts
    },
    get exhausted(): boolean {
      return exhausted
    },
  }
}

/* ========================================================================== */
/* 6. VALIDACAO DE ARRANQUE ("fail loud at load")                             */
/* ========================================================================== */

/** Grafias literais que significam "escuta em TODAS as interfaces de rede". */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '*', ''])

/**
 * Decide se um endereco de bind e o curinga "todas as interfaces".
 *
 * PORQUE NAO BASTA UM `Set` DE LITERAIS: o curinga tem muitas grafias
 * equivalentes que o `bind(2)` aceita e que passavam ilesas pela lista fixa --
 * `0` (forma curta do `inet_aton`, que expande para 0.0.0.0), `0.0`, o
 * `0.0.0.0.` com ponto final de nome absoluto, `::0`, `0000:0000:...:0000`,
 * `[::]` com zone id. Falhar em reconhecer qualquer uma delas e abrir a
 * sub-estacao `/api` a rede inteira -- a #853 na integra.
 */
function isWildcardBindHost(host: string): boolean {
  let value = host.trim().toLowerCase()

  // Forma entre parenteses rectos usada em autoridades de URL (`[::]`).
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)

  // Zone id (`::%eth0`) nao faz parte da identidade do endereco.
  const zoneIndex = value.indexOf('%')
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex)

  // Ponto final de nome absoluto (`0.0.0.0.`).
  if (value.endsWith('.')) value = value.slice(0, -1)

  // IPv4 curinga mapeado em IPv6 (`::ffff:0.0.0.0`).
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)

  if (WILDCARD_BIND_HOSTS.has(value)) return true

  // IPv4 so com zeros e pontos: `0`, `0.0`, `0.0.0.0` -- todos sao 0.0.0.0
  // para o `inet_aton`, todos significam "todas as interfaces".
  if (/^[0.]+$/u.test(value)) return true

  // IPv6 so com zeros e dois-pontos: `::`, `::0`, `0:0:...:0`, `0000:...:0000`.
  if (value.includes(':') && /^[0:]+$/u.test(value)) return true

  return false
}

/**
 * Caracteres proibidos no `realm`.
 *
 *   - aspas e barra invertida quebrariam a quoted-string do cabecalho
 *     `WWW-Authenticate`;
 *   - o intervalo U+0000..U+001F mais U+007F cobre CR/LF e restantes controlos
 *     (injecao de cabecalhos);
 *   - tudo acima de U+00FF e recusado porque um cabecalho HTTP/1.1 viaja em
 *     Latin-1. Um `realm` com caracteres fora desse intervalo (um emoji, um
 *     alfabeto nao latino) passava na validacao e so rebentava em tempo de
 *     execucao, DENTRO do `res.writeHead(401, ...)`, com `ERR_INVALID_CHAR`. O
 *     efeito pratico e o pior possivel: em vez do 401 com o desafio, o cliente
 *     recebe uma resposta vazia e o socket fechado -- a barreira continua a
 *     barrar, mas deixa de ser legivel e o operador nao percebe porque. Recusa-se
 *     no arranque, como manda o "fail loud at load".
 *
 * Espacos SAO permitidos -- 'Secure DSH Interface' e um realm legitimo.
 */
const UNSAFE_REALM_PATTERN = /["\\\u0000-\u001f\u007f]|[^\u0000-\u00ff]/u

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[${name}] config.${path} tem de ser uma string nao vazia.`)
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`[${name}] config.${path} tem de ser um array de strings.`)
  }
}

function assertPositiveNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`[${name}] config.${path} tem de ser um numero positivo finito.`)
  }
}

/**
 * Lados de credencial que NUNCA sao aceitaveis.
 *
 * `undefined` e `null` sao exatamente as strings que uma interpolacao
 * descuidada produz a partir de uma variavel de ambiente ausente:
 *
 *     Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`)
 *       -> 'undefined:undefined' -> 'dW5kZWZpbmVkOnVuZGVmaW5lZA=='
 *
 * Isso NAO e uma credencial invalida -- e uma credencial VALIDA, FIXA e
 * derivavel por qualquer pessoa que conheca o padrao.
 */
const PLACEHOLDER_CREDENTIAL_PARTS = new Set(['undefined', 'null', 'nan', 'nil', 'none'])

/**
 * Valida o PAR DESCODIFICADO de `encodedAuthString` (defesa em profundidade).
 *
 * PORQUE AQUI TAMBEM, se o `cordis.patch.yml` ja lanca quando `ADMIN_USER` ou
 * `ADMIN_PASS` faltam: porque o manifesto e apenas UM dos caminhos por onde a
 * configuracao pode chegar. Camadas de precedencia superiores (Home, `--patch`
 * da CLI) e qualquer outro carregador podem entregar este `config` sem passar
 * pelas guardas do YAML. `assertNonEmptyString` aprovava alegremente
 * `dW5kZWZpbmVkOnVuZGVmaW5lZA==` -- uma string nao vazia, e portanto "valida".
 * A unica verificacao que apanha a credencial universal e descodificar e olhar
 * para os dois lados.
 */
function assertUsableCredential(encodedAuthString: string, path: string): void {
  const decoded = Buffer.from(encodedAuthString, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')

  if (separator === -1) {
    throw new Error(
      `[${name}] config.${path} tem de ser base64 de 'utilizador:senha' (RFC 7617). ` +
        'O valor entregue nao descodifica para um par separado por ":".',
    )
  }

  const user = decoded.slice(0, separator).trim()
  const pass = decoded.slice(separator + 1).trim()

  if (user.length === 0 || pass.length === 0) {
    throw new Error(
      `[${name}] config.${path}: o par descodificado tem utilizador ou senha vazios. ` +
        'Ambos os lados de "utilizador:senha" sao obrigatorios.',
    )
  }

  for (const [label, part] of [
    ['utilizador', user],
    ['senha', pass],
  ] as const) {
    if (PLACEHOLDER_CREDENTIAL_PARTS.has(part.toLowerCase())) {
      throw new Error(
        `[${name}] config.${path}: o ${label} descodificado e o literal '${part}'. ` +
          'Isto e a assinatura de uma variavel de ambiente ausente interpolada num ' +
          'template (ADMIN_USER/ADMIN_PASS por definir) e produz uma credencial fixa, ' +
          'publicamente derivavel. Recuso arrancar: define as variaveis e reinicia.',
      )
    }
  }
}

/**
 * Exige que um caminho exista E seja um diretorio.
 *
 * PORQUE E VALIDACAO DE ARRANQUE E NAO "problema do runtime": um `worker.cwd`
 * inexistente faz o `spawn` falhar com ENOENT, e uma falha de spawn NAO emite
 * `'exit'` -- emite `'error'` e `'close'`. Antes da correcao desta onda isso
 * significava um worker permanentemente morto sem qualquer reinicio. Agora a
 * falha de spawn e tratada, mas continua a ser muito melhor recusar a
 * configuracao no arranque, com uma mensagem que nomeia o caminho, do que
 * gastar o orcamento de reinicios a repetir um erro que nunca se resolve
 * sozinho.
 */
function assertExistingDirectory(value: string, path: string): void {
  let isDirectory: boolean
  try {
    isDirectory = statSync(value).isDirectory()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[${name}] config.${path} ('${value}') nao existe ou nao e acessivel: ${reason}. ` +
        'O spawn do worker falharia com ENOENT a cada tentativa.',
    )
  }

  if (!isDirectory) {
    throw new Error(`[${name}] config.${path} ('${value}') existe mas nao e um diretorio.`)
  }
}

/**
 * Valida a configuracao INTEIRA no arranque.
 *
 * Nao ha `?? valor_por_omissao` em lado nenhum: uma chave em falta significa
 * que o `cordis.patch.yml` foi mal escrito (lembrar que a resolucao e
 * *whole-entry replace*: omitir apaga). Preencher em silencio transformaria um
 * erro de configuracao num buraco de seguranca silencioso.
 */
export function assertValidConfig(config: Config): void {
  assertNonEmptyString(config.encodedAuthString, 'encodedAuthString')
  assertUsableCredential(config.encodedAuthString, 'encodedAuthString')
  assertNonEmptyString(config.realm, 'realm')

  // O realm entra literalmente num cabecalho de resposta. Aspas, barras
  // invertidas e caracteres de controlo permitiriam injecao de cabecalhos
  // (CRLF) -- recusa-se no arranque em vez de "higienizar" a cada pedido.
  if (UNSAFE_REALM_PATTERN.test(config.realm)) {
    throw new Error(
      `[${name}] config.realm nao pode conter aspas, barras invertidas nem caracteres de controlo.`,
    )
  }

  assertStringArray(config.allowedHosts, 'allowedHosts')
  if (config.allowedHosts.length === 0) {
    throw new Error(
      `[${name}] config.allowedHosts nao pode estar vazio (nenhum bind seria valido).`,
    )
  }

  // `trustedRemotes` PODE estar vazio: e a politica fail-closed (nega tudo).
  assertStringArray(config.trustedRemotes, 'trustedRemotes')

  assertStringArray(config.guardedPrefixes, 'guardedPrefixes')

  // Um prefixo sem `/` inicial NUNCA casa com um caminho de rota (que comeca
  // sempre por `/`): `'api'` guarda exatamente nada. E o pior tipo de falha --
  // silenciosa e com aparencia de sucesso, porque a SPA continua a pedir senha
  // (o fallback e guardado incondicionalmente) enquanto `/api/commands/execute`
  // responde 200 sem credencial. O administrador ve o prompt e conclui que esta
  // protegido. Recusa-se no arranque.
  for (const [index, prefix] of config.guardedPrefixes.entries()) {
    if (!prefix.startsWith('/')) {
      throw new Error(
        `[${name}] config.guardedPrefixes[${index}] = '${prefix}' tem de comecar por '/'. ` +
          'Um prefixo sem barra inicial nao casa com caminho nenhum e deixa a ' +
          'sub-estacao /api aberta enquanto a SPA continua a pedir senha.',
      )
    }
  }

  assertStringArray(config.deniedPermissions, 'deniedPermissions')

  if (typeof config.worker !== 'object' || config.worker === null) {
    throw new Error(`[${name}] config.worker tem de ser um objeto.`)
  }

  assertNonEmptyString(config.worker.command, 'worker.command')
  assertStringArray(config.worker.args, 'worker.args')
  assertNonEmptyString(config.worker.cwd, 'worker.cwd')
  assertExistingDirectory(config.worker.cwd, 'worker.cwd')
  assertNonEmptyString(config.worker.token, 'worker.token')

  const { backoff } = config.worker
  if (typeof backoff !== 'object' || backoff === null) {
    throw new Error(`[${name}] config.worker.backoff tem de ser um objeto.`)
  }

  assertPositiveNumber(backoff.initialDelayMs, 'worker.backoff.initialDelayMs')
  assertPositiveNumber(backoff.maxDelayMs, 'worker.backoff.maxDelayMs')
  assertPositiveNumber(backoff.maxAttempts, 'worker.backoff.maxAttempts')
  assertPositiveNumber(backoff.resetAfterMs, 'worker.backoff.resetAfterMs')

  if (backoff.maxDelayMs < backoff.initialDelayMs) {
    throw new Error(
      `[${name}] config.worker.backoff.maxDelayMs (${backoff.maxDelayMs}) ` +
        `nao pode ser inferior a initialDelayMs (${backoff.initialDelayMs}).`,
    )
  }
}

/**
 * Valida o BIND do servidor web -- e a primeira linha de defesa contra #853.
 *
 * `0.0.0.0` / `::` expoem a sub-estacao `/api` a rede inteira. A exposicao
 * legitima faz-se sempre por proxy reverso TLS autenticado A FRENTE deste
 * loopback, nunca alargando o bind. Se o host efetivo nao estiver na allowlist,
 * o plugin recusa carregar: prefere-se o DSH nao arrancar a arrancar aberto.
 *
 * NOTA: `allowedHosts` e a allowlist do BIND (a interface onde o servidor
 * escuta) e nao tem qualquer relacao com `trustedRemotes` (a origem de cada
 * requisicao). Sao duas allowlists distintas por desenho.
 */
export function assertSecureBind(host: string, allowedHosts: readonly string[]): void {
  if (isWildcardBindHost(host)) {
    throw new Error(
      `[${name}] Bind inseguro: ctx.webServer.host = '${host}'. ` +
        'Escutar em todas as interfaces expoe a sub-estacao /api sem credenciais ' +
        '(discussao oficial #853). Fixa o bind no loopback e publica por proxy reverso TLS.',
    )
  }

  if (!allowedHosts.includes(host)) {
    throw new Error(
      `[${name}] Bind nao autorizado: ctx.webServer.host = '${host}' ` +
        `nao consta de config.allowedHosts (${allowedHosts.join(', ')}).`,
    )
  }
}

/* ========================================================================== */
/* 7. CAMADA HTTP GUARDADA                                                    */
/* ========================================================================== */

/**
 * Responde 403 a uma origem nao confiada.
 *
 * 403 e NAO 401 de proposito: 401 convida o cliente a repetir com credencial,
 * e repetir a credencial NAO ajuda quando o problema e a origem do socket.
 * Devolver 401 aqui daria ao atacante um oraculo para adivinhar credenciais a
 * partir de uma origem que nunca sera aceite.
 *
 * Escrita direta no socket bruto da resposta (`ServerResponse`), sem qualquer
 * camada tipo Express -- o DSH usa `node:http` cru.
 */
function denyUntrustedOrigin(res: ServerResponse): void {
  res.writeHead(403, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end('Acesso Intercetado: origem nao confiada.\n')
}

/** Emite o desafio 401 com `WWW-Authenticate: Basic realm="..."`. */
function challengeBasicAuth(res: ServerResponse, realm: string): void {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end('Acesso Intercetado: Credenciais invalidas.\n')
}

/**
 * Constroi o handler guardado que envolve um handler original.
 *
 * DECISAO DELIBERADA -- NAO SE CONSOME O CORPO DA REQUISICAO.
 * A decisao de autorizacao usa exclusivamente metodo, URL, cabecalhos e
 * endereco do socket. Ler o corpo para inspecionar o payload RPC obrigaria a
 * consumir o stream; se depois o pedido fosse recusado, a leitura ficaria a
 * meio e o servidor web do DSH fecharia o socket registando um HTTP 400 --
 * transformando um "401 legivel" num erro opaco. Alem disso, o corpo ja
 * consumido nunca chegaria ao handler original nos pedidos aprovados.
 */
function createGuardedHandler(
  ctx: Context,
  config: Config,
  originalHandler: WebRoute['handler'],
  target: WebServer,
  surface: string,
  /**
   * `true` -> a superficie e guardada INTEIRA, decidido no registo (o fallback
   * e qualquer rota DENTRO de um prefixo guardado). Nenhuma inspeccao do
   * `req.url` pode desactivar a barreira: e este o comportamento que ja hoje
   * barra `//api`, `/API` e afins, e nao pode regredir.
   *
   * `false` -> a rota foi embrulhada por ser ANCESTRAL de um prefixo guardado
   * (um `prefix` em `/`, tipicamente). Ai a barreira aplica-se por PEDIDO, e
   * so aos pedidos cujo caminho real cai sob um prefixo guardado -- caso
   * contrario a rota deixaria de servir a superficie nao guardada que o
   * administrador nao pediu para guardar.
   */
  alwaysGuarded: boolean,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // ---- (0) Esta rota, NESTE pedido, esta sob guarda? --------------------
    // Defesa em profundidade sobre o `req.url` REAL e normalizado
    // (percent-decoding, `//`, `\`, `.`/`..`, caixa): o caminho registado diz
    // o que a rota PODE servir, mas so o pedido diz o que esta a servir agora.
    if (!alwaysGuarded && !isGuardedPath(req.url, config.guardedPrefixes)) {
      await originalHandler.call(target, req, res)
      return
    }

    // ---- (a) Perimetro de rede: quem esta do outro lado do socket? --------
    if (!isTrustedRemote(req.socket.remoteAddress, config.trustedRemotes)) {
      ctx.logger.warn(
        LOG_SCOPE,
        `[${surface}] Origem nao confiada recusada: ` +
          `${String(req.socket.remoteAddress)} -> ${String(req.method)} ${String(req.url)}`,
      )
      denyUntrustedOrigin(res)
      return
    }

    // ---- (b) Barreira de autenticacao, avaliada em cascata ---------------
    // O `next` terminal repete a verificacao da credencial: assim a politica
    // permanece FAIL-CLOSED mesmo que nenhum ouvinte esteja registado (por
    // exemplo, se outra Fiber tiver removido o nosso).
    const isAuthorized = await ctx.waterfall(
      'http/auth-check',
      req,
      async (): Promise<boolean> =>
        verifyBasicAuth(req.headers.authorization, config.encodedAuthString),
    )

    if (!isAuthorized) {
      ctx.logger.warn(
        LOG_SCOPE,
        `[${surface}] 401 em ${String(req.method)} ${String(req.url)} ` +
          '(credencial ausente ou invalida).',
      )
      challengeBasicAuth(res, config.realm)
      return
    }

    // ---- (c) Aprovado: o controlo transita para o handler original -------
    await originalHandler.call(target, req, res)
  }
}

/**
 * Escreve uma resposta HTTP CRUA num socket de upgrade e destroi-o.
 *
 * Num tratador de `Connection: Upgrade` nao existe `ServerResponse`: o socket
 * ja foi destacado do ciclo pedido/resposta pelo `node:http` e quem responde
 * escreve os bytes do handshake a mao. Por isso a mensagem de estado, os
 * cabecalhos e a linha em branco final sao construidos aqui, com CRLF
 * explicito, como manda o RFC 7230.
 *
 * O `socket.destroy()` e obrigatorio: sem ele o cliente fica com uma ligacao
 * meio-aberta a espera do 101 que nunca vem.
 */
function denyUpgrade(socket: Duplex, status: 401 | 403, realm: string): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'

  const headers = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Length: 0',
  ]

  if (status === 401) {
    headers.push(`WWW-Authenticate: Basic realm="${realm}", charset="UTF-8"`)
  }

  try {
    socket.write(`${headers.join('\r\n')}\r\n\r\n`)
  } catch {
    // Socket ja fechado pelo par: nao ha nada a recuperar, e destruir a seguir
    // continua a ser correto.
  }

  socket.destroy()
}

/**
 * Constroi o tratador de upgrade guardado (handshake de WebSocket).
 *
 * PORQUE ESTA SUPERFICIE TAMBEM PRECISA DE PORTAO -- e porque e guardada
 * INTEIRA, sem olhar a `guardedPrefixes`: os WebSockets NAO estao sujeitos a
 * same-origin policy. Qualquer pagina aberta no navegador da maquina pode
 * abrir `ws://127.0.0.1:3080/...` para outra origem sem qualquer permissao
 * (nao ha preflight, nao ha CORS). E o doc-fonte do DSH regista que o canal de
 * downlink foi migrado de SSE para um WebSocket dedicado -- ou seja, o canal e
 * relevante e transporta estado do plano de controlo. Deixa-lo fora do portao
 * seria reabrir a #853 por outra porta.
 *
 * A decisao e a mesma do caminho HTTP (origem -> credencial) e usa exatamente
 * as mesmas primitivas; so a forma de RECUSAR e diferente, porque aqui nao ha
 * `ServerResponse`.
 */
function createGuardedUpgradeHandler(
  ctx: Context,
  config: Config,
  originalHandler: WebUpgradeHandler,
  target: WebServer,
  surface: string,
): WebUpgradeHandler {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // A assinatura nativa de `'upgrade'` e SINCRONA (`=> void`), mas a cascata
    // `http/auth-check` e assincrona. Encapsula-se numa IIFE assincrona cujo
    // resultado e explicitamente descartado: ninguem espera por este tratador.
    void (async (): Promise<void> => {
      try {
        if (!isTrustedRemote(req.socket.remoteAddress, config.trustedRemotes)) {
          ctx.logger.warn(
            LOG_SCOPE,
            `[${surface}] Upgrade recusado (origem nao confiada): ` +
              `${String(req.socket.remoteAddress)} -> ${String(req.url)}`,
          )
          denyUpgrade(socket, 403, config.realm)
          return
        }

        const isAuthorized = await ctx.waterfall(
          'http/auth-check',
          req,
          async (): Promise<boolean> =>
            verifyBasicAuth(req.headers.authorization, config.encodedAuthString),
        )

        if (!isAuthorized) {
          ctx.logger.warn(
            LOG_SCOPE,
            `[${surface}] Upgrade recusado (credencial ausente ou invalida) em ` +
              `${String(req.url)}.`,
          )
          denyUpgrade(socket, 401, config.realm)
          return
        }

        originalHandler.call(target, req, socket, head)
      } catch (error) {
        // Um erro no caminho de decisao NAO pode resultar em handshake
        // aprovado: fecha-se o socket (fail-closed).
        ctx.logger.error(
          LOG_SCOPE,
          `[${surface}] Erro ao avaliar o upgrade; socket destruido: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
        socket.destroy()
      }
    })()
  }
}

/* ========================================================================== */
/* 8. PONTO DE ENTRADA DO PLUGIN                                              */
/* ========================================================================== */

/**
 * Ativa o plugin na Fiber corrente.
 *
 * Ordem deliberada:
 *   1. validar (fail loud at load);
 *   2. instalar o ouvinte de veto de permissoes;
 *   3. instalar o ouvinte de autenticacao (around-middleware);
 *   4. intercetar `webServer` (fallback + rotas guardadas + upgrades);
 *   5. alocar o worker sob `ctx.effect`.
 *
 * O passo 5 e o ultimo porque os disposers correm em LIFO: o worker e o
 * primeiro a ser erradicado quando a Fiber transita para DISPOSED, antes de as
 * barreiras HTTP serem levantadas.
 */
export function apply(ctx: Context, config: Config): void {
  /* --- 1. Validacao ruidosa no arranque -------------------------------- */
  assertValidConfig(config)
  assertSecureBind(ctx.webServer.host, config.allowedHosts)

  if (config.trustedRemotes.length === 0) {
    // Nao e erro: e a politica fail-closed a funcionar. Mas e ruidoso de
    // proposito, porque nesta configuracao o plano de controlo fica inacessivel
    // a TODA a gente, e isso tem de ser uma escolha consciente.
    ctx.logger.warn(
      LOG_SCOPE,
      'config.trustedRemotes esta vazio: politica fail-closed ativa, ' +
        'TODAS as origens serao recusadas com 403. ' +
        'Acrescenta 127.0.0.1 para permitir o loopback.',
    )
  }

  if (config.guardedPrefixes.length === 0) {
    // O simetrico do aviso acima, mas na direcao PERIGOSA: lista vazia aqui
    // nao fecha nada -- abre tudo. Nenhuma rota registada e embrulhada, logo
    // `/api/commands/execute` responde sem credencial. E o pior modo de falha
    // possivel porque PARECE seguro: o fallback continua a ser guardado
    // incondicionalmente, portanto a SPA continua a pedir senha e o
    // administrador conclui que a barreira esta de pe.
    ctx.logger.warn(
      LOG_SCOPE,
      'config.guardedPrefixes esta VAZIO: nenhuma rota registada sera guardada. ' +
        'A sub-estacao /api responde SEM credencial (discussao #853) enquanto a ' +
        'SPA continua a pedir senha pelo fallback -- a barreira parece ativa e nao esta. ' +
        "Declara pelo menos '/api'.",
    )
  }

  if (config.deniedPermissions.length === 0) {
    // Mesma classe de armadilha: lista vazia = nenhuma elevacao e vetada, em
    // silencio. Ruidoso de proposito, tal como para `trustedRemotes`.
    ctx.logger.warn(
      LOG_SCOPE,
      'config.deniedPermissions esta VAZIO: NENHUMA elevacao de permissao sera vetada, ' +
        "incluindo 'danger-full-access' (#853 -> #1769).",
    )
  }

  /**
   * AVISO DE ORDEM DE CARREGAMENTO -- LIMITACAO ESTRUTURAL, DECLARADA EM VOZ ALTA.
   *
   * `ctx.intercept` so envolve os registos feitos DEPOIS deste `apply()`. Se o
   * pacote que regista `/api` (ou o `dsh-host-frontend-static`, que monta o
   * fallback da SPA) correr ANTES deste plugin, esses registos NAO passam pelo
   * portao e respondem sem credencial. Cenario plausivel, nao teorico: `/api` e
   * a SPA vem da Camada 1 (Bundle) e este plugin da Camada 2 (Profile).
   * Reproduzido em laboratorio: com o registo antes do `apply`, um POST sem
   * credencial para `/api/commands/execute` devolveu 200 e a RPC executou.
   *
   * PORQUE E SO UM AVISO E NAO UMA ASSERCAO: a superficie tipada de `WebServer`
   * (`types/dsh-host-webserver/index.d.ts`) expoe `host`, `port`, `register`,
   * `registerFallback` e `registerUpgrade` -- e NADA que permita enumerar as
   * rotas ja registadas. Nao ha, nesta distribuicao, forma de DETECTAR a ordem
   * errada, e inventar API que os `.d.ts` nao declaram seria pior do que ser
   * honesto. Como garantir a ordem: ver README.md ("Ordem de carregamento") e o
   * cabecalho de `cordis.patch.yml`.
   */
  ctx.logger.warn(
    LOG_SCOPE,
    'REQUISITO DE ORDEM DE CARREGAMENTO: este plugin so guarda registos feitos ' +
      'DEPOIS do seu apply(). Confirma que a entrada deste plugin e resolvida ANTES ' +
      'das entradas que registam /api e o fallback da SPA; caso contrario essas ' +
      'superficies respondem SEM credencial e nao ha como o plugin detetar isso ' +
      '(a superficie tipada do webServer nao permite enumerar rotas registadas).',
  )

  ctx.logger.info(
    LOG_SCOPE,
    `Portao ativo em ${ctx.webServer.host}:${ctx.webServer.port} ` +
      `(prefixos guardados: ${config.guardedPrefixes.join(', ') || 'nenhum'}).`,
  )

  /* --- 2. Veto de elevacao de permissao -------------------------------- */
  /**
   * Ouvinte em cascata que IGNORA (veta) pedidos de elevacao para permissoes
   * irrestritas. Devolver `false` SEM invocar `next()` instaura o
   * curto-circuito irreversivel descrito na primer do Cordis.
   *
   * -------------------------------------------------------------------------
   * CORRECAO DE UM CLAIM FALSO QUE ESTAVA AQUI. Este comentario afirmava ser
   * "o travao final da #853 -> #1769". NAO E, e a diferenca importa:
   *
   *   - `security/permission-elevate` e um evento DECLARADO POR ESTE PLUGIN
   *     (a augmentation de `Events` no topo do ficheiro). Nenhum componente
   *     DOCUMENTADO do DSH o emite: uma busca pelos markdowns-fonte devolve
   *     zero ocorrencias, e os unicos emissores existentes sao os testes deste
   *     repositorio;
   *   - o comando perigoso viaja no CORPO do POST para `/api/commands/execute`,
   *     e o portao HTTP deliberadamente NAO le o corpo (ver
   *     `createGuardedHandler`). Logo este ouvinte nunca chega a ver o comando
   *     de um pedido real.
   *
   * O que fecha de facto a #853 e o PORTAO DE AUTENTICACAO + ALLOWLIST DE
   * ORIGEM sobre `/api`, o fallback e os upgrades, mais o bind de loopback.
   * Este ouvinte e um HOOK DE DEFESA EM PROFUNDIDADE: fica no lugar, com o
   * tokenizador endurecido, para o dia em que o DSH (ou outro plugin) passe a
   * emitir o evento. Nao e o travao principal e nao deve ser contabilizado
   * como tal em nenhuma auditoria.
   * -------------------------------------------------------------------------
   *
   * O ouvinte resolve-se imediatamente (nao ha `await` de rede): devolve sem
   * congelar a cascata nem os `ctx.parallel` vizinhos.
   *
   * `ctx.on` devolve o disposer nativo; encaminha-lo por `ctx.effect`
   * inscreve-o na contabilidade LIFO da Fiber -- a subscricao desaparece com
   * o plugin.
   */
  ctx.effect(
    (): Disposer =>
      ctx.on('security/permission-elevate', async (command, next): Promise<boolean> => {
        const denied = requestsDeniedPermission(command, config.deniedPermissions)

        if (denied !== undefined) {
          ctx.logger.error(
            LOG_SCOPE,
            `VETO de elevacao de permissao: o comando pediu '${denied}', ` +
              `que consta de config.deniedPermissions. Comando recusado: ${command}`,
          )
          return false // curto-circuito: `next()` NAO e invocado.
        }

        return next()
      }),
  )

  /* --- 3. Ouvinte de autenticacao (around-middleware) ------------------ */
  /**
   * Faz a verificacao da credencial em Basic Auth. Em caso de falha devolve
   * `false` sem invocar `next()`, vetando a cascata; em caso de sucesso delega
   * em `next()`, deixando outros plugins acrescentarem politicas adicionais
   * (2FA, mTLS, lista de sessoes) por cima desta.
   *
   * PROPRIEDADE DA CASCATA A CONHECER (semantica do Cordis, nao bug deste
   * plugin): num `waterfall` ganha o PRIMEIRO ouvinte que responde sem invocar
   * `next()`. Um `http/auth-check` registado por OUTRO plugin ANTES deste pode
   * portanto devolver `true` e anular esta barreira sem que ela sequer corra.
   * A mitigacao possivel ja esta em `createGuardedHandler`: o `next` TERMINAL
   * repete a verificacao da credencial, o que mantem a politica fail-closed
   * quando nao ha ouvintes -- mas nao ha, nesta superficie tipada, forma de
   * impedir que um ouvinte anterior aprove. Auditar os plugins que subscrevem
   * `http/auth-check` faz parte da instalacao segura (ver README.md).
   */
  ctx.effect(
    (): Disposer =>
      ctx.on('http/auth-check', async (req, next): Promise<boolean> => {
        if (!verifyBasicAuth(req.headers.authorization, config.encodedAuthString)) {
          return false // veto: sem `next()`.
        }
        return next()
      }),
  )

  /* --- 4. Interceao do servico `webServer` ----------------------------- */
  /**
   * `ctx.intercept` deriva um contexto cujo servico `webServer` tem os metodos
   * abaixo sobrepostos. A derivacao e reversivel: quando esta Fiber e
   * descartada, o servico volta atras sozinho, sem *monkey patching* residual.
   *
   * Intercetam-se DOIS metodos, e ambos sao necessarios:
   *
   *   - `registerFallback` -> protege a Web UI. Toda a interface visual do DSH
   *     assenta no fallback (o `dsh-host-frontend-static` monta ali o SPA
   *     routing), pelo que envolver o fallback protege a interface inteira.
   *
   *   - `register` -> protege a sub-estacao `/api`. As rotas `exact` e `prefix`
   *     tem prioridade sobre o fallback e NUNCA passam por ele. Intercetar so
   *     o fallback deixaria a #853 completamente aberta: as mais de 60 RPCs de
   *     `/api`, incluindo `commands/execute`, continuariam a responder sem
   *     credencial nenhuma.
   *
   *   - `registerUpgrade` -> protege o handshake de WebSocket. E o terceiro
   *     metodo, e nao um extra: os WebSockets nao estao sujeitos a same-origin
   *     policy, pelo que qualquer pagina aberta no navegador da maquina pode
   *     abrir `ws://127.0.0.1:3080/...` sem credencial. Ver
   *     `createGuardedUpgradeHandler` para a mecanica da recusa em socket cru.
   */
  ctx.intercept('webServer', {
    registerFallback(this: WebServer, originalHandler: WebRoute['handler']): Disposer {
      const target = this
      const secureHandler = createGuardedHandler(
        ctx,
        config,
        originalHandler,
        target,
        'fallback',
        // O fallback serve a SPA inteira e e o ultimo recurso do encaminhador:
        // guarda-se por completo, sem depender do caminho pedido.
        true,
      )

      // Devolve-se o disposer nativo produzido pelo registo original: e a
      // ancora da reversibilidade atomica. Engoli-lo tornaria a barreira
      // impossivel de desmontar.
      return target.registerFallback(secureHandler)
    },

    register(this: WebServer, route: RouteRegistration): Disposer {
      const target = this

      // Rotas que nao podem servir superficie guardada seguem intactas: o
      // plugin e um portao, nao um proxy universal.
      if (!routeMayServeGuardedPath(route, config.guardedPrefixes)) {
        return target.register(route)
      }

      // Uma rota DENTRO de um prefixo guardado e guardada em todos os pedidos.
      // Uma rota ACIMA (ancestral, so possivel com `kind: 'prefix'`) e
      // embrulhada na mesma, mas decide pedido a pedido -- ver o parametro
      // `alwaysGuarded` de `createGuardedHandler`.
      const alwaysGuarded = isGuardedPath(route.path, config.guardedPrefixes)

      ctx.logger.info(
        LOG_SCOPE,
        `Rota guardada: kind=${route.kind} path=${route.path} ` +
          `(Basic Auth + allowlist de origem; ` +
          `${alwaysGuarded ? 'superficie inteira' : 'ancestral: decidido por pedido'}).`,
      )

      const secureHandler = createGuardedHandler(
        ctx,
        config,
        route.handler,
        target,
        `${route.kind}:${route.path}`,
        alwaysGuarded,
      )

      return target.register({ ...route, handler: secureHandler })
    },

    registerUpgrade(this: WebServer, route: UpgradeRegistration): Disposer {
      const target = this

      // Sem filtro por `guardedPrefixes`: TODO o handshake de upgrade e
      // guardado (justificacao completa em `createGuardedUpgradeHandler`).
      ctx.logger.info(
        LOG_SCOPE,
        `Upgrade guardado: path=${route.path} (Basic Auth + allowlist de origem).`,
      )

      const secureHandler = createGuardedUpgradeHandler(
        ctx,
        config,
        route.handler,
        target,
        `upgrade:${route.path}`,
      )

      return target.registerUpgrade({ ...route, handler: secureHandler })
    },
  })

  /* --- 5. Worker de long-polling sob ciclo de vida atomico ------------- */
  /**
   * Toda a instanciacao do processo do bot vive dentro de `ctx.effect()`.
   *
   * A funcao produtora devolve um disposer SINCRONO (`() => void`). Nunca
   * `async`, nunca devolvendo `Promise`: o motor precisa de executar os
   * disposers em ordem estritamente inversa a instanciacao sem intercalar
   * microtasks, e uma promessa quebraria essa garantia LIFO -- a nova Fiber
   * PENDING poderia arrancar um segundo worker antes de o primeiro ter morrido.
   */
  ctx.effect((): Disposer => {
    const supervisor = createWorkerSupervisor(ctx, config)
    supervisor.start()
    return supervisor.dispose
  })
}
