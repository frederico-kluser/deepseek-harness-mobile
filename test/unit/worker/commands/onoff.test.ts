/**
 * `worker/commands/onoff.ts` — /ligar e /desligar.
 *
 * COBRE TG-082 (/ligar: 2 etapas, nonce do host, so a confirmacao executa),
 * TG-083 (/desligar: 2 etapas, executa a reducao), CTL-023 (sem confirmacao
 * nao ha intent que aumente exposicao), CTL-024 (o intent que REDUZ nao
 * carrega nonce), S5 (o nonce viaja OPACO — reusar um consumido nao e travado
 * pelo worker, e o host e quem recusa) e as perguntas 1 e 2 da revisao
 * (answerCallbackQuery em todos os caminhos; callback_data dentro de 64
 * BYTES).
 */

import assert from 'node:assert/strict'
import { TextEncoder } from 'node:util'
import { describe, it } from 'node:test'

import {
  callbackQuery,
  dmMessage,
  GROUP,
  OWNER,
  pairCommand,
  pairCommandInGroup,
} from '../../../support/fixtures/telegram/updates.ts'
import { montarBancada, tick } from './apoio.ts'

/** O data do UNICO botao do teclado de uma resposta. */
function dataDoBotao(mensagem: { opcoes: { reply_markup?: { inline_keyboard?: unknown[] } } | undefined }): string {
  const teclado = mensagem.opcoes?.reply_markup?.inline_keyboard as
    | Array<Array<{ callback_data?: string }>>
    | undefined
  const data = teclado?.[0]?.[0]?.callback_data
  assert.ok(typeof data === 'string', 'esperava um botao com callback_data')
  return data
}

function botaoDaMensagem(bancada: { api: { mensagens: Array<{ opcoes: { reply_markup?: { inline_keyboard?: unknown[] } } | undefined }> } }): string {
  const ultima = bancada.api.mensagens.at(-1)
  assert.ok(ultima !== undefined)
  return dataDoBotao(ultima)
}

describe('TG-082: /ligar — confirmacao de 2 etapas com nonce emitido pelo host', () => {
  it('responde com teclado e nonce do host; NENHUM intent antes do clique', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))

    assert.equal(bancada.ipc.intents.length, 0, 'so a confirmacao executa')
    const data = botaoDaMensagem(bancada)
    assert.match(data, /^g1:tunnel\.up:/u)
    const nonce = data.slice('g1:tunnel.up:'.length)
    assert.ok(bancada.host.foiEmitido(nonce), 'o nonce do botao foi emitido pelo host')
  })

  it('so o clique envia o intent, com o nonce opaco e um requestId novo', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = botaoDaMensagem(bancada)

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(bancada.ipc.intents.length, 1)
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'tunnel.up')
    assert.equal(intent.nonce, data.slice('g1:tunnel.up:'.length))
    assert.match(intent.requestId, /^[0-9A-HJKMNP-TV-Z]{26}$/u)
    assert.equal(intent.from, OWNER)
    assert.equal(intent.chat, OWNER)
    // TG-027: o clique foi respondido.
    assert.equal(bancada.api.respostas.length, 1)
  })

  it('CTL-023 (face worker): sem nonce do host, falha FECHADO — nenhum intent', async () => {
    const bancada = montarBancada({
      emitirNonce: () => undefined,
    })
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))

    assert.equal(bancada.ipc.intents.length, 0, 'nenhum spawn: nao ha intent sequer')
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /Não foi possível obter a confirmação/u)
  })

  it('S5: um nonce JA CONSUMIDO e reusado — o worker transporta-o opaco e o host recusa', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = botaoDaMensagem(bancada)
    const nonce = data.slice('g1:tunnel.up:'.length)

    // 1o clique: o intent sai com o nonce, e o host consome-o.
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    assert.equal(bancada.ipc.intents[0]?.nonce, nonce)
    assert.equal(bancada.host.consumir(nonce), true, 'o 1o uso consome o nonce')

    // 2o clique com o MESMO callback_data: o worker NAO valida (S5) — reenvia
    // o mesmo valor opaco, e o host e quem recusa o replay.
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    assert.equal(bancada.ipc.intents.length, 2, 'o worker transportou o nonce consumido outra vez')
    assert.equal(bancada.ipc.intents[1]?.nonce, nonce)
    assert.equal(bancada.host.consumir(nonce), false, 'o host recusa o replay')
  })

  it('o ack de recusa do host (nonce invalido) e renderizado na mensagem do teclado', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = botaoDaMensagem(bancada)
    const mensagemDoTeclado = bancada.api.mensagens.at(-1)?.texto

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    bancada.roteador.onAck({
      v: 1,
      type: 'ack',
      requestId: intent.requestId,
      result: 'rejected',
      state: 'STOPPED',
      code: 'NONCE_INVALID',
    })
    await tick()

    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.match(edicao.texto, /Confirmação inválida ou expirada/u)
    assert.notEqual(edicao.texto, mensagemDoTeclado)
  })

  it('pergunta 2 da revisao: o callback_data cabe em 64 BYTES (nao caracteres)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = botaoDaMensagem(bancada)

    assert.ok(new TextEncoder().encode(data).length <= 64, `data com ${String(new TextEncoder().encode(data).length)} bytes`)
  })

  it('o botao de /desligar tambem cabe em 64 bytes', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = botaoDaMensagem(bancada)
    assert.ok(new TextEncoder().encode(data).length <= 64)
  })
})

describe('TG-083: /desligar — 2 etapas, e o intent REDUZ sem nonce (CTL-024)', () => {
  it('nao executa de primeira: responde com teclado de confirmacao', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/desligar'))

    assert.equal(bancada.ipc.intents.length, 0, 'nao executa antes da confirmacao (TG-020)')
    assert.match(botaoDaMensagem(bancada), /^g1:tunnel\.down:/u)
  })

  it('o clique envia tunnel.down SEM campo nonce (CTL-024)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = botaoDaMensagem(bancada)

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(bancada.ipc.intents.length, 1)
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'tunnel.down')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'a acao que reduz nao carrega nonce')
    assert.equal(bancada.api.respostas.length, 1, 'o clique foi respondido')
  })

  it('o token do teclado e de USO UNICO: o segundo clique nao envia nada', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = botaoDaMensagem(bancada)

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(bancada.ipc.intents.length, 1, 'replay do token: nenhum intent novo')
  })

  it('o token expira (TTL 60 s, relogio injetado): o clique morre em silencio', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = botaoDaMensagem(bancada)
    bancada.time.advance(61_000)

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.api.respostas.length, 1, 'o answer sempre vem (TG-027)')
    assert.match(bancada.api.respostas[0]?.outras?.text ?? '', /Confirmação expirada ou inválida/u)
  })

  it('token forjado (teclado alheio): descartado — nenhum intent, silencio de conteudo', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    // O atacante com o token do bot manda um teclado; o dono clica.
    await bancada.tratar(
      callbackQuery({ from: OWNER, chat: OWNER, data: 'g1:tunnel.down:AAAAAAAAAAA' }),
    )

    assert.equal(bancada.ipc.intents.length, 0, 'o botao forjado nao executa (TG-025)')
    assert.equal(bancada.api.respostas.length, 1)
    assert.equal(bancada.api.respostas[0]?.outras, undefined, 'sem oraculo para o teclado alheio')
  })

  it('TG-024: o token e ligado ao emissor — outro eixo do dono nao executa', async () => {
    // Pareia-se num GRUPO (from != chat): a allowlist passa a admitir os dois
    // eixos, e o token emitido num eixo nao vale no outro.
    const bancada = montarBancada()
    await bancada.tratar({ ...pairCommandInGroup(OWNER, GROUP, '123456') })
    // O /desligar chega do eixo privado (from=chat=OWNER).
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = botaoDaMensagem(bancada)

    // O mesmo botao, clicado do eixo do GRUPO: admitido pela allowlist, mas o
    // token nao e do emissor -> rejeitado, nenhum intent.
    await bancada.tratar(callbackQuery({ from: OWNER, chat: GROUP, data }))

    assert.equal(bancada.ipc.intents.length, 0, 'o token nao viaja entre eixos')
    assert.equal(bancada.api.respostas.length, 1)
    assert.match(bancada.api.respostas[0]?.outras?.text ?? '', /Confirmação expirada ou inválida/u)
  })
})

describe('o ack do /desligar edita o teclado in-place (TG-028)', () => {
  it('aceite -> «A desligar o túnel…» na mensagem do botao', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = botaoDaMensagem(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)

    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STOPPING' })
    await tick()

    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.match(edicao.texto, /A desligar o túnel/u)
  })
})
