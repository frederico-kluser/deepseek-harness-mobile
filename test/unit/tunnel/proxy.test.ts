/**
 * `src/tunnel/proxy.ts` -- o PROXY do tunel (modelo expose-port).
 *
 * Prova o modelo PORTA vs UPSTREAM com servidores REAIS em loopback:
 *
 *   (a) `Host: 127.0.0.1:3080` FORJADO pelo tunel sem credencial -> 401 (BLOCK);
 *   (b) `Host` legitimo do tunel sem credencial -> 401 sem `WWW-Authenticate`;
 *   (c) `?key=` valida -> 302 + Set-Cookie + URL limpa, e a chave e reutilizavel;
 *   (d) sessao -> 200, encaminhado para o upstream;
 *   (e) WebSocket: sessao -> encaminha; sem sessao -> recusa sem desafio;
 *   (f) rotate revoga a chave e a sessao -> 401;
 *   (g) o UPSTREAM (porta do DSH) responde 200 direto, SEM gate.
 */

import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createTunnelProxy, type TunnelProxy } from '../../../src/tunnel/proxy.ts'
import { bancada, FAKE_TUNNEL_ORIGIN, type Bancada } from '../http/bancada.ts'

const HOST_DO_TUNEL = 'marks-organization-moved-coupons.trycloudflare.com'

let aberta: Bancada | undefined
let upstream: Server | undefined
let proxy: TunnelProxy | undefined

function hostDoTunel(): string {
  return HOST_DO_TUNEL
}

async function ouvir(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

interface Resposta {
  status: number
  body: string
  challenge: string | undefined
  location: string | undefined
  setCookie: string | undefined
}

/** Um pedido ao PROXY (como o cloudflared entregaria), com o `Host` escolhido. */
function pedirAoProxy(port: number, path: string, host: string, headers: Record<string, string> = {}): Promise<Resposta> {
  return new Promise<Resposta>((resolve, reject) => {
    const req = httpRequest(
      // `agent: false` força uma conexao NOVA por pedido, como o cloudflared.
      // Sem isto, o `http.globalAgent` reutiliza sockets keep-alive que o
      // `encerrarConexoesAtivas()` derrubou do lado do proxy — e a reutilizacao
      // de um socket morto finge "o listener caiu" com ECONNRESET (artefacto de
      // harness, nao o contrato).
      { host: '127.0.0.1', port, path, method: 'GET', agent: false, headers: { host, ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (d) => void chunks.push(Buffer.from(d)))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            challenge: res.headers['www-authenticate'],
            location: typeof res.headers['location'] === 'string' ? res.headers['location'] : undefined,
            setCookie: Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : undefined,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function setUpProxy(
  onRequest?: (req: IncomingMessage, res: ServerResponse) => void,
  onUpgrade?: (req: IncomingMessage, socket: Duplex) => void,
): Promise<{ proxyPort: number; upstreamPort: number }> {
  aberta = bancada({ comSegredo: true, tunnelReady: true })
  aberta.tunnelOrigin.publish(FAKE_TUNNEL_ORIGIN)

  // O UPSTREAM = o servidor do DSH, que responde direto (SEM gate). Por padrao
  // devolve `UPSTREAM-OK` e fecha; um `onRequest` alternativo (ex.: streaming
  // em voo) permite cenas de corpo parcial.
  const onRequestAtual = onRequest ?? ((_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('UPSTREAM-OK')
  })
  upstream = createServer(onRequestAtual)
  // O padrao de `onRequest`: um `onUpgrade` opcional permite cenas em que o
  // upstream MANTEM o socket de upgrade aberto (nao chama `end`) — so o rotate
  // (via `encerrarConexoesAtivas`) e que o derruba. Por omissao o upstream
  // escreve o 101 e fecha, que e o comportamento historico dos restantes casos.
  upstream.on('upgrade', onUpgrade ?? ((_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.end()
  }))
  const upstreamPort = await ouvir(upstream)

  proxy = createTunnelProxy({
    ctx: aberta.ctx.asContext(),
    log: aberta.gate.log,
    config: aberta.config,
    auth: aberta.gate.auth,
    tunnelOrigin: aberta.tunnelOrigin,
    linkToken: aberta.gate.linkToken,
    issueSession: aberta.gate.issueSession,
    upstreamPort,
  })
  // O `listen(0)` do proxy e assincrono: espera ate a porta estar assignada.
  await ateFixar(proxy.server)
  return { proxyPort: (proxy.server.address() as AddressInfo).port, upstreamPort }
}

/** Espera ativamente ate o servidor estar a escutar (porta assignada). */
function ateFixar(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (server.listening && server.address() !== null) {
      resolve()
      return
    }
    const t = setInterval(() => {
      if (server.listening && server.address() !== null) {
        clearInterval(t)
        resolve()
      }
    }, 2)
    server.once('error', reject)
  })
}

afterEach(() => {
  proxy?.dispose()
  proxy = undefined
  upstream?.close()
  upstream = undefined
  aberta?.cleanup()
  aberta = undefined
})

describe('MODELO PORTA: o proxy do tunel (modelo expose-port)', () => {
  it('(a) BLOCK: Host: 127.0.0.1:3080 FORJADO pelo tunel, sem credencial -> 401', async () => {
    const { proxyPort } = await setUpProxy()
    const res = await pedirAoProxy(proxyPort, '/', '127.0.0.1:3080')
    assert.equal(res.status, 401, 'o Host loopback forjado NAO abre o proxy')
    assert.equal(res.challenge, undefined)
    assert.equal(res.body.includes('UPSTREAM-OK'), false, 'nada chegou ao upstream')
  })

  it('(b) Host legitimo do tunel, sem credencial -> 401 sem WWW-Authenticate', async () => {
    const { proxyPort } = await setUpProxy()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel())
    assert.equal(res.status, 401)
    assert.equal(res.challenge, undefined, 'sem popup')
    assert.equal(res.body.includes('UPSTREAM-OK'), false)
  })

  it('(c) `?key=` valida -> 302 + Set-Cookie + URL limpa, e a chave e REUTILIZAVEL', async () => {
    const { proxyPort } = await setUpProxy()
    const { token } = aberta!.linkStore.emitir()

    const res = await pedirAoProxy(proxyPort, `/?key=${token}`, hostDoTunel(), { 'x-forwarded-proto': 'https' })
    assert.equal(res.status, 302)
    assert.equal(res.location, '/', 'a URL limpa nao leva a chave')
    assert.ok((res.setCookie ?? '').startsWith('__Host-dsh_sid='), 'a chave troca por sessao')
    assert.equal(res.challenge, undefined)

    // A sessao emitida autoriza a seguir (200 -> upstream).
    const cookie = String(res.setCookie).slice('__Host-dsh_sid='.length).split(';')[0]
    const comSessao = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie: `__Host-dsh_sid=${cookie}` })
    assert.equal(comSessao.status, 200)
    assert.equal(comSessao.body, 'UPSTREAM-OK')

    // A chave permanece valida (nao e de uso unico).
    assert.equal(aberta!.linkStore.verificar(token), true)
  })

  it('(d) sessao valida -> 200 encaminhado ao upstream', async () => {
    const { proxyPort } = await setUpProxy()
    const cookie = aberta!.emitirSessao()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'UPSTREAM-OK', 'o proxy encaminhou para o upstream')
  })

  it('(g) o UPSTREAM (porta do DSH) responde 200 direto, SEM gate', async () => {
    const { upstreamPort } = await setUpProxy()
    const res = await pedirAoProxy(upstreamPort, '/', '127.0.0.1:3080')
    assert.equal(res.status, 200, 'o servidor do DSH fica ABERTO (expose-port)')
    assert.equal(res.body, 'UPSTREAM-OK')
    assert.equal(res.challenge, undefined)
  })

  it('(f) rotate revoga a chave E a sessao -> os dois viram 401', async () => {
    const { proxyPort } = await setUpProxy()
    const { token } = aberta!.linkStore.emitir()
    const cookie = aberta!.emitirSessao()

    // Rotacao revoga a chave do link e todas as sessoes (SECRET-008).
    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()

    const porChave = await pedirAoProxy(proxyPort, `/?key=${token}`, hostDoTunel(), { 'x-forwarded-proto': 'https' })
    assert.equal(porChave.status, 401, 'a chave revogada nao autentica')

    const porSessao = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie })
    assert.equal(porSessao.status, 401, 'a sessao revogada nao autentica')
  })
})

describe('WebSocket no proxy (modelo porta)', () => {
  it('(e) sem sessao: recusa 401 sem desafio no socket cru', async () => {
    const { proxyPort } = await setUpProxy()
    const bruto = await empurrarUpgrade(proxyPort, hostDoTunel(), undefined)
    assert.match(bruto, /^HTTP\/1\.1 401 /u)
    assert.equal(bruto.includes('WWW-Authenticate'), false)
    assert.equal(bruto.includes('101 Switching Protocols'), false, 'nao sobe de forma alguma')
  })

  it('(e) com sessao: encaminha o handshake (101) para o upstream', async () => {
    const { proxyPort } = await setUpProxy()
    const cookie = aberta!.emitirSessao()
    const bruto = await empurrarUpgrade(proxyPort, hostDoTunel(), cookie)
    assert.match(bruto, /^HTTP\/1\.1 101 /u)
    assert.equal(bruto.includes('101 Switching Protocols'), true)
  })
})

describe('QUALIDADE DE SERVICO da rotacao: encerrarConexoesAtivas (onda1)', () => {
  it('(h) WebSocket ativo sob o acesso antigo morre e o listen continua', async () => {
    // O upstream MANTEM o socket de upgrade ABERTO (nao chama `end`) — senao o
    // socket do cliente morreria SOZINHO e este teste seria vacuous (a prova de
    // que so `encerrarConexoesAtivas()` derruba o WebSocket upgraded).
    let upgradeSocket: Duplex | undefined
    const { proxyPort } = await setUpProxy(undefined, (_req, socket: Duplex) => {
      upgradeSocket = socket
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      // Nao chama `socket.end()`: o upgrade permanece ABERTO ate o proxy o matar.
    })
    const cookie = aberta!.emitirSessao()

    // O upgrade sobe (101): a conexao fica VIVA sob o acesso antigo.
    const { bruto, socket } = await abrirUpgrade(proxyPort, hostDoTunel(), cookie)
    assert.match(bruto, /^HTTP\/1\.1 101 /u, 'o upgrade subiu (101)')

    // Controle (prova de que o teste e DISCRIMINANTE): sem `encerrarConexoesAtivas`,
    // o socket de upgrade NAO fecha sozinho — o upstream nao esta a derruba-lo.
    await esperarEstavel(socket, 250)
    assert.equal(socket.destroyed, false, 'o socket de upgrade sobrevive ao controle')

    const fechou = esperarFecho(socket)

    // O rotate completo: revoga sessoes, revoga a chave, e ENCERRA as conexoes.
    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    // Idempotente: a segunda chamada tambem nao lanca (Q-2).
    proxy!.encerrarConexoesAtivas()

    await fechou // a conexao ativa morreu (FIN/close/end no socket cru do cliente)

    // O listener ficou de pe: as credenciais NOVAS autorizam outra vez.
    const novaSessao = aberta!.emitirSessao()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie: novaSessao })
    assert.equal(res.status, 200, 'o proxy continua a aceitar com sessao nova')
    assert.equal(res.body, 'UPSTREAM-OK')

    // Destroi o socket de upgrade do UPSTREAM que o onUpgrade manteve aberto de
    // proposito, para o `afterEach` conseguir fechar o servidor upstream sem
    // espera infinita (o proxy ja encerrou o lado dele).
    upgradeSocket?.destroy()
  })

  it('(h2) encerrarConexoesAtivas mata um stream HTTP keep-alive em voo', async () => {
    const { proxyPort } = await setUpProxy()
    const cookie = aberta!.emitirSessao()

    // Um stream HTTP keep-alive atravessou o proxy e fica aberto em voo.
    const { bruto, socket } = await abrirKeepAlive(proxyPort, hostDoTunel(), cookie)
    assert.match(bruto, /^HTTP\/1\.1 200 /u, 'o keep-alive autorizado chegou ao upstream')

    const fechou = esperarFecho(socket)
    // O rotate revoga sessoes + chave e encerra as conexoes (fail-closed).
    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    await fechou // o stream em voo morreu
  })

  it('(h3) WebSocket autenticado pela CHAVE no link (?key= -> 302 -> sessao) morre no rotate', async () => {
    const { proxyPort } = await setUpProxy()

    // Fluxo de navegador de VERDADE: a chave no link troca por uma sessao
    // (`302 + Set-Cookie`), e a sessao emitida e que povoa o upgrade. O (h)
    // usou `emitirSessao()` direto; aqui a sessao nasce da CHAVE (cenario 1).
    const { token } = aberta!.linkStore.emitir()
    const jeitoDoLink = await pedirAoProxy(proxyPort, `/?key=${token}`, hostDoTunel(), {
      'x-forwarded-proto': 'https',
    })
    assert.equal(jeitoDoLink.status, 302, 'a chave valida responde 302 (troca por sessao)')
    assert.ok((jeitoDoLink.setCookie ?? '').startsWith('__Host-dsh_sid='), 'a chave emitiu uma sessao')
    const cookie = String(jeitoDoLink.setCookie)
      .slice('__Host-dsh_sid='.length)
      .split(';')[0]

    const { bruto, socket } = await abrirUpgrade(proxyPort, hostDoTunel(), `__Host-dsh_sid=${cookie}`)
    assert.match(bruto, /^HTTP\/1\.1 101 /u, 'o upgrade sobe (101) com a sessao nascida da chave')

    const fechou = esperarFecho(socket)
    // O rotate revoga sessoes + chave e encerra as conexoes (fail-closed).
    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    proxy!.encerrarConexoesAtivas() // idempotente (segunda chamada nao lanca)
    await fechou // o WS autenticado pela chave do link morreu

    // O listener continua de pe apos o rotate APOS o fluxo real (?key= -> 302):
    // um request HTTP NOVO (sessao nova) responde 200 (nao ECONNRESET). O
    // `pedirAoProxy` usa `agent: false` (conexao nova, como o cloudflared).
    const novaSessao = aberta!.emitirSessao()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie: novaSessao })
    assert.equal(res.status, 200, 'o listener segue vivo apos o rotate no fluxo ?key=')
    assert.equal(res.body, 'UPSTREAM-OK')
  })

  it('(h4) conexao TCP crua que NUNCA completa handshake (sem request) morre no rotate', async () => {
    const { proxyPort } = await setUpProxy()

    // Abre um socket bruto no proxy e NAO escreve nada: fica parado sem pedido
    // (rastreado no `server.on('connection')`, sem nunca virar request/upgrade).
    const mortoPelaMao = connect(proxyPort, '127.0.0.1')
    await esperarLigacao(mortoPelaMao) // garante que o socket ja esta ACEITO pelo server
    const fechou = esperarFecho(mortoPelaMao)

    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    await fechou // a conexao crua travada foi encerrada pelo rotate

    const novaSessao = aberta!.emitirSessao()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie: novaSessao })
    assert.equal(res.status, 200, 'o listener continua de pe apos o rotate')
  })

  it('(h5) encerrarConexoesAtivas com o Set VAZIO e um no-op: nao lanca e o listener continua', async () => {
    const { proxyPort } = await setUpProxy()

    // Sobre um proxy recém-subido ainda nao existe conexao alguma.
    assert.doesNotThrow(() => proxy!.encerrarConexoesAtivas(), 'Set vazio nao lanca')
    assert.doesNotThrow(() => proxy!.encerrarConexoesAtivas(), 'idempotente mesmo com Set vazio')

    // O listener continua a aceitar normalmente.
    const cookie = aberta!.emitirSessao()
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie })
    assert.equal(res.status, 200, 'no-op nao derrubou o listener')
    assert.equal(res.body, 'UPSTREAM-OK')
  })

  it('(h6) DUAS conexoes WebSocket simultaneas: ambas morrem no rotate', async () => {
    const { proxyPort } = await setUpProxy()
    const cookie = aberta!.emitirSessao()

    const a = await abrirUpgrade(proxyPort, hostDoTunel(), cookie)
    const b = await abrirUpgrade(proxyPort, hostDoTunel(), cookie)
    assert.match(a.bruto, /^HTTP\/1\.1 101 /u, 'primeira subiu (101)')
    assert.match(b.bruto, /^HTTP\/1\.1 101 /u, 'segunda subiu (101)')

    const fechouA = esperarFecho(a.socket)
    const fechouB = esperarFecho(b.socket)

    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    await Promise.all([fechouA, fechouB]) // as DUAS conexoes morreram
  })

  it('(h7) request HTTP com `Connection: close` JA encerrado antes do rotate nao quebra o encerramento', async () => {
    const { proxyPort } = await setUpProxy()
    const cookie = aberta!.emitirSessao()

    // Um pedido COMPLETO com `Connection: close`: o upstream responde e o
    // socket ja fechou ANTES do rotate ('close' retirou-o do Set).
    const res = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), {
      cookie,
      connection: 'close',
    })
    assert.equal(res.status, 200)

    // Rotacionar sobre um Set que ja nao contem o socket fechado nao falha e
    // NAO derruba o listener para requests HTTP novos.
    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    proxy!.encerrarConexoesAtivas() // idempotente

    // O listener segue vivo APOS um request HTTP ja encerrado: um request NOVO
    // (sessao nova) responde 200 (nao ECONNRESET). O `pedirAoProxy` usa
    // `agent: false` (conexao nova, como o cloudflared).
    const novaSessao = aberta!.emitirSessao()
    const nova = await pedirAoProxy(proxyPort, '/api/state', hostDoTunel(), { cookie: novaSessao })
    assert.equal(nova.status, 200, 'o listener continua vivo para HTTP apos o rotate')
    assert.equal(nova.body, 'UPSTREAM-OK')
  })

  it('(h8) rotacao durante um stream HTTP com resposta do upstream em partes (corpo parcial) mata o socket', async () => {
    // O UPSTREAM escreve a METADE do corpo e trava (resposta incompleta em voo).
    let respostaUpstream: ServerResponse | undefined
    const { proxyPort } = await setUpProxy((_req, res) => {
      respostaUpstream = res
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.write('PRIMEIRA-METADE')
      // Não chame res.end(): o corpo fica PARCIAL, atravessando o proxy.
    })

    const cookie = aberta!.emitirSessao()
    const { bruto, socket } = await abrirStreamCorpo(proxyPort, hostDoTunel(), cookie)
    assert.match(bruto, /^HTTP\/1\.1 200 /u, 'a resposta comecou (200) e o corpo flui')
    assert.ok(bruto.includes('PRIMEIRA-METADE'), 'a primeira metade do corpo ja chegou ao cliente')

    const fechou = esperarFecho(socket)
    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    await fechou // o socket do stream em voo morreu

    // Destroi a resposta do upstream que ficou em voo (nunca terminada) para o
    // `afterEach` conseguir fechar o servidor upstream sem espera infinita.
    respostaUpstream?.destroy()
  })

  it('(h9) nenhuma conexao FORA do proxy e afetada pelo rotate', async () => {
    const { proxyPort, upstreamPort } = await setUpProxy()

    // Uma conexao crua DIRETA ao upstream (fora do proxy): nao deve ser derrubada.
    const direta = connect(upstreamPort, '127.0.0.1')

    // Uma conexao que atravessou o proxy (para servir de contraprova).
    const cookie = aberta!.emitirSessao()
    const atraves = await abrirKeepAlive(proxyPort, hostDoTunel(), cookie)
    const fechouAtraves = esperarFecho(atraves.socket)

    aberta!.stack.secrets.rotate()
    aberta!.linkStore.revogar()
    proxy!.encerrarConexoesAtivas()
    await fechouAtraves // a que VEM do proxy morre

    // A conexao fora do proxy NUNCA entrou no Set: continua viva (criterio (e)).
    assert.equal(direta.destroyed, false, 'a conexao fora do proxy permanece VIVA')
    direta.destroy()
  })
})

/** Sobe um handshake cru de WebSocket e devolve a resposta bruta lida. */
function empurrarUpgrade(port: number, host: string, cookie: string | undefined): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      const extra = cookie === undefined ? '' : `Cookie: ${cookie}\r\n`
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${FAKE_TUNNEL_ORIGIN}\r\n${extra}\r\n`,
      )
    })
    const pedacos: Buffer[] = []
    const tarde = (): void => resolve(Buffer.concat(pedacos).toString('utf8'))
    socket.on('data', (d: Buffer) => {
      pedacos.push(d)
      const texto = Buffer.concat(pedacos).toString('utf8')
      // Resolve quando a resposta HTTP esta completa (status + cabecalhos).
      if (/HTTP\/1\.1 1\d\d/mu.test(texto) || /HTTP\/1\.1 4\d\d/mu.test(texto)) resolve(texto)
    })
    socket.on('error', tarde)
    socket.on('end', tarde)
  })
}

/**
 * Sobe um handshake cru de WebSocket e devolve o socket do lado do CLIENTE
 * (para observar o fecho) e a resposta bruta lida. O socket fica aberto apos o
 * 101 — a conexao ativa atravessou o proxy.
 */
function abrirUpgrade(port: number, host: string, cookie: string | undefined): Promise<{ bruto: string; socket: Socket }> {
  return new Promise<{ bruto: string; socket: Socket }>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      const extra = cookie === undefined ? '' : `Cookie: ${cookie}\r\n`
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${FAKE_TUNNEL_ORIGIN}\r\n${extra}\r\n`,
      )
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => {
      pedacos.push(d)
      const texto = Buffer.concat(pedacos).toString('utf8')
      if (/HTTP\/1\.1 1\d\d/mu.test(texto) || /HTTP\/1\.1 4\d\d/mu.test(texto)) {
        resolve({ bruto: texto, socket })
      }
    })
    socket.on('error', () => resolve({ bruto: Buffer.concat(pedacos).toString('utf8'), socket }))
  })
}

/**
 * Abre um socket HTTP cru com sessao e pede keep-alive ao proxy, mantendo o
 * socket aberto. Devolve o socket e a resposta bruta.
 */
function abrirKeepAlive(port: number, host: string, cookie: string | undefined): Promise<{ bruto: string; socket: Socket }> {
  return new Promise<{ bruto: string; socket: Socket }>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      const extra = cookie === undefined ? '' : `Cookie: ${cookie}\r\n`
      socket.write(
        `GET /api/state HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n${extra}\r\n`,
      )
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => {
      pedacos.push(d)
      const texto = Buffer.concat(pedacos).toString('utf8')
      if (/HTTP\/1\.1 \d\d\d/mu.test(texto)) resolve({ bruto: texto, socket })
    })
    socket.on('error', () => resolve({ bruto: Buffer.concat(pedacos).toString('utf8'), socket }))
  })
}

/**
 * Abre um socket HTTP cru com sessao pedindo um stream ao proxy e resolve assim
 * que a PRIMEIRA METADE do corpo chegar ao cliente (a resposta em voo, com o
 * socket ainda aberto). O marcador `marca` distingue 'corpo parcial' de 'so
 * status': sem ele o pedido resolveria no `200` sem jamais travar em voo.
 */
function abrirStreamCorpo(
  port: number,
  host: string,
  cookie: string | undefined,
  marca = 'PRIMEIRA-METADE',
): Promise<{ bruto: string; socket: Socket }> {
  return new Promise<{ bruto: string; socket: Socket }>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      const extra = cookie === undefined ? '' : `Cookie: ${cookie}\r\n`
      socket.write(`GET /api/state HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n${extra}\r\n`)
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => {
      pedacos.push(d)
      const texto = Buffer.concat(pedacos).toString('utf8')
      if (texto.includes(marca)) resolve({ bruto: texto, socket })
    })
    socket.on('error', () => resolve({ bruto: Buffer.concat(pedacos).toString('utf8'), socket }))
  })
}

/**
 * Resolve quando um socket cru do cliente conclui a ligacao TCP (aceite pelo
 * server). Evita a corrida de o rotate correr antes de a conexao estar de facto
 * rastreada no `server.on('connection')` do proxy.
 */
function esperarLigacao(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.connecting === false) {
      resolve()
      return
    }
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
}

/**
 * Resolve quando o socket cru do cliente fecha (FIN/`close`/`end`), ou rejeita
 * se nao fechar no prazo. O valor do pedido virado RST (`error`) tambem fecha.
 */
function esperarFecho(socket: Socket, timeoutMs = 1_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      socket.removeListener('close', noFecho)
      socket.removeListener('end', noFecho)
      reject(new Error('a conexao ativa nao encerrou dentro do prazo'))
    }, timeoutMs)
    const noFecho = (): void => {
      clearTimeout(timer)
      socket.removeListener('close', noFecho)
      socket.removeListener('end', noFecho)
      resolve()
    }
    socket.once('close', noFecho)
    socket.once('end', noFecho)
  })
}

/**
 * Prova que um socket cru do cliente PERMANECE ABERTO durante `ms` — resolve
 * se nada o fechar nesse prazo, rejeita se fechar sozinho. Usado no controlo do
 * (h) para garantir que o teste e DISCRIMINANTE: o upstream mantem o socket de
 * upgrade aberto, logo sem `encerrarConexoesAtivas()` ele nao cai.
 */
function esperarEstavel(socket: Socket, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error('o socket de upgrade ja estava fechado no inicio do controlo'))
      return
    }
    const timer = setTimeout(() => {
      socket.removeListener('close', caiu)
      socket.removeListener('end', caiu)
      socket.removeListener('error', erro)
      resolve()
    }, ms)
    const caiu = (): void => {
      clearTimeout(timer)
      socket.removeListener('close', caiu)
      socket.removeListener('end', caiu)
      socket.removeListener('error', erro)
      reject(new Error('o socket de upgrade fechou SOZINHO (upstream nao o manteve aberto -> teste vacuous)'))
    }
    const erro = (err: NodeJS.ErrnoException): void => {
      clearTimeout(timer)
      socket.removeListener('close', caiu)
      socket.removeListener('end', caiu)
      socket.removeListener('error', erro)
      reject(new Error(`o socket de upgrade fechou SOZINHO (${err.code ?? err.message})`))
    }
    socket.once('close', caiu)
    socket.once('end', caiu)
    socket.once('error', erro)
  })
}
