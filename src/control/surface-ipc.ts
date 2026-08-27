/**
 * A SUPERFICIE Telegram do controlador: mapeia `IpcIntentMessage` (o canal
 * host <-> worker de T4.3, `src/ipc/channel.ts`) para `ControlIntent` e
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
 * A COSTURA (item 5) fia `session.issue` e `secret.rotate`: o /acessar (e o
 * auto-link do /ligar) emite a CHAVE NO LINK (`LinkTokenSurface.emitir`) e
 * notifica o dono com `https://<url>?key=<token>` por `notify` (TG-085) — quem
 * abre entra DIRETO, sem senha (modelo expose-port da Onda 1); o /rotacionar
 * consome o nonce no HOST, regenera o segredo (SECRET-008: sessoes invalidadas)
 * e revoga a chave no link, notificando SEM enviar a senha pelo chat. Sem a
 * chave/rotacao fiadas, os dois respondem `INTERNAL` — fail-closed.
 */

import type { AuditSink, SecretStore } from '../contracts/auth.ts'
import type { ControlAction, ControlIntent, ControlRecusa, ControlResultado } from '../contracts/control.ts'
import { comporTextoLinkMagico } from '../audit/notify.ts'
import type { ConfirmServiceComVeredito } from './confirm.ts'
import type { LinkTokenSurface } from '../contracts/link-token.ts'
import type { MagicStore } from '../session/magic.ts'
import type {
  IpcAckMessage,
  IpcErrorMessage,
  IpcIntentMessage,
  IpcMessageToWorker,
  IpcNonceRequestMessage,
} from '../contracts/ipc.ts'
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
   * `from`/`chat` sao STRING (envelope IPC V2 — EMENDA ONDA-1-IPC-ENVELOPE-STRING).
   */
  readonly pareado: (from: string, chat: string) => boolean
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
  /**
   * O ConfirmService do HOST (T5.1, partilhado com o controlador). Usado pelo
   * `secret.rotate` para consumir o nonce com a acao 'reset' (o worker pediu-o
   * pela ponte EMENDA-COSTURA-5). AUSENTE: `secret.rotate` responde INTERNAL.
   */
  readonly confirm?: Pick<ConfirmServiceComVeredito, 'consumirComVeredito'> | undefined
  /**
   * O MagicStore (T2.2) do link magico. Usado pelo `session.issue` (/acessar).
   * AUSENTE: `session.issue` responde INTERNAL (o estado de antes da costura).
   *
   * >>> ONDA 2: com o modelo expose-port o accesso pelo tunel entra por
   * SESSAO ou pela CHAVE NO LINK (`?key=<token>`, `src/session/link-token.ts`).
   * O link do bot compoe `?key=<token>` via `emitir()` — NUNCA mais o `#mk=`
   * nem a senha permanente. `magic` continua no contrato por compatibilidade,
   * mas o `session.issue` usa `linkToken` quando presente. <<<
   */
  readonly magic?: MagicStore | undefined
  /**
   * O STORE da CHAVE NO LINK (onda 1, `src/contracts/link-token.ts`). Usado
   * pelo `session.issue` (/acessar e auto-link) para compor `https://<url>?key=<token>`.
   * A chave viaja UMA vez, no retorno de `emitir()`, e dali so para a URL que o
   * dono recebe por `notify`. AUSENTE: `session.issue` responde INTERNAL.
   */
  readonly linkToken?: LinkTokenSurface | undefined
  /** `SecretStore.rotate` — o /rotacionar regenera o segredo e invalida sessoes. */
  readonly secretos?: Pick<SecretStore, 'rotate'> | undefined
  /** Envia um `notify` ao dono (o link magico / a instrucao local da rotacao). */
  readonly notificarDono?: ((texto: string) => void) | undefined
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
    requestedBy: `telegram:${intent.from}`,
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
      // Trabalho lento: aceita ja, difunde o resto depois (o padrao do IPC). O
      // despacho "nunca rejeita" por contrato, mas um defeito nao pode virar
      // unhandled rejection — o ack JA saiu (linha acima), o erro e logado e
      // segue (Frente 4, Onda 6).
      void deps.controller.despachar(controlIntent).catch((error) => {
        log.error(
          `falha no despacho pos-ack de ${action}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
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
          evento: `${EVENTO_NAO_PAREADO}:telegram:${intent.from}`,
          resultado: 'negado',
        })
      } catch (error) {
        log.error(
          `falha ao registar a recusa de identidade no audit: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      log.warn(`intencao '${intent.intent}' de identidade nao pareada (from ${intent.from}); recusada.`)
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
          // (b) O despacho pode LANCAR DE FORMA SINCRONA (controlador avariado:
          // persistirIntencao/supervisor a rebentar). O throw vira ack de erro,
          // nunca escapa — o "ack sempre emitido" e o contrato do canal (Q-5).
          try {
            // (a) A promise DERIVADA (despachar + aposEmergencia) tem catch: se
            // o aposEmergencia (ou o despacho) rejeitar DEPOIS do ack, o erro e
            // logado e segue — um kill switch falho nunca derruba o processo
            // por uma promise sem catch (Frente 4, Onda 6).
            void deps.controller
              .despachar(controlIntentDe(intent, 'stop'))
              .then(() => deps.aposEmergencia(intent))
              .catch((error) => {
                log.error(
                  `falha no /emergencia apos o ack: ${error instanceof Error ? error.message : String(error)}`,
                )
              })
          } catch (error) {
            log.error(
              `falha ao despachar o /emergencia: ${error instanceof Error ? error.message : String(error)}`,
            )
            return erro(intent, 'INTERNAL', 'Nao foi possivel processar o pedido. Tente novamente.')
          }
        } else {
          // Sem tunel nao ha o que derrubar; a invalidacao continua a valer.
          // Best-effort tambem aqui: um aposEmergencia avariado nao pode
          // impedir o ack ("ack sempre emitido").
          try {
            deps.aposEmergencia(intent)
          } catch (error) {
            log.error(
              `falha no /emergencia (sem tunel): ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        return ack(intent, 'accepted', estadoAtual())
      }
      case 'tunnel.status': {
        // Leitura pura; NAO estende o TTL (TUN-026). Reenvia o estado
        // completo — e assim que um worker (re)conectado se sincroniza.
        deps.reemitirEstado()
        return ack(intent, 'noop', estadoAtual())
      }
      case 'session.issue': {
        // Item 5 (costura) + ONDA 2 (expose-port): /acessar e o auto-link
        // pedem o acesso por LINK COM A CHAVE EMBUTIDA. O host compoe
        // `${url}?key=${token}` a partir do `LinkTokenSurface.emitir()` e
        // notifica o dono — quem abre entra DIRETO, sem senha e sem prompt.
        // O token e reutilizavel ate `revogar()` (rotacao do segredo) e sai
        // UMA vez do `emitir()`; NUNCA e logado (a URL com a chave nunca vai
        // ao log). A resposta `accepted` e INVISIVEL no worker de proposito —
        // o link chega por notify (A2/TG-085).
        if (deps.linkToken === undefined || deps.notificarDono === undefined) {
          log.warn(`intencao 'session.issue' sem chave-fiada; respondida INTERNAL (fail-closed).`)
          return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.')
        }
        const snap = deps.controller?.snapshot()
        const url = snap?.state === 'READY' ? snap.info?.url : undefined
        if (url === undefined) {
          // Sem tunel online nao ha painel para onde apontar o link.
          return erro(intent, 'INTERNAL', 'O tunel nao esta online; ligue-o antes de pedir o acesso.')
        }
        const emitido = deps.linkToken.emitir()
        // A URL COMPOSTA pelo host, nunca por um log: o token sai 1x aqui,
        // direto para o notify — o log so ve que a chave foi emitida, nunca o
        // valor nem a URL com `?key=`.
        deps.notificarDono(comporTextoLinkMagico(deps.agora(), url, emitido.token, emitido.expiraEm))
        return ack(intent, 'accepted', estadoAtual())
      }
      case 'secret.rotate': {
        // Item 5 (costura): /rotacionar regenera o segredo e invalida as
        // sessoes vivas (SECRET-008 — o SecretStore revoga ANTES de publicar).
        // O nonce e exigido (AUMENTA o risco de bloqueio do atacante) e e
        // consumido AQUI, no HOST (S5); a ponte do worker pediu-o como 'reset'
        // (EMENDA-COSTURA-5). A senha nova NUNCA sai pelo chat: so a
        // instrucao do caminho local/terminal.
        if (deps.secretos === undefined || deps.confirm === undefined || deps.notificarDono === undefined) {
          log.warn(`intencao 'secret.rotate' sem rotacao fiada; respondida INTERNAL (fail-closed).`)
          return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.')
        }
        const veredito = deps.confirm.consumirComVeredito(intent.nonce ?? '', 'reset')
        if (veredito !== 'ok') {
          // CTL-021/022: nonce desconhecido/consumido ou expirado.
          return { ...ack(intent, 'rejected', estadoAtual()), code: 'NONCE_INVALID' }
        }
        // O retorno carrega o display (que contem a senha) — ignorado aqui de
        // proposito: nunca logado, nunca enviado (S3/Q-4).
        void deps.secretos.rotate()
        deps.notificarDono(
          'Chave de acesso nova gerada: a anterior foi revogada e as sessões ' +
            'atuais invalidadas. O link novo que o bot enviar terá a chave ' +
            'nova embutida — quem usar um link antigo não entra mais.',
        )
        return ack(intent, 'accepted', estadoAtual())
      }
    }
  }
}

/* ========================================================================== */
/* O RESPONDEDOR DE NONCE — EMENDA-COSTURA-5 (transporte IPC do nonce)        */
/* ========================================================================== */

/**
 * O lado HOST do transporte do nonce (EMENDA-COSTURA-5, `src/contracts/ipc.ts`):
 * responde a `nonce.request` do worker com `nonce.issued` emitido pelo
 * `ConfirmService` de T5.1 (via controlador). O nonce viaja SÓ pelo pipe
 * host <-> worker; NUNCA e logado (S3) — so o prazo e a acao podem ir ao log.
 *
 * SEM CONTROLADOR (modo loopback), responde `EXPOSURE_DISABLED` — fail-closed:
 * um nonce que nao chega ao worker nao autoriza nada (CTL-023).
 */
export interface RespondedorNonceDeps {
  /** O controlador (fonte do `ConfirmService`). `undefined` em modo loopback. */
  readonly controller: TunnelController | undefined
  readonly log: GuardLogger
}

export type RespondedorNonce = (request: IpcNonceRequestMessage) => IpcMessageToWorker

export function criarRespondedorDeNonce(deps: RespondedorNonceDeps): RespondedorNonce {
  const { log } = deps
  return (request: IpcNonceRequestMessage): IpcMessageToWorker => {
    if (deps.controller === undefined) {
      log.warn(`pedido de nonce sem controlador (modo loopback); respondido EXPOSURE_DISABLED (acao ${request.acao}).`);
      return {
        v: IPC_PROTOCOL_VERSION,
        type: 'error',
        requestId: request.requestId,
        code: 'EXPOSURE_DISABLED',
        message: 'A exposicao esta desativada nesta instalacao. Defina exposure.mode como tunnel para ligar o tunel.',
      }
    }
    const emitido = deps.controller.emitirNonce(request.acao)
    // S3: o VALOR do nonce nunca vai ao log nem ao texto — so o prazo, que e
    // o que o worker precisa para expirar o teclado de confirmacao.
    log.debug(`nonce emitido para ${request.acao} (expira em ${String(emitido.expiresAt)}).`)
    return {
      v: IPC_PROTOCOL_VERSION,
      type: 'nonce.issued',
      acao: request.acao,
      requestId: request.requestId,
      nonce: emitido.valor,
      expiresAt: emitido.expiresAt,
    }
  }
}
