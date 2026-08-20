/** S12 — cliente HTTP cru do laboratorio: requisicoes e upgrades reais. */
import { request } from 'node:http'

/**
 * Faz uma requisicao HTTP real e devolve `{ status, headers, body }`.
 *
 * @param {number} port
 * @param {string} path
 * @param {object} [options]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.method]
 */
export function pedir(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers ?? {} },
      (res) => {
        const pedacos = []
        res.on('data', (d) => pedacos.push(d))
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(pedacos).toString('utf8'),
        }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * Tenta um upgrade HTTP real. Devolve `{ resultado: 'upgrade', preambulo }`,
 * `{ resultado: 'resposta', status }` ou `{ resultado: 'erro', code }`.
 *
 * @param {number} port
 * @param {string} path
 * @param {Record<string, string>} [headers]
 */
export function pedirUpgrade(port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
        ...headers,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ resultado: 'upgrade', status: res.statusCode, rota: res.headers['x-lab-route'] })
    })
    req.on('response', (res) => {
      res.resume()
      resolve({ resultado: 'resposta', status: res.statusCode, autenticar: res.headers['www-authenticate'] })
    })
    req.on('error', (err) => resolve({ resultado: 'erro', code: err.code ?? err.message }))
    req.end()
  })
}

/** Cabecalho Basic Auth pronto a usar. */
export function basic(user, pass) {
  return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` }
}
