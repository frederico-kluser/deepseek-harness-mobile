/**
 * `worker/commands/access.ts` — /acessar e /rotacionar.
 *
 * COBRE TG-085 (/acessar: o link magico chega pelo notify do host; nunca a
 * senha), TG-086 (/rotacionar: 2 etapas com nonce, e a senha nova nunca sai
 * pelo chat) e CTL-023 (a face worker: /rotacionar sem nonce falha fechado).
 *
 * A senha PERMANENTE nao existe neste worker: os testes proveem-no
 * comportamentalmente — um valor conhecido que seria o segredo nunca aparece
 * em payload nenhum (o espirito de S3).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { callbackQuery, dmMessage, pairCommand, OWNER } from '../../../support/fixtures/telegram/updates.ts'
import { montarBancada, tick } from './apoio.ts'

/** O segredo permanente conhecido: nunca pode aparecer em lado nenhum (S3). */
const SENHA = 'senha-que-nunca-pode-sair-0123456789'

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

describe('TG-085: /acessar — o link magico chega pelo notify do host', () => {
  it('envia o intent session.issue sem nonce, e nada responde no chat antes do host', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/acessar'))

    assert.equal(bancada.ipc.intents.length, 1)
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'session.issue')
    assert.equal(Object.hasOwn(intent, 'nonce'), false)
    assert.equal(bancada.api.mensagens.length, 1, 'so a resposta do pareamento')
  })

  it('o notify link-magico e renderizado com disable_web_page_preview e SEM botoes', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    bancada.roteador.onNotify({
      v: 1,
      type: 'notify',
      texto: `alerta:link-magico\nSeu link com a chave de acesso:\nhttps://exemplo.trycloudflare.com/?key=${SENHA}`,
    })
    await tick()

    const mensagem = bancada.api.mensagens.at(-1)
    assert.ok(mensagem !== undefined)
    // O marcador e ocultado; o link (com a chave na QUERY ?key=) passa intacto.
    assert.ok(!mensagem.texto.includes('alerta:link-magico'))
    assert.ok(mensagem.texto.includes('https://exemplo.trycloudflare.com/?key='))
    assert.equal(mensagem.opcoes?.disable_web_page_preview, true)
    const markup = mensagem.opcoes === undefined ? undefined : mensagem.opcoes.reply_markup
    assert.equal(markup, undefined, 'link-magico nao ganha botao')
  })

  it('TG-085: a senha NUNCA sai pelo chat — nem no notify, nem em payload', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    // O host compoe o notify com a instrucao do caminho local (opt-out), sem a
    // senha; e o worker nao tem a senha em lado nenhum para a enviar.
    bancada.roteador.onNotify({
      v: 1,
      type: 'notify',
      texto: 'alerta:link-magico\nO painel está em http://127.0.0.1:3080/__guard — abra na máquina.',
    })
    await tick()

    const tudo = JSON.stringify({
      mensagens: bancada.api.mensagens,
      intents: bancada.ipc.intents,
      edicoes: bancada.api.edicoes,
    })
    assert.ok(!tudo.includes(SENHA), 'a senha nao pode aparecer em payload nenhum')
  })
})

describe('TG-086: /rotacionar — 2 etapas com nonce, senha nova nunca pelo chat', () => {
  it('pede confirmacao com nonce do host e so o clique envia secret.rotate', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/rotacionar'))

    assert.equal(bancada.ipc.intents.length, 0, 'so a confirmacao executa')
    const data = dataDoBotao(bancada)
    assert.match(data, /^g1:secret\.rotate:/u)
    const nonce = data.slice('g1:secret.rotate:'.length)
    assert.ok(bancada.host.foiEmitido(nonce))

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(bancada.ipc.intents.length, 1)
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'secret.rotate')
    assert.equal(intent.nonce, nonce, 'o nonce viaja opaco')
  })

  it('sem nonce do host, /rotacionar falha fechado — nenhum intent', async () => {
    const bancada = montarBancada({ emitirNonce: async () => undefined })
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/rotacionar'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /Não foi possível obter a confirmação/u)
  })

  it('a senha nova nao viaja pelo chat: o notify fala da chave, nunca o valor', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    // O host, apos o secret.rotate aceite, compoe o notify da rotacao da
    // chave — SEM o valor do segredo.
    bancada.roteador.onNotify({
      v: 1,
      type: 'notify',
      texto:
        'alerta:link-magico\nChave de acesso nova gerada: a anterior foi revogada e as sessões atuais invalidadas. O link novo terá a chave nova embutida.',
    })
    await tick()

    const tudo = JSON.stringify({ mensagens: bancada.api.mensagens, intents: bancada.ipc.intents })
    assert.ok(!tudo.includes(SENHA), 'a senha nova nunca sai pelo chat')
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /chave/i)
  })
})
