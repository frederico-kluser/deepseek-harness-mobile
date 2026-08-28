/**
 * `worker/providers/discord/teclado.ts` — a renderizacao das linhas de acao
 * neutras em `components` do Discord, a resposta ao clique (TG-027) e a
 * edicao in-place.
 *
 * Cobre: ActionRow 5×5 com `custom_id` na gramatica `g1`, o teto de 100 bytes
 * (2.a linha de defesa), a resposta SEMPRE ao clique (type 6 sem texto / type
 * 4 efemera com texto — nunca lanca), o alvo invalido devolvendo `false` sem
 * lanca, e a edicao com `components` SEMPRE explicito (anti duplo-toque).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ActionRowLayout, SurfaceAction } from '../../../../../worker/surface/contract.ts'
import {
  answerCallbackAlways,
  assertCustomId,
  BUTTON_LABEL_MAX_CHARS,
  CALLBACK_CHANNEL_MESSAGE_WITH_SOURCE,
  CALLBACK_DEFERRED_UPDATE_MESSAGE,
  editMessageInPlace,
  MESSAGE_FLAG_EPHEMERAL,
  renderActionRowLayout,
  type TecladoApi,
} from '../../../../../worker/providers/discord/teclado.ts'
import { montarAnswerTarget } from '../../../../../worker/providers/discord/parse.ts'
import { captureLog, type LogCapturado } from './apoio.ts'

/** Uma linha de botao com os campos do contrato. */
function botao(label: string, action: SurfaceAction, token: string): { label: string; action: SurfaceAction; token: string } {
  return { label, action, token }
}

describe('provider/discord/teclado — renderizacao', () => {
  it('ActionRowLayout vira ActionRows com Buttons (style 1) e custom_id g1', () => {
    const layout: ActionRowLayout = [[botao('Ligar', 'tunnel.up', 'nonceA')]]
    const componentes = renderActionRowLayout(layout)
    assert.deepEqual(componentes, [
      {
        type: 1,
        components: [{ type: 2, style: 1, label: 'Ligar', custom_id: 'g1:tunnel.up:nonceA' }],
      },
    ])
  })

  it('5 linhas x 5 botoes renderizam (o teto do Discord); o nucleo ja cortou', () => {
    const layout: ActionRowLayout = Array.from({ length: 5 }, (_linha, r) =>
      Array.from({ length: 5 }, (_coluna, c) => botao(`B${r}${c}`, 'menu', `tok${r}${c}`)),
    )
    const componentes = renderActionRowLayout(layout)
    assert.ok(componentes !== undefined)
    assert.equal(componentes.length, 5)
    for (const linha of componentes) {
      assert.equal((linha as { components: unknown[] }).components.length, 5)
    }
  })

  it('rotulo vazio, rotulo acima de 80 chars ou custom_id invalido: botao descartado com warn', () => {
    const log = captureLog()
    const layout: ActionRowLayout = [
      [botao('', 'menu', 'tok'), botao('x'.repeat(BUTTON_LABEL_MAX_CHARS + 1), 'menu', 'tok'), botao('Ok', 'menu', 'com:separador')],
    ]
    const componentes = renderActionRowLayout(layout, log.logger)
    assert.equal(componentes, undefined, 'nenhum botao valido -> sem ActionRow')
    assert.ok(log.lines.length >= 3, 'cada descarte e registado')
  })

  it('assertCustomId e a 2.a linha de defesa dos 100 bytes', () => {
    assert.equal(assertCustomId('g1:menu:tok'), 'g1:menu:tok')
    assert.throws(() => assertCustomId(''), /vazio/u)
    assert.throws(() => assertCustomId('x'.repeat(200)), /100 BYTES/u)
  })
})

/** Um api de teste que registra os callbacks enviados. */
function apiDeTeste(): { api: TecladoApi; chamadas: Array<{ tipo: number; data?: Record<string, unknown> }>; falhas: number } {
  const chamadas: Array<{ tipo: number; data?: Record<string, unknown> }> = []
  return {
    chamadas,
    falhas: 0,
    api: {
      async answerInteraction(_id: string, _token: string, corpo: { type: number; data?: Record<string, unknown> }) {
        chamadas.push({ tipo: corpo.type, ...(corpo.data === undefined ? {} : { data: corpo.data }) })
        return {}
      },
      async editMessage() {
        return { id: 'x' }
      },
    },
  }
}

describe('provider/discord/teclado — resposta ao clique (TG-027)', () => {

  it('sem texto: ACK silencioso (type 6 DEFERRED_UPDATE_MESSAGE) — o girador para', async () => {
    const { api, chamadas } = apiDeTeste()
    const alvo = montarAnswerTarget({ interactionId: 'i1', interactionToken: 't1' })
    const ok = await answerCallbackAlways(api, alvo, captureLog().logger)
    assert.equal(ok, true)
    assert.deepEqual(chamadas[0], { tipo: CALLBACK_DEFERRED_UPDATE_MESSAGE })
  })

  it('com texto: type 4 CHANNEL_MESSAGE_WITH_SOURCE EFEMERA (flags 64) — o toast', async () => {
    const { api, chamadas } = apiDeTeste()
    const alvo = montarAnswerTarget({ interactionId: 'i1', interactionToken: 't1' })
    const ok = await answerCallbackAlways(api, alvo, captureLog().logger, { text: 'Ok, cancelado.' })
    assert.equal(ok, true)
    assert.deepEqual(chamadas[0], {
      tipo: CALLBACK_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Ok, cancelado.', flags: MESSAGE_FLAG_EPHEMERAL },
    })
  })

  it('NUNCA lanca: falha do canal devolve false e o comando segue', async () => {
    const api: TecladoApi = {
      async answerInteraction() {
        throw new Error('rate limited')
      },
      async editMessage() {
        return { id: 'x' }
      },
    }
    const log = captureLog()
    const alvo = montarAnswerTarget({ interactionId: 'i1', interactionToken: 't1' })
    const ok = await answerCallbackAlways(api, alvo, log.logger)
    assert.equal(ok, false)
    assert.ok(log.lines.some((l) => l.includes('callback de interacao falhou')))
  })

  it('answerTarget que o parse nao montou: false sem lanca (sem par nao ha o que responder)', async () => {
    const { api, chamadas } = apiDeTeste()
    const ok = await answerCallbackAlways(api, 'alvo-estranho', captureLog().logger)
    assert.equal(ok, false)
    assert.equal(chamadas.length, 0, 'nada foi ao canal')
  })
})

describe('provider/discord/teclado — edicao in-place', () => {
  it('PATCH com components SEMPRE explicito (anti duplo-toque) — veredito edited', async () => {
    const edits: Array<{ content: string; components: unknown[] }> = []
    const api: TecladoApi = {
      async answerInteraction() {
        return {}
      },
      async editMessage(_c: string, _m: string, corpo: { content: string; components: unknown[] }) {
        edits.push({ content: corpo.content, components: corpo.components })
        return { id: 'm1' }
      },
    }
    const log = captureLog()
    // SEM actionRows: components [] — destruir os botoes.
    assert.equal(await editMessageInPlace(api, { channelId: 'c1', messageId: 'm1' }, 'novo', log.logger), 'edited')
    assert.deepEqual(edits[0], { content: 'novo', components: [] })
    // COM actionRows: components novos.
    const layout: ActionRowLayout = [[botao('Ligar', 'tunnel.up', 'tok')]]
    assert.equal(
      await editMessageInPlace(api, { channelId: 'c1', messageId: 'm1' }, 'com botao', log.logger, renderActionRowLayout(layout)),
      'edited',
    )
    const editado = edits[1]
    assert.ok(editado !== undefined, 'a segunda edicao chegou ao canal')
    assert.equal(editado.components.length, 1)
  })

  it('falha do canal -> failed (nunca lanca); loga a causa', async () => {
    const api: TecladoApi = {
      async answerInteraction() {
        return {}
      },
      async editMessage() {
        throw new Error('unknown message')
      },
    }
    const log = captureLog()
    const veredito = await editMessageInPlace(api, { channelId: 'c1', messageId: 'm1' }, 'x', log.logger)
    assert.equal(veredito, 'failed')
    assert.ok(log.lines.some((l) => l.includes('edicao da mensagem falhou')))
  })
})

export type { LogCapturado }
