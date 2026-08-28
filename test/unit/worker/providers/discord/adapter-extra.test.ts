/**
 * `worker/providers/discord/adapter.ts` — 2.a leva: S4 (uma falha na entrega
 * do evento NAO mata o gateway), o `stop()` sem `start()`, os retries do 429
 * no sender (send/edit/answer — o servidor disse quanto esperar; a rede NAO),
 * e as bordas do corpo (components SEMPRE explicito).
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { SurfaceAction } from '../../../../../worker/surface/contract.ts'
import { createDiscordProvider, type DiscordAdapter } from '../../../../../worker/providers/discord/adapter.ts'
import { DiscordApiError } from '../../../../../worker/providers/discord/cliente.ts'
import { captureLog, chamadasDe, FakeTime, startFakeDiscord, TOKEN_DE_TESTE, type FakeDiscord } from './apoio.ts'
import { OWNER_CHANNEL, OWNER_SNOWFLAKE } from '../../../../support/fixtures/discord/updates.ts'

const abertos: FakeDiscord[] = []
const adaptersVivos: DiscordAdapter[] = []
after(async () => {
  await Promise.all(adaptersVivos.map((a) => a.stop().catch(() => undefined)))
  await Promise.all(abertos.map((srv) => srv.close()))
})

async function aguardar(condicao: () => boolean, descricao: string, prazoMs = 5000): Promise<void> {
  const fim = Date.now() + prazoMs
  while (!condicao()) {
    if (Date.now() > fim) throw new Error(`prazo esgotado a espera de: ${descricao}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function criarAdapterComDuble(
  srv: FakeDiscord,
  log: ReturnType<typeof captureLog>,
  extra: { time?: FakeTime } = {},
): DiscordAdapter {
  const adapter = createDiscordProvider({
    token: TOKEN_DE_TESTE,
    apiRoot: srv.apiRoot,
    log: log.logger,
    jitter: () => 0,
    backoffMs: [10],
    ...(extra.time === undefined ? {} : { time: extra.time }),
  })
  adaptersVivos.push(adapter)
  return adapter
}

function botao(label: string, action: SurfaceAction, token: string): { label: string; action: SurfaceAction; token: string } {
  return { label, action, token }
}

function mensagemDeComando(id: string, content: string): Record<string, unknown> {
  return {
    t: 'MESSAGE_CREATE',
    d: { id, channel_id: OWNER_CHANNEL, author: { id: OWNER_SNOWFLAKE }, content },
  }
}

describe('provider/discord/adapter — S4: o evento que rebenta nao mata o gateway', () => {
  it('handler que lanca: o erro e logado, o evento SEGUINTE chega e o gateway segue vivo', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)

    let entregues = 0
    void adapter.start(async () => {
      entregues += 1
      throw new Error('o nucleo rebentou com este evento')
    })
    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY')

    srv.enfileirarEvento(mensagemDeComando('m1', '/status'))
    srv.enfileirarEvento(mensagemDeComando('m2', '/status'))
    await aguardar(() => entregues >= 2, 'os DOIS eventos chegaram ao handler, apesar do primeiro rebentar')
    await aguardar(
      () => log.lines.some((l) => l.includes('falha ao entregar evento da superficie ao nucleo')),
      'a falha de entrega e registada',
    )
    assert.equal(srv.gatewayState.identify.length, 1, 'o gateway nao reconectou: a sessao segue viva')

    await adapter.stop()
  })
})

describe('provider/discord/adapter — o ciclo de vida (bordas)', () => {
  it('stop() sem start() resolve sem rebentar (roda inexistente)', async () => {
    const log = captureLog()
    const adapter = createDiscordProvider({ token: TOKEN_DE_TESTE, log: log.logger })
    adaptersVivos.push(adapter)
    await adapter.stop()
    assert.equal(adapter.descartados(), 0)
  })

})

describe('provider/discord/adapter — o sender (bordas do corpo e retries)', () => {
  it('send sem opcoes: components [] EXPLICITO (o Discord preservaria os botoes antigos)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)

    const id = await adapter.sender().send(OWNER_CHANNEL, 'so texto')
    assert.equal(typeof id, 'string')
    const chamada = chamadasDe(srv, '/channels/')[0]
    assert.ok(chamada !== undefined)
    assert.deepEqual(chamada.body, { content: 'so texto', components: [] })
    await adapter.stop()
  })

  it('edit com actionRows: o PATCH leva o teclado RENDERIZADO (e nao o antigo)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)

    const veredito = await adapter.sender().edit(OWNER_CHANNEL, 'm9', 'com botao', {
      actionRows: [[botao('Ligar', 'tunnel.up', 'nonceB')]],
    })
    assert.equal(veredito, 'edited')
    const chamada = chamadasDe(srv, '/channels/')[0]
    assert.ok(chamada !== undefined)
    assert.deepEqual(chamada.body, {
      content: 'com botao',
      components: [
        { type: 1, components: [{ type: 2, style: 1, label: 'Ligar', custom_id: 'g1:tunnel.up:nonceB' }] },
      ],
    })
    await adapter.stop()
  })

  it('429 no send: repete UMA vez (o servidor disse quanto esperar) e resolve', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const tempo = new FakeTime() // o retry dorme no relogio injectado
    const adapter = criarAdapterComDuble(srv, log, { time: tempo })

    srv.queueError('channels', { status: 429, body: { message: 'rate limited', retry_after: 0.05, global: false } })
    const id = await adapter.sender().send(OWNER_CHANNEL, 'com retry')
    assert.equal(typeof id, 'string')
    assert.equal(chamadasDe(srv, '/channels/').length, 2, 'a primeira tentativa levou 429, a segunda passou')
    assert.deepEqual(tempo.sleeps, [50], 'dormiu EXATAMENTE o retry_after (50 ms)')
    await adapter.stop()
  })

  it('429 persistente no send: orcamento esgotado, o erro sobe (a mensagem NAO duplica em loop)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const tempo = new FakeTime()
    const adapter = criarAdapterComDuble(srv, log, { time: tempo })

    srv.queueError('channels', { status: 429, body: { retry_after: 0.01 } })
    srv.queueError('channels', { status: 429, body: { retry_after: 0.01 } })
    await assert.rejects(adapter.sender().send(OWNER_CHANNEL, 'x'), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 429)
      return true
    })
    assert.equal(chamadasDe(srv, '/channels/').length, 2, '1 original + 1 retry, e PARA (sem martelada)')
    await adapter.stop()
  })

  it('429 no answer: o retry corre (o girador PARA mesmo com um 429 no meio)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const tempo = new FakeTime()
    const adapter = criarAdapterComDuble(srv, log, { time: tempo })

    srv.queueError('interactions', { status: 429, body: { retry_after: 0.02 } })
    const alvo = JSON.stringify({ i: 'i1', t: 'tok-1' })
    assert.equal(await adapter.sender().answer(alvo), true, 'o girador PARA mesmo com um 429 no meio')
    assert.equal(chamadasDe(srv, '/interactions/').length, 2, 'answer: 429 + retry')
    assert.deepEqual(tempo.sleeps, [20], 'dormiu exatamente o retry_after')
    await adapter.stop()
  })

  it('429 no sender.edit: veredicto failed SEM retry — o retry do PATCH vive no path do answer', async () => {
    // Premissa observada: o retry (comAutoRetry) e ligado no send e no answer;
    // o `sender.edit` direto chama `editMessageInPlace`, que NUNCA lanca e
    // devolve o veredicto 'failed' — o nucleo decide o que fazer. O PATCH com
    // retry existe no TecladoApi do `answer` (o anti duplo-toque).
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const tempo = new FakeTime()
    const adapter = criarAdapterComDuble(srv, log, { time: tempo })

    srv.queueError('channels', { status: 429, body: { retry_after: 0.02 } })
    assert.equal(await adapter.sender().edit(OWNER_CHANNEL, 'm1', 'editado'), 'failed')
    assert.equal(chamadasDe(srv, '/channels/').length, 1, 'uma unica tentativa: sem retry no edit direto')
    assert.deepEqual(tempo.sleeps, [], 'nada foi dormido')
    await adapter.stop()
  })

  it('REDE no send (status 0): NAO ha retry — o erro sobe na hora (POST nao e idempotente)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const tempo = new FakeTime()
    const adapter = criarAdapterComDuble(srv, log, { time: tempo })

    await srv.close()
    const idx = abertos.indexOf(srv)
    if (idx !== -1) abertos.splice(idx, 1)
    await assert.rejects(adapter.sender().send(OWNER_CHANNEL, 'x'), (error: unknown) => {
      assert.ok(error instanceof DiscordApiError)
      assert.equal(error.status, 0)
      return true
    })
    assert.deepEqual(tempo.sleeps, [], 'rede nao dorme nada: repetir duplicaria a mensagem')
    await adapter.stop()
  })
})

describe('provider/discord/adapter — publishCommands e contador', () => {
  it('publishCommands no-op loga o numero de comandos (sem erro)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)
    const resultado = await adapter.publishCommands([
      { command: 'status', description: 'estado' },
      { command: 'ligar', description: 'liga' },
    ])
    assert.equal(resultado, undefined)
    assert.ok(log.lines.some((l) => l.includes('publishCommands do discord: no-op') && l.includes('comandos=2')))
    await adapter.stop()
  })

  it('descartados() conta despachos ignorados desde o start (TG-089)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const log = captureLog()
    const adapter = criarAdapterComDuble(srv, log)
    void adapter.start(async () => undefined)
    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY (dispatch ignorado: 1)')
    srv.enfileirarEvento({ t: 'MESSAGE_UPDATE', d: { id: 'm1' } }) // dispatch-outro: 2
    await aguardar(() => adapter.descartados() >= 2, 'o contador sobe')
    assert.equal(adapter.descartados(), 2)
    await adapter.stop()
  })
})
