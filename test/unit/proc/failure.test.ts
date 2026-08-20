/**
 * `src/proc/failure.ts` -- a classificacao que decide se vale a pena tentar de
 * novo (SUP-007 / SUP-008, na sua forma PURA).
 *
 * A pergunta falsificavel 4 de T3.1 e "`ENOENT` e nao-retryable?". Aqui isso e
 * uma comparacao de valores; a sua consequencia no ciclo de vida esta em
 * `retry.test.ts` e em `test/integration/proc/close-is-terminal.test.ts`, que
 * mede a sequencia de eventos com processos REAIS.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  classifyNonRetryable,
  describeNonRetryable,
  SpawnSpecError,
  spawnErrno,
} from '../../../src/proc/failure.ts'

describe('classificacao de causas nao-retryable', () => {
  it('SUP-007: ENOENT -> BINARY_NOT_FOUND', () => {
    assert.equal(
      classifyNonRetryable(Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' })),
      'BINARY_NOT_FOUND',
    )
  })

  it('SUP-008: EACCES e EPERM -> BINARY_NOT_EXECUTABLE', () => {
    assert.equal(
      classifyNonRetryable(Object.assign(new Error('x'), { code: 'EACCES' })),
      'BINARY_NOT_EXECUTABLE',
    )
    assert.equal(
      classifyNonRetryable(Object.assign(new Error('x'), { code: 'EPERM' })),
      'BINARY_NOT_EXECUTABLE',
    )
  })

  it('`SpawnSpecError` -> INVALID_SPEC: a config foi recusada antes de haver processo', () => {
    assert.equal(classifyNonRetryable(new SpawnSpecError('porta invalida')), 'INVALID_SPEC')
  })

  it('o DEFAULT e RETRYABLE, e isso e deliberado', () => {
    // Classificar mal como terminal PARA um processo que so teve um solucco;
    // classificar mal como retryable gasta orcamento e acaba em
    // BUDGET_EXHAUSTED, que tambem e terminal e tambem e visivel. O erro caro e
    // o primeiro, entao a duvida cai para o lado que ainda tenta.
    assert.equal(classifyNonRetryable(Object.assign(new Error('x'), { code: 'EAGAIN' })), undefined)
    assert.equal(classifyNonRetryable(new Error('coisa qualquer')), undefined)
    assert.equal(classifyNonRetryable('nem sequer e um Error'), undefined)
  })
})

describe('extraccao do errno atraves das camadas em que o assento o pode embrulhar', () => {
  it('le `code` directo', () => {
    assert.equal(spawnErrno(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT')
  })

  it('atravessa `cause` -- o assento e ABSTRACTO e pode embrulhar o erro do child_process', () => {
    const inner = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const outer = new Error('falha ao alocar processo', { cause: inner })
    assert.equal(spawnErrno(outer), 'ENOENT')
    assert.equal(classifyNonRetryable(outer), 'BINARY_NOT_FOUND')
  })

  it('ultimo recurso: le o TEXTO, com fronteira de palavra', () => {
    assert.equal(spawnErrno(new Error('spawn cloudflared ENOENT')), 'ENOENT')
    // Um caminho que CONTEM as letras nao pode ser lido como um errno: sem a
    // fronteira de palavra, `/opt/enoent-tools/bin` classificava como binario
    // ausente um processo que morreu por outra razao qualquer.
    assert.equal(spawnErrno(new Error('falhou em /opt/enoent-tools/bin')), undefined)
  })
})

describe('mensagem accionavel', () => {
  it('nomeia o processo, diz o que fazer, e NAO leva caminho absoluto', () => {
    for (const kind of ['BINARY_NOT_FOUND', 'BINARY_NOT_EXECUTABLE', 'INVALID_SPEC'] as const) {
      const message = describeNonRetryable(kind, 'cloudflared')
      assert.equal(message.includes('cloudflared'), true)
      // INVARIANTE DE APRESENTACAO: esta mensagem viaja para o Telegram. Um
      // caminho absoluto nela divulga o layout do disco do utilizador a um
      // terceiro (a infraestrutura de quem transporta a mensagem).
      assert.equal(/(^|\s)\/[\w./-]+/u.test(message), false, `caminho absoluto em ${kind}`)
    }
  })
})
