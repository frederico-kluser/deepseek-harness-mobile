/**
 * `assertSecureBind`, `isWildcardBindHost` -- politica de BIND.
 *
 * E a primeira linha de defesa contra a discussao oficial #853: `0.0.0.0` / `::`
 * expoem a sub-estacao `/api` a rede inteira. A exposicao legitima faz-se sempre
 * por proxy reverso TLS autenticado A FRENTE deste loopback, nunca alargando o
 * bind.
 *
 * NOTA: `allowedHosts` e a allowlist do BIND (a interface onde o servidor
 * escuta) e nao tem qualquer relacao com `trustedRemotes` (a origem de cada
 * requisicao). Sao duas allowlists distintas por desenho.
 */

import { PLUGIN_NAME } from '../errors.ts'
import type { BindHost } from '../dsh/adapter.ts'

/** Grafias literais que significam "escuta em TODAS as interfaces de rede". */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '*', ''])

/**
 * Conjunto FECHADO de hosts que o `WebServer` real pode reportar.
 *
 * `WebServer['host']` e a uniao de literais `'127.0.0.1' | '0.0.0.0'` -- nao
 * `string`. Isso torna a allowlist de bind exaustiva EM TEMPO DE COMPILACAO: se
 * uma versao futura do host acrescentar um terceiro literal (dual-stack `'::'`,
 * por exemplo), `KNOWN_BIND_HOSTS` deixa de o cobrir e a linha abaixo deixa de
 * compilar -- em vez de o novo valor entrar em producao sem ninguem reavaliar a
 * politica.
 */
export const KNOWN_BIND_HOSTS = ['127.0.0.1', '0.0.0.0'] as const satisfies readonly BindHost[]

/** `never` (e portanto erro de compilacao) se algum `BindHost` ficar de fora. */
type UncoveredBindHost = Exclude<BindHost, (typeof KNOWN_BIND_HOSTS)[number]>
const _everyBindHostIsCovered: UncoveredBindHost extends never ? true : never = true
void _everyBindHostIsCovered

/**
 * Decide se um endereco de bind e o curinga "todas as interfaces".
 *
 * PORQUE NAO BASTA UM `Set` DE LITERAIS: o curinga tem muitas grafias
 * equivalentes que o `bind(2)` aceita e que passavam ilesas pela lista fixa --
 * `0` (forma curta do `inet_aton`, que expande para 0.0.0.0), `0.0`, o
 * `0.0.0.0.` com ponto final de nome absoluto, `::0`, `0000:0000:...:0000`,
 * `[::]` com zone id. Falhar em reconhecer qualquer uma delas e abrir a
 * sub-estacao `/api` a rede inteira -- a #853 na integra.
 *
 * A funcao continua a aceitar `string` (e nao so `BindHost`) de proposito: o
 * mesmo predicado valida as entradas de `config.allowedHosts`, que vem de YAML
 * editavel a mao e onde qualquer grafia pode aparecer.
 */
export function isWildcardBindHost(host: string): boolean {
  let value = host.trim().toLowerCase()

  // Forma entre parenteses rectos usada em autoridades de URL (`[::]`).
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)

  // Zone id (`::%eth0`) nao faz parte da identidade do endereco.
  const zoneIndex = value.indexOf('%')
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex)

  // Ponto final de nome absoluto (`0.0.0.0.`).
  if (value.endsWith('.')) value = value.slice(0, -1)

  // IPv4 curinga mapeado em IPv6 (`::ffff:0.0.0.0`).
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)

  if (WILDCARD_BIND_HOSTS.has(value)) return true

  // IPv4 so com zeros e pontos: `0`, `0.0`, `0.0.0.0` -- todos sao 0.0.0.0
  // para o `inet_aton`, todos significam "todas as interfaces".
  if (/^[0.]+$/u.test(value)) return true

  // IPv6 so com zeros e dois-pontos: `::`, `::0`, `0:0:...:0`, `0000:...:0000`.
  if (value.includes(':') && /^[0:]+$/u.test(value)) return true

  return false
}

/**
 * Valida o BIND do servidor web.
 *
 * Se o host efetivo nao estiver na allowlist, o plugin recusa carregar:
 * prefere-se o DSH nao arrancar a arrancar aberto.
 */
export function assertSecureBind(host: string, allowedHosts: readonly string[]): void {
  if (isWildcardBindHost(host)) {
    throw new Error(
      `[${PLUGIN_NAME}] Bind inseguro: ctx.webServer.host = '${host}'. ` +
        'Escutar em todas as interfaces expoe a sub-estacao /api sem credenciais ' +
        '(discussao oficial #853). Fixa o bind no loopback e publica por proxy reverso TLS.',
    )
  }

  if (!allowedHosts.includes(host)) {
    throw new Error(
      `[${PLUGIN_NAME}] Bind nao autorizado: ctx.webServer.host = '${host}' ` +
        `nao consta de config.allowedHosts (${allowedHosts.join(', ')}).`,
    )
  }
}
