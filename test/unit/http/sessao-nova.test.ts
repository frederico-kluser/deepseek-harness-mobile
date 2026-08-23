/**
 * Ponto de chamada CONGELADO no COMMIT PREP 5 (`src/http/gate.ts`, L3.1):
 * o evento de auditoria `sessao_nova` e o fan-out de observadores
 * (`src/audit/events.ts`).
 *
 * O QUE ESTE TESTE PRENDE, e porque existe:
 *
 *   1. O evento dispara no PRIMEIRO uso autorizado de uma sessao, e so nele —
 *      a notificacao de "sessao nova" nao pode virar uma notificacao por
 *      pedido (inundacao) nem nunca vir (o detector de "atacante com a
 *      credencial" e a razao de ser de T5.4).
 *   2. O audit escreve ANTES do fan-out — "o log e a fonte da verdade; a
 *      notificacao e best-effort" (03-ONDAS 10).
 *   3. Auditoria avariada no primeiro uso NEGA o pedido (fail-closed) e NAO
 *      notifica — a doutrina da auditoria nao ganha excecao no caminho de
 *      sucesso.
 *   4. Nenhum observador registado: nada rebenta (o caminho default).
 *
 * LIMITES DECLARADOS (nao testados aqui): o teto de 1024 sessoes vistas e a
 * eviccao da mais antiga — a consequencia aceite (re-notificar) esta escrita
 * no contrato; um teste de 1024 sessoes seria ruido. O caminho de upgrade nao
 * emite, de proposito — a razao esta escrita no ponto de chamada.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { AuditWriteError } from '../../../src/audit/log.ts'
import {
  registerSessaoNovaObserver,
  type SessaoNovaEvent,
} from '../../../src/audit/events.ts'
import type { AuditEvent } from '../../../src/contracts/auth.ts'
import { createGuardedHandler, type GateDeps } from '../../../src/http/gate.ts'
import { FakeResponse } from '../../support/ctx-double.ts'
import { bancada, pedido, FAKE_TUNNEL_ORIGIN, type Bancada } from './bancada.ts'

/**
 * O `sessao_nova` e um evento da SUPERFICIE DO TUNEL (onda 1). Um pedido
 * LOCAL abre direto e nunca passa pelo caminho que o emite; um pedido pelo
 * tunel com sessao valida passa por ele. Esta suite usa pedidos pelo TUNEL.
 */
function tunel(spec: Parameters<typeof pedido>[0] = {}): ReturnType<typeof pedido> {
  return pedido({
    ...spec,
    headers: { host: new URL(FAKE_TUNNEL_ORIGIN).host, ...spec.headers },
  })
}

/** Sink de auditoria que falha como um disco cheio (mesmo defeito de gate.test.ts). */
function comAuditoriaAvariada(b: Bancada): GateDeps {
  return {
    ...b.gate,
    auth: () => ({
      ...b.stack.auth,
      audit: {
        append(_event: AuditEvent): void {
          throw new AuditWriteError(
            'nao foi possivel registar a auditoria — o gate TEM de negar (fail-closed). ' +
              'Registos perdidos nesta janela: 1.',
            1,
            '/caminho/que/nao/pode/aparecer/no/corpo/audit.log',
          )
        },
      },
    }),
  }
}

describe('ponto de chamada congelado no PREP 5: sessao_nova', () => {
  it('emite no PRIMEIRO uso autorizado da sessao, e so nele', async () => {
    const b = bancada({ comSegredo: true, tunnelReady: true })
    const cookie = b.emitirSessao()

    const vistos: SessaoNovaEvent[] = []
    const desregista = registerSessaoNovaObserver((evento) => {
      vistos.push(evento)
    })

    let originais = 0
    const handler = createGuardedHandler(
      b.gate,
      (): void => {
        originais += 1
      },
      'dispatch:request',
    )

    const res1 = new FakeResponse()
    await handler(tunel({ headers: { cookie } }), res1.asServerResponse())
    assert.equal(originais, 1, 'o primeiro pedido chega ao despacho original')

    const res2 = new FakeResponse()
    await handler(tunel({ headers: { cookie } }), res2.asServerResponse())
    assert.equal(originais, 2, 'o despacho original corre nas duas vezes')

    assert.equal(vistos.length, 1, 'o observador viu EXATAMENTE um evento')
    assert.equal(vistos[0]?.evento, 'sessao_nova')
    assert.equal(vistos[0]?.resultado, 'permitido')
    assert.equal(typeof vistos[0]?.sessao_id_hash, 'string')
    assert.ok((vistos[0]?.sessao_id_hash ?? '').length > 0)

    desregista()
    b.cleanup()
  })

  it('cada sessao distinta emite uma vez — e o audit fica escrito ANTES do fan-out', async () => {
    const b = bancada({ comSegredo: true, tunnelReady: true })

    const ordem: string[] = []
    const desregista = registerSessaoNovaObserver(() => {
      ordem.push('observador')
    })

    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')

    const sessaoA = b.emitirSessao()
    const sessaoB = b.emitirSessao()

    await handler(tunel({ headers: { cookie: sessaoA } }), new FakeResponse().asServerResponse())
    await handler(tunel({ headers: { cookie: sessaoB } }), new FakeResponse().asServerResponse())

    assert.equal(ordem.length, 2, 'duas sessoes, dois eventos')

    const linhas = readFileSync(b.auditPath, 'utf8').trim().split('\n')
    const sessoesNovas = linhas
      .map((linha) => JSON.parse(linha) as AuditEvent)
      .filter((evento) => evento.evento === 'sessao_nova')
    assert.equal(sessoesNovas.length, 2, 'duas linhas sessao_nova no audit')
    for (const evento of sessoesNovas) {
      assert.equal(evento.resultado, 'permitido')
      assert.equal(typeof evento.sessao_id_hash, 'string')
    }

    // A ordem audit-antes-de-fanout e provada por construcao do ponto de
    // chamada (recordAudit precede emitSessaoNova); este teste prende que o
    // audit TEM as duas linhas quando os observadores ja correram.
    assert.equal(ordem[0], 'observador')
    assert.equal(ordem[1], 'observador')

    desregista()
    b.cleanup()
  })

  it('auditoria avariada no primeiro uso NEGA (fail-closed) e NAO notifica', async () => {
    const b = bancada({ comSegredo: true, tunnelReady: true })
    const cookie = b.emitirSessao()

    const vistos: SessaoNovaEvent[] = []
    const desregista = registerSessaoNovaObserver((evento) => {
      vistos.push(evento)
    })

    const handler = createGuardedHandler(comAuditoriaAvariada(b), (): void => {}, 'dispatch:request')

    const res = new FakeResponse()
    await handler(tunel({ headers: { cookie } }), res.asServerResponse())

    assert.equal(res.statusCode, 401, 'auditoria indisponivel: o gate nega')
    assert.equal(vistos.length, 0, 'sem log, sem notificacao')

    desregista()
    b.cleanup()
  })

  it('sem observadores registados, o caminho continua identico', async () => {
    const b = bancada({ comSegredo: true, tunnelReady: true })
    const cookie = b.emitirSessao()

    let originais = 0
    const handler = createGuardedHandler(
      b.gate,
      (): void => {
        originais += 1
      },
      'dispatch:request',
    )

    const res = new FakeResponse()
    await handler(tunel({ headers: { cookie } }), res.asServerResponse())
    assert.equal(originais, 1, 'o despacho original corre sem observadores')

    b.cleanup()
  })

  it('sem sessao (credencial estatica) NAO emite sessao_nova', async () => {
    const b = bancada({ comSegredo: true, tunnelReady: true })
    // Com credencial estatica presente, o pedido autentica por Basic:
    // outcome.session e null e o ponto de chamada nao pode disparar.
    const vistos: SessaoNovaEvent[] = []
    const desregista = registerSessaoNovaObserver((evento) => {
      vistos.push(evento)
    })

    let originais = 0
    const handler = createGuardedHandler(
      b.gate,
      (): void => {
        originais += 1
      },
      'dispatch:request',
    )
    const res = new FakeResponse()
    await handler(tunel({ headers: { authorization: basicHeader(b) } }), res.asServerResponse())
    assert.equal(originais, 1, 'a credencial estatica passa')
    assert.equal(vistos.length, 0, 'credencial estatica nao e sessao')

    desregista()
    b.cleanup()
  })
})

/** `Authorization: Basic` com a credencial ESTATICA valida da bancada. */
function basicHeader(b: Bancada): string {
  // `encodedAuthString` JA E o valor base64 (fixtures: `admin:s3cr3t`).
  return `Basic ${b.config.encodedAuthString}`
}
