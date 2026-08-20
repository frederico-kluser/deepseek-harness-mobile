/**
 * =============================================================================
 * O 401 DO GATE E O 401 DO PAINEL SAO O MESMO 401 -- BYTE A BYTE.
 * =============================================================================
 *
 * PORQUE ISTO E SEGURANCA E NAO ESTETICA. O painel e o unico componente deste
 * sistema alcancavel da internet sem credencial. Se o 401 dele se distinguisse
 * -- um cabecalho a mais, uma virgula no corpo, um `Content-Length` diferente --
 * um scanner anonimo passava a saber QUAL caminho e painel e qual e o resto do
 * DSH, sem nunca autenticar. Isso e enumeracao da superficie, e e exatamente o
 * que a reutilizacao de `challengeBasicAuth` (`src/http/responses.ts`) compra.
 *
 * ESTA SUITE EXISTE POR CAUSA DA EMENDA 5 DA COSTURA. `challengeBasicAuth` nao
 * emitia `Referrer-Policy: no-referrer`; T3.4 reparou, e em vez de o acrescentar
 * so do lado do painel -- o que teria QUEBRADO esta igualdade -- deixou o caso
 * de PANEL-010 a excluir a asercao e reportou. O cabecalho foi acrescentado na
 * funcao partilhada, ou seja nos dois lados de uma vez; esta suite e a prova de
 * que a igualdade sobreviveu a mudanca, e o travao para a proxima.
 *
 * O `Date` E RETIRADO DOS DOIS LADOS, e nada mais. Ele e emitido pelo
 * `node:http`, muda a cada segundo e nao participa de decisao nenhuma -- a
 * bancada do painel ja o desliga com `res.sendDate = false`, e do lado do gate
 * nao ha onde o desligar (a barreira e dona do despacho e responde antes de
 * qualquer listener nosso tocar no `ServerResponse`). Compara-lo era transformar
 * "byte a byte" numa asercao sobre o relogio.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { UNAUTHENTICATED_PANEL_PREFIXES } from '../../src/index.ts'
import { PANEL_PATH_ROOT } from '../../src/panel/routes.ts'
import { bancada, type Bancada } from '../unit/http/bancada.ts'
import { criarBancada, getCru, pedirCru, type Bancada as BancadaPainel } from '../unit/panel/harness.ts'

let b: Bancada
let painel: BancadaPainel
let servidorDoGate: Server
let portaDoGate = 0
let portaDoPainel = 0
let reverter: (() => void) | undefined

/** O hostname do tunel publicado pela bancada (`FAKE_TUNNEL_ORIGIN`). */
const HOST_DO_TUNEL = 'marks-organization-moved-coupons.trycloudflare.com'

/** Retira SO a linha `Date:`. Ver o cabecalho. */
function semData(bruta: string): string {
  return bruta
    .split('\r\n')
    .filter((linha) => !/^date:/iu.test(linha))
    .join('\r\n')
}

before(async () => {
  servidorDoGate = createServer()
  // O "resto do DSH" por baixo da barreira. Nunca alcancado nestes casos.
  servidorDoGate.on('request', (_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  // Sem um listener de `upgrade` a barreira nao tem despacho de handshake a
  // tomar, e `denyUpgrade` nunca correria.
  servidorDoGate.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
  })
  await new Promise<void>((resolve) => servidorDoGate.listen(0, '127.0.0.1', resolve))
  portaDoGate = (servidorDoGate.address() as AddressInfo).port

  b = bancada({
    comSegredo: true,
    // Com a origem do tunel publicada, um pedido com o `Host` do tunel PASSA
    // L2.5 e chega a L2.6 -- que e como se alcanca o 404 de CANAL LOCAL APENAS
    // escrito por `denyNotFound`. Sem isto o pedido morria no 403 do perimetro.
    tunnelReady: true,
    loopbackAuthority: `127.0.0.1:${String(portaDoGate)}`,
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
  })
  reverter = installAuthBarrier(
    servidorDoGate,
    {
      wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'sec:401'),
      wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'sec:401:upgrade'),
    },
    b.gate.log,
  )

  painel = criarBancada({ comSegredo: true })
  portaDoPainel = await painel.servir()
})

after(async () => {
  reverter?.()
  b.cleanup()
  await painel.fechar()
  await new Promise<void>((resolve) => servidorDoGate.close(() => resolve()))
})

describe('EMENDA 5: o desafio 401 e o mesmo dos dois lados', () => {
  it('gate e painel devolvem bytes IDENTICOS (excepto `Date`)', async () => {
    const doGate = await pedirCru(portaDoGate, getCru('/api/state'))
    const doPainel = await pedirCru(portaDoPainel, getCru(PANEL_PATH_ROOT))

    assert.match(doGate, /^HTTP\/1\.1 401 Unauthorized\r\n/u)
    assert.match(doPainel, /^HTTP\/1\.1 401 Unauthorized\r\n/u)
    assert.equal(semData(doPainel), semData(doGate))
  })

  it('e os dois levam `Referrer-Policy: no-referrer`', async () => {
    // Sem ele, uma pagina servida sob a URL do tunel que carregue QUALQUER
    // recurso externo leva essa URL no `Referer` para o log do destino -- e a
    // URL do quick tunnel nao e um endereco, e a capacidade. O painel prova que
    // nao carrega nada de fora (CSP `default-src 'none'`); o fallback da SPA do
    // DSH, que este 401 tambem cobre, nao e nosso e nao traz essa garantia.
    for (const bruta of [
      await pedirCru(portaDoGate, getCru('/api/state')),
      await pedirCru(portaDoPainel, getCru(PANEL_PATH_ROOT)),
    ]) {
      assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
      assert.match(bruta, /^www-authenticate: Basic realm="[^"]+", charset="UTF-8"\r$/imu)
      assert.match(bruta, /^cache-control: no-store\r$/imu)
    }
  })
})

/* ========================================================================== */
/* DEFEITO 3 -- A REGRA passou a ser de FICHEIRO: TODA recusa leva o cabecalho */
/* ========================================================================== */

/**
 * `src/http/responses.ts` escreve QUATRO recusas. Antes desta costura so o 401
 * levava `Referrer-Policy`, e as outras tres nao -- o que obrigava a proxima
 * pessoa a descobrir qual das duas convencoes seguir. Agora a regra e do
 * ficheiro inteiro.
 *
 * PORQUE VALE PARA AS QUATRO: qualquer uma pode ser servida SOB A URL DO TUNEL,
 * e essa URL nao e um endereco -- e a capacidade de alcancar a barreira.
 */
describe('DEFEITO 3: as quatro recusas de `responses.ts` levam `Referrer-Policy`', () => {
  it('403 de origem nao confiada (`denyUntrustedOrigin`)', async () => {
    const bruta = await pedirCru(
      portaDoGate,
      'POST /api/state HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n',
    )
    assert.match(bruta, /^HTTP\/1\.1 403 Forbidden\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
  })

  it('404 de CANAL LOCAL APENAS (`denyNotFound`), alcancado pelo tunel', async () => {
    const bruta = await pedirCru(
      portaDoGate,
      `GET /__guard/secret HTTP/1.1\r\nHost: ${HOST_DO_TUNEL}\r\nConnection: close\r\n\r\n`,
    )
    assert.match(bruta, /^HTTP\/1\.1 404 Not Found\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
  })

  it('401 do handshake de WebSocket (`denyUpgrade`), escrito no socket cru', async () => {
    const bruta = await pedirCru(
      portaDoGate,
      'GET /api/events.mux HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
    assert.match(bruta, /^HTTP\/1\.1 401 Unauthorized\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
    assert.equal(bruta.includes('101 Switching Protocols'), false, 'o handshake NAO pode subir')
  })

  it('403 do handshake (`denyUpgrade`), e SEM `WWW-Authenticate`', async () => {
    // Um 403 que desafia credencial e o oraculo que a ordem 403-antes-de-401
    // fecha; o cabecalho novo nao pode ter aberto um segundo canal de informacao.
    const bruta = await pedirCru(
      portaDoGate,
      'GET /api/events.mux HTTP/1.1\r\nHost: evil.com\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
    assert.match(bruta, /^HTTP\/1\.1 403 Forbidden\r\n/u)
    assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
    assert.equal(/^www-authenticate:/imu.test(bruta), false)
  })
})

/**
 * =============================================================================
 * O PAR DOS DOIS 404 -- IDENTIDADE EXIGIDA, ja nao documentada.
 * =============================================================================
 * `denyNotFound` sempre AFIRMOU, no seu proprio JSDoc, que ha dois sitios que
 * "tem de devolver exatamente estes bytes": `/__guard/secret` com `ott` invalido
 * (escrito pelo PAINEL, num envelope `PanelResponse`) e `/__guard/secret`
 * alcancado por canal NAO-LOCAL (escrito pelo PORTAO, direto no
 * `ServerResponse`). A medicao no fio mostrou que nao devolviam: o do painel
 * levava `x-content-type-options: nosniff` a mais, e os nomes dos cabecalhos
 * iam em caixas diferentes.
 *
 * >>> O DEFEITO ERA A AFIRMACAO, MAIS DO QUE O ORACULO. <<< Os dois caminhos sao
 * DISJUNTOS -- pelo tunel bate-se sempre na camada de canal-local-apenas, pelo
 * loopback chega-se sempre a rota --, logo o mesmo atacante dificilmente compara
 * os dois. A propriedade que protege o segredo e a que T3.4 pregou e que nunca
 * esteve em causa: o 404 de `ott` invalido e byte a byte o de rota inexistente,
 * ambos do MESMO lado (PANEL-003/PANEL-004). O que envenena a revisao seguinte e
 * um comentario a prometer o que o codigo nao faz -- foi a falha que esta onda
 * encontrou vezes de mais, e quem le acredita.
 *
 * Agora a igualdade e POR CONSTRUCAO: os dois montam a resposta a partir de
 * `TEXT_REFUSAL_HEADERS` e `NOT_FOUND_BODY`, declarados uma unica vez. Este caso
 * EXIGE-A, para que voltar a divergir custe um teste vermelho e nao uma leitura
 * atenta.
 */
describe('os dois 404 de `/__guard/secret` sao o MESMO 404', () => {
  const doGate = (): Promise<string> =>
    pedirCru(
      portaDoGate,
      `GET /__guard/secret HTTP/1.1\r\nHost: ${HOST_DO_TUNEL}\r\nConnection: close\r\n\r\n`,
    )
  const doPainel = (): Promise<string> => pedirCru(portaDoPainel, getCru('/__guard/secret'))

  it('portao e painel devolvem bytes IDENTICOS (excepto `Date`)', async () => {
    const gate = await doGate()
    const painelBruto = await doPainel()

    assert.match(gate, /^HTTP\/1\.1 404 Not Found\r\n/u)
    assert.match(painelBruto, /^HTTP\/1\.1 404 Not Found\r\n/u)
    // A ASERCAO INTEIRA, e nao "o corpo bate e os cabecalhos quase": um
    // cabecalho a mais num deles e o que distingue "esta rota nao existe" de
    // "esta rota existe e voce veio do sitio errado".
    assert.equal(semData(painelBruto), semData(gate))
  })

  it('e os dois levam os quatro cabecalhos da regra do ficheiro', async () => {
    for (const bruta of [await doGate(), await doPainel()]) {
      assert.match(bruta, /^content-type: text\/plain; charset=utf-8\r$/imu)
      assert.match(bruta, /^cache-control: no-store\r$/imu)
      assert.match(bruta, /^referrer-policy: no-referrer\r$/imu)
      assert.match(bruta, /^x-content-type-options: nosniff\r$/imu)
      // E nenhum enumera nada: PANEL-010 vale para os dois lados.
      assert.equal(/^server:/imu.test(bruta), false)
      assert.equal(bruta.includes('dsh-guarded-bot-orchestrator'), false)
    }
  })
})
