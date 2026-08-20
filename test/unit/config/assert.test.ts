/**
 * `src/config/assert.ts` -- "fail loud at load" (Q-3).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertValidConfig } from '../../../src/config/assert.ts'
import { PACKAGED_WORKER_DIR, resolveWorkerCwd } from '../../../src/config/schema.ts'
import { makeConfig } from '../../support/fixtures.ts'

describe('fail loud at load', () => {
  it('recusa configuracao incompleta em vez de preencher por omissao', () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ encodedAuthString: '' })),
      /encodedAuthString/u,
    )
    assert.throws(() => assertValidConfig(makeConfig({ allowedHosts: [] })), /allowedHosts/u)
    assert.throws(() => assertValidConfig(makeConfig({ realm: 'realm "injetado"' })), /realm/u)

    const semComando = makeConfig()
    semComando.worker.command = ''
    assert.throws(() => assertValidConfig(semComando), /worker.command/u)

    const backoffInvalido = makeConfig()
    backoffInvalido.worker.backoff.maxDelayMs = 100
    assert.throws(() => assertValidConfig(backoffInvalido), /maxDelayMs/u)
  })

  it('L2: recusa no arranque um realm nao representavel em Latin-1', () => {
    // Um cabecalho HTTP/1.1 viaja em Latin-1: isto rebentaria DENTRO do
    // `res.writeHead(401, ...)` com ERR_INVALID_CHAR e devolveria resposta VAZIA
    // em vez do desafio -- a barreira continuaria a barrar, mas deixaria de ser
    // legivel e o operador nao perceberia porque.
    assert.throws(() => assertValidConfig(makeConfig({ realm: 'DSH \u{1F512}' })), /realm/u)
    assert.throws(() => assertValidConfig(makeConfig({ realm: 'DSH \u4f60\u597d' })), /realm/u)

    // Latin-1 legitimo continua a passar (os acentos do portugues estao abaixo
    // de U+00FF). Sem esta metade, "recusar tudo" satisfazia o teste.
    assert.doesNotThrow(() =>
      assertValidConfig(makeConfig({ realm: 'Interface Segura \u00e7\u00e3o' })),
    )
  })

  it('recusa caracteres de controlo no realm (injecao de cabecalhos por CRLF)', () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ realm: 'DSH\r\nX-Injetado: 1' })),
      /realm/u,
    )
    assert.throws(() => assertValidConfig(makeConfig({ realm: 'DSH\u007f' })), /realm/u)
  })

  it('recusa barra invertida no realm (quebra a quoted-string)', () => {
    assert.throws(() => assertValidConfig(makeConfig({ realm: 'DSH\\quebrado' })), /realm/u)
  })

  it('aceita trustedRemotes vazio (fail-closed e configuracao valida)', () => {
    assert.doesNotThrow(() => assertValidConfig(makeConfig({ trustedRemotes: [] })))
  })

  it('exige worker.graceMs positivo e finito (o assento nao aplica defaults)', () => {
    const semGrace = makeConfig()
    // O YAML pode simplesmente nao trazer a chave: no `replace` do motor de
    // patches, o objeto `config`, quando fornecido, e substituido INTEIRO.
    delete (semGrace.worker as { graceMs?: number }).graceMs
    assert.throws(() => assertValidConfig(semGrace), /worker\.graceMs/u)

    const graceZero = makeConfig()
    graceZero.worker.graceMs = 0
    assert.throws(() => assertValidConfig(graceZero), /worker\.graceMs/u)
  })
})

describe('validacao do par descodificado de encodedAuthString (achado B-CRITICAL)', () => {
  it('recusa dW5kZWZpbmVkOnVuZGVmaW5lZA== (= undefined:undefined)', () => {
    const universal = Buffer.from('undefined:undefined').toString('base64')
    assert.equal(universal, 'dW5kZWZpbmVkOnVuZGVmaW5lZA==')

    assert.throws(
      () => assertValidConfig(makeConfig({ encodedAuthString: universal })),
      /literal 'undefined'/u,
    )
  })

  it('recusa o literal undefined/null de qualquer um dos lados', () => {
    for (const par of ['undefined:senha', 'admin:undefined', 'null:senha', 'admin:null']) {
      assert.throws(
        () =>
          assertValidConfig(makeConfig({ encodedAuthString: Buffer.from(par).toString('base64') })),
        /literal/u,
        `'${par}' tinha de ser recusado`,
      )
    }
  })

  it('recusa um par sem ":" ou com um dos lados vazio', () => {
    assert.throws(
      () =>
        assertValidConfig(
          makeConfig({ encodedAuthString: Buffer.from('semdoispontos').toString('base64') }),
        ),
      /separado por ":"/u,
    )
    assert.throws(
      () =>
        assertValidConfig(
          makeConfig({ encodedAuthString: Buffer.from('admin:').toString('base64') }),
        ),
      /vazios/u,
    )
    assert.throws(
      () =>
        assertValidConfig(
          makeConfig({ encodedAuthString: Buffer.from(':senha').toString('base64') }),
        ),
      /vazios/u,
    )
  })

  it('aceita uma credencial legitima', () => {
    assert.doesNotThrow(() => assertValidConfig(makeConfig()))
  })

  it('AUSENTE e valido: o manifesto Camada 1/Bundle nao pode transportar credencial', () => {
    const semCredencial = makeConfig()
    delete semCredencial.encodedAuthString
    assert.doesNotThrow(() => assertValidConfig(semCredencial))
  })
})

describe('validacao de prefixos', () => {
  it("recusa no arranque um prefixo sem '/' inicial", () => {
    assert.throws(() => assertValidConfig(makeConfig({ guardedPrefixes: ['api'] })), /comecar por/u)
    assert.throws(
      () => assertValidConfig(makeConfig({ guardedPrefixes: ['/api', 'admin'] })),
      /guardedPrefixes\[1\]/u,
    )
  })
})

describe('worker.cwd', () => {
  it('recusa no arranque um worker.cwd que nao existe', () => {
    const semCwd = makeConfig()
    semCwd.worker.cwd = '/caminho/que/nao/existe/dsh-worker'

    assert.throws(() => assertValidConfig(semCwd), /worker\.cwd/u)
  })

  it('recusa no arranque um worker.cwd que existe mas nao e diretorio', () => {
    const ficheiro = makeConfig()
    // O proprio ficheiro de testes existe e NAO e um diretorio.
    ficheiro.worker.cwd = fileURLToPath(import.meta.url)

    assert.throws(() => assertValidConfig(ficheiro), /nao e um diretorio/u)
  })

  it('AUSENTE resolve para o worker/ empacotado, e esse caminho e validado', () => {
    const semCwd = makeConfig()
    delete semCwd.worker.cwd

    assert.equal(resolveWorkerCwd(semCwd), PACKAGED_WORKER_DIR)
    assert.doesNotThrow(
      () => assertValidConfig(semCwd),
      'o worker/ do proprio pacote tem de existir',
    )
  })

  it('um cwd declarado ganha ao default', () => {
    const config = makeConfig()
    assert.notEqual(resolveWorkerCwd(config), PACKAGED_WORKER_DIR)
  })
})
