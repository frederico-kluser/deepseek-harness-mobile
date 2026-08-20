/**
 * `src/config/assert.ts` -- "fail loud at load" (Q-3).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertValidConfig } from '../../../src/config/assert.ts'
import { PACKAGED_WORKER_DIR, resolveWorkerCwd } from '../../../src/config/schema.ts'
import type { ExposureConfig, TunnelConfig } from '../../../src/contracts/tunnel.ts'
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

/* ========================================================================== */
/* Os eixos da Onda 3                                                         */
/* ========================================================================== */

/** Um `tunnel` valido, para variar UMA chave de cada vez. */
const TUNEL_VALIDO: TunnelConfig = { mode: 'quick', ttlMinutes: 60 }
const EXPOSICAO_TUNEL: ExposureConfig = { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false }

describe('TUN-019 -- ttlMinutes recusa no load, sem default silencioso e sem clamp', () => {
  it('>>> ausente, 0, negativo, nao-inteiro e 481 sao TODOS recusados <<<', () => {
    const invalidos: Array<[string, unknown]> = [
      ['ausente', undefined],
      ['zero', 0],
      ['negativo', -1],
      ['negativo grande', -480],
      ['nao-inteiro', 60.5],
      ['481 (um acima do tecto)', 481],
      ['uma semana', 10_080],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['string', '60'],
      ['null', null],
    ]

    for (const [rotulo, ttlMinutes] of invalidos) {
      const tunnel = { mode: 'quick', ...(ttlMinutes === undefined ? {} : { ttlMinutes }) }
      assert.throws(
        () => assertValidConfig(makeConfig({ tunnel: tunnel as TunnelConfig })),
        /tunnel\.ttlMinutes/u,
        `ttlMinutes ${rotulo} devia ser recusado`,
      )
    }
  })

  it('a mensagem e ACCIONAVEL: nomeia a chave, o intervalo e onde esta o 60', () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ tunnel: { mode: 'quick' } as TunnelConfig })),
      (error: unknown) => {
        const message = (error as Error).message
        assert.match(message, /config\.tunnel\.ttlMinutes/u)
        assert.match(message, /entre 1 e 480/u)
        assert.match(message, /cordis\.patch\.yml/u)
        assert.match(message, /NAO ha default no codigo e NAO ha clamp/u)
        return true
      },
    )
  })

  it('NUNCA faz clamp: 10080 nao vira 480, LANCA', () => {
    const config = makeConfig({ tunnel: { mode: 'quick', ttlMinutes: 10_080 } })
    assert.throws(() => assertValidConfig(config))
    assert.equal(config.tunnel?.ttlMinutes, 10_080, 'a configuracao nao pode ser mutada')
  })

  it('aceita o intervalo legitimo, incluindo os dois extremos', () => {
    for (const ttlMinutes of [1, 60, 479, 480]) {
      assert.doesNotThrow(() => assertValidConfig(makeConfig({ tunnel: { mode: 'quick', ttlMinutes } })))
    }
  })
})

describe('eixo `tunnel` -- o resto das chaves', () => {
  it("mode 'named' exige tokenFile (o token NUNCA vai no argv -- TUN-014)", () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ tunnel: { mode: 'named', ttlMinutes: 60 } })),
      /tokenFile/u,
    )
    assert.doesNotThrow(() =>
      assertValidConfig(
        makeConfig({ tunnel: { mode: 'named', ttlMinutes: 60, tokenFile: '/etc/dsh/token' } }),
      ),
    )
  })

  it('recusa um modo desconhecido', () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ tunnel: { mode: 'rapido', ttlMinutes: 60 } as unknown as TunnelConfig })),
      /tunnel\.mode/u,
    )
  })

  it('valida metricsPort, graceMs e backoff quando presentes', () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ tunnel: { ...TUNEL_VALIDO, metricsPort: 70_000 } })),
      /metricsPort/u,
    )
    assert.throws(
      () => assertValidConfig(makeConfig({ tunnel: { ...TUNEL_VALIDO, graceMs: 0 } })),
      /graceMs/u,
    )
    assert.throws(
      () =>
        assertValidConfig(
          makeConfig({
            tunnel: {
              ...TUNEL_VALIDO,
              backoff: { initialDelayMs: 500, maxDelayMs: 100, maxAttempts: 3, resetAfterMs: 1000 },
            },
          }),
        ),
      /maxDelayMs/u,
    )
  })
})

describe('eixo `exposure`', () => {
  it('AUSENTE nao e erro -- a leitura da ausencia e a mais fechada que existe', () => {
    const config = makeConfig()
    assert.equal(config.exposure, undefined)
    assert.doesNotThrow(() => assertValidConfig(config))
  })

  it('recusa modo desconhecido e chaves que nao sao booleanas', () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ exposure: { mode: 'publico' } as unknown as ExposureConfig })),
      /exposure\.mode/u,
    )
    assert.throws(
      () =>
        assertValidConfig(
          makeConfig({ exposure: { ...EXPOSICAO_TUNEL, autoStart: 'true' } as unknown as ExposureConfig, tunnel: TUNEL_VALIDO }),
        ),
      /exposure\.autoStart/u,
    )
  })

  it('>>> trustEdgeHeaders:true SEM borda a frente e recusado no arranque <<<', () => {
    // Em `loopback` nao ha borda: o cabecalho so pode ter sido escrito por um
    // processo local, que passaria a escolher o proprio IP -- e com ele o balde
    // do rate limit e a linha do audit log.
    assert.throws(
      () =>
        assertValidConfig(
          makeConfig({ exposure: { mode: 'loopback', autoStart: false, trustEdgeHeaders: true } }),
        ),
      /trustEdgeHeaders/u,
    )
    assert.doesNotThrow(() =>
      assertValidConfig(
        makeConfig({
          exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: true },
          tunnel: TUNEL_VALIDO,
        }),
      ),
    )
  })

  it("mode 'tunnel' sem o objeto `tunnel` e recusado no arranque", () => {
    assert.throws(
      () => assertValidConfig(makeConfig({ exposure: EXPOSICAO_TUNEL })),
      /exige o objeto config\.tunnel/u,
    )
  })
})

describe('eixo `control` -- minimo, e o PREP 5 e dono da expansao', () => {
  it('valida o booleano quando presente e aceita a ausencia', () => {
    assert.doesNotThrow(() => assertValidConfig(makeConfig({ control: { requireConfirmation: true } })))
    assert.throws(
      () =>
        assertValidConfig(
          makeConfig({ control: { requireConfirmation: 'sim' } as unknown as { requireConfirmation: boolean } }),
        ),
      /control\.requireConfirmation/u,
    )
  })
})
