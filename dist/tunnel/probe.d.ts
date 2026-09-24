/**
 * =============================================================================
 * PROBE FAIL-CLOSED — pre-condicao de `STOPPED -> STARTING` (D11 / 02 L1).
 * =============================================================================
 *
 * ISTO CORRE ANTES DO `spawn`. Nao e detalhe de ordem: se corresse depois, a
 * janela de exposicao ja teria aberto e o controlo seria um relatorio, nao um
 * portao. O supervisor (`./supervisor.ts`) chama `runGateProbe` e SO chama
 * `start()` do processo se o resultado passar; com o gate desarmado nao existe
 * `spawn` nenhum (TUN-020..TUN-023).
 *
 * -----------------------------------------------------------------------------
 * PORQUE QUATRO SONDAS E NAO UMA
 * -----------------------------------------------------------------------------
 * O modo de falha real e ORDEM DE CARREGAMENTO, e nao "o gate nao foi instalado".
 * Medido em `docs/spikes/superficie-ui.md` sobre a composicao real de 196
 * pacotes: `/` vem do `registerFallback` de `@deepseek-ai/dsh-host-frontend-static`
 * e `/api` e um PREFIXO nomeado de `@deepseek-ai/dsh-client-connection` — outro
 * pacote, outro momento de registo, outra tabela de rotas. O roteador consulta as
 * tabelas nomeadas ANTES do fallback. E portanto perfeitamente possivel — e e o
 * caso mais provavel — que o fallback caia DEPOIS do nosso `apply()` e o `/api`
 * ANTES: o probe de `/` passa, o tunel sobe, e `POST /api/...` fica publico.
 *
 * Provar `/` NAO prova `/api`. Foi exatamente essa diferenca que expos o DSH real
 * do utilizador, publicamente e sem autenticacao, durante ~40 segundos.
 *
 * -----------------------------------------------------------------------------
 * FAIL-CLOSED ATE NO PROPRIO ERRO
 * -----------------------------------------------------------------------------
 * Excepcao, timeout ou erro de rede DENTRO do probe conta como FALHA (TUN-025).
 * Nunca "nao consegui medir, entao deixa subir". `runGateProbe` nao lanca: devolve
 * sempre um veredito, e o veredito de um erro e `passed: false`.
 *
 * As sondas sao ANONIMAS — nenhuma leva credencial. Uma sonda autenticada mediria
 * "a aplicacao responde a quem tem credencial", que e a pergunta errada.
 */
import type { AuditSink } from '../contracts/auth.ts';
import type { ProbeId, ProbeOutcome, TunnelFailure } from '../contracts/tunnel.ts';
/** Codigo que TODA sonda anonima tem de receber de um gate armado. */
export declare const EXPECTED_STATUS = 401;
/**
 * RPC de LEITURA usada pela sonda 2. Tem de ser de leitura: se o gate estiver
 * desarmado, o pedido CHEGA a aplicacao, e uma sonda que escreve deixaria efeito
 * colateral exatamente no cenario em que ja ha um problema de seguranca.
 *
 * O caminho so precisa de estar sob o prefixo `/api` — o gate decide ANTES do
 * encaminhamento, portanto o que se mede e o prefixo, nao a existencia do metodo.
 * Um `404` aqui e tao reprovado quanto um `200`: os dois significam que o pedido
 * passou do gate para o roteador.
 */
export declare const DEFAULT_API_READ_PATH = "/api/state";
/** Prefixo do canario. Fora de `guardedPrefixes` de proposito (D11, sonda 4). */
export declare const CANARY_PATH_PREFIX = "/__guard/probe-canary-";
/** O que uma sonda observou na camada de transporte. */
export type ProbeTransportResult = {
    readonly kind: 'response';
    readonly status: number;
}
/** O servidor destruiu o socket sem completar uma resposta HTTP. */
 | {
    readonly kind: 'destroyed';
}
/** Nao houve medicao: rede, timeout ou excepcao. FALHA, sempre. */
 | {
    readonly kind: 'error';
    readonly reason: string;
};
/** Um pedido de sonda, ja resolvido (o canario ja tem o sufixo aleatorio). */
export interface ProbeRequest {
    readonly probe: ProbeId;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}
/** Costura de rede do probe. Injetada: nenhum teste unitario abre socket. */
export interface ProbeTransport {
    send(request: ProbeRequest, signal: AbortSignal): Promise<ProbeTransportResult>;
}
export interface GateProbeInput {
    readonly transport: ProbeTransport;
    /** Sufixo aleatorio do canario. Injetado para o teste ser determinista. */
    readonly canaryToken: string;
    /** Aborta as sondas quando o ciclo de vida do supervisor e descartado. */
    readonly signal: AbortSignal;
    /** Caminho da RPC de leitura da sonda 2. Ver {@link DEFAULT_API_READ_PATH}. */
    readonly apiReadPath?: string | undefined;
}
export interface GateProbeResult {
    readonly passed: boolean;
    /** SEMPRE as quatro, na ordem do plano — e o que vai para a auditoria. */
    readonly outcomes: readonly ProbeOutcome[];
    /** Presente sse `passed === false`. NOMEIA a sonda que reprovou. */
    readonly failure?: TunnelFailure | undefined;
}
/**
 * As quatro sondas, na ordem canonica de D11.
 *
 * A ordem e estavel porque a auditoria e a mensagem ao dono a citam; trocar a
 * ordem mudaria o significado de um registo ja escrito.
 */
export declare function buildProbePlan(canaryToken: string, apiReadPath?: string): readonly ProbeRequest[];
/** Decide se UMA sonda passou. Toda a politica fail-closed esta aqui. */
export declare function judgeProbe(probe: ProbeId, result: ProbeTransportResult): ProbeOutcome;
/**
 * Corre as QUATRO sondas e devolve o veredito.
 *
 * NUNCA LANCA. Uma excepcao que escapasse daqui subiria para o chamador e, num
 * `catch` distraido la em cima, viraria "o probe nao correu, continua". As quatro
 * correm SEMPRE, mesmo depois de a primeira reprovar: a auditoria de TUN-024
 * exige o resultado das quatro, e um relatorio parcial esconde se o gate falhou
 * numa superficie ou em todas.
 */
export declare function runGateProbe(input: GateProbeInput): Promise<GateProbeResult>;
/**
 * Mensagem que NOMEIA a sonda reprovada.
 *
 * INVARIANTE DE APRESENTACAO: viaja para o painel e para o Telegram. Sem segredo,
 * sem caminho absoluto de ficheiro e sem a URL do tunel — a mensagem sai da
 * maquina, e um caminho de ficheiro numa mensagem que sai da maquina divulga o
 * layout do disco do utilizador a um terceiro.
 */
export declare function describeFailure(outcome: ProbeOutcome): TunnelFailure;
/** Nomes de evento. O vocabulario fechado e de T5.4 (`src/audit/events.ts`). */
export declare const EVENTO_PROBE = "tunel_probe";
export declare const EVENTO_PROBE_DECISAO = "tunel_probe_decisao";
/**
 * Regista o resultado das QUATRO sondas e a decisao final (TUN-024).
 *
 * PORQUE UMA LINHA POR SONDA e nao um resumo: seis meses depois, "o probe
 * reprovou" nao diz onde o portao estava aberto. Uma linha por superficie diz.
 * O nome do evento leva o codigo observado, porque um `404` no canario significa
 * uma coisa muito diferente de um `200` — e essa diferenca e o achado.
 *
 * PODE LANCAR: o sink e fail-closed por desenho (disco cheio recusa escrever), e
 * quem chama TEM de tratar a excepcao como recusa de subida. Um tunel que sobe
 * sem prova de que o portao foi verificado e o estado que isto existe para impedir.
 */
export declare function auditProbeDecision(audit: AuditSink, result: GateProbeResult): void;
export interface HttpProbeTransportOptions {
    /** Sempre `127.0.0.1`: o probe mede a ORIGEM local, nunca a borda. */
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
}
/**
 * Transporte real das sondas.
 *
 * DISTINGUIR "destruido" DE "erro" e a unica subtileza: a sonda 3 aceita um
 * socket destruido e as outras tres nao, portanto confundir os dois casos ou
 * deixava passar um gate desarmado (se `error` contasse como destruido) ou
 * impedia o tunel de subir com o gate armado (o contrario). O discriminador e se
 * a ligacao TCP chegou a estabelecer-se: um `ECONNREFUSED` acontece ANTES disso,
 * um `ECONNRESET` provocado pelo `socket.destroy()` do gate acontece DEPOIS.
 */
export declare function createHttpProbeTransport(options: HttpProbeTransportOptions): ProbeTransport;
//# sourceMappingURL=probe.d.ts.map