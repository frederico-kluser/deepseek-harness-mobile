/**
 * `src/dsh/adapter.ts` -- a rede de seguranca que localiza o `node:http.Server`.
 *
 * PORQUE ESTE FICHEIRO EXISTE: o cabecalho do adapter declara "FALHA ALTO,
 * sempre: um servidor nao localizavel significa 'sem barreira', e 'sem barreira'
 * e uma credencial universal". Um caminho de falha por testar e um caminho de
 * falha que ninguem sabe se funciona -- e este decide se ha portao.
 */

import assert from 'node:assert/strict'
import { Server } from 'node:http'
import { describe, it } from 'node:test'

import { resolveWebServerHttpServer } from '../../../src/dsh/adapter.ts'
import type { WebServer } from '../../../src/dsh/adapter.ts'
import { GuardError } from '../../../src/errors.ts'

/** Converte um duble para a forma que a funcao aceita, sem fingir a classe. */
function comoWebServer(value: unknown): WebServer {
  return value as unknown as WebServer
}

describe('resolveWebServerHttpServer', () => {
  it('devolve o campo `server` quando ele e um node:http.Server', () => {
    const server = new Server()
    assert.equal(resolveWebServerHttpServer(comoWebServer({ server })), server)
  })

  it('FALHA ALTO quando o servico nao existe (undefined/null)', () => {
    for (const ausente of [undefined, null]) {
      assert.throws(
        () => resolveWebServerHttpServer(ausente),
        (error: unknown) =>
          error instanceof GuardError &&
          error.code === 'BARRIER_UNAVAILABLE' &&
          /webServer nao esta disponivel/u.test(error.message),
        `'${String(ausente)}' tem de falhar alto, nunca degradar para "sem barreira"`,
      )
    }
  })

  it('varre os campos proprios quando `server` foi RENOMEADO', () => {
    // A rede de seguranca contra uma renomeacao do campo `private` numa versao
    // futura do host: sem ela, um rename silencioso desligava a barreira.
    const server = new Server()
    const renomeado = comoWebServer({ host: '127.0.0.1', port: 3080, httpServidor: server })

    assert.equal(resolveWebServerHttpServer(renomeado), server)
  })

  it('ignora um campo cujo getter LANCA e continua a varrer', () => {
    const server = new Server()
    const armadilha = {}
    Object.defineProperty(armadilha, 'explosivo', {
      enumerable: true,
      get(): never {
        throw new Error('getter hostil')
      },
    })
    Object.defineProperty(armadilha, 'outroNome', { enumerable: true, value: server })

    assert.equal(resolveWebServerHttpServer(comoWebServer(armadilha)), server)
  })

  it('FALHA ALTO quando nao ha node:http.Server nenhum, e nomeia os campos', () => {
    assert.throws(
      () => resolveWebServerHttpServer(comoWebServer({ host: '127.0.0.1', port: 3080 })),
      (error: unknown) =>
        error instanceof GuardError &&
        error.code === 'BARRIER_UNAVAILABLE' &&
        error.message.includes('host, port'),
      'a mensagem tem de dizer ao operador o que foi inspecionado',
    )
  })

  it('nao confunde um objeto parecido com um Server (instanceof, nao duck typing)', () => {
    const impostor = { server: { listen: (): void => {}, on: (): void => {} } }
    assert.throws(
      () => resolveWebServerHttpServer(comoWebServer(impostor)),
      (error: unknown) => error instanceof GuardError && error.code === 'BARRIER_UNAVAILABLE',
    )
  })
})
