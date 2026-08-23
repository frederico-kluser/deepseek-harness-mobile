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
import { CSRF_HEADER_NAME } from '../../../src/panel/csrf.ts'
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
    // ONDA 1/2: o painel NAO pede senha — o 401 e TEXTO PURO, SEM desafio.
    assert.equal(resposta.headers['www-authenticate'], undefined, 'sem WWW-Authenticate (nada de popup)')
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
    // ONDA 1/2 (expose-port): o painel nunca pede senha — 401 em TEXTO PURO,
    // sem `WWW-Authenticate` (sem popup de login), como o do gate.
    assert.equal(resposta.headers['www-authenticate'], undefined, 'sem desafio Basic')
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

/* ========================================================================== */
/* defaultWait — a espera de producao (sem deps.wait injetado)                 */
/* ========================================================================== */

describe('defaultWait — o fallback de producao quando nao ha relogio injetado', () => {
  it('espera de 0 ms resolve de imediato (o login feliz nao atrasa)', async () => {
    // `wait: undefined` deliberado: o fallback de producao (defaultWait) entra.
    const bancada = criarBancada({ comSegredo: true, deps: { wait: undefined as never } })
    const port = await bancada.servir()
    try {
      const token = bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))
      const resposta = await pedir(port, PANEL_PATH_LOGIN, {
        method: 'POST',
        headers: { [CSRF_HEADER_NAME]: token },
        body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
      })
      assert.equal(resposta.status, 200, 'login com segredo certo e de imediato (sem espera real)')
    } finally {
      await bancada.fechar()
    }
  })

  it('com falhas suficientes, a espera REAL do setTimeout corre (castigo do limitador)', async () => {
    // `wait: undefined` deliberado: o fallback de producao (defaultWait) entra.
    const bancada = criarBancada({ comSegredo: true, deps: { wait: undefined as never } })
    const port = await bancada.servir()
    try {
      const token = bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))
      const falhar: () => ReturnType<typeof pedir> = () =>
        pedir(port, PANEL_PATH_LOGIN, {
          method: 'POST',
          headers: { [CSRF_HEADER_NAME]: token },
          body: new URLSearchParams({ segredo: 'senha-errada' }).toString(),
        })
      // As quatro primeiras saem imediatas (freeFailures); a sexta ja espera
      // o atraso real (>= 500 ms com o full jitter da bancada).
      for (let i = 0; i < 6; i += 1) {
        const resposta = await falhar()
        assert.equal(resposta.status, 401, 'tentativa ' + String(i + 1))
      }
      assert.ok(bancada.esperas.length === 0, 'o wait injetado nao foi usado (e o default real)')
    } finally {
      await bancada.fechar()
    }
  })
})

/* ========================================================================== */
/* O despachante — o catch de topo fecha com 500 (nunca um meio-painel)        */
/* ========================================================================== */

describe('o catch do despachante — nenhum caminho de erro termina em "deixa passar"', () => {
  it('um handler que LANCA vira 500 generico, com log do operador (S4)', async () => {
    const bancada = criarBancada()
    const logsAntes = bancada.logs.length
    const port = await bancada.servir((_d, _g) => [
      {
        method: 'GET',
        path: '/__guard/bomba',
        handler: async () => {
          throw new Error('detalhe interno do handler')
        },
      },
    ])
    try {
      const id = bancada.sessions.create()
      const resposta = await pedir(port, '/__guard/bomba', { cookie: '__Host-dsh_sid=' + id })

      assert.equal(resposta.status, 500)
      assert.ok(!resposta.body.includes('detalhe interno'), 'o detalhe interno nao sai no corpo')
      assert.ok(bancada.logs.slice(logsAntes).some((l) => l.includes('excecao ao servir')))
    } finally {
      await bancada.fechar()
    }
  })

  it('a mesma rota intrusa continua GUARDADA para o anonimo (o 500 nao vira rota publica)', async () => {
    const bancada = criarBancada()
    const port = await bancada.servir((_d, _g) => [
      {
        method: 'GET',
        path: '/__guard/bomba',
        handler: async () => {
          throw new Error('boom')
        },
      },
    ])
    try {
      const resposta = await pedir(port, '/__guard/bomba')
      assert.equal(resposta.status, 401, 'sem sessao: o gate corre ANTES do handler')
    } finally {
      await bancada.fechar()
    }
  })
})
