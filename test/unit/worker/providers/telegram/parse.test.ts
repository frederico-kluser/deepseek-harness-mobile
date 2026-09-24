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
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import type { SurfaceEvent } from '../../../../../worker/surface/contract.ts'
import { AUMENTA_EXPOSICAO } from '../../../../../worker/surface/auth.ts'
import { ProviderError } from '../../../../../worker/providers/telegram/interno.ts'
import {
  buildCallbackData,
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_SCHEMA,
  criarParse,
  INCREASES_EXPOSURE,
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

describe('provider/telegram/parse — TG-003: os eixos do callback_query', () => {
  it('`from` vem de cq.from (QUEM carregou) e `chat` de cq.message.chat.id (ONDE) — eixos DISTINTOS', () => {
    const { mapear } = criarParse()
    const evento = mapear({
      update_id: 2,
      callback_query: {
        id: 'cq-3',
        from: { id: 111222333, is_bot: false },
        message: { message_id: 9, chat: { id: -1001234567890, type: 'supergroup' } },
        data: `${CALLBACK_SCHEMA}:tunnel.status:tok`,
      },
    })
    assert.equal(evento?.kind, 'acao')
    const acao = evento as Extract<SurfaceEvent, { kind: 'acao' }>
    // Com from.id != message.chat.id, cada eixo so pode ter vindo do sitio
    // certo: trocar os dois (M-22) derruba ESTE teste.
    assert.equal(acao.identity.userKey, '111222333')
    assert.equal(acao.identity.chatKey, '-1001234567890')
  })

  it('callback sem `message` (inline) nao tem Onde: nao ha identidade completa, ha recusa', () => {
    const { mapear } = criarParse()
    const evento = mapear({
      update_id: 2,
      callback_query: {
        id: 'cq-4',
        from: { id: 111222333, is_bot: false },
        inline_message_id: 'inline-1',
        data: `${CALLBACK_SCHEMA}:tunnel.up:tok`,
      },
    })
    assert.equal(evento?.kind, 'acao-invalida')
    const rejeitado = evento as Extract<SurfaceEvent, { kind: 'acao-invalida' }>
    assert.equal(rejeitado.answerTarget, 'cq-4') // TG-027: responde-se na mesma
    assert.equal('action' in rejeitado, false) // S5: nada se forja
    assert.equal('token' in rejeitado, false)
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

  it('payload acima de 64 bytes morre no parser (deny:callback-data-too-long), sem forjar action/token', () => {
    const { mapear } = criarParse()
    const evento = mapear(
      updateDeCallback('tunnel.up', 'x', { data: `${CALLBACK_SCHEMA}:tunnel.up:${'a'.repeat(60)}` }),
    )
    assert.equal(evento?.kind, 'acao-invalida')
    const rejeitado = evento as Extract<SurfaceEvent, { kind: 'acao-invalida' }>
    assert.equal(rejeitado.reason, 'deny:callback-data-too-long')
    assert.equal(rejeitado.answerTarget, 'cq-1') // TG-027
    assert.equal('action' in rejeitado, false)
    assert.equal('token' in rejeitado, false)
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

  it('edited_channel_post / inline_query / my_chat_member / chat_member -> undefined SEM excecao (TG-012..015)', () => {
    const { mapear } = criarParse()
    assert.equal(
      mapear({ update_id: 8, edited_channel_post: { chat: { id: -100123 }, text: '/ligar' } }),
      undefined,
    )
    assert.equal(
      mapear({ update_id: 9, inline_query: { id: 'iq-1', from: { id: 555000111 }, query: '/ligar' } }),
      undefined,
    )
    assert.equal(
      mapear({ update_id: 10, my_chat_member: { from: { id: 555000111 }, chat: { id: 555000111 } } }),
      undefined,
    )
    assert.equal(
      mapear({ update_id: 11, chat_member: { from: { id: 555000111 }, chat: { id: 555000111 } } }),
      undefined,
    )
    // `unknown`: um update com superficie fora do vocabulario (TG-014) tambem
    // cai aqui — SEM excecao, e CONTADO (TG-089).
    assert.equal(mapear({ update_id: 12, poll: { id: 'p-1', question: 'x' } }), undefined)
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

  it('contagem EXATA: cada descarte soma 1 (inclusive o `unknown`) e nada aceite soma', () => {
    const parse = criarParse()
    parse.mapear(updateDeCallback('tunnel.up', 'x', { data: 'srv:off:v1' })) // +1 malformado
    parse.mapear(updateDeCallback('tunnel.up', 'x', { id: undefined })) // +1 sem answerTarget
    parse.mapear({ update_id: 4, channel_post: { chat: { id: -100 } } }) // +1 superficie inerte
    parse.mapear({ update_id: 8, edited_channel_post: { chat: { id: -100 } } }) // +1
    parse.mapear({ update_id: 9, inline_query: { id: 'iq', from: { id: 1 } } }) // +1
    parse.mapear({ update_id: 10, my_chat_member: { from: { id: 1 }, chat: { id: 1 } } }) // +1
    parse.mapear({ update_id: 11, chat_member: { from: { id: 1 }, chat: { id: 1 } } }) // +1
    parse.mapear({ update_id: 12, poll: { id: 'p' } }) // +1 unknown (TG-089: contado)
    parse.mapear('texto solto') // +1 nao-objecto
    parse.mapear(null) // +1 nao-objecto
    parse.mapear({ update_id: 6, message: { from: { id: 1 }, chat: { id: 1 }, photo: [{}] } }) // +1 sem texto
    parse.mapear({ update_id: 7, message: { chat: { id: 1 }, text: '/x' } }) // +1 sem identidade
    parse.mapear(updateDeMensagem('/status')) // +0 aceite
    parse.mapear(updateDeCallback('tunnel.up', 'tok')) // +0 aceite
    assert.equal(parse.descartados(), 12, 'TG-089: descartado E contado — sem subcontagem furtiva')
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

  it('o limite e EXATAMENTE 64 bytes: 64 passa, 65 lanca CALLBACK_DATA_TOO_LONG (TG-026)', () => {
    // 'g1:tunnel.up:' sao 13 bytes; 51 de token = 64 bytes redondos.
    const noLimite = buildCallbackData('tunnel.up', 'a'.repeat(51))
    assert.equal(utf8Bytes(noLimite), CALLBACK_DATA_MAX_BYTES)
    assert.throws(
      () => buildCallbackData('tunnel.up', 'a'.repeat(52)),
      (error: unknown) => error instanceof ProviderError && error.reason === 'CALLBACK_DATA_TOO_LONG',
    )
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
    // EMENDA ONDA-2-CONTRATO-CAPACIDADES — as intents novas tambem sao
    // accionaveis por botao (a renderizacao e das ondas 3-4).
    assert.equal(parseCallbackData('g1:chat.new:tok').ok, true)
    assert.equal(parseCallbackData('g1:worktree.create:tok').ok, true)
    assert.equal(parseCallbackData('g1:chat.new.extra:tok').ok, false, 'a acao nao pode conter o separador')
  })

  it('a unidade e BYTE, nao caractere: acento custa 2', () => {
    assert.equal(utf8Bytes('confirmação'), 13)
    assert.equal(CALLBACK_DATA_MAX_BYTES, 64)
  })
})

describe('provider/telegram/parse — o espelho FECHADO/par de exposicao (EMENDA ONDA-2-CONTRATO-CAPACIDADES)', () => {
  it('`Record<SurfaceAction, boolean>`: TODAS as intents do contrato estao no espelho, e so elas + navegacao', () => {
    // O Record nao compila se `IpcIntentName`/`SurfaceNavAction` ganhar um
    // membro sem decisao aqui — este teste prende o CONTEUDO da decisao.
    const chaves = Object.keys(INCREASES_EXPOSURE).toSorted()
    assert.deepEqual(chaves, [
      'agent.cancel',
      'agent.dispatch',
      'agent.status',
      'ajuda',
      'cancel',
      'chat.new',
      'emergency',
      'inicio',
      'menu',
      'secret.rotate',
      'session.issue',
      'tunnel.down',
      'tunnel.status',
      'tunnel.up',
      'worktree.create',
    ])
  })

  it('chat.new e worktree.create AUMENTAM exposicao (criam sessao/chat e worktree no host -> nonce reset)', () => {
    assert.equal(INCREASES_EXPOSURE['chat.new'], true)
    assert.equal(INCREASES_EXPOSURE['worktree.create'], true)
  })

  it('PAR fechado: INCREASES_EXPOSURE (parse) e AUMENTA_EXPOSICAO (auth) tem EXATAMENTE as mesmas entradas', () => {
    // Sao dois espelhos do mesmo vocabulario (fronteira D4 impede o import
    // comum); se alguem decidir num e esquecer o outro, isto fica vermelho.
    assert.deepEqual(INCREASES_EXPOSURE, AUMENTA_EXPOSICAO)
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

  it('ESTRUTURAL: nenhuma linha de codigo do parse.ts toca em `username` (TG-008)', () => {
    // O teste que prova a regra PERGUNTANDO ao fonte: o JSDoc FALA de username,
    // o codigo nao pode LER. Um `.username` reintroduzido em extraccao de
    // identidade derruba ESTE teste — usernames sao mutaveis e spoofaveis.
    const alvo = new URL('../../../../../worker/providers/telegram/parse.ts', import.meta.url)
    const codigo = readFileSync(alvo, 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
      .replaceAll(/(^|\s)\/\/.*$/gmu, '$1')
    assert.equal(
      /\busername\b/iu.test(codigo),
      false,
      'parse.ts le `username` — a allowlist e SO numerica (TG-008)',
    )
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