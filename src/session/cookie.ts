/**
 * Serializacao e leitura do cookie de sessao `__Host-dsh_sid`.
 *
 * DONO: T2.2. PURO -- este ficheiro nao conhece o objeto de pedido nem o de
 * resposta do Node; recebe strings e devolve strings.
 *
 * ------------------------------------------------------------------------
 * O NOME E CANONICO (09-DECISOES-CANONICAS.md D5)
 * ------------------------------------------------------------------------
 * `__Host-dsh_sid`, exatamente assim. Existe UMA constante e ela e exportada
 * daqui: dois modulos a escrever nomes ligeiramente diferentes e a falha
 * silenciosa classica -- o servidor emite um cookie e le outro, o dono leva 401
 * com sessao viva e nada no log explica porque.
 *
 * ------------------------------------------------------------------------
 * PORQUE O PREFIXO `__Host-` (RFC 6265bis, 4.1.3.2)
 * ------------------------------------------------------------------------
 * Texto normativo: *"If a cookie's name begins with a case-sensitive match for
 * the string `__Host-`, then the cookie will have been set with a `Secure`
 * attribute, a `Path` attribute with a value of `/`, and no `Domain`
 * attribute."* -- e o proprio agente do utilizador RECUSA o cookie se qualquer
 * uma das tres faltar.
 *
 * O que isso compra: sem `Domain`, o cookie fica preso a UMA origem. Um cookie
 * comum e partilhado por todo o registo de dominio -- qualquer subdominio de
 * `trycloudflare.com`, incluindo o tunel de um estranho, podia escrever um
 * `dsh_sid` que o navegador enviaria para o nosso. Com `__Host-` isso nao
 * compila do lado do navegador. E a unica defesa real contra *cookie injection*
 * por vizinho de dominio, e e a razao de a OWASP desaconselhar *double-submit*
 * ingenuo, que assume que ninguem escreve nos nossos cookies.
 *
 * ------------------------------------------------------------------------
 * `Secure` SOBRE `http://127.0.0.1` -- MEDIDO, NAO ASSUMIDO (spike S10)
 * ------------------------------------------------------------------------
 * A duvida que travava este desenho era: o navegador aceita um cookie `Secure`
 * com prefixo `__Host-` emitido por `http://127.0.0.1`, que e exatamente o
 * caminho do painel local? A Onda 0 mediu (`docs/spikes/superficie-ui.md` 5):
 *
 *   VEREDITO S10: CONFIRMADO. Firefox 149.0.2 e Brave 149.1.91.180 (motor
 *   Chromium) ACEITAM e REENVIAM `__Host-dsh_sid=...; Secure` emitido por
 *   `http://127.0.0.1:<porta>`. Duas celulas de controlo dao forca ao
 *   resultado: `__Host-` SEM `Secure` foi RECUSADO nos dois motores (a regra
 *   do prefixo esta mesmo a ser aplicada, o teste nao esta a medir nada), e em
 *   `http://192.168.122.1` -- HTTP nao-loopback -- o `Secure` foi RECUSADO nos
 *   dois motores medidos.
 *
 * Consequencia direta: **o cookie fica**, tambem no painel local, e o caminho
 * de bearer `Authorization` NAO e implementado. Ele era o fallback obrigatorio
 * apenas se S10 desse negativo (03-ONDAS.md 7, T2.2).
 *
 * MODO DE FALHA REAL DO PRODUTO, medido na mesma tabela: alcancado por IP de
 * LAN em `http` (`http://192.168.122.1:3080`, o telemovel na mesma rede sem
 * tunel), o cookie e DESCARTADO EM SILENCIO -- o servidor pensa que emitiu
 * sessao, o navegador nunca a devolve, e o dono ve um ciclo de login infinito
 * sem uma linha de erro. Por isso `serializeSessionCookie()` LANCA nessa
 * origem em vez de emitir: falhar alto uma vez e melhor que falhar baixo para
 * sempre (Q-3). E tambem a resposta a pergunta 5 desta sub-tarefa -- o
 * `Secure` nao e decorativo, ele governa se a sessao chega a existir.
 *
 * ------------------------------------------------------------------------
 * PORQUE NAO BEARER NO CABECALHO (a troca que NAO se faz em silencio)
 * ------------------------------------------------------------------------
 * Um portador em `Authorization` seria imune a CSRF -- o navegador nao o envia
 * sozinho em pedido de outro site. Mas o token teria de ser guardado onde o
 * JavaScript da pagina lhe chega (`localStorage`, memoria do bundle), e ai o
 * XSS passa a ser o risco DOMINANTE: com cookie `HttpOnly` um XSS pode agir
 * dentro da sessao mas nao pode LER nem EXFILTRAR a credencial; com portador em
 * `localStorage` pode roubar o token e usa-lo fora do navegador da vitima, sem
 * limite de tempo de janela. A propria OWASP resume: *"XSS can defeat all CSRF
 * mitigation techniques"*. Trocar CSRF por XSS seria trocar um risco mitigavel
 * (`SameSite` + `__Host-` + token anti-CSRF de T5.3) por um risco de
 * exfiltracao. A troca esta escrita aqui porque a alternativa e ela acontecer
 * sem ninguem a nomear.
 *
 * ------------------------------------------------------------------------
 * `SameSite=Strict`, E O QUE ISSO CUSTA
 * ------------------------------------------------------------------------
 * D5 / `02-SEGURANCA.md` 10.3 / `04-TESTES.md` SESS-002 fixam `Strict`.
 * `02-SEGURANCA.md` 5 argumenta pelo contrario (`Lax`), com o receio de que o
 * clique no link magico vindo do Telegram -- navegacao de topo *cross-site* --
 * nao levasse o cookie. O receio nao se aplica a ESTE desenho: quem chega pelo
 * link magico ainda NAO tem sessao; o `GET /__guard/magic` e inerte, e quem
 * emite o cookie e o `POST` disparado pela propria pagina, que ja e *same-site*
 * (D3 / `02-SEGURANCA.md` 5.3). O custo que sobra e outro, e e real: quem tiver
 * sessao viva e voltar por um link tocado NOUTRA aplicacao leva 401 na PRIMEIRA
 * navegacao, porque `Strict` retem o cookie; a navegacao seguinte dentro da
 * origem (recarregar, tocar num link da propria pagina) ja o envia. Uma volta
 * extra em troca de a sessao nao viajar em pedido iniciado por terceiros.
 */

import { SESSION_ABSOLUTE_TIMEOUT_MS } from './store.ts'
import { PLUGIN_NAME } from '../errors.ts'

/** Nome canonico do cookie de sessao (D5). Nao existe outro. */
export const SESSION_COOKIE_NAME = '__Host-dsh_sid'

/** Origem efetiva do pedido, ja normalizada por quem chama (T3.3/T3.4). */
export interface RequestOrigin {
  /** `http` ou `https`, sem `:`. */
  readonly scheme: string
  /** Host tal como veio, com ou sem porta: `127.0.0.1:3080`, `[::1]:80`, ... */
  readonly host: string
}

/**
 * Valores aceites no cookie: o alfabeto base64url e mais nada.
 *
 * Isto NAO e cosmetica de formato -- e a barreira contra INJECAO DE CABECALHO.
 * Um valor com `;`, `\r` ou `\n` deixaria de ser um valor e passaria a ser
 * atributos (ou cabecalhos) escolhidos por quem forneceu a string.
 */
const COOKIE_VALUE = /^[A-Za-z0-9_-]{22,256}$/u

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

/** Extrai o hostname: tira porta, parenteses de IPv6 e caixa. */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const fim = h.indexOf(']')
    return fim === -1 ? h.slice(1) : h.slice(1, fim)
  }
  const doisPontos = h.indexOf(':')
  // Mais de um `:` sem parenteses e um IPv6 nu, nao um `host:porta`.
  if (doisPontos !== -1 && h.indexOf(':', doisPontos + 1) === -1) {
    return h.slice(0, doisPontos)
  }
  return h
}

/**
 * 127.0.0.0/8 inteiro, nao so `127.0.0.1`.
 *
 * Aceita tambem a forma MAPEADA em IPv6 (`::ffff:127.0.0.1`), que e loopback
 * genuino e aparece quando o socket escuta em pilha dupla. Recusar essa forma
 * era recusar um cookie que o navegador teria aceite -- o inverso do erro que
 * este predicado existe para evitar.
 *
 * LIMITE CONHECIDO, e e obrigacao de normalizacao de quem chama (T3.3,
 * `src/http/host-header.ts`): a forma HEXADECIMAL do mesmo endereco
 * (`::ffff:7f00:1`) NAO e reconhecida aqui, nem a notacao de octeto com zero a
 * esquerda (`0177.0.0.1`). Nenhum navegador as poe num cabecalho `Host`, e
 * expandir este predicado a todas as grafias de um endereco era reimplementar
 * um parser de IP -- que e exatamente onde nascem os desvios de comparacao.
 * O que chega aqui tem de vir ja em forma canonica.
 */
function ehIpv4Loopback(hostname: string): boolean {
  const semMapa = hostname.startsWith('::ffff:') ? hostname.slice('::ffff:'.length) : hostname
  const m = IPV4.exec(semMapa)
  if (m === null) return false
  const octetos = [m[1], m[2], m[3], m[4]].map((o) => Number(o))
  if (octetos.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false
  return octetos[0] === 127
}

/**
 * A origem entrega um cookie `Secure`?
 *
 * A regra e a dos *potentially trustworthy origins* dos navegadores, e nao uma
 * invencao deste plugin: `https` sempre; em `http`, apenas o loopback
 * (`127.0.0.0/8`, `::1`, `localhost` e subdominios de `localhost`, RFC 6761).
 * Foi este o comportamento medido em S10 nos dois motores testados.
 */
export function isTrustworthyOrigin(origin: RequestOrigin): boolean {
  const scheme = origin.scheme.trim().toLowerCase().replace(/:$/u, '')
  if (scheme === 'https') return true
  if (scheme !== 'http') return false

  const hostname = hostnameOf(origin.host)
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '::1') return true
  return ehIpv4Loopback(hostname)
}

/**
 * Fail loud: recusa emitir sessao sobre origem que o navegador ia descartar.
 *
 * A mensagem nomeia a origem (que nao e segredo) e NUNCA o id (que e).
 */
export function assertTrustworthyOrigin(origin: RequestOrigin): void {
  if (isTrustworthyOrigin(origin)) return
  throw new Error(
    `[${PLUGIN_NAME}] recusa emitir sessao sobre ${origin.scheme}://${origin.host}: ` +
      'um cookie Secure/__Host- emitido por origem HTTP nao-loopback e descartado EM SILENCIO ' +
      'pelo navegador (medido em Firefox e Chromium, spike S10). Alcance a interface por ' +
      'http://127.0.0.1:<porta> ou pelo tunel HTTPS.',
  )
}

function atributos(): string {
  // A ordem nao e normativa; e fixa para que o teste possa comparar a linha
  // inteira byte a byte. `Path=/`, `Secure` e a AUSENCIA de `Domain` sao
  // exigidos pelo prefixo `__Host-`; `HttpOnly` tira o cookie do alcance do
  // script; `SameSite=Strict` tira-o do pedido iniciado por outro site.
  const maxAge = Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)
  return `Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
}

/**
 * Linha `Set-Cookie` que ENTREGA a sessao.
 *
 * @throws se a origem nao entrega cookie `Secure`, ou se o valor nao e um id
 *   opaco em base64url (injecao de cabecalho).
 */
export function serializeSessionCookie(id: string, origin: RequestOrigin): string {
  assertTrustworthyOrigin(origin)
  if (typeof id !== 'string' || !COOKIE_VALUE.test(id)) {
    throw new Error(
      `[${PLUGIN_NAME}] valor de sessao invalido para cookie: esperado id opaco em base64url`,
    )
  }
  return `${SESSION_COOKIE_NAME}=${id}; ${atributos()}`
}

/**
 * Linha `Set-Cookie` que APAGA a sessao do navegador (logout).
 *
 * Os atributos do prefixo tem de vir todos outra vez -- um `__Host-` sem
 * `Secure` ou sem `Path=/` e recusado tambem quando o que se pede e a
 * remocao, e o cookie ficaria vivo no cliente. `Max-Age=0` e a remocao.
 *
 * Isto e higiene do lado do cliente, nao a revogacao: quem invalida a sessao e
 * `SessionStore.revoke()`, do lado do servidor. Um logout que so apagasse o
 * cookie deixava a sessao valida para quem tivesse copiado o valor.
 *
 * NAO LANCA, ao contrario de `serializeSessionCookie()`, e a assimetria e
 * deliberada: EMITIR sobre origem que descarta o cookie e um erro que se paga
 * com um ciclo de login infinito, logo tem de ser alto; REMOVER e idempotente,
 * nao entrega credencial nenhuma e nunca pode ser o passo que faz um logout
 * devolver 500. A sessao ja morreu do lado do servidor quando esta linha e
 * construida.
 */
export function serializeSessionCookieClear(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
}

/**
 * Le `__Host-dsh_sid` de um cabecalho `Cookie`. Devolve `null` quando nao ha.
 *
 * NOME COMPARADO COM CAIXA: o prefixo `__Host-` e *case-sensitive* na RFC, e
 * aceitar `__host-dsh_sid` seria aceitar um nome que nao tem garantia nenhuma.
 *
 * DUPLICADO E RECUSA, NAO "fica o primeiro": um navegador conforme nunca envia
 * duas vezes o mesmo nome para a mesma origem, logo duas ocorrencias significam
 * que alguem injetou uma. Escolher uma delas e escolher a do atacante em
 * metade dos casos -- e a familia de ataques de *cookie shadowing* que a
 * PortSwigger publicou em 2025 contra os prefixos. Fecha-se.
 */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null

  let achado: string | null = null
  for (const parte of cookieHeader.split(';')) {
    const igual = parte.indexOf('=')
    if (igual === -1) continue
    if (parte.slice(0, igual).trim() !== SESSION_COOKIE_NAME) continue
    if (achado !== null) return null
    achado = parte.slice(igual + 1).trim()
  }

  if (achado === null || !COOKIE_VALUE.test(achado)) return null
  return achado
}
