/**
 * =============================================================================
 * DESCOBERTA DA URL DO QUICK TUNNEL — `GET /quicktunnel` + regex sobre STDERR.
 * =============================================================================
 *
 * DONO: T3.2. Implementa `TunnelDiscovery` de `src/contracts/tunnel.ts`
 * (CONGELADO no COMMIT PREP 3 — leitura livre, escrita proibida).
 *
 * PORQUE DOIS CAMINHOS, E PORQUE NENHUM DELES E DECORATIVO
 * -----------------------------------------------------------------------------
 * Os dois foram MEDIDOS contra `cloudflared 2026.7.3`, e cada facto medido aqui
 * e o que impede a proxima pessoa de "simplificar" e reintroduzir o defeito:
 *
 *   1. A URL sai 100 % em STDERR. Em duas execucoes medidas o `stdout` ficou
 *      com EXATAMENTE 0 bytes. Quem capturar so `stdout` nunca ve a URL. E por
 *      isso que `TunnelDiscoveryInput` so tem `stderr` — e por isso que este
 *      ficheiro nao contem a palavra `stdout` fora de comentario.
 *   2. `--output json` NAO ajuda: a URL continua embutida numa caixa ASCII
 *      dentro do campo `message`. Nao ha caminho estruturado nos logs.
 *   3. O endpoint `/quicktunnel` NAO esta documentado na pagina oficial de
 *      metricas, que so menciona `/metrics`. Ele e fiavel mas NAO e contratual:
 *      pode desaparecer numa versao qualquer sem aviso e sem nota de release.
 *      Logo o fallback por regex e OBRIGATORIO, e nao um cinto a mais.
 *   4. Entre lancar o processo e a URL aparecer mediram-se 6-7 SEGUNDOS. Daqui
 *      sai o piso de 30 s do timeout: nao e folga generosa, e margem para
 *      maquina lenta e rede de saida congestionada.
 *   5. Num dos runs medidos o STDERR chegou ANTES do endpoint (7826 ms contra
 *      8031 ms). Por isso o ciclo consulta os DOIS em cada volta em vez de
 *      esgotar um antes de tentar o outro.
 *
 * PORQUE A PORTA DE METRICAS ENTRA POR PARAMETRO E NUNCA E ADIVINHADA
 * -----------------------------------------------------------------------------
 * A documentacao afirma a faixa 20241-20245; o binario 2026.7.3 afirma
 * `localhost:0`, ou seja porta ALEATORIA. Duas fontes, duas afirmacoes
 * incompativeis — e a porta e ainda DISPUTADA entre instancias. Adivinhar a
 * faixa e o defeito TUN-011. Aqui a porta chega em
 * `TunnelDiscoveryInput.metricsPort`, ja fixada por quem faz o `spawn` (T3.1)
 * com `--metrics 127.0.0.1:<porta>`, e um valor que nao seja porta valida e
 * RECUSADO em vez de ser corrigido por defeito silencioso.
 *
 * O QUE ESTE MODULO NAO FAZ, DE PROPOSITO
 * -----------------------------------------------------------------------------
 *   - NAO faz `spawn`, NAO mata processo, NAO conhece `ChildProcess`. Recebe o
 *     `stderr` ja aberto e um `AbortSignal` ja ligado ao `'close'`/`'error'`.
 *   - NAO ESCREVE EM DISCO (TUN-015). A URL de um quick tunnel muda a cada
 *     arranque: um valor velho lido do disco entrega um link MORTO com toda a
 *     confianca. O que se persiste e `pid` + `startedAt` (T2.5), nunca a URL.
 *     Este ficheiro nao importa `node:fs` nem `../state/**` — e ha um teste que
 *     o assere lendo o proprio fonte, porque a regra so vale se for verificavel.
 *   - NAO valida seguranca. "A aplicacao responde" nao e "a aplicacao responde
 *     401 a quem nao tem credencial". Ver o cabecalho de `readiness.ts`.
 *
 * Strip-only mode (`node --test` corre estes `.ts` sem os compilar): sem `enum`,
 * sem `namespace`, sem parameter properties. Import relativo leva `.ts`.
 */
import type { Readable } from 'node:stream';
import type { TunnelDiscovery, TunnelFailure, TunnelFailureCode } from '../contracts/tunnel.ts';
/**
 * Erro tipado com codigo estavel (`05-QUALIDADE-CODIGO.md` 6.1), no mesmo molde
 * de `GuardError` (`src/errors.ts`) e `StateError` (`src/state/schema.ts`): a
 * mensagem e para o humano e pode ser reescrita; o `code` e para o programa e so
 * muda por quebra deliberada.
 *
 * `implements TunnelFailure` NAO e enfeite: o contrato manda `discover()`
 * rejeitar com um `TunnelFailure`, e um objecto cru lancado com `throw` perderia
 * o `stack` e falharia qualquer `instanceof Error` a jusante. Sendo as duas
 * coisas ao mesmo tempo, o supervisor pode po-lo directamente em
 * `TunnelSnapshot.failure` e o log continua a ver um `Error` de verdade.
 *
 * DIVERGENCIA DELIBERADA FACE A `GuardError`/`StateError`: aqui a `message` NAO
 * leva o prefixo `[<plugin>] <CODIGO>:`. Aquelas duas sobem para o log do DSH no
 * meio do de outros plugins, onde um erro sem dono e um erro que ninguem
 * investiga. Esta atravessa a invariante de apresentacao do contrato — e
 * MOSTRADA ao dono no painel e no Telegram — e ali o prefixo e ruido para quem
 * ja sabe de que bot veio a notificacao. Quem precisa de identificar a origem
 * por programa tem o `code`, que e exactamente para isso.
 *
 * `probe` fica por declarar: e opcional no contrato e so e preenchido em
 * `PROBE_FAILED`, que e do probe fail-closed de T3.1 e nunca sai daqui.
 */
export declare class TunnelError extends Error implements TunnelFailure {
    readonly name = "TunnelError";
    readonly code: TunnelFailureCode;
    readonly retryable: boolean;
    constructor(code: TunnelFailureCode, message: string, retryable: boolean, options?: ErrorOptions);
}
/**
 * Piso do `timeoutMs`. A medicao deu 6-7 s; 30 s e o piso que o contrato exige e
 * o que este modulo faz cumprir. Um valor mais curto e RECUSADO, nunca elevado
 * em silencio: um timeout que o codigo corrige por dentro diz ao operador que
 * ele configurou uma coisa e executa outra.
 */
export declare const MIN_DISCOVERY_TIMEOUT_MS = 30000;
/**
 * A URL como ela sai no `stderr`, ja com esquema.
 *
 * Sem `g`: `RegExp` global guarda `lastIndex` entre chamadas, e um padrao ao
 * nivel do modulo com estado seria estado global de modulo — a coisa que
 * `05-QUALIDADE-CODIGO.md` proibe. Sem `g`, `exec` devolve sempre a
 * PRIMEIRA ocorrencia (TUN-008), que e a que interessa: a caixa ASCII repete a
 * mesma URL e um `stderr` com duas URLs so pode ter a boa em primeiro lugar.
 */
export declare const STDERR_URL_PATTERN: RegExp;
/**
 * O que o `/quicktunnel` tem direito a devolver em `hostname`.
 *
 * ANCORADO NOS DOIS EXTREMOS, e e isso que faz o trabalho. O endpoint e input
 * NAO CONFIAVEL: e um processo externo, nao documentado, a falar por um socket.
 * Um `hostname` que ja venha com esquema NAO casa com este padrao e por isso e
 * RECUSADO — nunca prefixado — o que torna `https://https://...` inconstruivel
 * em vez de meramente improvavel (TUN-002).
 */
export declare const QUICKTUNNEL_HOSTNAME_PATTERN: RegExp;
/**
 * Resultado de UMA tentativa HTTP.
 *
 * `'unreachable'` NAO e excepcao engolida: durante o warmup medido de 6-7 s o
 * servidor de metricas AINDA NAO EXISTE, e um `ECONNREFUSED` ali e a condicao
 * esperada, nao um erro. A distincao fica no tipo em vez de ficar num `catch`
 * mudo, e o `reason` sobe ate a mensagem final para que o operador saiba se
 * ninguem atendeu ou se atenderam mal.
 */
export type HttpProbe = {
    readonly kind: 'response';
    readonly status: number;
    readonly body: string;
} | {
    readonly kind: 'unreachable';
    readonly reason: string;
};
export interface HttpProbeOptions {
    readonly target: URL;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    /** `0` descarta o corpo assim que os cabecalhos chegam. */
    readonly maxBodyBytes: number;
}
/**
 * Um GET, sem credencial nenhuma, com tecto de tempo e de corpo.
 *
 * >>> `auth: null` E O SEGUNDO FECHO, E NAO E ENFEITE. <<<
 * `http.request(url, ...)` chama `urlToHttpOptions(url)`, que copia
 * `url.username`/`url.password` para `options.auth`, e o `ClientRequest`
 * transforma isso num cabecalho `Authorization: Basic ...` sem avisar ninguem.
 * Um endereco com `dono:senha@` chega aqui e pulveriza o segredo na borda a
 * cada volta do ciclo — ate 1200 voltas por sessao de readiness. O primeiro
 * fecho e recusar o endereco em `parseUsableUrl` (`readiness.ts`); este e o
 * segundo, para o dia em que aparecer um chamador que nao passe por la.
 *
 * DUAS defesas contra socket pendurado, e sao DUAS porque cada uma cobre um
 * caminho diferente. A matriz foi MEDIDA (servidor local, tres pedidos,
 * `getConnections()` 60 ms depois):
 *
 *   agent:false + connection:close   corpo consumido -> 0   corpo por ler -> 0
 *   so agent:false                   corpo consumido -> 0   corpo por ler -> 0
 *   so connection:close              corpo consumido -> 0   corpo por ler -> 0
 *   nenhum dos dois                  corpo consumido -> 1   corpo por ler -> 1
 *
 * Ou seja: as tres eram MUTUAMENTE REDUNDANTES, e por isso nenhum teste
 * conseguia distinguir a remocao de UMA delas — foi o que a revisao
 * adversarial mostrou, com o teste anterior a sobreviver a remocao das tres.
 * `connection: close` FOI RETIRADO: era a unica que dependia de o servidor
 * cooperar, e mante-la so servia para tornar as outras duas infalsificaveis.
 *
 * Ficaram as duas que cobrem caminhos distintos, e agora cada uma tem o seu
 * teste que a mata:
 *   - `agent: false` — sem pool. O `globalAgent` do Node ja vem com `keepAlive`
 *     ligado; sem isto, cada arranque de tunel deixava uma ligacao a borda
 *     viva. Cobre o caminho em que o corpo E consumido (`/quicktunnel`).
 *   - `res.destroy()` no caminho `maxBodyBytes === 0` — sem ele, uma resposta
 *     com corpo que ninguem le prende o socket. Cobre o readiness, que so quer
 *     o codigo de estado e nunca le a pagina de erro que a borda devolve.
 *
 * O `reason` de falha usa SO o `code` do erro (`ECONNREFUSED`, `ETIMEDOUT`, ...)
 * e nunca a `message`: mensagens de erro de rede do Node embutem caminho de
 * socket e nome de host, e este texto pode acabar numa notificacao de Telegram.
 */
export declare function probeHttp(options: HttpProbeOptions): Promise<HttpProbe>;
/** O alvo do caminho primario. Sempre `127.0.0.1`, nunca `localhost`. */
export declare function quickTunnelUrl(metricsPort: number): URL;
/** Leitor de `stderr` com disposer SINCRONO (Q-2). */
export interface StderrScanner {
    /** A primeira URL vista ate agora, ou `null`. */
    url(): string | null;
    /** Motivo de o fluxo ter falhado, se falhou. Diagnostico, nunca engolido. */
    failure(): string | null;
    /** Remove o listener. Sincrono, idempotente. */
    dispose(): void;
}
/**
 * Acumula `stderr` e devolve a PRIMEIRA URL que passar pelo padrao.
 *
 * PORQUE ACUMULA EM VEZ DE CASAR CHUNK A CHUNK: o `stderr` de um processo chega
 * em pedacos arbitrarios, definidos pelo buffer do pipe e nao pelas linhas. A
 * URL parte-se ao meio com toda a naturalidade (TUN-006) e um parser que testa
 * cada chunk isolado perde-a sem deixar rasto.
 *
 * SOBRE O `StringDecoder`, e com honestidade: ele NAO e o que faz TUN-006
 * passar. A URL e 100 % ASCII, e `Buffer.toString('utf8')` sobre um pedaco
 * cortado a meio de um caractere multi-byte so troca ESSE caractere por
 * U+FFFD — a URL continuava a casar. Quem faz TUN-006 passar e o acumulador,
 * duas linhas acima. O decodificador esta ca para o TEXTO A VOLTA da URL (a
 * caixa que o `cloudflared` real desenha com `─` e `│`) nao ficar corrompido no
 * dia em que alguem quiser ler daqui mais do que a URL. Nao ha teste que o
 * distinga, e ele foi tentado: o mutante e equivalente. Fica declarado como
 * higiene, nao como garantia medida.
 */
export declare function createStderrScanner(stream: Readable | null): StderrScanner;
/**
 * O tempo e a rede entram por parametro. Sem isto, provar TUN-009 custava 30
 * segundos de relogio de parede por execucao e provar TUN-004 exigia derrubar
 * um servidor a meio do teste.
 */
export interface DiscoveryDeps {
    readonly now: () => number;
    /** Tem de REJEITAR quando `signal` aborta — e o que torna TUN-010 imediato. */
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly probeQuickTunnel: (metricsPort: number, signal: AbortSignal, timeoutMs: number) => Promise<HttpProbe>;
    readonly pollIntervalMs: number;
    readonly attemptTimeoutMs: number;
}
export declare const defaultDiscoveryDeps: DiscoveryDeps;
/**
 * O que uma sondagem ao endpoint produziu, ja classificado.
 *
 * Exportado porque `readQuickTunnelBody` o devolve e a emissao de `.d.ts`
 * precisa de o conseguir nomear — e porque a validacao de fronteira e
 * exactamente o que a revisao adversarial quer poder exercitar isolada.
 */
export type MetricsReading = {
    readonly kind: 'url';
    readonly url: string;
} | {
    readonly kind: 'rejected';
    readonly reason: string;
};
/**
 * Valida na fronteira e confia no interior.
 *
 * O corpo vem de um processo externo por um endpoint NAO DOCUMENTADO. Aqui ele e
 * tratado como texto hostil: tem de ser JSON, tem de ser objecto, `hostname` tem
 * de ser string e tem de casar com {@link QUICKTUNNEL_HOSTNAME_PATTERN} INTEIRO.
 * O que nao casar e recusado — nunca prefixado e devolvido.
 */
export declare function readQuickTunnelBody(body: string): MetricsReading;
/**
 * Constroi a implementacao de {@link TunnelDiscovery}.
 *
 * FABRICA e nao singleton: `05-QUALIDADE-CODIGO.md` proibe estado global de
 * modulo, e as dependencias fechadas nesta closure sao por INSTANCIA. Dois
 * tuneis em paralelo — ou dois testes no mesmo ficheiro — nao partilham nada.
 */
export declare function createTunnelDiscovery(deps?: DiscoveryDeps): TunnelDiscovery;
//# sourceMappingURL=discover.d.ts.map