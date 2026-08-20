/**
 * `worker/lib/transport-log.ts` — ACHADO 1 da revisao adversarial.
 *
 * O defeito: uma queda de rede durante o polling nao produzia UMA UNICA LINHA
 * de log, e o processo nao morria — logo o host nao via `stderr` nem `close`, e
 * a falha era literalmente inobservavel.
 *
 * Estes testes existem para falhar se alguem apagar o `try/catch`.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { ApiResponse } from 'grammy/types'

import { createBot } from '../../../../worker/lib/client.ts'
import {
  createTransportLogTransformer,
  ESCALATE_AFTER,
  isSamplePoint,
} from '../../../../worker/lib/transport-log.ts'
import { captureLog, startServidorMudo, TOKEN_DE_TESTE, type ServidorMudo } from './apoio.ts'

const mudos: ServidorMudo[] = []
after(async () => {
  await Promise.all(mudos.map((s) => s.close()))
})

const OK: ApiResponse<true> = { ok: true, result: true }

/** `prev` guionado: lanca `quantas` vezes seguidas, depois devolve sucesso. */
function bancada(quantas: number) {
  const log = captureLog()
  const transformer = createTransportLogTransformer({ log: log.logger })
  let restantes = quantas
  const prev = async (): Promise<ApiResponse<unknown>> => {
    if (restantes > 0) {
      restantes -= 1
      throw new Error('getaddrinfo ENOTFOUND api.telegram.org')
    }
    return Promise.resolve(OK)
  }
  const chamar = async (): Promise<ApiResponse<unknown>> =>
    transformer(prev as never, 'getUpdates' as never, {} as never, undefined)
  return { log, chamar }
}

describe('worker/lib/transport-log — a falha de rede deixa rasto', () => {
  it('ACHADO 1: UMA falha de rede produz UMA linha de log (antes: zero)', async () => {
    const b = bancada(1)
    await assert.rejects(b.chamar, /ENOTFOUND/u)
    assert.equal(b.log.lines.length, 1, 'a primeira falha e SEMPRE registada')
    assert.match(b.log.all(), /falhou \(rede\)/u)
    assert.match(b.log.all(), /ENOTFOUND/u, 'e a causa esta la, nao so "falhou"')
    assert.match(b.log.all(), /falhas_seguidas=1/u)
  })

  it('RELANCA o erro original: o grammY tem de o ver para dormir e repetir', async () => {
    const b = bancada(1)
    const erro = await b.chamar().then(
      () => undefined,
      (e: unknown) => e,
    )
    assert.ok(erro instanceof Error)
    assert.match(erro.message, /ENOTFOUND/u, 'nao e embrulhado nem substituido')
  })

  it('amostra por potencia de dois: 1, 2, 4 registam; 3 e 5 nao', async () => {
    const b = bancada(5)
    for (let i = 0; i < 5; i += 1) await assert.rejects(b.chamar)
    assert.deepEqual(
      b.log.lines.map((l) => /falhas_seguidas=(\d+)/u.exec(l)?.[1]),
      ['1', '2', '4'],
      'uma hora de avaria custa ~11 linhas, nao 1200',
    )
  })

  it(`escalada para ERROR a partir de ${ESCALATE_AFTER} falhas seguidas`, async () => {
    const b = bancada(8)
    for (let i = 0; i < 8; i += 1) await assert.rejects(b.chamar)
    const niveis = b.log.lines.map((l) => l.split(' ')[0])
    assert.deepEqual(niveis, ['WARN', 'WARN', 'WARN', 'ERROR'], '1,2,4 = warn; 8 >= 5 = error')
  })

  it('a recuperacao tambem e registada, e o contador zera', async () => {
    const b = bancada(2)
    await assert.rejects(b.chamar)
    await assert.rejects(b.chamar)
    const resposta = await b.chamar()
    assert.equal(resposta.ok, true)
    assert.match(b.log.all(), /transporte recuperado/u)
    assert.match(b.log.all(), /falhas_seguidas=2/u)
  })

  it('depois de recuperar, a proxima queda volta a ser a "primeira"', async () => {
    const log = captureLog()
    const transformer = createTransportLogTransformer({ log: log.logger })
    let falhar = true
    const prev = async (): Promise<ApiResponse<unknown>> => {
      if (falhar) throw new Error('ECONNRESET')
      return Promise.resolve(OK)
    }
    const chamar = async (): Promise<ApiResponse<unknown>> =>
      transformer(prev as never, 'getUpdates' as never, {} as never, undefined)

    await assert.rejects(chamar) // falha 1
    await assert.rejects(chamar) // falha 2
    falhar = false
    await chamar() // recupera, zera
    falhar = true
    await assert.rejects(chamar) // falha 1 OUTRA VEZ, e tem de ser registada

    const seguidas = log.lines
      .filter((l) => l.includes('falhou (rede)'))
      .map((l) => /falhas_seguidas=(\d+)/u.exec(l)?.[1])
    assert.deepEqual(seguidas, ['1', '2', '1'], 'sem zerar, a 3a queda seria a "3" e nao registava')
  })

  it('sucesso limpo nao regista nada: o log so fala quando ha o que dizer', async () => {
    const b = bancada(0)
    await b.chamar()
    assert.deepEqual(b.log.lines, [])
  })

  it('isSamplePoint e exatamente as potencias de dois', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 16, 17, 32].filter((n) => isSamplePoint(n)),
      [1, 2, 4, 8, 16, 32],
    )
    assert.equal(isSamplePoint(0), false)
  })
})

describe('worker/lib/transport-log — contra um socket que morre a meio', () => {
  it('ACHADO 1 ponta a ponta: o bot real regista a queda, e o token NAO sai', async () => {
    const mudo = await startServidorMudo()
    mudos.push(mudo)
    const log = captureLog()
    const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: mudo.apiRoot, log: log.logger })

    await assert.rejects(() => bot.api.getMe(), /Network request/u)

    assert.ok(mudo.ligacoes() >= 1, 'houve mesmo um pedido HTTP, e ele morreu')
    assert.equal(log.lines.length, 1, 'e ele deixou rasto — que era o defeito')
    assert.match(log.all(), /falhou \(rede\)/u)
    assert.match(log.all(), /method=getMe/u)
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false, 'a causa cita a URL; o token nao sai')
  })
})
