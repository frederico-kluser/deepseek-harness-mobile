/**
 * `src/control/confirm.ts` — o nonce de confirmacao de duas etapas
 * (CTL-021/022, S5 de `src/contracts/ipc.ts`).
 *
 * As propriedades presas aqui: 128 bits por CSPRNG em hex, TTL 60 s com
 * relogio INJETADO, USO UNICO (replay falha — CTL-021), expiracao falha
 * (CTL-022), o nonce autoriza a ACAO para que foi emitido, e o teto de nonces
 * vivos nao deixa uma superficie com defeito encher a memoria.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NONCE_TTL_MS } from '../../../src/contracts/control.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import { FakeClock } from '../../support/clock.ts'

function bytes(...valores: number[]): Uint8Array {
  return Uint8Array.from(valores)
}

function fazerServico(overrides: { agora?: () => number } = {}) {
  const clock = new FakeClock(1_000)
  const servico = createConfirmService({
    now: overrides.agora ?? (() => clock.now()),
    // Determinista: 16 bytes fixos -> hex de 32 caracteres.
    randomBytes: () => bytes(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10),
  })
  return { servico, clock }
}

describe('emissao do nonce', () => {
  it('devolve 128 bits em hex (32 caracteres) com expiracao agora + TTL', () => {
    const { servico } = fazerServico()
    const nonce = servico.issue('start')

    assert.equal(nonce.valor.length, 32, '16 bytes = 128 bits = 32 hex')
    assert.match(nonce.valor, /^[0-9a-f]{32}$/u)
    assert.equal(nonce.expiresAt, 1_000 + NONCE_TTL_MS)
  })

  it('emite nonces DISTINTOS em chamadas seguidas (CSPRNG)', () => {
    const { servico } = fazerServico()
    servico.issue('start')
    // A injecao fixa o gerador; sem ela a assercao e de DISTINCAO — com ela,
    // o que se prova e que o valor emitido e EXATAMENTE o do gerador.
    assert.equal(servico.issue('start').valor, '0102030405060708090a0b0c0d0e0f10')
  })
})

describe('consumo — uso unico (CTL-021)', () => {
  it('consome uma vez e devolve true; o replay devolve false', () => {
    const { servico } = fazerServico()
    const nonce = servico.issue('start')

    assert.equal(servico.consume(nonce.valor, 'start'), true)
    assert.equal(servico.consume(nonce.valor, 'start'), false, 'uso unico: replay recusado')
  })

  it('recusa um nonce desconhecido (fabricado pelo cliente)', () => {
    const { servico } = fazerServico()
    assert.equal(servico.consume('0123456789abcdef0123456789abcdef', 'start'), false)
  })

  it('recusa a ACAO errada e nao consome o nonce da acao certa', () => {
    const { servico } = fazerServico()
    const nonce = servico.issue('start')

    assert.equal(servico.consume(nonce.valor, 'reset'), false, 'o nonce de start nao autoriza reset')
    assert.equal(servico.consume(nonce.valor, 'start'), true, 'a apresentacao errada nao queimou o nonce')
  })
})

describe('consumo — expiracao (CTL-022)', () => {
  it('um nonce expirado devolve false e nao volta a valer', () => {
    const { servico, clock } = fazerServico()
    const nonce = servico.issue('start')

    clock.advance(NONCE_TTL_MS) // exatamente no limite: `now >= expiresAt` expira
    assert.equal(servico.consume(nonce.valor, 'start'), false)
    // O relogio NAO anda para tras no teste; avancar de novo nao ressuscita.
    assert.equal(servico.consume(nonce.valor, 'start'), false)
  })

  it('o veredito distingue expirado de desconhecido (recusas CTL-021/022)', () => {
    const { servico, clock } = fazerServico()
    const nonce = servico.issue('start')

    clock.advance(NONCE_TTL_MS + 1)
    assert.equal(servico.consumirComVeredito(nonce.valor, 'start'), 'expirado')
    assert.equal(servico.consumirComVeredito('00000000000000000000000000000000', 'start'), 'desconhecido')
  })
})

describe('teto de nonces vivos', () => {
  it('o mais antigo e descartado quando o teto e atingido', () => {
    // O gerador fixo da bancada produziria nonces IDENTICOS (uma so entrada
    // na tabela); aqui o gerador conta, para que cada emissao seja distinta.
    const clock = new FakeClock(1_000)
    let contador = 0
    const servico = createConfirmService({
      now: () => clock.now(),
      randomBytes: () => {
        contador += 1
        // 16 bits do contador nos dois ultimos bytes: unico nas 1026 emissoes.
        return Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, (contador >> 8) & 0xff, contador & 0xff])
      },
    })
    const primeiro = servico.issue('start')

    // Enche a tabela ate ao teto (1024) e emite mais um.
    for (let i = 0; i < 1024; i += 1) servico.issue('start')
    const ultimo = servico.issue('start')

    assert.notEqual(ultimo.valor, primeiro.valor)
    assert.equal(servico.consume(primeiro.valor, 'start'), false, 'o mais antigo saiu da tabela')
    assert.equal(servico.consume(ultimo.valor, 'start'), true)
  })
})
