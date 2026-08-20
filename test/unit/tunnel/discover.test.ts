/**
 * =============================================================================
 * `src/tunnel/discover.ts` — TUN-001..TUN-010 e TUN-015 (`04-TESTES.md` 5.4.2).
 * =============================================================================
 *
 * NENHUM TESTE DESTE FICHEIRO INVOCA O `cloudflared` REAL, nem local nem em CI
 * (D10). Subir um quick tunnel de verdade PUBLICA NA INTERNET o que estiver na
 * porta — foi assim que a pesquisa que originou este plugin expos o DSH real do
 * utilizador durante cerca de 40 segundos. Aqui o mundo exterior entra todo por
 * dependencia injetada: o relogio, a espera e a sondagem HTTP.
 *
 * NENHUM TESTE ESPERA TEMPO REAL. O prazo de 30 s de TUN-009 corre num
 * `FakeClock` (`test/support/clock.ts`, congelado): a espera injetada faz o
 * relogio ANDAR e devolve logo. Um teste que dormisse 30 segundos seria um
 * teste que ninguem corre.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createTunnelDiscovery,
  MIN_DISCOVERY_TIMEOUT_MS,
  readQuickTunnelBody,
  TunnelError,
  type DiscoveryDeps,
  type HttpProbe,
} from '../../../src/tunnel/discover.ts'
import { FakeClock } from '../../support/clock.ts'

import type { TunnelDiscoveryInput } from '../../../src/contracts/tunnel.ts'

/* ========================================================================== */
/* Apoio                                                                      */
/* ========================================================================== */

const HOSTNAME = 'exemplo-duble-do-tunel.trycloudflare.com'
const URL_ESPERADA = `https://${HOSTNAME}`
const PORTA_DE_METRICAS = 41_337
const INTERVALO = 250

/** A caixa ASCII, tal como ela sai no `stderr` medido do 2026.7.3. */
const CAIXA = [
  'INF +--------------------------------------------+\n',
  `INF |  https://${HOSTNAME}  |\n`,
  'INF +--------------------------------------------+\n',
].join('')

interface Bancada {
  readonly deps: DiscoveryDeps
  readonly clock: FakeClock
  /** Quantas vezes o `/quicktunnel` foi consultado. */
  readonly consultas: () => number
  /** As portas em que se bateu, por ordem. A prova de que nenhuma foi adivinhada. */
  readonly portas: () => readonly number[]
}

/**
 * A bancada injeta TUDO o que e mundo exterior. `sondar` decide, por numero da
 * consulta, o que o endpoint responde — que e a unica forma de escrever
 * "responde 404 nas primeiras N tentativas e depois 200" sem um servidor a
 * mudar de ideias a meio.
 */
function bancada(sondar: (consulta: number) => HttpProbe | Promise<HttpProbe>): Bancada {
  const clock = new FakeClock(1_700_000_000_000)
  const portas: number[] = []
  let consultas = 0

  const deps: DiscoveryDeps = {
    now: () => clock.now(),
    sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
      clock.advance(ms)
      // `setImmediate` e nao `Promise.resolve()`: os chunks de um `Readable`
      // sao entregues pela maquinaria de streams, que agenda em `nextTick` e na
      // fase de *check*. Uma microtarefa so nao chega para o que ja esta no
      // buffer atingir o nosso listener — e entao o teste passava a medir o
      // agendador em vez de medir o parser. Continua a nao haver tempo real
      // nenhum: quem anda e o relogio falso, na linha acima.
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      // A espera injetada respeita o `signal` tal como a real: e o que faz
      // TUN-010 medir o corte imediato em vez de o assumir.
      if (signal.aborted) throw new Error('espera abortada')
    },
    probeQuickTunnel: async (metricsPort: number): Promise<HttpProbe> => {
      consultas += 1
      portas.push(metricsPort)
      return await sondar(consultas)
    },
    pollIntervalMs: INTERVALO,
    attemptTimeoutMs: 2000,
  }

  return { deps, clock, consultas: () => consultas, portas: () => portas }
}

const RECUSADO: HttpProbe = { kind: 'unreachable', reason: 'ECONNREFUSED' }
const respostaComHostname = (hostname: string): HttpProbe => ({
  kind: 'response',
  status: 200,
  body: JSON.stringify({ hostname }),
})

function entrada(overrides: Partial<TunnelDiscoveryInput> = {}): TunnelDiscoveryInput {
  return {
    metricsPort: PORTA_DE_METRICAS,
    stderr: null,
    signal: new AbortController().signal,
    timeoutMs: MIN_DISCOVERY_TIMEOUT_MS,
    ...overrides,
  }
}

async function falha(promessa: Promise<unknown>): Promise<TunnelError> {
  try {
    await promessa
  } catch (error) {
    assert.ok(error instanceof TunnelError, `esperava TunnelError, veio ${String(error)}`)
    return error
  }
  throw new Error('a promessa resolveu quando devia ter falhado')
}

/* ========================================================================== */
/* TUN-001 / TUN-002 — o caminho primario e a normalizacao do esquema         */
/* ========================================================================== */

describe('TUN-001 — `/quicktunnel` responde 200 com hostname', () => {
  it('devolve `https://` + hostname e marca o caminho preferido', async () => {
    const { deps } = bancada(() => respostaComHostname(HOSTNAME))
    const resultado = await createTunnelDiscovery(deps).discover(entrada())

    assert.deepEqual(resultado, { url: URL_ESPERADA, via: 'metrics' })
  })

  it('o endpoint GANHA ao `stderr` quando os dois tem a resposta na mesma volta', async () => {
    // Prova o "caminho PREFERIDO" do enunciado: com as duas fontes prontas, o
    // `via` tem de ser `metrics`. Sem esta asercao, uma implementacao que
    // lesse o log primeiro passaria em TUN-001 na mesma.
    const stderr = new PassThrough()
    stderr.write(CAIXA)
    const { deps } = bancada(() => respostaComHostname(HOSTNAME))

    const resultado = await createTunnelDiscovery(deps).discover(entrada({ stderr }))

    assert.equal(resultado.via, 'metrics')
    assert.equal(resultado.url, URL_ESPERADA)
  })
})

describe('TUN-002 — hostname vem SEM esquema', () => {
  it('prefixa `https://` exactamente uma vez', async () => {
    const { deps } = bancada(() => respostaComHostname(HOSTNAME))
    const { url } = await createTunnelDiscovery(deps).discover(entrada())

    assert.equal(url, URL_ESPERADA)
    assert.equal(url.startsWith('https://'), true)
    assert.equal(url.split('https://').length - 1, 1, 'o esquema aparece uma unica vez')
    assert.equal(url.includes('https://https://'), false)
  })

  it('um hostname que JA venha com esquema e RECUSADO, nunca prefixado de novo', async () => {
    // O mutante obvio e `hostname.startsWith('https://') ? hostname : 'https://' + hostname`.
    // Ele "funciona" e faz o codigo aceitar como bom um campo que o endpoint
    // nunca devia ter enviado. Aqui a forma e ancorada nos dois extremos: o que
    // nao casa nao entra, e a suite prova que o valor NAO e devolvido.
    const { deps, clock } = bancada(() => respostaComHostname(`https://${HOSTNAME}`))
    const inicio = clock.now()

    const erro = await falha(createTunnelDiscovery(deps).discover(entrada()))

    assert.equal(erro.code, 'READINESS_TIMEOUT')
    assert.equal(erro.message.includes('trycloudflare'), false)
    assert.equal(clock.now() - inicio >= MIN_DISCOVERY_TIMEOUT_MS, true)
  })

  it('um hostname que nao e de quick tunnel e RECUSADO', async () => {
    const { deps } = bancada(() => respostaComHostname('atacante.exemplo.pt'))
    const erro = await falha(createTunnelDiscovery(deps).discover(entrada()))

    assert.equal(erro.code, 'READINESS_TIMEOUT')
    assert.equal(erro.message.includes('atacante'), false)
  })

  it('SO um 200 entrega hostname: outro codigo com corpo valido nao e aceite', async () => {
    // O estado faz parte da validacao de fronteira, e nao e detalhe. Um
    // `/quicktunnel` que responda `404` com um corpo bem formado esta a dizer
    // que a rota nao existe nesta versao — aceitar o corpo seria acreditar no
    // conteudo de uma resposta que o proprio servidor marcou como invalida.
    for (const status of [201, 204, 301, 400, 404, 500, 503]) {
      const { deps } = bancada(() => ({
        kind: 'response',
        status,
        body: JSON.stringify({ hostname: HOSTNAME }),
      }))

      const erro = await falha(createTunnelDiscovery(deps).discover(entrada()))

      assert.equal(erro.code, 'READINESS_TIMEOUT', `status ${String(status)}`)
      assert.equal(erro.message.includes(`HTTP ${String(status)}`), true)
    }
  })

  it('a validacao de fronteira recusa corpo que nao e JSON, nao e objecto, ou nao tem `hostname`', () => {
    assert.equal(readQuickTunnelBody('nao e json').kind, 'rejected')
    assert.equal(readQuickTunnelBody('[]').kind, 'rejected')
    assert.equal(readQuickTunnelBody('null').kind, 'rejected')
    assert.equal(readQuickTunnelBody('{"hostname":42}').kind, 'rejected')
    assert.equal(readQuickTunnelBody('{"hostname":""}').kind, 'rejected')
    assert.equal(readQuickTunnelBody('{"hostname":"A-MAIUSCULA.trycloudflare.com"}').kind, 'rejected')
    assert.equal(readQuickTunnelBody('{"hostname":"x.evil.com"}').kind, 'rejected')
    assert.deepEqual(readQuickTunnelBody(`{"hostname":"${HOSTNAME}"}`), {
      kind: 'url',
      url: URL_ESPERADA,
    })
  })
})

/* ========================================================================== */
/* TUN-003 — o polling persiste                                               */
/* ========================================================================== */

describe('TUN-003 — 404 nas primeiras tentativas, depois 200', () => {
  it('insiste ate ao prazo e tem sucesso', async () => {
    const { deps, clock, consultas } = bancada((consulta) =>
      consulta <= 24
        ? { kind: 'response', status: 404, body: '404 page not found' }
        : respostaComHostname(HOSTNAME),
    )
    const inicio = clock.now()

    const resultado = await createTunnelDiscovery(deps).discover(entrada())

    assert.deepEqual(resultado, { url: URL_ESPERADA, via: 'metrics' })
    assert.equal(consultas(), 25)
    // 24 esperas de 250 ms = 6 s, que e o tempo MEDIDO ate a URL aparecer.
    assert.equal(clock.now() - inicio, 24 * INTERVALO)
  })
})

/* ========================================================================== */
/* TUN-004 — o fallback por regex                                             */
/* ========================================================================== */

describe('TUN-004 — endpoint inalcancavel durante todo o warmup', () => {
  it('a URL sai do `stderr` e o `via` prova-o', async () => {
    const stderr = new PassThrough()
    const { deps, consultas } = bancada((consulta) => {
      // O log so aparece a meio: prova que o ciclo continuou a olhar para o
      // `stderr` depois da primeira volta, e nao so uma vez no arranque.
      if (consulta === 10) stderr.write(CAIXA)
      return RECUSADO
    })

    const resultado = await createTunnelDiscovery(deps).discover(entrada({ stderr }))

    assert.deepEqual(resultado, { url: URL_ESPERADA, via: 'stderr' })
    assert.equal(consultas() >= 10, true)
  })

  it('sem `stderr` (`null`) so existe o caminho primario', async () => {
    const { deps } = bancada(() => RECUSADO)
    const erro = await falha(createTunnelDiscovery(deps).discover(entrada({ stderr: null })))

    assert.equal(erro.code, 'READINESS_TIMEOUT')
    assert.equal(erro.message.includes('ECONNREFUSED'), true, 'o motivo medido sobe ate a mensagem')
  })
})

/* ========================================================================== */
/* TUN-005 — o parser le `stderr`, e SO `stderr`                              */
/* ========================================================================== */

/**
 * Colapsa em `never` no dia em que alguem acrescentar `stdout` ao contrato.
 *
 * Uma asercao de TIPO, e nao de comportamento, porque comportamento nao ha:
 * `TunnelDiscoveryInput` nem sequer entrega `stdout`, logo qualquer teste que
 * "escrevesse a URL em stdout" estaria, por construcao, a montar um `stderr`
 * vazio — byte a byte o cenario de TUN-009. A revisao adversarial apanhou
 * exactamente isso na versao anterior deste ficheiro e o teste encenado foi
 * RETIRADO. O que segura a linha e este tipo (verificado por `pnpm typecheck`,
 * que abrange `test/**`), o grep ao fonte logo abaixo, e o teste de integracao
 * com um processo real a escrever mesmo em stdout.
 */
type SemCanalDeStdout = 'stdout' extends keyof TunnelDiscoveryInput ? never : true

describe('TUN-005 — URL so em stdout', () => {
  it('o contrato NAO tem canal de stdout: ler de la e inconstruivel, nao so errado', () => {
    // Medido: em duas execucoes do `cloudflared` 2026.7.3 o `stdout` ficou com
    // EXATAMENTE 0 bytes. A resposta certa nao foi "nao leias stdout" — foi
    // tirar o canal do contrato, para que o mutante nao tenha por onde entrar.
    const semStdout: SemCanalDeStdout = true

    assert.equal(semStdout, true)
    assert.deepEqual(Object.keys(entrada()).toSorted(), [
      'metricsPort',
      'signal',
      'stderr',
      'timeoutMs',
    ])
  })

  it('o fonte nao le `stdout` em lado nenhum — a decisao esta congelada no codigo', () => {
    // Asercao sobre o FONTE, e nao sobre o comportamento: o contrato
    // (`TunnelDiscoveryInput`) nem sequer entrega `stdout`, por isso a unica
    // forma de o mutante "ler as duas" voltar e alguem acrescentar o campo. Que
    // e exactamente o que este teste torna barulhento.
    const fonte = readFileSync(fonteDe('discover.ts'), 'utf8')
    const codigo = semComentarios(fonte)

    assert.equal(codigo.includes('stdout'), false, 'nenhuma referencia a stdout fora de comentario')
  })
})

/* ========================================================================== */
/* TUN-006 / TUN-007 / TUN-008 — o acumulador de buffer                       */
/* ========================================================================== */

describe('TUN-006 — URL partida entre dois chunks', () => {
  it('o acumulador junta os pedacos e a regex casa', async () => {
    const stderr = new PassThrough()
    const { deps } = bancada((consulta) => {
      // O `stderr` de um processo chega em pedacos definidos pelo buffer do
      // pipe, nao por linhas. Cortar a meio do hostname e o caso normal.
      if (consulta === 2) stderr.write('INF |  https://exemplo-duble-do')
      if (consulta === 4) stderr.write('-tunel.trycloudflare.com  |\n')
      return RECUSADO
    })

    const resultado = await createTunnelDiscovery(deps).discover(entrada({ stderr }))

    assert.deepEqual(resultado, { url: URL_ESPERADA, via: 'stderr' })
  })

  // NAO ha teste do `StringDecoder`, e a ausencia e deliberada. A URL e 100 %
  // ASCII: trocar o decodificador por `Buffer.toString('utf8')` so poe um
  // U+FFFD no caractere partido e a URL continua a casar. O mutante e
  // EQUIVALENTE — foi tentado pela revisao adversarial e nao ha entrada que o
  // distinga. O decodificador fica como higiene do texto a volta, declarada
  // como tal no comentario de `createStderrScanner`, e nao como garantia
  // medida. Um teste que "passasse" ali seria decoracao.

  it('o corte do buffer guarda a CAUDA: um log gigante nao apaga a URL', async () => {
    // A URL parte-se numa fronteira de chunk DEPOIS de o buffer ja ter passado
    // o tecto. Cortar pela cabeca (`slice(0, MAX)`) congela o buffer nos
    // primeiros 64 KB de ruido e descarta tudo o que vier a seguir: a URL nunca
    // fica contigua, a descoberta queima os 30 s e o supervisor vai a DEGRADED
    // com o tunel DE FACTO no ar. Alcancavel com arranque lento, com retries de
    // ligacao, ou com um `--loglevel` mais falador.
    const stderr = new PassThrough()
    const ruido = 'x'.repeat(64 * 1024)
    const { deps } = bancada((consulta) => {
      if (consulta === 2) stderr.write(`${ruido}https://parti`)
      if (consulta === 4) stderr.write('do-em-dois.trycloudflare.com  |\n')
      return RECUSADO
    })

    const resultado = await createTunnelDiscovery(deps).discover(entrada({ stderr }))

    assert.deepEqual(resultado, {
      url: 'https://partido-em-dois.trycloudflare.com',
      via: 'stderr',
    })
  })
})

describe('TUN-007 — a linha com a caixa ASCII', () => {
  it('extrai so a URL, sem barra vertical, sem espacos e sem o prefixo `INF`', async () => {
    const stderr = new PassThrough()
    stderr.write(CAIXA)
    const { deps } = bancada(() => RECUSADO)

    const { url } = await createTunnelDiscovery(deps).discover(entrada({ stderr }))

    assert.equal(url, URL_ESPERADA)
    assert.equal(/[|\s]/u.test(url), false, 'nem barra vertical nem espaco')
    assert.equal(url.includes('INF'), false)
  })
})

describe('TUN-008 — duas URLs no mesmo buffer', () => {
  it('usa a primeira e ignora as demais', async () => {
    const stderr = new PassThrough()
    stderr.write(
      `INF |  https://primeira-a-chegar.trycloudflare.com  |\n` +
        `INF |  https://segunda-a-chegar.trycloudflare.com  |\n`,
    )
    const { deps } = bancada(() => RECUSADO)

    const { url } = await createTunnelDiscovery(deps).discover(entrada({ stderr }))

    assert.equal(url, 'https://primeira-a-chegar.trycloudflare.com')
  })

  it('uma URL vista numa volta nao e substituida por outra que chegue depois', async () => {
    const stderr = new PassThrough()
    const { deps } = bancada((consulta) => {
      if (consulta === 1) {
        stderr.write('INF |  https://primeira-a-chegar.trycloudflare.com  |\n')
        stderr.write('INF |  https://segunda-a-chegar.trycloudflare.com  |\n')
      }
      return RECUSADO
    })

    const { url } = await createTunnelDiscovery(deps).discover(entrada({ stderr }))

    assert.equal(url, 'https://primeira-a-chegar.trycloudflare.com')
  })
})

/* ========================================================================== */
/* TUN-009 — o prazo                                                          */
/* ========================================================================== */

describe('TUN-009 — 30 s sem URL e sem `/quicktunnel`', () => {
  it('falha com erro TIPADO, retryable, e so depois de os 30 s virtuais passarem', async () => {
    const stderr = new PassThrough()
    const { deps, clock } = bancada(() => RECUSADO)
    const inicio = clock.now()

    const erro = await falha(createTunnelDiscovery(deps).discover(entrada({ stderr })))

    assert.equal(erro.code, 'READINESS_TIMEOUT')
    assert.equal(erro.retryable, true, 'ha orcamento: quem chama transita para DEGRADED')
    assert.equal(erro instanceof Error, true, 'e um Error de verdade, com stack')
    assert.equal(erro.name, 'TunnelError')
    assert.equal(clock.now() - inicio >= MIN_DISCOVERY_TIMEOUT_MS, true)
    // O ciclo nao pode passar MUITO do prazo: uma volta de folga, no maximo.
    assert.equal(clock.now() - inicio <= MIN_DISCOVERY_TIMEOUT_MS + INTERVALO, true)
  })

  it('a mensagem e accionavel e nao carrega segredo, caminho nem URL', async () => {
    const { deps } = bancada(() => RECUSADO)
    const erro = await falha(createTunnelDiscovery(deps).discover(entrada()))

    assert.equal(erro.message.includes('trycloudflare'), false)
    assert.equal(erro.message.includes('https://'), false)
    assert.equal(erro.message.includes('/home/'), false)
    assert.equal(/\/[a-z]+\/[a-z]/u.test(erro.message), false, 'nenhum caminho absoluto')
    assert.equal(erro.message.includes('Confirme'), true, 'diz o que FAZER, nao so o que falhou')
  })

  it('um `stderr` que rebenta NAO e engolido: o motivo entra na mensagem', async () => {
    // A metade da mensagem que so existe quando o proprio fluxo falhou. Sem
    // este teste ela nunca era renderizada — e as asercoes de "sem segredo, sem
    // caminho" acima nem sequer chegavam a ver esse texto.
    const stderr = new PassThrough()
    const { deps } = bancada((consulta) => {
      if (consulta === 2) {
        const rebentou: NodeJS.ErrnoException = new Error('cano partido')
        rebentou.code = 'EPIPE'
        stderr.destroy(rebentou)
      }
      return RECUSADO
    })

    const erro = await falha(createTunnelDiscovery(deps).discover(entrada({ stderr })))

    assert.equal(erro.code, 'READINESS_TIMEOUT')
    assert.equal(erro.message.includes('EPIPE'), true, 'o motivo medido do fluxo sobe a mensagem')
    assert.equal(erro.message.includes('leitura por log'), true)
    // A metade nova obedece as MESMAS regras da outra metade.
    assert.equal(erro.message.includes('trycloudflare'), false)
    assert.equal(erro.message.includes('cano partido'), false, 'a `message` do erro nao entra')
    assert.equal(/\/[a-z]+\/[a-z]/u.test(erro.message), false, 'nenhum caminho absoluto')
  })
})

/* ========================================================================== */
/* TUN-010 — o processo morre a meio                                          */
/* ========================================================================== */

describe('TUN-010 — processo morre DURANTE o warmup', () => {
  it('aborta de imediato no `signal`, sem esperar o prazo inteiro', async () => {
    const controlador = new AbortController()
    const { deps, clock } = bancada((consulta) => {
      if (consulta === 3) controlador.abort()
      return RECUSADO
    })
    const inicio = clock.now()

    const erro = await falha(
      createTunnelDiscovery(deps).discover(entrada({ signal: controlador.signal })),
    )

    assert.equal(erro.code, 'PROCESS_EXITED')
    assert.equal(erro.retryable, true)
    // A prova falsificavel: o relogio VIRTUAL mal andou. Uma implementacao que
    // ignorasse o `signal` chegaria aos 30 000 ms antes de desistir.
    const decorrido = clock.now() - inicio
    assert.equal(decorrido < MIN_DISCOVERY_TIMEOUT_MS, true, `decorrido=${String(decorrido)}`)
    assert.equal(decorrido <= 3 * INTERVALO, true, `decorrido=${String(decorrido)}`)
  })

  it('morrer DURANTE a sondagem nao devolve a URL que ja estava no log', async () => {
    // O caso discriminante da verificacao de aborto que corre LOGO A SEGUIR ao
    // `await` da sondagem. Sem ela, o ciclo seguia para a leitura do `stderr`,
    // encontrava lixo residual de um tunel que ja nao existe, e devolvia uma
    // URL — que o supervisor publicaria como `READY`, porque e isso que o
    // contrato manda fazer em `READY`. Um endereco morto divulgado com toda a
    // confianca.
    const controlador = new AbortController()
    const stderr = new PassThrough()
    const { deps } = bancada((consulta) => {
      if (consulta !== 1) return RECUSADO
      // A URL ENTRA no acumulador (um `PassThrough` em modo fluente entrega o
      // chunk de forma SINCRONA dentro do `write`) e, na mesma volta, o
      // processo morre. E este o unico arranjo que distingue a verificacao de
      // aborto pos-sondagem: se ela nao existir, a leitura do `stderr` logo a
      // seguir encontra a URL e devolve-a.
      stderr.write(CAIXA)
      controlador.abort()
      return RECUSADO
    })

    const erro = await falha(
      createTunnelDiscovery(deps).discover(entrada({ stderr, signal: controlador.signal })),
    )

    assert.equal(erro.code, 'PROCESS_EXITED')
  })

  it('um `signal` ja abortado a entrada nem chega a consultar o endpoint', async () => {
    const controlador = new AbortController()
    controlador.abort()
    const { deps, consultas } = bancada(() => RECUSADO)

    const erro = await falha(
      createTunnelDiscovery(deps).discover(entrada({ signal: controlador.signal })),
    )

    assert.equal(erro.code, 'PROCESS_EXITED')
    assert.equal(consultas(), 0)
  })

  it('uma falha da espera que NAO e aborto sobe intacta, nunca engolida', async () => {
    const clock = new FakeClock(0)
    const explosao = new Error('defeito de programacao na espera')
    const deps: DiscoveryDeps = {
      now: () => clock.now(),
      sleep: () => Promise.reject(explosao),
      probeQuickTunnel: () => Promise.resolve(RECUSADO),
      pollIntervalMs: INTERVALO,
      attemptTimeoutMs: 2000,
    }

    await assert.rejects(createTunnelDiscovery(deps).discover(entrada()), (error: unknown) => {
      assert.equal(error, explosao)
      return true
    })
  })
})

/* ========================================================================== */
/* TUN-011 (a metade de T3.2) e o prazo minimo — validacao de fronteira        */
/* ========================================================================== */

describe('a porta de metricas e FIXADA por quem chama, nunca adivinhada', () => {
  it('recusa porta em falta ou fora de faixa em vez de tentar 20241-20245', async () => {
    const { deps, consultas } = bancada(() => respostaComHostname(HOSTNAME))

    for (const porta of [0, -1, 1.5, 70_000, Number.NaN]) {
      const erro = await falha(
        createTunnelDiscovery(deps).discover(entrada({ metricsPort: porta })),
      )
      assert.equal(erro.code, 'INVALID_CONFIG')
      assert.equal(erro.retryable, false, 'tentar de novo com a mesma porta e o mesmo erro')
    }
    assert.equal(consultas(), 0, 'nao chegou a bater em porta nenhuma')
  })

  it('bate SO na porta que lhe foi dada — nunca varre a faixa 20241-20245', async () => {
    // A doc afirma a faixa; o binario 2026.7.3 afirma `localhost:0`, ou seja
    // porta ALEATORIA. Duas fontes, duas afirmacoes incompativeis, e a porta e
    // ainda disputada entre instancias — um segundo tunel na mesma maquina
    // desloca-a em silencio. Adivinhar entrega a URL do tunel ERRADO, que e uma
    // falha pior do que nao entregar nenhuma.
    //
    // Asercao COMPORTAMENTAL e nao um `grep` ao fonte: e a lista de portas
    // realmente consultadas que falsifica o mutante "se a fixa falhar, tenta a
    // faixa".
    const { deps, portas } = bancada(() => RECUSADO)
    await falha(createTunnelDiscovery(deps).discover(entrada()))

    assert.equal(portas().length > 1, true, 'houve mesmo varias voltas')
    assert.deepEqual([...new Set(portas())], [PORTA_DE_METRICAS])
  })
})

describe('o prazo de descoberta tem piso e tem de ser finito', () => {
  it('recusa prazo abaixo de 30 s, e NUNCA o eleva em silencio', async () => {
    const { deps } = bancada(() => respostaComHostname(HOSTNAME))

    for (const timeoutMs of [0, 1000, MIN_DISCOVERY_TIMEOUT_MS - 1]) {
      const erro = await falha(createTunnelDiscovery(deps).discover(entrada({ timeoutMs })))
      assert.equal(erro.code, 'INVALID_CONFIG')
    }
  })

  it('recusa `Infinity` — o prazo que nunca chega e o mutante M-32', async () => {
    const { deps } = bancada(() => RECUSADO)
    const erro = await falha(
      createTunnelDiscovery(deps).discover(entrada({ timeoutMs: Number.POSITIVE_INFINITY })),
    )

    assert.equal(erro.code, 'INVALID_CONFIG')
  })
})

/* ========================================================================== */
/* TUN-015 — a URL nunca e persistida por este modulo                         */
/* ========================================================================== */

describe('TUN-015 — a URL do tunel nunca e escrita em disco por T3.2', () => {
  it('nem `discover.ts` nem `readiness.ts` tocam no sistema de ficheiros ou no estado', () => {
    // Ela muda a cada arranque: um valor velho lido do disco entrega um link
    // MORTO com toda a confianca. O que se persiste e `pid` + `startedAt`.
    for (const ficheiro of ['discover.ts', 'readiness.ts']) {
      const codigo = semComentarios(readFileSync(fonteDe(ficheiro), 'utf8'))

      assert.equal(codigo.includes('node:fs'), false, `${ficheiro} importa node:fs`)
      assert.equal(codigo.includes('writeFile'), false, `${ficheiro} escreve ficheiro`)
      assert.equal(codigo.includes('../state/'), false, `${ficheiro} fala com o estado`)
      assert.equal(codigo.includes('state/store'), false, `${ficheiro} fala com o estado`)
    }
  })
})

/* ========================================================================== */
/* Utilitarios de asercao sobre o fonte                                       */
/* ========================================================================== */

function fonteDe(nome: string): string {
  return fileURLToPath(new URL(`../../../src/tunnel/${nome}`, import.meta.url))
}

/**
 * Tira comentarios de bloco e de linha.
 *
 * Sem isto, as asercoes de TUN-005 e TUN-015 falhavam por causa das NOTAS que
 * explicam precisamente porque e que aquelas coisas nao podem existir — e a
 * reaccao natural seria apagar a nota, que e o unico sitio onde o facto medido
 * esta escrito.
 */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

