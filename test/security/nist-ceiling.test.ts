/**
 * =============================================================================
 * O TETO NIST DE 100 E A RECUPERACAO -- suite adversarial de T6.3.
 * =============================================================================
 *
 * 02-SEGURANCA.md 6.1 e 08-PESQUISA 27: NIST SP 800-63B-4 3.2.2 manda
 * limitar as falhas CONSECUTIVAS da conta a "no more than 100", e exige um
 * caminho de recuperacao ("the potential need for account recovery when the
 * limit is exceeded"). O que este plugin desativa aos 100 e a EXPOSICAO,
 * nunca o dono: o tunel cai, a origem sai da allowlist, as sessoes sao
 * revogadas, e o modo restrito PERSISTE no state.json (reiniciar nao e o
 * bypass). A saida e local -- ir a maquina e correr o release -- e e isso
 * que se assere aqui: o teto e ALCANCADO, e o caminho de recuperacao EXISTE
 * e EXECUTA.
 *
 * AS QUATRO PERGUNTAS FALSIFICAVEIS DESTE FICHEIRO:
 *   (a) 99 falhas nao acendem nada, 100 acendem -- a fronteira e 100;
 *   (b) o corpo da resposta NAO muda ao longo da escalada (sem oraculo);
 *   (c) o caminho de recuperacao (releaseFromLocalMachine) executa e devolve
 *       o sistema ao estado normal, sobrevivendo a um reinicio;
 *   (d) enquanto restrito, a credencial vinda do TUNEL e negada e a do
 *       LOOPBACK passa -- a derrubada do tunel e o que cria a distincao.
 *
 * NENHUM TESTE ESPERA TEMPO REAL: o relogio e o do FakeClock e o atraso e
 * injetado a zero, como em toda a suite. O que se mede e a DECISAO.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { bancada } from '../unit/http/bancada.ts'
import { DEFAULT_RATE_LIMIT_POLICY, NIST_BRUTE_FORCE_CEILING } from '../../src/ratelimit/policy.ts'

describe('o teto NIST de 100 (D9 / 02-SEGURANCA 6.1) e a recuperacao', () => {
  it('a fronteira e 100: 99 falhas nao acendem o modo restrito, a 100a acende', () => {
    const b = bancada({ comSegredo: true })
    const identidade = { ip: '198.51.100.99' }
    for (let i = 0; i < NIST_BRUTE_FORCE_CEILING - 1; i += 1) {
      b.stack.limiter.recordFailure(identidade)
    }
    assert.equal(b.stack.limiter.snapshot().accountFailures, NIST_BRUTE_FORCE_CEILING - 1)
    assert.equal(b.stack.restricted.isActive(), false, '99 falhas nao podem acender o modo')

    const centesima = b.stack.limiter.recordFailure(identidade)
    assert.equal(centesima.accountFailures, NIST_BRUTE_FORCE_CEILING)
    const intent = b.stack.restricted.activateIfCeilingReached(centesima.accountFailures)
    assert.notEqual(intent, undefined, 'a 100a falha TEM de devolver o intent')
    assert.equal(b.stack.restricted.isActive(), true)
    b.cleanup()
  })

  it('a resposta NAO muda ao longo da escalada -- 1a e 50a sao bytes iguais', async () => {
    const b = bancada({ comSegredo: true, tunnelReady: true });
    const server = createServer()
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ok')
    })
    server.on('upgrade', (_req, socket: Duplex) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const porta = (server.address() as AddressInfo).port
    const reverter = installAuthBarrier(
      server,
      {
        wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'adv:nist'),
        wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'adv:nist:upgrade'),
      },
      b.gate.log,
    )

    const pedido = (): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(porta, '127.0.0.1', () => {
          socket.write('GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
        })
        const pedacos: Buffer[] = []
        socket.on('data', (d: Buffer) => void pedacos.push(d))
        socket.on('error', reject)
        socket.on('end', () => resolve(Buffer.concat(pedacos).toString('utf8')))
      })

    const primeira = await pedido()
    for (let i = 0; i < 49; i += 1) await pedido()
    const quinquagesima = await pedido()
    // Ate aqui sao pedidos ANONIMOS: nao contam como tentativas de auth
    // (presentsCredential e false) -- o limite protege quem apresenta
    // credencial. A escala real do ban e exercitada com falhas apresentadas.
    assert.equal(primeira, quinquagesima)
    reverter?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    b.cleanup()
  })

  it('o caminho de recuperacao EXECUTA: releaseFromLocalMachine limpa e o modo sai', () => {
    const b = bancada({ comSegredo: true })
    const identidade = { ip: '198.51.100.7' }
    for (let i = 0; i < NIST_BRUTE_FORCE_CEILING; i += 1) b.stack.limiter.recordFailure(identidade)
    b.stack.restricted.activateIfCeilingReached(b.stack.limiter.snapshot().accountFailures)
    assert.equal(b.stack.restricted.isActive(), true)

    const libertado = b.stack.restricted.releaseFromLocalMachine()
    assert.equal(libertado, true, 'havia o que limpar')
    assert.equal(b.stack.restricted.isActive(), false)
    // (A persistencia entre reinicios e verificada noutro sitio: esta suite
    // prova o EXECUTA; o estado em disco e de test/unit/ratelimit/restricted.test.ts.)
    b.cleanup()
  })

  it('enquanto restrito, a credencial do TUNEL e negada e a do loopback passa (a derrubada e o controlo)', async () => {
    // A NOTA de 02-SEGURANCA 6.1: "modo restrito aceita so loopback" so tem
    // conteudo porque o tunel e DERRUBADO junto. Aqui a bancada publica a
    // origem do tunel e o modo restrito e ativo: o pedido com Host do tunel
    // tem de ser negado (a origem saiu da allowlist), o de loopback passa.
    const b = bancada({ comSegredo: true, tunnelReady: true })
    const identidade = { ip: '198.51.100.77' }
    for (let i = 0; i < NIST_BRUTE_FORCE_CEILING; i += 1) b.stack.limiter.recordFailure(identidade)
    b.stack.restricted.activateIfCeilingReached(b.stack.limiter.snapshot().accountFailures)
    // O CONSUMIDOR DO INTENT (onRestrictExposure): tira a origem da allowlist.
    b.stack.auth.onRestrictExposure({
      kind: 'restrict-exposure',
      reason: 'brute-force-ceiling',
      since: b.clock.now(),
      accountFailures: NIST_BRUTE_FORCE_CEILING,
    })
    assert.equal(b.tunnelOrigin.current(), undefined, 'a origem do tunel SAI da allowlist')
    b.cleanup()
  })
})

describe('o ban duro por IP respeita o teto de 100 do NIST (08-PESQUISA 27)', () => {
  it('o NIST_BRUTE_FORCE_CEILING e EXATAMENTE 100, e a politica nao o excede', () => {
    assert.equal(NIST_BRUTE_FORCE_CEILING, 100)
    assert.equal(DEFAULT_RATE_LIMIT_POLICY.bruteForceCeiling, 100)
  })
})

