/**
 * O EMISSOR: parte o texto antes de o mandar, e serializa 1 mensagem/segundo
 * por chat.
 *
 * ===========================================================================
 * TG-048 — 4096 CARACTERES, E O CORTE E NOSSO
 * ===========================================================================
 * `sendMessage.text` e documentado como «1-4096 characters after entities
 * parsing». Mandar 5000 e receber um 400 nao e "a API valida por nos": e uma
 * ida a rede desperdicada, um erro no log que parece defeito, e uma mensagem
 * que o dono NAO recebe. O corte acontece aqui, antes do fio.
 *
 * O limite conta-se em UNIDADES UTF-16 (`String#length`) de proposito. O
 * Telegram conta caracteres, e `"a".length === [..."a"].length` mas
 * `"😀".length === 2` e `[..."😀"].length === 1` — ou seja, medir em UTF-16 e
 * SEMPRE conservador: nunca deixa passar uma mensagem que o servidor recuse.
 * Errar para o lado seguro e barato; para o outro custa a mensagem toda.
 *
 * ===========================================================================
 * TG-049 — 1 MENSAGEM/SEGUNDO POR CHAT
 * ===========================================================================
 * O limite documentado do Telegram para um chat individual e ~1 mensagem por
 * segundo. Passar disso rende 429, e um 429 numa notificacao de "o tunel caiu"
 * chega tarde ou nao chega.
 *
 * A serializacao e POR CHAT e nao global: dois chats distintos nao tem razao
 * para esperar um pelo outro, e uma fila unica transformava o limite por chat
 * num limite global — muito mais apertado do que o real.
 *
 * O espacamento e medido com o relogio INJETADO. Nenhum teste deste ficheiro
 * espera tempo real.
 *
 * Sem estado de modulo: as filas vivem no closure de {@link createOutbox}. Duas
 * instancias sao mesmo independentes, que e o que torna o teste honesto.
 */

import { systemTime, type TimeSource } from './clock.ts'
import { WorkerError } from './errors.ts'
import type { WorkerLogger } from './log.ts'

/** «1-4096 characters after entities parsing» (Bot API, `sendMessage`). */
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096

/** Um segundo entre mensagens para o MESMO chat. */
export const DEFAULT_MIN_INTERVAL_MS = 1000

/** Marcador de corte, quando o chamador escolhe truncar em vez de particionar. */
export const TRUNCATION_MARKER = '…'

/**
 * Parte `text` em pedacos que cabem em `limit`, SEM PERDER UM CARACTER: a
 * concatenacao dos pedacos e identica ao original.
 *
 * PORQUE LOSSLESS: o unico teste honesto de um particionador e
 * `chunks.join('') === original`. Um que apare espacos nas juntas passa a
 * depender de o revisor confiar na descricao.
 *
 * Preferencia de corte: ultima quebra de linha dentro do limite, senao ultimo
 * espaco, senao corte duro. O corte duro NUNCA parte um par substituto — meio
 * par e um `U+FFFD` na cara do dono.
 */
export function splitMessageText(
  text: string,
  limit: number = TELEGRAM_MESSAGE_MAX_LENGTH,
): readonly string[] {
  if (limit < 1) throw new WorkerError('MESSAGE_EMPTY', `limite invalido: ${limit}`)
  if (text.length <= limit) return text === '' ? [] : [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    if (text.length - start <= limit) {
      chunks.push(text.slice(start))
      break
    }

    const window = text.slice(start, start + limit)
    let end = start + limit

    const newline = window.lastIndexOf('\n')
    const space = window.lastIndexOf(' ')
    if (newline > 0) end = start + newline + 1
    else if (space > 0) end = start + space + 1
    else {
      // Corte duro. `charCodeAt` do ultimo caracter incluido: se for a metade
      // ALTA de um par substituto, recua-se um — perder um caracter no fim do
      // pedaco e melhor do que emitir meio.
      const last = text.charCodeAt(end - 1)
      const isHighSurrogate = last >= 0xd8_00 && last <= 0xdb_ff
      if (isHighSurrogate && end - 1 > start) end -= 1
    }

    chunks.push(text.slice(start, end))
    start = end
  }

  return chunks
}

/**
 * Corta `text` em `limit`, com marcador. Alternativa a particionar, para texto
 * em que o fim nao interessa (um dump de erro, por exemplo).
 *
 * O marcador conta PARA DENTRO do limite: um "truncador" que devolve
 * `limit + 1` caracteres e um gerador de 400 com passo extra.
 */
export function truncateMessageText(
  text: string,
  limit: number = TELEGRAM_MESSAGE_MAX_LENGTH,
): string {
  if (text.length <= limit) return text
  const keep = Math.max(0, limit - TRUNCATION_MARKER.length)
  const head = text.slice(0, keep)
  const last = head.charCodeAt(head.length - 1)
  const trimmed = last >= 0xd8_00 && last <= 0xdb_ff ? head.slice(0, -1) : head
  return `${trimmed}${TRUNCATION_MARKER}`
}

/** O que o outbox precisa de saber fazer. Estrutural, para o teste nao montar um `Bot`. */
export type SendText = (chatId: number, text: string) => Promise<unknown>

export interface OutboxOptions {
  readonly minIntervalMs?: number
  readonly maxLength?: number
  readonly time?: TimeSource
  readonly log?: WorkerLogger
}

export interface Outbox {
  /**
   * Enfileira um texto para um chat. Resolve quando TODOS os pedacos sairam.
   *
   * Rejeita se o envio falhar — nunca engolir: quem chamou tem de poder decidir
   * se avisa, se repete, ou se desiste.
   */
  send(chatId: number, text: string): Promise<void>
  /** Espera que todas as filas esvaziem. Para o encerramento limpo. */
  drain(): Promise<void>
}

export function createOutbox(sendText: SendText, options: OutboxOptions = {}): Outbox {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxLength = options.maxLength ?? TELEGRAM_MESSAGE_MAX_LENGTH
  const time = options.time ?? systemTime
  const log = options.log

  /** Cauda da fila de cada chat. A chave e `chat.id` — numerico, nunca username. */
  const lanes = new Map<number, Promise<void>>()
  /** Instante do ultimo envio bem sucedido por chat. */
  const lastSentAt = new Map<number, number>()

  async function pace(chatId: number): Promise<void> {
    const last = lastSentAt.get(chatId)
    if (last === undefined) return
    const waitMs = minIntervalMs - (time.now() - last)
    if (waitMs > 0) await time.sleep(waitMs)
  }

  async function deliver(chatId: number, chunks: readonly string[]): Promise<void> {
    for (const chunk of chunks) {
      await pace(chatId)
      await sendText(chatId, chunk)
      lastSentAt.set(chatId, time.now())
    }
  }

  function send(chatId: number, text: string): Promise<void> {
    const chunks = splitMessageText(text, maxLength)
    if (chunks.length === 0) {
      return Promise.reject(
        new WorkerError('MESSAGE_EMPTY', `pedido de envio sem texto para o chat ${chatId}`),
      )
    }
    if (chunks.length > 1) {
      log?.debug('mensagem particionada antes de sair', {
        chat: chatId,
        chunks: chunks.length,
        length: text.length,
      })
    }

    const previous = lanes.get(chatId) ?? Promise.resolve()
    const task = previous.then(() => deliver(chatId, chunks))

    // A CAUDA da fila absorve a falha; a promessa DEVOLVIDA nao. Se a cauda
    // propagasse o erro, uma falha de envio encravava o chat para sempre — e
    // ainda produzia uma rejeicao nao tratada em cada envio seguinte.
    const tail: Promise<void> = task.catch(() => undefined)
    lanes.set(chatId, tail)
    // Fila vazia, entrada apagada: sem isto o mapa cresce um lugar por chat que
    // o bot alguma vez tocou e nunca encolhe. `lanes.get() === tail` garante que
    // so se apaga a PROPRIA cauda — se entretanto entrou outro envio, ele manda.
    void tail.finally(() => {
      if (lanes.get(chatId) === tail) lanes.delete(chatId)
    })
    return task
  }

  async function drain(): Promise<void> {
    // Uma passagem nao chega: enquanto se espera, pode ter entrado mais coisa
    // na fila. Repete-se ate o conjunto de caudas estabilizar.
    for (;;) {
      const snapshot = [...lanes.values()]
      if (snapshot.length === 0) return
      await Promise.all(snapshot)
      const after = [...lanes.values()]
      const estavel = after.length === snapshot.length && after.every((p, i) => p === snapshot[i])
      if (estavel) return
    }
  }

  return { send, drain }
}
