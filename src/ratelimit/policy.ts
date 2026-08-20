/**
 * Politica de limite: falhas -> atraso, limiar de ban, escopo banivel e teto
 * NIST. Tudo PURO — sem I/O, sem relogio, sem estado: o que esta politica sabe
 * entra por argumento.
 *
 * DONO: T2.3.
 *
 * ---------------------------------------------------------------------------
 * A REGRA QUE DEFINE ESTE MODULO: o atraso e INTERNO e nunca vira resposta.
 * ---------------------------------------------------------------------------
 * O valor devolvido aqui e o tempo que o gate espera ANTES de comparar a
 * credencial. Ele NAO pode aparecer no fio: nem como `429`, nem como
 * `Retry-After`, nem como qualquer variacao de corpo ou de cabecalho. Um `429`
 * com `Retry-After` diz ao atacante duas coisas que ele nao tem como medir de
 * outra forma — que foi detetado, e qual e a janela — e e literalmente o oraculo
 * que `02-SEGURANCA.md` 6.1 proibe e que `09-DECISOES-CANONICAS.md` D9 resolve
 * a favor do 401 unico. Toda falha de autenticacao responde `401` com o MESMO
 * corpo e os MESMOS cabecalhos, seja ela "sem sessao", "sessao expirada",
 * "segredo errado" ou "identidade banida".
 *
 * ---------------------------------------------------------------------------
 * ORDEM, e porque ela e uma propriedade de seguranca
 * ---------------------------------------------------------------------------
 * O atraso e funcao APENAS do numero de falhas ANTERIORES. `computeAuthDelayMs`
 * nao recebe — e nao pode receber — a credencial apresentada nem o resultado da
 * comparacao. Isso e o que garante que esperar nao vaza nada: se o atraso fosse
 * calculado DEPOIS da comparacao, ou dependesse do seu resultado, o proprio
 * limitador viraria o oraculo de timing que ele existe para fechar (CWE-208).
 * A sequencia obrigatoria vive em `runThrottledAttempt` (`tracker.ts`).
 *
 * ---------------------------------------------------------------------------
 * FONTE NORMATIVA — NIST SP 800-63B-4 3.2.2 "Rate Limiting (Throttling)",
 * citada LITERALMENTE de <https://pages.nist.gov/800-63-4/sp800-63b.html>
 * (SP 800-63B-4, final de 2025-07-31), nao de memoria:
 * ---------------------------------------------------------------------------
 *   "Unless otherwise specified in the description of a given authenticator,
 *    the verifier SHALL limit consecutive failed authentication attempts using
 *    a specific authenticator on a single subscriber account to no more than
 *    100 by disabling that authenticator."
 *
 *   "The limit of 100 attempts is an upper bound, and agencies MAY impose lower
 *    limits. The limit of 100 was chosen to balance the likelihood of a correct
 *    guess [...] versus the potential need for account recovery when the limit
 *    is exceeded."
 *
 *   "Requiring the claimant to wait after a failed attempt for a period of time
 *    that increases as the subscriber account approaches its maximum allowance
 *    for consecutive failed attempts (e.g., 30 seconds up to an hour)"
 *
 *   "When the subscriber successfully authenticates, the verifier SHOULD
 *    disregard any previous failed attempts for the authenticators used in the
 *    successful authentication."
 *
 * COMO O TEXTO E CUMPRIDO AQUI, sem fingir. A norma diz "disabling that
 * authenticator" e exige rebind (3.2.2 -> 4.1) para voltar a ser usavel. Com um
 * unico dono, desativar o unico autenticador seria auto-DoS irreversivel — o que
 * a propria norma reconhece ao falar em "potential need for account recovery".
 * O que este plugin desativa aos 100 e a EXPOSICAO (o tunel cai e o modo restrito
 * persiste), nao o dono; e o "rebind" e ir a maquina. Ver `restricted.ts`.
 *
 * ---------------------------------------------------------------------------
 * DIVERGENCIA DECLARADA (nao e descuido)
 * ---------------------------------------------------------------------------
 * `02-SEGURANCA.md` 6.1 fixa o teto do atraso em 30 s; `04-TESTES.md` RL-004 diz
 * entre parenteses "default 60 s". Adotamos 30 s, e a razao e de MERITO, nao de
 * precedencia: D9 arbitra a favor de `02-SEGURANCA.md` em DOIS pontos nomeados
 * (o 401 unico e o modo restrito) e nao diz uma palavra sobre este teto, logo
 * invoca-lo aqui seria sobre-ler o documento.
 *
 * O merito e este: com o balde colapsado do modo tunel (ver `tracker.ts`), o
 * atraso e sofrido por QUEM QUER QUE tente a seguir — incluindo o dono. Duplicar
 * o teto duplica o tempo que um atacante consegue impor ao dono a custo zero
 * para si, e nao muda a ordem de grandeza do custo do atacante: 30 s ja tornam
 * a forca bruta remota inviavel (2 tentativas/minuto), e o controlo que
 * realmente fecha a adivinhacao e o teto NIST, nao mais 30 s de espera. O campo
 * e configuravel e RL-004 ("nunca acima do TETO CONFIGURADO") e verificado nos
 * DOIS valores.
 */

import { createHash } from 'node:crypto'

import type { Identity } from '../contracts/auth.ts'
import { PLUGIN_NAME } from '../errors.ts'

/**
 * Os tres parametros de lockout da OWASP (threshold, observation window,
 * duration) mais os dois numeros normativos: o inicio do backoff e o teto NIST.
 *
 * Nenhum campo e opcional DE PROPOSITO. `05-QUALIDADE-CODIGO.md` 1.2: em campo
 * que participa de rate limit, `??` com valor de reserva e rejeicao automatica —
 * a ausencia tem de ser um erro de configuracao, nunca um default silencioso.
 */
export interface RateLimitPolicy {
  /** Falhas que NAO sofrem atraso. 4 => o atraso comeca na 5a falha. */
  readonly freeFailures: number
  /** Base do atraso na 1a falha ja atrasada (a 5a). fail2ban/OWASP: ~1 s. */
  readonly initialDelayMs: number
  /** Teto do atraso interno. Ver "DIVERGENCIA DECLARADA" acima. */
  readonly maxDelayMs: number
  /** Falhas na janela que passam a recusar qualquer credencial (fail2ban: 5; aqui 15). */
  readonly banAfterFailures: number
  /** Duracao da recusa. `02-SEGURANCA.md` 6.1: 60 min (fail2ban usa 10 min). */
  readonly banDurationMs: number
  /** Janela de observacao da identidade (fail2ban `findtime`): 10 min. */
  readonly observationWindowMs: number
  /** Teto de falhas CONSECUTIVAS na conta. NIST SP 800-63B-4 3.2.2: 100. */
  readonly bruteForceCeiling: number
}

/**
 * Teto normativo, isolado como constante para que o numero apareca UMA vez.
 * "no more than 100" — NIST SP 800-63B-4 3.2.2. E um limite superior: baixar e
 * permitido pela norma, subir nao.
 */
export const NIST_BRUTE_FORCE_CEILING = 100

/** A politica adotada. Cada numero tem fonte no JSDoc de {@link RateLimitPolicy}. */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  freeFailures: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  banAfterFailures: 15,
  banDurationMs: 60 * 60 * 1_000,
  observationWindowMs: 10 * 60 * 1_000,
  bruteForceCeiling: NIST_BRUTE_FORCE_CEILING,
}

/** Erro de politica de limite. Mensagem ja prefixada com o nome do plugin. */
export class RateLimitPolicyError extends Error {
  override readonly name = 'RateLimitPolicyError'
  constructor(detail: string) {
    super(`[${PLUGIN_NAME}] RATE_LIMIT_POLICY_INVALID: ${detail}`)
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RateLimitPolicyError(`${field} tem de ser inteiro positivo (recebido: ${String(value)})`)
  }
}

/**
 * Valida uma politica. FAIL LOUD (Q-3): uma politica incoerente nao pode ficar
 * a espera do primeiro atacante para se revelar.
 */
export function assertRateLimitPolicy(policy: RateLimitPolicy): void {
  if (!Number.isInteger(policy.freeFailures) || policy.freeFailures < 0) {
    throw new RateLimitPolicyError(`freeFailures tem de ser inteiro >= 0 (recebido: ${String(policy.freeFailures)})`)
  }
  assertPositiveInteger(policy.initialDelayMs, 'initialDelayMs')
  assertPositiveInteger(policy.maxDelayMs, 'maxDelayMs')
  assertPositiveInteger(policy.banAfterFailures, 'banAfterFailures')
  assertPositiveInteger(policy.banDurationMs, 'banDurationMs')
  assertPositiveInteger(policy.observationWindowMs, 'observationWindowMs')
  assertPositiveInteger(policy.bruteForceCeiling, 'bruteForceCeiling')

  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new RateLimitPolicyError('maxDelayMs nao pode ser menor que initialDelayMs')
  }
  if (policy.banAfterFailures <= policy.freeFailures) {
    throw new RateLimitPolicyError('banAfterFailures tem de ser maior que freeFailures: banir antes de atrasar inverte a escada')
  }
  if (policy.bruteForceCeiling <= policy.banAfterFailures) {
    throw new RateLimitPolicyError('bruteForceCeiling tem de ser maior que banAfterFailures')
  }
  if (policy.bruteForceCeiling > NIST_BRUTE_FORCE_CEILING) {
    throw new RateLimitPolicyError(
      `bruteForceCeiling ${String(policy.bruteForceCeiling)} excede o teto normativo de ${String(NIST_BRUTE_FORCE_CEILING)} ` +
        '(NIST SP 800-63B-4 3.2.2: "no more than 100" e um LIMITE SUPERIOR — baixar e permitido, subir nao)',
    )
  }
}

// Q-3, fail loud AT LOAD: se a politica adotada deixar de ser coerente, o modulo
// recusa-se a carregar. Um limitador incoerente que arranca em silencio e pior
// do que nenhum, porque da a sensacao de que existe controlo.
assertRateLimitPolicy(DEFAULT_RATE_LIMIT_POLICY)

/** Prende `random()` a [0, 1] — um gerador injetado nao e de confianca cega. */
function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/**
 * Atraso INTERNO antes de avaliar a proxima tentativa, em milissegundos.
 *
 * FULL JITTER, na forma canonica `random(0, min(cap, base * 2^n))` — a mesma de
 * `02-SEGURANCA.md` 6.1. Escolhido em vez de "equal jitter" porque o objetivo
 * aqui NAO e proteger um servico a jusante de thundering herd (esse e o caso de
 * `src/proc/backoff.ts`, que soma jitter POR CIMA da base para nunca descer
 * abaixo do minimo documentado): e desperdicar o tempo de quem adivinha. Full
 * jitter maximiza a dispersao e, com `random() === 1`, degenera na progressao
 * nominal exata (1 s, 2 s, 4 s, 8 s, ...), o que torna a funcao verificavel de
 * forma determinista com o gerador injetado.
 *
 * CONTRATO, verdadeiro para QUALQUER `random()`:
 *
 *   0 <= atraso <= min(initialDelayMs * 2^(falhas - freeFailures - 1), maxDelayMs)
 *
 * e `atraso === 0` para `falhas <= freeFailures`.
 *
 * NAO RECEBE a credencial, nem o resultado da comparacao, nem a razao da falha.
 * Isso e estrutural, nao estilistico: e o que impede o atraso de codificar
 * qualquer bit sobre o segredo. Ver "ORDEM" no cabecalho do ficheiro.
 */
export function computeAuthDelayMs(
  consecutiveFailures: number,
  policy: RateLimitPolicy,
  random: () => number,
): number {
  if (!Number.isFinite(consecutiveFailures)) return 0

  const failures = Math.floor(consecutiveFailures)
  if (failures <= policy.freeFailures) return 0

  const step = failures - policy.freeFailures - 1
  const cap = Math.min(policy.initialDelayMs * 2 ** step, policy.maxDelayMs)

  return Math.round(clampUnitInterval(random()) * cap)
}

/**
 * De onde saiu a chave do balde contra o qual se conta. Vive AQUI, e nao no
 * `tracker.ts`, porque "que escopos podem ser banidos" e decisao de POLITICA —
 * e e a decisao que separa um limitador de um auto-DoS.
 */
export type IdentityScope = 'ip' | 'session' | 'global'

/**
 * O ban duro de 60 min pode ser aplicado a um balde deste escopo?
 *
 * ---------------------------------------------------------------------------
 * ESTA FUNCAO EXISTE POR CAUSA DE UM AUTO-DoS REMOTO REAL, encontrado em revisao
 * ---------------------------------------------------------------------------
 * `02-SEGURANCA.md` 6.1 escopa o ban de 15 falhas explicitamente **"para aquele
 * IP"**. Mas o spike S2 provou que, sob tunel e com `trustEdgeHeaders: false`,
 * NAO HA IP: `Identity.ip` vem `undefined`, e numa tentativa de login ainda nao
 * ha sessao — logo o balde e GLOBAL, um so para toda a gente. Aplicar a esse
 * balde um ban que recusa QUALQUER credencial durante 60 minutos significa,
 * literalmente:
 *
 *   15 pedidos anonimos -> o DONO, com a senha CERTA, e recusado por uma hora.
 *
 * E era pior: como o sucesso era impossivel durante o ban, a insistencia do dono
 * com a credencial correta era contada como falha de conta e empurrava o
 * contador ate ao teto NIST, forcando modo restrito. Ou seja: um atacante
 * remoto nao autenticado derrubava a exposicao com ~100 pedidos e trancava o
 * dono no intervalo — exatamente o que `02-SEGURANCA.md` 6.1 nomeia como o que
 * ha a evitar ("com um unico usuario, lockout de conta e auto-DoS total").
 *
 * REGRA ADOTADA: o ban duro so se aplica a baldes IDENTIFICADOS (`ip`,
 * `session`). Sobre o balde `global` ficam apenas (a) o atraso exponencial, que
 * abranda a forca bruta sem trancar ninguem, e (b) o teto NIST — que e
 * exatamente o que `04-TESTES.md` ORIG-015 prescreve para o caso colapsado:
 * "o teto NIST (RL-008) passa a ser o controle principal". ORIG-015 autoriza o
 * colapso de identidade; NAO autoriza o ban de 60 min sobre ele.
 *
 * CONSEQUENCIA PARA RL-011 ("credencial correta durante o ban e negada"), que
 * fica DECLARADA e nao escondida: RL-011 continua a valer no caminho POR IP,
 * onde o ban castiga uma origem identificada e o dono tem outra origem por onde
 * entrar. Sobre o balde colapsado RL-011 nao se aplica — nao por conveniencia,
 * mas porque ali "banir toda a gente" inclui o dono e nao existe outra porta.
 *
 * RESIDUAL, declarado e NAO resolvido aqui: um atacante remoto continua a poder
 * gastar 100 tentativas erradas e acender o modo restrito, o que derruba o tunel.
 * Isso e o controlo ESPECIFICADO (D9 + NIST SHALL), com recuperacao local
 * assumida pelo plano — nao e o defeito que esta funcao corrige. O defeito era o
 * dono ficar trancado COM O TUNEL AINDA DE PE, e as credenciais CERTAS dele
 * contarem para o teto.
 */
export function banAppliesToScope(scope: IdentityScope): boolean {
  return scope !== 'global'
}

export interface IdentityBucket {
  readonly scope: IdentityScope
  readonly key: string
}

/** Chave do balde global. Nome literal para aparecer em qualquer despejo. */
export const GLOBAL_BUCKET_KEY = 'global'

function shortDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Resolve a identidade num balde. PRECEDENCIA: IP (so quando existe um de
 * confianca) -> sessao -> global. Nao ha ramo que fabrique identidade.
 *
 * PERIGO REGISTADO, para o dia em que T3.3 preencher `Identity.ip`: com o IP a
 * frente da sessao, a MESMA sessao vista de dois IPs cai em dois baldes. Se o
 * cabecalho de borda for confiado sem que a borda o SOBRESCREVA (S2 mediu que
 * ela apenas ACRESCENTA ao `X-Forwarded-For`), um IP forjado (a) faz escapar
 * uma sessao ja banida e (b) permite envenenar o balde do dono enviando o IP
 * dele. So e seguro enquanto `trustEdgeHeaders` exigir prova de sobrescrita.
 */
export function resolveIdentityBucket(identity: Identity): IdentityBucket {
  if (typeof identity.ip === 'string' && identity.ip.length > 0) {
    return { scope: 'ip', key: `ip:${shortDigest(identity.ip)}` }
  }
  if (typeof identity.sessionId === 'string' && identity.sessionId.length > 0) {
    return { scope: 'session', key: `sess:${shortDigest(identity.sessionId)}` }
  }
  return { scope: 'global', key: GLOBAL_BUCKET_KEY }
}

/**
 * A contagem ja atingiu o limiar de ban? Predicado PURO do numero — quem decide
 * se o ban pode sequer ser aplicado aquele balde e {@link banAppliesToScope}.
 *
 * PORQUE O BAN NAO E "RECUSA IMEDIATA", como a tabela de `02-SEGURANCA.md` 6.1
 * literalmente diz: responder de imediato durante o ban seria MAIS RAPIDO do que
 * o caminho de senha errada ja atrasado pela escada, e essa diferenca de tempo e
 * exatamente o oraculo que a mesma seccao proibe duas linhas acima ("custo
 * constante: mesmo com IP banido, a resposta gasta o mesmo caminho de codigo").
 * Portanto o ban NAO altera o tempo: altera so o veredito. O atraso continua a
 * ser o da escada, e a resposta continua a ser o mesmo 401.
 */
export function isBanTriggeredBy(consecutiveFailures: number, policy: RateLimitPolicy): boolean {
  return Math.floor(consecutiveFailures) >= policy.banAfterFailures
}

/**
 * Teto NIST atingido? Conta falhas CONSECUTIVAS DA CONTA — nao da identidade de
 * rede. E a leitura literal de "on a single subscriber account", e e o que impede
 * que rodar identidade a cada pedido (o que S2 provou ser trivial: ver
 * `tracker.ts`) zere o controlo. Zera com autenticacao bem-sucedida, por
 * "the verifier SHOULD disregard any previous failed attempts".
 *
 * O QUE ESTE CONTADOR NAO E: "recusas consecutivas". A norma diz "failed
 * authentication ATTEMPTS", e uma credencial que se verifica CORRETA nao e uma
 * tentativa falhada, mesmo que o pedido acabe recusado por outra razao (um ban
 * de identidade, por exemplo). Contar a recusa em vez da falha punia o dono
 * pelas tentativas do atacante — ver `runThrottledAttempt` em `tracker.ts`.
 */
export function hasReachedBruteForceCeiling(
  consecutiveAccountFailures: number,
  policy: RateLimitPolicy,
): boolean {
  return Math.floor(consecutiveAccountFailures) >= policy.bruteForceCeiling
}
