/**
 * `buildControlIntent` e a projecao do resultado — a traducao do gesto de UI
 * para o contrato de T5.1. As perguntas falsificaveis respondidas aqui:
 *
 *  - o intent carrega `requestId` novo (chave de idempotencia) e `at` do
 *    relogio INJETADO, nunca `Date.now`;
 *  - o nonce viaja opaco: presente nas acoes que AUMENTAM exposicao
 *    (CTL-024), AUSENTE nas que reduzem (o botao de desligar funciona de
 *    primeira);
 *  - a recusa do controlador chega a UI com motivo em portugues, e a URL so
 *    e projetada em READY (a URL nao aparece antes de o tunel estar pronto).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ControlRecusa } from '../../../src/contracts/control.ts'
import {
  buildControlIntent,
  exigeNonce,
  motivoDaRecusa,
  projectResultado,
  RECUSA_MOTIVO,
  RECUSA_SEM_ROTULO,
} from '../../../src/ui-contrib/intents.ts'

describe('buildControlIntent', () => {
  it('carrega action, requestedBy, requestId e at do relogio injetado', () => {
    const intent = buildControlIntent({
      action: 'start',
      requestedBy: 'ui:native',
      requestId: '01ABCDEFGHJKMNPQRSTVWXYZ',
      at: 1_700_000_000_000,
    })
    assert.deepEqual(intent, {
      action: 'start',
      requestedBy: 'ui:native',
      requestId: '01ABCDEFGHJKMNPQRSTVWXYZ',
      at: 1_700_000_000_000,
    })
  })

  it('o nonce e transportado opaco quando presente', () => {
    const intent = buildControlIntent({
      action: 'start',
      requestedBy: 'ui:native',
      requestId: 'id-1',
      nonce: 'abc-opaco-123',
      at: 5,
    })
    assert.equal(intent.nonce, 'abc-opaco-123')
  })

  it('sem nonce, a CHAVE nao existe no intent (exactOptionalPropertyTypes)', () => {
    const intent = buildControlIntent({
      action: 'stop',
      requestedBy: 'ui:native',
      requestId: 'id-1',
      at: 5,
    })
    assert.equal('nonce' in intent, false)
  })

  it('o corpo do intent e o do contrato congelado — nada a mais, nada a menos', () => {
    const intent = buildControlIntent({
      action: 'stop',
      requestedBy: 'ui:native',
      requestId: 'id-1',
      at: 5,
    })
    assert.deepEqual(Object.keys(intent).toSorted(), ['action', 'at', 'requestId', 'requestedBy'])
  })
})

describe('exigeNonce (CTL-024)', () => {
  it('start e reset AUMENTAM exposicao: exigem nonce', () => {
    assert.equal(exigeNonce('start'), true)
    assert.equal(exigeNonce('reset'), true)
  })

  it('stop REDUZ exposicao: dispensa nonce — o botao funciona de primeira', () => {
    assert.equal(exigeNonce('stop'), false)
  })
})

describe('RECUSA_MOTIVO', () => {
  it('cobre as recusas ALCANCAVEIS da superficie, com motivo nao-vazio', () => {
    const codigos: readonly ControlRecusa[] = [
      'SHUTDOWN_IN_PROGRESS',
      'MODO_RESTRITO',
      'SEM_SEGREDO_FORTE',
      'NONCE_AUSENTE',
      'NONCE_INVALIDO',
      'NONCE_EXPIRADO',
      'TERMINAL_SEM_RESET', // desde a costura (W3): a rota de reset existe
    ]
    for (const codigo of codigos) {
      const motivo = RECUSA_MOTIVO[codigo]
      assert.ok(typeof motivo === 'string' && motivo.length > 0, `falta o motivo de ${codigo}`)
    }
    // Nenhum codigo inventado fora do contrato.
    assert.deepEqual(Object.keys(RECUSA_MOTIVO).toSorted(), [...codigos].toSorted())
  })

  it('TERMINAL_SEM_RESET TEM rotulo desde a costura (W3): a rota de reset existe', () => {
    // A COSTURA da Onda 5 (W3) acrescentou `POST /__guard-ui/api/reset` e o
    // confirm — FAILED so sai por reset humano (CTL-012) e a recusa de um
    // reset forjado chega a UI. O rotulo deixa de ser codigo morto.
    assert.deepEqual(RECUSA_SEM_ROTULO, [])
    assert.ok(typeof RECUSA_MOTIVO.TERMINAL_SEM_RESET === 'string')
    assert.ok(typeof motivoDaRecusa('TERMINAL_SEM_RESET') === 'string')
  })
})

describe('projectResultado', () => {
  it('recusa chega a UI com codigo e motivo em portugues', () => {
    const projetado = projectResultado({
      estado: 'STOPPED',
      idempotente: false,
      recusa: 'MODO_RESTRITO',
    })
    assert.equal(projetado.recusa, 'MODO_RESTRITO')
    assert.equal(typeof projetado.motivo, 'string')
    assert.ok((projetado.motivo as string).includes('Modo restrito'))
    assert.equal(projetado.url, undefined)
  })

  it('a URL so e projetada em READY', () => {
    const emReady = projectResultado({
      estado: 'READY',
      idempotente: true,
      url: 'https://abc.trycloudflare.com',
    })
    assert.equal(emReady.url, 'https://abc.trycloudflare.com')
  })

  it('DEFESA EM PROFUNDIDADE: url fora de READY e DESCARTADA, mesmo que o controlador a devolva', () => {
    const projetado = projectResultado({
      estado: 'STARTING',
      idempotente: false,
      url: 'https://vazou.trycloudflare.com',
    })
    assert.equal(projetado.url, undefined)
  })

  it('`idempotente` passa para a UI (o clique repetido nao e erro)', () => {
    const projetado = projectResultado({ estado: 'READY', idempotente: true, url: 'https://x' })
    assert.equal(projetado.idempotente, true)
    assert.equal(projetado.recusa, undefined)
    assert.equal(projetado.motivo, undefined)
  })
})
