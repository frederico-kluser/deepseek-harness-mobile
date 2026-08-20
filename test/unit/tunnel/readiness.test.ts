/**
 * =============================================================================
 * `src/tunnel/readiness.ts` — TUN-012 e a FRONTEIRA de `04-TESTES.md` 5.4.2.
 * =============================================================================
 *
 * O QUE ESTA SUITE EXISTE PARA IMPEDIR, e nao e o que parece a primeira vista:
 *
 * A tentacao natural, ao escrever readiness, e fazer dele um segundo probe de
 * seguranca — "so digo que esta pronto se responder 401". Parece uma rede a
 * mais de graca. Nao e. O readiness corre DEPOIS de o tunel subir: quando ele
 * observa um `200` anonimo, a aplicacao JA ESTA exposta na internet ha
 * segundos. Foi precisamente essa confusao que expos o DSH real do utilizador
 * durante cerca de 40 s na pesquisa que originou este plugin.
 *
 *     "a aplicacao responde"  !=  "a aplicacao responde 401 a quem nao tem
 *                                  credencial"
 *
 * Quem recusa o `200` anonimo e o probe fail-closed de T3.1
 * (`src/tunnel/probe.ts`, TUN-020..025), ANTES de existir tunel nenhum. Por
 * isso ha aqui um teste que assere, de forma deliberada e contra-intuitiva, que
 * um `200` conta como PRONTO — ele e o que impede alguem de mover a
 * verificacao de seguranca para depois da exposicao.
 *
 * Nenhum teste espera tempo real; o relogio e o `FakeClock` congelado.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TunnelError, type HttpProbe } from '../../../src/tunnel/discover.ts'
import {
  createTunnelReadiness,
  isApplicationResponse,
  MAX_READINESS_TIMEOUT_MS,
  type ReadinessDeps,
} from '../../../src/tunnel/readiness.ts'
import { FakeClock } from '../../support/clock.ts'

/* ========================================================================== */
/* Apoio                                                                      */
/* ========================================================================== */

const URL_DO_TUNEL = 'https://exemplo-duble-do-tunel.trycloudflare.com'
const INTERVALO = 500
const PRAZO = 30_000

interface Bancada {
  readonly deps: ReadinessDeps
  readonly clock: FakeClock
  readonly sondagens: () => number
  readonly alvos: () => readonly string[]
}

function bancada(sondar: (sondagem: number) => HttpProbe): Bancada {
  const clock = new FakeClock(1_700_000_000_000)
  const alvos: string[] = []
  let sondagens = 0

  const deps: ReadinessDeps = {
    now: () => clock.now(),
    sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
      clock.advance(ms)
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      if (signal.aborted) throw new Error('espera abortada')
    },
    probeUrl: (target: URL): Promise<HttpProbe> => {
      sondagens += 1
      alvos.push(target.toString())
      return Promise.resolve(sondar(sondagens))
    },
    pollIntervalMs: INTERVALO,
    attemptTimeoutMs: 5000,
  }

  return { deps, clock, sondagens: () => sondagens, alvos: () => alvos }
}

const resposta = (status: number): HttpProbe => ({ kind: 'response', status, body: '' })
/** Socket que nunca produz resposta HTTP nenhuma: porta aberta, app calada. */
const SEM_RESPOSTA: HttpProbe = { kind: 'unreachable', reason: 'ETIMEDOUT' }

function esperar(deps: ReadinessDeps, signal: AbortSignal, timeoutMs = PRAZO): Promise<{
  usable: boolean
  status: number | null
}> {
  return createTunnelReadiness(deps).waitUntilUsable({ url: URL_DO_TUNEL, signal, timeoutMs })
}

const semAborto = (): AbortSignal => new AbortController().signal

/* ========================================================================== */
/* TUN-012 — a URL so e utilizavel depois de o readiness confirmar            */
/* ========================================================================== */

describe('TUN-012 — porta aberta NAO e aplicacao pronta', () => {
  it('um socket que aceita a ligacao e nunca responde NAO conta como pronto', async () => {
    // Este e o caso que da nome a regra. A borda da Cloudflare aceita a
    // ligacao muito antes de o conector estar registado; declarar pronto ai
    // entrega ao dono um link que falha na primeira tentativa dele.
    const { deps, clock } = bancada(() => SEM_RESPOSTA)
    const inicio = clock.now()

    const resultado = await esperar(deps, semAborto())

    assert.deepEqual(resultado, { usable: false, status: null })
    // `status: null` e a afirmacao exacta: nao houve codigo NENHUM para
    // mostrar, e o contrato obriga quem chama a distinguir isso de um `502`.
    assert.equal(clock.now() - inicio >= PRAZO, true)
  })

  it('insiste enquanto a borda devolve 502/503 e so declara pronto quando a app responde', async () => {
    const { deps, sondagens } = bancada((sondagem) => {
      if (sondagem <= 2) return resposta(503)
      if (sondagem <= 4) return resposta(502)
      return resposta(401)
    })

    const resultado = await esperar(deps, semAborto())

    assert.deepEqual(resultado, { usable: true, status: 401 })
    assert.equal(sondagens(), 5)
  })

  it('esgotado o prazo, devolve o ULTIMO codigo observado em vez de o apagar', async () => {
    // "Ficou preso em 530" e informacao operacional; `null` deitava fora a
    // unica pista que o dono tem para perceber que o tunel nao registou.
    const { deps } = bancada(() => resposta(530))

    assert.deepEqual(await esperar(deps, semAborto()), { usable: false, status: 530 })
  })

  it('so bate no endereco que lhe foi dado', async () => {
    const { deps, alvos } = bancada(() => resposta(401))
    await esperar(deps, semAborto())

    assert.deepEqual([...new Set(alvos())], [`${URL_DO_TUNEL}/`])
  })
})

/* ========================================================================== */
/* A FRONTEIRA — readiness NAO e o probe de seguranca                         */
/* ========================================================================== */

describe('readiness responde "ja responde?", nunca "responde 401?"', () => {
  it('401 conta como PRONTO — e o caso normal, porque o portao esta armado', () => {
    assert.equal(isApplicationResponse(401), true)
  })

  it('200 TAMBEM conta como pronto, e isto e deliberado', () => {
    // Contra-intuitivo de proposito. Um `200` anonimo E um problema grave — mas
    // quando este modulo o observa, o tunel JA esta no ar e a fuga JA aconteceu.
    // Quem tem de recusar um `200` anonimo e o probe fail-closed de T3.1, ANTES
    // do arranque do tunel. Exigir `401` aqui daria a ilusao de rede dupla e
    // mudava a verificacao de seguranca para DEPOIS da exposicao — que e
    // exactamente o defeito que ja expos o DSH real.
    assert.equal(isApplicationResponse(200), true)
  })

  it('403, 404 e 500 contam como pronto: foi a APLICACAO que os produziu', () => {
    for (const status of [403, 404, 405, 418, 500, 501]) {
      assert.equal(isApplicationResponse(status), true, `status ${String(status)}`)
    }
  })

  it('os codigos que a BORDA devolve enquanto o conector nao registou NAO contam', () => {
    // 530 e o classico "Argo Tunnel error 1033": hostname na borda, nada do
    // outro lado. 503 e tambem o que o `/ready` do cloudflared devolve enquanto
    // `readyConnections` for 0.
    for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) {
      assert.equal(isApplicationResponse(status), false, `status ${String(status)}`)
    }
  })

  it('um codigo que nao e HTTP nao conta', () => {
    for (const status of [0, 99, 600]) {
      assert.equal(isApplicationResponse(status), false, `status ${String(status)}`)
    }
  })

  it('as quatro sondas do probe fail-closed nao existem aqui — este modulo nao as duplica', async () => {
    const fonte = await lerFonte('readiness.ts')

    for (const sonda of ['spa-fallback', 'api-rpc', 'websocket-upgrade', 'unguarded-canary']) {
      assert.equal(fonte.includes(sonda), false, `readiness.ts duplica a sonda ${sonda}`)
    }
    // Nem sequer ha uma comparacao com 401 no codigo: se houvesse, era a
    // assinatura do probe de seguranca a migrar para o sitio errado.
    assert.equal(semComentarios(fonte).includes('401'), false)
  })
})

/* ========================================================================== */
/* Aborto — o processo morreu, nao ha nada a esperar                          */
/* ========================================================================== */

describe('aborto durante a espera', () => {
  it('devolve `usable: false` de imediato, sem consumir o prazo inteiro', async () => {
    const controlador = new AbortController()
    const { deps, clock } = bancada((sondagem) => {
      if (sondagem === 2) controlador.abort()
      return resposta(503)
    })
    const inicio = clock.now()

    const resultado = await esperar(deps, controlador.signal)

    assert.equal(resultado.usable, false)
    assert.equal(resultado.status, 503, 'o ultimo codigo observado sobrevive ao aborto')
    const decorrido = clock.now() - inicio
    assert.equal(decorrido < PRAZO, true, `decorrido=${String(decorrido)}`)
  })

  it('morrer DURANTE uma sondagem UTILIZAVEL nao declara o tunel pronto', async () => {
    // O caso discriminante da verificacao de aborto que corre LOGO A SEGUIR ao
    // `await` da sondagem. O teste vizinho aborta numa volta que devolve `502`
    // e por isso NAO distingue nada: o ciclo sairia na mesma pelo `catch` da
    // espera. Aqui a volta abortada devolve `401` — um estado UTILIZAVEL. Sem
    // a verificacao, o ciclo aceitava-o e o supervisor transitava para `READY`
    // sobre um processo que ja morreu, divulgando a URL de um tunel morto.
    const controlador = new AbortController()
    const { deps } = bancada((sondagem) => {
      if (sondagem === 1) return resposta(503)
      controlador.abort()
      return resposta(401)
    })

    const resultado = await esperar(deps, controlador.signal)

    assert.deepEqual(resultado, { usable: false, status: 503 })
  })

  it('um `signal` ja abortado a entrada nem chega a sondar', async () => {
    const controlador = new AbortController()
    controlador.abort()
    const { deps, sondagens } = bancada(() => resposta(401))

    assert.deepEqual(await esperar(deps, controlador.signal), { usable: false, status: null })
    assert.equal(sondagens(), 0)
  })

  it('uma falha da espera que NAO e aborto sobe intacta, nunca engolida', async () => {
    const clock = new FakeClock(0)
    const explosao = new Error('defeito de programacao na espera')
    const deps: ReadinessDeps = {
      now: () => clock.now(),
      sleep: () => Promise.reject(explosao),
      probeUrl: () => Promise.resolve(resposta(503)),
      pollIntervalMs: INTERVALO,
      attemptTimeoutMs: 5000,
    }

    await assert.rejects(esperar(deps, semAborto()), (error: unknown) => {
      assert.equal(error, explosao)
      return true
    })
  })
})

/* ========================================================================== */
/* Validacao de fronteira                                                     */
/* ========================================================================== */

describe('validacao de fronteira', () => {
  it('recusa endereco que nao e absoluto ou que nao e HTTP(S) — e nao o repete na mensagem', async () => {
    const { deps } = bancada(() => resposta(401))
    const readiness = createTunnelReadiness(deps)

    for (const url of ['', 'exemplo.trycloudflare.com', 'ftp://exemplo.trycloudflare.com']) {
      const erro = await falha(
        readiness.waitUntilUsable({ url, signal: semAborto(), timeoutMs: PRAZO }),
      )
      assert.equal(erro.code, 'INVALID_CONFIG')
      assert.equal(erro.retryable, false)
      // A URL nunca entra na mensagem: ela viaja para o painel e para o
      // Telegram, e um endereco de tunel ali e divulgacao.
      assert.equal(erro.message.includes('trycloudflare'), false)
      assert.equal(erro.message.includes(url) && url !== '', false)
    }
  })

  it('RECUSA endereco com credencial embutida — e nao a repete na mensagem', async () => {
    // DEFEITO DE PRODUCAO apanhado pela revisao adversarial. `http.request`
    // copia `username`/`password` de um `URL` para `options.auth` e transforma
    // isso num cabecalho `Authorization: Basic` sem avisar. Como esta sondagem
    // corre em ciclo, o segredo ia para a borda ate 1200 vezes por sessao.
    //
    // O caminho E alcancavel em producao: em `tunnel.mode: 'named'` a URL vem
    // do dominio do utilizador, por configuracao de T3.3, e NUNCA passa por
    // `discover()` — a invariante de `discover()` nao cobre esse caso.
    const { deps, sondagens } = bancada(() => resposta(401))
    const readiness = createTunnelReadiness(deps)

    for (const url of [
      'https://dono:senha-do-dono@exemplo.trycloudflare.com',
      'https://dono@exemplo.trycloudflare.com',
      'https://:senha-do-dono@exemplo.trycloudflare.com',
    ]) {
      const erro = await falha(
        readiness.waitUntilUsable({ url, signal: semAborto(), timeoutMs: PRAZO }),
      )
      assert.equal(erro.code, 'INVALID_CONFIG')
      assert.equal(erro.retryable, false)
      // RECUSAR e nao limpar em silencio: quem configurou a credencial tem de
      // saber que foi ignorada. E a mensagem nao pode repetir o segredo.
      assert.equal(erro.message.includes('senha-do-dono'), false)
      assert.equal(erro.message.includes('trycloudflare'), false)
    }
    assert.equal(sondagens(), 0, 'nao chegou a sair pedido nenhum')
  })

  it('recusa prazo infinito, nulo ou negativo — o mutante M-32', async () => {
    const { deps } = bancada(() => SEM_RESPOSTA)
    const readiness = createTunnelReadiness(deps)

    for (const timeoutMs of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      0,
      -1,
      1.5,
      MAX_READINESS_TIMEOUT_MS + 1,
    ]) {
      const erro = await falha(
        readiness.waitUntilUsable({ url: URL_DO_TUNEL, signal: semAborto(), timeoutMs }),
      )
      assert.equal(erro.code, 'INVALID_CONFIG')
    }
  })

  it('o erro e um `Error` de verdade com codigo estavel, nao uma string lancada', async () => {
    const { deps } = bancada(() => resposta(401))
    const erro = await falha(
      createTunnelReadiness(deps).waitUntilUsable({
        url: 'nao-e-url',
        signal: semAborto(),
        timeoutMs: PRAZO,
      }),
    )

    assert.equal(erro instanceof Error, true)
    assert.equal(erro.name, 'TunnelError')
    assert.equal(typeof erro.stack, 'string')
  })
})

/* ========================================================================== */
/* Utilitarios                                                                */
/* ========================================================================== */

async function falha(promessa: Promise<unknown>): Promise<TunnelError> {
  try {
    await promessa
  } catch (error) {
    assert.ok(error instanceof TunnelError, `esperava TunnelError, veio ${String(error)}`)
    return error
  }
  throw new Error('a promessa resolveu quando devia ter falhado')
}

async function lerFonte(nome: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  return await readFile(fileURLToPath(new URL(`../../../src/tunnel/${nome}`, import.meta.url)), 'utf8')
}

function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}
