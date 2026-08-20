/**
 * Politica por rota e isencoes -- `04-TESTES.md` 5.9.
 *
 * O QUE ESTA SUITE EXISTE PARA FALSIFICAR: que a isencao ao gate seja INFERIDA
 * em vez de ENUMERADA. O caso central e `PANEL-009-nova-rota`: acrescenta-se uma
 * rota que a tabela nunca viu e exige-se que ela nasca GUARDADA. Se ela nascer
 * publica, o desenho esta errado -- e o erro nao apareceria em mais lado nenhum,
 * porque uma rota publica responde 200 e um 200 parece sucesso.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import type { PanelRoute } from '../../../src/panel/routes.ts'
import {
  PANEL_PATH_LOGIN,
  PANEL_PATH_MAGIC,
  PANEL_PATH_ROOT,
  PANEL_PATH_SECRET,
  PANEL_PATH_STATE,
  PANEL_ROUTE_POLICY,
  panelPublicRouteKeys,
  panelRoutes,
  policyForRoute,
  routeKeyOf,
} from '../../../src/panel/routes.ts'
import { criarBancada, pedir, type Bancada } from './harness.ts'

describe('a tabela de politica e enumerada e fecha por omissao', () => {
  it('PANEL-009: as isencoes sao exatamente as tres rotas de 01-ARQUITETURA 3(e)', () => {
    assert.deepEqual(panelPublicRouteKeys().toSorted(), [
      `GET ${PANEL_PATH_MAGIC}`,
      `GET ${PANEL_PATH_SECRET}`,
      `POST ${PANEL_PATH_LOGIN}`,
      `POST ${PANEL_PATH_MAGIC}`,
    ].toSorted())
  })

  it('as rotas do painel e do estado exigem sessao', () => {
    assert.equal(policyForRoute('GET', PANEL_PATH_ROOT), 'exige-sessao')
    assert.equal(policyForRoute('GET', PANEL_PATH_STATE), 'exige-sessao')
  })

  it('uma rota ausente da tabela responde `exige-sessao`, e nao `undefined`', () => {
    assert.equal(policyForRoute('GET', '/__guard/rota-que-nunca-existiu'), 'exige-sessao')
    assert.equal(policyForRoute('POST', '/__guard/api/tunnel/start'), 'exige-sessao')
    assert.equal(policyForRoute('DELETE', PANEL_PATH_ROOT), 'exige-sessao')
  })

  it('uma chave herdada do prototipo NAO e uma politica', () => {
    // Com um objeto literal em vez de um `Map`, `tabela['constructor']` devolvia
    // um valor verdadeiro herdado -- e uma consulta de politica que devolve lixo
    // verdadeiro e um buraco que revisao nenhuma apanha.
    assert.equal(PANEL_ROUTE_POLICY.get('constructor'), undefined)
    assert.equal(PANEL_ROUTE_POLICY.get('toString'), undefined)
    assert.equal(policyForRoute('GET', 'constructor'), 'exige-sessao')
  })

  it('a chave e canonicalizada dos dois lados: caixa, barra final e `..` nao abrem buraco', () => {
    assert.equal(routeKeyOf('get', '/__GUARD/MAGIC'), `GET ${PANEL_PATH_MAGIC}`)
    assert.equal(policyForRoute('GET', '/__guard/magic/'), 'publica')
    assert.equal(policyForRoute('GET', '//__guard//magic'), 'publica')
    assert.equal(policyForRoute('GET', '/__guard/x/../magic'), 'publica')
    // E o inverso: nada disto transforma uma rota guardada em publica.
    assert.equal(policyForRoute('GET', '/__guard/magic/../api/state'), 'exige-sessao')
  })
})

describe('o despachante aplica a tabela, e nao o objeto de rota', () => {
  let bancada: Bancada
  let port = 0

  /**
   * A rota intrusa. Ela nao tem nada de especial -- e exatamente isso que se
   * quer: se bastar acrescentar uma entrada a lista de rotas para servir algo
   * sem credencial, o controlo nao existe.
   */
  const ROTA_NOVA: PanelRoute = {
    method: 'GET',
    path: '/__guard/rota-nova-de-t53',
    handler: async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'ISTO NUNCA PODIA SER SERVIDO SEM SESSAO',
    }),
  }

  before(async () => {
    bancada = criarBancada()
    port = await bancada.servir((d, g) => [...panelRoutes(d, g), ROTA_NOVA])
  })

  after(async () => {
    await bancada.fechar()
  })

  it('PANEL-009-nova-rota: uma rota acrescentada sem tocar na tabela NASCE GUARDADA', async () => {
    const resposta = await pedir(port, ROTA_NOVA.path)

    assert.equal(resposta.status, 401)
    assert.match(String(resposta.headers['www-authenticate']), /^Basic realm=/u)
    assert.ok(!resposta.body.includes('ISTO NUNCA PODIA SER SERVIDO SEM SESSAO'))
  })

  it('a mesma rota nova responde com sessao valida -- ela existe, so nao e publica', async () => {
    const id = bancada.sessions.create()
    const resposta = await pedir(port, ROTA_NOVA.path, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal(resposta.status, 200)
    assert.equal(resposta.body, 'ISTO NUNCA PODIA SER SERVIDO SEM SESSAO')
  })
})

describe('as rotas guardadas antes do login', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({ estado: { state: 'READY', attempts: 0, info: { url: 'https://nao-pode-vazar.example', startedAt: 1, mode: 'quick' } } })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  it('PANEL-001: `GET /__guard` sem sessao e 401 e nao traz um byte do painel', async () => {
    const resposta = await pedir(port, PANEL_PATH_ROOT)

    assert.equal(resposta.status, 401)
    assert.match(String(resposta.headers['www-authenticate']), /^Basic realm="Secure DSH Interface"/u)
    assert.ok(!resposta.body.includes('<html'))
    assert.ok(!resposta.body.includes('dsh-csrf'))
  })

  it('PANEL-002: `GET /__guard/api/state` sem sessao nao revela estado nem URL', async () => {
    const resposta = await pedir(port, PANEL_PATH_STATE)

    assert.equal(resposta.status, 401)
    assert.ok(!resposta.body.includes('nao-pode-vazar'))
    assert.ok(!resposta.body.includes('READY'))
    assert.ok(!resposta.body.includes('state'))
  })

  it('uma sessao expirada e indistinguivel de nao haver sessao', async () => {
    const id = bancada.sessions.create()
    const semSessao = await pedir(port, PANEL_PATH_STATE)
    // 8 h e o teto absoluto; a sessao morre com ou sem atividade.
    bancada.clock.advance(9 * 60 * 60 * 1000)
    const expirada = await pedir(port, PANEL_PATH_STATE, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal(expirada.status, semSessao.status)
    assert.equal(expirada.body, semSessao.body)
    assert.equal(expirada.headers['www-authenticate'], semSessao.headers['www-authenticate'])
  })

  it('PANEL-003: uma rota inexistente sob `/__guard` e 404 e nao 401', async () => {
    const resposta = await pedir(port, '/__guard/rota-que-nao-existe')

    assert.equal(resposta.status, 404)
    assert.equal(resposta.headers['www-authenticate'], undefined)
  })

  it('um metodo que a tabela nao declara nao alcanca tratador nenhum', async () => {
    const resposta = await pedir(port, PANEL_PATH_SECRET, { method: 'POST', body: '' })
    assert.equal(resposta.status, 404)
  })

  it('um pedido fora de `/__guard` fecha em vez de delegar', async () => {
    const resposta = await pedir(port, '/api/commands/execute')
    assert.equal(resposta.status, 404)
  })

  it('o despacho e canonico: `/__guard/` e `/__GUARD/MAGIC` casam as rotas certas', async () => {
    // A canonicalizacao vale para os DOIS lados. Sem ela, `/__guard/` (o
    // endereco que D5 escreve, com barra) nunca casava a rota `/__guard` e o
    // painel respondia 404 a quem seguisse a documentacao.
    const id = bancada.sessions.create()
    const comBarra = await pedir(port, '/__guard/', { cookie: `__Host-dsh_sid=${id}` })
    assert.equal(comBarra.status, 200)
    assert.ok(comBarra.body.includes('<html'))

    const maiusculas = await pedir(port, '/__GUARD/MAGIC')
    assert.equal(maiusculas.status, 200)

    // E sobre-guardar continua a ser a direcao segura: a mesma canonicalizacao
    // NAO deixa `/__guard/x/../api/state` escapar ao gate.
    const escapatoria = await pedir(port, '/__guard/x/../api/state')
    assert.equal(escapatoria.status, 401)
  })
})
