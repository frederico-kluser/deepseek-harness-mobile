/**
 * A SUPERFICIE Telegram do controlador: mapeia `IpcIntentMessage` (o canal
 * host <-> worker de T4.3, `src/telegram/ipc.ts`) para `ControlIntent` e
 * devolve a resposta `IpcMessageToWorker` que o canal exige.
 *
 * DONO: T5.1 (a fiacao do canal IPC do host e desta sub-tarefa).
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTA CAMADA EXISTE — S6, D29 E O "ACK SEMPRE"
 * ---------------------------------------------------------------------------
 * - S6 (`src/contracts/ipc.ts`): a allowlist de identidade vive no worker; o
 *   host VOLTA a verificar contra o pareamento persistido, porque uma
 *   verificacao no processo que fala com a internet e a primeira a cair se
 *   esse processo for comprometido. A recusa e `NOT_PAIRED` e e CONTADA no
 *   audit (CTL-029).
 * - `EXPOSURE_DISABLED`: com `exposure.mode !== 'tunnel'` nao ha controlador
 *   (a fiacao so o cria com config de tunel) e a superficie recusa o pedido
 *   com o codigo cujo texto diz qual chave mudar.
 * - D29: `tunnel.up` em `STOPPING` e respondido `rejected` com
 *   `SHUTDOWN_IN_PROGRESS` — decidido de forma SINCRONA, nunca enfileirado.
 * - O `ack` e SEMPRE emitido: trabalho lento (`start` a partir de `STOPPED`,
 *   onde o probe corre) responde `accepted` JA e o resultado vem pelas
 *   difusoes de estado — o padrao do contrato IPC ("trabalho lento responde
 *   accepted ja e difunde o resto depois por send").
 * - `/emergencia` REDUZ exposicao e NAO exige nonce (CTL-024). Ele derruba o
 *   tunel PRIMEIRO (despacho `stop`) e so depois invalida as sessoes
 *   (`aposEmergencia`): "ordem tunel primeiro, sempre" (02-SEGURANCA L8).
 *
 * O que este ficheiro NAO faz: `session.issue` e `secret.rotate` ainda nao
 * tem dono nesta onda (a magia de T2.2/T3.4 e a rotacao de T2.1 entram pela
 * costura pos-onda); aqui respondem `INTERNAL` — fail-closed, com log.
 */

import type { AuditSink } from '../contracts/auth.ts'
import type { ControlAction, ControlIntent, ControlRecusa, ControlResultado } from '../contracts/control.ts'
import type { IpcAckMessage, IpcErrorMessage, IpcIntentMessage, IpcMessageToWorker } from '../contracts/ipc.ts'
import { IPC_PROTOCOL_VERSION } from '../contracts/ipc.ts'
import type { TunnelState } from '../contracts/tunnel.ts'
import type { GuardLogger } from '../logging/logger.ts'
import type { TunnelController } from './controller.ts'

/** Vocabulario de auditoria desta superficie. O fechado e de T5.4. */
export const EVENTO_NAO_PAREADO = 'tunel_intent_nao_pareado'

export interface RespondedorIpcDeps {
  /**
   * O controlador. `undefined` quando nao ha config de tunel
   * (`exposure.mode !== 'tunnel'`): a superficie recusa com
   * `EXPOSURE_DISABLED` — nunca despacha para um controlador inexistente.
   */
  readonly controller: TunnelController | undefined
  /** `exposure.mode === 'tunnel'` (derivado da config pela fiacao). */
  readonly modoTunel: boolean
  /**
   * Re-verificacao de identidade contra o pareamento persistido (S6).
   * NUNCA lanca: a falha de leitura responde `false` (fail-closed).
   */
  readonly pareado: (from: number, chat: number) => boolean
  /** Onde as recusas de identidade sao contadas (CTL-029). */
  readonly audit: Pick<AuditSink, 'append'>
  readonly log: GuardLogger
  /** Relogio injetado, para o campo `at` do `ControlIntent`. */
  readonly agora: () => number
  /**
   * Reenvia o estado corrente pelo canal (resposta a `/status` e a
   * reconexoes — CTL-027: o worker recebe o estado COMPLETO, nao um delta).
   */
  readonly reemitirEstado: () => void
  /**
   * Efeitos do `/emergencia` DEPOIS de o tunel cair: invalidar TODAS as
   * sessoes e auditar. Recebe a intent para a origem da linha.
   */
  readonly aposEmergencia: (intent: IpcIntentMessage) => void
}

/** O tratador que a fiacao entrega a `createWorkerSupervisor({ onIntent })`. */
export type RespondedorIpc = (intent: IpcIntentMessage) => IpcMessageToWorker

/**
 * Mapeia uma recusa do controlador para o vocabulario FECHADO do IPC.
 *
 * Uma entrada do vocabulario nao tem correspondente (`SEM_SEGREDO_FORTE`):
 * nao ha codigo IPC para "segredo nao provisionado". Responde-se `INTERNAL`
 * — o codigo catch-all cuja mensagem "nao denuncia topologia" — e o motivo
 * fica no audit, que e a fonte da verdade.
 */
export function codigoIpcDe(recusa: ControlRecusa): IpcAckMessage['code'] {
  switch (recusa) {
    case 'SHUTDOWN_IN_PROGRESS':
      return 'SHUTDOWN_IN_PROGRESS'
    case 'MODO_RESTRITO':
      return 'RESTRICTED_MODE'
    case 'SEM_SEGREDO_FORTE':
      return 'INTERNAL'
    case 'TERMINAL_SEM_RESET':
      return 'TUNNEL_FAILED'
    case 'NONCE_AUSENTE':
    case 'NONCE_INVALIDO':
    case 'NONCE_EXPIRADO':
      return 'NONCE_INVALID'
  }
}

/**
 * Deriva o `result` do ack a partir do resultado do despacho.
 *
 * `ControlResultado` nao carrega "accepted vs noop" — so o estado apos o
 * despacho e a recusa. A derivacao e a tabela de 01-ARQUITETURA 9.2:
 *
 *   - `start` -> `STARTING`/`DEGRADED`: accepted (a subida esta em curso);
 *     `READY`: noop (ja estava online; a URL vigente vem na difusao);
 *     `FAILED` sem recusa: rejected `PROBE_FAILED` (CTL-013);
 *   - `stop` -> `STOPPING`: accepted; `STOPPED`/`FAILED`: noop;
 *   - `reset` -> `STOPPED`: accepted; resto: noop.
 */
export function resultadoDoAck(
  action: ControlAction,
  resultado: ControlResultado,
): { readonly result: 'accepted' | 'noop' | 'rejected'; readonly code?: IpcAckMessage['code'] } {
  if (resultado.recusa !== undefined) return { result: 'rejected', code: codigoIpcDe(resultado.recusa) }

  switch (action) {
    case 'start':
      if (resultado.estado === 'STARTING' || resultado.estado === 'DEGRADED') return { result: 'accepted' }
      if (resultado.estado === 'READY') return { result: 'noop' }
      return { result: 'rejected', code: 'PROBE_FAILED' }
    case 'stop':
      if (resultado.estado === 'STOPPING') return { result: 'accepted' }
      return { result: 'noop' }
    case 'reset':
      if (resultado.estado === 'STOPPED') return { result: 'accepted' }
      return { result: 'noop' }
  }
}

/** Resposta de erro a uma intent (o `ack` e sempre emitido; o erro, nos caminhos de falha). */
function erro(intent: IpcIntentMessage, code: IpcErrorMessage['code'], message: string): IpcErrorMessage {
  return { v: IPC_PROTOCOL_VERSION, type: 'error', requestId: intent.requestId, code, message }
}

/** Resposta de ack a uma intent. */
function ack(intent: IpcIntentMessage, result: IpcAckMessage['result'], state: TunnelState): IpcAckMessage {
  return { v: IPC_PROTOCOL_VERSION, type: 'ack', requestId: intent.requestId, result, state }
}

export function criarRespondedorIpc(deps: RespondedorIpcDeps): RespondedorIpc {
  const { log } = deps

  const estadoAtual = (): TunnelState => deps.controller?.snapshot().state ?? 'STOPPED'

  const controlIntentDe = (intent: IpcIntentMessage, action: ControlAction, nonce?: string): ControlIntent => ({
    action,
    requestedBy: `telegram:${String(intent.from)}`,
    requestId: intent.requestId,
    ...(nonce === undefined ? {} : { nonce }),
    at: deps.agora(),
  })

  /**
   * `tunnel.up`/`tunnel.down`: decide de forma SINCRONA quando possivel; o
   * `start` a partir de `STOPPED` responde `accepted` ja e corre na fila.
   */
  const despacharControle = (intent: IpcIntentMessage, action: ControlAction, nonce: string | undefined): IpcMessageToWorker => {
    if (!deps.modoTunel || deps.controller === undefined) {
      return erro(
        intent,
        'EXPOSURE_DISABLED',
        'A exposicao esta desativada nesta instalacao. Defina exposure.mode como tunnel para ligar o tunel.',
      )
    }

    const controlIntent = controlIntentDe(intent, action, nonce)
    const decidido = deps.controller.decidirSincrono(controlIntent)
    if (decidido === null) {
      // Trabalho lento: aceita ja, difunde o resto depois (o padrao do IPC).
      void deps.controller.despachar(controlIntent)
      return ack(intent, 'accepted', estadoAtual())
    }
    const veredito = resultadoDoAck(action, decidido)
    return veredito.code === undefined
      ? ack(intent, veredito.result, decidido.estado)
      : { ...ack(intent, veredito.result, decidido.estado), code: veredito.code }
  }

  return (intent: IpcIntentMessage): IpcMessageToWorker => {
    // 1. IDENTIDADE (S6): o host re-verifica contra o pareamento persistido,
    //    ANTES de tocar na maquina de estado (CTL-029), e conta no audit.
    if (!deps.pareado(intent.from, intent.chat)) {
      try {
        deps.audit.append({
          evento: `${EVENTO_NAO_PAREADO}:telegram:${String(intent.from)}`,
          resultado: 'negado',
        })
      } catch (error) {
        log.error(
          `falha ao registar a recusa de identidade no audit: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      log.warn(`intencao '${intent.intent}' de identidade nao pareada (from ${String(intent.from)}); recusada.`)
      return erro(intent, 'NOT_PAIRED', 'Este chat nao esta pareado com o dono do tunel.')
    }

    switch (intent.intent) {
      case 'tunnel.up':
        return despacharControle(intent, 'start', intent.nonce)
      case 'tunnel.down':
        return despacharControle(intent, 'stop', undefined)
      case 'emergency': {
        // Kill switch: sem nonce (CTL-024). Tunel primeiro, sessoes depois.
        if (deps.controller !== undefined) {
          void deps.controller.despachar(controlIntentDe(intent, 'stop')).then(() => deps.aposEmergencia(intent))
        } else {
          // Sem tunel nao ha o que derrubar; a invalidacao continua a valer.
          deps.aposEmergencia(intent)
        }
        return ack(intent, 'accepted', estadoAtual())
      }
      case 'tunnel.status': {
        // Leitura pura; NAO estende o TTL (TUN-026). Reenvia o estado
        // completo — e assim que um worker (re)conectado se sincroniza.
        deps.reemitirEstado()
        return ack(intent, 'noop', estadoAtual())
      }
      case 'session.issue':
      case 'secret.rotate':
        log.warn(
          `intencao '${intent.intent}' ainda sem tratamento nesta onda; respondida INTERNAL. ` +
            'A magia de T2.2/T3.4 e a rotacao de T2.1 entram pela costura pos-onda.',
        )
        return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.')
    }
  }
}
