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
 * O PORTE `emitirNonce` EM PRODUCAO — FECHADO PELA COSTURA (EMENDA-COSTURA-5)
 * ===========================================================================
 * O contrato do canal IPC NAO definia transporte host -> worker para o nonce
 * de confirmacao (BLOQUEIO T5.2 reportado no handoff). A COSTURA da Onda 5
 * fecha-o com a emenda `nonce.request`/`nonce.issued` (`src/contracts/ipc.ts`,
 * a RATIFICAR no COMMIT PREP 6): o worker pede o nonce ao HOST pelo pipe e
 * aguarda a resposta com TIMEOUT fail-closed — sem nonce a tempo, a
 * confirmacao fica indisponivel e nenhum intent que aumente exposicao sai
 * (CTL-023). O que esta ponte NAO faz, por desenho: inventar um nonce (S5),
 * valida-lo, ou loga-lo (S3 — o valor viaja so pelo pipe).
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
import type { ControlAction } from '../../src/contracts/control.ts'
import type { IpcIntentName, IpcMessageToWorker, IpcPairingOwnerMessage } from '../../src/contracts/ipc.ts'
import type { PairedOwner } from '../auth/pairing.ts'

import {
  criarRoteador,
  gerarRequestId,
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
 * Teto de espera por `nonce.issued` (EMENDA-COSTURA-5). Fail-closed: passado
 * este prazo sem resposta do host, o pedido resolve `undefined` e a acao que
 * aumentaria exposicao NAO sai (CTL-023). Curto de proposito — o teclado de
 * confirmacao do /ligar nao pode deixar o dono a olhar para um botao morto.
 */
export const NONCE_REQUEST_TIMEOUT_MS = 5_000

/**
 * O intent do Telegram -> a `ControlAction` do contrato para a qual o nonce e
 * emitido. So as acoes que AUMENTAM exposicao pedem nonce (CTL-023/024); as
 * demais nunca chegam aqui. `secret.rotate` cai na familia do `reset`: e a
 * acao destrutiva que regenera o segredo e invalida as sessoes.
 */
const ACAO_PARA_NONCE: Readonly<Partial<Record<IpcIntentName, ControlAction>>> = {
  'tunnel.up': 'start',
  'secret.rotate': 'reset',
}

export interface PonteDeNonce {
  /** Pede um nonce ao host e aguarda `nonce.issued` (timeout fail-closed). */
  readonly emitir: EmitirNonce
  /**
   * Consome as mensagens do canal que dizem respeito a pedidos de nonce.
   * `true` = consumida (nao deve chegar ao roteador); `false` = nao e do
   * nonce (segue o despacho normal).
   */
  readonly onMessage: (msg: IpcMessageToWorker) => boolean
}

/**
 * A ponte de producao do nonce: `nonce.request` pelo canal e `nonce.issued` de
 * volta, com TIMEOUT fail-closed (EMENDA-COSTURA-5; ver o cabecalho). O valor
 * do nonce NUNCA e logado (S3) e NUNCA e interpretado aqui (S5) — so o prazo
 * e a acao podem ir ao log.
 */
export function criarPonteDeNonce(deps: {
  readonly log: WorkerLogger
  readonly time: TimeSource
  readonly ipc: WorkerIpc
}): PonteDeNonce {
  const { log } = deps
  const pendentes = new Map<string, (nonce: string | undefined) => void>()

  const emitir: EmitirNonce = async (acao) => {
    const controlo = ACAO_PARA_NONCE[acao]
    if (controlo === undefined) {
      // A acao nao exige nonce (CTL-024) ou e desconhecida: nao ha o que pedir.
      log.warn(`emitirNonce chamado para acao sem nonce: ${acao}`, { acao })
      return undefined
    }
    const requestId = gerarRequestId(deps.time.now())
    const enviado = deps.ipc.send({ v: 1, type: 'nonce.request', acao: controlo, requestId })
    if (!enviado) {
      // Canal indisponivel: falha FECHADO ja, sem esperar o timeout.
      log.warn('emitirNonce sem canal para o host: confirmacao indisponivel (fail-closed, CTL-023)', { acao })
      return undefined
    }
    return new Promise<string | undefined>((resolve) => {
      pendentes.set(requestId, resolve)
      void deps.time.sleep(NONCE_REQUEST_TIMEOUT_MS).then(() => {
        const pendente = pendentes.get(requestId)
        if (pendente !== undefined) {
          pendentes.delete(requestId)
          log.warn(`nonce nao chegou a tempo (${String(NONCE_REQUEST_TIMEOUT_MS)} ms); confirmacao indisponivel`, { acao })
          pendente(undefined)
        }
      })
    })
  }

  const onMessage = (msg: IpcMessageToWorker): boolean => {
    if (msg.type === 'nonce.issued') {
      const pendente = pendentes.get(msg.requestId)
      if (pendente === undefined) {
        // Resposta tardia de um pedido ja resolvido (timeout ou repetido):
        // nao ha ninguem a espera — descarta-se, sem log do nonce.
        return true
      }
      pendentes.delete(msg.requestId)
      pendente(msg.nonce)
      return true
    }
    if (msg.type === 'error' && msg.requestId !== undefined) {
      const pendente = pendentes.get(msg.requestId)
      if (pendente !== undefined) {
        // O host recusou emitir (ex.: modo loopback): falha fechado JA, em vez
        // de esperar o timeout — e o erro NAO vai ao roteador (nao ha intent
        // pendente para ele; mostrar ao dono seria duplicar a mensagem).
        pendentes.delete(msg.requestId)
        pendente(undefined)
        return true
      }
    }
    return false
  }

  return { emitir, onMessage }
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
  /**
   * Dono persistido reaprendido no boot (EMENDA-COSTURA-5, `pairing.owner`):
   * o receptor nasce FECHADO com o dono e `/parear` e recusado a partida —
   * sem nova parelha (8c).
   */
  readonly donoInicial?: PairedOwner | undefined
}

/** Monta o guard, o receptor e o roteador — a superficie inteira. */
export function montarSuperficie(deps: MontarSuperficieDeps): SuperficieMontada {
  const pairing = createPairingReceiver({
    challenge: desafioMorto(),
    clock: deps.time,
    ...(deps.donoInicial === undefined ? {} : { owner: deps.donoInicial }),
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
    // EMENDA-COSTURA-5: sem porte injetado, o default de producao pede o
    // nonce ao HOST pelo canal (`nonce.request`/`nonce.issued`), com timeout
    // fail-closed — nunca inventa um nonce (S5).
    emitirNonce: deps.emitirNonce ?? criarPonteDeNonce({ log: deps.log, time: deps.time, ipc: deps.ipc }).emitir,
    parar: deps.parar,
  })
  return { guard, pairing, roteador }
}

/**
 * A TABELA tipo -> tratador do canal. Uma entrada por tipo; o desconhecido
 * nunca chega aqui (o parser de T4.3 ja o descartou por S4).
 *
 * EMENDA-COSTURA-5: a ponte de nonce consome ANTES do roteador —
 * `nonce.issued` e um pedido de nonce respondido pelo host, nao uma mensagem
 * que o roteador saiba renderizar, e um `error` de um pedido de nonce
 * pendente nao tem intent por tras (mostra-lo ao dono seria duplicar a
 * mensagem de confirmacao indisponivel).
 */
export function criarDespachoDoCanal(roteador: Roteador, ponte?: PonteDeNonce): Readonly<
  {
    [K in Exclude<IpcMessageToWorker['type'], 'pairing.owner'>]: (
      msg: Extract<IpcMessageToWorker, { type: K }>,
    ) => void
  }
> {
  const consumidoPelaPonte = (msg: IpcMessageToWorker): boolean => ponte?.onMessage(msg) ?? false
  return {
    state: (msg) => roteador.onState(msg),
    ack: (msg) => roteador.onAck(msg),
    error: (msg) => {
      if (consumidoPelaPonte(msg)) return
      roteador.onError(msg)
    },
    notify: (msg) => roteador.onNotify(msg),
    'pairing.challenge': (msg) => roteador.onPairingChallenge(msg),
    'nonce.issued': (msg) => {
      // A resposta de um pedido de nonce pendente; orfa, descarta-se na ponte.
      consumidoPelaPonte(msg)
    },
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
  // EMENDA-COSTURA-5: a ponte de nonce nasce ANTES da superficie (o roteador
  // usa o `emitir` dela) e consome `nonce.issued`/`error` de pedidos de nonce
  // ANTES do despacho normal — ver `criarDespachoDoCanal`.
  let ponte: PonteDeNonce | undefined
  // 8(c): `pairing.owner` no boot. O host entrega o dono PERSISTIDO e a
  // superficie e RE-MONTADA com ele — o receptor nasce fechado, a allowlist
  // aceita o dono e `/parear` e recusado, sem nova parelha. A re-montagem e
  // atomica entre eventos (o bind e sincrono e os updates chegam depois).
  const remontarComDono = (msg: IpcPairingOwnerMessage): void => {
    superficie = montarSuperficie({
      log,
      time: systemTime,
      api: bot.api as unknown as ApiDoBot,
      ipc,
      // `exactOptionalPropertyTypes`: quando a ponte ainda nao existe (nunca,
      // na pratica — a re-montagem corre dentro de onMessage, depois do bind),
      // o campo e OMITIDO e o default interno cria a ponte.
      ...(ponte === undefined ? {} : { emitirNonce: ponte.emitir }),
      donoInicial: { from: msg.from, chat: msg.chat, pairedAt: msg.pairedAt },
      parar: async () => {
        await bot.stop()
      },
    })
  }
  const ipc = bindWorkerIpcToProcess(proc, {
    onMessage: (msg: IpcMessageToWorker) => {
      // `pairing.owner` nao e renderizavel pelo roteador: consome-se AQUI,
      // re-montando a superficie com o dono reaprendido (8c).
      if (msg.type === 'pairing.owner') {
        remontarComDono(msg)
        return
      }
      const roteador = superficie?.roteador
      if (roteador === undefined) return
      criarDespachoDoCanal(roteador, ponte)[msg.type](msg as never)
    },
  })

  ponte = criarPonteDeNonce({ log, time: systemTime, ipc })
  superficie = montarSuperficie({
    log,
    time: systemTime,
    api: bot.api as unknown as ApiDoBot,
    ipc,
    emitirNonce: ponte.emitir,
    parar: async () => {
      await bot.stop()
    },
  })

  // O funil do Telegram: todo update passa pelo roteador CORRENTE — lido no
  // instante do update, para a re-montagem por `pairing.owner` (8c) valer aqui
  // tambem. `undefined` (impossivel depois do bind) descarta o update em vez de
  // rebentar.
  bot.on(['message', 'callback_query'], async (ctx) => {
    await superficie?.roteador.tratarUpdate(ctx.update)
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

