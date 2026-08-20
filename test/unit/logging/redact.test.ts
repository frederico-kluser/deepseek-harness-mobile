/**
 * `src/logging/redact.ts` -- Q-4: segredo nunca em log.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { redact, REDACTED } from '../../../src/logging/redact.ts'

describe('redact', () => {
  it('mascara um literal conhecido onde quer que ele apareca', () => {
    const token = '123456789:AAH-segredo-do-bot-que-nao-pode-vazar'
    const linha = `HTTPError: 401 for url https://api.telegram.org/bot${token}/getUpdates`

    const limpo = redact(linha, [token])

    assert.equal(limpo.includes(token), false, 'o token NAO pode sobreviver')
    assert.equal(limpo.includes(REDACTED), true)
    assert.equal(limpo.includes('api.telegram.org'), true, 'o resto da linha continua legivel')
  })

  it('mascara a FORMA de um token de bot mesmo sem o conhecer', () => {
    const linha = 'GET https://api.telegram.org/bot987654321:ZZZZZZZZZZZZZZZZZZZZZZZZ/sendMessage'

    const limpo = redact(linha)

    assert.equal(limpo.includes('ZZZZZZZZZZZZZZZZZZZZZZZZ'), false)
    assert.equal(limpo.includes('987654321:'), true, 'o id numerico nao e segredo')
  })

  it('mascara o VALOR de Authorization e de Cookie, mantendo o nome', () => {
    const dump = 'Authorization: Basic YWRtaW46czNjcjN0\nSet-Cookie: __Host-dsh_sid=abc123; Path=/'

    const limpo = redact(dump)

    assert.equal(limpo.includes('YWRtaW46czNjcjN0'), false)
    assert.equal(limpo.includes('abc123'), false)
    assert.equal(limpo.includes('Authorization: '), true)
    assert.equal(limpo.includes('Set-Cookie: '), true)
  })

  it('ignora literais curtos demais para serem segredo (evita ruido)', () => {
    // Mascarar `'x'` transformaria metade do log em [REDACTED].
    assert.equal(redact('o worker x saiu com codigo x', ['x']), 'o worker x saiu com codigo x')
  })

  it('e reentrante: duas chamadas seguidas dao o mesmo resultado', () => {
    const linha = 'Authorization: Basic YWRtaW46czNjcjN0'
    assert.equal(redact(linha), redact(linha))
  })
})
