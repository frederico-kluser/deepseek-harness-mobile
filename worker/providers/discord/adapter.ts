/**
 * O ADAPTADOR DISCORD: `createDiscordProvider(deps) -> ProviderAdapter`.
 * Consome SO o contrato neutro `worker/surface/contract.ts` (e, como
 * referencia de consumo, `worker/surface/core.ts`); o WebSocket nativo e o
 * `fetch` vivem EXCLUSIVAMENTE neste diretorio — SEM SDK, SEM dependencia
 * nova (`package.json`/`pnpm-lock` intactos).
 *
 * ===========================================================================
 * A DIVISAO (D4)
 * ===========================================================================
 * ENTRADA: o adaptador e DONO do SEU proprio loop de consumo (o gateway por
 * WebSocket) e EMPURRA {@link SurfaceEvent} para o handler que o nucleo lhe
 * passa em `start(handleEvent)`. SAIDA: `sender()` fornece o
 * {@link SurfaceSender} neutro com que o nucleo envia/edita/responde. O
 * nucleo NAO conhece o gateway nem o REST.
 *
 * SNOWFLAKES STRING NA FRONTEIRA (D4): `userKey`/`chatKey` nascem STRING no
 * parse (`String(...)` na fronteira, uma unica vez) e viajam STRING por todo
 * o sender — o `Number(...)` NAO existe neste adaptador: um snowflake
 * (> 2^53) truncaria silenciosamente no cast (o envelope IPC V2 existe por
 * isso).
 *
 * ===========================================================================
 * LIMITES — o que o nucleo usa para cortar e renderizar (doc oficial)
 * ===========================================================================
 * maxTextLength 2000 (o teto de `content` de UMA mensagem), maxActionRows 5
 * e maxActionPerRow 5 (o teto de ActionRows e de botoes por linha),
 * maxActionDataBytes 100 (o `custom_id`, 1..100 caracteres; o payload
 * `g1:<acao>:<token>` e ASCII — bytes == chars), supportsEditing true
 * (`PATCH /channels/{id}/messages/{id}`).
 *
 * ===========================================================================
 * PUBLISHCOMMANDS: NO-OP DOCUMENTADO
 * ===========================================================================
 * O `setMyCommands` do Telegram nao tem equivalente REST para um bot do
 * Discord sem registro de slash commands: publicar comandos exigiria
 * `POST /applications/{id}/commands` (mudanca de modelo — o nucleo entende
 * TEXTO LIVRE, nao slash commands) e o id da aplicacao, que o token sozinho
 * nao da. O contrato manda best-effort: este adaptador registra e resolve.
 */

import type {
  ProviderAdapter,
  SurfaceEditOutcome,
  SurfaceEvent,
  SurfaceLimits,
  SurfacePublishedCommand,
  SurfaceSender,
  SurfaceSendOptions,
} from '../../surface/contract.ts'

import { criarClienteDiscord, type ClienteDiscord, type CorpoDeMensagem } from './cliente.ts'
import { iniciarGateway, type GatewayDeps, type GatewayRoda } from './gateway.ts'
import { lerApiRootDoAmbiente } from './token.ts'
import { criarParse } from './parse.ts'
import { answerCallbackAlways, editMessageInPlace, renderActionRowLayout } from './teclado.ts'
import { comAutoRetry } from './transporte.ts'
import type { TimeSource, WorkerLogger } from './interno.ts'
import { systemTime } from './interno.ts'

/** As dependencias que o boot injeta ao criar o adaptador. */
export interface DiscordProviderDeps {
  readonly token: string
  /**
   * Raiz da API do Discord (duble de teste). Omitida, a raiz do ambiente
   * (`DISCORD_API_ROOT`) e, na falta dela, a publica `https://discord.com/api/v10`.
   */
  readonly apiRoot?: string
  /** URL do gateway injetada (duble de teste). Omitida: via `GET /gateway/bot`. */
  readonly gatewayUrl?: string
  readonly log: WorkerLogger
  readonly time?: TimeSource
  /** Intents do identify. Omitidos: {@link INTENTS_DO_BOT}. */
  readonly intents?: number
  /** Construtor WebSocket injetavel (duble). Omitido: o global do Node 24. */
  readonly WebSocketCtor?: typeof WebSocket
  /** Jitter do primeiro heartbeat (0..1). Omitido: `Math.random` (doc oficial). */
  readonly jitter?: () => number
  /** Escalada de backoff em ms (duble de teste). Omitida: a padrao. */
  readonly backoffMs?: readonly number[]
  /** Prazo de arranque ate READY/RESUMED (duble de teste). */
  readonly bootTimeoutMs?: number
  /** Teto de espera de uma chamada REST. Omitido: {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** `fetch` injetavel (duble). Omitido: o global do Node 24. */
  readonly buscar?: typeof fetch
}

/** Limites do provedor discord (D4, doc oficial). O nucleo corta/renderiza por aqui. */
export const DISCORD_LIMITS: SurfaceLimits = Object.freeze({
  maxTextLength: 2000,
  maxActionRows: 5,
  maxActionPerRow: 5,
  maxActionDataBytes: 100,
  supportsEditing: true,
})

/** A superficie exposta: o contrato + o contador de descartes (TG-089). */
export type DiscordAdapter = ProviderAdapter & {
  /** Quantos payloads o adaptador descartou desde `start` (TG-089). */
  readonly descartados: () => number
}

/**
 * Cria o PROVIDER discord — a superficie completa que o boot generico consome.
 *
 * @throws {Error} `TOKEN_MISSING` quando o token e vazio (o boot deve VALIDAR
 *   com `lerTokenDoAmbiente` e `assertTokenNotInArgv` de `./token.ts` ANTES).
 */
export function createDiscordProvider(deps: DiscordProviderDeps): DiscordAdapter {
  const time = deps.time ?? systemTime
  const log = deps.log
  const token = deps.token.trim()
  if (token === '') {
    throw new Error('token vazio: nao ha bot para construir (valide antes com lerTokenDoAmbiente)')
  }

  // A raiz da API: (1) a injetada pelo teste; (2) a do AMBIENTE (`DISCORD_API_ROOT`,
  // que o boot generico da Onda 4 ainda nao le por provedor — ele le a raiz do
  // telegram, que em producao discord esta ausente); (3) a publica.
  const apiRoot = deps.apiRoot ?? lerApiRootDoAmbiente(process.env)

  const cliente: ClienteDiscord = criarClienteDiscord({
    token,
    apiRoot,
    log,
    time,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.buscar === undefined ? {} : { buscar: deps.buscar }),
  })

  // Estado vivo do loop — criado no `start()`, encerrado no `stop()`.
  let roda: GatewayRoda | undefined
  let handleEvent: ((event: SurfaceEvent) => Promise<void>) | undefined
  const parse = criarParse()

  /** O handler de dispatch do gateway: payload cru -> SurfaceEvent -> nucleo. */
  function onDispatch(payload: unknown): void {
    const evento = parse.mapear(payload)
    if (evento === undefined) return
    const handler = handleEvent
    if (handler === undefined) return
    // S4: uma falha de entrega nao pode matar o gateway. Registar e seguir.
    void handler(evento).catch((error: unknown) => {
      log.error('falha ao entregar evento da superficie ao nucleo', {
        kind: evento.kind,
        detail: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Constrói o {@link SurfaceSender} NEUTRO sobre o cliente REST. */
  function criarSender(): SurfaceSender {
    function componentsDe(opcoes: SurfaceSendOptions | undefined): readonly unknown[] {
      if (opcoes?.actionRows === undefined) return []
      const renderizado = renderActionRowLayout(opcoes.actionRows, log)
      return renderizado ?? []
    }
    function corpoDe(texto: string, opcoes: SurfaceSendOptions | undefined): CorpoDeMensagem {
      return { content: texto, components: componentsDe(opcoes) }
    }

    return {
      async send(chatKey: string, texto: string, opcoes?: SurfaceSendOptions): Promise<string> {
        // O 429 e repetido aqui (o servidor disse quanto esperar); a rede nao
        // (POST nao e idempotente — ver `./transporte.ts`). O id da mensagem
        // resolve STRING (D4): o snowflake nunca passa por `Number(...)`.
        const enviada = await comAutoRetry(
          () => cliente.sendMessage(chatKey, corpoDe(texto, opcoes)),
          { time, log },
        )
        return enviada.id
      },
      async edit(
        chatKey: string,
        messageId: string,
        texto: string,
        opcoes?: SurfaceSendOptions,
      ): Promise<SurfaceEditOutcome> {
        // NUNCA lanca (contrato): o veredito decide. `components: []` (ou o
        // teclado novo) e SEMPRE explicito — o Discord preservaria os botoes
        // antigos se o campo fosse omitido (anti duplo-toque, CONTRATO §4
        // Regra 2).
        return editMessageInPlace(
          cliente,
          { channelId: chatKey, messageId },
          texto,
          log,
          componentsDe(opcoes),
        )
      },
      async answer(
        answerTarget: string,
        outras?: { readonly text?: string; readonly showAlert?: boolean },
      ): Promise<boolean> {
        // O girador do clique (TG-027). `answerCallbackAlways` NUNCA lanca; o
        // 429 e repetido aqui — um callback perdido deixa o botao com o
        // girador ate expirar.
        return answerCallbackAlways(
          {
            answerInteraction: (interactionId, interactionToken, corpo) =>
              comAutoRetry(
                () => cliente.answerInteraction(interactionId, interactionToken, corpo),
                { time, log },
              ),
            editMessage: (channelId, messageId, corpo) =>
              comAutoRetry(() => cliente.editMessage(channelId, messageId, corpo), { time, log }),
          },
          answerTarget,
          log,
          outras,
        )
      },
    }
  }

  const sender = criarSender()

  return {
    id: 'discord',
    limits: DISCORD_LIMITS,
    async start(handler: (event: SurfaceEvent) => Promise<void>) {
      handleEvent = handler
      const depsDoGateway: GatewayDeps = {
        token,
        log,
        time,
        cliente,
        ...(deps.intents === undefined ? {} : { intents: deps.intents }),
        ...(deps.gatewayUrl === undefined ? {} : { gatewayUrl: deps.gatewayUrl }),
        ...(deps.WebSocketCtor === undefined ? {} : { WebSocketCtor: deps.WebSocketCtor }),
        ...(deps.jitter === undefined ? {} : { jitter: deps.jitter }),
        ...(deps.backoffMs === undefined ? {} : { backoffMs: deps.backoffMs }),
        ...(deps.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: deps.bootTimeoutMs }),
      }
      const novaRoda = iniciarGateway(depsDoGateway, onDispatch)
      roda = novaRoda

      // O `start` aguarda o OUTCOME — espelho do telegram: o boot so considera
      // o arranque concluido quando o loop esta vivo; 401/4013/4014/BOOT_TIMEOUT
      // REJEITAM o `start` e o processo sai com o codigo do veredito.
      const resultado = await novaRoda.outcome
      if (resultado.kind === 'fatal') throw resultado.error
    },
    async stop() {
      handleEvent = undefined
      const atual = roda
      roda = undefined
      if (atual !== undefined) {
        atual.parar()
        await atual.outcome.catch(() => undefined)
      }
    },
    async publishCommands(comandos: readonly SurfacePublishedCommand[]) {
      // NO-OP DOCUMENTADO: o Discord nao tem equivalente do `setMyCommands`
      // para um bot que consome TEXTO LIVRE (ver o cabecalho do ficheiro). O
      // boot chama isto best-effort (TG-080); nada a fazer, sem erro.
      log.debug('publishCommands do discord: no-op (sem setMyCommands equivalente)', {
        comandos: comandos.length,
      })
      return undefined
    },
    sender: () => sender,
    descartados: () => parse.descartados(),
  }
}
