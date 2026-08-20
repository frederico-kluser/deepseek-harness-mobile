/**
 * `challengeBasicAuth`, `denyUntrustedOrigin`, `denyUpgrade` -- os corpos de
 * recusa, byte a byte.
 *
 * Escrita direta no objeto de resposta (`ServerResponse`) ou no socket cru, sem
 * qualquer camada tipo Express -- o DSH usa `node:http` cru.
 */

import type { ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Responde 403 a uma origem nao confiada.
 *
 * 403 e NAO 401 de proposito: 401 convida o cliente a repetir com credencial, e
 * repetir a credencial NAO ajuda quando o problema e a origem do socket.
 * Devolver 401 aqui daria ao atacante um oraculo para adivinhar credenciais a
 * partir de uma origem que nunca sera aceite.
 */
export function denyUntrustedOrigin(res: ServerResponse): void {
  res.writeHead(403, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end('Acesso Intercetado: origem nao confiada.\n')
}

/** Emite o desafio 401 com `WWW-Authenticate: Basic realm="..."`. */
export function challengeBasicAuth(res: ServerResponse, realm: string): void {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end('Acesso Intercetado: Credenciais invalidas.\n')
}

/**
 * Escreve uma resposta HTTP CRUA num socket de upgrade e destroi-o.
 *
 * Num tratador de `Connection: Upgrade` nao existe `ServerResponse`: o socket ja
 * foi destacado do ciclo pedido/resposta pelo `node:http` e quem responde
 * escreve os bytes do handshake a mao. Por isso a mensagem de estado, os
 * cabecalhos e a linha em branco final sao construidos aqui, com CRLF explicito,
 * como manda o RFC 7230.
 *
 * O `socket.destroy()` e obrigatorio: sem ele o cliente fica com uma ligacao
 * meio-aberta a espera do 101 que nunca vem.
 */
export function denyUpgrade(socket: Duplex, status: 401 | 403, realm: string): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'

  const headers = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Length: 0',
  ]

  if (status === 401) {
    headers.push(`WWW-Authenticate: Basic realm="${realm}", charset="UTF-8"`)
  }

  try {
    socket.write(`${headers.join('\r\n')}\r\n\r\n`)
  } catch {
    // Socket ja fechado pelo par: nao ha nada a recuperar, e destruir a seguir
    // continua a ser correto.
  }

  socket.destroy()
}
