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
export declare function normalizeRemoteAddress(address: string | undefined | null): string | undefined;
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
export declare function isTrustedRemote(address: string | undefined | null, trustedRemotes: readonly string[]): boolean;
//# sourceMappingURL=origin.d.ts.map