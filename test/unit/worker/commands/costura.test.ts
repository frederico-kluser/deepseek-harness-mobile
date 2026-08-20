/**
 * `worker/commands/costura.ts` — a costura: allowlist dinamica, despacho por
 * TABELA, notify com botoes semanticos (contrato de T5.4), rotacao do desafio
 * de pareamento (S3-b) e o serializador de 1 msg/s das difusoes.
 *
 * COBRE a pergunta 5 da revisao (flapping NAO gera enxurrada/429), S3-b (o
 * digest nunca sai) e o despacho tipo -> tratador sem switch.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  criarAllowlistDinamica,
  criarDespachoDoCanal,
  criarPonteDeNonce,
  desafioMorto,
  montarSuperficie,
} from '../../../../worker/commands/costura.ts'
import {
  botoesDoAlerta,
  extrairAlerta,
  type TIPOS_DE_ALERTA,
} from '../../../../worker/commands/router.ts'
import { parseCallbackData } from '../../../../worker/auth/guard.ts'
import { createPairingReceiver } from '../../../../worker/auth/pairing.ts'
import { createConfirmService } from '../../../../src/control/confirm.ts'
import { criarRespondedorDeNonce } from '../../../../src/control/surface-ipc.ts'
import type { ControlAction } from '../../../../src/contracts/control.ts'
import type { IpcMessageToWorker } from '../../../../src/contracts/ipc.ts'
import type { TunnelController } from '../../../../src/control/controller.ts'
import { FakeClock } from '../../../support/clock.ts'
import {
  callbackQuery,
  dmMessage,
  OWNER,
  pairCommand,
  STRANGER,
} from '../../../support/fixtures/telegram/updates.ts'
import { captureLog, digestDoCodigo, FakeTime, montarBancada, tick, type Bancada } from './apoio.ts'


/* ========================================================================== */
/* O despacho do canal e uma TABELA (tipo -> tratador), nao um switch          */
/* ========================================================================== */

describe('criarDespachoDoCanal — uma entrada por tipo, sem switch', () => {
  it('os cinco tipos chegam ao roteador pelo mesmo funil', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const despacho = criarDespachoDoCanal(bancada.roteador)

    despacho.state({ v: 1, type: 'state', state: 'STOPPED', seq: 1 })
    despacho.ack({ v: 1, type: 'ack', requestId: 'r-inexistente', result: 'accepted', state: 'STOPPED' })
    despacho.error({ v: 1, type: 'error', code: 'INTERNAL', message: 'erro de teste' })
    despacho.notify({ v: 1, type: 'notify', texto: 'alerta:relatorio\nResumo das ultimas horas.' })
    despacho['pairing.challenge']({
      v: 1,
      type: 'pairing.challenge',
      digest: digestDoCodigo('654321'),
      expiresAt: bancada.time.now() + 5 * 60_000,
    })
    await tick()

    // O state foi renderizado; o notify renderizado; o error mostrado.
    assert.ok(bancada.api.mensagens.some((m) => m.texto.includes('desligado (STOPPED)')))
    assert.ok(bancada.api.mensagens.some((m) => m.texto.includes('Resumo das ultimas horas')))
    assert.ok(bancada.api.mensagens.some((m) => m.texto.includes('erro de teste')))
  })

  it('a tabela tem exactamente as SEIS chaves do vocabulario host -> worker (EMENDA-COSTURA-5: + nonce.issued)', () => {
    const despacho = criarDespachoDoCanal({
      onState: () => undefined,
      onAck: () => undefined,
      onError: () => undefined,
      onNotify: () => undefined,
      onPairingChallenge: () => undefined,
      tratarUpdate: async () => undefined,
    })
    assert.deepEqual(
      Object.keys(despacho).toSorted(),
      ['ack', 'error', 'nonce.issued', 'notify', 'pairing.challenge', 'state'],
    )
  })
})

/* ========================================================================== */
/* O notify: marcador `alerta:<tipo>` e botoes semanticos (contrato T5.4)     */
/* ========================================================================== */

describe('o notify — extrairAlerta e o mapeamento texto -> botoes', () => {
  it('separa o marcador da primeira linha do corpo mostrado', () => {
    assert.deepEqual(extrairAlerta('alerta:sessao-nova\nAlguém entrou.'), {
      tipo: 'sessao-nova',
      corpo: 'Alguém entrou.',
    })
    assert.deepEqual(extrairAlerta('texto sem marcador'), { tipo: undefined, corpo: 'texto sem marcador' })
    assert.deepEqual(extrairAlerta('alerta:tipo-desconhecido\ncorpo'), { tipo: undefined, corpo: 'corpo' })
  })

  it('sessao-nova -> «Não fui eu»; auth-falha -> «Derrubar túnel agora»; ttl/relatorio -> «Encerrar»', () => {
    const casos: ReadonlyArray<[string, string]> = [
      ['sessao-nova', 'Não fui eu'],
      ['auth-falha', 'Derrubar túnel agora'],
      ['ttl-expirado', 'Encerrar'],
      ['relatorio', 'Encerrar'],
    ]
    for (const [tipo, rotulo] of casos) {
      const botoes = botoesDoAlerta(tipo as (typeof TIPOS_DE_ALERTA)[number])
      assert.equal(botoes.length, 1)
      assert.equal(botoes[0]?.[0]?.text, rotulo, tipo)
      // SEMPRE via buildCallbackData: a gramatica g1 com intencao emergency.
      const data = botoes[0][0].data
      assert.ok(typeof data === 'string')
      const parse = parseCallbackData(data)
      assert.equal(parse.ok, true)
      if (parse.ok) {
        assert.equal(parse.parsed.action, 'emergency')
      }
    }
  })

  it('os tipos informativos nao ganham botao', () => {
    for (const tipo of ['tunel-ligar', 'tunel-desligar', 'modo-restrito', 'magic-suspeito', 'link-magico'] as const) {
      assert.deepEqual(botoesDoAlerta(tipo), [])
    }
    assert.deepEqual(botoesDoAlerta(undefined), [])
  })

  it('o notify com botao chega ao chat com o marcador ocultado (contrato T5.4)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    bancada.roteador.onNotify({ v: 1, type: 'notify', texto: 'alerta:sessao-nova\nPrimeira entrada com a sua sessão.' })
    await tick()

    const mensagem = bancada.api.mensagens.at(-1)
    assert.ok(mensagem !== undefined)
    assert.ok(!mensagem.texto.includes('alerta:sessao-nova'))
    assert.ok(mensagem.texto.includes('Primeira entrada'))
    const data = (mensagem.opcoes?.reply_markup?.inline_keyboard as
      | Array<Array<{ callback_data?: string }>>
      | undefined)?.[0]?.[0]?.callback_data
    assert.ok(typeof data === 'string')
    const parse = parseCallbackData(data)
    assert.equal(parse.ok && parse.parsed.action === 'emergency', true)
  })
})

/* ========================================================================== */
/* O pairing.challenge: rotacao do desafio, digest nunca sai (S3-b)           */
/* ========================================================================== */

describe('pairing.challenge — rota o desafio do receptor, e o digest nunca sai', () => {
  it('depois do desafio novo, so o codigo novo pareia', async () => {
    const bancada = montarBancada()
    // O codigo valido da bancada e 123456; o host roda-o para 654321.
    bancada.roteador.onPairingChallenge({
      v: 1,
      type: 'pairing.challenge',
      digest: digestDoCodigo('654321'),
      expiresAt: bancada.time.now() + 5 * 60_000,
    })

    await bancada.tratar(pairCommand(STRANGER, '123456'))
    assert.equal(bancada.api.mensagens.length, 1)
    assert.match(bancada.api.mensagens[0]?.texto ?? '', /Nao foi possivel parear/u, 'o codigo antigo morreu')

    await bancada.tratar(pairCommand(OWNER, '654321'))
    assert.equal(bancada.api.mensagens.length, 2)
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /Pareado/u, 'o codigo novo pareia')
  })

  it('S3-b: o digest nao aparece no log, no stderr nem em payload nenhum', async () => {
    const bancada = montarBancada()
    const digest = digestDoCodigo('654321')

    bancada.roteador.onPairingChallenge({
      v: 1,
      type: 'pairing.challenge',
      digest,
      expiresAt: bancada.time.now() + 5 * 60_000,
    })
    await bancada.tratar(pairCommand(OWNER, '654321'))

    assert.ok(!bancada.log.all().includes(digest), 'o digest saiu no log')
    const tudo = JSON.stringify({ mensagens: bancada.api.mensagens, intents: bancada.ipc.intents })
    assert.ok(!tudo.includes(digest), 'o digest saiu em payload')
  })
})

/* ========================================================================== */
/* A allowlist dinamica                                                        */
/* ========================================================================== */

describe('criarAllowlistDinamica — o pareamento e a fonte', () => {
  it('antes do pareamento: size 0 e nega tudo (TG-007); depois, os dois eixos', () => {
    const pairing = createPairingReceiver({
      challenge: desafioMorto(),
      clock: { now: () => 0 },
    })
    const allowlist = criarAllowlistDinamica(pairing)
    assert.equal(allowlist.size, 0)
    assert.equal(allowlist.has(OWNER), false)

    // O desafio morto nao pareia ninguem — a allowlist so muda com o receptor.
    const pareamento = pairing.receive(dmMessage(OWNER, '/parear 123456'))
    assert.equal(pareamento.kind, 'refused')
    assert.equal(allowlist.size, 0)
  })

  it('apos o pareamento, has(from) e has(chat) — e nada mais', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    assert.equal(bancada.roteador !== undefined, true)
    // O comportamento observavel ja foi provado: o dono comanda, o estranho nao.
    await bancada.tratar(dmMessage(OWNER, '/status'))
    await bancada.tratar(dmMessage(STRANGER, '/status'))
    assert.equal(bancada.ipc.intents.length, 1)
    assert.equal(bancada.ipc.intents[0]?.from, OWNER)
  })
})

/* ========================================================================== */
/* Pergunta 5 da revisao: 1 msg/s por chat na difusao (flapping sem 429)      */
/* ========================================================================== */

describe('o serializador de difusoes — um flapping nao gera enxurrada', () => {
  it('cinco difusoes rapidas: UMA mensagem e a ultima quando a janela fecha (in-place)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const antes = bancada.api.mensagens.length

    // Flapping: READY -> DEGRADED -> STARTING -> READY -> DEGRADED, seq crescente.
    for (const [i, estado] of ['READY', 'DEGRADED', 'STARTING', 'READY', 'DEGRADED'].entries()) {
      bancada.roteador.onState({
        v: 1,
        type: 'state',
        state: estado as 'READY',
        seq: i + 1,
        ...(estado === 'READY' ? { url: 'https://x.trycloudflare.com', expiresAt: bancada.time.now() + 60_000 } : {}),
      })
    }
    await tick()

    // A primeira difusao saiu logo; as quatro seguintes coalesceram.
    assert.equal(bancada.api.mensagens.slice(antes).length, 1, 'so a primeira difusao saiu')

    // Quando a janela de 1 s fecha, a ULTIMA difusao sai como EDICAO in-place
    // (TG-028) — duas chamadas no total para cinco difusoes, nunca cinco.
    assert.ok(bancada.time.sleeps.some((ms) => ms > 0 && ms <= 1_000))
    await tick()
    assert.equal(bancada.api.mensagens.slice(antes).length, 1, 'nenhuma mensagem nova')
    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.match(edicao.texto, /instável, tentando de novo/u)
  })

  it('difusoes com 1 s de intervalo saem todas (o limite e respeitado, nao engolido)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const antes = bancada.api.mensagens.length

    bancada.roteador.onState({ v: 1, type: 'state', state: 'STOPPED', seq: 1 })
    await tick()
    bancada.time.advance(1_000)
    bancada.roteador.onState({ v: 1, type: 'state', state: 'STARTING', seq: 2 })
    await tick()

    assert.equal(bancada.api.mensagens.slice(antes).length, 1, 'a segunda difusao edita, nao envia')
    assert.equal(bancada.api.edicoes.length, 1)
    assert.match(bancada.api.edicoes.at(-1)?.texto ?? '', /ligando \(STARTING\)/u)
  })
})

/* ========================================================================== */
/* montarSuperficie: a composicao em si                                        */
/* ========================================================================== */

describe('montarSuperficie — a composicao de producao', () => {
  it('monta guard + pareamento + roteador sem I/O', () => {
    const bancada = montarBancada()
    void bancada
    const { guard, pairing, roteador } = montarSuperficie({
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      time: { now: () => 0, sleep: async () => undefined },
      api: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ ok: true }),
        answerCallbackQuery: async () => true,
      },
      ipc: { send: () => true, log: () => undefined, dispose: () => undefined },
      parar: async () => undefined,
    })
    assert.ok(guard !== undefined)
    assert.ok(pairing !== undefined)
    assert.ok(roteador !== undefined)
  })
describe('8(c): dono persistido semeado na montagem — o worker reaprende sem nova parelha', () => {
  it('montarSuperficie com donoInicial nasce FECHADO: allowlist aceita o dono e /parear e recusado', async () => {
    const time = new FakeTime()
    const log = captureLog()
    const { guard, pairing, roteador } = montarSuperficie({
      log: log.logger,
      time,
      api: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => ({ ok: true }),
        answerCallbackQuery: async () => true,
      },
      ipc: { send: () => true, log: () => undefined, dispose: () => undefined },
      donoInicial: { from: 42, chat: -1001234567890, pairedAt: 2_000 },
      parar: async () => undefined,
    })
    void roteador
    assert.deepEqual(pairing.state(), { status: 'fechado', owner: { from: 42, chat: -1001234567890, pairedAt: 2_000 } })
    // A allowlist aceita os DOIS eixos do dono reaprendido:
    assert.equal(guard.admit(dmMessage(42, '/status')).kind !== 'discarded', true, 'from do dono passa')
    // /parear e recusado a partida (o segundo pareamento nao existe):
    const parear = pairing.receive(dmMessage(42, '/parear 123456'))
    assert.equal(parear.kind, 'refused')
    assert.equal(guard.admit(dmMessage(999, '/status')).kind, 'discarded', 'um estranho continua fora')
  })
})

  it('EMENDA-COSTURA-5: emitir pede o nonce ao host (nonce.request) e devolve o valor de nonce.issued', async () => {
    // O fluxo de producao do /ligar: o worker pede pelo CANAL (nunca inventa —
    // S5) e o host responde pelo pipe. O valor viaja opaco e NUNCA e logado (S3).
    const time = new FakeTime()
    const log = captureLog()
    const enviadas: Array<{ type?: unknown; acao?: unknown; requestId?: unknown }> = []
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: {
        send: (msg) => {
          enviadas.push(msg as { type?: unknown; acao?: unknown; requestId?: unknown })
          return true
        },
        log: () => undefined,
        dispose: () => undefined,
      },
    })

    const pedido = ponte.emitir('tunnel.up')
    assert.equal(enviadas.length, 1, 'o nonce.request saiu pelo canal')
    assert.equal(enviadas[0]?.type, 'nonce.request')
    assert.equal(enviadas[0]?.acao, 'start', 'tunnel.up mapeia para a ControlAction start')
    const requestId = enviadas[0]?.requestId
    assert.ok(typeof requestId === 'string' && requestId.length > 0)

    // O host responde (como criarRespondedorDeNonce faria):
    ponte.onMessage({
      v: 1,
      type: 'nonce.issued',
      acao: 'start',
      requestId,
      nonce: 'nonce-opaco-do-host',
      expiresAt: time.now() + 60_000,
    })
    assert.equal(await pedido, 'nonce-opaco-do-host')
    assert.ok(!log.all().includes('nonce-opaco-do-host'), 'S3: o nonce nao vai ao log')
  })

  it('EMENDA-COSTURA-5: timeout fail-closed — sem nonce.issued a tempo, resolve undefined', async () => {
    const time = new FakeTime()
    const log = captureLog()
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: { send: () => true, log: () => undefined, dispose: () => undefined },
    })

    const pedido = ponte.emitir('tunnel.up')
    await tick() // o sono injetado resolve: o timeout corre
    assert.equal(await pedido, undefined, 'sem nonce a tempo, a confirmacao fica indisponivel (CTL-023)')
    assert.match(log.all(), /nao chegou a tempo/u, 'o operador e avisado')
  })

  it('EMENDA-COSTURA-5: canal indisponivel falha FECHADO ja, sem esperar o timeout', async () => {
    const time = new FakeTime()
    const log = captureLog()
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: { send: () => false, log: () => undefined, dispose: () => undefined },
    })
    assert.equal(await ponte.emitir('tunnel.up'), undefined, 'sem canal nao ha pedido')
    assert.match(log.all(), /sem canal para o host/u, 'o operador e avisado')
  })

  it('EMENDA-COSTURA-5: um error do host a um pedido de nonce falha fechado JA e nao vai ao roteador', async () => {
    const time = new FakeTime()
    const log = captureLog()
    const enviadas: Array<{ requestId?: unknown }> = []
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: {
        send: (msg) => {
          enviadas.push(msg as { requestId?: unknown })
          return true
        },
        log: () => undefined,
        dispose: () => undefined,
      },
    })
    const pedido = ponte.emitir('tunnel.up')
    const requestId = enviadas[0]?.requestId
    assert.ok(typeof requestId === 'string')
    // O host recusa (ex.: modo loopback): EXPOSURE_DISABLED como error.
    const consumido = ponte.onMessage({
      v: 1,
      type: 'error',
      requestId,
      code: 'EXPOSURE_DISABLED',
      message: 'exposicao desativada',
    })
    assert.equal(consumido, true, 'o error do pedido de nonce e consumido pela ponte')
    assert.equal(await pedido, undefined, 'falha fechado ja, sem esperar o timeout')
  })

  it('EMENDA-COSTURA-5: request -> issued fecha ponta a ponta (ponte do worker + responder do host)', async () => {
    // As DUAS metades do transporte, ligadas por um canal fake: o worker pede
    // pelo pipe, o HOST (ConfirmService real de T5.1 via criarRespondedorDeNonce)
    // emite e responde, e a ponte entrega o valor opaco ao comando. O mesmo
    // nonce que viajou e CONSUMIVEL no controlador (uso unico — CTL-021).
    const clock = new FakeClock(1_000)
    const confirm = createConfirmService({
      now: () => clock.now(),
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    })
    const responder = criarRespondedorDeNonce({
      controller: {
        emitirNonce: (acao: ControlAction) => confirm.issue(acao),
      } as unknown as TunnelController,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    const time = new FakeTime()
    const log = captureLog()
    const enviadas: Array<Record<string, unknown>> = []
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: { send: (msg) => { enviadas.push(msg as unknown as Record<string, unknown>); return true }, log: () => undefined, dispose: () => undefined },
    })

    const pedido = ponte.emitir('tunnel.up')
    const request = enviadas[0] as { type?: string; acao?: string; requestId?: string }
    assert.equal(request?.type, 'nonce.request')
    // O canal entrega ao HOST; o HOST responde; o canal devolve a resposta:
    const resposta = responder({ v: 1, type: 'nonce.request', acao: 'start', requestId: request?.requestId ?? '' })
    assert.equal(resposta.type, 'nonce.issued')
    ponte.onMessage(resposta as IpcMessageToWorker)
    const nonce = await pedido
    assert.ok(nonce !== undefined && nonce.length === 32, 'o nonce real do host chegou ao worker')
    // E o mesmo nonce autoriza (e so autoriza uma vez) um start no controlador:
    assert.equal(confirm.consume(nonce, 'start'), true, 'uso unico: autoriza uma vez')
    assert.equal(confirm.consume(nonce, 'start'), false, 'uso unico: replay recusado (CTL-021)')
  })
})

/* ========================================================================== */
/* Pergunta 1 da revisao: answerCallbackQuery em TODOS os caminhos             */
/* ========================================================================== */

describe('o answer do callback — em todos os caminhos, inclusive nos de erro', () => {
  it('um callback de acao sem botao renderizado (tunnel.status) e respondido e descartado', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(
      callbackQuery({ from: OWNER, chat: OWNER, data: 'g1:tunnel.status:AAAAAAAAAAA' }),
    )

    assert.equal(bancada.ipc.intents.length, 0, 'nenhum intent para acao sem botao')
    assert.equal(bancada.api.respostas.length, 1, 'o girador para (TG-027)')
  })

  it('um callback MALFORMADO (fora da gramatica g1) e respondido em silencio', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data: 'srv:off:v1' }))

    assert.equal(bancada.ipc.intents.length, 0, 'o payload administrativo directo morre no guard')
    assert.equal(bancada.api.respostas.length, 1)
    assert.equal(bancada.api.respostas[0]?.outras, undefined, 'silencio de conteudo')
  })
})

/* ========================================================================== */
/* A1 da revisao: uma falha de sendMessage no despacho NAO pode virar         */
/* rejeicao nao tratada -> crash do processo                                   */
/* ========================================================================== */

/** O data do UNICO botao do teclado de uma resposta (como em onoff.test.ts). */
function dataDoBotaoUnico(mensagem: { opcoes: { reply_markup?: { inline_keyboard?: unknown[] } } | undefined }): string {
  const teclado = mensagem.opcoes?.reply_markup?.inline_keyboard as
    | Array<Array<{ callback_data?: string }>>
    | undefined
  const data = teclado?.[0]?.[0]?.callback_data
  assert.ok(typeof data === 'string', 'esperava um botao com callback_data')
  return data
}

describe('A1: a rede em baixo no despacho NAO gera rejeicoes nao tratadas', () => {
  it('flapping + ack (aceite e recusa) + error + notify, tudo com sendMessage a falhar', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    // /desligar -> teclado -> clique: um pendente com messageId (a recusa
    // dele edita in-place e a edicao vai falhar).
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const dataDesligar = dataDoBotaoUnico(bancada.api.mensagens.at(-1) ?? { opcoes: undefined })
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data: dataDesligar }))
    const desligarRequestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(desligarRequestId !== undefined)

    // /status e /acessar: pendentes sem messageId (o aceite/erro deles passa
    // por mostrarEstado).
    await bancada.tratar(dmMessage(OWNER, '/status'))
    const statusRequestId = bancada.ipc.intents.at(-1)?.requestId
    await bancada.tratar(dmMessage(OWNER, '/acessar'))
    const acessarRequestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(statusRequestId !== undefined && acessarRequestId !== undefined)

    const naoTratadas: unknown[] = []
    const ouvinte = (motivo: unknown): void => {
      naoTratadas.push(motivo)
    }
    process.on('unhandledRejection', ouvinte)
    try {
      // A rede cai: todo send/edit passa a rejeitar.
      bancada.api.falharEnvio = true

      // Flapping de 5 difusoes (o serializador: a 1a sai logo e falha; a
      // ultima sai na janela e falha tambem — as duas tem de ser apanhadas).
      for (const [i, estado] of ['READY', 'DEGRADED', 'STARTING', 'READY', 'DEGRADED'].entries()) {
        bancada.roteador.onState({
          v: 1,
          type: 'state',
          state: estado as 'READY',
          seq: i + 1,
          ...(estado === 'READY'
            ? { url: 'https://x.trycloudflare.com', expiresAt: bancada.time.now() + 60_000 }
            : {}),
        })
      }
      bancada.roteador.onAck({
        v: 1,
        type: 'ack',
        requestId: statusRequestId,
        result: 'accepted',
        state: 'STARTING',
      })
      bancada.roteador.onError({
        v: 1,
        type: 'error',
        requestId: acessarRequestId,
        code: 'INTERNAL',
        message: 'erro de teste',
      })
      bancada.roteador.onNotify({ v: 1, type: 'notify', texto: 'alerta:relatorio\nresumo' })

      // Drena o serializador (o sono injetado + a entrega coalescida) e todas
      // as cadeias de microtarefas. Um turno de MACROTASK no fim: o Node so
      // emite 'unhandledRejection' depois de esvaziar a fila de microtarefas
      // e passar ao proximo turno — sem ele, a rejeicao escaparia do corpo do
      // teste e o assert nunca a veria.
      //
      // O ack-rejeitado do /desligar (com messageId) vem SO DEPOIS do dreno:
      // ele registaria a ultima mensagem de estado, e entao a entrega
      // coalescida tomaria o caminho de EDICAO (que nunca lanca — T4.2) em
      // vez do caminho SEND — o unico que falha com a rede em baixo e cujo
      // .catch este teste existe para provar.
      await tick(30)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await tick(2)
      bancada.roteador.onAck({
        v: 1,
        type: 'ack',
        requestId: desligarRequestId,
        result: 'rejected',
        state: 'STOPPED',
        code: 'NONCE_INVALID',
      })
      await tick(2)
    } finally {
      process.removeListener('unhandledRejection', ouvinte)
    }

    assert.deepEqual(
      naoTratadas,
      [],
      'nenhuma rejeicao nao tratada: o processo nao cai com a rede em baixo',
    )
  })
})

/* ========================================================================== */
/* A2 da revisao: o aceite e a recusa de /acessar NUNCA tocam o painel de     */
/* estado — a resposta (link ou instrucao) chega por notify (TG-085) e a      */
/* recusa e uma mensagem propria; o painel sobrevive aos dois                 */
/* ========================================================================== */

/** Pareia e renderiza o painel de estado; devolve o texto e o indice dele. */
async function comPainel(): Promise<{
  bancada: Bancada
  textoDoPainel: string
  indiceDoPainel: number
}> {
  const bancada = montarBancada()
  await bancada.tratar(pairCommand(OWNER, '123456'))
  bancada.roteador.onState({ v: 1, type: 'state', state: 'STOPPED', seq: 1 })
  await tick()
  const painel = bancada.api.mensagens.at(-1)
  assert.ok(painel !== undefined, 'o painel de estado foi renderizado')
  assert.match(painel.texto, /Estado: desligado \(STOPPED\)/u)
  return {
    bancada,
    textoDoPainel: painel.texto,
    indiceDoPainel: bancada.api.mensagens.length - 1,
  }
}

describe('A2: /acessar nao substitui o painel de estado (aceite e recusa)', () => {

  it('aceite: /acessar e INVISIVEL, o link chega por notify e o painel fica intacto', async () => {
    const { bancada, textoDoPainel, indiceDoPainel } = await comPainel()

    await bancada.tratar(dmMessage(OWNER, '/acessar'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)

    const mensagensAntes = bancada.api.mensagens.length
    bancada.roteador.onAck({
      v: 1,
      type: 'ack',
      requestId,
      result: 'accepted',
      state: 'STARTING',
    })
    await tick()

    // Invisivel de proposito: nem mensagem nova nem edicao in-place.
    assert.equal(bancada.api.edicoes.length, 0, 'o aceite nao edita o painel in-place')
    assert.equal(bancada.api.mensagens.length, mensagensAntes, 'o aceite nao renderiza nada')

    // A resposta (TG-085) chega por notify, como mensagem NOVA — nunca como
    // edicao da ultima mensagem de estado.
    bancada.roteador.onNotify({
      v: 1,
      type: 'notify',
      texto: 'alerta:link-magico\nhttps://exemplo.trycloudflare.com/__guard/magic#mk=abc',
    })
    await tick()

    assert.equal(bancada.api.mensagens.length, mensagensAntes + 1, 'o link chegou como mensagem nova')
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /exemplo.trycloudflare.com/u)
    assert.equal(bancada.api.edicoes.length, 0, 'o notify nao edita o painel')
    assert.equal(bancada.api.mensagens[indiceDoPainel]?.texto, textoDoPainel, 'o painel intacto')
  })

  it('recusa: mensagem propria (nunca edicao) e o painel fica intacto', async () => {
    const { bancada, textoDoPainel, indiceDoPainel } = await comPainel()

    await bancada.tratar(dmMessage(OWNER, '/acessar'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)

    const mensagensAntes = bancada.api.mensagens.length
    bancada.roteador.onAck({
      v: 1,
      type: 'ack',
      requestId,
      result: 'rejected',
      state: 'STOPPED',
      code: 'NONCE_INVALID',
    })
    await tick()

    assert.equal(bancada.api.edicoes.length, 0, 'a recusa nao edita o painel in-place')
    assert.equal(bancada.api.mensagens.length, mensagensAntes + 1, 'a recusa e uma mensagem propria')
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /Confirmação inválida ou expirada/u)
    assert.equal(bancada.api.mensagens[indiceDoPainel]?.texto, textoDoPainel, 'o painel intacto')
  })

  it('erro: o erro de /acessar e mensagem propria (nunca edicao) e o painel fica intacto', async () => {
    const { bancada, textoDoPainel, indiceDoPainel } = await comPainel()

    await bancada.tratar(dmMessage(OWNER, '/acessar'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)

    // O contrato (ipc.ts): o requestId esta presente quando o erro decorre de
    // uma intencao — e o erro de session.issue E uma resposta de /acessar.
    const mensagensAntes = bancada.api.mensagens.length
    bancada.roteador.onError({
      v: 1,
      type: 'error',
      requestId,
      code: 'INTERNAL',
      message: 'erro de teste do host',
    })
    await tick()

    assert.equal(bancada.api.edicoes.length, 0, 'o erro nao edita o painel in-place')
    assert.equal(bancada.api.mensagens.length, mensagensAntes + 1, 'o erro e uma mensagem propria')
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /erro de teste do host/u)
    assert.equal(bancada.api.mensagens[indiceDoPainel]?.texto, textoDoPainel, 'o painel intacto')
  })
})

/* ========================================================================== */
/* A ponte de nonce — os cantos (EMENDA-COSTURA-5)                             */
/* ========================================================================== */

describe('a ponte de nonce — cantos do transporte', () => {
  it('acao que NAO pede nonce (ou desconhecida): aviso e undefined, sem pedido ao canal', async () => {
    const time = new FakeTime()
    const log = captureLog()
    let enviadas = 0
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: { send: () => { enviadas += 1; return true }, log: () => undefined, dispose: () => undefined },
    })
    assert.equal(await ponte.emitir('tunnel.down'), undefined)
    assert.equal(await ponte.emitir('emergency'), undefined)
    assert.equal(enviadas, 0, 'nenhum nonce.request para acao que dispensa nonce (CTL-024)')
    assert.match(log.all(), /acao sem nonce/u)
  })

  it('nonce.issued de um pedido JA resolvido (orfa): consumido em silencio, sem log do valor', async () => {
    const time = new FakeTime()
    const log = captureLog()
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: { send: () => true, log: () => undefined, dispose: () => undefined },
    })
    const consumido = ponte.onMessage({
      v: 1,
      type: 'nonce.issued',
      acao: 'start',
      requestId: 'nunca-pedido',
      nonce: 'valor-opaco-que-nao-deve-sair',
      expiresAt: time.now() + 60_000,
    })
    assert.equal(consumido, true, 'a resposta orfa e consumida pela ponte')
    assert.ok(!log.all().includes('valor-opaco-que-nao-deve-sair'), 'S3: o valor nao vai ao log')
  })

  it('mensagem de outro tipo nao e da ponte: devolve false e segue o despacho', () => {
    const time = new FakeTime()
    const log = captureLog()
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: { send: () => true, log: () => undefined, dispose: () => undefined },
    })
    assert.equal(
      ponte.onMessage({ v: 1, type: 'state', state: 'STOPPED', seq: 1 }),
      false,
      'o state nao interessa a ponte',
    )
  })

  it('criarDespachoDoCanal com a ponte: nonce.issued e consumido antes do roteador, e o error de um pedido de nonce tambem', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const time = new FakeTime()
    const log = captureLog()
    const ponte = criarPonteDeNonce({
      log: log.logger,
      time,
      ipc: { send: () => true, log: () => undefined, dispose: () => undefined },
    })
    const despacho = criarDespachoDoCanal(bancada.roteador, ponte)

    // Um nonce.issued orfa passa pela ponte e NAO chega ao roteador (que nao
    // sabe renderizar um nonce).
    const antes = bancada.api.mensagens.length
    despacho['nonce.issued']({
      v: 1,
      type: 'nonce.issued',
      acao: 'start',
      requestId: 'orfa',
      nonce: 'valor-opaco',
      expiresAt: time.now() + 60_000,
    })
    await tick()
    assert.equal(bancada.api.mensagens.length, antes, 'o nonce.issued nao renderiza nada')

    // O error de um pedido de nonce pendente NAO vai ao roteador — a ponte
    // consome-o antes (nao ha intent por tras; mostra-lo seria duplicar a
    // mensagem de confirmacao indisponivel).
    despacho.error({ v: 1, type: 'error', requestId: 'pedido-de-nonce', code: 'EXPOSURE_DISABLED', message: 'exposicao desativada' })
    await tick()
    assert.equal(bancada.api.mensagens.length, antes, 'o error do pedido de nonce nao renderiza nada')
  })
})

