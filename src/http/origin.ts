/**
 * `normalizeRemoteAddress`, `isTrustedRemote` -- perimetro de rede.
 */

/**
 * Normaliza um endereco de socket para uma forma canonica comparavel.
 *
 * O Node entrega enderecos IPv4 em sockets dual-stack no formato IPv6-mapeado
 * (`::ffff:127.0.0.1`). Sem normalizacao, uma allowlist com `'127.0.0.1'`
 * falharia contra o MESMO cliente so por causa da representacao.
 *
 * O loopback IPv6 (`::1`) e colapsado para `127.0.0.1` porque e a MESMA origem
 * local: assim a allowlist nao precisa de duplicar entradas. As proprias
 * entradas de `trustedRemotes` passam por esta funcao, logo escrever `'::1'` no
 * YAML continua a funcionar.
 */
export function normalizeRemoteAddress(address: string | undefined | null): string | undefined {
  if (typeof address !== 'string') return undefined

  let value = address.trim().toLowerCase()
  if (value.length === 0) return undefined

  // Zone id de link-local (`fe80::1%eth0`) nao faz parte da identidade do par.
  const zoneIndex = value.indexOf('%')
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex)

  // Forma entre parenteses rectos usada em autoridades de URL (`[::1]`).
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)

  // IPv4 mapeado em IPv6.
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)

  // Loopback IPv6, nas duas grafias possiveis.
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') value = '127.0.0.1'

  return value.length === 0 ? undefined : value
}

/**
 * Politica de sub-rede confiada.
 *
 * SEMANTICA FAIL-CLOSED EXPLICITA E INTENCIONAL:
 *   `trustedRemotes: []` significa NINGUEM E CONFIADO -- nega tudo, incluindo o
 *   proprio loopback. Nao ha "lista vazia = toda a gente", que e a interpretacao
 *   permissiva que produz exatamente a falha #853. Quem quiser servir o loopback
 *   tem de escrever `['127.0.0.1']` no `cordis.patch.yml`; a permissao e sempre
 *   um ato deliberado do administrador, nunca um efeito colateral de uma
 *   omissao.
 *
 * Um socket sem `remoteAddress` (ja destruido, ou transporte nao-IP) tambem e
 * negado: na duvida, fecha-se.
 */
export function isTrustedRemote(
  address: string | undefined | null,
  trustedRemotes: readonly string[],
): boolean {
  if (trustedRemotes.length === 0) return false

  const remote = normalizeRemoteAddress(address)
  if (remote === undefined) return false

  return trustedRemotes.some((entry) => normalizeRemoteAddress(entry) === remote)
}
