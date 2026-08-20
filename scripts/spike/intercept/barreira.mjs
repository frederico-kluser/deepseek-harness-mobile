/**
 * S12 — a barreira de autenticacao reversivel sobre o `webServer` do DSH.
 *
 * MECANISMO: troca de dono do despacho no `node:http.Server` que o
 * `WebServer` cria em `[Service.init]` (`lib/index.js:121` e `:132`).
 * Capturamos os listeners `request`/`upgrade` existentes, retiramo-los do
 * emissor e instalamos UM listener nosso que decide e so entao delega.
 *
 * Porque nao `prependListener`: o EventEmitter do Node nao tem waterfall nem
 * veto — um listener prepended corre primeiro mas NAO impede os seguintes.
 * Para BLOQUEAR e preciso ser o unico dono do despacho.
 *
 * Porque isto cobre os tres caminhos: o roteador do WebServer (`match` ->
 * `fallback`) e as tabelas `upgrades` vivem TODOS por baixo destes dois
 * listeners. Guardar o listener guarda `register`, `registerFallback` e
 * `registerUpgrade` de uma so vez, sem conhecer nenhuma rota.
 *
 * Porque nao ha exigencia de ordem de carregamento: o EventEmitter resolve a
 * lista de listeners a CADA evento, e as rotas sao registadas nas tabelas por
 * baixo. Instalar depois de toda a gente ja ter registado funciona na mesma.
 */
import { Server } from 'node:http'

/**
 * Marca de posse gravada no listener instalado. Serve para RECUSAR uma segunda
 * barreira no mesmo servidor: duas barreiras de fibers distintos podem ser
 * dispostas fora de ordem LIFO, e a reversão da primeira reinstalaria o
 * despacho original a correr EM PARALELO com a segunda — dupla resposta ao
 * mesmo `res`. Refusar o empilhamento elimina a classe inteira do problema.
 */
export const MARCA_DE_POSSE = Symbol.for('dsh-guard.barreira.dono')

/** Erro dedicado: falhar alto, nunca degradar para "sem barreira". */
export class BarreiraIndisponivel extends Error {
  constructor(message) {
    super(message)
    this.name = 'BarreiraIndisponivel'
  }
}

/**
 * Localiza o `node:http.Server` dentro do servico `webServer`.
 *
 * O campo chama-se `server` e e `private` APENAS em TypeScript: no
 * `lib/index.js` publicado e um campo de classe comum. O varrimento por
 * `instanceof Server` e a rede de seguranca para uma renomeacao do campo.
 *
 * @param {object} webServer - o servico lido de `ctx.webServer`.
 * @returns {import('node:http').Server}
 */
export function resolveHttpServer(webServer) {
  if (webServer === undefined || webServer === null) {
    throw new BarreiraIndisponivel('barreira: servico webServer ausente')
  }
  const direto = webServer.server
  if (direto instanceof Server) return direto
  for (const chave of Object.getOwnPropertyNames(webServer)) {
    let valor
    try {
      valor = webServer[chave]
    } catch {
      continue
    }
    if (valor instanceof Server) return valor
  }
  throw new BarreiraIndisponivel(
    'barreira: nenhum node:http.Server encontrado no servico webServer '
      + `(campos: ${Object.getOwnPropertyNames(webServer).join(', ')})`,
  )
}

/** Resposta padrao de recusa no caminho HTTP. */
function recusarHttp(res, realm) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(401, {
    'www-authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end('unauthorized')
}

/** Resposta padrao de recusa no caminho de upgrade (socket cru). */
function recusarUpgrade(socket, realm) {
  if (socket.destroyed) return
  socket.write(
    'HTTP/1.1 401 Unauthorized\r\n'
      + `WWW-Authenticate: Basic realm="${realm}", charset="UTF-8"\r\n`
      + 'Connection: close\r\n'
      + 'Content-Length: 0\r\n'
      + '\r\n',
  )
  socket.destroy()
}

/**
 * Instala a barreira. Sincrono, e o disposer devolvido tambem e sincrono.
 *
 * @param {object} webServer - o servico `ctx.webServer` (ja ACTIVE).
 * @param {object} options
 * @param {(req: import('node:http').IncomingMessage) => boolean} options.authorize
 *   predicado puro sobre a requisicao; `false` recusa.
 * @param {string} [options.realm] - realm do `WWW-Authenticate`.
 * @param {(d: {listenersRequest: number, listenersUpgrade: number}) => void} [options.onPerdaDePosse]
 *   chamado na reversao quando o despacho ja nao e nosso. O padrao lanca
 *   `BarreiraIndisponivel` — falhar alto, nunca restaurar por cima de outro dono.
 * @returns {() => void} disposer sincrono que devolve o despacho ao estado original.
 */
export function instalarBarreira(webServer, options) {
  const authorize = options?.authorize
  if (typeof authorize !== 'function') {
    throw new BarreiraIndisponivel('barreira: `authorize` e obrigatorio')
  }
  const realm = options?.realm ?? 'dsh'
  const onPerdaDePosse = options?.onPerdaDePosse ?? ((detalhe) => {
    throw new BarreiraIndisponivel(
      'barreira: o despacho ja nao e nosso no momento da reversao '
        + `(listeners request=${detalhe.listenersRequest}, upgrade=${detalhe.listenersUpgrade}). `
        + 'Os listeners originais NAO foram reinstalados, para nao duplicar o despacho.',
    )
  })
  const server = resolveHttpServer(webServer)

  const originaisRequest = server.listeners('request')
  const originaisUpgrade = server.listeners('upgrade')
  if (originaisRequest.length === 0) {
    throw new BarreiraIndisponivel(
      'barreira: o servidor nao tem listener `request` — o WebServer ainda nao inicializou',
    )
  }
  for (const listener of [...originaisRequest, ...originaisUpgrade]) {
    if (listener[MARCA_DE_POSSE] === true) {
      throw new BarreiraIndisponivel(
        'barreira: ja existe uma barreira instalada neste servidor. Empilhar duas barreiras '
          + 'e recusado porque a reversao fora de ordem LIFO reinstalaria o despacho original '
          + 'em paralelo com a barreira de cima (dupla resposta ao mesmo `res`).',
      )
    }
  }

  const onRequest = (req, res) => {
    let permitido = false
    try {
      permitido = authorize(req) === true
    } catch {
      permitido = false
    }
    if (!permitido) {
      recusarHttp(res, realm)
      return
    }
    for (const listener of originaisRequest) listener.call(server, req, res)
  }

  const onUpgrade = (req, socket, head) => {
    let permitido = false
    try {
      permitido = authorize(req) === true
    } catch {
      permitido = false
    }
    if (!permitido) {
      recusarUpgrade(socket, realm)
      return
    }
    for (const listener of originaisUpgrade) listener.call(server, req, socket, head)
  }

  onRequest[MARCA_DE_POSSE] = true
  onUpgrade[MARCA_DE_POSSE] = true

  server.removeAllListeners('request')
  server.on('request', onRequest)

  // O listener de `upgrade` so entra se ja existia algum. Medido no Node 24:
  // um servidor com ZERO listeners de `upgrade` NAO fecha a ligacao — o pedido
  // cai no caminho `request` (200), que esta guardado. Instalar um listener
  // onde nao havia nenhum mudaria essa semantica e, pior, um upgrade autorizado
  // seria delegado a uma lista vazia e ficaria pendurado.
  const guardaUpgrade = originaisUpgrade.length > 0
  if (guardaUpgrade) {
    server.removeAllListeners('upgrade')
    server.on('upgrade', onUpgrade)
  }

  let revertido = false
  return () => {
    if (revertido) return
    revertido = true

    // Verificacao de posse: so restauramos se o despacho ainda for nosso. Se
    // outro dono tomou conta entretanto, reinstalar os originais poria dois
    // despachos a responder ao mesmo `res`. Nesse caso removemos apenas o que
    // e nosso e falhamos alto.
    const agoraRequest = server.listeners('request')
    const agoraUpgrade = guardaUpgrade ? server.listeners('upgrade') : []
    const soNossoRequest = agoraRequest.length === 1 && agoraRequest[0] === onRequest
    const soNossoUpgrade = !guardaUpgrade || (agoraUpgrade.length === 1 && agoraUpgrade[0] === onUpgrade)

    server.removeListener('request', onRequest)
    if (guardaUpgrade) server.removeListener('upgrade', onUpgrade)

    if (!soNossoRequest || !soNossoUpgrade) {
      onPerdaDePosse({
        listenersRequest: agoraRequest.length,
        listenersUpgrade: agoraUpgrade.length,
      })
      return
    }

    for (const listener of originaisRequest) server.on('request', listener)
    if (guardaUpgrade) for (const listener of originaisUpgrade) server.on('upgrade', listener)
  }
}
