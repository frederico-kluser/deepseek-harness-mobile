/**
 * O TECLADO E A RENDERIZACAO de saida do discord: `ActionRowLayout` (contrato)
 * -> `components` do Discord (ActionRow com Buttons), a edicao in-place e a
 * resposta ao clique. Port do `teclado.ts` do telegram (fronteira D4).
 *
 * ===========================================================================
 * A FORMA DO DISCORD (confirmada na doc oficial de components)
 * ===========================================================================
 *   - no maximo 5 ActionRow (type 1) por mensagem, cada uma com ate 5 botoes
 *     (type 2); um botao tem `style` (1 = primary), `label` (max 80 chars) e
 *     `custom_id` (1..100 chars, unico por mensagem);
 *   - `custom_id` carrega o payload do botao — a gramatica `g1:<acao>:<token>`
 *     de `./parse.ts` (o token opaco S5);
 *   - editar = `PATCH /channels/{id}/messages/{id}` com `components` NOVO;
 *     mandar `components: []` explicito DESTROI os botoes (anti duplo-toque —
 *     omitir o campo PRESERVARIA os botoes antigos, CONTRATO §4 Regra 2).
 *
 * ===========================================================================
 * RESPONDER AO CLIQUE (TG-027)
 * ===========================================================================
 * O análogo do `answerCallbackQuery`: `POST /interactions/{id}/{token}/
 * callback`. Os tipos (doc oficial de interactions, InteractionCallbackType):
 *   - type 6 `DEFERRED_UPDATE_MESSAGE` — ACK o clique SEM estado de loading
 *     e SEM editar: o girador para e a edicao real (se houver) vem pelo PATCH;
 *   - type 4 `CHANNEL_MESSAGE_WITH_SOURCE` com `flags: 64` (EPHEMERAL) — a
 *     resposta com texto (o "toast" do nucleo: "Ligando...", "Ok, cancelado."),
 *     visivel so para quem clicou e que some ao trocar de canal.
 * A resposta do callback e a UNICA forma de parar o girador do clique — por
 * isso `answer` NUNCA lanca (uma falha cosmética nao pode virar funcional).
 */

import type { ActionRow, ActionRowLayout } from '../../surface/contract.ts'
import { buildCustomId, CUSTOM_ID_MAX_BYTES, lerAnswerTarget, type AnswerTargetDiscord } from './parse.ts'
import type { ClienteDiscord } from './cliente.ts'
import { describeForLog, type WorkerLogger } from './interno.ts'

/** Limite da API para o rotulo de um botao (doc oficial de components). */
export const BUTTON_LABEL_MAX_CHARS = 80

/** `InteractionCallbackType.DEFERRED_UPDATE_MESSAGE` — ACK silencioso (TG-027). */
export const CALLBACK_DEFERRED_UPDATE_MESSAGE = 6

/** `InteractionCallbackType.CHANNEL_MESSAGE_WITH_SOURCE` — resposta com texto. */
export const CALLBACK_CHANNEL_MESSAGE_WITH_SOURCE = 4

/** `MessageFlags.EPHEMERAL` — a resposta so o autor do clique ve. */
export const MESSAGE_FLAG_EPHEMERAL = 64

/** O minimo do cliente que este modulo toca. Estrutural, para o teste. */
export interface TecladoApi {
  answerInteraction(
    interactionId: string,
    interactionToken: string,
    corpo: { readonly type: number; readonly data?: Record<string, unknown> },
  ): Promise<unknown>
  editMessage(
    channelId: string,
    messageId: string,
    corpo: { readonly content: string; readonly components: readonly unknown[] },
  ): Promise<{ readonly id: string }>
}

/**
 * Renderiza as {@link ActionRowLayout} neutras em `components` do Discord.
 *
 * Concentra a unica traducao que este modulo faz: {@link ActionRow} -> botao
 * com `custom_id = buildCustomId(action, token)`. O adaptador ja recebe as
 * linhas dentro de {@link SurfaceLimits}; aqui apenas se RENDERIZA (o corte e
 * do nucleo). Devolve `undefined` quando nenhuma linha renderiza — a mensagem
 * sai sem botoes.
 */
export function renderActionRowLayout(
  linhas: ActionRowLayout,
  log?: WorkerLogger,
): readonly unknown[] | undefined {
  const componentes: unknown[] = []
  for (const linha of linhas) {
    const botoes: unknown[] = []
    for (const acao of linha) {
      const montado = montarBotao(acao, log)
      if (montado !== undefined) botoes.push(montado)
    }
    if (botoes.length > 0) {
      componentes.push({ type: 1, components: botoes })
    }
  }
  return componentes.length === 0 ? undefined : componentes
}

function montarBotao(acao: ActionRow, log?: WorkerLogger): unknown | undefined {
  if (acao.label.length === 0) {
    log?.warn('botao com rotulo vazio descartado na renderizacao')
    return undefined
  }
  if (acao.label.length > BUTTON_LABEL_MAX_CHARS) {
    log?.warn('botao com rotulo acima do limite descartado na renderizacao', {
      label_chars: acao.label.length,
      max: BUTTON_LABEL_MAX_CHARS,
    })
    return undefined
  }
  let customId: string
  try {
    customId = buildCustomId(acao.action, acao.token)
  } catch (error) {
    log?.warn('botao descartado na renderizacao: custom_id invalido', {
      action: acao.action,
      detail: describeForLog(error),
    })
    return undefined
  }
  return { type: 2, style: 1, label: acao.label, custom_id: customId }
}

/**
 * Responde ao clique (o girador). NUNCA lanca.
 *
 * Devolve `true` se o canal aceitou. Uma falha aqui e registada e NAO
 * propaga — a unica excecao a "nunca engolir", justificada: propagar
 * impediria o tratamento do update de continuar, ou seja, uma falha COSMETICA
 * viraria falha FUNCIONAL.
 *
 * >>> NA NEGACAO, CHAME-A SEM `text`. <<< O protocolo responde, o conteudo
 * cala. Uma mensagem de recusa dita a um estranho e um ORACULO.
 */
export async function answerCallbackAlways(
  api: TecladoApi,
  answerTarget: string,
  log: WorkerLogger,
  outras?: { readonly text?: string; readonly showAlert?: boolean },
): Promise<boolean> {
  const alvo = lerAnswerTarget(answerTarget)
  if (alvo === undefined) {
    // Alvo de resposta que o nosso parse nao montou (ou foi corrompido):
    // nao ha como responder — devolve false sem lanca (o handleEvent segue).
    log.warn('answer sem answerTarget discord valido; o girador do clique nao para', {
      detail: describeForLog(answerTarget),
    })
    return false
  }
  try {
    if (outras?.text !== undefined && outras.text !== '') {
      // O "toast" do nucleo: mensagem efemera so para quem clicou. A
      // `showAlert` do contrato (alerta modal do Telegram) nao tem analogo no
      // Discord — ignora-se sem ruido: o texto e o conteudo, a forma e a nossa.
      await api.answerInteraction(alvo.interactionId, alvo.interactionToken, {
        type: CALLBACK_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: outras.text, flags: MESSAGE_FLAG_EPHEMERAL },
      })
    } else {
      // NEGACAO/confirmacao silenciosa: ACK sem loading e sem texto. A
      // edicao real (estado) chega pelo PATCH do `edit`.
      await api.answerInteraction(alvo.interactionId, alvo.interactionToken, {
        type: CALLBACK_DEFERRED_UPDATE_MESSAGE,
      })
    }
    return true
  } catch (error) {
    log.warn('callback de interacao falhou; o botao fica com o girador, o comando segue', {
      detail: describeForLog(error),
    })
    return false
  }
}

/**
 * Edita a mensagem no lugar em vez de mandar uma nova.
 *
 * O Discord NAO recusa edicao identica (o PATCH devolve 200 com a mensagem
 * como esta) — ao contrario da Bot API do Telegram («message is not
 * modified»). Logo `'unchanged'` nao ocorre neste canal; o veredito existe
 * para o contrato neutro e fica como ponte para um provedor que o use.
 */
export async function editMessageInPlace(
  api: TecladoApi,
  alvo: { readonly channelId: string; readonly messageId: string },
  texto: string,
  log: WorkerLogger,
  components?: readonly unknown[],
): Promise<'edited' | 'unchanged' | 'failed'> {
  try {
    await api.editMessage(alvo.channelId, alvo.messageId, {
      content: texto,
      // `components: []` (ou o novo teclado) e SEMPRE explicito: sem ele o
      // Discord PRESERVARIA os botoes antigos — o anti duplo-toque morreria.
      components: components ?? [],
    })
    return 'edited'
  } catch (error) {
    log.warn('edicao da mensagem falhou', {
      channel: alvo.channelId,
      message: alvo.messageId,
      detail: describeForLog(error),
    })
    return 'failed'
  }
}

/** O cliente REST satisfaz a superficie que este modulo toca, sem cast. */
export function tecladoApiDe(cliente: ClienteDiscord): TecladoApi {
  return cliente
}

/** Guarda de sanidade dos 100 bytes (2.a linha de defesa de `buildCustomId`). */
export function assertCustomId(data: string): string {
  const bytes = new TextEncoder().encode(data).length
  if (bytes === 0) throw new Error('custom_id vazio: a API exige 1-100 bytes')
  if (bytes > CUSTOM_ID_MAX_BYTES) {
    throw new Error(
      `custom_id com ${bytes} bytes (${data.length} caracteres); o limite e ` +
        `${CUSTOM_ID_MAX_BYTES} BYTES — cada acento consome 2`,
    )
  }
  return data
}

/** Tipos re-exportados para o adapter (e o teste) nomearem o par do clique. */
export type { AnswerTargetDiscord }
