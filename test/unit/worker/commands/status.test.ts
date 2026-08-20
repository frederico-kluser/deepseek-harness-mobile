/**
 * `worker/commands/status.ts` — /status e /emergencia.
 *
 * COBRE TG-084 (/status: estado, seq, tunel, ha quanto tempo, quando o TTL
 * expira; sem segredo nem digest), TG-087 (/emergencia: derruba tunel E
 * worker, responde UMA vez, idempotente, sem confirmacao) e CTL-024 (o intent
 * de emergencia nao carrega nonce).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { callbackQuery, dmMessage, pairCommand, OWNER } from '../../../support/fixtures/telegram/updates.ts'
import { montarBancada, tick } from './apoio.ts'

/** O digest do segredo: nunca pode aparecer no texto de /status (TG-084). */
const DIGEST = 'a'.repeat(64)

describe('TG-084: /status — estado, seq, tunel, tempo no ar e expiracao do TTL', () => {
  it('responde a partir do ack, com estado, seq, URL, tempo no ar e TTL', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    // O host difunde READY (seq 7, URL, expira em 5 min).
    bancada.roteador.onState({
      v: 1,
      type: 'state',
      state: 'READY',
      seq: 7,
      url: 'https://exemplo.trycloudflare.com',
      expiresAt: bancada.time.now() + 5 * 60_000,
    })
    await tick()
    bancada.time.advance(2 * 60_000) // 2 minutos depois

    await bancada.tratar(dmMessage(OWNER, '/status'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId, result: 'accepted', state: 'READY' })
    await tick()

    // A resposta de /status EDITA a mensagem da difusao in-place (TG-028).
    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    const texto = edicao.texto
    assert.match(texto, /Estado: online \(READY\)/u)
    assert.match(texto, /Sequência: 7/u)
    assert.match(texto, /Túnel: https:\/\/exemplo\.trycloudflare\.com/u)
    assert.match(texto, /No ar há: 2 min/u)
    assert.match(texto, /Expira: em 3 min/u)
  })

  it('fora de READY nao ha URL: a difusao de STARTING nao a divulga', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    bancada.roteador.onState({ v: 1, type: 'state', state: 'STARTING', seq: 3 })
    await tick()

    await bancada.tratar(dmMessage(OWNER, '/status'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId, result: 'accepted', state: 'STARTING' })
    await tick()

    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    const texto = edicao.texto
    assert.match(texto, /Estado: ligando \(STARTING\)/u)
    assert.ok(!texto.includes('https://'), 'a URL so existe em READY')
    assert.ok(!texto.includes('Túnel:'), 'a URL so existe em READY')
  })

  it('nunca expoe segredo nem digest (TG-084)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    bancada.roteador.onState({
      v: 1,
      type: 'state',
      state: 'READY',
      seq: 9,
      url: 'https://exemplo.trycloudflare.com',
      expiresAt: bancada.time.now() + 60_000,
    })
    await tick()

    await bancada.tratar(dmMessage(OWNER, '/status'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId, result: 'accepted', state: 'READY' })
    await tick()

    const edicao = bancada.api.edicoes.at(-1)
    const texto = `${edicao?.texto ?? ''}${bancada.api.mensagens.map((m) => m.texto).join('\n')}`
    assert.ok(!texto.includes(DIGEST), 'o digest nao pode aparecer')
    assert.ok(!texto.includes('sha256'), 'nenhum material de verificacao')
  })

  it('o intent tunnel.status nao estende o TTL (leitura pura)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/status'))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'tunnel.status')
    assert.equal(Object.hasOwn(intent, 'nonce'), false)
  })
})

describe('TG-087: /emergencia — derruba tunel e worker, responde uma vez, idempotente', () => {
  it('envia o intent emergency SEM nonce e responde UMA vez', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/emergencia'))

    assert.equal(bancada.ipc.intents.length, 1)
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'emergency')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'CTL-024: a acao que reduz nao exige nonce')
    assert.equal(bancada.api.mensagens.length, 2)
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /Emergência: a desligar o túnel e este bot/u)
    assert.equal(bancada.paradas(), 1, 'o worker foi derrubado')
  })

  it('o segundo /emergencia e IDEMPOTENTE: nada de novo', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/emergencia'))
    const intents = bancada.ipc.intents.length
    const mensagens = bancada.api.mensagens.length

    await bancada.tratar(dmMessage(OWNER, '/emergencia'))

    assert.equal(bancada.ipc.intents.length, intents, 'nenhum intent novo')
    assert.equal(bancada.api.mensagens.length, mensagens, 'nenhuma resposta nova')
    assert.equal(bancada.paradas(), 1, 'o worker nao e derrubado duas vezes')
  })

  it('o botao de um notify (emergencia) derruba tudo e responde uma vez', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    bancada.roteador.onNotify({ v: 1, type: 'notify', texto: 'alerta:auth-falha\nTentativa de acesso falhada.' })
    await tick()
    const botao = (bancada.api.mensagens.at(-1)?.opcoes?.reply_markup?.inline_keyboard as
      | Array<Array<{ callback_data?: string }>>
      | undefined)?.[0]?.[0]?.callback_data
    assert.ok(typeof botao === 'string')

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data: botao }))

    assert.equal(bancada.ipc.intents.at(-1)?.intent, 'emergency')
    assert.equal(bancada.paradas(), 1)
    assert.equal(bancada.api.respostas.length, 1, 'o clique do botao foi respondido (TG-027)')
  })
})
