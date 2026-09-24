/**
 * Vocabulario de falha do supervisor de processos, e a CLASSIFICACAO que decide
 * se vale a pena tentar outra vez.
 *
 * PORQUE UM MODULO PROPRIO: "classificar a causa" e uma decisao pura, sem I/O e
 * sem tempo, e por isso e a peca mais facil de testar do ciclo de vida. Deixa-la
 * dentro do supervisor obrigava a montar um subprocesso inteiro para verificar
 * uma comparacao de strings.
 *
 * -----------------------------------------------------------------------------
 * PORQUE `retryable: false` EXISTE, e porque nao e o mesmo que "acabou o
 * orcamento"
 * -----------------------------------------------------------------------------
 * Um binario ausente do `PATH` nao aparece na tentativa seguinte, nem na decima.
 * Consumir dez tentativas de orcamento, com backoff exponencial pelo meio, para
 * chegar a conclusao que a PRIMEIRA falha ja continha e gastar minutos a produzir
 * a mesma mensagem. Pior: o log fica com dez linhas de "reinicio agendado" e uma
 * de "orcamento esgotado", o que faz o operador procurar instabilidade quando o
 * problema e uma instalacao em falta.
 *
 * ARMADILHA MEDIDA (`08-PESQUISA-E-FONTES.md`, facto 520, e o cabecalho de
 * `supervisor.ts`): num `ENOENT` do `child_process` cru a sequencia e
 * `error -> close`, e `'exit'` NUNCA dispara. Quem escuta so `'exit'` fica
 * pendurado para sempre EXATAMENTE neste caso -- o mais comum de todos. O
 * assento `SubprocessHandle` colapsa os dois eventos numa promessa (`done`
 * rejeita em falha de spawn), mas a classificacao continua a ser nossa: o assento
 * "carrega DELIBERADAMENTE nenhuma classificacao de causa" e diz ao consumidor
 * para a fazer.
 */
/**
 * Causas que NAO melhoram com uma nova tentativa.
 *
 * - `BINARY_NOT_FOUND`      — `ENOENT`: o `argv[0]` nao existe (ou nao esta no `PATH`).
 * - `BINARY_NOT_EXECUTABLE` — `EACCES`/`EPERM`: existe, mas nao tem bit de execucao.
 * - `INVALID_SPEC`          — o construtor do spec recusou-se a montar um spawn
 *   (config invalida). Nunca chega a haver processo.
 */
export type NonRetryableKind = 'BINARY_NOT_FOUND' | 'BINARY_NOT_EXECUTABLE' | 'INVALID_SPEC';
/** Todas as causas TERMINAIS: as nao-retryable mais o fim do orcamento. */
export type ProcessFailureKind = NonRetryableKind | 'BUDGET_EXHAUSTED';
/**
 * Falha terminal de um processo supervisionado.
 *
 * `retryable` e literalmente `false` porque TODA falha descrita por este tipo e
 * terminal: uma falha retryable nao produz `ProcessFailure` nenhum, produz um
 * reinicio agendado. O campo existe para que o consumidor possa projeta-lo em
 * `TunnelFailure` (que tem os dois casos) sem inventar o valor.
 */
export interface ProcessFailure {
    readonly kind: ProcessFailureKind;
    /** Accionavel, sem segredo e sem caminho absoluto: pode ser MOSTRADA ao dono. */
    readonly message: string;
    readonly retryable: false;
    /** Codigo `errno` observado, quando houve um. Para log/diagnostico, nao para UI. */
    readonly errno?: string | undefined;
}
/**
 * Erro lancado pelo construtor de spec de um processo supervisionado.
 *
 * Existe para que `INVALID_SPEC` seja reconhecivel por TIPO e nao por texto: um
 * `Error` generico vindo do construtor podia ser qualquer defeito de programacao,
 * e tratar defeito de programacao como "config invalida" esconderia o defeito.
 */
export declare class SpawnSpecError extends Error {
    readonly name = "SpawnSpecError";
}
/**
 * Extrai o `errno` de um erro de spawn, atravessando `cause`.
 *
 * PORQUE ATRAVESSA `cause` E TAMBEM OLHA O TEXTO: o assento de subprocessos e
 * ABSTRACTO. A implementacao local propaga o erro do `child_process`, mas nada no
 * contrato obriga uma implementacao remota a preservar a propriedade `code` — ela
 * pode embrulhar o erro (`cause`) ou reduzi-lo a uma mensagem. O texto e o ultimo
 * recurso e esta ancorado em fronteira de palavra para que um caminho chamado
 * `/opt/enoent-tools/bin` nao seja lido como um `ENOENT`.
 */
export declare function spawnErrno(error: unknown): string | undefined;
/**
 * Classifica um erro de spawn. `undefined` significa "retryable": a falha pode
 * ser transitoria e o orcamento decide quantas vezes se insiste.
 *
 * FAIL-CLOSED PELO LADO CONTRARIO, e e deliberado: o default aqui e RETRYABLE,
 * nao terminal. Classificar mal como terminal para um processo que so teve um
 * soluco; classificar mal como retryable gasta orcamento e acaba em
 * `BUDGET_EXHAUSTED`, que tambem e terminal e tambem e visivel. O erro caro e o
 * primeiro.
 */
export declare function classifyNonRetryable(error: unknown): NonRetryableKind | undefined;
/**
 * Mensagem accionavel para uma causa nao-retryable.
 *
 * INVARIANTE DE APRESENTACAO (herdada de `src/contracts/tunnel.ts`): este texto
 * pode ser MOSTRADO ao dono, no painel e no Telegram. Logo NAO pode conter
 * segredo, token, caminho absoluto de ficheiro nem URL. `name` e o nome CURTO do
 * processo (`'cloudflared'`, `'worker'`), nunca o `argv` — o `argv` traz caminhos
 * absolutos e um caminho absoluto numa mensagem que sai da maquina divulga o
 * layout do disco do utilizador a um terceiro.
 */
export declare function describeNonRetryable(kind: NonRetryableKind, name: string): string;
//# sourceMappingURL=failure.d.ts.map