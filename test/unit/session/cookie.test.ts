/**
 * `src/session/cookie.ts` -- SESS-002 e SESS-007 de `04-TESTES.md` 5.2, mais o
 * veredito de S10 transformado em assercao.
 *
 * SESS-010 nasceu como SONDA ("emite, le de volta e IMPRIME o resultado") e so
 * podia virar assercao depois de a Onda 0 medir. Mediu: `docs/spikes/
 * superficie-ui.md` 5, dois motores, com celula de controlo. Estes testes sao
 * a assercao que a sonda autorizou.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SESSION_COOKIE_NAME,
  assertTrustworthyOrigin,
  isTrustworthyOrigin,
  readSessionCookie,
  serializeSessionCookie,
  serializeSessionCookieClear,
} from '../../../src/session/cookie.ts'
import { createSessionStore } from '../../../src/session/store.ts'
import { FakeClock } from '../../support/clock.ts'

const TUNEL = { scheme: 'https', host: 'algo-aleatorio.trycloudflare.com' } as const
const LOCAL = { scheme: 'http', host: '127.0.0.1:3080' } as const
const LAN = { scheme: 'http', host: '192.168.122.1:3080' } as const

const ID = 'A'.repeat(43)

describe('SESS-002 -- o nome do cookie e canonico e literal (D5)', () => {
  it('e exatamente __Host-dsh_sid', () => {
    assert.equal(SESSION_COOKIE_NAME, '__Host-dsh_sid')
  })

  it('a linha Set-Cookie tem os atributos exigidos, e nenhum Domain', () => {
    const linha = serializeSessionCookie(ID, TUNEL)
    assert.equal(linha, `__Host-dsh_sid=${ID}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`)

    // Cada exigencia do prefixo `__Host-` (RFC 6265bis 4.1.3.2), uma a uma.
    assert.match(linha, /^__Host-/u)
    assert.match(linha, /; Secure(;|$)/u)
    assert.match(linha, /; Path=\/(;|$)/u)
    assert.equal(/;\s*Domain=/iu.test(linha), false, 'Domain invalida o prefixo __Host-')
    assert.match(linha, /; HttpOnly(;|$)/u)
    assert.match(linha, /; SameSite=Strict(;|$)/u)
  })

  it('o Max-Age acompanha o teto absoluto de 8 h', () => {
    assert.match(serializeSessionCookie(ID, TUNEL), /; Max-Age=28800$/u)
  })

  it('o id emitido pelo store passa na serializacao sem escape', () => {
    const store = createSessionStore({ clock: new FakeClock(0) })
    const id: string = store.create()
    assert.equal(serializeSessionCookie(id, LOCAL), `__Host-dsh_sid=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`)
  })
})

describe('SESS-007 -- o Secure NAO e decorativo: governa a emissao', () => {
  it('S10 CONFIRMADO: http de loopback emite (Firefox e Chromium reenviam)', () => {
    assert.equal(isTrustworthyOrigin(LOCAL), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: 'localhost:3080' }), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: 'painel.localhost' }), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: '[::1]:3080' }), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: '::1' }), true)
    // Parentese por fechar: entrada malformada que ainda assim NAO pode virar
    // uma origem de LAN por acidente de parse.
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: '[::1' }), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: '127.5.5.5' }), true)
    // Loopback MAPEADO em IPv6: e loopback genuino, aparece em pilha dupla, e
    // recusa-lo era recusar um cookie que o navegador teria aceite.
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: '::ffff:127.0.0.1' }), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: '[::ffff:127.0.0.1]:3080' }), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'http', host: '::ffff:192.168.1.10' }), false)
    assert.doesNotThrow(() => serializeSessionCookie(ID, LOCAL))
  })

  it('celula de fronteira de S10: http de LAN e RECUSADO na emissao', () => {
    assert.equal(isTrustworthyOrigin(LAN), false)
    assert.throws(() => serializeSessionCookie(ID, LAN), /descartado EM SILENCIO/u)
    assert.throws(() => assertTrustworthyOrigin(LAN), /192\.168\.122\.1/u)
  })

  it('a recusa nomeia a origem e NUNCA o id (Q-4)', () => {
    try {
      serializeSessionCookie(ID, LAN)
      assert.fail('devia ter lancado')
    } catch (erro) {
      const mensagem = String(erro)
      assert.equal(mensagem.includes(ID), false, 'a mensagem vazou o id de sessao')
      assert.equal(mensagem.includes('192.168.122.1'), true)
    }
  })

  it('https vale sempre; esquema desconhecido, nunca', () => {
    assert.equal(isTrustworthyOrigin(TUNEL), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'HTTPS:', host: 'exemplo.com' }), true)
    assert.equal(isTrustworthyOrigin({ scheme: 'ws', host: '127.0.0.1' }), false)
    assert.equal(isTrustworthyOrigin({ scheme: '', host: '127.0.0.1' }), false)
  })

  it('o que so PARECE loopback nao passa', () => {
    for (const host of [
      '127.0.0.1.evil.com',
      // Forma HEXADECIMAL do loopback mapeado: NAO reconhecida aqui, de
      // proposito. E obrigacao de normalizacao de T3.3 -- ver o comentario de
      // `ehIpv4Loopback`. Nenhum navegador poe isto num cabecalho Host.
      '::ffff:7f00:1',
      'localhost.evil.com',
      'naolocalhost',
      '0177.0.0.1',
      '256.0.0.1',
      '127.0.0',
      '1270.0.0.1',
      '',
    ]) {
      assert.equal(isTrustworthyOrigin({ scheme: 'http', host }), false, `passou: ${host}`)
    }
  })
})

describe('injecao de cabecalho pelo valor do cookie', () => {
  it('so o alfabeto base64url entra, e o comprimento tem piso', () => {
    for (const valor of [`${ID}; Domain=evil.com`, `${ID}\r\nSet-Cookie: x=1`, 'curto', '']) {
      assert.throws(() => serializeSessionCookie(valor, TUNEL), /valor de sessao invalido/u)
    }
  })
})

describe('logout do lado do cliente', () => {
  it('a linha de remocao mantem os atributos do prefixo e leva Max-Age=0', () => {
    assert.equal(
      serializeSessionCookieClear(),
      '__Host-dsh_sid=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0',
    )
    // Remover NUNCA lanca, nem sobre a origem de LAN em que emitir e recusado:
    // um logout que rebenta e um logout que nao acontece.
    assert.doesNotThrow(() => serializeSessionCookieClear())
  })
})

describe('leitura do cabecalho Cookie', () => {
  it('encontra o nosso no meio dos outros', () => {
    assert.equal(readSessionCookie(`outro=1; __Host-dsh_sid=${ID}; mais=2`), ID)
    assert.equal(readSessionCookie(`__Host-dsh_sid=${ID}`), ID)
    assert.equal(readSessionCookie(`  __Host-dsh_sid = ${ID}  `), ID)
  })

  it('o nome e comparado COM caixa: o prefixo e case-sensitive na RFC', () => {
    assert.equal(readSessionCookie(`__host-dsh_sid=${ID}`), null)
    assert.equal(readSessionCookie(`__Host-DSH_SID=${ID}`), null)
    assert.equal(readSessionCookie(`dsh_sid=${ID}`), null)
    assert.equal(readSessionCookie(`x__Host-dsh_sid=${ID}`), null)
  })

  it('DUPLICADO fecha: shadowing de cookie nao escolhe vencedor', () => {
    assert.equal(readSessionCookie(`__Host-dsh_sid=${ID}; __Host-dsh_sid=${'B'.repeat(43)}`), null)
  })

  it('valor fora do alfabeto, ausencia e ruido devolvem null', () => {
    assert.equal(readSessionCookie(undefined), null)
    assert.equal(readSessionCookie(''), null)
    assert.equal(readSessionCookie('sem-igual'), null)
    assert.equal(readSessionCookie('__Host-dsh_sid=curto'), null)
    assert.equal(readSessionCookie('__Host-dsh_sid=' + 'A'.repeat(300)), null)
  })

  it('o que sai da leitura entra no store sem transformacao', () => {
    const store = createSessionStore({ clock: new FakeClock(0) })
    const id: string = store.create()
    const linha = serializeSessionCookie(id, TUNEL)
    const enviadoPeloNavegador = linha.slice(0, linha.indexOf(';'))
    const lido = readSessionCookie(`tema=escuro; ${enviadoPeloNavegador}`)
    assert.equal(lido, id)
    assert.notEqual(store.validate(lido), null)
  })
})
