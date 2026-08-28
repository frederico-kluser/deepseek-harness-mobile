/**
 * O REGISTRY DE PROVEDORES e a PONTE IPC REAL (onda 4 — boot generico).
 *
 * Este ficheiro e DONO de `worker/providers/` (o que NAO e `telegram/**`):
 * diz ao boot GENERICO qual e o provedor ativo (por `DSH_GUARD_PROVIDER`,
 * com default fechado `telegram`), fabrica o {@link SurfaceIpcBridge} REAL
 * (o envio de intents pelo canal `worker/ipc.ts`, com a conversao numerica de
 * `userKey`/`chatKey` NA FONTE) e porteia a PONTE DE NONCE da costura antiga
 * (`worker/commands/costura.ts`, que a Onda 5 apaga — aqui a sua logica vive).
 *
 * ===========================================================================
 * A RESOLUCAO DO PROVEDOR (D1) — FAIL-CLOSED
 * ===========================================================================
 * A variavel `DSH_GUARD_PROVIDER` e injetada PELO HOST em
 * `src/proc/env.ts::buildWorkerEnv`; o worker NAO a adivinha pelo nome do
 * `tokenVar`. O valor e um ROTULO (o worker nao autoriza nada com ele — quem
 * valida e o HOST). Ausente ou vazio = `telegram` (D1, o unico que o host
 * conhece hoje); um valor DESCONHECIDO recusa a arrancar com erro claro —
 * nunca degrada em silencio para o default (um provider digitado mal seria
 * um bot a nascer com o token de OUTRO provedor).
 *
 * ===========================================================================
 * A PONTE DE INTENT — ENVELOPE STRING NA FONTE (D4 / EMENDA ONDA-1-IPC-ENVELOPE-STRING)
 * ===========================================================================
 * O contrato NEUTRO carrega `userKey`/`chatKey` como STRINGS
 * (`SurfaceIdentity`, D4) e o envelope IPC V2 (`src/contracts/ipc.ts`) tipa
 * `from`/`chat` como STRING tambem — a conversao numerica que vivia AQUI
 * (V1, heranca Telegram) foi neutralizada: {@link montarEnvelopeDeIntent}
 * recebe {@link IntencaoNeutra} e monta o `IpcIntentMessage` completo
 * (`v:2`, `type:'intent'`, `from: userKey`, `chat: chatKey`) SEM `Number(...)`.
 * O que outrora era o "preco de coexistir com o envelope V1" (ids
 * nao-numericos quebravam o cast) deixou de existir: um snowflake do Discord
 * atravessa a ponte byte a byte, sem truncar em Number.MAX_SAFE_INTEGER.
 *
 * E a falsa atribuicao `as unknown as IpcIntentMessage` que a Onda 2 deixou
 * como "pegada" em `worker/surface/commands.ts` DEIXA de ser o unico caminho:
 * o boot consome a ponte REAL daqui. NaO se alterou `commands.ts` (dono de
 * outra onda); a neutralizacao completa do envelope era o trabalho futuro
 * anotado no manual (docs/PROVIDERS.md §7) — esta onda o executa.
 */

import {
  IPC_PROTOCOL_VERSION,
  type ControlAction,
  type IpcIntentMessage,
  type IpcMessageToWorker,
} from '../../src/contracts/ipc.ts'
import type { TimeSource } from '../lib/clock.ts'
import type { WorkerLogger } from '../lib/log.ts'
import type { WorkerIpc } from '../ipc.ts'
import type { EmitirNonce, IntencaoNeutra, SurfaceIpcBridge } from '../surface/contract.ts'
import type { SurfaceAction } from '../surface/contract.ts'
import { gerarRequestId } from '../surface/tokens.ts'

import { createTelegramProvider, type TelegramAdapter } from './telegram/adapter.ts'
import {
  API_ROOT_ENV_VAR as TELEGRAM_API_ROOT_ENV_VAR,
  assertTokenNotInArgv,
  lerTokenDoAmbiente,
} from './telegram/token.ts'

import { createDiscordProvider, type DiscordAdapter } from './discord/adapter.ts'
import {
  API_ROOT_ENV_VAR as DISCORD_API_ROOT_ENV_VAR,
  assertTokenNotInArgv as assertDiscordTokenNotInArgv,
  lerTokenDoAmbiente as lerTokenDiscordDoAmbiente,
} from './discord/token.ts'

/* ========================================================================== */
/* 1. O ROTULO DO PROVEDOR (D1)                                               */
/* ========================================================================== */

/** Nome que o HOST escreve no ambiente do worker. Contrato com o host. */
export const WORKER_PROVIDER_ENV_VAR = 'DSH_GUARD_PROVIDER'

/** O identificador fechado do provedor ativo. `telegram` e `discord`. */
export type ProviderId = 'telegram' | 'discord'

/** O default fechado (D1): ausente em config/estado = telegram. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'telegram'

/**
 * Provedor desconhecido: um `DSH_GUARD_PROVIDER` que nenhum {@link PROVIDERS}
 * conhece. FAIL-CLOSED — quem chamou pediu um provedor que nao existe e o
 * boot nao pode adivinhar um substituto (seria nascer com o token de outro).
 */
export class ProvedorDesconhecidoError extends Error {
  override readonly name = 'ProvedorDesconhecidoError'
  readonly id: string

  constructor(id: string) {
    super(
      `[worker/providers] provedor desconhecido: "${id}". Os antecipados sao: ` +
        Object.keys(PROVIDERS).join(', ') +
        '. O rotulo vem de ' +
        WORKER_PROVIDER_ENV_VAR +
        ' (injetado pelo host); NUNCA degrade para o default num valor desconhecido.',
    )
    this.id = id
  }
}

/* ========================================================================== */
/* 2. A TABELA PROVIDER -> DESCRICAO DE BOOT                                   */
/* ========================================================================== */

/**
 * Tudo o que o BOOT generico precisa SABER de um provedor para o arrancar, sem
 * conhecer o provedor. O telegram e uma ENTRADA aqui; um provedor futuro
 * acrescenta a SUA linha e o seu `create` — nunca edita a linha de outrem.
 */
export interface ProvedorDescrito {
  readonly id: ProviderId
  /** Fabrica o adaptador. A assinatura e o minimo que o boot fornece. */
  readonly create: (deps: ProvedorCreateDeps) => TelegramAdapter
  /** Le o token do ambiente (o `tokenVar` proprio do provedor). */
  readonly lerToken: (env: NodeJS.ProcessEnv) => string
  /** Recusa arrancar com token na linha de comandos (TG-069). */
  readonly assertTokenNaoEmArgv: (argv: readonly string[], token?: string) => void
  /**
   * Nome da variavel de ambiente com a raiz da API do provedor (duble de
   * teste). O BOOT generico le `env[apiRootVar]` e passa o valor como
   * `apiRoot` ao `create` SO quando definido — cada provedor com a SUA
   * variavel, sem vazamento cruzado (o boot da Onda 4 lia a raiz do telegram
   * para qualquer provedor). `undefined` = o provedor nao tem raiz via env.
   */
  readonly apiRootVar?: string
}

/** As deps que o boot passa ao `create` de QUALQUER provedor. */
export interface ProvedorCreateDeps {
  readonly token: string
  /** Raiz da Bot API (duplo de teste). Omitido, a oficial. */
  readonly apiRoot?: string
  readonly log: WorkerLogger
  readonly time?: TimeSource
}

const DESCRICAO_TELEGRAM: ProvedorDescrito = {
  id: 'telegram',
  apiRootVar: TELEGRAM_API_ROOT_ENV_VAR,
  create: (deps: ProvedorCreateDeps): TelegramAdapter => createTelegramProvider(deps),
  lerToken: (env: NodeJS.ProcessEnv): string => lerTokenDoAmbiente(env),
  assertTokenNaoEmArgv: (argv: readonly string[], token?: string): void =>
    assertTokenNotInArgv(argv, token),
}

const DESCRICAO_DISCORD: ProvedorDescrito = {
  id: 'discord',
  apiRootVar: DISCORD_API_ROOT_ENV_VAR,
  create: (deps: ProvedorCreateDeps): DiscordAdapter => createDiscordProvider(deps),
  lerToken: (env: NodeJS.ProcessEnv): string => lerTokenDiscordDoAmbiente(env),
  assertTokenNaoEmArgv: (argv: readonly string[], token?: string): void =>
    assertDiscordTokenNotInArgv(argv, token),
}

/** A tabela FECHADA provedor -> descricao. Acrescentar um provedor = +1 linha. */
export const PROVIDERS: Readonly<Record<ProviderId, ProvedorDescrito>> = Object.freeze({
  telegram: DESCRICAO_TELEGRAM,
  discord: DESCRICAO_DISCORD,
})

/**
 * Resolve o provedor ativo. Ausente/vazio -> `telegram` (D1); desconhecido ->
 * {@link ProvedorDesconhecidoError} (fail-closed, nunca degrada em silencio).
 */
export function resolverProvedor(env: NodeJS.ProcessEnv): ProvedorDescrito {
  const bruto = env[WORKER_PROVIDER_ENV_VAR]
  if (bruto === undefined || bruto.trim() === '') return PROVIDERS.telegram
  const id = bruto.trim()
  const encontrado = Object.values(PROVIDERS).find((p) => p.id === id) ?? undefined
  if (encontrado === undefined) throw new ProvedorDesconhecidoError(id)
  return encontrado
}

/* ========================================================================== */
/* 3. A PONTE DE INTENT — envelope STRING NA FONTE (V2)                        */
/* ========================================================================== */

/**
 * A intent NEUTRA que o boot/pubProvider monta — chaves STRING (D4).
 *
 * DONO unico em `worker/surface/contract.ts` (uma so forma para a ponte, os
 * comandos e o nucleo); este ficheiro re-exporta-a para quem consume a ponte
 * aqui (o boot generico de `worker/telegram-bot.ts` e o teste do registry).
 */
export type { IntencaoNeutra } from '../surface/contract.ts'

/**
 * Monta o {@link IpcIntentMessage} COMPLETO a partir da intencao NEUTRA.
 *
 * EM V2 NAO HA CONVERSAO: o envelope `from`/`chat` e STRING, como a fronteira
 * neutra (D4) os entrega. O `userKey`/`chatKey` ja normalizados (trim +
 * nao-vazio, `worker/surface/ids.ts`) viajam direto para o envelope — um id
 * nao-numerico de um provedor futuro atravessa intacto, sem `Number(...)` nem
 * truncagem em Number.MAX_SAFE_INTEGER. A montagem mora NA PONTE (na fonte do
 * envio), e NAO espalhada pelos comandos — a falsa atribuicao da Onda 2 deixa
 * de ser o unico caminho. (Neutralizacao completa do corpo do canal: EMENDA
 * ONDA-1-IPC-ENVELOPE-STRING, docs/PROVIDERS.md §7.)
 */
export function montarEnvelopeDeIntent(pedido: IntencaoNeutra): IpcIntentMessage {
  return {
    v: IPC_PROTOCOL_VERSION,
    type: 'intent',
    intent: pedido.intent,
    requestId: pedido.requestId,
    from: pedido.userKey,
    chat: pedido.chatKey,
    ...(pedido.nonce === undefined ? {} : { nonce: pedido.nonce }),
  }
}

/**
 * A ponte de intent REAL que o NUCLEO consome como {@link SurfaceIpcBridge}:
 * `send(IntencaoNeutra)` -> monta o envelope STRING NA FONTE (a
 * {@link montarEnvelopeDeIntent}) -> `WorkerIpc.send` (o canal `worker/ipc.ts`).
 *
 * A montagem do envelope `from`/`chat` a partir de `userKey`/`chatKey` e
 * responsabilidade DESTA ponte, nunca do nucleo nem dos comandos (onda 5a);
 * em V2 os quatro campos sao todos STRING, e nao ha conversao.
 */
export function criarSurfaceIpcBridge(ipc: WorkerIpc): SurfaceIpcBridge {
  return {
    send: (pedido: IntencaoNeutra): boolean => ipc.send(montarEnvelopeDeIntent(pedido)),
    /**
     * O pareamento concluiu NO WORKER (`/parear <codigo>` valido). Emite
     * `pairing.success` pelo canal, Na FONTE da conversao numerica (analogo ao
     * `send`). NAO autoriza nada por si: quem valida intents e o HOST (S6).
     */
    pairingSuccess: (dono): void => {
      // Best-effort/fire-and-forget (S4): o retorno do send nao derruba o
      // nucleo — quem re-pareia depois re-envia. O `pairedAt` viaja fiel; os
      // dois eixos viajam STRING (V2), sem `Number(...)`.
      ipc.send({
        v: IPC_PROTOCOL_VERSION,
        type: 'pairing.success',
        from: dono.userKey,
        chat: dono.chatKey,
        pairedAt: dono.pairedAt,
      })
    },
  }
}

/* ========================================================================== */
/* 4. A PONTE DE NONCE (port da costura antiga — Onda 5 apaga a costura)      */
/* ========================================================================== */

/** Teto de espera por `nonce.issued`. Fail-closed: sem resposta, `undefined`. */
export const NONCE_REQUEST_TIMEOUT_MS = 5_000

/**
 * O intent -> a `ControlAction` para a qual o nonce e emitido. So as acoes que
 * AUMENTAM exposicao pedem nonce (CTL-023/024); `secret.rotate` cai na familia
 * do `reset` (destrutiva: regenera o segredo e invalida sessoes).
 */
const ACAO_PARA_NONCE: Readonly<Partial<Record<SurfaceAction, ControlAction>>> = {
  'tunnel.up': 'start',
  'secret.rotate': 'reset',
}

export interface PonteDeNonce {
  /** Pede um nonce ao host e aguarda `nonce.issued` (timeout fail-closed). */
  readonly emitir: EmitirNonce
  /**
   * Consome as mensagens do canal que dizem respeito a pedidos de nonce.
   * `true` = consumida (nao deve chegar ao roteador/nucleo); `false` = nao e
   * do nonce (segue o despacho normal).
   */
  readonly onMessage: (msg: IpcMessageToWorker) => boolean
}

/**
 * A ponte de producao do nonce: `nonce.request` pelo canal e `nonce.issued` de
 * volta, com TIMEOUT fail-closed (EMENDA-COSTURA-5). O valor do nonce NUNCA e
 * logado (S3) e NUNCA e interpretado aqui (S5) — so o prazo e a acao vao ao log.
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
    const enviado = deps.ipc.send({ v: IPC_PROTOCOL_VERSION, type: 'nonce.request', acao: controlo, requestId })
    if (!enviado) {
      // Canal indisponivel: falha FECHADO ja, sem esperar o timeout.
      log.warn('emitirNonce sem canal para o host: confirmacao indisponivel (fail-closed, CTL-023)', {
        acao,
      })
      return undefined
    }
    return new Promise<string | undefined>((resolve) => {
      pendentes.set(requestId, resolve)
      void deps.time.sleep(NONCE_REQUEST_TIMEOUT_MS).then(() => {
        const pendente = pendentes.get(requestId)
        if (pendente === undefined) return undefined
        pendentes.delete(requestId)
        log.warn(
          `nonce nao chegou a tempo (${String(NONCE_REQUEST_TIMEOUT_MS)} ms); confirmacao indisponivel`,
          { acao },
        )
        pendente(undefined)
        return undefined
      })
    })
  }

  const onMessage = (msg: IpcMessageToWorker): boolean => {
    if (msg.type === 'nonce.issued') {
      const pendente = pendentes.get(msg.requestId)
      if (pendente === undefined) {
        // Resposta tardia de um pedido ja resolvido (timeout ou repetido).
        return true
      }
      pendentes.delete(msg.requestId)
      pendente(msg.nonce)
      return true
    }
    if (msg.type === 'error' && msg.requestId !== undefined) {
      const pendente = pendentes.get(msg.requestId)
      if (pendente !== undefined) {
        // O host recusou emitir (ex.: modo loopback): falha fechado JA. O erro
        // NAO vai ao nucleo (nao ha intent pendente para ele — mostra-lo ao
        // dono seria duplicar a mensagem de confirmacao indisponivel).
        pendentes.delete(msg.requestId)
        pendente(undefined)
        return true
      }
    }
    return false
  }

  return { emitir, onMessage }
}