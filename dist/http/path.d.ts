/**
 * `canonicalRequestPath`, `isGuardedPath`, `routeMayServeGuardedPath` --
 * canonicalizacao de caminhos e a relacao "cai sob um prefixo declarado".
 */
/**
 * `decodeURIComponent` que nao rebenta. Uma sequencia percent malformada
 * (`%zz`, `%` solto) lanca `URIError`; num caminho de decisao de seguranca uma
 * excecao seria pior do que a string por decodificar, por isso devolve-se a
 * entrada intacta e deixa-se a normalizacao seguinte tratar dela.
 *
 * EXPORTADA, e a razao importa: `src/permissions/deny.ts` precisa exatamente da
 * mesma primitiva para canonicalizar tokens de permissao percent-codificados
 * (`danger%2Dfull%2Daccess`). Duplicar uma primitiva de descodificacao de
 * entrada hostil e como as duas copias divergem; e um ficheiro `utils.ts` para a
 * partilhar e proibido por nome. Fica no modulo que ja e o dono da
 * descodificacao de caminho.
 */
export declare function safeDecodeURIComponent(value: string): string;
/**
 * Reduz um caminho (de requisicao OU de registo) a uma CHAVE DE COMPARACAO
 * canonica. Nao e um caminho utilizavel para servir ficheiros -- e apenas a
 * forma normalizada com que se decide se algo cai sob um prefixo declarado.
 *
 * O que e neutralizado, e porque (cada item corresponde a um contorno real da
 * barreira observado em laboratorio):
 *
 *   - percent-encoding, aplicado ATE ESTABILIZAR (limite de 3 passagens):
 *     `/%61pi` e `/%2561pi` designam `/api` depois de uma e de duas
 *     descodificacoes. O limite existe para nao dar ao atacante um ciclo
 *     arbitrario a custo zero;
 *   - barras invertidas -> barras normais: `\api` e uma grafia aceite por
 *     varias pilhas HTTP e por navegadores em Windows;
 *   - barras repetidas colapsadas: `//api/x` e `/api/x` sao o mesmo recurso
 *     para um encaminhador por prefixo;
 *   - segmentos `.` e `..` resolvidos: `/x/../api` nao pode escapar a guarda;
 *   - caixa: comparacao insensivel a maiusculas. Isto SOBRE-GUARDA (`/API` passa
 *     a ser tratado como guardado mesmo onde o encaminhador do DSH e sensivel a
 *     maiusculas), o que e a direcao segura: guardar a mais devolve 401 a um
 *     pedido que nao existiria; guardar a menos e a #853.
 */
export declare function canonicalRequestPath(rawUrl: string | undefined): string;
/**
 * Decide se um caminho cai sob um dos prefixos declarados (relacao DESCENDENTE:
 * o caminho esta DENTRO do prefixo).
 *
 * A fronteira e feita ao SEGMENTO e nao ao caractere: `/api` cobre `/api` e
 * `/api/commands/execute`, mas NAO cobre `/apinfo` -- que e um recurso distinto
 * e cuja captura acidental produziria 401 em rotas legitimas.
 *
 * Ambos os lados passam por {@link canonicalRequestPath}, pelo que `//api`,
 * `/API`, `/%61pi` e `/x/../api` sao todos reconhecidos como `/api`.
 */
export declare function isGuardedPath(rawUrl: string | undefined, guardedPrefixes: readonly string[]): boolean;
/**
 * Decide se um REGISTO de rota pode servir superficie declarada como plano de
 * controlo.
 *
 * PORQUE NAO BASTA {@link isGuardedPath}: a decisao ao nivel do registo nao pode
 * olhar so para rotas DENTRO do prefixo. Uma rota registada como `kind:
 * 'prefix'` num ANCESTRAL do prefixo -- no caso limite, em `/` -- serve
 * `/api/commands/execute` sem nunca ter `/api` no seu proprio `path`. Provado em
 * laboratorio: com `guardedPrefixes: ['/api']`, uma rota `prefix` em `/`
 * respondia 200 a um POST nao autenticado para `/api/commands/execute`.
 *
 * Logo a relacao e verdadeira em DUAS situacoes:
 *   - DESCENDENTE: o caminho registado esta dentro de um prefixo declarado
 *     (`/api/health` sob `/api`) -- a rota so serve superficie do plano de
 *     controlo;
 *   - ANCESTRAL: o caminho registado esta ACIMA de um prefixo declarado e o
 *     registo e por prefixo (`/` ou `/a` como `prefix`, com `/api` declarado) --
 *     a rota PODE servir essa superficie.
 *
 * Uma rota `exact` num ancestral nao entra: por definicao serve exatamente
 * aquele caminho e nunca alcanca `/api/...`.
 *
 * NOTA DE PAPEL: a barreira desta onda e dona do DESPACHO e guarda a superficie
 * inteira, pelo que ja nao consulta este predicado para decidir o que embrulhar.
 * Ele permanece porque continua a ser a definicao correcta de "este registo toca
 * o plano de controlo" -- que e o que a politica por rota do painel `/__guard`
 * (Onda 3, D5) precisa de exprimir.
 */
export declare function routeMayServeGuardedPath(route: {
    kind: string;
    path: string;
}, guardedPrefixes: readonly string[]): boolean;
//# sourceMappingURL=path.d.ts.map