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

/**
 * Responde 404 SEM confirmar que o recurso existe.
 *
 * ---------------------------------------------------------------------------
 * PORQUE ISTO E UMA FUNCAO PARTILHADA, E NAO UM `writeHead(404)` A MAO
 * ---------------------------------------------------------------------------
 * Ha DOIS sitios que tem de devolver exatamente estes bytes:
 *
 *   - `GET /__guard/secret` com `ott` invalido, expirado ou ja usado (T3.4);
 *   - `GET /__guard/secret` alcancado por um canal NAO-LOCAL, recusado pelo
 *     portao antes de a rota ser sequer invocada (`src/http/gate.ts`).
 *
 * Se os dois escrevessem o seu proprio 404, a menor diferenca -- uma virgula no
 * corpo, um cabecalho a mais, o `Content-Length` -- passava a distinguir "esta
 * rota nao existe" de "esta rota existe e voce veio do sitio errado". Isso e um
 * oraculo, e e exatamente o oraculo que o 404 existe para fechar: um 401 ou um
 * 403 aqui CONFIRMARIAM a rota. Uma funcao so, um corpo so.
 *
 * O CORPO E GENERICO DE PROPOSITO. Nao leva o nome do plugin nem a redaccao
 * "Acesso Intercetado" dos outros dois: um 404 com marca deste plugin anunciava
 * que foi ESTE plugin a responder, o que ja diz mais do que "nao ha nada aqui".
 */
export function denyNotFound(res: ServerResponse): void {
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end('Not Found\n')
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
    // Engolir aqui e um dos casos legitimos de 05-QUALIDADE-CODIGO.md §6.3; o
    // comentario do corpo explica porque. O selector `body.body.length=0`
    // conta statements e nao ve comentarios, entao a excecao vai explicita.
    // eslint-disable-next-line no-restricted-syntax
  } catch {
    // Socket ja fechado pelo par: nao ha nada a recuperar, e destruir a seguir
    // continua a ser correto.
  }

  socket.destroy()
}
