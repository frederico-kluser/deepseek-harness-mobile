/**
 * =============================================================================
 * L2.5 -- VALIDACAO DO CABECALHO `Host` (anti DNS REBINDING)
 * =============================================================================
 *
 * TRES ALLOWLISTS, TRES COISAS DIFERENTES. O `cordis.patch.yml` documenta a
 * distincao e ela repete-se aqui porque confundi-las e como nasce um buraco:
 *
 *   - `config.allowedHosts`   -> allowlist do ENDERECO DE BIND: os valores que
 *                                `ctx.webServer.host` pode assumir (a INTERFACE
 *                                LOCAL onde o servidor escuta). Dono:
 *                                `src/config/bind.ts`.
 *   - `config.trustedRemotes` -> allowlist da PONTA REMOTA
 *                                (`req.socket.remoteAddress`). Dono:
 *                                `src/http/origin.ts`.
 *   - ESTE FICHEIRO           -> allowlist do NOME PELO QUAL o cliente PEDIU o
 *                                recurso (o cabecalho `Host` da requisicao).
 *
 * PORQUE A TERCEIRA E NECESSARIA, quando as outras duas ja existem. Sob
 * `cloudflared` -- e sob qualquer proxy -- a ponta remota e SEMPRE `127.0.0.1`:
 * `trustedRemotes` deixa de separar seja o que for. E o bind continua a ser
 * loopback: `allowedHosts` tambem nao ve nada. O que muda de pedido para pedido
 * e o NOME que o cliente pediu, e e por ele que passa o DNS rebinding:
 *
 *   1. a vitima abre `http://evil.com`, que resolve para um IP do atacante;
 *   2. o registo expira em 1 s e passa a resolver para `127.0.0.1`;
 *   3. o JavaScript da pagina, ainda na origem `evil.com`, faz `fetch` para
 *      `http://evil.com:3080/api/...` -- que agora chega ao NOSSO servidor,
 *      com `Host: evil.com`, e a same-origin policy nao se opoe, porque para o
 *      navegador continua a ser a mesma origem.
 *
 * A defesa e recusar o pedido cujo `Host` nao e um nome por que este servidor
 * responde. E uma allowlist, nao uma blocklist -- uma forma desconhecida (um
 * IPv4 em decimal, `0177.0.0.1`, um nome novo) simplesmente NAO CASA e e
 * recusada. Fecha por omissao.
 *
 * -----------------------------------------------------------------------------
 * UMA SO NORMALIZACAO, PARA OS DOIS LADOS
 * -----------------------------------------------------------------------------
 * A origem recebida e as entradas da lista passam por
 * {@link canonicalRequestHost}, que por sua vez delega em
 * `normalizeRemoteAddress` (`src/http/origin.ts`) -- a MESMA funcao que
 * normaliza `req.socket.remoteAddress`. Duas normalizacoes divergentes sao a
 * forma classica de uma allowlist deixar passar o que julga recusar.
 *
 * O que este modulo acrescenta ANTES de delegar e so o que um cabecalho `Host`
 * traz e um `remoteAddress` nao traz: a PORTA, os parenteses rectos da
 * autoridade de URL, o ponto final de nome absoluto e as grafias HEXADECIMAIS
 * de IPv6 (`::ffff:7f00:1`, `0000:...:0001`) -- que o Node nunca poe num
 * `remoteAddress` mas que um cliente pode escrever a mao.
 * =============================================================================
 */

import { normalizeRemoteAddress } from './origin.ts'

/**
 * Nomes de loopback que valem SEMPRE, independentemente do bind.
 *
 * `localhost` e `*.localhost` sao loopback por norma (RFC 6761 6.3): *"Name
 * resolution APIs and libraries SHOULD recognize localhost names as special and
 * SHOULD always return the IP loopback address"*. E o mesmo conjunto que
 * `isTrustworthyOrigin` (`src/session/cookie.ts`) usa para decidir se o
 * navegador aceita o cookie `Secure` -- se divergissem, haveria um nome que
 * entrega sessao e nao passa no portao, ou o contrario.
 */
export const LOOPBACK_HOST_NAME = 'localhost'

/** `port = *DIGIT` (RFC 3986 3.2.3). Vazio e legal e significa "a por omissao". */
const PORT = /^\d{0,5}$/u

/**
 * Separa a autoridade do `Host` do numero de porta. `undefined` = FORMA INVALIDA.
 *
 * ===========================================================================
 * A VERSAO ANTERIOR DESTA FUNCAO ACEITAVA LIXO COMO LOOPBACK. Medido:
 * ===========================================================================
 * Ela tratava TUDO depois do primeiro `:` como porta, sem olhar para o que la
 * estava, e ignorava TUDO depois do `]`. O resultado, contra dois servidores
 * reais com socket cru e uma rota a servir o segredo:
 *
 *   Host: 127.0.0.1:1234@evil.com    -> canonicalizava para 127.0.0.1  -> 200
 *   Host: 127.0.0.1:evil.com         -> canonicalizava para 127.0.0.1  -> 200
 *   Host: [::1]evil.com              -> canonicalizava para 127.0.0.1  -> 200
 *   Host: [127.0.0.1]qualquer-coisa  -> canonicalizava para 127.0.0.1  -> 200
 *
 * O cabecalho deste modulo promete o CONTRARIO -- "uma forma desconhecida
 * simplesmente NAO CASA e e recusada. Fecha por omissao" -- e a promessa nao
 * estava a ser cumprida. Nenhum NAVEGADOR produz estas formas (o `Host` sai de
 * uma autoridade ja parseada), mas qualquer cliente que escreva cabecalhos crus
 * produz, e ALCANCABILIDADE E PROPRIEDADE DA TOPOLOGIA: muda em `mode: 'named'`
 * ou com um proxy a frente. E L2.5 e a camada que a reescrita de `Host` nomeia
 * como a sustentacao da garantia depois de desarmar o anti-rebinding do nucleo
 * -- uma sustentacao que aceita `127.0.0.1:evil.com` como loopback deixou de ser
 * a garantia que esta escrita.
 *
 * AS UNICAS TRES FORMAS ACEITES, e cada carater delas e verificado:
 *
 *   `[::1]` / `[::1]:3080`  parenteses rectos: DEPOIS do `]` so pode vir nada,
 *                           ou `:` seguido de digitos;
 *   `1.2.3.4` / `:80`       sem parenteses e com UM `:`: a direita so digitos;
 *   `::1`                   mais do que um `:` sem parenteses e um IPv6 NU, que
 *                           nao pode levar porta e nao pode ser partido ao meio.
 *
 * A porta e descartada porque NAO faz parte da identidade -- o servidor escuta
 * numa porta so, e `evil.com:3080` nao e mais legitimo do que `evil.com`. Mas
 * descartar nao e ignorar: o que se descarta tem de ser mesmo uma porta.
 */
function stripPort(value: string): string | undefined {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return undefined // `[` sem fecho: forma invalida.

    const rest = value.slice(end + 1)
    if (rest.length > 0) {
      // Depois do `]` so pode vir `:<porta>`. `[::1]evil.com` nao e um `Host`.
      if (!rest.startsWith(':') || !PORT.test(rest.slice(1))) return undefined
    }
    return value.slice(1, end)
  }

  const first = value.indexOf(':')
  if (first === -1) return value

  // Mais do que um `:` sem parenteses: IPv6 nu, sem porta. Quem escrever
  // `::1:8080` esta a escrever um endereco, e e como endereco que e lido.
  if (value.indexOf(':', first + 1) !== -1) return value

  // `127.0.0.1:evil.com` e `127.0.0.1:1234@evil.com` morrem aqui.
  if (!PORT.test(value.slice(first + 1))) return undefined

  return value.slice(0, first)
}

const IPV4_TEXT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u
const IPV6_GROUP = /^[0-9a-f]{1,4}$/u

/**
 * Converte um grupo de texto IPv6 (ou o sufixo IPv4 embutido) em grupos
 * canonicos de 16 bits, sem zeros a esquerda. `undefined` = nao e IPv6 valido.
 */
function pushGroups(parts: readonly string[], out: string[]): boolean {
  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      // O sufixo IPv4 embutido so pode ser o ULTIMO grupo (`::ffff:127.0.0.1`).
      if (index !== parts.length - 1) return false
      const match = IPV4_TEXT.exec(part)
      if (match === null) return false
      const octets = [match[1], match[2], match[3], match[4]].map((o) => Number(o))
      if (octets.some((o) => !Number.isInteger(o) || o > 255)) return false
      out.push(
        (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16),
        (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16),
      )
      continue
    }
    if (!IPV6_GROUP.test(part)) return false
    out.push(Number.parseInt(part, 16).toString(16))
  }
  return true
}

/**
 * Expande um IPv6 (com ou sem `::`) para os seus OITO grupos canonicos.
 *
 * PORQUE E PRECISO: `::1`, `0:0:0:0:0:0:0:1` e `0000:0000:0000:0000:0000:0000:0000:0001`
 * sao o MESMO endereco escrito de tres maneiras, e uma comparacao textual
 * reconheceria uma e recusaria as outras duas. O mesmo vale para a forma
 * hexadecimal do IPv4 mapeado, `::ffff:7f00:1`, que e literalmente
 * `::ffff:127.0.0.1`.
 */
function expandIpv6(value: string): string[] | undefined {
  if (!value.includes(':')) return undefined

  const elision = value.indexOf('::')
  if (elision !== -1 && value.indexOf('::', elision + 2) !== -1) return undefined

  let headText: string
  let tailText: string
  if (elision === -1) {
    headText = value
    tailText = ''
  } else {
    headText = value.slice(0, elision)
    tailText = value.slice(elision + 2)
  }

  const head: string[] = []
  const tail: string[] = []
  if (!pushGroups(headText.length === 0 ? [] : headText.split(':'), head)) return undefined
  if (!pushGroups(tailText.length === 0 ? [] : tailText.split(':'), tail)) return undefined

  if (elision === -1) return head.length === 8 ? head : undefined

  const fill = 8 - head.length - tail.length
  if (fill < 0) return undefined
  return [...head, ...Array<string>(fill).fill('0'), ...tail]
}

/** `::1` e `::ffff:a.b.c.d` reduzidos a forma que `normalizeRemoteAddress` ja conhece. */
function collapseIpv6(groups: readonly string[]): string {
  const zeros = (upTo: number): boolean => groups.slice(0, upTo).every((g) => g === '0')

  if (zeros(7) && groups[7] === '1') return '::1'

  if (zeros(5) && groups[5] === 'ffff') {
    const high = Number.parseInt(groups[6] ?? '0', 16)
    const low = Number.parseInt(groups[7] ?? '0', 16)
    return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`
  }

  return groups.join(':')
}

/**
 * Reduz um cabecalho `Host` (ou uma entrada da allowlist) a uma CHAVE DE
 * COMPARACAO canonica. `undefined` = nao ha `Host` utilizavel.
 *
 * FRONTEIRA HOSTIL: o valor vem inteiro do cliente. Nao lanca, nao entra em
 * ciclo e nao aloca em funcao do tamanho da entrada -- devolve `undefined` e
 * deixa a decisao de recusar a quem chama.
 */
export function canonicalRequestHost(rawHost: string | undefined | null): string | undefined {
  if (typeof rawHost !== 'string') return undefined

  let value = rawHost.trim().toLowerCase()
  if (value.length === 0) return undefined

  // Um `Host` com vírgula sao DOIS cabecalhos `Host` colapsados pelo Node. Um
  // pedido conforme tem exatamente um; dois e request smuggling a bater a porta.
  if (value.includes(',')) return undefined

  // `Host` NAO tem userinfo (RFC 9110 7.2: e `uri-host [ ":" port ]`, e mais
  // nada). Um `@` so aparece quando alguem esta a colar uma autoridade de URL
  // no cabecalho, e a leitura de quem esta a colar nao e a nossa.
  if (value.includes('@')) return undefined

  // Branco no meio de uma autoridade nao existe; e enquadramento a ser testado.
  if (/\s/u.test(value)) return undefined

  const semPorta = stripPort(value)
  if (semPorta === undefined) return undefined
  value = semPorta

  // Zone id (`fe80::1%eth0`) nao faz parte da identidade do par.
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)

  // Ponto final de nome absoluto: `127.0.0.1.` e `localhost.` designam o mesmo
  // recurso e sao aceites por resolvers e por navegadores.
  while (value.endsWith('.') && value.length > 1) value = value.slice(0, -1)

  if (value.length === 0) return undefined

  const groups = expandIpv6(value)
  if (groups !== undefined) value = collapseIpv6(groups)

  // A NORMALIZACAO FINAL E A MESMA DA PONTA REMOTA. Ver o cabecalho do modulo.
  return normalizeRemoteAddress(value)
}

/** `localhost` e qualquer subdominio dele (RFC 6761). */
function isLocalhostName(host: string): boolean {
  return host === LOOPBACK_HOST_NAME || host.endsWith(`.${LOOPBACK_HOST_NAME}`)
}

/** `127.0.0.0/8` inteiro -- e nao apenas `127.0.0.1`. */
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u

/**
 * O pedido foi feito a um nome LOCAL?
 *
 * ===========================================================================
 * ESTA PERGUNTA NAO E "passou em `trustedRemotes`?" NEM "passou na allowlist?"
 * ===========================================================================
 * E a distincao que fecha um furo real. Sob `cloudflared`, um pedido vindo da
 * internet publica:
 *
 *   - passa em L2, porque quem abre o socket e o `cloudflared`, que corre em
 *     `127.0.0.1` e portanto ESTA em `trustedRemotes`;
 *   - passa em L2.5, porque a origem do tunel e DELIBERADAMENTE acrescentada a
 *     allowlist de `Host` enquanto o tunel esta `READY` -- e para isso que o
 *     tunel existe.
 *
 * As duas camadas defendem de OUTROS PROCESSOS LOCAIS e de DNS REBINDING. Nao
 * defendem -- e nao podem defender -- da internet que o tunel deixa entrar de
 * propriedade. Uma rota que exija "canal local apenas" tem de perguntar ISTO, e
 * nao aquilo.
 *
 * `02-SEGURANCA.md` 4.4 e literal sobre o canal de entrega do segredo
 * persistente: **"Canal local apenas, sem excecao"**, e escreve o endereco
 * `http://127.0.0.1:3080/__guard/secret?ott=<token>`. O `127.0.0.1` ali nao e
 * ilustracao: e o controlo.
 *
 * Aceita `127.0.0.0/8` inteiro (nao so `.1`), as grafias de loopback IPv6 que
 * {@link canonicalRequestHost} ja colapsou, e `localhost`/`*.localhost`.
 */
export function isLoopbackRequestHost(rawHost: string | undefined): boolean {
  const host = canonicalRequestHost(rawHost)
  if (host === undefined) return false
  if (isLocalhostName(host)) return true
  return IPV4_LOOPBACK.test(host)
}

/**
 * Monta a allowlist de `Host` a partir do que o servidor E, agora.
 *
 * O `tunnelOrigin` entra SE E SO SE o tunel estiver `READY` -- e sai quando ele
 * cai. `src/contracts/tunnel.ts` torna isso estrutural: `TunnelSnapshot.info`
 * existe se e so se `state === 'READY'`. Uma entrada morta nesta lista e um nome
 * que continua a ser aceite depois de deixar de nos pertencer -- e um nome de
 * `*.trycloudflare.com` derrubado volta a ser distribuido a outra pessoa.
 *
 * @param bindHost o `ctx.webServer.host` efetivo -- o endereco por que este
 *   servidor responde de facto.
 * @param tunnelOrigin a origem publica do tunel (`https://x.trycloudflare.com`)
 *   quando, e apenas quando, ele esta `READY`.
 */
export function buildAllowedRequestHosts(
  bindHost: string,
  tunnelOrigin: string | undefined,
): readonly string[] {
  const hosts = new Set<string>()

  // Loopback, sempre: e por ai que o dono chega a maquina dele.
  hosts.add('127.0.0.1')
  hosts.add(LOOPBACK_HOST_NAME)

  const bind = canonicalRequestHost(bindHost)
  if (bind !== undefined) hosts.add(bind)

  const tunnel = hostOfOrigin(tunnelOrigin)
  if (tunnel !== undefined) hosts.add(tunnel)

  return [...hosts]
}

/** O host de uma origem absoluta (`https://x.y/`), ja canonico. `undefined` se nao houver. */
export function hostOfOrigin(origin: string | undefined): string | undefined {
  if (typeof origin !== 'string' || origin.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    // Origem malformada nao entra na allowlist. Nao lanca: quem publica a origem
    // e outro modulo, e um valor mau dele nao pode derrubar o portao -- so pode
    // deixar de abrir a porta, que e a direccao segura.
    return undefined
  }
  return canonicalRequestHost(parsed.host)
}

/**
 * O `Host` deste pedido e aceitavel?
 *
 * AUSENTE E RECUSADO. `Host` e OBRIGATORIO em HTTP/1.1 (RFC 9112, 3.2: *"A
 * client MUST send a Host header field [...] A server MUST respond with a 400
 * (Bad Request) status code to any HTTP/1.1 request message that lacks a Host
 * header field"*), e um navegador envia-o sempre e nao deixa o script mexer
 * nele. Um pedido sem `Host` so pode vir de um socket cru -- e nesse caso a
 * unica leitura segura de "nao disse por que nome me pediu" e recusar.
 */
export function isAllowedRequestHost(
  rawHost: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  const host = canonicalRequestHost(rawHost)
  if (host === undefined) return false
  if (isLocalhostName(host)) return true

  return allowedHosts.some((entry) => {
    const allowed = canonicalRequestHost(entry)
    return allowed !== undefined && allowed === host
  })
}

/**
 * O cliente escreveu o NOME PUBLICO DO TUNEL no cabecalho `Host`?
 *
 * ===========================================================================
 * LEIA O NOME DA PERGUNTA. NAO E "o pedido passou pela borda?".
 * ===========================================================================
 * A versao anterior deste JSDoc chamava-lhe "o pedido chegou pelo tunel?", e
 * isso AFIRMAVA MAIS DO QUE A FUNCAO GARANTE. O que ela compara e uma string
 * escolhida pelo cliente com o hostname do tunel. Um processo LOCAL que abra um
 * socket direto para `127.0.0.1:<porta>` e escreva `Host: <hostname-do-tunel>`
 * e indistinguivel, aqui, de um pedido que atravessou mesmo a borda -- e ele
 * passa L2, porque `127.0.0.1` esta em `trustedRemotes` por desenho.
 *
 * >>> RESIDUAL DECLARADO, com o alcance exato. <<< Com
 * `exposure.trustEdgeHeaders: true` (opt-in, `false` no manifesto, e recusado
 * fora de `mode: 'tunnel'`), um processo local pode escolher o proprio balde do
 * limitador -- rodando o IP evade o lockout por identidade -- e escrever IPs a
 * escolha no log append-only. Nao e escalada de privilegio: ele nao ganha
 * credencial nenhuma, e ja executa codigo na maquina. Mas e o modo de falha que
 * as duas condicoes de `mayTrustEdgeClientIp` dizem impedir, e elas nao o
 * impedem -- adiam-no atras de uma chave que ninguem liga por omissao.
 *
 * O QUE FECHARIA ISTO, e porque nao esta feito: seria preciso uma prova
 * INDEPENDENTE do `Host` de que o byte veio da borda -- na pratica, o tunel
 * apontar para um listener de loopback DEDICADO a exposicao, e o portao ler a
 * porta local do socket em vez de um cabecalho. Isso muda o alvo do
 * `cloudflared`, que e do supervisor do tunel (T3.1), e uma sub-tarefa nao
 * redesenha o alvo de outra a meio de uma onda paralela. Fica NOMEADO em vez de
 * insinuado, que e a diferenca entre um limite conhecido e um buraco.
 *
 * Usado em dois sitios, e o residual pesa DIFERENTE em cada um:
 *   - MODO RESTRITO: escrever o nome do tunel so pode FECHAR a porta a si
 *     proprio (a credencial passa a ser recusada). Ninguem forja isto para
 *     ganhar acesso;
 *   - `trustEdgeHeaders`: e onde o residual acima vive.
 */
export function arrivedViaTunnel(
  rawHost: string | undefined,
  tunnelOrigin: string | undefined,
): boolean {
  const tunnel = hostOfOrigin(tunnelOrigin)
  if (tunnel === undefined) return false
  const host = canonicalRequestHost(rawHost)
  return host !== undefined && host === tunnel
}
