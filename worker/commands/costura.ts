/**
 * A COSTURA (adicao SANCIONADA ao mapa de propriedade da Onda 5): o builder
 * `configure(bot)` que liga o worker inteiro — allowlist + pareamento (T4.4),
 * canal IPC (T4.3), comandos (T5.2) — DEPOIS de o bot existir e ANTES de o
 * polling arrancar (`worker/telegram-bot.ts` chama-o pelo gancho
 * {@link WorkerRuntime.configure}).
 *
 * DONO: T5.2.
 *
 * ===========================================================================
 * A ALLOWLIST E DINAMICA — E O PAREAMENTO, A FONTE
 * ===========================================================================
 * O worker nasce SEM dono (o ambiente do processo e construido por allowlist
 * em `src/proc/env.ts` e nao transporta ids). Quem decide o pareamento e o
 * receptor de T4.4, e a allowlist e um ENVELOPE sobre o estado dele: antes do
 * pareamento, `size 0` (nega tudo, TG-007); depois, aceita os dois eixos do
 * dono gravado. Nenhum id novo entra por configuracao — so pelo `/parear`.
 *
 * ===========================================================================
 * O DESAFIO DE PAREAMENTO NO ARRANQUE — PREMISSA (ver handoff)
 * ===========================================================================
 * O receptor exige um desafio ao nascer. A costura usa um desafio MORTO
 * (expira no instante 0): enquanto o host nao enviar `pairing.challenge`, todo
 * `/parear` e recusado (fail-closed). O host envia o desafio quando gera o
 * codigo; num reboot com dono persistido, o contrato congelado NAO define como
 * o worker o volta a aprender — reportado no handoff (T5.1 fia o host).
 *
 * ===========================================================================
 * O PORTE `emitirNonce` EM PRODUCAO — BLOQUEIO REPORTADO (ver handoff)
 * ===========================================================================
 * O contrato congelado do canal IPC nao define transporte host -> worker para
 * o nonce de confirmacao. A ligacao de producao devolve `undefined` e falha
 * FECHADO: sem nonce nao ha confirmacao possivel, e sem confirmacao nao ha
 * intent que aumente exposicao (CTL-023). T5.1 fecha o transporte na fiacao
 * do host; a porta fica exposta exatamente para isso. O que esta ligacao NAO
 * faz, por desenho: inventar um nonce (S5) ou deixar a acao passar sem
 * confirmacao.
 *
 * ===========================================================================
 * O DESPACHO DO CANAL E UMA TABELA (tipo -> tratador), NAO UM SWITCH
 * ===========================================================================
 * `worker/ipc.ts` (T4.3) entrega mensagens validas; esta costura despacha-as
 * por tabela. Acrescentar um tipo ao contrato = UMA entrada nesta tabela.
 */

import { EMPTY_ALLOWLIST, type Allowlist } from '../auth/allowlist.ts'
import { createIdentityGuard, type IdentityGuard } from '../auth/guard.ts'
import { createPairingChallenge, createPairingReceiver, type PairingReceiver } from '../auth/pairing.ts'
import { bindWorkerIpcToProcess, type WorkerIpc } from '../ipc.ts'
import { systemTime, type TimeSource } from '../lib/clock.ts'
import { createWorkerLogger, type WorkerLogger } from '../lib/log.ts'
import { readBotToken } from '../lib/token.ts'
import type { Bot, Context } from 'grammy'
import type { IpcMessageToWorker } from '../../src/contracts/ipc.ts'

import {
  criarRoteador,
  registarComandosPublicados,
  type ApiDoBot,
  type EmitirNonce,
  type Roteador,
} from './router.ts'

/**
 * A allowlist DINAMICA: um envelope sobre o estado do receptor de pareamento.
 *
 * `has` aceita os DOIS eixos do dono gravado; `size` e 0 antes do pareamento
 * (default deny, TG-007) e 2 depois. Nao guarda estado proprio — le o do
 * receptor, que e a fonte.
 */
export function criarAllowlistDinamica(pareamento: PairingReceiver): Allowlist {
  const estatica = EMPTY_ALLOWLIST
  return Object.freeze({
    get size(): number {
      return pareamento.state().status === 'fechado' ? 2 : 0
    },
    has: (id: number): boolean => {
      if (estatica.has(id)) return true
      const estado = pareamento.state()
      return estado.status === 'fechado' && (id === estado.owner.from || id === estado.owner.chat)
    },
  })
}

/** Desafio MORTO: expira no instante 0. Todo `/parear` falha ate o host mandar o real. */
export function desafioMorto(): ReturnType<typeof createPairingChallenge> {
  return createPairingChallenge('000000', 0)
}

/**
 * O porte `emitirNonce` DE PRODUCAO sem ponte do host (BLOQUEIO T5.2 — ver o
 * cabecalho e o handoff): devolve `undefined` — a confirmacao falha FECHADO e
 * nenhum intent que aumente exposicao sai (CTL-023) — e AVISA o operador, para
 * o botao nao morrer em silencio. Nomeada e exportada para o teste a exercitar
 * de verdade (A3-b da revisao).
 */
export function emitirNonceDeProducao(log: WorkerLogger): EmitirNonce {
  return (acao) => {
    log.warn('emitirNonce sem ponte do host: confirmacao indisponivel (BLOQUEIO T5.2)', { acao })
    return undefined
  }
}

export interface SuperficieMontada {
  readonly guard: IdentityGuard
  readonly pairing: PairingReceiver
  readonly roteador: Roteador
}

export interface MontarSuperficieDeps {
  readonly log: WorkerLogger
  readonly time: TimeSource
  readonly api: ApiDoBot
  readonly ipc: WorkerIpc
  readonly parar: () => Promise<void>
  readonly emitirNonce?: EmitirNonce
}

/** Monta o guard, o receptor e o roteador — a superficie inteira. */
export function montarSuperficie(deps: MontarSuperficieDeps): SuperficieMontada {
  const pairing = createPairingReceiver({
    challenge: desafioMorto(),
    clock: deps.time,
  })
  const guard = createIdentityGuard({
    allowlist: criarAllowlistDinamica(pairing),
  })
  const roteador = criarRoteador({
    log: deps.log,
    time: deps.time,
    guard,
    pairing,
    ipc: deps.ipc,
    api: deps.api,
    emitirNonce: deps.emitirNonce ?? emitirNonceDeProducao(deps.log),
    parar: deps.parar,
  })
  return { guard, pairing, roteador }
}

/**
 * A TABELA tipo -> tratador do canal. Uma entrada por tipo; o desconhecido
 * nunca chega aqui (o parser de T4.3 ja o descartou por S4).
 */
export function criarDespachoDoCanal(roteador: Roteador): Readonly<
  { [K in IpcMessageToWorker['type']]: (msg: Extract<IpcMessageToWorker, { type: K }>) => void }
> {
  return {
    state: (msg) => roteador.onState(msg),
    ack: (msg) => roteador.onAck(msg),
    error: (msg) => roteador.onError(msg),
    notify: (msg) => roteador.onNotify(msg),
    'pairing.challenge': (msg) => roteador.onPairingChallenge(msg),
  }
}

/** As dependencias de producao que `configure` consegue obter do processo. */
export interface ConfiguracaoDoProcesso {
  readonly env?: NodeJS.ProcessEnv
  readonly proc?: NodeJS.Process
}

/**
 * O builder sancionado: liga tudo ao processo real e ao bot, e publica a
 * lista de comandos. Chamado por `worker/telegram-bot.ts` antes do polling.
 */
export function configure(
  bot: Bot<Context>,
  processo: ConfiguracaoDoProcesso = {},
): void {
  const env = processo.env ?? process.env
  const proc = processo.proc ?? process

  // O logger proprio da costura mascara o token do ambiente (o entrypoint ja
  // o validou; aqui so se quer o mascaramento). Nivel `info`: as linhas
  // `debug` da superficie sao diagnostico raro e nao justificam duplicar a
  // constante do entrypoint (que criaria um ciclo de import).
  let token: string | undefined
  try {
    token = readBotToken(env)
  } catch {
    token = undefined
  }
  const log = createWorkerLogger({
    clock: systemTime,
    secrets: () => (token === undefined ? [] : [token]),
  })

  // O despacho resolve-se por tabela quando a mensagem chega; a superficie
  // nasce a seguir (o bind e sincrono — nenhuma mensagem chega antes).
  let superficie: SuperficieMontada | undefined
  const ipc = bindWorkerIpcToProcess(proc, {
    onMessage: (msg: IpcMessageToWorker) => {
      const roteador = superficie?.roteador
      if (roteador === undefined) return
      criarDespachoDoCanal(roteador)[msg.type](msg as never)
    },
  })

  superficie = montarSuperficie({
    log,
    time: systemTime,
    api: bot.api as unknown as ApiDoBot,
    ipc,
    parar: async () => {
      await bot.stop()
    },
  })

  // O funil do Telegram: todo update passa pelo roteador.
  bot.on(['message', 'callback_query'], async (ctx) => {
    await superficie.roteador.tratarUpdate(ctx.update)
  })

  // TG-080: publica a lista canonica. Uma falha de publicacao e logada e nao
  // derruba o boot — o bot continua a responder aos comandos que sabe.
  void registarComandosPublicados(bot.api as unknown as Parameters<typeof registarComandosPublicados>[0]).catch(
    (error) => {
      log.error('setMyCommands falhou; a lista nao ficou publicada', {
        detail: error instanceof Error ? error.message : String(error),
      })
    },
  )
}

