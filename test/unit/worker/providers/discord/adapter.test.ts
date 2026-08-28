/**
 * `worker/providers/discord/adapter.ts` — o PROVIDER discord inteiro contra o
 * duble congelado (REST + gateway WS no mesmo listener): a superficie
 * completa (id/limits/start/stop/publishCommands/sender), o mapeamento
 * payload->evento no loop, o answerTarget SEMPRE (TG-027) e o contador TG-089.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { SurfaceAction, SurfaceEvent } from '../../../../../worker/surface/contract.ts'
import {
  createDiscordProvider,
  DISCORD_LIMITS,
  type DiscordAdapter,
} from '../../../../../worker/providers/discord/adapter.ts'
import { lerAnswerTarget } from '../../../../../worker/providers/discord/parse.ts'
import { captureLog, chamadasDe, startFakeDiscord, TOKEN_DE_TESTE, type FakeDiscord } from './apoio.ts'
import { OWNER_CHANNEL, OWNER_SNOWFLAKE } from '../../../../support/fixtures/discord/updates.ts'

const abertos: FakeDiscord[] = []
const adaptersVivos: DiscordAdapter[] = []
after(async () => {
  // Para TODOS os adapters criados, mesmo quando um assert falhou no meio do
  // teste: um gateway vivo (socket + heartbeats) seguraria o event loop do
  // runner para sempre.
  await Promise.all(adaptersVivos.map((a) => parar(a)))
  await Promise.all(abertos.map((srv) => srv.close()))
})

async function aguardar(condicao: () => boolean, descricao: string, prazoMs = 5000): Promise<void> {
  const fim = Date.now() + prazoMs
  while (!condicao()) {
    if (Date.now() > fim) throw new Error(`prazo esgotado a espera de: ${descricao}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function parar(adapter: DiscordAdapter): Promise<void> {
  await adapter.stop().catch(() => undefined)
}

/** Cria um adapter contra o duble e registra-o no `after` (para o gateway). */
function criarAdapterComDuble(srv: FakeDiscord, log: ReturnType<typeof captureLog>): DiscordAdapter {
  const adapter = createDiscordProvider({
    token: TOKEN_DE_TESTE,
    apiRoot: srv.apiRoot,
    log: log.logger,
    jitter: () => 0,
    backoffMs: [10],
  })
  adaptersVivos.push(adapter)
  return adapter
}

function botao(label: string, action: SurfaceAction, token: string): { label: string; action: SurfaceAction; token: string } {
  return { label, action, token }
}

describe('provider/discord/adapter — superficie e limites', () => {
  it('expõe id, limits e sender como o contrato manda', () => {
    const log = captureLog()
    const adapter = createDiscordProvider({ token: TOKEN_DE_TESTE, log: log.logger })
    assert.equal(adapter.id, 'discord')
    assert.deepEqual(adapter.limits, DISCORD_LIMITS)
    assert.equal(typeof adapter.sender, 'function')
    assert.equal(typeof adapter.start, 'function')
    assert.equal(typeof adapter.stop, 'function')
    assert.equal(typeof adapter.publishCommands, 'function')
    // Limites concretos (D4, doc oficial do Discord).
    assert.equal(DISCORD_LIMITS.maxTextLength, 2000)
    assert.equal(DISCORD_LIMITS.maxActionRows, 5)
    assert.equal(DISCORD_LIMITS.maxActionPerRow, 5)
    assert.equal(DISCORD_LIMITS.maxActionDataBytes, 100)
    assert.equal(DISCORD_LIMITS.supportsEditing, true)
  })

  it('token vazio recusa na construcao (fail-closed)', () => {
    const log = captureLog()
    assert.throws(() => createDiscordProvider({ token: '  ', log: log.logger }), /token vazio/u)
  })
})

describe('provider/discord/adapter — o loop de boot', () => {
  it('start: conecta ao gateway, recebe eventos (comando e acao) e para limpo', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)

    const eventos: SurfaceEvent[] = []
    void adapter.start(async (ev) => {
      eventos.push(ev)
    })

    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY no duble')

    // Mensagem de texto -> SurfaceCommandEvent com os eixos STRING (D4).
    srv.enfileirarEvento({
      t: 'MESSAGE_CREATE',
      d: { id: 'm1', channel_id: OWNER_CHANNEL, author: { id: OWNER_SNOWFLAKE }, content: '/status' },
    })
    await aguardar(() => eventos.length >= 1, 'o comando chega ao handler')
    const comando = eventos[0]
    assert.equal(comando?.kind, 'comando')
    if (comando?.kind === 'comando') {
      assert.equal(comando.identity.userKey, OWNER_SNOWFLAKE)
      assert.equal(comando.identity.chatKey, OWNER_CHANNEL)
      assert.equal(comando.text, '/status')
    }

    // Clique -> SurfaceActionEvent com answerTarget SEMPRE (TG-027).
    srv.enfileirarEvento({
      t: 'INTERACTION_CREATE',
      d: {
        id: 'i9',
        type: 3,
        token: 'tok-9',
        channel_id: OWNER_CHANNEL,
        user: { id: OWNER_SNOWFLAKE },
        message: { id: 'm1', channel_id: OWNER_CHANNEL },
        data: { custom_id: 'g1:tunnel.up:nonce-opaco', component_type: 2 },
      },
    })
    await aguardar(() => eventos.length >= 2, 'a acao chega ao handler')
    const acao = eventos[1]
    assert.equal(acao?.kind, 'acao')
    if (acao?.kind === 'acao') {
      assert.equal(acao.action, 'tunnel.up')
      assert.equal(acao.token, 'nonce-opaco')
      assert.deepEqual(lerAnswerTarget(acao.answerTarget), {
        interactionId: 'i9',
        interactionToken: 'tok-9',
        messageId: 'm1',
      })
      assert.equal(acao.messageTarget, 'm1')
    }

    await parar(adapter)
  })

  it('clique malformado -> acao-invalida com answerTarget SEMPRE (TG-027, S5)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)

    const eventos: SurfaceEvent[] = []
    void adapter.start(async (ev) => {
      eventos.push(ev)
    })
    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY')

    srv.enfileirarEvento({
      t: 'INTERACTION_CREATE',
      d: {
        id: 'i8',
        type: 3,
        token: 'tok-8',
        channel_id: OWNER_CHANNEL,
        user: { id: OWNER_SNOWFLAKE },
        message: { id: 'm1', channel_id: OWNER_CHANNEL },
        data: { custom_id: 'srv:off:v1', component_type: 2 },
      },
    })
    await aguardar(() => eventos.length >= 1, 'a recusa chega ao handler')
    const rejeitado = eventos[0]
    assert.equal(rejeitado?.kind, 'acao-invalida')
    if (rejeitado?.kind === 'acao-invalida') {
      assert.deepEqual(lerAnswerTarget(rejeitado.answerTarget), {
        interactionId: 'i8',
        interactionToken: 'tok-8',
        messageId: 'm1',
      })
      assert.equal('action' in rejeitado, false)
      assert.equal('token' in rejeitado, false)
    }
    // TG-089: o malformado e RECUSA (evento ENTREGUE ao nucleo) E CONTADO —
    // aqui com o READY do boot (dispatch ignorado, tambem conta): 2.
    assert.equal(adapter.descartados(), 2, 'READY + malformado: descartado e contado')

    await parar(adapter)
  })

  it('close 4004 faz o start() REJEITAR (terminal, zero reconexoes)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)

    let rejeitou = false
    const startPromise = adapter.start(async () => undefined).then(
      () => undefined,
      () => {
        rejeitou = true
      },
    )
    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY antes do 4004')
    srv.fecharGateway(4004, 'token errado')
    await startPromise
    assert.equal(rejeitou, true, 'o start rejeita no veredito fatal')
    assert.equal(srv.gatewayState.identify.length, 1, 'zero reconexoes')
    await parar(adapter)
  })
})

describe('provider/discord/adapter — o sender sobre o REST', () => {
  it('send: POST /channels/{id}/messages com content e components; resolve o id STRING', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)
    const sender = adapter.sender()

    const id = await sender.send(OWNER_CHANNEL, 'ola', {
      actionRows: [[botao('Ligar', 'tunnel.up', 'nonceA')]],
    })

    assert.equal(typeof id, 'string')
    const chamada = chamadasDe(srv, '/channels/')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.path, `/channels/${OWNER_CHANNEL}/messages`)
    assert.deepEqual(chamada.body, {
      content: 'ola',
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'Ligar', custom_id: 'g1:tunnel.up:nonceA' }] },
      ],
    })
    await parar(adapter)
  })

  it('edit: PATCH com components SEMPRE explicito ([] quando sem teclado) — veredito edited', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)
    const sender = adapter.sender()

    const veredito = await sender.edit(OWNER_CHANNEL, 'm9', 'depois')
    assert.equal(veredito, 'edited')
    const chamada = chamadasDe(srv, '/channels/')[0]
    assert.ok(chamada !== undefined)
    assert.equal(chamada.method, 'PATCH')
    assert.equal(chamada.path, `/channels/${OWNER_CHANNEL}/messages/m9`)
    assert.deepEqual(chamada.body, { content: 'depois', components: [] }, 'sem teclado: destruir os botoes')
    await parar(adapter)
  })

  it('answer: o girador PARA sempre — type 6 sem texto; type 4 efemera com texto', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)
    const sender = adapter.sender()
    const alvo = JSON.stringify({ i: 'i1', t: 'tok-1' })

    const semTexto = await sender.answer(alvo)
    assert.equal(semTexto, true)
    assert.deepEqual(chamadasDe(srv, '/interactions/')[0]?.body, { type: 6 })

    const comTexto = await sender.answer(alvo, { text: 'Ligando…' })
    assert.equal(comTexto, true)
    assert.deepEqual(chamadasDe(srv, '/interactions/')[1]?.body, {
      type: 4,
      data: { content: 'Ligando…', flags: 64 },
    })
    await parar(adapter)
  })

  it('answer com alvo que o parse nao montou: false sem lanca', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)
    const ok = await adapter.sender().answer('alvo-estranho')
    assert.equal(ok, false)
    assert.equal(chamadasDe(srv, '/interactions/').length, 0)
    await parar(adapter)
  })

  it('publishCommands e no-op documentado (sem setMyCommands equivalente no Discord)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)
    const resultado = await adapter.publishCommands([{ command: 'status', description: 'estado' }])
    assert.equal(resultado, undefined)
    assert.equal(srv.calls.length, 0, 'nada foi ao canal')
    await parar(adapter)
  })
})

