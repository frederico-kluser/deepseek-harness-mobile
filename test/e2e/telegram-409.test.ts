/**
 * T6.2 — o 409 de polling duplicado, no PROCESSO REAL (pergunta falsificavel
 * 1/5: o servidor falso implementa o 409 e o worker SAI em vez de flapping).
 *
 * O facto medido (Onda 0): o 409 mata a instancia que JA estava pendurada,
 * nunca a que chega. Quem reinicia cegamente entra em flapping infinito — por
 * isso o processo termina com o codigo proprio de CONFLITO (11) e UMA tentativa
 * de getUpdates, e mais nenhuma.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  assertSemTokenRealNoAmbiente,
  canonicalErrors,
  chamadasDe,
  startFakeBotApi,
  spawnWorkerProcess,
  TOKEN_DE_TESTE,
  type FakeBotApi,
  type WorkerFilho,
} from './telegram-apoio.ts'
import { WORKER_EXIT } from '../../worker/lib/errors.ts'

assertSemTokenRealNoAmbiente()

const abertos: FakeBotApi[] = []
const filhos: WorkerFilho[] = []

after(async () => {
  for (const filho of filhos) await filho.parar()
  await Promise.all(abertos.map((srv) => srv.close()))
})

describe('e2e 409 — o processo SAI em vez de flapping', () => {
  it('409 no primeiro getUpdates: saida com o codigo de CONFLITO (11), UMA tentativa e mais nenhuma', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errors = await canonicalErrors()
    const conflito = errors['conflictOtherGetUpdates']
    assert.ok(conflito !== undefined)
    srv.queueError('getUpdates', conflito)

    const filho = spawnWorkerProcess({ srv })
    filhos.push(filho)

    const saida = await filho.saida
    assert.equal(saida.pendurado, false, 'o processo saiu sozinho, sem kill de seguranca')
    assert.equal(saida.code, WORKER_EXIT.CONFLICT, 'codigo distinto de CONFLITO, nao 0 nem 1')
    assert.notEqual(saida.code, WORKER_EXIT.OK, 'sair com 0 faria o host achar que foi paragem pedida')

    // O NUCLEO: uma tentativa e mais nenhuma — reconexao agressiva aqui seria
    // flapping infinito (o 409 mata a instancia que ja estava pendurada).
    assert.equal(chamadasDe(srv, 'getUpdates').length, 1)

    const stderr = filho.stderr()
    assert.match(stderr, /409/u)
    assert.match(stderr, /outro getUpdates/u)
    assert.match(stderr, /flapping/u, 'a linha explica PORQUE o processo sai em vez de reiniciar')
    assert.equal(stderr.includes(TOKEN_DE_TESTE), false, 'nem no caminho de erro o token sai')
  })

  it('401 e igualmente terminal e DISTINGUIVEL: codigo 12, nunca 11', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errors = await canonicalErrors()
    const naoAutorizado = errors['unauthorized']
    assert.ok(naoAutorizado !== undefined)
    srv.queueError('getUpdates', naoAutorizado)

    const filho = spawnWorkerProcess({ srv })
    filhos.push(filho)

    const saida = await filho.saida
    assert.equal(saida.code, WORKER_EXIT.UNAUTHORIZED, '401 -> 12')
    assert.notEqual(saida.code, WORKER_EXIT.CONFLICT, 'codigos distintos: causas distintas')
    assert.equal(chamadasDe(srv, 'getUpdates').length, 1, 'tambem terminal: sem reconexao')
    assert.equal(filho.stderr().includes(TOKEN_DE_TESTE), false)
  })

  it('o formato do 409 nao e complacente: HTTP 409, corpo canonico transcrito de Client.cpp', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errors = await canonicalErrors()
    const conflito = errors['conflictOtherGetUpdates']
    assert.ok(conflito !== undefined)
    srv.queueError('getUpdates', conflito)

    const resposta = await fetch(`${srv.apiRoot}/bot${TOKEN_DE_TESTE}/getUpdates`)

    assert.equal(resposta.status, 409)
    assert.deepEqual(await resposta.json(), {
      ok: false,
      error_code: 409,
      description: conflito.description,
    })
  })
})
