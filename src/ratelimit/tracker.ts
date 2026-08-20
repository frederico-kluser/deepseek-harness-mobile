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

import type { Identity, RateLimiter } from '../contracts/auth.ts'
import { PLUGIN_NAME } from '../errors.ts'
import {
  assertRateLimitPolicy,
  banAppliesToScope,
  computeAuthDelayMs,
  hasReachedBruteForceCeiling,
  isBanTriggeredBy,
  resolveIdentityBucket,
  type IdentityBucket,
  type RateLimitPolicy,
} from './policy.ts'

// A resolucao de identidade em balde e decisao de POLITICA (que escopo existe,
// e qual pode ser banido), logo vive em `policy.ts`. Reexportada aqui porque e
// por este modulo que o gate a consome.
export {
  GLOBAL_BUCKET_KEY,
  resolveIdentityBucket,
  type IdentityBucket,
  type IdentityScope,
} from './policy.ts'

interface Counter {
  failures: number
  lastFailureAt: number
  bannedUntil: number
}

/** O que `recordFailure` devolve (T3.3 alimenta `restricted.ts` com isto). */
export interface FailureRecord {
  readonly bucket: IdentityBucket
  readonly identityFailures: number
  readonly accountFailures: number
  readonly banned: boolean
  readonly ceilingReached: boolean
}

export interface TrackerSnapshot {
  readonly trackedIdentities: number
  readonly accountFailures: number
  readonly ceilingReached: boolean
}

/** Costura injetavel sobre `setInterval`/`clearInterval`. */
export interface IntervalScheduler {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const nodeIntervalScheduler: IntervalScheduler = {
  setInterval(callback: () => void, ms: number): unknown {
    const handle = globalThis.setInterval(callback, ms)
    handle.unref()
    return handle
  },
  clearInterval(handle: unknown): void {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>)
  },
}

export interface TrackerDeps {
  readonly policy: RateLimitPolicy
  readonly now: () => number
  readonly random: () => number
  /** Teto de baldes vivos. Ver "MEMORIA" no cabecalho. */
  readonly maxTrackedIdentities: number
  /**
   * Varredura periodica OPCIONAL (`05-QUALIDADE-CODIGO.md` 1.6: o disposer do
   * rate limit faz `clearInterval` + esvaziar mapa). Ausente por omissao de
   * proposito: a poda e preguicosa e o teto LRU ja limita a memoria, logo um
   * temporizador so nasce se alguem o pedir.
   */
  readonly sweep?: { readonly everyMs: number; readonly scheduler: IntervalScheduler } | undefined
}

/** Satisfaz `RateLimiter` (contrato congelado) e acrescenta o que o gate precisa. */
export interface FailureTracker extends RateLimiter {
  /**
   * Decide ANTES de comparar a credencial. Nao aloca, nao muta, nao ve a
   * credencial. `retryAfterMs` e ATRASO INTERNO — nunca cabecalho `Retry-After`.
   */
  check(identity: Identity): { allowed: boolean; retryAfterMs: number }
  recordFailure(identity: Identity): FailureRecord
  recordSuccess(identity: Identity): void
  /** Credencial CORRETA recusada por ban de identidade. Ver a implementacao. */
  recordVerifiedButDenied(identity: Identity): void
  snapshot(): TrackerSnapshot
  /** Q-2: SINCRONO. `clearInterval` + esvaziar o mapa. Idempotente. */
  dispose(): void
}

const EVICTION_SCAN_BUDGET = 64

export function createFailureTracker(deps: TrackerDeps): FailureTracker {
  assertRateLimitPolicy(deps.policy)
  if (!Number.isInteger(deps.maxTrackedIdentities) || deps.maxTrackedIdentities <= 0) {
    throw new Error(
      `[${PLUGIN_NAME}] RATE_LIMIT_TRACKER_INVALID: maxTrackedIdentities tem de ser inteiro positivo`,
    )
  }

  const counters = new Map<string, Counter>()
  let accountFailures = 0
  let disposed = false
  let sweepHandle: unknown

  const assertLive = (): void => {
    if (disposed) {
      throw new Error(
        `[${PLUGIN_NAME}] RATE_LIMIT_TRACKER_DISPOSED: o limitador ja foi disposto; ` +
          'usar um limitador morto e aceitar tudo em silencio',
      )
    }
  }

  /** Um balde so pode ser esquecido quando nao ha ban vivo NEM janela viva. */
  const isForgettable = (counter: Counter, at: number): boolean =>
    at >= counter.bannedUntil && at - counter.lastFailureAt > deps.policy.observationWindowMs

  const prune = (at: number): void => {
    for (const [key, counter] of counters) {
      if (isForgettable(counter, at)) counters.delete(key)
    }
  }

  /**
   * Despeja para caber no teto. Prefere baldes SEM ban vivo: despejar um ban
   * seria uma forma de o lavar criando identidades novas. Se so houver banidos
   * dentro do orcamento, despeja o mais antigo — e o contador da CONTA, que nao
   * e evitavel, continua a ser a rede de seguranca.
   */
  const evictIfNeeded = (at: number): void => {
    if (counters.size < deps.maxTrackedIdentities) return

    let scanned = 0
    let oldest: string | undefined
    for (const [key, counter] of counters) {
      if (oldest === undefined) oldest = key
      if (at >= counter.bannedUntil) {
        counters.delete(key)
        return
      }
      scanned += 1
      if (scanned >= EVICTION_SCAN_BUDGET) break
    }
    if (oldest !== undefined) counters.delete(oldest)
  }

  const effectiveFailures = (counter: Counter, at: number): number =>
    isForgettable(counter, at) ? 0 : counter.failures

  const check = (identity: Identity): { allowed: boolean; retryAfterMs: number } => {
    assertLive()
    const at = deps.now()
    const counter = counters.get(resolveIdentityBucket(identity).key)
    const failures = counter === undefined ? 0 : effectiveFailures(counter, at)
    const banned = counter !== undefined && at < counter.bannedUntil

    return {
      allowed: !banned,
      retryAfterMs: computeAuthDelayMs(failures, deps.policy, deps.random),
    }
  }

  const recordFailure = (identity: Identity): FailureRecord => {
    assertLive()
    const at = deps.now()
    const bucket = resolveIdentityBucket(identity)

    let counter = counters.get(bucket.key)
    if (counter !== undefined && isForgettable(counter, at)) {
      counters.delete(bucket.key)
      counter = undefined
    }
    if (counter === undefined) {
      evictIfNeeded(at)
      counter = { failures: 0, lastFailureAt: at, bannedUntil: 0 }
    } else {
      // Reinserir no fim mantem a ordem de insercao do Map util como LRU.
      counters.delete(bucket.key)
    }
    counters.set(bucket.key, counter)

    counter.failures += 1
    counter.lastFailureAt = at

    // DUAS guardas, cada uma fecha um auto-DoS distinto. `banAppliesToScope`:
    // o balde `global` NUNCA e banido, porque banir toda a gente inclui o dono
    // (ver `policy.ts`). `at >= bannedUntil`: o ban e ARMADO na transicao e
    // nunca REARMADO por pedidos feitos durante ele — sem isto, um pedido por
    // hora mantinha a identidade fora para sempre.
    if (
      banAppliesToScope(bucket.scope) &&
      at >= counter.bannedUntil &&
      isBanTriggeredBy(counter.failures, deps.policy)
    ) {
      counter.bannedUntil = at + deps.policy.banDurationMs
    }
    accountFailures += 1

    return {
      bucket,
      identityFailures: counter.failures,
      accountFailures,
      banned: at < counter.bannedUntil,
      ceilingReached: hasReachedBruteForceCeiling(accountFailures, deps.policy),
    }
  }

  /**
   * NIST 3.2.2: "the verifier SHOULD disregard any previous failed attempts".
   * Zera a escada da identidade e da conta, mas NAO levanta um ban vivo: deixar
   * um sucesso lava-lo daria de volta o que RL-011 fecha.
   */
  const recordSuccess = (identity: Identity): void => {
    assertLive()
    const bucket = resolveIdentityBucket(identity)
    const counter = counters.get(bucket.key)
    if (counter !== undefined) counter.failures = 0
    accountFailures = 0
  }

  /**
   * A credencial verificou-se CORRETA mas o pedido foi recusado por um ban de
   * identidade. NAO e uma "failed authentication attempt" na leitura do NIST:
   * nao incrementa, nao rearma, e QUEBRA a serie de falhas consecutivas da
   * conta — e o que impede o dono de ser empurrado ao teto pelo atacante. Zera
   * SO o contador da conta: o balde fica banido, porque o ban e da origem e nao
   * da credencial (RL-011), e levanta-lo aqui seria lavar o proprio ban.
   */
  const recordVerifiedButDenied = (): void => {
    assertLive()
    accountFailures = 0
  }

  if (deps.sweep !== undefined) {
    sweepHandle = deps.sweep.scheduler.setInterval(() => {
      prune(deps.now())
    }, deps.sweep.everyMs)
  }

  return {
    check,
    recordFailure,
    recordSuccess,
    recordVerifiedButDenied,
    snapshot: (): TrackerSnapshot => ({
      trackedIdentities: counters.size,
      accountFailures,
      ceilingReached: hasReachedBruteForceCeiling(accountFailures, deps.policy),
    }),
    dispose: (): void => {
      if (disposed) return
      disposed = true
      if (sweepHandle !== undefined && deps.sweep !== undefined) {
        deps.sweep.scheduler.clearInterval(sweepHandle)
        sweepHandle = undefined
      }
      counters.clear()
    },
  }
}

export interface ThrottledAttemptOutcome {
  readonly granted: boolean
  /** Quanto se esperou ANTES de comparar. Interno. Nunca vai para o fio. */
  readonly delayMs: number
  readonly deniedByBan: boolean
  readonly accountFailures: number
  readonly ceilingReached: boolean
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
export async function runThrottledAttempt(
  tracker: FailureTracker,
  identity: Identity,
  verify: () => boolean,
  wait: (ms: number) => Promise<void>,
): Promise<ThrottledAttemptOutcome> {
  const decision = tracker.check(identity)
  await wait(decision.retryAfterMs)
  const verified = verify()

  if (verified) {
    if (decision.allowed) tracker.recordSuccess(identity)
    else tracker.recordVerifiedButDenied(identity)

    const after = tracker.snapshot()
    return {
      granted: decision.allowed,
      delayMs: decision.retryAfterMs,
      deniedByBan: !decision.allowed,
      accountFailures: after.accountFailures,
      ceilingReached: after.ceilingReached,
    }
  }

  const record = tracker.recordFailure(identity)
  return {
    granted: false,
    delayMs: decision.retryAfterMs,
    deniedByBan: !decision.allowed,
    accountFailures: record.accountFailures,
    ceilingReached: record.ceilingReached,
  }
}
