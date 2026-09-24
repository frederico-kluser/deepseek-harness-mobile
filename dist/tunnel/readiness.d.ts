/**
 * =============================================================================
 * READINESS DO TUNEL — "a URL ja responde?", e SO isso.
 * =============================================================================
 *
 * DONO: T3.2. Implementa `TunnelReadiness` de `src/contracts/tunnel.ts`
 * (CONGELADO no COMMIT PREP 3 — leitura livre, escrita proibida).
 *
 * >>> A FRONTEIRA QUE JA CUSTOU CARO. LEIA ANTES DE MEXER. <<<
 * -----------------------------------------------------------------------------
 * Existem DUAS perguntas parecidas, e confundi-las expos o DSH real do
 * utilizador publicamente durante cerca de 40 segundos durante a pesquisa que
 * originou este plugin:
 *
 *   READINESS (este ficheiro)   "a URL do tunel ja responde?"
 *                               Corre DEPOIS de o tunel subir.
 *
 *   PROBE FAIL-CLOSED (T3.1,    "o portao esta armado, isto e, responde 401 a
 *   `src/tunnel/probe.ts`)      quem nao tem credencial?"
 *                               Corre ANTES de o tunel subir, contra
 *                               `127.0.0.1`, e e PRE-CONDICAO de
 *                               `STOPPED -> STARTING`.
 *
 *       "a aplicacao responde"  !=  "a aplicacao responde 401 a quem nao tem
 *                                    credencial"
 *
 * Consequencia directa e contra-intuitiva, escrita aqui para nao ser
 * "corrigida" por engano: um `200` observado por este modulo conta como PRONTO.
 * Ele NAO e o sitio onde se descobre que o portao esta aberto — nessa altura o
 * tunel JA ESTA no ar e a fuga JA aconteceu. Quem tem de recusar um `200`
 * anonimo e o probe de T3.1, antes de existir tunel nenhum. Transformar este
 * ficheiro num segundo probe de seguranca da uma sensacao de rede dupla e
 * fabrica exactamente o buraco que ja se pagou uma vez: a verificacao mudava
 * para DEPOIS da exposicao.
 *
 * E por isso, tambem, que `ReadinessOutcome` carrega `status: number | null` em
 * vez de um booleano so: "porta aberta" e "aplicacao respondeu" nao sao a mesma
 * afirmacao, e o contrato obriga quem chama a olhar para o codigo observado.
 * Um socket que aceita a ligacao e nunca escreve nada devolve
 * `{ usable: false, status: null }` — nao ha nenhum codigo para mostrar porque
 * nunca houve resposta nenhuma.
 *
 * O QUE ESTE MODULO NAO FAZ
 * -----------------------------------------------------------------------------
 *   - NAO envia credencial. As sondagens sao ANONIMAS: mandar a senha do dono
 *     para a borda a cada volta do ciclo era espalhar o segredo por um caminho
 *     que nao precisa dele. Isto tem DOIS fechos, porque a promessa e forte
 *     demais para depender de um: `parseUsableUrl` RECUSA um endereco com
 *     `utilizador:senha@`, e `probeHttp` forca `auth: null` para o caso de
 *     aparecer um chamador que nao passe por aqui. Em `tunnel.mode: 'named'` a
 *     URL vem do dominio do utilizador, por configuracao, e NAO passa por
 *     `discover()` — o caminho e alcancavel em producao.
 *   - NAO ESCREVE EM DISCO (TUN-015), pela mesma razao de `discover.ts`: a URL
 *     de um quick tunnel muda a cada arranque e um valor velho entrega um link
 *     morto com toda a confianca.
 *   - NAO poe a URL em mensagem de erro nenhuma. A invariante de apresentacao
 *     do contrato e explicita: `message` e mostrada ao dono no painel e no
 *     Telegram, e a URL do tunel e informacao sensivel de operacao.
 *
 * Strip-only mode: sem `enum`, sem `namespace`, sem parameter properties.
 */
import { type HttpProbe } from './discover.ts';
import type { TunnelReadiness } from '../contracts/tunnel.ts';
/**
 * A aplicacao produziu esta resposta?
 *
 * Exportado para que a decisao seja exercitavel sozinha: e a linha que a revisao
 * adversarial vai querer falsificar, e uma politica que so se consegue observar
 * atraves de um ciclo de sondagem e uma politica que ninguem revê.
 *
 * REPARE NO QUE ESTA AUSENTE: nao ha nenhuma comparacao com `401`. Ver o
 * cabecalho do ficheiro — este modulo NAO e o probe de seguranca.
 */
export declare function isApplicationResponse(status: number): boolean;
/**
 * Tecto do `timeoutMs`.
 *
 * Existe para matar, pela raiz, o mutante "timeout infinito": um readiness que
 * se pode configurar para esperar para sempre tem o mesmo defeito que um
 * `Infinity` escrito a mao — o arranque fica preso e nenhum estado terminal
 * chega a ser observado. Dez minutos ja e generoso face aos 6-7 s medidos.
 */
export declare const MAX_READINESS_TIMEOUT_MS = 600000;
export interface ReadinessDeps {
    readonly now: () => number;
    /** Tem de REJEITAR quando `signal` aborta — e o que torna o corte imediato. */
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly probeUrl: (target: URL, signal: AbortSignal, timeoutMs: number) => Promise<HttpProbe>;
    readonly pollIntervalMs: number;
    readonly attemptTimeoutMs: number;
}
export declare const defaultReadinessDeps: ReadinessDeps;
/**
 * Constroi a implementacao de {@link TunnelReadiness}.
 *
 * FABRICA e nao singleton, pela mesma razao de `createTunnelDiscovery`: nada de
 * estado global de modulo.
 */
export declare function createTunnelReadiness(deps?: ReadinessDeps): TunnelReadiness;
//# sourceMappingURL=readiness.d.ts.map