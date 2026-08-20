/**
 * `GET /__guard/api/state` e `POST /__guard/api/login` -- `04-TESTES.md` 3.2
 * (`panel/api.test.ts`), PANEL-002 e `02-SEGURANCA.md` 6.1.
 *
 * DUAS PERGUNTAS ADVERSARIAIS SAO RESPONDIDAS AQUI:
 *
 *  - "o `/api/state` responde antes do login? o que vaza?" -- a URL do tunel e
 *    o endereco publico da maquina do dono. Os testes procuram a SUBSTRING da
 *    URL no corpo, e nao apenas o codigo de estado: um 401 com a URL no corpo
 *    passaria num teste de status.
 *  - "o login e um oraculo?" -- segredo errado, segredo certo sem conta
 *    provisionada, campo ausente e corpo malformado tem de produzir a MESMA
 *    resposta. Aqui compara-se estado, corpo E o conjunto inteiro de
 *    cabecalhos; a comparacao byte a byte no fio esta em
 *    `test/security/panel-exemptions.test.ts`.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { createAuditGate, projectSnapshot } from '../../../src/panel/api.ts'
import { CSRF_HEADER_NAME } from '../../../src/panel/csrf.ts'
import { PANEL_PATH_LOGIN, PANEL_PATH_STATE, routeKeyOf } from '../../../src/panel/routes.ts'
import { SESSION_ABSOLUTE_TIMEOUT_MS } from '../../../src/session/store.ts'
import { FakeClock } from '../../support/clock.ts'
import {
  criarBancada,
  pedir,
  sessaoDoCookie,
  SNAPSHOT_ONLINE,
  URL_DO_TUNEL,
  type Bancada,
} from './harness.ts'

describe('projeccao do estado', () => {
  it('`info` e `expiresAt` so saem em READY', () => {
    assert.deepEqual(projectSnapshot({ state: 'STOPPED', attempts: 0 }), {
      state: 'STOPPED',
      attempts: 0,
    })
  })

  it('DEFESA EM PROFUNDIDADE: `info` presente fora de READY e DESCARTADA', () => {
    // O contrato ja diz "presente sse READY". Isto prova que a fronteira nao
    // CONFIA no contrato: um supervisor com defeito que deixe `info` preenchida
    // em STARTING nao consegue publicar a URL do tunel por esta rota.
    const projetado = projectSnapshot({
      state: 'STARTING',
      attempts: 1,
      info: { url: URL_DO_TUNEL, startedAt: 1, mode: 'quick' },
      expiresAt: 999,
    })

    assert.equal(JSON.stringify(projetado).includes(URL_DO_TUNEL), false)
    assert.deepEqual(projetado, { state: 'STARTING', attempts: 1 })
  })

  it('BAIXA: a mensagem de falha nao entrega a URL do tunel nem o caminho no disco', () => {
    // A ASSIMETRIA QUE A REVISAO APANHOU: `info` era filtrada por desconfianca
    // do produtor e `message` era ACEITE dele. E o comentario chamava a `redact`
    // "o cinto por cima dos suspensorios" -- mas `redact.ts` DECLARA, no proprio
    // cabecalho, que nao cobre a URL do tunel. Ela saia intacta.
    const projetado = projectSnapshot({
      state: 'FAILED',
      attempts: 3,
      failure: {
        code: 'READINESS_TIMEOUT',
        message: `o tunel ${URL_DO_TUNEL} nao respondeu; veja /home/dono/.dsh/guarded-bot/audit.log`,
        retryable: true,
      },
    })

    const mensagem = String((projetado['failure'] as Record<string, unknown>)['message'])
    assert.equal(mensagem.includes(URL_DO_TUNEL), false, 'a URL do tunel saiu no fio')
    assert.equal(mensagem.includes('trycloudflare'), false)
    assert.equal(mensagem.includes('/home/dono'), false, 'o `$HOME` do dono saiu no fio')
    // E o que RESTA continua a ser accionavel -- mascarar nao pode virar apagar.
    assert.ok(mensagem.includes('nao respondeu'))
    // >>> A REGRA MUDOU NA COSTURA DA ONDA 3, E ISTO E O SEU LADO POSITIVO. <<<
    // O remendo local `maskAbsolutePaths` comia o caminho INTEIRO e o dono
    // ficava com "veja [REDACTED]", que nao diz onde procurar. A forma promovida
    // (`SECRET_SHAPES`, `src/logging/redact.ts`) mascara o `$HOME` e so ele: o
    // nome de conta sai, o ficheiro fica.
    assert.ok(mensagem.includes('audit.log'), 'o ficheiro a consultar tem de sobreviver')
  })

  it('a falha e projetada com o codigo e a sonda, e a mensagem e mascarada', () => {
    const projetado = projectSnapshot({
      state: 'FAILED',
      attempts: 5,
      failure: {
        code: 'PROBE_FAILED',
        probe: 'unguarded-canary',
        message: 'o canario respondeu 404: cookie: sid=abcdefghijkl',
        retryable: false,
      },
    })

    const falha = projetado['failure'] as Record<string, unknown>
    assert.equal(falha['code'], 'PROBE_FAILED')
    assert.equal(falha['probe'], 'unguarded-canary')
    assert.equal(falha['retryable'], false)
    assert.ok(!String(falha['message']).includes('sid=abcdefghijkl'))
  })
})

describe('ALTA-2 · o porteiro de auditoria nunca propaga', () => {
  it('`append` engole a falha do sink, regista no log do operador e nao lanca', () => {
    const logs: string[] = []
    const gate = createAuditGate({
      audit: {
        append: () => {
          throw new Error('nao foi possivel registar a auditoria - o gate TEM de negar')
        },
      },
      log: {
        info: () => {},
        warn: () => {},
        error: (m: string) => void logs.push(m),
        debug: () => {},
      },
      clock: new FakeClock(0),
    })

    // Antes desta correcao, esta excecao subia ao `catch` do despachante e o 404
    // do segredo virava 500 -- que ANUNCIA que a rota existe.
    assert.doesNotThrow(() => gate.append({ evento: 'x', resultado: 'negado' }))
    assert.doesNotThrow(() => gate.recordAnonymousRejection('y'))
    assert.equal(logs.length, 2)
    assert.ok(logs.every((l) => l.includes('falha ao registar auditoria')))
  })
})

describe('GET /__guard/api/state', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({ estado: SNAPSHOT_ONLINE })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  it('sem sessao, a URL do tunel NAO aparece no corpo', async () => {
    const resposta = await pedir(port, PANEL_PATH_STATE)

    assert.equal(resposta.status, 401)
    assert.equal(resposta.body.includes(URL_DO_TUNEL), false)
    assert.equal(resposta.body.includes('trycloudflare'), false)
  })

  it('com sessao, devolve o vocabulario INGLES de D7 e a URL', async () => {
    const id = bancada.sessions.create()
    const resposta = await pedir(port, PANEL_PATH_STATE, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal(resposta.status, 200)
    const payload = JSON.parse(resposta.body) as Record<string, unknown>
    assert.equal(payload['state'], 'READY')
    assert.deepEqual(payload['info'], {
      url: URL_DO_TUNEL,
      startedAt: 1_000,
      mode: 'quick',
    })
  })

  it('o payload nunca leva rotulo de interface -- eles vivem so no HTML (D7)', async () => {
    const id = bancada.sessions.create()
    const resposta = await pedir(port, PANEL_PATH_STATE, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal(resposta.body.includes('online'), false)
    assert.equal(resposta.headers['cache-control'], 'no-store')
  })
})

describe('POST /__guard/api/login', () => {
  let bancada: Bancada
  let port = 0
  let token = ''

  before(async () => {
    bancada = criarBancada({ comSegredo: true })
    port = await bancada.servir()
    token = bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))
  })

  after(async () => {
    await bancada.fechar()
  })

  const entrar = (corpo: Record<string, string>): Promise<ReturnType<typeof pedir> extends Promise<infer R> ? R : never> =>
    pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      body: new URLSearchParams(corpo).toString(),
    })

  it('o segredo certo emite `__Host-dsh_sid` com todos os atributos do prefixo', async () => {
    const resposta = await entrar({ segredo: String(bancada.segredo) })

    assert.equal(resposta.status, 200)
    const cookie = resposta.setCookie[0] ?? ''
    assert.match(cookie, /^__Host-dsh_sid=[A-Za-z0-9_-]{22,}; /u)
    assert.ok(cookie.includes('Path=/'))
    assert.ok(cookie.includes('Secure'))
    assert.ok(cookie.includes('HttpOnly'))
    assert.ok(cookie.includes('SameSite=Strict'))
    assert.ok(cookie.includes(`Max-Age=${Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)}`))
    assert.ok(!cookie.includes('Domain='))
  })

  it('o segredo agrupado com hifens e minusculas entra na mesma', async () => {
    const canonico = String(bancada.segredo)
    const agrupado = (canonico.match(/.{1,4}/gu) ?? []).join('-').toLowerCase()
    const resposta = await entrar({ segredo: agrupado })

    assert.equal(resposta.status, 200)
  })

  it('ANTI-FIXATION: o id apresentado deixa de valer no instante do login', async () => {
    const plantado = bancada.sessions.create()
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${plantado}`,
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

    const emitido = sessaoDoCookie(resposta.setCookie)
    assert.equal(resposta.status, 200)
    assert.notEqual(emitido, plantado)
    assert.equal(bancada.sessions.validate(plantado), null)
  })

  it('NENHUM ORACULO: senha errada e senha certa sem conta dao a MESMA resposta', async () => {
    const errada = await entrar({ segredo: 'ERRADAERRADAERRADA' })

    // Segunda bancada, sem segredo provisionado: e o caso "a credencial esta
    // certa mas a conta nao existe". O corpo do pedido leva o segredo CERTO da
    // primeira bancada.
    const semConta = criarBancada()
    const portaSemConta = await semConta.servir()
    const tokenSemConta = semConta.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))
    const inexistente = await pedir(portaSemConta, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: tokenSemConta },
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })
    await semConta.fechar()

    assert.equal(errada.status, 401)
    assert.equal(inexistente.status, errada.status)
    assert.equal(inexistente.body, errada.body)
    assert.deepEqual(inexistente.headers, errada.headers)
    assert.equal(errada.setCookie.length, 0)
    assert.equal(inexistente.setCookie.length, 0)
    // E o custo pedido ao limitador foi o mesmo nos dois caminhos.
    assert.deepEqual(semConta.esperas, [0])
  })

  it('campo ausente e corpo malformado sao a MESMA resposta que senha errada', async () => {
    const errada = await entrar({ segredo: 'ERRADA' })
    const semCampo = await entrar({})
    const malformado = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token, 'content-type': 'application/json' },
      body: '{isto nao e json',
    })

    for (const outra of [semCampo, malformado]) {
      assert.equal(outra.status, errada.status)
      assert.equal(outra.body, errada.body)
      assert.deepEqual(outra.headers, errada.headers)
    }
  })

  it('a resposta de recusa nao traz `Retry-After` nem contagem de tentativas', async () => {
    const resposta = await entrar({ segredo: 'ERRADA' })

    assert.equal(resposta.headers['retry-after'], undefined)
    assert.equal(resposta.status, 401)
    assert.equal(resposta.body, '{"ok":false}\n')
  })

  it('um corpo grande demais e cortado antes de ser interpretado', async () => {
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      body: `segredo=${'A'.repeat(8000)}`,
    })

    assert.equal(resposta.status, 413)
  })

  it('a auditoria distingue permitido de negado -- e nunca leva o segredo', async () => {
    bancada.eventos.length = 0
    await entrar({ segredo: 'ERRADA' })
    await entrar({ segredo: String(bancada.segredo) })

    assert.deepEqual(
      bancada.eventos.map((e) => `${e.evento}:${e.resultado}`),
      ['painel_login:negado', 'painel_login:permitido'],
    )
    const bruto = JSON.stringify(bancada.eventos)
    assert.equal(bruto.includes(String(bancada.segredo)), false)
  })

  it('nem o segredo nem o cookie emitido aparecem em log nenhum', () => {
    const tudo = bancada.logs.join('\n')
    assert.equal(tudo.includes(String(bancada.segredo)), false)
    assert.equal(tudo.includes('__Host-dsh_sid='), false)
  })
})

/**
 * =============================================================================
 * EMENDA 1 DA COSTURA -- O RESOLUTOR DE ORIGEM E O DE T3.3, E A CONDICAO E O MODO
 * =============================================================================
 * O painel tinha um `defaultResolveOrigin` local cuja condicao era "host
 * NAO-LOOPBACK => acredito no `X-Forwarded-Proto`". "Nao-loopback" nao e "atras
 * da borda": uma instalacao em LAN satisfaz a primeira e nao a segunda.
 *
 * A condicao correcta (`createRequestOriginResolver`, `src/http/session-auth.ts`)
 * e `exposure.mode === 'tunnel'` **E** o pedido ter chegado pelo nome publico do
 * tunel. A medicao que a legitima e R10 de `docs/spikes/cloudflared.md:155`: a
 * borda da Cloudflare SOBRESCREVE `X-Forwarded-Proto` (o cliente enviou `http`,
 * a origem viu `https`) -- garantia da BORDA, e so dela.
 *
 * OS DOIS SENTIDOS ESTAO AQUI, e sao o teste da emenda:
 *   - `mode: 'loopback'`: um `X-Forwarded-Proto: https` FORJADO nao muda nada;
 *   - `mode: 'tunnel'` + o pedido pelo nome publicado: muda.
 */
describe('EMENDA 1 -- em `loopback` o `X-Forwarded-Proto` forjado nao decide nada', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    // `exposure` AUSENTE => `LOOPBACK_ONLY_EXPOSURE`, a leitura mais fechada.
    bancada = criarBancada({ comSegredo: true })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  it('o esquema derivado continua `http`, e a sessao NAO e emitida', async () => {
    bancada.logs.length = 0
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: {
        [CSRF_HEADER_NAME]: bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN)),
        host: 'exemplo-de-teste.trycloudflare.com',
        'x-forwarded-proto': 'https',
      },
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

    // Com o resolutor ERRADO isto era 200 + cookie `Secure`: o cabecalho forjado
    // por qualquer maquina do segmento decidia o esquema.
    assert.equal(resposta.status, 500)
    assert.equal(resposta.setCookie.length, 0)
    assert.ok(bancada.logs.some((l) => l.includes('recusa emitir sessao')))
  })
})

describe('EMENDA 1 -- em `tunnel`, e vindo da borda, o cabecalho decide', () => {
  const HOST_DO_TUNEL = 'exemplo-de-teste.trycloudflare.com'
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({
      comSegredo: true,
      config: { exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false } },
      // O supervisor publicou a origem ao chegar a `READY` (emenda 2).
      tunnelOrigin: `https://${HOST_DO_TUNEL}`,
    })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  it('`Host` do tunel + `X-Forwarded-Proto: https` -> sessao emitida com `Secure`', async () => {
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: {
        [CSRF_HEADER_NAME]: bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN)),
        host: HOST_DO_TUNEL,
        'x-forwarded-proto': 'https',
      },
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

    assert.equal(resposta.status, 200)
    assert.ok((resposta.setCookie[0] ?? '').includes('Secure'))
  })

  it('MESMO modo, host que NAO e o publicado: nao passou pela borda, nao conta', async () => {
    bancada.logs.length = 0
    const resposta = await pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: {
        [CSRF_HEADER_NAME]: bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN)),
        host: '192.168.122.1:3080',
        'x-forwarded-proto': 'https',
      },
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

    assert.equal(resposta.status, 500)
    assert.equal(resposta.setCookie.length, 0)
  })

  it('o tunel CAIU (`publish(undefined)`): o mesmo pedido deixa de ser da borda', async () => {
    bancada.tunnelOrigin.publish(undefined)
    try {
      const resposta = await pedir(port, PANEL_PATH_LOGIN, {
        method: 'POST',
        headers: {
          [CSRF_HEADER_NAME]: bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN)),
          host: HOST_DO_TUNEL,
          'x-forwarded-proto': 'https',
        },
        body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
      })

      assert.equal(resposta.status, 500)
    } finally {
      bancada.tunnelOrigin.publish(`https://${HOST_DO_TUNEL}`)
    }
  })
})

describe('a origem decide se ha sessao -- e falha ALTO quando nao pode haver', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({ comSegredo: true })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  const entrar = (cabecalhos: Record<string, string>): Promise<Awaited<ReturnType<typeof pedir>>> =>
    pedir(port, PANEL_PATH_LOGIN, {
      method: 'POST',
      headers: {
        [CSRF_HEADER_NAME]: bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN)),
        ...cabecalhos,
      },
      body: new URLSearchParams({ segredo: String(bancada.segredo) }).toString(),
    })

  it('LAN em `http` sem TLS: recusa ALTA, e nao um ciclo de login infinito', async () => {
    bancada.logs.length = 0
    const resposta = await entrar({ host: '192.168.122.1:3080' })

    // O navegador DESCARTA em silencio um cookie `Secure` emitido por HTTP
    // nao-loopback (medido nos dois motores, spike S10). Emiti-lo seria um
    // login que "funciona" e nunca autentica. Fecha-se, e o operador ve porque.
    assert.equal(resposta.status, 500)
    assert.equal(resposta.setCookie.length, 0)
    assert.ok(bancada.logs.some((l) => l.includes('recusa emitir sessao')))
  })
})
