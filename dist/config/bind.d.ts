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
export declare const KNOWN_BIND_HOSTS: readonly ["127.0.0.1", "0.0.0.0"];
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
export declare function isWildcardBindHost(host: string): boolean;
/**
 * Valida o BIND do servidor web.
 *
 * Se o host efetivo nao estiver na allowlist, o plugin recusa carregar:
 * prefere-se o DSH nao arrancar a arrancar aberto.
 */
export declare function assertSecureBind(host: string, allowedHosts: readonly string[]): void;
//# sourceMappingURL=bind.d.ts.map