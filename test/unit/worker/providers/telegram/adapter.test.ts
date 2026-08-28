/**
 * `worker/providers/telegram/adapter.ts` — o PROVIDER telegram inteiro contra o
 * duble congelado: a sequencia de boot, a superficie completa (id/limits/
 * start/stop/publishCommands/sender), o mapeamento update->evento no loop, e o
 * contador TG-089.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { SurfaceEvent } from '../../../../../worker/surface/contract.ts'
import {
  createTelegramProvider,
  TELEGRAM_LIMITS,
  type TelegramAdapter,
} from '../../../../../worker/providers/telegram/adapter.ts'
import { ProviderError } from '../../../../../worker/providers/telegram/interno.ts'
import { WORKER_EXIT } from '../../../../../worker/lib/errors.ts'
import {
  canonicalErrors,
  captureLog,
  chamadasDe,
  startFakeBotApi,
  TOKEN_DE_TESTE,
  type FakeBotApi,
} from './apoio.ts'

const abertos: FakeBotApi[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
})

/** Um update de mensagem com texto e os dois eixos numericos. */
function updateDeMensagem(texto: string): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_800_000_000,
      from: { id: 777000123, is_bot: false },
      chat: { id: 777000123, type: 'private' },
      text: texto,
    },
  }
}

/** Um callback_query bem formado com a gramatica `g1:<acao>:<token>`. */
function updateDeCallback(data: string): unknown {
  return {
    update_id: 2,
    callback_query: {
      id: 'cq-9',
      from: { id: 777000123, is_bot: false },
      message: { message_id: 9, chat: { id: 777000123, type: 'private' } },
      data,
    },
  }
}

async function parar(adapter: TelegramAdapter): Promise<void> {
  await adapter.stop().catch(() => undefined)
}

describe('provider/telegram/adapter — superficie e limites', () => {
  it('expõe id, limits e sender como o contrato manda', () => {
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, log: log.logger })
    assert.equal(adapter.id, 'telegram')
    assert.deepEqual(adapter.limits, TELEGRAM_LIMITS)
    assert.equal(typeof adapter.sender, 'function')
    assert.equal(typeof adapter.start, 'function')
    assert.equal(typeof adapter.stop, 'function')
    assert.equal(typeof adapter.publishCommands, 'function')
    // Limites concretos (D4).
    assert.equal(TELEGRAM_LIMITS.maxTextLength, 4096)
    assert.equal(TELEGRAM_LIMITS.maxActionRows, 1)
    assert.equal(TELEGRAM_LIMITS.maxActionPerRow, 1)
    assert.equal(TELEGRAM_LIMITS.maxActionDataBytes, 64)
    assert.equal(TELEGRAM_LIMITS.supportsEditing, true)
  })

  it('token vazio recusa na construcao (fail-closed)', () => {
    const log = captureLog()
    assert.throws(() => createTelegramProvider({ token: '  ', log: log.logger }), /token vazio/u)
  })
})

describe('provider/telegram/adapter — o loop de boot', () => {
  it('start: getMe -> deleteWebhook{drop_pending_updates:true} -> getUpdates; eventos chegam ao handler', async () => {
    const srv = await startFakeBotApi([updateDeMensagem('/status')])
    abertos.push(srv)

    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    const eventos: SurfaceEvent[] = []
    void adapter.start(async (ev) => {
      eventos.push(ev)
    })

    // A fila traz um update pendente; o polling entrega-o ao handler.
    await esperar(() => eventos.length >= 1, 'o update chega ao handler')

    const ordem = srv.calls.map((c) => c.method)
    const idxMe = ordem.indexOf('getme')
    const idxDel = ordem.indexOf('deletewebhook')
    const idxGu = ordem.indexOf('getupdates')
    assert.ok(idxMe !== -1 && idxDel !== -1 && idxGu !== -1, `boot presente: ${ordem.join(',')}`)
    assert.ok(idxMe < idxDel, 'getMe antes de deleteWebhook')
    assert.ok(idxDel < idxGu, 'deleteWebhook antes do primeiro getUpdates')

    // TG-045: drop_pending_updates no deleteWebhook, nunca em getUpdates.
    const deletes = chamadasDe(srv, 'deleteWebhook')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0]?.payload['drop_pending_updates'], true)
    for (const call of chamadasDe(srv, 'getUpdates')) {
      assert.equal(Object.hasOwn(call.payload, 'drop_pending_updates'), false)
    }

    // TG-046/047: o primeiro getUpdates e explicito e dentro dos tectos.
    const primeiro = chamadasDe(srv, 'getUpdates')[0]
    assert.ok(primeiro !== undefined)
    assert.deepEqual(primeiro.payload['allowed_updates'], ['message', 'callback_query'])
    assert.equal(primeiro.payload['timeout'], 50)
    assert.equal(primeiro.payload['limit'], 100)

    // O update cru virou SurfaceCommandEvent com os eixos STRING (D4).
    const comando = eventos[0]
    assert.equal(comando?.kind, 'comando')
    if (comando?.kind === 'comando') {
      assert.equal(comando.identity.userKey, '777000123')
      assert.equal(comando.identity.chatKey, '777000123')
      assert.equal(comando.text, '/status')
    }

    await parar(adapter)
  })

  it('409 no boot faz start() REJEITAR (terminal, ZERO reconexoes)', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errs = await canonicalErrors()
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    srv.queueError('deleteWebhook', errs.conflictOtherGetUpdates!)

    let rejeitou = false
    await adapter.start(async () => undefined).then(
      () => undefined,
      () => {
        rejeitou = true
      },
    )
    assert.equal(rejeitou, true, 'start() rejeita no 409')
    await parar(adapter)
  })

  it('401 (token invalido) faz start() rejeitar', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errs = await canonicalErrors()
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    srv.queueError('getMe', errs.unauthorized!)

    let rejeitou = false
    await adapter.start(async () => undefined).then(
      () => undefined,
      () => {
        rejeitou = true
      },
    )
    assert.equal(rejeitou, true, 'start() rejeita no 401')
    await parar(adapter)
  })

  it('409 chegando VIA getUpdates DEPOIS do onStart faz start() REJEITAR (o e2e depende disto)', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errs = await canonicalErrors()
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    // O onStart do grammY fire ANTES do primeiro getUpdates; um 409 nesse
    // getUpdates chega DEPOIS do onStart. `start()` tem de rejeitar para o
    // processo sair com 11 — a semantica dos e2e telegram-409 (imutaveis).
    srv.queueError('getUpdates', errs.conflictOtherGetUpdates!)

    let rejeitou = false
    let erro: unknown
    await adapter.start(async () => undefined).then(
      () => undefined,
      (e: unknown) => {
        rejeitou = true
        erro = e
      },
    )
    assert.equal(rejeitou, true, 'start() rejeita num 409 de getUpdates pos-onStart')
    // Onda 3-fix: o erro que sai do adaptador e o do CONTRATO COMUM —
    // `ProviderError` com o `code` NUMERICO 11 (o boot classifica por code, sem
    // instanceof); o GrammyError original viaja na `cause` para o log.
    assert.ok(erro instanceof ProviderError, 'o erro do contrato comum')
    if (erro instanceof ProviderError) {
      assert.equal(erro.code, WORKER_EXIT.CONFLICT, '409 -> 11')
      assert.equal(erro.reason, 'POLLING_CONFLICT')
      assert.equal((erro.cause as { error_code?: number } | undefined)?.error_code, 409, 'a causa e o 409 do Telegram')
    }
    await parar(adapter)
  })

  it('401 chegando VIA getUpdates faz start() REJEITAR com o codigo 12 em jogo (e2e 401)', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errs = await canonicalErrors()
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    srv.queueError('getUpdates', errs.unauthorized!)

    let rejeitou = false
    let erro: unknown
    await adapter.start(async () => undefined).then(
      () => undefined,
      (e: unknown) => {
        rejeitou = true
        erro = e
      },
    )
    assert.equal(rejeitou, true, 'start() rejeita num 401 de getUpdates')
    assert.ok(erro instanceof ProviderError, 'o erro do contrato comum')
    if (erro instanceof ProviderError) {
      assert.equal(erro.code, WORKER_EXIT.UNAUTHORIZED, '401 -> 12')
      assert.equal(erro.reason, 'POLLING_UNAUTHORIZED')
      assert.equal((erro.cause as { error_code?: number } | undefined)?.error_code, 401)
    }
    await parar(adapter)
  })
})

describe('provider/telegram/adapter — publishCommands', () => {
  it('publica a lista por setMyCommands', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    void adapter.start(async () => undefined)
    await esperar(() => chamadasDe(srv, 'getUpdates').length >= 1)

    await adapter.publishCommands([
      { command: 'ligar', description: 'Liga o túnel' },
      { command: 'desligar', description: 'Desliga o túnel' },
    ])

    const sets = chamadasDe(srv, 'setmycommands')
    const ultimo = sets[sets.length - 1]
    assert.ok(ultimo !== undefined)
    const cmds = ultimo.payload['commands'] as unknown[]
    assert.equal(cmds.length, 2)
    await parar(adapter)
  })
})

describe('provider/telegram/adapter — sender()', () => {
  it('a accao (botao) chega ao handler e o sender.send devolve id STRING (D4)', async () => {
    const srv = await startFakeBotApi([updateDeCallback('g1:tunnel.up:tokenX')])
    abertos.push(srv)
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    let visto: SurfaceEvent | undefined
    void adapter.start(async (ev) => {
      visto = ev
    })
    await esperar(() => visto !== undefined)

    assert.equal(visto?.kind, 'acao')
    if (visto?.kind === 'acao') {
      assert.equal(visto.action, 'tunnel.up')
      assert.equal(visto.token, 'tokenX') // OPACO (S5): transporta, nao valida
      assert.equal(visto.answerTarget, 'cq-9') // TG-027
      const enviado = await adapter.sender().send('777000123', 'A ligar o túnel…')
      assert.equal(typeof enviado, 'string')
      assert.equal(chamadasDe(srv, 'sendmessage').length, 1)
    }
    await parar(adapter)
  })

  it('sender.edit devolve `edited` contra o duble e NAO lanca', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
    void adapter.start(async () => undefined)
    await esperar(() => chamadasDe(srv, 'getUpdates').length >= 1)

    const outcome = await adapter.sender().edit('777000123', '9', 'Estado: pronto')
    assert.equal(outcome, 'edited')
    await parar(adapter)
  })

  it('sender.answer resolve true e faz parar o girador (protocolo TG-027)', async () => {
    const srv = await startFakeBotApi([updateDeCallback('g1:tunnel.up:tokenX')])
    abertos.push(srv)
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
    let visto: SurfaceEvent | undefined
    void adapter.start(async (ev) => {
      visto = ev
    })
    await esperar(() => visto !== undefined)
    if (visto?.kind === 'acao') {
      const ok = await adapter.sender().answer(visto.answerTarget)
      assert.equal(ok, true)
      assert.ok(chamadasDe(srv, 'answercallbackquery').length >= 1)
    }
    await parar(adapter)
  })
})

describe('provider/telegram/adapter — descartados (TG-089)', () => {
  it('um callback malformado conta como descartado e o handler recebe `acao-invalida`', async () => {
    const srv = await startFakeBotApi([updateDeCallback('srv:off:v1')])
    abertos.push(srv)
    const log = captureLog()
    const adapter = createTelegramProvider({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })

    let rejeitado: SurfaceEvent | undefined
    void adapter.start(async (ev) => {
      rejeitado = ev
    })
    await esperar(() => rejeitado !== undefined)

    assert.equal(rejeitado?.kind, 'acao-invalida')
    if (rejeitado?.kind === 'acao-invalida') {
      assert.equal(rejeitado.answerTarget, 'cq-9') // TG-027
      assert.ok(rejeitado.reason !== undefined)
    }
    assert.ok(adapter.descartados() >= 1, 'descartado e contado (TG-089)')
    await parar(adapter)
  })
})

/** Espera que a condicao fique verdadeira (ceder o turno p/ I/O local). */
async function esperar(cond: () => boolean, descricao = 'condicao'): Promise<void> {
  const fim = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > fim) throw new Error(`prazo esgotado: ${descricao}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}