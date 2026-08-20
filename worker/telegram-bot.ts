/**
 * ENTRYPOINT do processo do bot. Long polling com grammY.
 *
 * ===========================================================================
 * COMO ESTE FICHEIRO E LANCADO — E PORQUE E `.js` E NAO `.ts`
 * ===========================================================================
 * O worker vive em `worker/`, NO MESMO PACOTE npm: nao ha monorepo e nao ha
 * binario publicado a parte. O `tsconfig.build.json` compila `src/` e o
 * `tsconfig.worker.json` compila `worker/` para `dist/worker/`, e o `argv` do
 * spawn resolve `dist/worker/telegram-bot.js` RELATIVO A `import.meta.url` —
 * nunca por `cwd`. O `cwd` de um plugin carregado por um host e o do HOST, e
 * nao o do pacote; resolver por `cwd` funciona na maquina de quem escreveu e
 * falha em toda a gente.
 *
 * Spawnar o `.ts` de dentro de `node_modules` E IMPOSSIVEL: o Node recusa type
 * stripping ali (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Dai compilar-se.
 *
 * ===========================================================================
 * S2 — `stdout` E EXCLUSIVAMENTE JSONL
 * ===========================================================================
 * Nada neste ficheiro escreve em `stdout`. Todo o log humano vai para `stderr`
 * atraves de `./lib/log.ts`. O lado JSONL do canal e de T4.3 (`worker/ipc.ts`):
 * a costura entra pelo gancho {@link WorkerRuntime.configure}, e nao por um
 * `import` que esta sub-tarefa nao pode fazer sem colidir com a de outrem.
 *
 * ===========================================================================
 * A DEPENDENCIA
 * ===========================================================================
 * `grammy` e a UNICA dependencia de runtime deste pacote (D23), e e carregada
 * SO por este processo — o plugin host continua a usar apenas builtins `node:`.
 * A frase "zero dependencias de runtime" deixa de ser verdade no mesmo commit
 * em que ela entra; o argumento verificavel passa a ser "UMA dependencia de
 * runtime, carregada so pelo processo `worker/`".
 */

import { pathToFileURL } from 'node:url'

import { createBot } from './lib/client.ts'
import { configure as configureBot } from './commands/costura.ts'
import { systemTime, type TimeSource } from './lib/clock.ts'
import { exitCodeFor, WORKER_EXIT, WorkerError } from './lib/errors.ts'
import { createWorkerLogger, type WorkerLogger, type WorkerLogLevel } from './lib/log.ts'
import { buildPollingOptions, runPolling } from './lib/polling.ts'
import { describeForLog } from './lib/redact.ts'
import { API_ROOT_ENV_VAR, assertTokenNotInArgv, readBotToken } from './lib/token.ts'

/** Tudo o que o processo toca do mundo exterior, para o teste poder substitui-lo. */
export interface WorkerRuntime {
  readonly env?: NodeJS.ProcessEnv
  readonly argv?: readonly string[]
  readonly log?: WorkerLogger
  readonly time?: TimeSource
  /**
   * Costura das outras sub-tarefas da Onda 4/5: allowlist (T4.4), canal IPC
   * (T4.3) e comandos (T5.2) registam-se aqui, DEPOIS de o bot existir e ANTES
   * de o polling arrancar.
   *
   * PORQUE UM GANCHO E NAO UM `import` DIRECTO: a costura (T5.2) e dona de
   * `worker/commands/**` e o call site de producao (`main`) passa-a — ver
   * `configureBot` abaixo. O gancho mantem o entrypoint testavel com
   * configuracao injetada; a producao liga a costura num unico lugar.
   */
  readonly configure?: (bot: ReturnType<typeof createBot>) => void | Promise<void>
}

/**
 * Corre o worker do principio ao fim e devolve o codigo de saida.
 *
 * NAO chama `process.exit`: devolve. Quem mata o processo e {@link main}, e essa
 * separacao e o que torna todo este caminho testavel sem subprocesso.
 */
export async function runTelegramWorker(runtime: WorkerRuntime = {}): Promise<number> {
  const env = runtime.env ?? process.env
  const argv = runtime.argv ?? process.argv
  const time = runtime.time ?? systemTime

  // O logger nasce ANTES de haver token: se a leitura do token falhar, a falha
  // tem de sair por algum lado. Os segredos entram por FUNCAO, e nao por valor,
  // precisamente para que este logger — criado antes — mascare o token que so
  // vai existir daqui a duas linhas.
  let token: string | undefined
  const log =
    runtime.log ??
    createWorkerLogger({
      clock: time,
      level: WORKER_LOG_LEVEL,
      secrets: () => (token === undefined ? [] : [token]),
    })

  try {
    // Ordem deliberada: primeiro le-se, depois verifica-se o `argv`. Sem o token
    // lido, a verificacao literal nao tem com que comparar.
    token = readBotToken(env)
    assertTokenNotInArgv(argv, token)

    const apiRoot = env[API_ROOT_ENV_VAR]
    const bot = createBot({
      token,
      log,
      time,
      ...(apiRoot === undefined || apiRoot === '' ? {} : { apiRoot }),
    })

    await runtime.configure?.(bot)

    const outcome = await runPolling({
      bot,
      log,
      options: buildPollingOptions(),
      secrets: () => (token === undefined ? [] : [token]),
    })
    return outcome.exitCode
  } catch (error) {
    // Nunca engolir: a causa sai mascarada, com codigo quando ha codigo.
    if (error instanceof WorkerError) {
      log.error(error.message, { code: error.code })
      return exitCodeFor(error.code)
    }
    log.error('falha nao classificada no arranque do worker', {
      detail: describeForLog(error, token === undefined ? [] : [token]),
    })
    return WORKER_EXIT.POLLING
  }
}

/**
 * Nivel de log do processo. CONSTANTE, e nao lido do ambiente.
 *
 * ===========================================================================
 * PORQUE DEIXOU DE SER CONFIGURAVEL (achado de revisao adversarial)
 * ===========================================================================
 * Este ficheiro lia `WORKER_LOG_LEVEL` do ambiente. So que o ambiente do worker
 * e construido por ALLOWLIST no host (`WORKER_ENV_ALLOWLIST`, `src/proc/env.ts`)
 * e `WORKER_LOG_LEVEL` **nao esta la**. Consequencia: a variavel nunca chegava,
 * o nivel ficava permanentemente `info`, e todas as chamadas `log.debug` deste
 * worker eram CODIGO MORTO no processo real.
 *
 * Pior do que inutil: era a APARENCIA DE UM CONTROLO QUE NAO EXISTE. Um operador
 * a diagnosticar uma avaria poria `WORKER_LOG_LEVEL=debug`, nao veria nada
 * mudar, e concluiria que nao havia mais nada para ver — quando o que havia era
 * um botao desligado do fio.
 *
 * As duas saidas honestas eram acrescentar a variavel a allowlist (fica em
 * `src/`, que NAO e desta sub-tarefa) ou tirar a leitura. Tirou-se a leitura.
 *
 * O valor e `debug` e nao `info` para que nada aqui seja codigo morto: os unicos
 * sitios que registam a este nivel sao eventos RAROS (uma mensagem particionada,
 * uma espera de 429 abortada). Nao ha, nem pode passar a haver, `log.debug` num
 * caminho por-update.
 *
 *   >>> SE ACRESCENTAR UM `log.debug` A UM CAMINHO POR-UPDATE, MUDE ISTO <<<
 *   >>> PARA `'info'` NO MESMO COMMIT — senao um chat activo enche o log do  <<<
 *   >>> DSH. E se algum dia quiser mesmo o controlo por ambiente, o sitio e  <<<
 *   >>> `WORKER_ENV_ALLOWLIST`; sem passar por la, ele nao existe.           <<<
 */
export const WORKER_LOG_LEVEL: WorkerLogLevel = 'debug'

/**
 * Tempo de graca antes de forcar a saida.
 *
 * O timer e `unref()`ado: se o event loop esvaziar sozinho, o processo sai ANTES
 * disto com o `exitCode` ja definido e este timer nunca dispara. Ele so ganha
 * vida se sobrar algum handle agarrado — e ai o host precisa mesmo de ver o
 * `close`, porque e nele que baseia o `DEGRADED`. Um worker que fica pendurado
 * a seguir a um 409 e pior do que um worker morto: o supervisor nao sabe que
 * ele acabou.
 */
export const EXIT_GRACE_MS = 2000

/**
 * Entrada real. Separada para que importar este modulo num teste nao arranque nada.
 *
 * O call site de producao e o PASSO DE INTEGRACAO da costura: `configureBot`
 * (T5.2, `worker/commands/costura.ts`) liga allowlist, pareamento, canal IPC e
 * comandos ao bot, DEPOIS de o bot existir e ANTES de o polling arrancar.
 */
export async function main(): Promise<void> {
  const code = await runTelegramWorker({ configure: configureBot })
  process.exitCode = code
  if (code !== WORKER_EXIT.OK) {
    const timer = setTimeout(() => {
      process.exit(code)
    }, EXIT_GRACE_MS)
    timer.unref()
  }
}

/**
 * So corre quando este ficheiro E o processo — nunca quando e importado.
 *
 * `process.argv[1]` pode ser `undefined` (REPL, `--eval`); `pathToFileURL` de
 * `undefined` lancaria, e uma excecao no topo de um modulo importado por um
 * teste seria um falhanco sem relacao nenhuma com o que o teste mede.
 */
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
