/**
 * Modo restrito: ativa aos 100, PERSISTE via `StateStore`, sobrevive a reinicio.
 *
 * DONO: T2.3.
 *
 * ---------------------------------------------------------------------------
 * FRONTEIRA DESTA ONDA — este ficheiro DECIDE e PERSISTE; nao executa
 * ---------------------------------------------------------------------------
 * A Onda 2 e "primitivas sem fiacao" por construcao. Quem derruba o `cloudflared`
 * e quem passa a recusar credencial vinda do tunel e o consumidor do intent
 * ({@link RestrictExposureIntent}): T3.3 no gate, T3.1/T5.1 no ciclo de vida do
 * tunel. O efeito ponta a ponta (`pgrep -f cloudflared` vazio) e item de aceite
 * da ONDA 3, nao desta — aqui o tunel ainda nem existe no repositorio.
 *
 * ---------------------------------------------------------------------------
 * PORQUE MODO RESTRITO E NAO LOCKOUT
 * ---------------------------------------------------------------------------
 * NIST SP 800-63B-4 3.2.2 manda limitar as falhas consecutivas por conta a "no
 * more than 100 by disabling that authenticator", e exige rebind para o voltar a
 * usar. Com UM UNICO dono, desativar o unico autenticador e auto-DoS
 * irreversivel: tranca o dono para fora da propria maquina sem caminho remoto de
 * volta — e a propria norma admite o custo ao falar em "the potential need for
 * account recovery when the limit is exceeded". O que se desativa aqui e a
 * EXPOSICAO, nao o dono:
 *
 *   - o tunel cai e o gate deixa de aceitar credencial vinda dele;
 *   - o modo fica no `state.json`, logo reiniciar o DSH NAO e o bypass;
 *   - a recuperacao e ir a maquina — o "rebind" do NIST, na versao de uma conta.
 *
 * ---------------------------------------------------------------------------
 * A SAIDA E LOCAL, E ISSO E UMA FRONTEIRA DE ARQUITETURA (declarada, nao fingida)
 * ---------------------------------------------------------------------------
 * `04-TESTES.md` RL-015: nenhum caminho remoto desativa o modo — nem painel
 * autenticado pelo tunel, nem comando do bot. Dentro de UM processo nao existe
 * forma honesta de um modulo provar em runtime que quem o chamou era o terminal
 * local e nao um handler HTTP: seria teatro. A fronteira e portanto de
 * arquitetura e VERIFICAVEL POR GREP — o unico chamador permitido de
 * `releaseFromLocalMachine` e `bin/dsh-guard-setup.ts` (T4.1), que e outro
 * processo, arrancado na maquina:
 *
 *     grep -rn 'releaseFromLocalMachine' src/panel src/telegram src/http worker
 *
 * tem de devolver VAZIO. Isto esta escrito aqui para que a revisao da Onda 4/5
 * o possa transformar num gate, e nao para dar a impressao de um controlo que o
 * runtime nao tem.
 *
 * ---------------------------------------------------------------------------
 * FAIL LOUD (Q-3): nao ha `try`/`catch` a volta de `state.read()`
 * ---------------------------------------------------------------------------
 * Se o `state.json` estiver corrompido ou com modo mais frouxo que 0600, o
 * `StateStore` de T2.5 LANCA, e o lance sobe daqui inalterado. Engolir esse erro
 * e assumir "nao restrito" seria transformar um ficheiro corrompido no bypass do
 * controlo — exatamente o que `04-TESTES.md` RL-016 proibe.
 */

import type { PersistedState, StateStore } from '../contracts/state.ts'
import { PLUGIN_NAME } from '../errors.ts'
import { hasReachedBruteForceCeiling, type RateLimitPolicy } from './policy.ts'

/**
 * Unica razao possivel. O contrato congelado (`contracts/state.ts`) fixa o
 * literal `'brute-force-ceiling'`; e um tipo, nao um `enum` — o `node --test`
 * corre `.ts` em strip-only mode e `enum` emite codigo.
 */
export type RestrictedReason = 'brute-force-ceiling'

export const RESTRICTED_REASON: RestrictedReason = 'brute-force-ceiling'

export interface RestrictedStatus {
  readonly active: boolean
  readonly since: number | undefined
  readonly reason: RestrictedReason | undefined
}

/**
 * O que a Onda 3 consome. Nao e uma accao: e a DECISAO ja tomada e ja persistida.
 * Quem o recebe derruba a exposicao e avisa o dono.
 */
export interface RestrictExposureIntent {
  readonly kind: 'restrict-exposure'
  readonly reason: RestrictedReason
  readonly since: number
  readonly accountFailures: number
}

export interface RestrictedMode {
  isActive(): boolean
  status(): RestrictedStatus
  /**
   * Chamado a cada falha, com o contador CONSECUTIVO DA CONTA
   * (`FailureRecord.accountFailures`, de `tracker.ts`). Devolve o intent apenas
   * na TRANSICAO — ativacoes repetidas nao reescrevem o `since`, para que o
   * atacante nao consiga empurrar o instante de inicio para a frente.
   */
  activateIfCeilingReached(accountFailures: number): RestrictExposureIntent | undefined
  /** Ver "A SAIDA E LOCAL" no cabecalho. Devolve `true` se havia o que limpar. */
  releaseFromLocalMachine(): boolean
  /** Relê do `StateStore`. O ficheiro e a fonte da verdade; a cache e conveniencia. */
  reload(): void
}

export interface RestrictedModeDeps {
  readonly state: StateStore
  readonly now: () => number
  readonly policy: RateLimitPolicy
}

function readRestricted(state: PersistedState): { since: number; reason: RestrictedReason } | undefined {
  const restricted = state.restricted
  if (restricted === undefined) return undefined
  if (!Number.isFinite(restricted.since)) {
    throw new Error(
      `[${PLUGIN_NAME}] RESTRICTED_STATE_INVALID: state.restricted.since nao e um instante valido ` +
        `(${String(restricted.since)}). Corrigir o state.json na maquina — assumir "nao restrito" seria o bypass.`,
    )
  }
  return { since: restricted.since, reason: restricted.reason }
}

/**
 * Constroi o modo restrito ja HIDRATADO do disco.
 *
 * E aqui que "persiste entre reinicios" acontece, e nao por magia: uma instancia
 * nova, sobre um `StateStore` novo, sobre o mesmo `state.json`, arranca ATIVA se
 * o ficheiro disser que esta ativa. Nao ha estado so-em-memoria a proteger.
 */
export function createRestrictedMode(deps: RestrictedModeDeps): RestrictedMode {
  let current = readRestricted(deps.state.read())

  const status = (): RestrictedStatus =>
    current === undefined
      ? { active: false, since: undefined, reason: undefined }
      : { active: true, since: current.since, reason: current.reason }

  return {
    isActive: (): boolean => current !== undefined,
    status,

    activateIfCeilingReached: (accountFailures: number): RestrictExposureIntent | undefined => {
      if (!hasReachedBruteForceCeiling(accountFailures, deps.policy)) return undefined
      if (current !== undefined) return undefined

      const since = deps.now()
      deps.state.update((previous) => ({
        ...previous,
        restricted: { since, reason: RESTRICTED_REASON },
      }))
      current = { since, reason: RESTRICTED_REASON }

      return { kind: 'restrict-exposure', reason: RESTRICTED_REASON, since, accountFailures }
    },

    releaseFromLocalMachine: (): boolean => {
      if (current === undefined) return false
      deps.state.update((previous) => ({ ...previous, restricted: undefined }))
      current = undefined
      return true
    },

    reload: (): void => {
      current = readRestricted(deps.state.read())
    },
  }
}
