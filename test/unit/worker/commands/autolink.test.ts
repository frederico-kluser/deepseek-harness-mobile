/**
 * AUTOLINK (onda1): o link autenticado sai SOZINHO quando o tunel que o dono
 * mandou ligar fica READY — uma unica vez por ligacao, e o /desligar nao o
 * reenvia. O `mk` do link e composto SO pelo HOST (session.issue); este worker
 * apenas o pede automaticamente. O `/acessar` continua a funcionar como hoje.
 *
 * COBRE: (a) ligar -> READY -> UMA `session.issue`; (b) dedupe (difusoes
 * seguintes de READY nao reenviam); (c) /desligar -> nenhum link; (d) `tunnel.up`
 * noop (o tunel ja estava READY) -> nenhum link; (e) o texto do /ligar anuncia
 * que o link chegara.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IpcStateMessage } from '../../../../src/contracts/ipc.ts'
import {
  callbackQuery,
  dmMessage,
  OWNER,
  pairCommand,
} from '../../../support/fixtures/telegram/updates.ts'
import { montarBancada, tick } from './apoio.ts'

const URL = 'https://x.trycloudflare.com'

/** Estado READY no formato do contrato IPC. */
function ready(seq: number): IpcStateMessage {
  return { v: 1, type: 'state', state: 'READY', seq, url: URL, expiresAt: 9_000 }
}

function starting(seq: number): IpcStateMessage {
  return { v: 1, type: 'state', state: 'STARTING', seq }
}

/** data do UNICO botao da ultima mensagem (o teclado de confirmacao). */
function dataDoBotao(bancada: { api: { mensagens: Array<{ opcoes: { reply_markup?: { inline_keyboard?: unknown[] } } | undefined }> } }): string {
  const ultima = bancada.api.mensagens.at(-1)
  assert.ok(ultima !== undefined)
  const teclado = ultima.opcoes?.reply_markup?.inline_keyboard as
    | Array<Array<{ callback_data?: string }>>
    | undefined
  const data = teclado?.[0]?.[0]?.callback_data
  assert.ok(typeof data === 'string')
  return data
}

describe('autolink: /ligar -> READY -> o link da chave de acesso sai', () => {
  it('confirma o /ligar, o tunel fica READY e pede session.issue UMA vez', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(bancada.ipc.intents.length, 1, 'so o tunnel.up apos a confirmacao')
    assert.equal(bancada.ipc.intents[0]?.intent, 'tunnel.up')

    // O host confirma (accepted) e o tunel sobe: STARTING -> READY.
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
    bancada.roteador.onState(starting(1))
    bancada.roteador.onState(ready(2))

    assert.equal(bancada.ipc.intents.length, 2, 'o autolink pediu session.issue')
    const pedido = bancada.ipc.intents[1]
    assert.ok(pedido !== undefined)
    assert.equal(pedido.intent, 'session.issue')
    assert.equal(pedido.from, OWNER, 'a identidade do /ligar do dono')
    assert.equal(Object.hasOwn(pedido, 'nonce'), false, 'session.issue nao exige nonce (TG-085)')
  })

  it('o notify que o host devolve ao READY renderiza UMA mensagem com ?key= e NAO com #mk=', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
    bancada.roteador.onState(ready(1))

    // O host compoe e notifica o link ?key= (a chave 256 bits); o worker so
    // renderiza. NAO ha prompt nem senha no texto.
    bancada.roteador.onNotify({
      v: 1,
      type: 'notify',
      texto:
        'alerta:link-magico\nSeu link com a chave de acesso (abre e entra, sem senha):\nhttps://x.trycloudflare.com/?key=ABC234GHJ5678LMNPQRSTVWXYZ234567',
    })
    await tick()

    const textosComLink = bancada.api.mensagens
      .map((m) => m.texto)
      .filter((t) => t.includes('x.trycloudflare.com'))
    assert.equal(textosComLink.length, 1, 'exatamente UMA mensagem do link')
    assert.match(textosComLink[0] ?? '', /\?key=/u, 'a chave vai na query ?key=')
    assert.ok(!(textosComLink[0] ?? '').includes('#mk='), 'NAO usa o fragmento #mk=')
    assert.match(textosComLink[0] ?? '', /sem senha/u, 'o texto anuncia acesso sem senha')
  })

  it('dedupe: difusoes seguintes de READY (mesma ligacao) NAO reenviam o pedido', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)

    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
    bancada.roteador.onState(ready(1))
    assert.equal(bancada.ipc.intents.length, 2, 'primeiro READY pede o link')

    // Re-difusoes de READY (probe do /status, reconexao, seq novo) — nao reenvia.
    bancada.roteador.onState(ready(2))
    bancada.roteador.onState(ready(3))
    assert.equal(bancada.ipc.intents.length, 2, 'o autolink e de UMA ligacao')
  })
})

describe('autolink: /desligar e noop nao disparam o link', () => {
  it('confirma o /desligar e o tunel READY — nenhum session.issue', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(bancada.ipc.intents.length, 1, 'so o tunnel.down')
    assert.equal(bancada.ipc.intents[0]?.intent, 'tunnel.down')

    // O tunel sobe (diffusao READY trazida pelo estado) mesmo assim.
    bancada.roteador.onState(starting(1))
    bancada.roteador.onState(ready(2))

    assert.equal(bancada.ipc.intents.length, 1, 'sem autolink no /desligar: nenhum session.issue')
  })

  it('tunnel.up accepted mas ack noop (o tunel JÁ estava READY) — nenhum link', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)

    // Ja estava em READY: o host responde noop (CTL-003) — nenhuma ligacao nova.
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'noop', state: 'READY' })
    bancada.roteador.onState(ready(1))

    assert.equal(bancada.ipc.intents.length, 1, 'noop em READY nao gera link (nao ha ligacao nova)')
  })

  it('tunnel.up rejected (nonce invalido) — nenhum link', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)

    bancada.roteador.onAck({
      v: 1,
      type: 'ack',
      requestId: upRequest,
      result: 'rejected',
      state: 'STOPPED',
      code: 'NONCE_INVALID',
    })
    bancada.roteador.onState(ready(1))

    assert.equal(bancada.ipc.intents.length, 1, 'tunnel.up recusado nao arma autolink')
  })

  it('DOUBLE-TAP: req1 aceite + req2 recusado -> a ligacao boa ainda envia 1 session.issue', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    // Dois cliques no MESMO callback_data do /ligar: o guard NAO deduplica
    // callbacks (por desenho) e as duas confirmacoes enviam tunnel.up (req1,
    // req2). O host serializa: req1 accepted/STARTING, req2 rejected (o
    // nonce ja foi consumido pela req1).
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    assert.equal(bancada.ipc.intents.length, 2, 'guarda nao deduplica; duas confirmacoes')

    const req1 = bancada.ipc.intents[0]?.requestId
    const req2 = bancada.ipc.intents[1]?.requestId
    assert.ok(req1 !== undefined && req2 !== undefined && req1 !== req2)

    // req1 esta STARTING (aceite); req2 e recusada (NONCE_INVALID).
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: req1, result: 'accepted', state: 'STARTING' })
    bancada.roteador.onAck({
      v: 1,
      type: 'ack',
      requestId: req2,
      result: 'rejected',
      state: 'STARTING',
      code: 'NONCE_INVALID',
    })
    bancada.roteador.onState(starting(1))
    bancada.roteador.onState(ready(2))

    // O ack rejected da req2 NAO pode desarmar o autolink da req1 (chaveado por
    // requestId): a ligacao boa (capturada pela req1, aceite) continua a valer.
    const pedidos = bancada.ipc.intents.filter((i) => i.intent === 'session.issue')
    assert.equal(pedidos.length, 1, 'double-tap: exatamente UMA session.issue (a ligacao boa)')
  })

  it('RE-CONFIRMAR /ligar enquanto STARTING: o noop da 2a nao apaga o autolink da 1a', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    // 1a ligacao: confirmacao enviada e aceite (STARTING).
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data1 = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data: data1 }))
    const req1 = bancada.ipc.intents[0]?.requestId
    assert.ok(req1 !== undefined)
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: req1, result: 'accepted', state: 'STARTING' })

    // Dono re-confirma enquanto STARTING: novo /ligar (novo nonce do host) +
    // clique -> req2, que o host responde noop('STARTING').
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data2 = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data: data2 }))
    const req2 = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(req2 !== undefined && req2 !== req1)
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: req2, result: 'noop', state: 'STARTING' })

    bancada.roteador.onState(starting(1))
    bancada.roteador.onState(ready(2))

    const pedidos = bancada.ipc.intents.filter((i) => i.intent === 'session.issue')
    assert.equal(pedidos.length, 1, 're-confirmar nao apaga o autolink da ligacao aceite')
  })
})

describe('autolink: o texto do /ligar anuncia o link', () => {
  it('a confirmacao de /ligar diz que o link da chave de acesso chegara', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/ligar'))

    const texto = bancada.api.mensagens.at(-1)?.texto ?? ''
    assert.match(texto, /Ligar o túnel/u)
    assert.match(texto, /chave de acesso/u, 'o dono sabe que o link chegara automaticamente')
  })
})