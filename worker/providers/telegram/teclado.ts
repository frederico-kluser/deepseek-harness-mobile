/**
 * O TECLADO E A RENDERIZACAO de saida: `ActionRowLayout` (contrato) ->
 * `InlineKeyboardMarkup` (grammY), a edicao in-place e a resposta ao clique.
 *
 * Port fiel de `worker/lib/keyboard.ts` (buildInlineKeyboard,
 * editMessageTextInPlace, answerCallbackAlways). A fronteira D4 troca o
 * `InlineButtonSpec` TELEGRAM por {@link ActionRow} NEUTRO — o rotulo e o token
 * continuam OPOSTOS (S5): este modulo nunca lê o valor do token, apenas o
 * envolve em `callback_data` via `buildCallbackData` (a gramatica vive em
 * `./parse.ts`).
 */

import type { InlineKeyboardMarkup } from 'grammy/types'

import type { ActionRow, ActionRowLayout } from '../../surface/contract.ts'
import { buildCallbackData, CALLBACK_DATA_MAX_BYTES } from './parse.ts'
import { describeForLog, type WorkerLogger } from './interno.ts'

/**
 * Valida e devolve o `data` de um botao — a SEGUNDA linha de defesa dos 64
 * bytes. A primeira vive em `buildCallbackData` (`./parse.ts`), que monta a
 * string; ter as duas cobre o caminho em que alguem passa um `callback_data`
 * ja montado sem passar pelo construtor.
 */
export function assertCallbackData(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8')
  if (bytes === 0) {
    throw new Error('callback_data vazio: a Bot API exige 1-64 bytes')
  }
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `callback_data com ${bytes} bytes (${data.length} caracteres); o limite e ` +
        `${CALLBACK_DATA_MAX_BYTES} BYTES — cada acento consome 2`,
    )
  }
  return data
}

/**
 * Renderiza as {@link ActionRowLayout} neutras num {@link InlineKeyboardMarkup}.
 *
 * Concentra a unica traducao que este modulo faz: {@link ActionRow} -> botao
 * inline com `callback_data = buildCallbackData(action, token)`. O adaptador ja
 * recebe as linhas dentro de {@link SurfaceLimits}; aqui apenas se RENDERIZA
 * (o corte e do nucleo).
 *
 * Devolve `undefined` quando UMA linha nao renderiza (rotulo vazio ou estouro
 * dos 64 bytes) e NAO ha botao valido a enviar: falhar alto seria matar o
 * envio inteiro por um botao defeituoso, mas esconde-lo em silencio e um
 * defeito; registar e devolver o markup valido que ainda ha e a escolha
 * operavel — ver o teste que assere o estouro a falhar no construtor.
 */
export function renderActionRowLayout(
  linhas: ActionRowLayout,
  log?: WorkerLogger,
): InlineKeyboardMarkup | undefined {
  const teclado: InlineKeyboardMarkup = { inline_keyboard: [] }
  for (const linha of linhas) {
    const botoes: { text: string; callback_data: string }[] = []
    for (const acao of linha) {
      const built = montarBotao(acao, log)
      if (built !== undefined) botoes.push(built)
    }
    if (botoes.length > 0) teclado.inline_keyboard.push(botoes)
  }
  return teclado.inline_keyboard.length === 0 ? undefined : teclado
}

function montarBotao(acao: ActionRow, log?: WorkerLogger): { text: string; callback_data: string } | undefined {
  if (acao.label.length === 0) {
    log?.warn('botao com rotulo vazio descartado na renderizacao')
    return undefined
  }
  let data: string
  try {
    data = assertCallbackData(buildCallbackData(acao.action, acao.token))
  } catch (error) {
    log?.warn('botao descartado na renderizacao: callback_data invalido', {
      action: acao.action,
      detail: describeForLog(error),
    })
    return undefined
  }
  return { text: acao.label, callback_data: data }
}

/** O que aconteceu a uma edicao in-place. */
export type EditOutcome = 'edited' | 'unchanged' | 'failed'

/** O minimo da `Api` do grammY que este modulo toca. Estrutural, para o teste. */
export interface InlineKeyboardApi {
  answerCallbackQuery(
    callbackQueryId: string,
    other?: { text?: string; show_alert?: boolean },
  ): Promise<true>
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    other?: { reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>
}

/**
 * Responde ao `callback_query`. NUNCA lanca.
 *
 * Devolve `true` se o canal aceitou. Uma falha aqui e registada e NAO
 * propaga — a unica excecao a "nunca engolir", justificada: propagar
 * impediria o tratamento do update de continuar, ou seja, uma falha COSMETICA
 * (o relogio no botao) viraria falha FUNCIONAL (o comando nao executa).
 *
 * >>> NA NEGACAO, CHAME-A SEM `text`. <<< O protocolo responde, o conteudo
 * cala. Uma mensagem de recusa dita a um estranho e um ORACULO.
 */
export async function answerCallbackAlways(
  api: InlineKeyboardApi,
  callbackQueryId: string,
  log: WorkerLogger,
  outras?: { readonly text?: string; readonly showAlert?: boolean },
): Promise<boolean> {
  try {
    await api.answerCallbackQuery(
      callbackQueryId,
      outras === undefined
        ? undefined
        : {
            ...(outras.text === undefined ? {} : { text: outras.text }),
            ...(outras.showAlert === undefined ? {} : { show_alert: outras.showAlert }),
          },
    )
    return true
  } catch (error) {
    log.warn('answerCallbackQuery falhou; o botao fica com o relogio, o comando segue', {
      detail: describeForLog(error),
    })
    return false
  }
}

/**
 * Edita a mensagem no lugar em vez de mandar uma nova.
 *
 * «message is not modified» devolvido como `unchanged` e nao como falha: a Bot
 * API recusa uma edicao que nao muda nada, resultado esperado.
 */
export async function editMessageTextInPlace(
  api: InlineKeyboardApi,
  // `chatId` alargado a `number | string` (EMENDA ONDA-1-IPC-ENVELOPE-STRING):
  // o sender do adaptador entrega o id do envelope em STRING (V2) e a Bot API
  // aceita ambos — o alargamento e de TIPO, o comportamento nao muda.
  alvo: { readonly chatId: number | string; readonly messageId: number },
  text: string,
  log: WorkerLogger,
  markup?: InlineKeyboardMarkup,
): Promise<EditOutcome> {
  try {
    await api.editMessageText(
      alvo.chatId,
      alvo.messageId,
      text,
      markup === undefined ? undefined : { reply_markup: markup },
    )
    return 'edited'
  } catch (error) {
    if (isNotModified(error)) return 'unchanged'
    log.warn('editMessageText falhou', {
      chat: alvo.chatId,
      message: alvo.messageId,
      detail: describeForLog(error),
    })
    return 'failed'
  }
}

/**
 * Reconhece o «Bad Request: message is not modified». Compara-se pela
 * `description` porque a Bot API nao da codigo proprio: e um 400 como qualquer
 * outro. Comparacao por SUBSTRING em minusculas, limitada ao 400.
 */
export function isNotModified(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidato = error as { readonly error_code?: unknown; readonly description?: unknown }
  if (candidato.error_code !== 400) return false
  return (
    typeof candidato.description === 'string' &&
    candidato.description.toLowerCase().includes('message is not modified')
  )
}