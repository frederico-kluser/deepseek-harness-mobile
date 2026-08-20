/**
 * `worker/lib/auto-retry.ts` — TG-043 e a regra "nunca retry cego".
 *
 * O 429 chega ao transformer como DADO (`ApiResponse` com `ok: false`), e nao
 * como excecao: o grammY so o converte em `GrammyError` DEPOIS da cadeia de
 * transformers (`out/core/client.js:97-100`). E por isso que
 * `parameters.retry_after` esta intacto aqui.
 *
 * Nenhum destes testes espera tempo real: a espera e {@link FakeTime}, e a
 * asserção de TG-043 e uma IGUALDADE (`[3000]`), nao uma tolerancia.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ApiResponse } from 'grammy/types'

import {
  createAutoRetryTransformer,
  retryAfterSeconds,
  TOO_MANY_REQUESTS,
} from '../../../../worker/lib/auto-retry.ts'
import { captureLog, FakeTime } from './apoio.ts'

/** Resposta de erro da Bot API, na forma exata do fio. */
function erro(
  error_code: number,
  description: string,
  parameters?: { retry_after?: number },
): ApiResponse<never> {
  return parameters === undefined
    ? { ok: false, error_code, description }
    : { ok: false, error_code, description, parameters }
}

const OK: ApiResponse<{ message_id: number }> = { ok: true, result: { message_id: 1 } }

/**
 * Monta o transformer com um `prev` guionado.
 *
 * O `prev` real e a chamada HTTP; aqui e uma lista de respostas a devolver por
 * ordem, e o teste conta quantas vezes foi consumida.
 */
function bancada(
  respostas: readonly ApiResponse<unknown>[],
  opcoes: { maxRetryAttempts?: number; maxDelaySeconds?: number } = {},
) {
  const time = new FakeTime()
  const log = captureLog()
  const chamadas: string[] = []
  let indice = 0

  const transformer = createAutoRetryTransformer({ time, log: log.logger, ...opcoes })

  const prev = async (method: string): Promise<ApiResponse<unknown>> => {
    chamadas.push(method)
    const resposta = respostas[Math.min(indice, respostas.length - 1)]
    indice += 1
    assert.ok(resposta !== undefined, 'a bancada tem de ter pelo menos uma resposta')
    return Promise.resolve(resposta)
  }

  return { time, log, chamadas, transformer, prev }
}

describe('worker/lib/auto-retry', () => {
  it('TG-043: 429 com retry_after=3 espera EXATAMENTE 3 s no relogio injetado e repete UMA vez', async () => {
    const b = bancada([erro(TOO_MANY_REQUESTS, 'Too Many Requests: retry after 3', { retry_after: 3 }), OK])

    const resposta = await b.transformer(b.prev as never, 'sendMessage' as never, {} as never, undefined)

    assert.deepEqual(b.time.sleeps, [3000], 'esperou exatamente uma vez, exatamente 3000 ms')
    assert.equal(b.time.now(), 3000, 'o relogio andou 3 s, nem mais nem menos')
    assert.deepEqual(b.chamadas, ['sendMessage', 'sendMessage'], 'duas chamadas: a original e UMA repeticao')
    assert.equal(resposta.ok, true, 'a segunda tentativa passou')
  })

  it('TG-043: 429 persistente NAO entra em ciclo — para no orcamento e devolve o erro', async () => {
    const b = bancada([
      erro(TOO_MANY_REQUESTS, 'Too Many Requests: retry after 1', { retry_after: 1 }),
      erro(TOO_MANY_REQUESTS, 'Too Many Requests: retry after 1', { retry_after: 1 }),
      erro(TOO_MANY_REQUESTS, 'Too Many Requests: retry after 1', { retry_after: 1 }),
    ])

    const resposta = await b.transformer(b.prev as never, 'sendMessage' as never, {} as never, undefined)

    assert.equal(b.chamadas.length, 2, 'uma repeticao e so uma: sem ciclo')
    assert.deepEqual(b.time.sleeps, [1000])
    assert.equal(resposta.ok, false, 'o erro chega a quem chamou em vez de ser mascarado')
    assert.match(b.log.all(), /orcamento de repeticoes esgotado/u)
  })

  it('NUNCA retry cego: 429 SEM retry_after nao dorme e nao repete', async () => {
    const b = bancada([erro(TOO_MANY_REQUESTS, 'Too Many Requests'), OK])

    const resposta = await b.transformer(b.prev as never, 'sendMessage' as never, {} as never, undefined)

    assert.deepEqual(b.time.sleeps, [], 'sem `retry_after` nao ha quanto esperar — logo nao se espera')
    assert.equal(b.chamadas.length, 1, 'e nao se repete: repetir as cegas num 429 AMPLIFICA')
    assert.equal(resposta.ok, false)
  })

  it('NUNCA retry cego: um 400 ou um 500 passam intactos, sem espera', async () => {
    for (const codigo of [400, 403, 500, 502]) {
      const b = bancada([erro(codigo, 'qualquer coisa'), OK])
      const resposta = await b.transformer(b.prev as never, 'sendMessage' as never, {} as never, undefined)
      assert.deepEqual(b.time.sleeps, [], `${codigo} nao e caso de espera`)
      assert.equal(b.chamadas.length, 1, `${codigo} nao e repetido`)
      assert.equal(resposta.ok, false)
    }
  })

  it('um retry_after absurdo NAO e esperado: o worker nao fica pendurado uma hora', async () => {
    const b = bancada([erro(TOO_MANY_REQUESTS, 'retry after 3600', { retry_after: 3600 }), OK], {
      maxDelaySeconds: 60,
    })

    const resposta = await b.transformer(b.prev as never, 'sendMessage' as never, {} as never, undefined)

    assert.deepEqual(b.time.sleeps, [])
    assert.equal(b.chamadas.length, 1)
    assert.equal(resposta.ok, false)
    assert.match(b.log.all(), /acima do tecto/u)
  })

  it('ACHADO 6: um 429 em `getUpdates` NAO e repetido aqui — o polling tem outro dono', async () => {
    // A revisao mediu este caminho a dormir `retry_after` DUAS vezes: uma aqui e
    // outra no `handlePollingError` do grammY, ate 2x a indisponibilidade pedida
    // pelo servidor. `getUpdates` passou a sair deste transformer.
    const b = bancada([erro(TOO_MANY_REQUESTS, 'retry after 7', { retry_after: 7 }), OK])

    const resposta = await b.transformer(b.prev as never, 'getUpdates' as never, {} as never, undefined)

    assert.deepEqual(b.time.sleeps, [], 'zero espera AQUI: quem dorme e o ciclo de polling do grammY')
    assert.deepEqual(b.chamadas, ['getUpdates'], 'e zero repeticoes')
    assert.equal(resposta.ok, false, 'o 429 sobe intacto para o grammY o tratar')
  })

  it('ACHADO 6: o mesmo 429 em `sendMessage` CONTINUA a ser repetido', async () => {
    // A exclusao e cirurgica: so o polling. As chamadas de saida nao tem retry
    // nenhum na biblioteca, e e para elas que este transformer existe.
    const b = bancada([erro(TOO_MANY_REQUESTS, 'retry after 7', { retry_after: 7 }), OK])

    const resposta = await b.transformer(b.prev as never, 'sendMessage' as never, {} as never, undefined)

    assert.deepEqual(b.time.sleeps, [7000])
    assert.equal(b.chamadas.length, 2)
    assert.equal(resposta.ok, true)
  })

  it('sucesso a primeira nao paga nada: nem espera, nem repeticao', async () => {
    const b = bancada([OK])
    const resposta = await b.transformer(b.prev as never, 'getMe' as never, {} as never, undefined)
    assert.deepEqual(b.time.sleeps, [])
    assert.equal(b.chamadas.length, 1)
    assert.equal(resposta.ok, true)
  })

  describe('retryAfterSeconds', () => {
    it('so responde a um 429 com retry_after numerico', () => {
      assert.equal(retryAfterSeconds(erro(429, 'x', { retry_after: 5 })), 5)
      assert.equal(retryAfterSeconds(erro(429, 'x')), undefined)
      assert.equal(retryAfterSeconds(erro(500, 'x', { retry_after: 5 })), undefined)
      assert.equal(retryAfterSeconds(OK), undefined)
    })

    it('um retry_after negativo vale zero, e nao um erro', () => {
      assert.equal(retryAfterSeconds(erro(429, 'x', { retry_after: -7 })), 0)
    })

    it('um retry_after nao finito e tratado como ausente', () => {
      assert.equal(retryAfterSeconds(erro(429, 'x', { retry_after: Number.NaN })), undefined)
      assert.equal(retryAfterSeconds(erro(429, 'x', { retry_after: Number.POSITIVE_INFINITY })), undefined)
    })
  })
})
