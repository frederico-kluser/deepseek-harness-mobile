/**
 * =============================================================================
 * O PORTAO VISTO DE FORA -- pela URL do tunel, nao por `curl` no loopback.
 * =============================================================================
 *
 * A pergunta falsificavel que esta suite responde: *"com o tunel ligado, um
 * `POST /api/...` sem credencial vindo DE FORA devolve 401?"*. Prova-la com um
 * pedido ao `127.0.0.1` seria responder a outra pergunta -- a de dentro.
 *
 * Por isso ha aqui DOIS servidores reais, em portas efemeras:
 *
 *   BORDA FALSA  imita o `cloudflared` + a borda da Cloudflare, e imita-a nos
 *                dois comportamentos MEDIDOS no spike S2, que sao os que
 *                importam para a decisao:
 *                  - reescreve `Host` para o hostname publico do tunel e
 *                    encaminha para `127.0.0.1:<porta do portao>`;
 *                  - acrescenta `CF-Connecting-IP` com o IP real e RECUSA na
 *                    PROPRIA BORDA (403, `error code: 1000`) o pedido em que o
 *                    cliente envia esse cabecalho (caso R3);
 *                  - SOBRESCREVE `X-Forwarded-Proto` (caso R10).
 *   PORTAO       o `node:http.Server` com a barreira instalada, exatamente como
 *                em producao.
 *
 * >>> NENHUM `cloudflared` E INVOCADO (D10). <<< Um tunel a serio publica na
 * internet o que estiver na porta -- foi assim que a pesquisa expos o DSH real
 * do utilizador durante ~40 s.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { after, before, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../../src/http/gate.ts'
import { installAuthBarrier } from '../../../src/http/intercept.ts'
import { UNAUTHENTICATED_PANEL_PREFIXES } from '../../../src/index.ts'
import { bancada, basic, OWNER_SECRET, type Bancada } from '../../unit/http/bancada.ts'

const TUNNEL_HOST = 'marks-organization-moved-coupons.trycloudflare.com'
const TUNNEL_URL = `https://${TUNNEL_HOST}`
/** O IP real do cliente, como a borda o entrega. */
const CLIENT_IP = '203.0.113.9'

let b: Bancada
let portao: Server
let borda: Server
let portaoPort = 0
let bordaPort = 0
let reverter: (() => void) | undefined

/** O que o "resto do DSH" viu -- para provar a reescrita de `Host`. */
let ultimoPedido: { host: string | undefined; origin: string | undefined } | undefined

/**
 * Leitura indireta de {@link ultimoPedido}.
 *
 * O `tsc` estreita a variavel para `undefined` depois do `ultimoPedido =
 * undefined` do teste: ele nao ve que quem a escreve e o callback do servidor.
 * A funcao devolve o tipo declarado e nao a analise de fluxo.
 */
function pedidoVisto(): { host: string | undefined; origin: string | undefined } | undefined {
  return ultimoPedido
}

function ouvir(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

before(async () => {
  /* ---- O PORTAO ------------------------------------------------------- */
  portao = createServer()
  portao.on('request', (req: IncomingMessage, res: ServerResponse) => {
    ultimoPedido = { host: req.headers.host, origin: req.headers.origin }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"rota":"api"}')
  })
  portao.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
  })
  portaoPort = await ouvir(portao)

  b = bancada({
    comSegredo: true,
    tunnelReady: true,
    loopbackAuthority: `127.0.0.1:${String(portaoPort)}`,
    // As isencoes REAIS do plugin -- e nao uma lista de teste. O furo que esta
    // suite fecha so existe quando `/__guard/secret` esta mesmo isento.
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
    config: {
      exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: true },
      tunnel: { mode: 'quick', ttlMinutes: 60 },
    },
  })
  b.tunnelOrigin.publish(TUNNEL_URL)

  reverter = installAuthBarrier(
    portao,
    {
      wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'tunel:request'),
      wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'tunel:upgrade'),
    },
    b.gate.log,
  )

  /* ---- A BORDA FALSA -------------------------------------------------- */
  borda = createServer((entrada, saida) => {
    // Caso R3, medido: a borda RECUSA quem enviar `CF-Connecting-IP`.
    if (entrada.headers['cf-connecting-ip'] !== undefined) {
      saida.writeHead(403, { 'Content-Type': 'text/plain' })
      saida.end('error code: 1000\n')
      return
    }

    const headers: Record<string, string> = {}
    for (const [nome, valor] of Object.entries(entrada.headers)) {
      if (typeof valor === 'string') headers[nome] = valor
    }
    headers['host'] = TUNNEL_HOST
    headers['cf-connecting-ip'] = CLIENT_IP
    headers['x-forwarded-proto'] = 'https' // R10: SOBRESCRITO, nunca acrescentado.
    headers['x-forwarded-for'] =
      entrada.headers['x-forwarded-for'] === undefined
        ? CLIENT_IP
        : `${String(entrada.headers['x-forwarded-for'])},${CLIENT_IP}`

    const encaminhado = request(
      { host: '127.0.0.1', port: portaoPort, path: entrada.url ?? '/', method: entrada.method, headers },
      (resposta) => {
        saida.writeHead(resposta.statusCode ?? 502, resposta.headers)
        resposta.pipe(saida)
      },
    )
    encaminhado.on('error', () => {
      saida.writeHead(502)
      saida.end()
    })
    entrada.pipe(encaminhado)
  })
  bordaPort = await ouvir(borda)
})

after(async () => {
  reverter?.()
  b.cleanup()
  await new Promise<void>((resolve) => borda.close(() => resolve()))
  await new Promise<void>((resolve) => portao.close(() => resolve()))
})

interface Resposta {
  readonly status: number
  readonly body: string
  readonly challenge: string | undefined
}

/** Um pedido PELA URL PUBLICA do tunel -- atravessa a borda. */
function pedirDeFora(
  path: string,
  options: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<Resposta> {
  return new Promise<Resposta>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: bordaPort,
        path,
        method: options.method ?? 'POST',
        headers: { host: TUNNEL_HOST, ...options.headers },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            challenge: res.headers['www-authenticate'],
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

/** O mesmo pedido, mas PELO LOOPBACK -- sem passar pela borda. */
function pedirNoLoopback(path: string): Promise<Resposta> {
  return new Promise<Resposta>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: portaoPort,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${String(portaoPort)}` },
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

describe('a pergunta falsificavel: 401 de fora, pela URL do tunel', () => {
  it('>>> POST /api/commands/execute SEM credencial, vindo de fora -> 401 <<<', async () => {
    ultimoPedido = undefined

    const res = await pedirDeFora('/api/commands/execute', {
      // O comando perigoso viaja no CORPO. O portao decide SEM o ler.
      body: JSON.stringify({ command: '/permission danger-full-access' }),
      headers: { 'content-type': 'application/json' },
    })

    assert.equal(res.status, 401, `URL publica: ${TUNNEL_URL}/api/commands/execute`)
    assert.equal(res.challenge, undefined, 'o 401 do tunel NAO emite WWW-Authenticate (nao ha popup)')
    assert.equal(pedidoVisto(), undefined, 'nada chegou a sub-estacao /api')
  })

  it('o fallback da SPA e as rotas nomeadas tambem levam 401 de fora', async () => {
    for (const path of ['/', '/api/state', '/plugins/x', '/__dsh_invariant_probe__']) {
      const res = await pedirDeFora(path, { method: 'GET' })
      assert.equal(res.status, 401, `${TUNNEL_URL}${path} respondeu ${String(res.status)}`)
    }
  })

  it('com o segredo do dono, o trafego chega -- e com o Host ja reescrito', async () => {
    ultimoPedido = undefined

    const res = await pedirDeFora('/api/state', {
      method: 'GET',
      headers: { authorization: basic(OWNER_SECRET), origin: TUNNEL_URL },
    })

    assert.equal(res.status, 200)
    const visto = pedidoVisto() ?? { host: undefined, origin: undefined }
    assert.equal(
      visto.host,
      `127.0.0.1:${String(portaoPort)}`,
      'sem a reescrita o nucleo do DSH devolve 403 em /api (medido, spike T0.4)',
    )
    assert.equal(visto.origin, undefined, 'a cerca de borda do nucleo tem de sair junto')
  })
})

describe('a identidade vem do UNICO cabecalho medido', () => {
  it('o audit log regista o IP da borda, e nao o 127.0.0.1 do socket', async () => {
    await pedirDeFora('/api/state', {
      method: 'GET',
      headers: { authorization: basic('errada-de-proposito') },
    })

    const linhas = readFileSync(b.auditPath, 'utf8').trim().split('\n')
    const ultima = linhas[linhas.length - 1] ?? ''
    assert.equal(ultima.includes(`"ip_normalizado":"${CLIENT_IP}"`), true, ultima)
  })

  it('a borda RECUSA (403) quem forjar CF-Connecting-IP -- e por isso ele e confiavel', async () => {
    const res = await pedirDeFora('/api/state', {
      method: 'GET',
      headers: { 'cf-connecting-ip': '1.2.3.4', authorization: basic(OWNER_SECRET) },
    })

    assert.equal(res.status, 403)
    assert.equal(res.body.includes('error code: 1000'), true, 'e a borda a recusar, nao o portao')
  })

  it('um X-Forwarded-For forjado nao muda a identidade -- ele e ACRESCENTADO', async () => {
    await pedirDeFora('/api/state', {
      method: 'GET',
      headers: { 'x-forwarded-for': '1.2.3.4', authorization: basic('errada-outra-vez') },
    })

    const linhas = readFileSync(b.auditPath, 'utf8').trim().split('\n')
    const ultima = linhas[linhas.length - 1] ?? ''
    assert.equal(ultima.includes('1.2.3.4'), false, 'o IP escolhido pelo cliente NUNCA entra')
    assert.equal(ultima.includes(`"ip_normalizado":"${CLIENT_IP}"`), true, ultima)
  })
})

describe('quando o tunel cai, o nome deixa de valer', () => {
  it('a mesma URL passa a 403 assim que a origem sai do registo', async () => {
    b.tunnelOrigin.publish(undefined)
    try {
      const res = await pedirDeFora('/api/state', {
        method: 'GET',
        headers: { authorization: basic(OWNER_SECRET) },
      })
      assert.equal(res.status, 403, 'um nome derrubado volta a ser distribuido a outra pessoa')
    } finally {
      b.tunnelOrigin.publish(TUNNEL_URL)
    }
  })
})

describe('CANAL LOCAL APENAS: /__guard/secret nao sai pela internet', () => {
  const OTT = 'A'.repeat(26)

  it('>>> pelo TUNEL, com ott, e 404 -- e a rota nunca e invocada <<<', async () => {
    // O furo que este teste fecha: `/__guard/secret` esta ISENTO de credencial
    // (quem o vem buscar e quem ainda nao tem o segredo), e sob tunel L2 e L2.5
    // passam as duas -- o socket vem do `cloudflared` em 127.0.0.1, e a origem
    // do tunel esta na allowlist de `Host` por desenho. Sem L2.6, isto servia o
    // SEGREDO PERSISTENTE em texto claro a partir da internet publica.
    ultimoPedido = undefined

    const res = await pedirDeFora(`/__guard/secret?ott=${OTT}`, { method: 'GET' })

    assert.equal(res.status, 404, `${TUNNEL_URL}/__guard/secret respondeu ${String(res.status)}`)
    assert.equal(pedidoVisto(), undefined, 'a rota do segredo NAO pode ser invocada')
  })

  it('a recusa e o 404 GENERICO -- nunca 403, que confirmaria que a rota existe', async () => {
    const res = await pedirDeFora(`/__guard/secret?ott=${OTT}`, { method: 'GET' })

    assert.equal(res.status, 404)
    assert.equal(res.body, 'Not Found\n', 'o corpo tem de ser o de `denyNotFound`, byte a byte')
    assert.equal(res.challenge, undefined, 'um 401 tambem confirmaria a rota')
    assert.equal(res.body.includes('guard'), false, 'o corpo nao pode ter marca deste plugin')
    assert.equal(res.body.includes('Acesso Intercetado'), false)
  })

  it('um caminho DESCENDENTE do prefixo tambem nao escapa', async () => {
    const res = await pedirDeFora('/__guard/secret/qualquer-coisa', { method: 'GET' })
    assert.equal(res.status, 404)
  })

  it('>>> CASO DE CONTROLO: pelo LOOPBACK a rota continua a ser servida <<<', async () => {
    // Sem isto, o teste acima passava com a rota simplesmente PARTIDA.
    ultimoPedido = undefined

    const res = await pedirNoLoopback(`/__guard/secret?ott=${OTT}`)

    assert.equal(res.status, 200, 'o dono, na maquina dele, TEM de conseguir rever o segredo')
    assert.equal(
      pedidoVisto()?.host,
      `127.0.0.1:${String(portaoPort)}`,
      'o pedido chegou ao despacho original',
    )
  })

  it('as outras duas isencoes CONTINUAM a passar pelo tunel', async () => {
    // `/__guard/magic` existe para ser aberto do telemovel PELO tunel, e
    // `/__guard/api/login` tem de ser alcancavel de fora ou nao ha como
    // autenticar. Tranca-las no loopback nao endurecia nada -- partia o produto.
    for (const path of ['/__guard/magic?mk=abc', '/__guard/api/login']) {
      ultimoPedido = undefined
      const res = await pedirDeFora(path, { method: 'GET' })
      assert.equal(res.status, 200, `${TUNNEL_URL}${path} respondeu ${String(res.status)}`)
      assert.notEqual(pedidoVisto(), undefined, `${path} tem de chegar a rota`)
    }
  })
})
