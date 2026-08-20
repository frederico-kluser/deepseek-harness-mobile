/**
 * Teclado inline: construcao, o limite REAL do `callback_data`, e as duas
 * regras de interaccao que o cliente do Telegram nao perdoa.
 *
 * ===========================================================================
 * `callback_data` NAO E PROVA DE AUTORIZACAO — E ISSO E ESTRUTURAL
 * ===========================================================================
 * `src/contracts/ipc.ts` S5: sao 1-64 BYTES fornecidos pelo CLIENTE. Um cliente
 * modificado manda o que quiser la dentro. Portanto o `callback_data` transporta
 * INTENCAO e um nonce OPACO; quem decide se a intencao vale e o host, e quem
 * revalida a identidade a cada `callback_query` e `worker/auth/guard.ts` (T4.4).
 * Nada neste ficheiro autoriza coisa nenhuma.
 *
 * ===========================================================================
 * QUEM PRODUZ A STRING E T4.4 — AQUI ELA E OPACA
 * ===========================================================================
 * A GRAMATICA do `callback_data` (`g1:<accao>:<token>`, com a accao validada
 * contra o vocabulario FECHADO de `IpcIntentName`) e fixada por
 * `worker/auth/guard.ts`, que exporta `buildCallbackData()` e
 * `parseCallbackData()`.
 *
 *   >>> CHAME `buildCallbackData()`. NAO MONTE A STRING A MAO. <<<
 *
 * Este modulo NAO conhece nem inventa formato nenhum: recebe a string pronta,
 * trata-a como opaca e so verifica o LIMITE. Sao duas responsabilidades
 * distintas de proposito — se este ficheiro conhecesse o formato, haveria dois
 * sitios no repositorio a decidir o que e um `callback_data` valido, e eles
 * divergiriam.
 *
 * A verificacao de bytes aqui e a SEGUNDA linha de defesa, e nao a primeira:
 * `buildCallbackData` ja mede com `TextEncoder` e recusa acima de 64. Ter as
 * duas e barato e cobre o caminho em que alguem constroi um botao decorativo
 * sem passar pelo construtor.
 *
 * ===========================================================================
 * 64 **BYTES**, NAO 64 CARACTERES
 * ===========================================================================
 * A armadilha e silenciosa: `'ligar'.length === 5` e 5 bytes, mas
 * `'confirmação'.length === 11` e **13 bytes** em UTF-8 — cada acento consome
 * 2. MEDIDO por T4.4: o payload real gasta 24 dos 64 bytes, mas 33 caracteres
 * acentuados medem 66 — e `.length` aprovaria os 33 sem pestanejar. Um rotulo
 * traduzido cabe na contagem errada e estoura na do fio, e estoura no caminho
 * do botao de DESLIGAR, que e onde menos se quer descobrir isso.
 *
 * ===========================================================================
 * `answerCallbackQuery` SEMPRE
 * ===========================================================================
 * Enquanto o bot nao responde, o cliente do Telegram mostra o RELOGIO no botao.
 * Se a resposta nunca vem, o dono ve um botao pendurado e carrega outra vez —
 * o que gera um segundo update para a mesma intencao. Responder e barato e tem
 * de acontecer em TODOS os caminhos, inclusive no de erro.
 *
 * E a propria resposta pode falhar («query is too old»), tipicamente porque a
 * accao demorou mais de 15 s. Isso NAO e motivo para derrubar o tratamento do
 * update: regista-se e segue-se.
 */

import type { InlineKeyboardMarkup } from 'grammy/types'

import { WorkerError } from './errors.ts'
import type { WorkerLogger } from './log.ts'
import { describeForLog } from './redact.ts'

/** «1-64 bytes» (Bot API, `InlineKeyboardButton.callback_data`). */
export const CALLBACK_DATA_MAX_BYTES = 64

/** Quantos BYTES UTF-8 ocupa `data`. A unica contagem que o servidor faz. */
export function callbackDataBytes(data: string): number {
  return Buffer.byteLength(data, 'utf8')
}

/**
 * Valida e devolve `data`.
 *
 * @throws {WorkerError} `CALLBACK_DATA_TOO_LONG` — com a contagem em bytes E em
 * caracteres, porque a diferenca entre as duas E a explicacao da falha.
 */
export function assertCallbackData(data: string): string {
  const bytes = callbackDataBytes(data)
  if (bytes === 0) {
    throw new WorkerError('CALLBACK_DATA_TOO_LONG', 'callback_data vazio: a Bot API exige 1-64 bytes')
  }
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new WorkerError(
      'CALLBACK_DATA_TOO_LONG',
      `callback_data com ${bytes} bytes (${data.length} caracteres); o limite e ` +
        `${CALLBACK_DATA_MAX_BYTES} BYTES — cada acento consome 2`,
    )
  }
  return data
}

export interface InlineButtonSpec {
  /** O rotulo. Carrega a semantica: emoji e texto funcionam em cliente antigo. */
  readonly text: string
  /**
   * O `callback_data` JA CONSTRUIDO por `buildCallbackData()`
   * (`worker/auth/guard.ts`, T4.4). Opaco aqui — ver o cabecalho e S5.
   */
  readonly data: string
}

/**
 * Constroi o `reply_markup`.
 *
 * NAO usa o `InlineKeyboard` fluente do grammY de proposito: o construtor
 * fluente e mutavel e convida a guardar-se numa variavel de modulo, que e
 * exatamente o estado partilhado que este worker nao pode ter. Isto e uma
 * funcao pura de entrada para saida.
 */
export function buildInlineKeyboard(
  rows: readonly (readonly InlineButtonSpec[])[],
): InlineKeyboardMarkup {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: assertCallbackData(button.data) })),
    ),
  }
}

/** O minimo da `Api` do grammY que este modulo toca. Estrutural, para o teste. */
export interface CallbackApi {
  answerCallbackQuery(
    callbackQueryId: string,
    other?: { readonly text?: string; readonly show_alert?: boolean },
  ): Promise<true>
}

/** Idem, para a edicao in-place. */
export interface EditApi {
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    other?: { readonly reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>
}

/**
 * Responde ao `callback_query`. NUNCA lanca.
 *
 * Devolve `true` se o Telegram aceitou. Uma falha aqui e registada e engolida
 * DE PROPOSITO — e a unica excecao a regra "nunca engolir", e ela esta
 * justificada: propagar impediria o tratamento do update de continuar, ou seja,
 * uma falha COSMETICA (o relogio no botao) passaria a falha FUNCIONAL (o
 * comando nao executa).
 *
 * >>> NO CAMINHO DE NEGACAO, CHAME-A **SEM `text`**. <<< O protocolo responde,
 * o conteudo cala. Uma mensagem de recusa dita a um estranho e um ORACULO: diz
 * a quem nao esta na allowlist que o bot existe, que o comando existe, e que
 * ele so nao tem permissao — tres factos que ele nao tinha antes de carregar no
 * botao. Nao responder de todo tambem nao serve: deixa o cliente com a barra de
 * progresso a girar para sempre.
 */
export async function answerCallbackAlways(
  api: CallbackApi,
  callbackQueryId: string,
  log: WorkerLogger,
  other?: { readonly text?: string; readonly show_alert?: boolean },
): Promise<boolean> {
  try {
    await api.answerCallbackQuery(callbackQueryId, other)
    return true
  } catch (error) {
    log.warn('answerCallbackQuery falhou; o botao fica com o relogio, o comando segue', {
      detail: describeForLog(error),
    })
    return false
  }
}

/** O que aconteceu a uma edicao in-place. */
export type EditOutcome = 'edited' | 'unchanged' | 'failed'

/**
 * Edita a mensagem no lugar, em vez de mandar uma nova.
 *
 * PORQUE IN-PLACE: o painel de estado e UMA mensagem que se actualiza. Mandar
 * uma nova a cada transicao enche o chat e, pior, deixa mensagens ANTIGAS com
 * botoes VIVOS — o dono carrega no `Ligar` de ha uma hora sem reparar.
 *
 * «message is not modified» e devolvido como `unchanged` e nao como falha: a
 * Bot API recusa uma edicao que nao muda nada, e isso acontece sempre que duas
 * difusoes de estado seguidas dizem o mesmo. E o resultado esperado, nao um
 * erro.
 */
export async function editMessageTextInPlace(
  api: EditApi,
  target: { readonly chatId: number; readonly messageId: number },
  text: string,
  log: WorkerLogger,
  markup?: InlineKeyboardMarkup,
): Promise<EditOutcome> {
  try {
    await api.editMessageText(
      target.chatId,
      target.messageId,
      text,
      markup === undefined ? undefined : { reply_markup: markup },
    )
    return 'edited'
  } catch (error) {
    if (isNotModified(error)) return 'unchanged'
    log.warn('editMessageText falhou', {
      chat: target.chatId,
      message: target.messageId,
      detail: describeForLog(error),
    })
    return 'failed'
  }
}

/**
 * Reconhece o «Bad Request: message is not modified».
 *
 * Compara-se pela `description` porque a Bot API nao da codigo proprio a este
 * caso: e um 400 como qualquer outro. A comparacao e por SUBSTRING em minusculas
 * e limitada ao 400, para nao apanhar um erro diferente que por acaso cite a
 * frase.
 */
export function isNotModified(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { readonly error_code?: unknown; readonly description?: unknown }
  if (candidate.error_code !== 400) return false
  return (
    typeof candidate.description === 'string' &&
    candidate.description.toLowerCase().includes('message is not modified')
  )
}
