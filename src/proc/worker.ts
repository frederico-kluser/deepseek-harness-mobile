/**
 * `createWorkerSupervisor` -- o worker de long-polling do Telegram, expresso como
 * UMA INSTANCIACAO de `createProcessSupervisor`.
 *
 * PORQUE ESTE FICHEIRO E TAO CURTO: e essa a prova de que a generalizacao e real.
 * Tudo o que era ciclo de vida (backoff com jitter, orcamento em janela
 * deslizante, `AbortController` unico, tree-kill do grupo, disposer sincrono
 * LIFO, evento terminal unico) vive em `./supervisor.ts` e e partilhado com o
 * supervisor do `cloudflared`. O que sobra aqui e SO o que distingue o worker de
 * qualquer outro processo longo: o `argv`, o `cwd`, o `stdio` e o ambiente.
 *
 * `src/proc/supervisor.ts` reexporta este simbolo, e nao ao contrario: quem
 * importava `createWorkerSupervisor` de la (`src/index.ts`, T4.3) continua a
 * compilar sem tocar em nada.
 */

import {
  PACKAGED_WORKER_ENTRYPOINT,
  resolveWorkerCwd,
  type Config,
} from '../config/schema.ts'
import type { Context, SubprocessSpawnSpec } from '../dsh/adapter.ts'
import { buildWorkerEnv } from './env.ts'
import {
  createProcessSupervisor,
  defaultSupervisorDeps,
  type ProcessSupervisor,
  type SupervisorDeps,
} from './supervisor.ts'

/**
 * Superficie publica do supervisor do worker.
 *
 * Continua a ser um tipo proprio (e nao um alias nu de `ProcessSupervisor`) para
 * que a Onda 4 lhe possa acrescentar o que o IPC precisar sem alargar a
 * superficie generica, que e partilhada com o tunel.
 */
export interface WorkerSupervisor extends ProcessSupervisor {}

/** Cria o supervisor do processo filho do worker do Telegram. */
export function createWorkerSupervisor(
  ctx: Context,
  config: Config,
  deps: SupervisorDeps = defaultSupervisorDeps,
): WorkerSupervisor {
  const { worker } = config

  return createProcessSupervisor(
    ctx,
    {
      name: 'worker',
      backoff: worker.backoff,
      // Q-4: o token entra no ambiente, nunca em `argv`. Passa-lo tambem aqui faz
      // com que qualquer eco dele em stdout/stderr saia do log mascarado.
      // FORNECEDOR (ver `SupervisedProcess.secrets`). O token do bot vem da
      // configuracao e nao muda em runtime, mas a superficie e uma so para os
      // dois supervisores -- duas assinaturas para o mesmo campo era a fenda por
      // onde a generalizacao deixaria de ser real.
      secrets: (): readonly string[] => [worker.token],
      buildSpec: (signal: AbortSignal): SubprocessSpawnSpec => ({
        /**
         * ARGV: `[command, entrypoint, ...args]` -- o entrypoint e ANTEPOSTO aqui
         * e NAO vem do manifesto. Nao pode vir: um caminho relativo no
         * `cordis.patch.yml` resolveria contra o `cwd` do HOST (o workspace do
         * utilizador) e o absoluto so e conhecido em runtime. As tres decisoes
         * canonicas dizem a mesma frase: *"O `argv` do spawn resolve
         * `dist/worker/telegram-bot.js` relativo a `import.meta.url`, nunca por
         * `cwd`."*
         *
         * `worker.command` e `process.execPath` (o MESMO Node do host, sem
         * depender do `PATH`) e `worker.args` sao argumentos EXTRA, valor normal
         * `[]`. Montar `[command, ...args]` dava, com o manifesto real,
         * `argv: ['/caminho/para/node']`: um REPL do Node, nao o worker.
         */
        argv: [worker.command, PACKAGED_WORKER_ENTRYPOINT, ...worker.args],
        cwd: resolveWorkerCwd(config),
        // Isolamento dos canais stdio: o worker nao satura o terminal do DSH e
        // stdin fica fechado (um long-poller nao le do operador). `'pipe'`
        // entrega os `Readable` crus, que e o que o encaminhamento para o log usa.
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        // Janela de cortesia da escalada SIGTERM -> grace -> SIGKILL do assento.
        graceMs: worker.graceMs,
        // A intencao de anulacao transita nativamente para a arvore do filho.
        signal,
        // Ambiente CONSTRUIDO a partir de uma allowlist, nunca herdado inteiro:
        // `process.env` levava `ADMIN_USER`/`ADMIN_PASS` do plano de controlo
        // para dentro do worker. Ver `buildWorkerEnv`.
        env: buildWorkerEnv(process.env, worker.token),
      }),
    },
    deps,
  )
}
