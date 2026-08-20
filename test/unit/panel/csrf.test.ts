/**
 * Token anti-CSRF das rotas POST -- `04-TESTES.md` 3.2 (`panel/csrf.test.ts`) e
 * SESS-006 ("mutacao sem token anti-CSRF => 403").
 *
 * As duas propriedades que importam e que um token "que parece funcionar" nao
 * tem: (a) um token de uma rota NAO vale noutra (o vinculo); (b) o `GET` que o
 * emite nao escreve nada -- e por isso o pre-carregamento de um link magico
 * continua a custar zero.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import {
  CSRF_FIELD_NAME,
  CSRF_HEADER_NAME,
  CSRF_TTL_MS,
  createCsrfGuard,
} from '../../../src/panel/csrf.ts'
import {
  PANEL_PATH_LOGIN,
  PANEL_PATH_MAGIC,
  routeKeyOf,
} from '../../../src/panel/routes.ts'
import { FakeClock } from '../../support/clock.ts'
import { criarBancada, pedir, type Bancada } from './harness.ts'

describe('a primitiva do token', () => {
  it('MEDIA-3: o TTL tem a GRANDEZA LITERAL, e nao uma asercao autorreferencial', () => {
    // A versao anterior desta suite importava `CSRF_TTL_MS` e avancava o relogio
    // POR ELE -- ou seja, media a si propria. A revisao adversarial pos o TTL em
    // DEZ ANOS e a suite inteira ficou verde.
    //
    // E ele nao e um detalhe de conforto: nas rotas publicas o token e emitido a
    // qualquer anonimo (`GET /__guard/magic` e publico), e reutilizavel, e nao
    // esta vinculado ao cliente. O TTL e o UNICO limite que ele tem.
    assert.equal(CSRF_TTL_MS, 30 * 60 * 1000)
    assert.ok(CSRF_TTL_MS <= 60 * 60 * 1000, 'um token publico e reutilizavel nao vive uma hora')
  })

  it('um token emitido para um vinculo verifica nesse vinculo', () => {
    const clock = new FakeClock(1_000)
    const guarda = createCsrfGuard({ clock })

    assert.equal(guarda.verify(guarda.issue('sessao-abc'), 'sessao-abc'), true)
  })

  it('o vinculo separa as rotas: um token do magic NAO vale no login', () => {
    const clock = new FakeClock(1_000)
    const guarda = createCsrfGuard({ clock })
    const doMagic = guarda.issue(routeKeyOf('POST', PANEL_PATH_MAGIC))

    assert.equal(guarda.verify(doMagic, routeKeyOf('POST', PANEL_PATH_LOGIN)), false)
  })

  it('o prefixo de comprimento impede que dois vinculos diferentes colidam', () => {
    const clock = new FakeClock(1_000)
    const guarda = createCsrfGuard({ clock })
    // Sem prefixo de comprimento, `('ab','c|1')` e `('ab|c','1')` produziriam a
    // mesma mensagem assinada.
    assert.equal(guarda.verify(guarda.issue('ab'), 'ab|c'), false)
    assert.equal(guarda.verify(guarda.issue('ab|c'), 'ab'), false)
  })

  it('o token expira pelo relogio injetado, e nao por um temporizador', () => {
    const clock = new FakeClock(1_000)
    const guarda = createCsrfGuard({ clock })
    const token = guarda.issue('v')

    clock.advance(CSRF_TTL_MS - 1)
    assert.equal(guarda.verify(token, 'v'), true)
    clock.advance(1)
    assert.equal(guarda.verify(token, 'v'), false)
  })

  it('adiantar a expiracao declarada no token invalida a assinatura', () => {
    const clock = new FakeClock(1_000)
    const guarda = createCsrfGuard({ clock })
    const token = guarda.issue('v')
    const assinatura = token.slice(token.indexOf('.') + 1)
    const esticado = `${(clock.now() + CSRF_TTL_MS * 10).toString(36)}.${assinatura}`

    assert.equal(guarda.verify(esticado, 'v'), false)
  })

  it('lixo, tipos errados e tamanhos absurdos devolvem `false` sem lancar', () => {
    const clock = new FakeClock(1_000)
    const guarda = createCsrfGuard({ clock })

    for (const candidato of [
      undefined,
      null,
      42,
      {},
      '',
      '.',
      'semponto',
      'zz.AAAA',
      `${'a'.repeat(200)}.${'b'.repeat(200)}`,
      `${(clock.now() + 1000).toString(36)}.`,
    ]) {
      assert.equal(guarda.verify(candidato, 'v'), false)
    }
  })

  it('duas guardas independentes nao aceitam os tokens uma da outra', () => {
    const clock = new FakeClock(1_000)
    const a = createCsrfGuard({ clock })
    const b = createCsrfGuard({ clock })

    assert.equal(b.verify(a.issue('v'), 'v'), false)
  })

  it('uma chave curta demais falha ALTO no arranque', () => {
    assert.throws(
      () => createCsrfGuard({ clock: new FakeClock(0), key: new Uint8Array(8) }),
      /chave de CSRF curta demais/u,
    )
  })

  it('ttlMs invalido ou nao positivo falha ALTO no arranque', () => {
    assert.throws(() => createCsrfGuard({ clock: new FakeClock(0), ttlMs: 0 }), /ttlMs/u)
    assert.throws(() => createCsrfGuard({ clock: new FakeClock(0), ttlMs: -5 }), /ttlMs/u)
    assert.throws(() => createCsrfGuard({ clock: new FakeClock(0), ttlMs: Number.NaN }), /ttlMs/u)
  })
})

describe('o despachante exige o token em TODO POST', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({ comSegredo: true })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  it('SESS-006: `POST /__guard/api/login` sem token e 403, e nao 401', async () => {
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

    assert.equal(resposta.status, 403)
    assert.equal(resposta.setCookie.length, 0)
  })

  it('o token e aceite pelo cabecalho', async () => {
    const token = bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

    assert.equal(resposta.status, 200)
  })

  it('o token e aceite pelo campo de corpo', async () => {
    const token = bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      body: new URLSearchParams({
        segredo: String(bancada.segredo),
        [CSRF_FIELD_NAME]: token,
      }).toString(),
    })

    assert.equal(resposta.status, 200)
  })

  it('um token emitido para OUTRA rota nao destranca o login', async () => {
    const token = bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_MAGIC))
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

    assert.equal(resposta.status, 403)
  })

  it('nas rotas com sessao o vinculo e o HASH da sessao -- o id nunca sai no HTML', async () => {
    const id = bancada.sessions.create()
    const sessao = bancada.sessions.validate(id)
    assert.ok(sessao !== null)

    const pagina = await pedir(port, '/__guard', { cookie: `__Host-dsh_sid=${id}` })
    const meta = /<meta name="dsh-csrf" content="([^"]+)">/u.exec(pagina.body)
    assert.ok(meta !== null)

    assert.ok(!pagina.body.includes(id))
    assert.equal(bancada.csrf.verify(meta[1], sessao.idHash), true)
    assert.equal(bancada.csrf.verify(meta[1], routeKeyOf('POST', PANEL_PATH_LOGIN)), false)
  })
})
