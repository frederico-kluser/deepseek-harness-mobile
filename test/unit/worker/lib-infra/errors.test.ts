/**
 * `worker/lib/errors.ts` — o CONTRATO DE ERRO do processo do bot (Onda 3-fix):
 * o vocabulario fechado dos codigos de saida (10..14), o `ProviderError`
 * canonico com `code` NUMERICO + `reason`, o `WorkerError` legado, e os guards
 * `exitCodeFor`/`isWorkerExitCode` que o BOOT GENERICO usa para classificar
 * QUALQUER erro de QUALQUER provedor — sem `instanceof` de classe de provedor.
 *
 * Este ficheiro nao existia antes desta onda de testes: a classe era coberta
 * indirectamente (e so em parte) pelos testes dos adaptadores.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  exitCodeFor,
  isWorkerExitCode,
  ProviderError,
  WORKER_EXIT,
  WORKER_LOG_NAME,
  WorkerError,
} from '../../../../worker/lib/errors.ts'

describe('worker/lib/errors — WORKER_EXIT (vocabulario fechado, congelado)', () => {
  it('os valores sao os estaveis: 0, 10..14 — nunca 1 nem 128+N (sinal)', () => {
    assert.equal(WORKER_EXIT.OK, 0)
    assert.equal(WORKER_EXIT.CONFIG, 10)
    assert.equal(WORKER_EXIT.CONFLICT, 11)
    assert.equal(WORKER_EXIT.UNAUTHORIZED, 12)
    assert.equal(WORKER_EXIT.POLLING, 13)
    assert.equal(WORKER_EXIT.BOOT_TIMEOUT, 14)
  })

  it('o objecto e congelado (nada de codigos inventados em runtime)', () => {
    assert.equal(Object.isFrozen(WORKER_EXIT), true)
    assert.throws(() => {
      ;(WORKER_EXIT as { CONFIG: number }).CONFIG = 99
    }, TypeError)
  })

  it('exitCodeFor: cada causa terminal mapeia para o codigo do operador', () => {
    // CONFIG: configuracao, nao instabilidade.
    assert.equal(exitCodeFor('TOKEN_MISSING'), WORKER_EXIT.CONFIG)
    assert.equal(exitCodeFor('TOKEN_IN_ARGV'), WORKER_EXIT.CONFIG)
    // CONFLICT: ha um segundo consumidor.
    assert.equal(exitCodeFor('POLLING_CONFLICT'), WORKER_EXIT.CONFLICT)
    // UNAUTHORIZED: token recusado.
    assert.equal(exitCodeFor('POLLING_UNAUTHORIZED'), WORKER_EXIT.UNAUTHORIZED)
    // BOOT_TIMEOUT: arranque expirou.
    assert.equal(exitCodeFor('BOOT_TIMEOUT'), WORKER_EXIT.BOOT_TIMEOUT)
    // POLLING: qualquer outra falha terminal.
    assert.equal(exitCodeFor('POLLING_FAILED'), WORKER_EXIT.POLLING)
    assert.equal(exitCodeFor('CALLBACK_DATA_TOO_LONG'), WORKER_EXIT.POLLING)
    assert.equal(exitCodeFor('MESSAGE_EMPTY'), WORKER_EXIT.POLLING)
  })
})

describe('worker/lib/errors — isWorkerExitCode (o guard de classificacao do boot)', () => {
  it('10..14 sao codigos do contrato; tudo o resto nao e', () => {
    assert.equal(isWorkerExitCode(10), true)
    assert.equal(isWorkerExitCode(11), true)
    assert.equal(isWorkerExitCode(12), true)
    assert.equal(isWorkerExitCode(13), true)
    assert.equal(isWorkerExitCode(14), true)
  })

  it('bordas: 0 (OK nao e erro), 1, 9, 15, 100 e negativos ficam fora do union', () => {
    assert.equal(isWorkerExitCode(0), false, 'OK nao e um veredito de erro')
    assert.equal(isWorkerExitCode(1), false)
    assert.equal(isWorkerExitCode(9), false)
    assert.equal(isWorkerExitCode(15), false)
    assert.equal(isWorkerExitCode(100), false)
    assert.equal(isWorkerExitCode(-1), false)
    assert.equal(isWorkerExitCode(128), false, '128+N e o shell a dizer "morto pelo sinal N"')
  })

  it('nao-numeros e numeros especiais nao entram no union (o boot so aceita number)', () => {
    // `isWorkerExitCode` recebe `number`; em runtime pode chegar um cast frouxo.
    assert.equal(isWorkerExitCode(NaN as number), false)
    assert.equal(isWorkerExitCode(Infinity as number), false)
    assert.equal(isWorkerExitCode(12.5), false)
  })
})

describe('worker/lib/errors — WorkerError (o erro legado do worker, com codigo legivel)', () => {
  it('carrega name, code e a mensagem prefixada pelo dono do log', () => {
    const erro = new WorkerError('POLLING_UNAUTHORIZED', 'o token foi revogado.', {
      cause: new Error('401'),
    })
    assert.equal(erro.name, 'WorkerError')
    assert.equal(erro.code, 'POLLING_UNAUTHORIZED')
    assert.ok(erro instanceof Error)
    assert.equal(erro.message, `[${WORKER_LOG_NAME}] POLLING_UNAUTHORIZED: o token foi revogado.`)
    assert.ok(erro.cause instanceof Error, 'a causa atravessa para o Error do Node')
  })

  it('o prefixo da mensagem identifica o processo (stderr intercalado com o host)', () => {
    const erro = new WorkerError('TOKEN_MISSING', 'x')
    assert.equal(WORKER_LOG_NAME, 'dsh-guard-messenger/worker')
    assert.match(erro.message, /^\[dsh-guard-messenger\/worker\] TOKEN_MISSING:/u)
  })
})

describe('worker/lib/errors — ProviderError (o contrato comum dos provedores)', () => {
  it('code e o NUMERICO 10..14 e reason a causa legivel; a mensagem leva o prefixo', () => {
    const erro = new ProviderError(WORKER_EXIT.UNAUTHORIZED, 'GATEWAY_UNAUTHORIZED', 'token recusado.')
    assert.equal(erro.name, 'ProviderError')
    assert.equal(erro.code, WORKER_EXIT.UNAUTHORIZED)
    assert.equal(erro.code, 12)
    assert.equal(erro.reason, 'GATEWAY_UNAUTHORIZED')
    assert.equal(erro.message, `[${WORKER_LOG_NAME}] GATEWAY_UNAUTHORIZED: token recusado.`)
    assert.ok(erro instanceof Error)
  })

  it('aceita qualquer code do union (10, 11, 13, 14) e a causa opcional', () => {
    for (const code of [10, 11, 13, 14]) {
      const erro = new ProviderError(code as 10 | 11 | 13 | 14, `R-${code}`, 'detalhe')
      assert.equal(erro.code, code, `code ${code} preservado`)
      assert.equal(erro.reason, `R-${code}`)
    }
    const causa = new Error('rede')
    const comCausa = new ProviderError(13, 'GATEWAY_FAILED', 'falhou', { cause: causa })
    assert.equal(comCausa.cause, causa)
  })

  it('o contrato e a CHAVE do boot: o boot le o campo code, nunca instanceof de classe', () => {
    // O teste que o boot generico faz (codeDoContrato): o valor numerico dentro
    // do union decide o codigo de saida — o nome da classe nao importa.
    const erro = new ProviderError(WORKER_EXIT.CONFIG, 'TOKEN_MISSING', 'ausente')
    assert.equal(isWorkerExitCode(erro.code), true)
    assert.equal(erro.code, WORKER_EXIT.CONFIG)
  })
})
