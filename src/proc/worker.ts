/**
 * `createWorkerSupervisor` -- o worker de long-polling do Telegram, expresso como
 * UMA INSTANCIACAO de `createProcessSupervisor`.
 *
 * O QUE ESTE FICHEIRO NAO TEM, e essa e a prova de que a generalizacao e real:
 * nada de ciclo de vida. Backoff com jitter, orcamento em janela deslizante,
 * `AbortController` unico, tree-kill do grupo, disposer sincrono LIFO e evento
 * terminal unico vivem em `./supervisor.ts` e sao partilhados com o supervisor
 * do `cloudflared`. Aqui esta SO o que distingue o worker de qualquer outro
 * processo longo: o `argv`, o `cwd`, o `stdio`, o ambiente -- e, desde a Onda 4,
 * o CANAL.
 *
 * O ficheiro cresceu nesta onda (de ~90 para ~225 linhas) e a razao esta toda
 * numa frase: o worker passou a ser o unico processo do repositorio com um
 * PROTOCOLO. `stdin` passou de `'ignore'` a `'pipe'`, e com isso vieram o
 * sentido host -> worker (`send`), o decisor de intencoes e o dead-man's switch.
 * O `cloudflared` nao tem nada disto e continua a nao ter -- pelo que a
 * alternativa (empurrar o canal para a superficie generica) tornaria a
 * generalizacao MENOS real, nao mais.
 *
 * `src/proc/supervisor.ts` reexporta este simbolo, e nao ao contrario: quem
 * importava `createWorkerSupervisor` de la (`src/index.ts`) continua a compilar
 * sem tocar em nada.
 */

import {
  PACKAGED_WORKER_ENTRYPOINT,
  resolveWorkerCwd,
  type Config,
} from '../config/schema.ts'
import type { IpcIntentMessage, IpcMessageToWorker } from '../contracts/ipc.ts'
import type { Context, SubprocessHandle, SubprocessSpawnSpec } from '../dsh/adapter.ts'
import { createGuardLogger, type GuardLogger } from '../logging/logger.ts'
import { createHostIpcChannel, type HostIpcChannel } from '../telegram/ipc.ts'
import type { IpcNonceRequestMessage } from '../contracts/ipc.ts'
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
 * Continua a ser um tipo proprio (e nao um alias nu de `ProcessSupervisor`)
 * porque a Onda 4 lhe acrescentou o que o IPC precisa -- {@link send} -- sem
 * alargar a superficie generica, que e partilhada com o tunel.
 */
export interface WorkerSupervisor extends ProcessSupervisor {
  /**
   * Difunde uma mensagem host -> worker pelo canal JSONL.
   *
   * `false` quando ela nao saiu: nao ha filho vivo, o canal esta saturado
   * (backpressure) ou a mensagem viola o contrato. NUNCA lanca e NUNCA bloqueia
   * -- um `write` que bloqueasse num pipe cheio congelava o DSH inteiro.
   */
  send(message: IpcMessageToWorker): boolean
}

/** O que distingue este supervisor do generico, alem do `argv`. */
export interface WorkerSupervisorOptions {
  /**
   * O TOKEN do bot, RESOLVIDO pela costura (`config.worker.token` ou o
   * `secrets.env` gravado pelo CLI). AUSENTE, o supervisor usa `config.worker.token`.
   *
   * PORQUE EXISTE: o botao da UI e o spawn do worker tem de PARTILHAR a MESMA
   * resolucao do token, ou o botao acenderia com um token que nunca chega ao
   * worker (`config.worker.token` vazio mas `secrets.env` preenchido). A costura
   * em `src/index.ts` resolve uma vez e passa-o para as duas pontas.
   */
  readonly token?: string | undefined
  /**
   * Decide UMA intencao vinda do worker e devolve a resposta.
   *
   * SINCRONO e TOTAL (devolve sempre uma mensagem), porque o contrato diz que o
   * `ack` e "sempre emitido -- inclusive nos caminhos de erro": sem resposta, o
   * cliente do Telegram fica com a barra de progresso eterna e o dono nao sabe
   * se o comando chegou. Trabalho lento responde `accepted` JA e difunde o resto
   * depois, por {@link WorkerSupervisor.send}.
   *
   * AUSENTE, o canal responde `INTERNAL` a tudo -- ver
   * {@link rejeitarSemControlador}. E fail-closed e e visivel no log; nao ha
   * caminho em que uma intencao seja ignorada em silencio.
   */
  readonly onIntent?: ((intent: IpcIntentMessage) => IpcMessageToWorker) | undefined
  /**
   * Decide UM pedido de nonce (EMENDA-COSTURA-5) e devolve a resposta.
   *
   * AUSENTE, o canal responde `error INTERNAL` ao pedido (fail-closed: um
   * nonce que nao chega nao autoriza nada — CTL-023). Em producao a fiacao
   * liga-o ao `ConfirmService` de T5.1 via `criarRespondedorDeNonce`.
   */
  readonly onNonceRequest?: ((request: IpcNonceRequestMessage) => IpcMessageToWorker) | undefined
}

/**
 * Resposta do canal quando NENHUM controlador esta montado.
 *
 * A maquina de controlo (transicoes legais, nonce, TTL) e da Onda 5. Ate la a
 * unica resposta honesta e `INTERNAL`: e o codigo do vocabulario fechado cuja
 * `message` "nao pode denunciar topologia", e responder e obrigatorio -- calar
 * seria deixar o dono a olhar para uma barra de progresso que nunca acaba.
 */
function rejeitarSemControlador(log: GuardLogger, intent: IpcIntentMessage): IpcMessageToWorker {
  log.warn(
    `Intencao '${intent.intent}' recebida sem controlador montado; respondida com INTERNAL.`,
  )
  return {
    v: 1,
    type: 'error',
    requestId: intent.requestId,
    code: 'INTERNAL',
    message: 'Este comando ainda nao esta disponivel nesta instalacao.',
  }
}

/**
 * Resposta do canal quando NENHUM tratador de nonce esta montado (EMENDA-
 * COSTURA-5). Fail-closed: sem nonce nao ha confirmacao, e sem confirmacao
 * nao ha intent que aumente exposicao (CTL-023).
 */
function rejeitarSemNonce(log: GuardLogger, request: IpcNonceRequestMessage): IpcMessageToWorker {
  log.warn(
    `Pedido de nonce (${request.acao}) recebido sem tratador montado; respondido com INTERNAL.`,
  )
  return {
    v: 1,
    type: 'error',
    requestId: request.requestId,
    code: 'INTERNAL',
    message: 'Este comando ainda nao esta disponivel nesta instalacao.',
  }
}

/** Cria o supervisor do processo filho do worker do Telegram. */
export function createWorkerSupervisor(
  ctx: Context,
  config: Config,
  deps: SupervisorDeps = defaultSupervisorDeps,
  options: WorkerSupervisorOptions = {},
): WorkerSupervisor {
  const { worker } = config
  const log = createGuardLogger(ctx)

  /**
   * O token do bot: o da costura (`options.token`, resolvido de
   * `config.worker.token`/`secrets.env`) ou o do proprio `config` quando
   * aquele e omitido (os testes, por exemplo). Uma so fonte para o segredo,
   * o env do filho E a mascara de logs.
   */
  const tokenDoBot = options.token ?? worker.token

  /**
   * FORNECEDOR de segredos, PARTILHADO pelo encaminhamento de log do filho e
   * pelo canal IPC.
   *
   * Uma so definicao de proposito: enquanto o `attachStreamLogging` tinha
   * `redact()` e o canal nao, o MESMO token do bot saia mascarado quando era o
   * filho a imprimi-lo e EM CLARO quando era o host a registar a excecao de um
   * decisor de intencoes. Duas listas eram duas politicas.
   */
  const secrets = (): readonly string[] => [tokenDoBot]

  /**
   * O canal da INSTANCIA CORRENTE. Estado de CLOSURE, nunca de modulo: dois
   * supervisores no mesmo processo (o teste corre dezenas) teriam de partilhar
   * um canal, e o `send` de um acabaria no `stdin` do filho do outro.
   */
  let channel: HostIpcChannel | undefined

  const supervisor = createProcessSupervisor(
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
      secrets,
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
        /**
         * OS TRES CANAIS EM `'pipe'` -- e o `stdin` e a mudanca estrutural da
         * Onda 4.
         *
         * Ate aqui `stdin` era `'ignore'` (fd 0 em `/dev/null`), com a
         * justificacao "um long-poller nao le do operador". Continua a ser
         * verdade que ele nao le do OPERADOR; o que ele passa a ler e o
         * PROTOCOLO -- e o pipe compra duas coisas que `/dev/null` nao dava:
         *
         *   1. o sentido host -> worker do canal JSONL, sem abrir porta nenhuma
         *      nem ficheiro nenhum (`../contracts/ipc.ts`);
         *   2. o DEAD-MAN'S SWITCH: morto o `dsh` com `SIGKILL`, o nucleo fecha
         *      este descritor, o worker ve EOF e termina sozinho. E a UNICA
         *      defesa que sobrevive a um `SIGKILL` no supervisor, porque
         *      `detached` + `kill(-pid)` no disposer depende de o disposer
         *      chegar a correr.
         *
         * MEDIDO -- e a pergunta que a revisao exigiu: passar `stdin` a `'pipe'`
         * NAO altera o tree-kill nem o `detached`. `ps -o pid,ppid,pgid,sid`
         * mostra o filho como lider do seu proprio grupo e da sua propria sessao
         * (`pgid === sid === pid`) com os dois `stdio`, e o neto continua a
         * morrer com o grupo. Evidencia em
         * `test/integration/proc/stdio-pipe-nao-regride-tree-kill.test.ts`.
         *
         * `'pipe'` entrega os streams crus: `stdout` vai para o canal (S2 -- so
         * JSONL) e `stderr` continua a ir para o log do host.
         */
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        // Janela de cortesia da escalada SIGTERM -> grace -> SIGKILL do assento.
        graceMs: worker.graceMs,
        // A intencao de anulacao transita nativamente para a arvore do filho.
        signal,
        // Ambiente CONSTRUIDO a partir de uma allowlist, nunca herdado inteiro:
        // `process.env` levava `ADMIN_USER`/`ADMIN_PASS` do plano de controlo
        // para dentro do worker. Ver `buildWorkerEnv`.
        env: buildWorkerEnv(process.env, tokenDoBot),
      }),
      /**
       * O CANAL, ligado e desligado pelo supervisor generico -- ver
       * `SupervisedProcess.attachChannel`. Aqui so se diz QUEM decide as
       * intencoes; o QUANDO (antes de `onSpawned`, desarmado no fecho) e
       * garantia da camada de cima.
       */
      attachChannel: (handle: SubprocessHandle): (() => void) => {
        const corrente = createHostIpcChannel({
          input: handle.stdout,
          output: handle.stdin,
          log,
          secrets,
          onIntent: (intent: IpcIntentMessage): IpcMessageToWorker =>
            options.onIntent?.(intent) ?? rejeitarSemControlador(log, intent),
          onNonceRequest: (request: IpcNonceRequestMessage): IpcMessageToWorker =>
            options.onNonceRequest?.(request) ?? rejeitarSemNonce(log, request),
        })
        channel = corrente

        return (): void => {
          corrente.dispose()
          // So limpa se ainda for o corrente: numa substituicao, o canal NOVO ja
          // esta em `channel` e apaga-lo aqui deixava o `send` mudo com um filho
          // vivo -- o mesmo defeito que `releaseCurrentHandle` corrigiu para o
          // handle.
          if (channel === corrente) channel = undefined
        }
      },
    },
    deps,
  )

  /**
   * Delegacao CAMPO A CAMPO, e nao `{ ...supervisor }`: o espalhamento copia
   * VALORES, e `attempts`, `exhausted` e `failure` sao getters -- ficariam
   * congelados no valor que tinham no instante da copia, e um teste de orcamento
   * passaria a ler sempre `0`.
   */
  return {
    start: supervisor.start,
    restart: supervisor.restart,
    dispose: supervisor.dispose,
    signal: supervisor.signal,
    get attempts(): number {
      return supervisor.attempts
    },
    get exhausted(): boolean {
      return supervisor.exhausted
    },
    get failure(): ProcessSupervisor['failure'] {
      return supervisor.failure
    },
    send: (message: IpcMessageToWorker): boolean => channel?.send(message) ?? false,
  }
}
