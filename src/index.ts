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
 *      veto de elevacoes para `danger-full-access`.
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

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Disposer } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
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
 */
export function verifyBasicAuth(
  authorizationHeader: string | undefined,
  encodedAuthString: string,
): boolean {
  if (typeof authorizationHeader !== 'string') return false

  const prefix = 'Basic '
  // O esquema em si nao e segredo: compara-lo em tempo variavel nao vaza nada.
  if (!authorizationHeader.startsWith(prefix)) return false

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
 * Decide se um caminho cai sob um dos prefixos guardados.
 *
 * A fronteira e feita ao SEGMENTO e nao ao caractere: `/api` guarda `/api` e
 * `/api/commands/execute`, mas NAO guarda `/apinfo` -- que e um recurso
 * distinto e cuja captura acidental produziria 401 em rotas legitimas.
 */
export function isGuardedPath(
  rawUrl: string | undefined,
  guardedPrefixes: readonly string[],
): boolean {
  const pathname = extractPathname(rawUrl)

  return guardedPrefixes.some((rawPrefix) => {
    const prefix = rawPrefix.endsWith('/') ? rawPrefix.slice(0, -1) : rawPrefix
    if (prefix.length === 0) return true // prefixo `/` guarda o servidor inteiro
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}

/**
 * Deteta se um comando pede uma permissao recusada.
 *
 * A analise e por TOKEN e nao por `includes()` de substring: `includes` daria
 * falso positivo em `danger-full-access-audit` e falso negativo perante
 * espacamento diferente. Devolve a permissao encontrada (para o registo de
 * auditoria) ou `undefined`.
 */
export function requestsDeniedPermission(
  command: string,
  deniedPermissions: readonly string[],
): string | undefined {
  const tokens = new Set(
    command
      .toLowerCase()
      .split(/[^a-z0-9._-]+/u)
      .filter((token) => token.length > 0),
  )

  for (const permission of deniedPermissions) {
    const needle = permission.trim().toLowerCase()
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
 * JITTER ("equal jitter"): metade do atraso e deterministica e a outra metade
 * e aleatoria. Sem jitter, N instancias do DSH que percam o mesmo servico
 * remoto voltam TODAS no mesmo milissegundo (*thundering herd*), reconstruindo
 * a sobrecarga que o backoff pretendia dissipar. Com `random()` a devolver 1 a
 * sequencia degenera exatamente na progressao nominal, o que torna a funcao
 * verificavel de forma determinista nos testes.
 */
export function computeBackoffDelay(
  attempt: number,
  backoff: BackoffConfig,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  const base = Math.min(backoff.initialDelayMs * 2 ** exponent, backoff.maxDelayMs)
  const half = base / 2

  return Math.round(half + random() * half)
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
/* 4. SUPERVISOR DO WORKER DE LONG-POLLING                                    */
/* ========================================================================== */

/** Superficie publica do supervisor. `dispose` e SINCRONO por contrato. */
export interface WorkerSupervisor {
  /** Arranca o worker imediatamente (primeira instanciacao). */
  start(): void
  /** Disposer SINCRONO: cancela reinicio, aborta e faz tree-kill. */
  dispose(): void
  /** Numero de reinicios ja consumidos do orcamento (observabilidade/testes). */
  readonly attempts: number
}

/**
 * Cria o supervisor do processo filho.
 *
 * REQUISITO DURO DE CONCORRENCIA (ver `apply` para o contexto completo):
 * nenhuma funcao aqui faz `await` de uma operacao dependente da rede ou do
 * reinicio. O tratador de `exit` e SINCRONO e o reagendamento e
 * *fire-and-forget* via `setTimeout`.
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
  let restartTimer: TimerHandle | undefined
  let attempts = 0
  let disposed = false

  const spawnOnce = (): void => {
    if (disposed || abortController.signal.aborted) return

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
      // O segredo entra por ambiente, nunca por argv (argv e legivel por
      // qualquer processo local atraves de /proc/<pid>/cmdline).
      env: { ...process.env, TELEGRAM_BOT_TOKEN: worker.token },
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

    spawned.stdout?.on('data', (chunk: Buffer): void => {
      ctx.logger.debug(LOG_SCOPE, `[Worker STDOUT]: ${chunk.toString().trim()}`)
    })

    spawned.stderr?.on('data', (chunk: Buffer): void => {
      ctx.logger.warn(LOG_SCOPE, `[Worker STDERR]: ${chunk.toString().trim()}`)
    })

    spawned.on('error', (error: Error): void => {
      ctx.logger.error(LOG_SCOPE, `Falha na costura de subprocesso: ${error.message}`)
    })

    spawned.on('exit', (code: number | null, signal: NodeJS.Signals | null): void => {
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
        // Orcamento finito esgotado: cessa-se a recuperacao. Falhar alto e
        // visivelmente e melhor do que reiniciar para sempre em silencio.
        ctx.logger.error(
          LOG_SCOPE,
          `Orcamento de reinicios esgotado (${backoff.maxAttempts}). ` +
            `Ultima saida: code=${String(code)} signal=${String(signal)}. ` +
            'Recuperacao automatica CESSADA ate recarregamento manual.',
        )
        return
      }

      const delayMs = computeBackoffDelay(attempts, backoff, deps.random)

      ctx.logger.warn(
        LOG_SCOPE,
        `Worker encerrado (code=${String(code)} signal=${String(signal)}). ` +
          `Reinicio ${attempts}/${backoff.maxAttempts} agendado para daqui a ${delayMs} ms.`,
      )

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
      restartTimer = deps.scheduler.setTimeout((): void => {
        restartTimer = undefined
        spawnOnce()
      }, delayMs)
    })
  }

  const dispose = (): void => {
    // Reentrancia: o Cordis nao repete disposers, mas um `dispose()` manual
    // seguido do descarte da Fiber e cenario plausivel.
    if (disposed) return
    disposed = true

    ctx.logger.info(LOG_SCOPE, 'Descarregando o plugin; abortando processo filho...')

    // (a) Cancelar o reinicio pendente ANTES de matar, para nao correr o risco
    //     de o temporizador disparar entre o kill e o fim do disposer.
    if (restartTimer !== undefined) {
      deps.scheduler.clearTimeout(restartTimer)
      restartTimer = undefined
    }

    // (b) O sinal de abort transita assincronamente pela arvore do processo e
    //     marca, para o tratador de `exit`, que a saida foi intencional.
    abortController.abort()

    // (c) Tree-kill de ultima instancia. `ctx.subprocess` ja implementa
    //     mecanismos internos, mas o SIGKILL explicito garante que um filho
    //     que ignore o abort nao gere bloqueios eternos.
    const current = child
    child = undefined

    if (current === undefined || current.killed) return

    const { pid } = current
    if (pid === undefined) return

    if (deps.platform === 'win32') {
      // `process.kill(-pid, ...)` NAO EXISTE no Windows: nao ha grupos de
      // processos POSIX. Nessa plataforma o proprio `ctx.subprocess` executa
      // `taskkill /T /F` internamente (comportamento documentado no pacote
      // `lsp-stdio`), pelo que basta o abort acima.
      return
    }

    try {
      // O sinal negativo alveja o GRUPO inteiro -- possivel apenas porque o
      // spawn usou `detached: true` (ver comentario extenso acima).
      deps.kill(-pid, 'SIGKILL')
    } catch {
      // ESRCH: o processo (ou o grupo) ja nao existe na tabela. Excecao
      // mitigada de proposito -- o objetivo do disposer ja esta cumprido.
    }
  }

  return {
    start: spawnOnce,
    dispose,
    get attempts(): number {
      return attempts
    },
  }
}

/* ========================================================================== */
/* 5. VALIDACAO DE ARRANQUE ("fail loud at load")                             */
/* ========================================================================== */

/** Interfaces que significam "escuta em TODAS as interfaces de rede". */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', ''])

/**
 * Caracteres proibidos no `realm`: aspas e barra invertida quebrariam a
 * quoted-string do cabecalho `WWW-Authenticate`; o intervalo U+0000..U+001F
 * mais U+007F cobre CR/LF e restantes controlos (injecao de cabecalhos).
 * Espacos SAO permitidos -- 'Secure DSH Interface' e um realm legitimo.
 */
const UNSAFE_REALM_PATTERN = /["\\\u0000-\u001f\u007f]/u

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
 * Valida a configuracao INTEIRA no arranque.
 *
 * Nao ha `?? valor_por_omissao` em lado nenhum: uma chave em falta significa
 * que o `cordis.patch.yml` foi mal escrito (lembrar que a resolucao e
 * *whole-entry replace*: omitir apaga). Preencher em silencio transformaria um
 * erro de configuracao num buraco de seguranca silencioso.
 */
export function assertValidConfig(config: Config): void {
  assertNonEmptyString(config.encodedAuthString, 'encodedAuthString')
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
  assertStringArray(config.deniedPermissions, 'deniedPermissions')

  if (typeof config.worker !== 'object' || config.worker === null) {
    throw new Error(`[${name}] config.worker tem de ser um objeto.`)
  }

  assertNonEmptyString(config.worker.command, 'worker.command')
  assertStringArray(config.worker.args, 'worker.args')
  assertNonEmptyString(config.worker.cwd, 'worker.cwd')
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
  const normalized = host.trim().toLowerCase()

  if (WILDCARD_BIND_HOSTS.has(normalized)) {
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
/* 6. CAMADA HTTP GUARDADA                                                    */
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
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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

/* ========================================================================== */
/* 7. PONTO DE ENTRADA DO PLUGIN                                              */
/* ========================================================================== */

/**
 * Ativa o plugin na Fiber corrente.
 *
 * Ordem deliberada:
 *   1. validar (fail loud at load);
 *   2. instalar o ouvinte de veto de permissoes;
 *   3. instalar o ouvinte de autenticacao (around-middleware);
 *   4. intercetar `webServer` (fallback + rotas guardadas);
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
   * E este o travao final da #853 -> #1769: mesmo que um pedido chegue
   * autenticado, `commands/execute` nao consegue injetar
   * `/permission danger-full-access` e derrubar o confinamento
   * `workspace-write` do Sandbox.
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
   * NOTA DE AMBITO: `registerUpgrade` (WebSocket) nao e intercetado nesta
   * versao. O seu handler recebe o socket ja em negociacao de protocolo e nao
   * um `ServerResponse` onde se possa escrever um 401 legivel; o canal
   * WebSocket deve ser autenticado no proprio handshake pelo pacote que o
   * publica.
   */
  ctx.intercept('webServer', {
    registerFallback(this: WebServer, originalHandler: WebRoute['handler']): Disposer {
      const target = this
      const secureHandler = createGuardedHandler(ctx, config, originalHandler, target, 'fallback')

      // Devolve-se o disposer nativo produzido pelo registo original: e a
      // ancora da reversibilidade atomica. Engoli-lo tornaria a barreira
      // impossivel de desmontar.
      return target.registerFallback(secureHandler)
    },

    register(this: WebServer, route: RouteRegistration): Disposer {
      const target = this

      // Rotas fora dos prefixos guardados seguem intactas: o plugin e um
      // portao, nao um proxy universal.
      if (!isGuardedPath(route.path, config.guardedPrefixes)) {
        return target.register(route)
      }

      ctx.logger.info(
        LOG_SCOPE,
        `Rota guardada: kind=${route.kind} path=${route.path} ` +
          '(Basic Auth + allowlist de origem).',
      )

      const secureHandler = createGuardedHandler(
        ctx,
        config,
        route.handler,
        target,
        `${route.kind}:${route.path}`,
      )

      return target.register({ ...route, handler: secureHandler })
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
