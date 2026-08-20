/**
 * `GET` inerte + `POST` consumidor -- `04-TESTES.md` 5.2.2 (MAG-001..MAG-006) e
 * 5.9 (PANEL-006/PANEL-007).
 *
 * O CASO QUE MANTEM O PRODUTO DE PE E `MAG-001`. Um link enviado por Telegram e
 * PRE-CARREGADO -- pelo pre-visualizador do proprio Telegram, por scanners de
 * antiphishing, por clientes de e-mail. Se o `GET` consumisse, o link morria
 * antes de o dono lhe tocar e ele veria "link invalido" num link que nunca usou.
 * Por isso o teste nao se limita a um `GET`: faz DOIS, e so depois o `POST`.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { CSRF_HEADER_NAME } from '../../../src/panel/csrf.ts'
import { CLICK_SIGNAL_HEADER, MAGIC_CRAWLER_EVENT } from '../../../src/panel/magic.ts'
import { CSRF_REJECTION_EVENT, PANEL_PATH_MAGIC, routeKeyOf } from '../../../src/panel/routes.ts'
import { MAGIC_MAX_LIVE, MAGIC_TTL_MS } from '../../../src/session/magic.ts'
import { criarBancada, pedir, sessaoDoCookie, type Bancada } from './harness.ts'

describe('/__guard/magic', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada()
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  beforeEach(() => {
    bancada.magic.revokeAll()
    bancada.eventos.length = 0
  })

  const token = (): string => bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_MAGIC))

  /**
   * Imita o que a NOSSA pagina envia: token anti-CSRF mais
   * `Sec-Fetch-Site: same-origin`. Um teste que nao enviasse o cabecalho estaria
   * a medir o caminho do cliente antigo, nao o do caso feliz.
   */
  const consumir = (mk: string, cabecalhos?: Record<string, string>): Promise<Awaited<ReturnType<typeof pedir>>> =>
    pedir(port, PANEL_PATH_MAGIC, {
      method: 'POST',
      headers: cabecalhos ?? {
        [CSRF_HEADER_NAME]: token(),
        [CLICK_SIGNAL_HEADER]: 'same-origin',
      },
      body: new URLSearchParams({ mk }).toString(),
    })

  it('MAG-001/PANEL-006: dois `GET` seguidos NAO consomem -- o `POST` depois deles funciona', async () => {
    const mk = bancada.magic.issue().mk

    const primeiro = await pedir(port, PANEL_PATH_MAGIC)
    const segundo = await pedir(port, `${PANEL_PATH_MAGIC}?mk=${encodeURIComponent(mk)}`)

    assert.equal(primeiro.status, 200)
    assert.equal(segundo.status, 200)
    assert.equal(primeiro.setCookie.length, 0)
    assert.equal(segundo.setCookie.length, 0)
    assert.equal(bancada.magic.live, 1)

    const terceiro = await consumir(mk)
    assert.equal(terceiro.status, 200)
    assert.ok(sessaoDoCookie(terceiro.setCookie) !== undefined)
  })

  it('o `GET` nao le `?mk=` -- o token viaja no FRAGMENTO, que nao chega ao servidor', async () => {
    const mk = bancada.magic.issue().mk
    const resposta = await pedir(port, `${PANEL_PATH_MAGIC}?mk=${encodeURIComponent(mk)}`)

    assert.equal(resposta.status, 200)
    assert.equal(resposta.body.includes(mk), false)
    assert.equal(bancada.magic.live, 1)
  })

  it('MAG-002/PANEL-007: o `POST` consome e emite sessao', async () => {
    const mk = bancada.magic.issue().mk
    const resposta = await consumir(mk)

    assert.equal(resposta.status, 200)
    const id = sessaoDoCookie(resposta.setCookie)
    assert.ok(id !== undefined)
    assert.ok(bancada.sessions.validate(id) !== null)
    assert.equal(bancada.magic.live, 0)
  })

  it('MAG-003: o SEGUNDO `POST` com o mesmo `mk` falha e nao emite sessao nova', async () => {
    const mk = bancada.magic.issue().mk

    const primeiro = await consumir(mk)
    const segundo = await consumir(mk)

    assert.equal(primeiro.status, 200)
    assert.equal(segundo.status, 401)
    assert.equal(segundo.setCookie.length, 0)
    assert.deepEqual(
      bancada.eventos.map((e) => `${e.evento}:${e.resultado}`),
      ['painel_magic:permitido', 'painel_magic:negado'],
    )
  })

  it('MAG-004: `mk` expirado e recusado -- relogio injetado, sem esperar 120 s', async () => {
    const mk = bancada.magic.issue().mk

    bancada.clock.advance(MAGIC_TTL_MS - 1)
    const dentro = await consumir(mk)
    assert.equal(dentro.status, 200)

    const outro = bancada.magic.issue().mk
    bancada.clock.advance(MAGIC_TTL_MS + 1)
    const fora = await consumir(outro)
    assert.equal(fora.status, 401)
    assert.equal(fora.setCookie.length, 0)
  })

  it(`mais de ${MAGIC_MAX_LIVE} tokens vivos: o mais antigo cai`, async () => {
    const emitidos: string[] = []
    for (let i = 0; i < MAGIC_MAX_LIVE; i += 1) {
      emitidos.push(bancada.magic.issue().mk)
      // Um milissegundo entre emissoes para que "o mais antigo" seja uma
      // ordem observavel e nao um empate resolvido por acaso.
      bancada.clock.advance(1)
    }
    assert.equal(bancada.magic.live, MAGIC_MAX_LIVE)

    const excedente = bancada.magic.issue().mk
    assert.equal(bancada.magic.live, MAGIC_MAX_LIVE)

    const maisAntigo = await consumir(emitidos[0] ?? '')
    assert.equal(maisAntigo.status, 401)

    const recente = await consumir(excedente)
    assert.equal(recente.status, 200)
  })

  it('as tres razoes de recusa sao indistinguiveis no fio', async () => {
    const gasto = bancada.magic.issue().mk
    await consumir(gasto)
    const jaGasto = await consumir(gasto)

    const expirado = bancada.magic.issue().mk
    bancada.clock.advance(MAGIC_TTL_MS + 1)
    const foraDePrazo = await consumir(expirado)

    const inventado = await consumir('nao-e-um-mk-valido-de-todo')

    for (const outra of [foraDePrazo, inventado]) {
      assert.equal(outra.status, jaGasto.status)
      assert.equal(outra.body, jaGasto.body)
      assert.deepEqual(outra.headers, jaGasto.headers)
    }
  })

  it('MAG-006a: `POST` sem token anti-CSRF nao queima o `mk`, e o evento e o de CSRF', async () => {
    const mk = bancada.magic.issue().mk

    const cego = await consumir(mk, {})

    assert.equal(cego.status, 403)
    assert.equal(cego.setCookie.length, 0)
    assert.equal(bancada.magic.live, 1, 'o `mk` foi queimado por um POST sem token')
    // NAO e `magic.crawler-suspect`: um POST cego normalmente nem `mk` traz, e
    // baptizar essa recusa de "crawler" era ruido disfarcado de alarme. O nome
    // do evento diz a verdade -- faltou o token.
    assert.ok(bancada.eventos.every((e) => e.evento.startsWith(CSRF_REJECTION_EVENT)))
    assert.ok(bancada.eventos.every((e) => !e.evento.startsWith(MAGIC_CRAWLER_EVENT)))

    const dono = await consumir(mk)
    assert.equal(dono.status, 200)
  })

  it('MAG-006b: token VALIDO colhido anonimamente + `Sec-Fetch-Site` errado NAO queima o `mk`', async () => {
    // ESTE E O ATAQUE QUE A REVISAO ADVERSARIAL DEMONSTROU, e que a versao
    // anterior deixava passar: `GET /__guard/magic` entrega o token a qualquer
    // anonimo, porque a rota e publica e o vinculo do token e a chave da rota.
    // Com o token na mao, bastavam dois pedidos para consumir o `mk` sem
    // navegador e sem clique -- e nenhum evento era registado.
    const mk = bancada.magic.issue().mk
    const pagina = await pedir(port, PANEL_PATH_MAGIC)
    const colhido = /<meta name="dsh-csrf" content="([^"]+)">/u.exec(pagina.body)?.[1] ?? ''

    const robo = await consumir(mk, {
      [CSRF_HEADER_NAME]: colhido,
      [CLICK_SIGNAL_HEADER]: 'cross-site',
    })

    assert.equal(robo.status, 401)
    assert.equal(robo.setCookie.length, 0)
    assert.equal(bancada.magic.live, 1, 'o `mk` foi queimado sem sinal de clique')
    assert.ok(bancada.eventos.some((e) => e.evento.startsWith(MAGIC_CRAWLER_EVENT)))

    // E o dono, que veio da nossa pagina, continua a entrar com o mesmo `mk`.
    const dono = await consumir(mk, {
      [CSRF_HEADER_NAME]: colhido,
      [CLICK_SIGNAL_HEADER]: 'same-origin',
    })
    assert.equal(dono.status, 200)
  })

  it('a recusa por sinal de clique e indistinguivel de um `mk` invalido', async () => {
    const mk = bancada.magic.issue().mk
    const semSinal = await consumir(mk, {
      [CSRF_HEADER_NAME]: token(),
      [CLICK_SIGNAL_HEADER]: 'none',
    })
    const inventado = await consumir('nao-e-um-mk-valido-de-todo')

    assert.equal(semSinal.status, inventado.status)
    assert.equal(semSinal.body, inventado.body)
    assert.deepEqual(semSinal.headers, inventado.headers)
  })

  it('LIMITE HONESTO: sem `Sec-Fetch-Site` o pedido passa, e o facto fica registado', async () => {
    // Safari so envia o cabecalho desde a 16.4. Exigi-lo trancava o telemovel
    // do dono fora do produto -- e o telemovel do dono E o produto. O que se faz
    // e registar a ausencia, para o alerta de sessao nova a poder dizer.
    const mk = bancada.magic.issue().mk
    const antigo = await consumir(mk, { [CSRF_HEADER_NAME]: token() })

    assert.equal(antigo.status, 200)
    assert.ok(
      bancada.eventos.some(
        (e) => e.evento === 'painel_magic_sem_sinal_de_clique' && e.resultado === 'permitido',
      ),
    )
  })

  it('a pagina do `GET` traz o token do `POST` do magic E o do login', async () => {
    const pagina = await pedir(port, PANEL_PATH_MAGIC)
    const doMagic = /<meta name="dsh-csrf" content="([^"]+)">/u.exec(pagina.body)
    const doLogin = /<meta name="dsh-csrf-login" content="([^"]+)">/u.exec(pagina.body)

    assert.ok(doMagic !== null && doLogin !== null)
    assert.equal(bancada.csrf.verify(doMagic[1], routeKeyOf('POST', PANEL_PATH_MAGIC)), true)
    assert.equal(bancada.csrf.verify(doLogin[1], routeKeyOf('POST', '/__guard/api/login')), true)
    // E nao sao intermutaveis.
    assert.equal(bancada.csrf.verify(doLogin[1], routeKeyOf('POST', PANEL_PATH_MAGIC)), false)
  })
})
