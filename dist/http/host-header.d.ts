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
export declare const LOOPBACK_HOST_NAME = "localhost";
/**
 * Reduz um cabecalho `Host` (ou uma entrada da allowlist) a uma CHAVE DE
 * COMPARACAO canonica. `undefined` = nao ha `Host` utilizavel.
 *
 * FRONTEIRA HOSTIL: o valor vem inteiro do cliente. Nao lanca, nao entra em
 * ciclo e nao aloca em funcao do tamanho da entrada -- devolve `undefined` e
 * deixa a decisao de recusar a quem chama.
 */
export declare function canonicalRequestHost(rawHost: string | undefined | null): string | undefined;
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
export declare function isLoopbackRequestHost(rawHost: string | undefined): boolean;
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
export declare function buildAllowedRequestHosts(bindHost: string, tunnelOrigin: string | undefined): readonly string[];
/** O host de uma origem absoluta (`https://x.y/`), ja canonico. `undefined` se nao houver. */
export declare function hostOfOrigin(origin: string | undefined): string | undefined;
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
export declare function isAllowedRequestHost(rawHost: string | undefined, allowedHosts: readonly string[]): boolean;
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
export declare function arrivedViaTunnel(rawHost: string | undefined, tunnelOrigin: string | undefined): boolean;
//# sourceMappingURL=host-header.d.ts.map