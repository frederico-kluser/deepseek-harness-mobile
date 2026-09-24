/**
 * Contadores de falha por identidade, EM MEMORIA, com disposer sincrono.
 *
 * DONO: T2.3.
 *
 * ---------------------------------------------------------------------------
 * POR IP, POR SESSAO OU GLOBAL? A resposta e MEDIDA, nao assumida (spike S2)
 * ---------------------------------------------------------------------------
 * `docs/spikes/cloudflared.md`, VEREDITO S2 CONFIRMADO: `CF-Connecting-IP` chega
 * com o IP real e a borda recusa com `403` quem o envie do lado cliente; mas
 * `X-Forwarded-For` e ACRESCENTADO ao do cliente (forjado primeiro, real por
 * ultimo), logo e FORJAVEL. E a ressalva que decide tudo: a origem e
 * `127.0.0.1` e qualquer processo local forja `CF-Connecting-IP` ligando-se
 * direto.
 *
 * CONSEQUENCIA, DECLARADA E NAO FINGIDA: enquanto `exposure.trustEdgeHeaders`
 * for `false` (o default, e hoje o unico valor possivel — T3.3), `Identity.ip`
 * chega `undefined` e conta-se por SESSAO quando ha sessao, por GLOBAL quando
 * nao ha — e numa tentativa de LOGIN ainda nao ha sessao, logo o caso real e o
 * balde global. E a leitura honesta de "toda a gente e 127.0.0.1": um balde so,
 * com o teto NIST da conta como controlo principal (`04-TESTES.md` ORIG-015). E
 * porque o balde e um so, o BAN DURO NAO SE APLICA A ELE — ver
 * `banAppliesToScope` em `policy.ts`, que documenta o auto-DoS remoto que essa
 * regra fecha.
 *
 * DIVERGENCIA DECLARADA face a ORIG-015 (`04-TESTES.md` 575): o texto manda
 * derivar a identidade de `req.socket.remoteAddress`. NAO derivamos, de
 * proposito — S2 mediu que sob tunel esse endereco e SEMPRE `127.0.0.1`, e usa-lo
 * daria um balde unico com nome de IP: a mesma coisa que o global, mas a fingir
 * que discrimina clientes. O efeito e o que ORIG-015 prescreve ("todas as
 * tentativas colapsam numa identidade so"); o que muda e que o colapso fica
 * VISIVEL no tipo (`scope: 'global'`).
 *
 * Este modulo NAO le cabecalhos, NAO le sockets e NAO tem como inventar um IP:
 * recebe uma `Identity` ja resolvida.
 *
 * ---------------------------------------------------------------------------
 * CONTRATO PARA T3.3 — LEIA ANTES DE FIAR O GATE
 * ---------------------------------------------------------------------------
 * A prova de que o atraso corre ANTES da comparacao em tempo constante vive em
 * {@link runThrottledAttempt} e SO LA. Se o gate reimplementar a sequencia a
 * mao, a prova nao acompanha o codigo e o oraculo de timing volta sem que um so
 * teste desta onda fique vermelho. CHAME `runThrottledAttempt`; NAO COPIE OS
 * PASSOS. E tambem so ele garante que uma credencial verificada como CORRETA
 * nunca conta para o teto NIST.
 *
 * ---------------------------------------------------------------------------
 * MEMORIA: o limitador nao pode virar o proprio DoS
 * ---------------------------------------------------------------------------
 * `check()` NUNCA aloca — so `recordFailure()` cria balde. Os baldes vivem num
 * `Map` com teto (`maxTrackedIdentities`) e ordem de insercao usada como LRU. A
 * chave e um `sha256` truncado de 32 caracteres: tamanho fixo seja qual for o
 * que o cliente apresentou, e o id de sessao em claro nao fica retido. O
 * contador da CONTA e um numero unico, nao evitavel por rotacao de identidade.
 */
import type { Identity, RateLimiter } from '../contracts/auth.ts';
import { type IdentityBucket, type RateLimitPolicy } from './policy.ts';
export { GLOBAL_BUCKET_KEY, resolveIdentityBucket, type IdentityBucket, type IdentityScope, } from './policy.ts';
/** O que `recordFailure` devolve (T3.3 alimenta `restricted.ts` com isto). */
export interface FailureRecord {
    readonly bucket: IdentityBucket;
    readonly identityFailures: number;
    readonly accountFailures: number;
    readonly banned: boolean;
    readonly ceilingReached: boolean;
}
export interface TrackerSnapshot {
    readonly trackedIdentities: number;
    readonly accountFailures: number;
    readonly ceilingReached: boolean;
}
/** Costura injetavel sobre `setInterval`/`clearInterval`. */
export interface IntervalScheduler {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}
export declare const nodeIntervalScheduler: IntervalScheduler;
export interface TrackerDeps {
    readonly policy: RateLimitPolicy;
    readonly now: () => number;
    readonly random: () => number;
    /** Teto de baldes vivos. Ver "MEMORIA" no cabecalho. */
    readonly maxTrackedIdentities: number;
    /**
     * Varredura periodica OPCIONAL (`05-QUALIDADE-CODIGO.md` 1.6: o disposer do
     * rate limit faz `clearInterval` + esvaziar mapa). Ausente por omissao de
     * proposito: a poda e preguicosa e o teto LRU ja limita a memoria, logo um
     * temporizador so nasce se alguem o pedir.
     */
    readonly sweep?: {
        readonly everyMs: number;
        readonly scheduler: IntervalScheduler;
    } | undefined;
}
/** Satisfaz `RateLimiter` (contrato congelado) e acrescenta o que o gate precisa. */
export interface FailureTracker extends RateLimiter {
    /**
     * Decide ANTES de comparar a credencial. Nao aloca, nao muta, nao ve a
     * credencial. `retryAfterMs` e ATRASO INTERNO — nunca cabecalho `Retry-After`.
     */
    check(identity: Identity): {
        allowed: boolean;
        retryAfterMs: number;
    };
    recordFailure(identity: Identity): FailureRecord;
    recordSuccess(identity: Identity): void;
    /** Credencial CORRETA recusada por ban de identidade. Ver a implementacao. */
    recordVerifiedButDenied(identity: Identity): void;
    snapshot(): TrackerSnapshot;
    /** Q-2: SINCRONO. `clearInterval` + esvaziar o mapa. Idempotente. */
    dispose(): void;
}
export declare function createFailureTracker(deps: TrackerDeps): FailureTracker;
export interface ThrottledAttemptOutcome {
    readonly granted: boolean;
    /** Quanto se esperou ANTES de comparar. Interno. Nunca vai para o fio. */
    readonly delayMs: number;
    readonly deniedByBan: boolean;
    readonly accountFailures: number;
    readonly ceilingReached: boolean;
}
/**
 * A SEQUENCIA OBRIGATORIA, num sitio so — a resposta a "o atraso roda antes ou
 * depois da comparacao em tempo constante?".
 *
 *   1. `check()`  — decide a partir das falhas ANTERIORES. Nao ve a credencial.
 *   2. `wait()`   — o atraso corre AQUI, ANTES de qualquer comparacao.
 *   3. `verify()` — a comparacao corre SEMPRE, exatamente uma vez, mesmo com a
 *                   identidade banida: e o que faz o caminho "banido" e o de
 *                   senha errada custarem as mesmas operacoes (RL-013).
 *   4. veredito   — credencial CORRETA durante ban e NEGADA (RL-011), mas NAO
 *                   conta como falha da conta.
 *
 * Se o passo 2 corresse depois do 3, ou se o atraso dependesse do resultado de
 * `verify()`, o limitador viraria o oraculo de timing que existe para fechar. A
 * ordem esta aqui, e nao no gate, para poder ser testada sem HTTP.
 *
 * OS TRES RAMOS DO VEREDITO, e porque sao tres e nao dois. Um simples
 * `granted ? recordSuccess : recordFailure` contava uma credencial CORRETA como
 * falha de conta sempre que a identidade estivesse banida; e, como o sucesso era
 * impossivel durante o ban, `recordSuccess` ficava inalcancavel e o "SHOULD
 * disregard any previous failed attempts" do NIST nunca podia disparar — o dono,
 * a insistir com a senha certa, empurrava-se sozinho ate ao teto de 100. Hoje:
 * correto+permitido -> sucesso; correto+banido -> recusa SEM contar falha
 * (`recordVerifiedButDenied`); errado -> falha. Nenhum dos tres muda o que sai
 * no fio — bytes e atraso sao os mesmos —, logo a diferenca nao e oraculo.
 */
export declare function runThrottledAttempt(tracker: FailureTracker, identity: Identity, verify: () => boolean, wait: (ms: number) => Promise<void>): Promise<ThrottledAttemptOutcome>;
//# sourceMappingURL=tracker.d.ts.map