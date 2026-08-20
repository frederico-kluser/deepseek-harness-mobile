/**
 * =============================================================================
 * L2.5 -- DNS REBINDING. Suite adversarial de T3.3, contra sockets REAIS.
 * =============================================================================
 *
 * O ATAQUE, em quatro passos, e porque nenhuma das outras duas allowlists o
 * apanha:
 *
 *   1. a vitima abre `http://evil.com`, que resolve para um IP do atacante;
 *   2. o registo expira em 1 s e passa a resolver para `127.0.0.1`;
 *   3. o JavaScript da pagina, ainda na origem `evil.com`, faz `fetch` para
 *      `http://evil.com:<porta>/api/...`;
 *   4. o pedido chega ao NOSSO servidor com `Host: evil.com` -- e a same-origin
 *      policy nao se opoe, porque para o navegador continua a ser a mesma
 *      origem.
 *
 * `trustedRemotes` nao ve nada: a ponta remota E `127.0.0.1`. `allowedHosts` nao
 * ve nada: o BIND continua a ser loopback. O unico sinal e o NOME pelo qual o
 * recurso foi pedido, e e esse que esta camada valida.
 *
 * PORQUE COM SERVIDOR REAL E PORTA EFEMERA: o cabecalho `Host` e escrito pela
 * pilha HTTP do cliente. Provar a defesa com um objeto literal provaria a funcao
 * e nao o caminho -- e o caminho inclui o `node:http` a montar o cabecalho.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { UNAUTHENTICATED_PANEL_PREFIXES } from '../../src/index.ts'
import { bancada, basic, OWNER_SECRET, type Bancada } from '../unit/http/bancada.ts'

const TUNNEL_HOST = 'marks-organization-moved-coupons.trycloudflare.com'

let b: Bancada
let server: Server
let port = 0
let reverter: (() => void) | undefined
/** O que o "resto do DSH" recebeu -- para provar a reescrita de `Host`. */
let ultimoHostVisto: string | undefined

before(async () => {
  server = createServer()
  server.on('request', (req, res) => {
    ultimoHostVisto = req.headers.host
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('{"rota":"api"}')
  })
  server.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  b = bancada({
    comSegredo: true,
    tunnelReady: true,
    loopbackAuthority: `127.0.0.1:${String(port)}`,
    // As isencoes REAIS. Sem elas, `/__guard/secret` exigia credencial e os
    // testes de L2.6 passavam por outra razao que nao a que dizem testar.
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
  })
  reverter = installAuthBarrier(
    server,
    {
      wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'sec:request'),
      wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'sec:upgrade'),
    },
    b.gate.log,
  )
})

after(async () => {
  reverter?.()
  b.cleanup()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface Resposta {
  readonly status: number
  readonly body: string
  /** `WWW-Authenticate`. Tem de ser `undefined` em todo o 403: um 403 que
   *  desafia credencial e o oraculo que a ordem 403-antes-de-401 fecha. */
  readonly challenge: string | undefined
}

/** Pedido com o cabecalho `Host` ESCOLHIDO -- e o que o rebinding faz. */
function pedirComHost(
  host: string,
  credencial?: string,
  path = '/api/state',
  extra: Readonly<Record<string, string>> = {},
): Promise<Resposta> {
  return new Promise<Resposta>((resolve, reject) => {
    const headers: Record<string, string> = { host, ...extra }
    if (credencial !== undefined) headers['authorization'] = credencial

    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body, challenge: res.headers['www-authenticate'] }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

describe('Host forjado (DNS rebinding)', () => {
  it('>>> Host: evil.com E RECUSADO, com credencial CORRETA e tudo <<<', async () => {
    const res = await pedirComHost('evil.com', basic(OWNER_SECRET))

    assert.equal(res.status, 403, 'a credencial certa nao compra um nome que nao e nosso')
    assert.equal(res.body.includes('rota'), false, 'o despacho original NAO pode ser alcancado')
  })

  it('recusa a familia inteira de nomes que se parecem com o nosso', async () => {
    for (const host of [
      'evil.com',
      '127.0.0.1.evil.com',
      'localhost.evil.com',
      `${TUNNEL_HOST}.evil.com`,
      'notlocalhost',
      // IPv4 em decimal: nao casa com a allowlist, logo fecha por omissao.
      '2130706433',
    ]) {
      const res = await pedirComHost(host, basic(OWNER_SECRET))
      assert.equal(res.status, 403, `Host aceite indevidamente: ${host}`)
    }
  })

  it('o 403 do Host e IDENTICO ao 403 da origem -- nao diz qual camada barrou', async () => {
    // Distinguir os dois diria ao atacante QUAL camada o barrou, e portanto qual
    // vale a pena atacar a seguir.
    const doHost = await pedirComHost('evil.com', basic(OWNER_SECRET))
    assert.equal(doHost.status, 403)
    assert.equal(doHost.body, 'Acesso Intercetado: origem nao confiada.\n')
  })
})

describe('as grafias equivalentes de loopback sao aceites', () => {
  it('todas passam, e passam pela MESMA normalizacao das entradas da lista', async () => {
    for (const host of [
      `127.0.0.1:${String(port)}`,
      '127.0.0.1',
      '[::1]',
      `[::1]:${String(port)}`,
      '[0:0:0:0:0:0:0:1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      `localhost:${String(port)}`,
      '127.0.0.1.',
    ]) {
      const res = await pedirComHost(host, basic(OWNER_SECRET))
      assert.equal(res.status, 200, `grafia de loopback recusada: ${host}`)
    }
  })

  it('sem credencial continua a ser 401 -- L2.5 nao substitui L3', async () => {
    const res = await pedirComHost(`127.0.0.1:${String(port)}`)
    assert.equal(res.status, 401)
  })
})

describe('o nome publico do tunel', () => {
  it('e aceite enquanto READY e reescrito para loopback DEPOIS de autenticar', async () => {
    ultimoHostVisto = undefined
    const res = await pedirComHost(TUNNEL_HOST, basic(OWNER_SECRET))

    assert.equal(res.status, 200)
    assert.equal(
      ultimoHostVisto,
      `127.0.0.1:${String(port)}`,
      'sem a reescrita o nucleo do DSH devolve 403 em /api (medido no spike T0.4)',
    )
  })

  it('sem credencial NAO passa, mesmo com o nome do tunel', async () => {
    ultimoHostVisto = undefined
    const res = await pedirComHost(TUNNEL_HOST)

    assert.equal(res.status, 401)
    assert.equal(ultimoHostVisto, undefined, 'nada chegou ao despacho original')
  })

  it('SAI da allowlist quando o tunel cai -- e volta a ser 403', async () => {
    b.tunnelOrigin.publish(undefined)
    try {
      const res = await pedirComHost(TUNNEL_HOST, basic(OWNER_SECRET))
      assert.equal(res.status, 403)
    } finally {
      b.tunnelOrigin.publish(`https://${TUNNEL_HOST}`)
    }
  })
})

describe('SOSIAS DE LOOPBACK -- o parser tem de recusar a forma, nao so o nome', () => {
  /**
   * OS VETORES QUE A VERSAO ANTERIOR DO PARSER ACEITOU, medidos com socket cru
   * contra uma rota a servir o segredo. Todos canonicalizavam para `127.0.0.1`
   * e passavam L2.5 E L2.6.
   *
   * `stripPort` tratava TUDO depois do primeiro `:` como porta, sem olhar para o
   * que la estava, e ignorava TUDO depois do `]`. Nenhum NAVEGADOR produz estas
   * formas -- o `Host` sai de uma autoridade ja parseada --, mas qualquer cliente
   * que escreva cabecalhos crus produz, e ALCANCABILIDADE E PROPRIEDADE DA
   * TOPOLOGIA: muda em `mode: 'named'` ou com um proxy a frente. L2.5 e a camada
   * que a reescrita de `Host` nomeia como sustentacao da garantia depois de
   * desarmar o anti-rebinding do nucleo -- ela nao pode aceitar sosias.
   */
  const SOSIAS = [
    '127.0.0.1:1234@evil.com', // userinfo colado depois da porta
    '127.0.0.1:evil.com', // "porta" que nao e um numero
    '[::1]evil.com', // lixo depois do `]`
    '[127.0.0.1]qualquer-coisa', // idem, com IPv4 entre parenteses
    '[::1', // parenteses sem fecho
    'user@127.0.0.1', // userinfo, que o `Host` nao tem
    '127.0.0.1:80:90', // duas "portas"
    '127.0.0.1: 80', // branco no meio da autoridade
    '127.0.0.1:8o', // digito trocado por letra
  ]

  it('>>> nenhum sosia e servido, nem sequer com a credencial CORRETA <<<', async () => {
    for (const host of SOSIAS) {
      const res = await pedirComHost(host, basic(OWNER_SECRET))
      assert.equal(res.status, 403, `SOSIA ACEITE COMO LOOPBACK: ${host}`)
      assert.equal(res.body.includes('rota'), false, `despacho alcancado por: ${host}`)
    }
  })

  it('e nenhum sosia destranca a rota de CANAL LOCAL APENAS', async () => {
    // O impacto real do defeito: `/__guard/secret` serve o SEGREDO PERSISTENTE, e
    // L2.6 so o protege se o parser souber o que e loopback.
    for (const host of SOSIAS) {
      const res = await pedirComHost(host, undefined, '/__guard/secret?ott=AAAA')
      assert.notEqual(res.status, 200, `SOSIA destrancou o segredo: ${host}`)
    }
  })

  it('CURINGA DELIBERADO: `*.localhost` E aceite, e isso e uma decisao', async () => {
    // `evil.localhost` PASSA, de proposito. `localhost` e subdominios sao
    // loopback por norma (RFC 6761 6.3) e a definicao W3C de origem
    // potencialmente confiavel inclui-os -- e `isTrustworthyOrigin`
    // (`src/session/cookie.ts`) usa exatamente o mesmo conjunto. Diverge-los
    // criaria um nome que entrega cookie e nao passa no portao, ou o contrario.
    //
    // Fica AQUI, ao lado dos sosias, porque e um curinga dentro de uma allowlist
    // que se declara EXATA, e quem ler tem de o ver.
    const res = await pedirComHost('evil.localhost', basic(OWNER_SECRET))
    assert.equal(res.status, 200, 'o curinga *.localhost e deliberado -- ver o comentario')
  })

  it('as formas legitimas continuam a passar -- recusar tudo nao e defender', async () => {
    for (const host of [`127.0.0.1:${String(port)}`, '[::1]:8080', '[::1]', '127.0.0.1']) {
      const res = await pedirComHost(host, basic(OWNER_SECRET))
      assert.equal(res.status, 200, `forma legitima recusada: ${host}`)
    }
  })
})

describe('A ORDEM DAS CAMADAS E CONTRATO -- L2 e L2.5 ANTES de L3', () => {
  it('sessao VALIDA nao curto-circuita L2.5: Host forjado continua 403', async () => {
    // Era o teste que faltava, e e a metade anti-DNS-rebinding da ordem --
    // rebinding e precisamente o ataque em que a vitima TRAZ estado autenticado.
    const cookie = b.emitirSessao()

    const res = await pedirComHost('evil.com', undefined, '/api/state', { cookie })

    assert.equal(res.status, 403, 'com cookie valido, o Host forjado tem de continuar a ser 403')
    assert.equal(res.challenge, undefined, '403 nao desafia credencial')
    assert.equal(res.body.includes('rota'), false)
  })

  it('sessao VALIDA nao destranca a rota de canal local pelo nome do tunel', async () => {
    const cookie = b.emitirSessao()

    const res = await pedirComHost(TUNNEL_HOST, undefined, '/__guard/secret?ott=AAAA', { cookie })

    assert.equal(res.status, 404, 'L2.6 corre antes de L3, e a sessao nao a dispensa')
  })
})

describe('A ORDEM DAS CAMADAS E CONTRATO -- perimetro fechado (trustedRemotes vazio)', () => {
  let fechado: Bancada
  let servidorFechado: Server
  let portaFechada = 0
  let reverterFechado: (() => void) | undefined

  before(async () => {
    servidorFechado = createServer()
    servidorFechado.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('SERVIDO')
    })
    await new Promise<void>((resolve) => servidorFechado.listen(0, '127.0.0.1', resolve))
    portaFechada = (servidorFechado.address() as AddressInfo).port

    // `trustedRemotes: []` = NINGUEM e confiado, nem o proprio loopback. E a
    // politica fail-closed literal, e e o unico modo de exercitar L2 com um
    // socket REAL: um teste nao consegue vir de 10.0.0.7 para 127.0.0.1.
    fechado = bancada({
      comSegredo: true,
      loopbackAuthority: `127.0.0.1:${String(portaFechada)}`,
      config: { trustedRemotes: [] },
    })
    reverterFechado = installAuthBarrier(
      servidorFechado,
      {
        wrapRequest: (delegate) => createGuardedHandler(fechado.gate, delegate, 'ordem:request'),
        wrapUpgrade: (delegate) => createGuardedUpgradeHandler(fechado.gate, delegate, 'ordem:upgrade'),
      },
      fechado.gate.log,
    )
  })

  after(async () => {
    reverterFechado?.()
    fechado.cleanup()
    await new Promise<void>((resolve) => servidorFechado.close(() => resolve()))
  })

  function pedirFechado(extra: Readonly<Record<string, string>> = {}): Promise<Resposta> {
    return new Promise<Resposta>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: portaFechada,
          path: '/api/state',
          method: 'GET',
          headers: { host: `127.0.0.1:${String(portaFechada)}`, ...extra },
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            body += chunk
          })
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body, challenge: res.headers['www-authenticate'] }),
          )
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  it('>>> SEM credencial: 403, e NUNCA 401 -- e o que prega L2 antes de L3 <<<', async () => {
    // Este e o teste que morre se alguem mover o perimetro para DEPOIS da
    // autenticacao: nessa ordem, um pedido sem credencial leva 401 e a
    // diferenca entre "a tua origem nunca sera aceite" e "tenta outra senha"
    // desaparece -- que e o oraculo que a ordem existe para fechar.
    const res = await pedirFechado()

    assert.equal(res.status, 403)
    assert.equal(res.challenge, undefined, '403 nao pode convidar a repetir a credencial')
    assert.equal(res.body.includes('SERVIDO'), false)
  })

  it('com credencial ERRADA: continua 403, nao 401', async () => {
    const res = await pedirFechado({ authorization: basic('errada') })
    assert.equal(res.status, 403)
    assert.equal(res.challenge, undefined)
  })

  it('com a credencial CERTA: continua 403 -- a credencial nao compra a origem', async () => {
    const res = await pedirFechado({ authorization: basic(OWNER_SECRET) })
    assert.equal(res.status, 403)
    assert.equal(res.body.includes('SERVIDO'), false)
  })

  it('>>> com SESSAO VALIDA: continua 403 -- a sessao nao curto-circuita L2 <<<', async () => {
    const cookie = `__Host-dsh_sid=${fechado.stack.sessions.create()}`

    const res = await pedirFechado({ cookie })

    assert.equal(res.status, 403, 'se isto virar 401 ou 200, a ordem 403-antes-de-401 perdeu-se')
    assert.equal(res.body.includes('SERVIDO'), false)
  })
})
