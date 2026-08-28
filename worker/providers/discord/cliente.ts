/**
 * O CLIENTE HTTP do adaptador discord — REST puro via `fetch` (Node >= 24),
 * SEM SDK e SEM dependencia nova. E a mesma disciplina da sonda do host
 * (`src/onboarding/sonda.ts::criarSondaDiscord`): o token viaja no cabecalho
 * `Authorization: Bearer`, NUNCA na URL.
 *
 * ===========================================================================
 * PORQUE SEM SDK
 * ===========================================================================
 * O repo tem cultura de zero-deps (a barreira HTTP do host e `node:http`
 * puro; a sonda discord e `fetch` puro). O que este modulo precisa da API do
 * Discord sao QUATRO verbos REST (mensagem nova, edicao, callback de
 * interacao, `GET /gateway/bot`) — nada que justifique arrastar o discord.js
 * para dentro do processo que fala com a internet.
 *
 * ===========================================================================
 * CLASSIFICACAO DE ERRO
 * ===========================================================================
 * O transporte (`./transporte.ts`) decide o que repetir; o gateway e o
 * adaptador decidem o que e fatal. Este modulo so CLASSIFICA:
 *
 *   - HTTP 401          -> `DiscordApiError{status:401}` (token recusado;
 *                          fatal no boot, `GATEWAY_UNAUTHORIZED`);
 *   - HTTP 429          -> `DiscordApiError{status:429, retryAfterMs}` (o
 *                          servidor DIZ quanto esperar — o transporte dorme
 *                          exatamente isso, nunca retry cego);
 *   - sem resposta HTTP -> `DiscordApiError{status:0}` (queda de rede — o
 *                          `fetch` lanca `TypeError`/`AbortError`; a mensagem
 *                          dele e DELIBERADAMENTE descartada, como na sonda);
 *   - outro HTTP        -> `DiscordApiError{status, code?, message?}`.
 *
 * O `retry_after` do 429 vem do CORPO (a doc oficial: "The number of seconds
 * to wait", um float — ao contrario do Telegram, que o da em segundos
 * inteiros; ambos em segundos, aqui normalizado para ms no relogio injetado).
 */

import type { TimeSource, WorkerLogger } from './interno.ts'
import { describeForLog } from './interno.ts'

/** Teto de espera de uma chamada REST. O worker, nao um CLI: mais folgado. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** O corpo minimo de uma mensagem: o conteudo e os components, SEMPRE explicitos. */
export interface CorpoDeMensagem {
  /** Texto da mensagem (o nucleo ja cortou nos 2000 do canal). */
  readonly content: string
  /**
   * Linhas de acao do Discord. `[]` explicito DESTROI os botoes da mensagem
   * (anti duplo-toque) — omitir o campo PRESERVARIA os components existentes,
   * que e exatamente o que nao se quer apos uma accao (CONTRATO §4 Regra 2).
   */
  readonly components: readonly unknown[]
}

/** O corpo de um callback de interacao: o tipo + data opcional. */
export interface CorpoDeCallback {
  /** `InteractionCallbackType` do Discord (4/6/7 — ver `./teclado.ts`). */
  readonly type: number
  readonly data?: Readonly<Record<string, unknown>> | undefined
}

/** A resposta do `GET /gateway/bot` (doc oficial: url + shards + session_start_limit). */
export interface GatewayBotInfo {
  readonly url: string
  readonly shards: number
}

/** O erro TIPADO do cliente. `status === 0` significa "nem houve resposta HTTP". */
export class DiscordApiError extends Error {
  override readonly name = 'DiscordApiError'
  /** HTTP status; `0` quando a rede falhou antes da resposta. */
  readonly status: number
  /** O `code` numerico do corpo do Discord (ex.: 10008 "unknown message"). */
  readonly code: number | undefined
  /** `429` com `retry_after` do corpo, em MILISSEGUNDOS (ja convertido). */
  readonly retryAfterMs: number | undefined
  /** `429` global (Rate Limit Global, doc oficial). */
  readonly global: boolean | undefined

  constructor(
    status: number,
    options: {
      readonly code?: number
      readonly retryAfterMs?: number
      readonly global?: boolean
      readonly message?: string
      readonly cause?: unknown
    } = {},
  ) {
    super(options.message ?? `a API do Discord respondeu com HTTP ${status}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.status = status
    this.code = options.code
    this.retryAfterMs = options.retryAfterMs
    this.global = options.global
  }
}

/** As deps do cliente. `buscar` e injetavel para o duble; o default e o fetch global. */
export interface ClienteDiscordDeps {
  readonly token: string
  /** Raiz da API (duble de teste). Omitida, a publica. SEM barra final. */
  readonly apiRoot: string
  readonly log: WorkerLogger
  readonly time?: TimeSource
  readonly timeoutMs?: number
  readonly buscar?: typeof fetch
}

export interface ClienteDiscord {
  /** `GET /gateway/bot` — a URL do gateway (com shards) para a conexao WS. */
  getGatewayBot(): Promise<GatewayBotInfo>
  /** `POST /channels/{channelId}/messages` — resolve com o id STRING da msg. */
  sendMessage(channelId: string, corpo: CorpoDeMensagem): Promise<{ readonly id: string }>
  /** `PATCH /channels/{channelId}/messages/{messageId}` — edicao in-place. */
  editMessage(channelId: string, messageId: string, corpo: CorpoDeMensagem): Promise<{ readonly id: string }>
  /** `POST /interactions/{interactionId}/{interactionToken}/callback`. */
  answerInteraction(interactionId: string, interactionToken: string, corpo: CorpoDeCallback): Promise<unknown>
}

function ehObjecto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null
}

/**
 * Classifica (HTTP, corpo) num {@link DiscordApiError}. `retry_after` do 429
 * e um float em SEGUNDOS (doc oficial atual); normalizado para ms.
 */
export function classificarResposta(status: number, corpo: unknown): DiscordApiError | undefined {
  if (status >= 200 && status < 300) return undefined
  let code: number | undefined
  let retryAfterMs: number | undefined
  let global: boolean | undefined
  let mensagem: string | undefined
  if (ehObjecto(corpo)) {
    if (typeof corpo.code === 'number') code = corpo.code
    if (typeof corpo.message === 'string') mensagem = corpo.message
    if (status === 429) {
      const retryAfter = corpo.retry_after
      // A doc oficial diz "seconds" (float); tolera-se um valor pequeno que
      // algum proxy envie em ms (>= 1000 s seria absurdo num rate limit).
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
        retryAfterMs = retryAfter < 1_000 ? Math.round(retryAfter * 1000) : Math.round(retryAfter)
      }
      if (typeof corpo.global === 'boolean') global = corpo.global
    }
  }
  return new DiscordApiError(status, {
    ...(code === undefined ? {} : { code }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(global === undefined ? {} : { global }),
    ...(mensagem === undefined ? {} : { message: mensagem }),
  })
}

/**
 * Monta o cliente REST do Discord.
 *
 * O token NAO vai para logs: o `describeForLog` das mensagens de erro passa
 * pela lista de segredos, e a URL nunca carrega o token (Bearer no header).
 */
export function criarClienteDiscord(deps: ClienteDiscordDeps): ClienteDiscord {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const buscar = deps.buscar ?? fetch
  const apiRoot = deps.apiRoot.replace(/\/+$/u, '')

  /** Uma chamada REST: metodo + caminho + corpo JSON. Classifica o erro. */
  async function chamar(
    method: string,
    caminho: string,
    corpo?: unknown,
  ): Promise<{ readonly status: number; readonly corpo: unknown }> {
    let resposta: Response
    try {
      resposta = await buscar(`${apiRoot}${caminho}`, {
        method,
        headers: {
          authorization: `Bot ${deps.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (erro) {
      // A mensagem do `fetch` pode citar a URL (sem token — Bearer no header);
      // ainda assim descarta-se por disciplina: `status: 0` diz tudo.
      void erro
      throw new DiscordApiError(0, { cause: erro })
    }
    const texto = await resposta.text()
    let lido: unknown = undefined
    try {
      lido = JSON.parse(texto)
    } catch {
      lido = undefined
    }
    const classificado = classificarResposta(resposta.status, lido)
    if (classificado !== undefined) throw classificado
    return { status: resposta.status, corpo: lido }
  }

  return {
    async getGatewayBot(): Promise<GatewayBotInfo> {
      const { corpo } = await chamar('GET', '/gateway/bot')
      if (!ehObjecto(corpo) || typeof corpo.url !== 'string' || corpo.url === '') {
        throw new DiscordApiError(0, {
          message: 'o corpo de GET /gateway/bot nao trouxe uma url utilizavel',
          cause: corpo,
        })
      }
      const shards = typeof corpo.shards === 'number' ? corpo.shards : 1
      return { url: corpo.url, shards }
    },

    async sendMessage(channelId: string, body: CorpoDeMensagem): Promise<{ readonly id: string }> {
      const { corpo } = await chamar('POST', `/channels/${channelId}/messages`, body)
      if (!ehObjecto(corpo) || typeof corpo.id !== 'string') {
        throw new DiscordApiError(0, {
          message: 'o corpo de POST /channels/{id}/messages nao trouxe id',
          cause: corpo,
        })
      }
      // O id da mensagem e um snowflake STRING (D4): nunca Number(...).
      return { id: corpo.id }
    },

    async editMessage(channelId: string, messageId: string, body: CorpoDeMensagem): Promise<{ readonly id: string }> {
      const { corpo } = await chamar('PATCH', `/channels/${channelId}/messages/${messageId}`, body)
      if (!ehObjecto(corpo) || typeof corpo.id !== 'string') {
        throw new DiscordApiError(0, {
          message: 'o corpo de PATCH /channels/{id}/messages/{id} nao trouxe id',
          cause: corpo,
        })
      }
      return { id: corpo.id }
    },

    async answerInteraction(
      interactionId: string,
      interactionToken: string,
      body: CorpoDeCallback,
    ): Promise<unknown> {
      const { corpo } = await chamar(
        'POST',
        `/interactions/${interactionId}/${interactionToken}/callback`,
        body,
      )
      return corpo
    },
  }
}

/** Log seguro de um erro do cliente (sem o token — S3). */
export function descreverErroDoCliente(error: unknown, log: WorkerLogger): void {
  log.warn('chamada REST do Discord falhou', {
    status: error instanceof DiscordApiError ? error.status : undefined,
    detail: describeForLog(error),
  })
}
