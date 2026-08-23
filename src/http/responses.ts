/**
 * `challengeBasicAuth`, `denyUntrustedOrigin`, `denyUpgrade` -- os corpos de
 * recusa, byte a byte.
 *
 * Escrita direta no objeto de resposta (`ServerResponse`) ou no socket cru, sem
 * qualquer camada tipo Express -- o DSH usa `node:http` cru.
 *
 * =============================================================================
 * REGRA DE FICHEIRO: TODA RECUSA LEVA `Referrer-Policy: no-referrer`.
 * =============================================================================
 * Nao e "as que precisam": sao TODAS, e a uniformidade e o controlo. Qualquer
 * uma destas respostas pode ser servida SOB A URL DO TUNEL, e a URL de um quick
 * tunnel nao e um endereco -- e a CAPACIDADE: quem a tem alcanca a barreira.
 * Basta a pagina servida carregar um recurso externo para essa URL viajar no
 * `Referer` ate ao log do servidor de destino. O painel deste plugin prova que
 * nao carrega nada de fora (CSP `default-src 'none'`, `src/panel/html.ts`); o
 * fallback da SPA do DSH, que estas recusas tambem cobrem, nao e nosso e nao
 * traz garantia nenhuma.
 *
 * >>> E ISTO E DEFESA EM PROFUNDIDADE BARATA COM UM SEGUNDO EFEITO. <<< Com
 * quatro respostas e uma so convencao, quem escrever a quinta nao tem de
 * descobrir qual das convencoes seguir -- e a divergencia entre duas recusas e
 * precisamente o oraculo que as funcoes PARTILHADAS deste ficheiro existem para
 * fechar. Ver a nota de {@link denyNotFound} sobre os dois 404.
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
    // Ver a REGRA DE FICHEIRO no cabecalho.
    'Referrer-Policy': 'no-referrer',
  })
  res.end('Acesso Intercetado: origem nao confiada.\n')
}

/**
 * Cabecalhos de uma recusa em TEXTO. UMA declaracao, para os DOIS escritores.
 *
 * ---------------------------------------------------------------------------
 * PORQUE ISTO E UMA CONSTANTE PARTILHADA E NAO DOIS LITERAIS QUE CONCORDAM HOJE
 * ---------------------------------------------------------------------------
 * O JSDoc de {@link denyNotFound} sempre AFIRMOU que os dois 404 tinham de sair
 * byte a byte iguais. Nao saiam -- e a divergencia foi MEDIDA no fio: o do
 * painel levava `x-content-type-options: nosniff` que o do portao nao tinha, e
 * os nomes dos cabecalhos iam em caixas diferentes (`Content-Type` contra
 * `content-type`), o que `writeHead` preserva tal e qual na resposta.
 *
 * >>> O DEFEITO NAO ERA O ORACULO; ERA O COMENTARIO A PROMETER O QUE O CODIGO
 * NAO FAZIA. <<< Os dois 404 alcancam-se por caminhos DISJUNTOS -- pelo tunel
 * bate-se sempre na camada de canal-local-apenas e ve-se o do portao; pelo
 * loopback chega-se sempre a rota e ve-se o do painel --, pelo que o mesmo
 * atacante dificilmente compara os dois. A propriedade que protege o segredo e a
 * outra, e essa manteve-se sempre: o 404 de `ott` invalido e byte a byte o 404
 * de rota inexistente, AMBOS escritos pelo mesmo lado (PANEL-003/PANEL-004).
 *
 * Uma constante partilhada torna a afirmacao verdadeira POR CONSTRUCAO em vez de
 * por coincidencia. Dois literais divergem na primeira melhoria de redaccao de
 * um deles; um so nao tem como.
 *
 * NOMES EM MINUSCULAS porque e a convencao de `PanelResponse.headers`
 * (`src/panel/api.ts`), que os escreve num envelope e nao direto no
 * `ServerResponse` -- alinhar do lado que tem tipo declarado seria mudar um
 * contrato de dados para arrumar um detalhe de fio. A ORDEM tambem e contrato:
 * e ela que torna os dois 404 identicos.
 */
export const TEXT_REFUSAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  // Ver a REGRA DE FICHEIRO no cabecalho.
  'referrer-policy': 'no-referrer',
  // Um 404 de texto nao deve poder ser adivinhado como outro tipo pelo
  // navegador. Estava so no lado do painel; passa a estar nos dois.
  'x-content-type-options': 'nosniff',
})

/** O corpo do 404. Generico de proposito -- ver {@link denyNotFound}. */
export const NOT_FOUND_BODY = 'Not Found\n'

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
 * O SEGUNDO ESCRITOR NAO E ESTA FUNCAO: o painel devolve um ENVELOPE
 * (`PanelResponse`), nao escreve no `ServerResponse`. Por isso a igualdade nao
 * pode vir de "chamem os dois a mesma funcao" -- vem de os dois montarem a
 * resposta a partir de {@link TEXT_REFUSAL_HEADERS} e {@link NOT_FOUND_BODY}.
 *
 * O CORPO E GENERICO DE PROPOSITO. Nao leva o nome do plugin nem a redaccao
 * "Acesso Intercetado" dos outros dois: um 404 com marca deste plugin anunciava
 * que foi ESTE plugin a responder, o que ja diz mais do que "nao ha nada aqui".
 */
export function denyNotFound(res: ServerResponse): void {
  res.writeHead(404, TEXT_REFUSAL_HEADERS)
  res.end(NOT_FOUND_BODY)
}

/**
 * Emite o desafio 401 com `WWW-Authenticate: Basic realm="..."`.
 *
 * ---------------------------------------------------------------------------
 * `Referrer-Policy: no-referrer` -- PORQUE ESTA NUM 401
 * ---------------------------------------------------------------------------
 * Sem ele, uma pagina servida SOB A URL DO TUNEL que carregue qualquer recurso
 * externo leva essa URL no `Referer` para o log do servidor de destino -- e a
 * URL do quick tunnel nao e um endereco, e a CAPACIDADE: quem a tem alcanca a
 * barreira. O painel deste plugin nao carrega recurso externo nenhum (CSP
 * `default-src 'none'`, provado em `src/panel/html.ts`), mas o corpo deste 401
 * e servido a TODA a superficie interceptada -- incluindo o fallback da SPA do
 * DSH, que nao e nosso e nao traz essa garantia.
 *
 * >>> ESTA FUNCAO E O 401 DO GATE **E** O 401 DO PAINEL, E ISSO E UMA
 * PROPRIEDADE DE SEGURANCA. <<< Os dois tem de sair BYTE A BYTE iguais: um
 * cabecalho a mais num deles e um oraculo que distingue "isto e o painel" de
 * "isto e o resto do DSH". Acrescentar o cabecalho AQUI mantem a igualdade por
 * construcao; acrescenta-lo em `src/panel/routes.ts` tinha-a quebrado.
 */
export function challengeBasicAuth(res: ServerResponse, realm: string): void {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  res.end('Acesso Intercetado: Credenciais invalidas.\n')
}

/**
 * O 401 do PORTAO no modelo novo: TEXTO PURO, SEM `WWW-Authenticate`.
 *
 * ---------------------------------------------------------------------------
 * PORQUE ESTA FUNCAO EXISTE AO LADO DE `challengeBasicAuth`
 * ---------------------------------------------------------------------------
 * A Onda 1 remove o login do portao: o gate NUNCA emite `WWW-Authenticate`
 * (que dispara o popup de credenciais do navegador). Quando o acesso pelo
 * TUNEL falha -- sem sessao e sem `?key=` valida -- a resposta e um 401 em
 * texto puro, sem desafio. `denyUnauthorized` E esse 401.
 *
 * `challengeBasicAuth` continua a existir e a emitir o desafio porque o PAINEL
 * (`src/panel/routes.ts`, de outra onda) ainda o usa na sua porta de login. O
 * portao, por desenho novo, NAO a chama: o "401 do gate" e este.
 *
 * ---------------------------------------------------------------------------
 * REGRA DE FICHEIRO PRESERVADA
 * ---------------------------------------------------------------------------
 * `Referrer-Policy: no-referrer` continua em TODA recusa deste ficheiro,
 * incluindo este 401 (um cache sem store e um referrer nulo sao o minimo para
 * quem possa ser servido sob a URL do tunel).
 */
export function denyUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    // Ausencia deliberada de `WWW-Authenticate`: nada de popup de login.
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    // Ver a REGRA DE FICHEIRO no cabecalho.
    'Referrer-Policy': 'no-referrer',
  })
  res.end('Acesso Intercetado: autorizacao necessaria.\n')
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
 *
 * A PARTIR DA ONDA 1, NENHUM STATUS EMITE `WWW-Authenticate`. O gateway de
 * WebSocket recusado (401) responde SEM desafio -- "nunca mais o popup de
 * login", a mesma doutrina do 401 do request (`denyUnauthorized`).
 */
export function denyUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'

  const headers = [
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Cache-Control: no-store',
    // Ver a REGRA DE FICHEIRO no cabecalho. Num handshake recusado o `Referer`
    // e menos provavel do que numa pagina, mas a regra vale para o ficheiro
    // inteiro: uma excecao aqui era a excecao que a proxima pessoa copiava.
    'Referrer-Policy: no-referrer',
    'Content-Length: 0',
  ]

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
