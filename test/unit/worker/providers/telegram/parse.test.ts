/**
 * `worker/providers/telegram/parse.ts` — a traducao do update cru para o
 * {@link SurfaceEvent} neutro. Port fiel do funil de `worker/auth/guard.ts`
 * (decideUpdate/extractIdentity/isTelegramId) e da gramatica `g1:<acao>:<token>`
 * (buildCallbackData/parseCallbackData).
 *
 * Cobre: TG-002..015 (dois eixos, sem username, 52 bits, sinal, superficie nao
 * accionavel), TG-025 (payload administrativo directo morre no parser), TG-027
 * (answerTarget SEMPRE nos callbacks), TG-089 (descartado e contado), S5
 * (token OPACO — nunca validado, nunca forjado).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SurfaceEvent } from '../../../../../worker/surface/contract.ts'
import {
  buildCallbackData,
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_SCHEMA,
  criarParse,
  parseCallbackData,
  utf8Bytes,
} from '../../../../../worker/providers/telegram/parse.ts'

/** Um update de mensagem com texto, com os dois eixos numericos. */
function updateDeMensagem(text: string, fromId = 777000123, chatId = 777000123): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_800_000_000,
      from: { id: fromId, is_bot: false, first_name: 'Dono' },
      chat: { id: chatId, type: 'private' },
      text,
    },
  }
}

/** Um callback_query bem formado com a gramatica `g1:<acao>:<token>`. */
function updateDeCallback(action: string, token: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 2,
    callback_query: {
      id: 'cq-1',
      from: { id: 777000123, is_bot: false },
      message: { message_id: 9, chat: { id: 777000123, type: 'private' } },
      data: `${CALLBACK_SCHEMA}:${action}:${token}`,
      ...overrides,
    },
  }
}

function comprimir(event: SurfaceEvent | undefined): unknown {
  if (event === undefined) return event
  if (event.kind === 'comando') return { kind: event.kind, user: event.identity.userKey, chat: event.identity.chatKey, text: event.text }
  if (event.kind === 'acao') {
    return {
      kind: event.kind,
      user: event.identity.userKey,
      chat: event.identity.chatKey,
      action: event.action,
      token: event.token,
      answer: event.answerTarget,
      message: event.messageTarget,
    }
  }
  return { kind: event.kind, answer: event.answerTarget, reason: event.reason, ident: event.identity }
}

describe('provider/telegram/parse — comando', () => {
  it('message com texto vira SurfaceCommandEvent com os dois eixos STRING', () => {
    const { mapear } = criarParse()
    const e = mapear(updateDeMensagem('/status'))
    assert.equal(e?.kind, 'comando')
    const comando = e as Extract<SurfaceEvent, { kind: 'comando' }>
    assert.equal(comando.identity.userKey, '777000123')
    assert.equal(comando.identity.chatKey, '777000123')
    assert.equal(comando.text, '/status')
  })

  it('userKey e chatKey sao sempre STRINGS (D4), nunca number', () => {
    const { mapear } = criarParse()
    const e = mapear(updateDeMensagem('/ligar', 777000123, 777000123)) as Extract<SurfaceEvent, { kind: 'comando' }>
    assert.equal(typeof e.identity.userKey, 'string')
    assert.equal(typeof e.identity.chatKey, 'string')
  })
})

describe('provider/telegram/parse — callback bem formado', () => {
  it('callback_query com g1:<acao>:<token> vira SurfaceActionEvent', () => {
    const { mapear } = criarParse()
    const evento = mapear(updateDeCallback('tunnel.up', 'ABCxyz-123'))
    assert.equal(evento?.kind, 'acao')
    const acao = evento as Extract<SurfaceEvent, { kind: 'acao' }>
    assert.equal(acao.action, 'tunnel.up')
    assert.equal(acao.token, 'ABCxyz-123') // OPACO (S5): transporta, nao valida
    assert.equal(acao.answerTarget, 'cq-1') // TG-027: o nucleo responde sempre
    assert.equal(acao.messageTarget, '9')
    assert.equal(acao.identity.userKey, '777000123')
  })

  it('o token viaja TAL QUAL foi emitido — o adaptador nunca o altera nem valida (S5)', () => {
    const { mapear } = criarParse()
    const token = 'someHostnonceXyz'
    const evento = mapear(updateDeCallback('secret.rotate', token)) as Extract<SurfaceEvent, { kind: 'acao' }>
    assert.equal(evento.token, token)
  })
})

describe('provider/telegram/parse — callback malformado (TG-027 + S5)', () => {
  it('payload administrativo directo (srv:off:v1) morre, com answerTarget SEMPRE e SEM action/token forjados', () => {
    const { mapear } = criarParse()
    const evento = mapear(updateDeCallback('tunnel.down', 'x', { data: 'srv:off:v1' }))
    assert.equal(evento?.kind, 'acao-invalida')
    const rejeitado = evento as Extract<SurfaceEvent, { kind: 'acao-invalida' }>
    assert.equal(rejeitado.answerTarget, 'cq-1') // TG-027
    assert.ok(rejeitado.reason !== undefined)
    // NUNCA forjar action/token (S5).
    assert.equal('action' in rejeitado, false)
    assert.equal('token' in rejeitado, false)
  })

  it('callback_data com token ausente e recusado na FORMA (nada de comando numa etapa)', () => {
    const { mapear } = criarParse()
    const evento = mapear(updateDeCallback('tunnel.up', 'x', { data: `${CALLBACK_SCHEMA}:tunnel.up:` }))
    assert.equal(evento?.kind, 'acao-invalida')
    assert.equal((evento as Extract<SurfaceEvent, { kind: 'acao-invalida' }>).answerTarget, 'cq-1')
  })

  it('callback_query sem id nao tem a quem responder — nao produz acao (fail-closed)', () => {
    const { mapear } = criarParse()
    const evento = mapear(updateDeCallback('tunnel.up', 'tok', { id: undefined }))
    assert.equal(evento, undefined)
  })
})

describe('provider/telegram/parse — superficies que nao sao comando/callback', () => {
  it('edited_message / channel_post / desconhecido -> undefined, SEM excecao (TG-012..015)', () => {
    const { mapear } = criarParse()
    assert.equal(mapear({ update_id: 3, edited_message: { from: { id: 1 }, chat: { id: 1 }, text: '/ligar' } }), undefined)
    assert.equal(mapear({ update_id: 4, channel_post: { chat: { id: -100123 }, text: '/ligar' } }), undefined)
    assert.equal(mapear({ update_id: 5, unknown_field: {} }), undefined)
    assert.equal(mapear(null), undefined)
    assert.equal(mapear('texto solto'), undefined)
  })

  it('message SEM texto (foto, sticker) nao e comando — ignorada', () => {
    const { mapear } = criarParse()
    assert.equal(mapear({ update_id: 6, message: { from: { id: 1 }, chat: { id: 1 }, photo: [{}] } }), undefined)
  })
})

describe('provider/telegram/parse — contagem de descartes (TG-089)', () => {
  it('descartado e contado: callbacks malformados e superficies inertes acumulam', () => {
    const parse = criarParse()
    parse.mapear(updateDeCallback('tunnel.up', 'x', { data: 'srv:off:v1' }))
    parse.mapear({ update_id: 4, channel_post: { chat: { id: -100 } } })
    parse.mapear(updateDeMensagem('/status')) // aceite: nao conta
    assert.ok(parse.descartados() >= 2)
  })
})

describe('provider/telegram/parse — gramatica g1 e o limite de 64 BYTES', () => {
  it('buildCallbackData monta `g1:<acao>:<token>`', () => {
    const data = buildCallbackData('tunnel.up', 'ABCxyz')
    assert.equal(data, 'g1:tunnel.up:ABCxyz')
  })

  it('o estouro dos 64 bytes FALHA ALTO em teste, nao em producao (TG-026)', () => {
    assert.throws(() => buildCallbackData('tunnel.up', 'a'.repeat(70)), /bytes/u)
  })

  it('parseCallbackData aceita so o vocabulario FECHADO de SurfaceAction (intents + navegacao)', () => {
    assert.equal(parseCallbackData('g1:tunnel.up:tok').ok, true)
    assert.equal(parseCallbackData('g1:nao-existe:tok').ok, false)
    assert.equal(parseCallbackData('g1:tunnel.down:tok').ok, true)
    // Onda 3 — navegacao LOCAL do cartao/fallback tambem e uma SurfaceAction.
    assert.equal(parseCallbackData('g1:menu:tok').ok, true)
    assert.equal(parseCallbackData('g1:ajuda:tok').ok, true)
    assert.equal(parseCallbackData('g1:inicio:tok').ok, true)
    // Onda 5 — o cancelamento das telas de confirmacao sao navegacao local tambem.
    assert.equal(parseCallbackData('g1:cancel:tok').ok, true)
  })

  it('a unidade e BYTE, nao caractere: acento custa 2', () => {
    assert.equal(utf8Bytes('confirmação'), 13)
    assert.equal(CALLBACK_DATA_MAX_BYTES, 64)
  })
})

describe('provider/telegram/parse — identidade numerica', () => {
  it('id acima de 2^53 -> sem identidade (52 bits, TG-010)', () => {
    const { mapear } = criarParse()
    const acima = Number.MAX_SAFE_INTEGER + 1 // 2^53: fora do range seguro
    assert.equal(Number.isSafeInteger(acima), false)
    const evento = mapear(updateDeMensagem('/status', acima, 777000123))
    assert.equal(evento, undefined)
  })

  it('chat.id NEGATIVO de grupo e aceite (TG-011)', () => {
    const { mapear } = criarParse()
    const e = mapear(updateDeMensagem('/status', 777000123, -1001234567890)) as Extract<SurfaceEvent, { kind: 'comando' }>
    assert.equal(e.identity.chatKey, '-1001234567890')
  })

  it('nunca lê username — a identidade vem so de from.id/chat.id numericos', () => {
    const { mapear } = criarParse()
    const e = mapear({
      update_id: 7,
      message: {
        from: {
          id: 555000111,
          username: 'dono_mutavel',
          is_bot: false,
        },
        chat: { id: 555000111, username: 'dono_mutavel', type: 'private' },
        text: '/start',
      },
    }) as Extract<SurfaceEvent, { kind: 'comando' }>
    assert.equal(e.identity.userKey, '555000111')
    assert.equal('dono' in e.identity, false)
  })

  it('resumo estrutural rodeia os casos felizes (para o handoff)', () => {
    const { mapear } = criarParse()
    assert.equal(
      JSON.stringify(comprimir(mapear(updateDeMensagem('/status')))),
      JSON.stringify({ kind: 'comando', user: '777000123', chat: '777000123', text: '/status' }),
    )
    assert.equal(
      JSON.stringify(comprimir(mapear(updateDeCallback('tunnel.up', 'tok', {})))),
      JSON.stringify({
        kind: 'acao',
        user: '777000123',
        chat: '777000123',
        action: 'tunnel.up',
        token: 'tok',
        answer: 'cq-1',
        message: '9',
      }),
    )
  })
})