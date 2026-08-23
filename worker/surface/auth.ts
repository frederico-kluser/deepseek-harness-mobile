/**
 * AUTORIZACAO NEUTRA DA SUPERFICIE — allowlist de dois eixos, receptor de
 * pareamento e guard, TUDO sobre `SurfaceIdentity{userKey,chatKey}` (STRINGS,
 * D4) e `SurfaceEvent`, em vez da forma crua do update do Telegram.
 *
 * DONO: onda 2 "desacoplar o bot de mensageria para arquitetura de provedores".
 * PORTE FIEL de `worker/auth/{allowlist,guard,pairing}.ts` ($BASE) sobre o
 * CONTRATO em `./contract.ts`. NADA antigo e tocado: estas funcoes sao novas e
 * coexistam com o funil Telegram ate a Onda 4 (rewire) as cortar.
 *
 * ===========================================================================
 * O QUE MUDOU vs. o funil Telegram, E O QUE NAO PODE MUDAR
 * ===========================================================================
 * - **A identidade chega JA normalizada.** O `worker/auth/allowlist.ts`
 *   desembrulhava o JSON cru do Telegram (`from.id`, `chat.id`) e validava
 *   52 bits. Aqui a fronteira (D4) ja entregou uma {@link SurfaceIdentity} com
 *   `userKey`/`chatKey` como STRINGS (o adaptador de provedor resolveu-as, Onda
 *   3). Por isso nao ha `detectSurface`, `extractIdentity` nem `isTelegramId`
 *   neste ficheiro — funcionariam sobre a forma errada (um JSON por provedor).
 * - **As regras de SEGURANCA portam-se INTEGRAS** (TG-0xx, PAIR-0xx): os DOIS
 *   eixos sempre (TG-001..006/008), default DENY inclusive o dono (TG-007),
 *   ausencia de eixo = NEGACAO (TG-004), revalidacao de identidade em TODO
 *   evento de acao (TG-024), descarte silencioso CONTADO (TG-089) com
 *   `answerTarget` obrigatorio (TG-027), nenhum nonce validado localmente (S5),
 *   sequidor de pareamento = segunda porta ao estranho (PAIR-001..010).
 * - **A auditoria vira eventos neutros em PT-BR.** `telegram.update.admitido`
 *   e o marcador do canal antigo; aqui o equivalente e
 *   `surface.evento.admitido` (e o descartado `/surface.evento.descartado`, o
 *   pareamento `/surface.pareamento.*`). A Onda 4 reescreve o prefixo do antigo
 *   para bater com estes.
 *
 * ===========================================================================
 * S5 — NENHUM NONCE AQUI DENTRO
 * ===========================================================================
 * {@link SurfaceActionEvent} ja chega com `action` e `token` extraidos PELO
 * ADAPTADOR. Este modulo NAO deserializa `callback_data` nenhum (isso e do
 * provedor, Onda 3) e NAO valida o valor do token: transporta-o OPACO ate ao
 * contexto do comando / host (S5 de `src/contracts/ipc.ts`). Um token validado
 * no processo que fala com a internet nao e um controlo, e uma variavel.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import type { SurfaceAction } from './contract.ts'
import type { SurfaceCommandEvent, SurfaceIdentity } from './contract.ts'
import type { SurfaceEvent } from './contract.ts'

/* ========================================================================== */
/* 1. ERRO TIPADO (mesma fronteira de $BASE): o worker so importa de `src/`    */
/*    tipos de `src/contracts/`. O erro repete o padrao estavel do canal.      */
/* ========================================================================== */

export type SurfaceAuthErrorCode =
  /** Uma chave de allowlist vazia/sem conteudo: erro de configuracao. */
  | 'ALLOWLIST_INVALID_KEY'
  /** Codigo de pareamento fora da forma 6 digitos acordada com o host. */
  | 'PAIRING_CHALLENGE_INVALID'
  /** Tetos de tentativa incoerentes: seria limite decorativo. */
  | 'PAIRING_LIMITS_INVALID'

export class SurfaceAuthError extends Error {
  override readonly name = 'SurfaceAuthError'
  readonly code: SurfaceAuthErrorCode

  constructor(code: SurfaceAuthErrorCode, detail: string) {
    super(`[worker/surface/auth] ${code}: ${detail}`)
    this.code = code
  }
}

/* ========================================================================== */
/* 2. ALLOWLIST DE DOIS EIXOS, DEFAULT DENY (TG-007)                           */
/* ========================================================================== */

/**
 * Allowlist de STRINGS, com os DOIS eixos separados.
 *
 * No Telegram o `from` e o `chat` viviam no MESMO `Set<number>` numerico; na
 * fronteira neutra os dois eixos sao conjuntos de chaves {user, chat} — o
 * mesmo numero de 52 bits do Telegram resolvido para `string`, ou qualquer
 * id de outro provedor. Separar os dois conjuntos e o que permite que um grupo
 * autorizado (`chatKey`) seja independente de quem nele carrega num botao
 * (`userKey`) — a mesma armadilha de TG-003 que `worker/auth/allowlist.ts`
 * fechava com `&&`.
 *
 * NAO expoe as chaves: responde `has*`, nunca itera. `size` e a soma dos dois.
 */
export interface SurfaceAllowlist {
  /** Quantas chaves distintas ao todo (user + chat). `0` = NEGA TUDO. */
  readonly size: number
  hasUser(key: string): boolean
  hasChat(key: string): boolean
}

/** Forma minima para construir — dois conjuntos de chaves ja validos. */
export interface SurfaceAllowlistInput {
  readonly users: readonly string[]
  readonly chats: readonly string[]
}

/**
 * Constroi a allowlist de dois eixos a partir de STRINGS, e copia-as.
 *
 * FALHA ALTO em chave vazia ou so espaco (`ALLOWLIST_INVALID_KEY`): uma chave
 * que "nunca casa" seria uma allowlist silenciosamente mais estreita — o modo
 * de falha indistinguivel de um bug. Copia para `Set` proprio: mutar a origem
 * depois nao alarga a allowlist.
 */
export function criarAllowlistSurface(input: SurfaceAllowlistInput): SurfaceAllowlist {
  const users = new Set<string>()
  const chats = new Set<string>()

  function acumula(alvo: Set<string>, chaves: readonly string[]): void {
    for (const chave of chaves) {
      const limpa = chave.trim()
      if (limpa.length === 0) {
        throw new SurfaceAuthError(
          'ALLOWLIST_INVALID_KEY',
          `chave de allowlist vazia ou so espaco em ${alvo === users ? 'users' : 'chats'}; deixar entrar uma chave morta e enganar o operador`,
        )
      }
      alvo.add(limpa)
    }
  }

  acumula(users, input.users)
  acumula(chats, input.chats)

  return {
    size: users.size + chats.size,
    hasUser: (key: string): boolean => users.has(key),
    hasChat: (key: string): boolean => chats.has(key),
  }
}

/** A allowlist do arranque: VAZIA, e portanto inerte (TG-007). */
export const ALLOWLIST_VAZIA: SurfaceAllowlist = criarAllowlistSurface({ users: [], chats: [] })

/**
 * A UNICA funcao de decisao de autorizacao da superficie neutra.
 *
 * PORQUE UMA FUNCAO E NAO UM METODO DA ALLOWLIST: a decisao fica pura e pode
 * ser injetada. Default DENY (TG-007): lista vazia nega ATE O DONO. E
 * `&&`, nunca `||` (TG-003): os DOIS eixos tem de estar em lista.
 */
export function autorizar(identity: SurfaceIdentity, allowlist: SurfaceAllowlist): boolean {
  return allowlist.hasUser(identity.userKey) && allowlist.hasChat(identity.chatKey)
}

/**
 * Veredito de autorizacao, uniao discriminada — nao um booleano. O MOTIVO e
 * metade do controlo (o audit distingue "nao pareou" de "estranho bateu").
 */
export type SurfaceAuthorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SurfaceDenyReason }

/** Vocabulario FECHADO de recusas. Nunca sai para o chat (nao dai oraculo). */
export type SurfaceDenyReason =
  /** Allowlist vazia: o pareamento ainda nao aconteceu. Nega ATE O DONO. */
  | 'deny:not-configured'
  /** Um dos dois eixos ficou fora da lista (TG-002/003/005/006/008). */
  | 'deny:not-allowlisted'
  /** Identidade incompleta (sem um eixo legitimo) — ausencia e NEGACAO. */
  | 'deny:incomplete-identity'

/**
 * A decisao de autorizacao com o motivo certo para o audit. A ORDEM importa:
 * allowlist vazia (nunca parou) -> eixos fora da lista (estranho).
 */
export function decidirAutorizacao(
  identity: SurfaceIdentity | undefined,
  allowlist: SurfaceAllowlist,
): SurfaceAuthorization {
  if (identity === undefined) {
    return { ok: false, reason: 'deny:incomplete-identity' }
  }
  if (allowlist.size === 0) {
    return { ok: false, reason: 'deny:not-configured' }
  }
  if (!autorizar(identity, allowlist)) {
    return { ok: false, reason: 'deny:not-allowlisted' }
  }
  return { ok: true }
}

/* ========================================================================== */
/* 3. O DESAFIO DE PAREAMENTO (PAIR-010: o codigo entra e NAO sai)            */
/* ========================================================================== */

/** Quantos digitos o codigo que o HOST gera tem. */
const PAIRING_CODE_DIGITS = 6

/**
 * Forma do codigo — por varrimento de `charCodeAt`, NUNCA por `RegExp`.
 *
 * `RegExp.prototype.test` e `String.prototype.search` publicam o sujeito nas
 * estaticas GLOBAIS `RegExp.input`/`RegExp.lastMatch`, que sobrevivem ao
 * retorno e ficam legiveis ao processo inteiro (PAIR-010, ACHADO 7).
 */
function eSeisDigitos(value: string): boolean {
  if (value.length !== PAIRING_CODE_DIGITS) return false
  for (let i = 0; i < PAIRING_CODE_DIGITS; i += 1) {
    const digito = value.charCodeAt(i)
    // 0x30..0x39 = '0'..'9'. Sem parseInt/Number.isNaN: aceitam lixo ('1e5').
    if (digito < 0x30 || digito > 0x39) return false
  }
  return true
}

/** O que o worker guarda do codigo: um VERIFICADOR e um prazo. Nunca o claro. */
export interface SurfacePairingChallenge {
  /** `true` sse o candidato e o codigo. Comparacao em tempo constante. */
  verify(candidate: string): boolean
  /** Epoch ms em que o codigo deixa de valer (TTL de 5 min decidido no host). */
  readonly expiresAt: number
}

/**
 * Constroi o desafio a partir do codigo em claro e descarta o claro.
 *
 * PORQUE COMPARAR DIGESTS NAO STRINGS: `timingSafeEqual` lanca `RangeError`
 * com buffers de comprimentos diferentes; reduzir os dois lados a `sha256` da
 * sempre 32 bytes e torna a comparacao total. FALHA ALTO se o codigo nao for 6
 * digitos, sem o citar na mensagem (PAIR-010 vale ate no erro).
 */
export function criarDesafioDePareamento(code: string, expiresAt: number): SurfacePairingChallenge {
  if (!eSeisDigitos(code)) {
    throw new SurfaceAuthError(
      'PAIRING_CHALLENGE_INVALID',
      `codigo de pareamento tem de ser 6 digitos decimais (recebido: ${code.length} caracteres)`,
    )
  }
  if (!Number.isFinite(expiresAt)) {
    throw new SurfaceAuthError('PAIRING_CHALLENGE_INVALID', 'expiresAt tem de ser um epoch em ms finito')
  }
  // O UNICO ponto onde o claro existe. Depois so o digest vive na closure.
  const digest = sha256(code)
  return {
    expiresAt,
    verify: (candidate: string): boolean => timingSafeEqual(sha256(candidate), digest),
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/* ========================================================================== */
/* 4. O RECEPTOR DE PAREAMENTO (PAIR-001..010)                                 */
/* ========================================================================== */

export interface SurfacePairingLimits {
  /** Tentativas por `chatKey` antes de o chat ser descartado. */
  readonly maxAttemptsPerChat: number
  /** Tentativas somadas de TODOS os chats. E este teto que fecha 10^6. */
  readonly maxAttemptsGlobal: number
  /** Quantos chats distintos o contador de SONDAS chega a registar. */
  readonly maxProbeChatsTracked: number
  /** Primeiro atraso. Dobra a cada falha do mesmo chat. */
  readonly baseDelayMs: number
  /** Tecto do atraso. Acima disto o legitimo desiste antes do atacante. */
  readonly maxDelayMs: number
}

/** Os numeros e a conta que os justifica (idêntico a $BASE). */
export const LIMITES_PAREAMENTO_PADRAO: SurfacePairingLimits = Object.freeze({
  maxAttemptsPerChat: 5,
  maxAttemptsGlobal: 20,
  maxProbeChatsTracked: 64,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
})

function validarLimites(limits: SurfacePairingLimits): void {
  const ok =
    limits.maxAttemptsPerChat > 0 &&
    limits.maxAttemptsGlobal > 0 &&
    limits.maxProbeChatsTracked > 0 &&
    limits.baseDelayMs >= 0 &&
    limits.maxDelayMs >= limits.baseDelayMs
  if (!ok) {
    throw new SurfaceAuthError(
      'PAIRING_LIMITS_INVALID',
      'tetos tem de ser positivos e maxDelayMs >= baseDelayMs; um teto <= 0 seria limite decorativo',
    )
  }
}

/** O dono, tal como gravado. **Os dois eixos**, lidos do evento que pareia. */
export interface PairedOwner {
  readonly userKey: string
  readonly chatKey: string
  readonly pairedAt: number
}

/** Nao existe transicao fechado -> aberto neste modulo (PAIR-008: reabrir e na maquina). */
export type SurfacePairingState =
  | { readonly status: 'aberto' }
  | { readonly status: 'fechado'; readonly owner: PairedOwner }

/** Vocabulario FECHADO de recusas. Codigos para o audit, nunca para o chat. */
export type SurfacePairingRefusal =
  | 'refuse:already-paired'
  | 'refuse:wrong-code'
  | 'refuse:expired'
  | 'refuse:rate-limited'
  | 'refuse:malformed'
  | 'refuse:missing-identity'

/** A que orcamento a tentativa foi debitada (palpite vs sonda vs nenhum). */
export type SurfacePairingBudget = 'palpite' | 'sonda' | 'nenhum'

/** Auditoria em PT-BR: o marcador neutro do pareamento. NUNCA tem campo p/ codigo. */
export interface SurfacePairingAuditIntent {
  readonly evento: 'surface.pareamento.concluido' | 'surface.pareamento.recusado' | 'surface.pareamento.boas-vindas'
  readonly resultado: 'permitido' | 'negado'
  readonly motivo: SurfacePairingRefusal | 'ok'
  readonly orcamento: SurfacePairingBudget
  /** Valor forense. NUNCA ha aqui um campo para o codigo nem o candidato. */
  readonly userKey?: string | undefined
  readonly chatKey?: string | undefined
}

/** O que fazer a seguir. `reply` `undefined` = SILENCIO TOTAL. */
export type SurfacePairingOutcome =
  | {
      readonly kind: 'paired'
      readonly owner: PairedOwner
      readonly reply: string
      readonly audit: SurfacePairingAuditIntent
    }
  | {
      readonly kind: 'welcome'
      readonly reply: string
      /** O `chatKey` de onde o /start veio (para responder). `undefined` sem identidade. */
      readonly chat?: string | undefined
      readonly audit: SurfacePairingAuditIntent
    }
  | {
      readonly kind: 'refused'
      readonly reason: SurfacePairingRefusal
      /** `undefined` = descarte silencioso. */
      readonly reply?: string | undefined
      /** O chamador espera este tempo ANTES de responder. Nunca dormimos aqui. */
      readonly delayMs: number
      /** O `chatKey` de onde partiu a tentativa (para responder). P/ o core. */
      readonly chat?: string | undefined
      readonly audit: SurfacePairingAuditIntent
    }
  | {
      /** Nao e `/parear` nem `/start`: nao e assunto deste modulo. */
      readonly kind: 'ignored'
    }

// -- Os textos. Constantes de modulo: e assim que PAIR-003 e PAIR-010 valem. --

/** A resposta UNICA a qualquer tentativa falhada durante a janela aberta. */
export const RESPOSTA_PAREAMENTO_RECUSADO =
  'Nao foi possivel parear. Confirme o codigo no terminal da maquina e tente de novo.'

/** A resposta ao DONO que manda `/parear` outra vez (so o dono a ve). */
export const RESPOSTA_JA_PAREADO =
  'Este bot ja esta pareado. Para trocar de dono, rode `--reset-pairing` na maquina onde o DSH esta instalado.'

/** Boas-vindas de `/start`, INOCUA e IGUAL para toda a gente (PAIR-006). */
export const RESPOSTA_BOAS_VINDAS =
  'Ola. Este bot e privado e responde apenas ao dono da maquina onde esta instalado.'

// -- Estado e contadores --

export interface SurfacePairingStats {
  /** PALPITES processados: tentativas que carregaram um candidato. */
  readonly attempts: number
  /** SONDAS: `/parear` seco. Contadas A PARTE de proposito. */
  readonly probes: number
  readonly refused: number
  /** Contagem por motivo. E o que o relatorio ao dono usa. */
  readonly byReason: Readonly<Record<string, number>>
}

export interface SurfacePairingReceiver {
  /** Processa um evento de comando. **SINCRONO** — isso e o contrato de PAIR-009. */
  receive(evento: SurfaceCommandEvent): SurfacePairingOutcome
  state(): SurfacePairingState
  stats(): SurfacePairingStats
  /** Troca o desafio quando o host gera outro codigo (TG-064). Nao zera palpites. */
  rotateChallenge(next: SurfacePairingChallenge): void
  /**
   * SEMEIA o dono PERSISTIDO em runtime (`pairing.owner`, re-montagem 8c),
   * quando `pairing.owner` chega DEPOIS do boot. O receptor passa a fechado com
   * este dono: `/parear` e recusado, nao ha nova parelha. NAO zera o orcamento
   * de palpites (alterar o dono nao devolve tentativas ao atacante).
   */
  semearDono(dono: PairedOwner): void
}

/** Relogio injetado. Nenhum teste espera 5 min reais. */
export interface SurfacePairingClock {
  now(): number
}

export interface SurfacePairingDeps {
  readonly challenge: SurfacePairingChallenge
  readonly clock: SurfacePairingClock
  readonly limits?: SurfacePairingLimits | undefined
  /** Dono ja persistido, quando o host arranca fechado. */
  readonly owner?: PairedOwner | undefined
}

/**
 * Constroi o receptor.
 *
 * PAIR-009 — A CORRIDA: dois `/parear` com o codigo certo no MESMO tick dao UM
 * dono porque {@link SurfacePairingReceiver.receive} **nao tem um unico
 * `await`**: entre ler o estado e gravar o dono nao ha ponto de suspensao,
 * logo o event loop nao intercala a segunda chamada.
 */
export function criarReceptorDePareamento(deps: SurfacePairingDeps): SurfacePairingReceiver {
  const limits = deps.limits ?? LIMITES_PAREAMENTO_PADRAO
  validarLimites(limits)

  let challenge = deps.challenge
  let state: SurfacePairingState =
    deps.owner === undefined ? { status: 'aberto' } : { status: 'fechado', owner: deps.owner }

  /** Orcamento de PALPITES: por chat e global. E o que a forca bruta gasta. */
  const tentativasPorChat = new Map<string, number>()
  let tentativasGlobal = 0
  let attempts = 0

  /** Contador de SONDAS, separado do de palpites (LIMITES_PAREAMENTO_PADRAO). */
  const sondasPorChat = new Map<string, number>()
  let probes = 0

  let refused = 0
  const byReason = new Map<string, number>()

  function recusar(
    reason: SurfacePairingRefusal,
    reply: string | undefined,
    delayMs: number,
    identity: SurfaceIdentity | undefined,
    orcamento: SurfacePairingBudget,
  ): SurfacePairingOutcome {
    refused += 1
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    return {
      kind: 'refused',
      reason,
      reply,
      delayMs,
      // O `chatKey` para o chamador responder (o core usa-o em `recusado.chat`).
      ...(identity === undefined ? {} : { chat: identity.chatKey }),
      audit: {
        evento: 'surface.pareamento.recusado',
        resultado: 'negado',
        motivo: reason,
        orcamento,
        ...(identity === undefined ? {} : { userKey: identity.userKey, chatKey: identity.chatKey }),
      },
    }
  }

  /** Atraso exponencial nas falhas ANTERIORES do chat. Expoente cortado p/ anti-Infinity. */
  function atrasoPara(falhasAnteriores: number): number {
    const bruto = limits.baseDelayMs * 2 ** Math.min(falhasAnteriores, 32)
    return Math.min(limits.maxDelayMs, bruto)
  }

  return {
    receive(evento: SurfaceCommandEvent): SurfacePairingOutcome {
      const command = parseComando(evento)
      if (command === undefined) return { kind: 'ignored' }
      const identity = command.identity

      // /start — boas-vindas, e NADA MAIS (D8, PAIR-006). O argumento e
      // ignorado de proposito: o payload de /start viaja numa URL partilhavel.
      if (command.nome === 'start') {
        return {
          kind: 'welcome',
          reply: RESPOSTA_BOAS_VINDAS,
          ...(identity === undefined ? {} : { chat: identity.chatKey }),
          audit: {
            evento: 'surface.pareamento.boas-vindas',
            resultado: 'negado',
            motivo: 'ok',
            orcamento: 'nenhum',
            ...(identity === undefined ? {} : { userKey: identity.userKey, chatKey: identity.chatKey }),
          },
        }
      }

      if (command.nome !== 'parear') return { kind: 'ignored' }

      // PAIR-005/009 — o SEGUNDO pareamento e recusado, antes de tudo.
      if (state.status === 'fechado') {
        const eDono =
          identity !== undefined &&
          identity.userKey === state.owner.userKey &&
          identity.chatKey === state.owner.chatKey
        // Ao dono, explicacao; a qualquer outro identidade, SILENCIO.
        return recusar(
          'refuse:already-paired',
          eDono ? RESPOSTA_JA_PAREADO : undefined,
          0,
          identity,
          'nenhum',
        )
      }

      // SINTAXE: exige um elemento completo para continuar.
      if (identity === undefined) {
        // Sem os dois eixos nao ha para onde responder. Recusa silenciosa.
        return recusar('refuse:missing-identity', undefined, limits.maxDelayMs, undefined, 'nenhum')
      }

      // ---- SONDA SEM PALPITE — `/parear` seco. SILENCIO SEMPRE, orcamento proprio.
      if (command.arg.length === 0) {
        probes += 1
        const visto = sondasPorChat.get(identity.chatKey)
        let sondasAnteriores: number
        if (visto !== undefined) {
          sondasAnteriores = visto
          sondasPorChat.set(identity.chatKey, visto + 1)
        } else if (sondasPorChat.size < limits.maxProbeChatsTracked) {
          sondasAnteriores = 0
          sondasPorChat.set(identity.chatKey, 1)
        } else {
          // Mapa cheio: nao se registam chats novos; o escalar continua a subir.
          sondasAnteriores = Number.MAX_SAFE_INTEGER
        }
        return recusar('refuse:malformed', undefined, atrasoPara(sondasAnteriores), identity, 'sonda')
      }

      // ---- A PARTIR DAQUI TODA A TENTATIVA CARREGA UM PALPITE.
      // TETO ANTES DA VERIFICACAO (PAIR-007): um chat esgotado nao chega a TESTAR.
      const falhasDoChat = tentativasPorChat.get(identity.chatKey) ?? 0
      if (falhasDoChat >= limits.maxAttemptsPerChat || tentativasGlobal >= limits.maxAttemptsGlobal) {
        return recusar('refuse:rate-limited', undefined, limits.maxDelayMs, identity, 'palpite')
      }

      attempts += 1
      tentativasGlobal += 1
      tentativasPorChat.set(identity.chatKey, falhasDoChat + 1)

      // TTL — PAIR-004. Relogio injetado.
      if (deps.clock.now() >= challenge.expiresAt) {
        return recusar('refuse:expired', RESPOSTA_PAREAMENTO_RECUSADO, atrasoPara(falhasDoChat), identity, 'palpite')
      }

      if (!challenge.verify(command.arg)) {
        // >>> UNICO RAMO QUE DEVOLVE SINAL A QUEM NAO E DONO. Responde porque
        // PAIR-003 exige resposta generica — e POR RESPONDER debita palpite.
        return recusar('refuse:wrong-code', RESPOSTA_PAREAMENTO_RECUSADO, atrasoPara(falhasDoChat), identity, 'palpite')
      }

      // ---- PAREADO. Os dois eixos vem DESTE evento (o que carrega o codigo certo).
      const owner: PairedOwner = {
        userKey: identity.userKey,
        chatKey: identity.chatKey,
        pairedAt: deps.clock.now(),
      }
      state = { status: 'fechado', owner }
      byReason.set('ok', (byReason.get('ok') ?? 0) + 1)

      return {
        kind: 'paired',
        owner,
        // Nao ecoa o codigo.
        reply: 'Pareado. Este chat passa a ser o unico autorizado a comandar este bot.',
        audit: {
          evento: 'surface.pareamento.concluido',
          resultado: 'permitido',
          motivo: 'ok',
          orcamento: 'palpite',
          userKey: identity.userKey,
          chatKey: identity.chatKey,
        },
      }
    },

    state(): SurfacePairingState {
      return state
    },

    stats(): SurfacePairingStats {
      return { attempts, probes, refused, byReason: Object.fromEntries(byReason) }
    },

    rotateChallenge(next: SurfacePairingChallenge): void {
      challenge = next
    },

    semearDono(dono: PairedOwner): void {
      // `fechado` e terminal neste modulo: uma vez com dono, `/parear` e
      // recusado (PAIR-005). O orcamento de palpites NAO e zerado, e o desafio
      // corrente nao e tocado (o host continua a rota-lo por `rotateChallenge`).
      state = { status: 'fechado', owner: dono }
    },
  }
}

// ---------------------------------------------------------------------------
// Leitura do comando a partir de um `SurfaceCommandEvent`.
//
// A identidade ja vem normalizada; so resta comutar o texto. O varrimento e
// manual (nao regex) pela mesma razao de PAIR-010. `identity` pode ser
// `undefined` se um adaptador emitir um comando sem identidade completa — mas
// os comandos neutros do funil normal voem ja o guard (o comando so passa a
// ser processado depois da allowlist).
// ---------------------------------------------------------------------------

interface ComandoPareado {
  readonly nome: string
  readonly arg: string
  readonly identity: SurfaceIdentity | undefined
}

/** Limite da forma do texto de que este modulo trata. Nao processamos alem. */
const MAX_TEXT_CHARS = 4_096

function parseComando(evento: SurfaceCommandEvent): ComandoPareado | undefined {
  const texto = evento.text
  if (texto.length === 0 || texto.length > MAX_TEXT_CHARS) return undefined

  const aparado = texto.trim()
  if (!aparado.startsWith('/')) return undefined

  const espaco = indiceDeEspacoAscii(aparado)
  const cabeca = espaco === -1 ? aparado : aparado.slice(0, espaco)
  const arg = espaco === -1 ? '' : aparado.slice(espaco + 1).trim()

  // `/parear@nome_bot 123456` — o cliente de grupo acrescenta o `@bot`.
  const arroba = cabeca.indexOf('@')
  const nome = (arroba === -1 ? cabeca.slice(1) : cabeca.slice(1, arroba)).toLowerCase()
  if (nome.length === 0) return undefined

  return { nome, arg, identity: evento.identity }
}

/** Indice do primeiro espaco em branco ASCII, ou `-1`. Cobra ` `, `\t`..`\r`. */
function indiceDeEspacoAscii(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i)
    if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) return i
  }
  return -1
}

/* ========================================================================== */
/* 5. A TABELA DE EXPOSICAO (o espelho neutro de `INCREASES_EXPOSURE`)         */
/* ========================================================================== */

/**
 * Acao -> exige confirmacao de 2 etapas?
 *
 * `Record<SurfaceAction, boolean>` (SurfaceAction = IpcIntentName) e o ponto
 * todo: se `IpcIntentName` ganhar um membro novo, este objecto deixa de
 * compilar e alguem e OBRIGADO a decidir, aqui, se ele aumenta ou reduz
 * exposicao. A assimetria e fail-safe na direccao certa (`02-SEGURANCA.md` 7.3):
 * o que AUMENTA confirma; o que REDUZ executa a primeira.
 */
export const AUMENTA_EXPOSICAO: Readonly<Record<SurfaceAction, boolean>> = Object.freeze({
  'tunnel.up': true,
  'tunnel.down': false,
  'tunnel.status': false,
  'session.issue': true,
  'secret.rotate': true,
  emergency: false,
})

/* ========================================================================== */
/* 6. O GUARD NEUTRO — decisao por evento, descartado CONTADO (TG-089)         */
/* ========================================================================== */

export interface SurfaceGuardStats {
  readonly admitido: number
  readonly descartado: number
  /** Contagem por motivo. E o que o relatorio ao dono usa. */
  readonly byReason: Readonly<Record<string, number>>
}

/**
 * A decisao do funil neutro. Uniao discriminada com TRES saidas e nenhuma
 * quarta: um evento ou vira comando, ou vira acao encaminhada, ou e
 * REJEITADO. Nenhum ramo de erro termina em "deixa passar".
 */
export type SurfaceGuardDecision =
  | {
      readonly kind: 'comando'
      readonly identity: SurfaceIdentity
      readonly audit: SurfaceGuardAuditIntent
    }
  | {
      readonly kind: 'acao'
      readonly identity: SurfaceIdentity
      readonly action: SurfaceAction
      /** OPACO (S5): vai tal e qual para o host, que o valida. */
      readonly token: string
      /** Se a acao aumenta exposicao. Informativo; o host decide na mesma. */
      readonly increasesExposure: boolean
      /** O alvo de resposta do clique (TG-027). Obrigatorio em `acao`. */
      readonly answerTarget: string
      readonly audit: SurfaceGuardAuditIntent
    }
  | {
      readonly kind: 'rejeitado'
      readonly reason: string
      /** Presente quando houve a quem responder (protocolo TG-027). */
      readonly answerTarget?: string | undefined
      readonly identity?: SurfaceIdentity | undefined
      readonly audit: SurfaceGuardAuditIntent
    }

/** Auditoria do funil, em PT-BR. `evento` usa o marcador neutro `surface.evento.*`. */
export interface SurfaceGuardAuditIntent {
  readonly evento: 'surface.evento.admitido' | 'surface.evento.descartado'
  readonly resultado: 'permitido' | 'negado'
  readonly motivo: string
  readonly userKey?: string | undefined
  readonly chatKey?: string | undefined
}

export interface SurfaceIdentityGuard {
  /** O UNICO ponto de entrada. Todo evento passa por aqui. */
  admit(evento: SurfaceEvent): SurfaceGuardDecision
  /** Contadores acumulados. TG-089: descartado E contado. */
  stats(): SurfaceGuardStats
}

export interface SurfaceIdentityGuardDeps {
  readonly allowlist: SurfaceAllowlist
}

/**
 * Constroi o funil neutro.
 *
 * O UNICO estado sao CONTADORES. Nenhum nonce, nenhum token consumido, nenhuma
 * sessao. A identidade e REVALIDADA em TODO evento de `acao` (TG-024) e em todo
 * evento de `comando` — e por isso que um clique de um membro estranho num
 * grupo autorizado nunca chega ao host.
 *
 * O evento nao pode carregar um token verificavel por nos: {@link SurfaceActionEvent}
 * ja vem COM o token extraido pelo adaptador. O guard nao valida o VALOR (S5),
 * apenas transporta.
 */
export function criarGuardDeIdentidade(deps: SurfaceIdentityGuardDeps): SurfaceIdentityGuard {
  let admitido = 0
  let descartado = 0
  const byReason = new Map<string, number>()

  function contar(motivo: string, permitido: boolean): void {
    if (permitido) admitido += 1
    else descartado += 1
    byReason.set(motivo, (byReason.get(motivo) ?? 0) + 1)
  }

  return {
    admit(evento: SurfaceEvent): SurfaceGuardDecision {
      // -------------------------------------------------------------------
      // ACAO MALFORMADA/DESCARTAVEL — o adaptador nao conseguiu ler um payload
      // valido. NUNCA inventa `action`/`token`: responde ao clique (TG-027) e
      // conta. `answerTarget` e obrigatorio neste evento.
      // -------------------------------------------------------------------
      if (evento.kind === 'acao-invalida') {
        const motivo = evento.reason ?? 'deny:callback-data-invalido'
        contar(motivo, false)
        return {
          kind: 'rejeitado',
          reason: motivo,
          answerTarget: evento.answerTarget,
          identity: evento.identity,
          audit: {
            evento: 'surface.evento.descartado',
            resultado: 'negado',
            motivo,
            ...(evento.identity === undefined
              ? {}
              : { userKey: evento.identity.userKey, chatKey: evento.identity.chatKey }),
          },
        }
      }

      // -------------------------------------------------------------------
      // COMANDO — um update de TEXTO normalizado. Revalida os dois eixos.
      // -------------------------------------------------------------------
      if (evento.kind === 'comando') {
        const decisao = decidirAutorizacao(evento.identity, deps.allowlist)
        if (!decisao.ok) {
          contar(decisao.reason, false)
          return {
            kind: 'rejeitado',
            reason: decisao.reason,
            identity: evento.identity,
            audit: {
              evento: 'surface.evento.descartado',
              resultado: 'negado',
              motivo: decisao.reason,
              ...(evento.identity === undefined
                ? {}
                : { userKey: evento.identity.userKey, chatKey: evento.identity.chatKey }),
            },
          }
        }
        const identity = evento.identity
        contar('ok', true)
        return {
          kind: 'comando',
          identity,
          audit: {
            evento: 'surface.evento.admitido',
            resultado: 'permitido',
            motivo: 'ok',
            userKey: identity.userKey,
            chatKey: identity.chatKey,
          },
        }
      }

      // -------------------------------------------------------------------
      // ACAO — um clique. A PARTIR DAQUI A IDENTIDADE JA FOI REVALIDADA
      // (TG-024): `decidirAutorizacao` acabou de comparar `userKey` (quem
      // carregou) E `chatKey` (onde estava a mensagem) contra a allowlist.
      // -------------------------------------------------------------------
      const decisao = decidirAutorizacao(evento.identity, deps.allowlist)
      if (!decisao.ok) {
        contar(decisao.reason, false)
        return {
          kind: 'rejeitado',
          reason: decisao.reason,
          // TG-027: responder NA negacao tambem. O `answerTarget` do evento.
          answerTarget: evento.answerTarget,
          identity: evento.identity,
          audit: {
            evento: 'surface.evento.descartado',
            resultado: 'negado',
            motivo: decisao.reason,
            ...(evento.identity === undefined
              ? {}
              : { userKey: evento.identity.userKey, chatKey: evento.identity.chatKey }),
          },
        }
      }

      const identity = evento.identity
      // Falta de `answerTarget` = impossivel cumprir TG-027; fail-closed.
      if (evento.answerTarget.length === 0) {
        contar('deny:sem-alvo-de-resposta', false)
        return {
          kind: 'rejeitado',
          reason: 'deny:sem-alvo-de-resposta',
          identity,
          audit: {
            evento: 'surface.evento.descartado',
            resultado: 'negado',
            motivo: 'deny:sem-alvo-de-resposta',
            userKey: identity.userKey,
            chatKey: identity.chatKey,
          },
        }
      }

      contar('ok', true)
      return {
        kind: 'acao',
        identity,
        action: evento.action,
        token: evento.token,
        increasesExposure: AUMENTA_EXPOSICAO[evento.action],
        answerTarget: evento.answerTarget,
        audit: {
          evento: 'surface.evento.admitido',
          resultado: 'permitido',
          motivo: 'ok',
          userKey: identity.userKey,
          chatKey: identity.chatKey,
        },
      }
    },

    stats(): SurfaceGuardStats {
      return { admitido, descartado, byReason: Object.fromEntries(byReason) }
    },
  }
}

/* ========================================================================== */
/* 7. O FACADE `criarAuthDeSuperficie` — o que o NUCLEO (core.ts) consome      */
/* ========================================================================== */

/**
 * DONO persistido — a forma que o CORE chama de `SurfaceDono` e que este facade
 * devolve em `estado()`. Espelho de `PairedOwner`, os dois eixos em STRING (D4).
 */
export interface SurfaceDonoDaSuperficie {
  readonly userKey: string
  readonly chatKey: string
  readonly pairedAt: number
}

/** O estado do pareamento na forma que o core lê em `estado()`/`dono()`. */
export type SurfaceEstadoPareamentoSuperficie =
  | { readonly status: 'aberto' }
  | { readonly status: 'fechado'; readonly dono: SurfaceDonoDaSuperficie }

/**
 * O resultado de `receber` na forma que o core consome (`SurfacePareamentoResultado`).
 * `chat` deriva do `chatKey` do evento; `reply` ausente = descarte silencioso.
 */
export type SurfacePareamentoResultadoSuperficie =
  | { readonly kind: 'pareado'; readonly dono: SurfaceDonoDaSuperficie; readonly reply: string }
  | { readonly kind: 'boas-vindas'; readonly reply: string; readonly chat: string | undefined }
  | {
      readonly kind: 'recusado'
      readonly reply: string | undefined
      /** O chamador espera este tempo ANTES de responder. */
      readonly delayMs: number
      readonly chat: string | undefined
    }
  | { readonly kind: 'ignorado' }

/** O veredito de allowlist que o core usa (`SurfaceAdmissao`). */
export type SurfaceAdmissaoSuperficie =
  | { readonly admitido: true }
  | { readonly admitido: false; readonly motivo: string }

/**
 * O funil que o NUCLEO consome de `auth` (`SurfaceAuth`). PLANA e composta: o
 * receptor de pareamento + o guard de identidade + a allowlist de dois eixos,
 * com a traducao das unioes para a forma que o core espera (o core acrescenta
 * `deny:` por cima do `motivo`, logo o motivo sai SEM o prefixo).
 */
export interface SurfaceAuthDaSuperficie {
  receber(evento: SurfaceCommandEvent): SurfacePareamentoResultadoSuperficie
  admitirComando(identidade: SurfaceIdentity): SurfaceAdmissaoSuperficie
  admitirAcao(identidade: SurfaceIdentity, action: SurfaceAction): SurfaceAdmissaoSuperficie
  estado(): SurfaceEstadoPareamentoSuperficie
  rotacionarDesafio(desafio: SurfacePairingChallenge): void
  semearDono(dono: PairedOwner): void
}

/** As deps do facade — o que o wire/onda 4 fornece ao monta-lo. */
export interface SurfaceAuthFacadeDeps {
  readonly challenge: SurfacePairingChallenge
  readonly clock: SurfacePairingClock
  readonly limits?: SurfacePairingLimits | undefined
  /** Dono persistido no arranque; o receptor nasce fechado. */
  readonly owner?: PairedOwner | undefined
  /** Chaves iniciais da allowlist de dois eixos. */
  readonly users?: readonly string[] | undefined
  readonly chats?: readonly string[] | undefined
}

/**
 * Uma {@link SurfaceAllowlist} que sabe CRESCER (a allowlist canonica e
 * imutavel; aqui a `semearDono` tem de dar ao dono o acesso aos DOIS eixos sem
 * reconstruir o facade). O `size` e a soma atual.
 */
export interface SurfaceAllowlistIncremental extends SurfaceAllowlist {
  readonly adicionarUser: (chave: string) => void
  readonly adicionarChat: (chave: string) => void
}

export function criarAllowlistIncremental(users: readonly string[], chats: readonly string[]): SurfaceAllowlistIncremental {
  const setUsers = new Set<string>(users)
  const setChats = new Set<string>(chats)
  return {
    // `size` e DERIVADO (getter): `adicionar*` muta o conjunto e o default-deny
    // passa a ver o novo dono semeado (sem isso, `size===0` negaria tudo).
    get size(): number {
      return setUsers.size + setChats.size
    },
    hasUser: (key: string): boolean => setUsers.has(key),
    hasChat: (key: string): boolean => setChats.has(key),
    adicionarUser(chave: string): void {
      const limpa = chave.trim()
      if (limpa.length > 0) setUsers.add(limpa)
    },
    adicionarChat(chave: string): void {
      const limpa = chave.trim()
      if (limpa.length > 0) setChats.add(limpa)
    },
  }
}

/** Forma minima que o facade usa para admitir uma identidade contra a allowlist. */
interface AllowlistDeAdmissao {
  readonly size: number
  hasUser(key: string): boolean
  hasChat(key: string): boolean
}

/** Traduz `decidirAutorizacao` para a `SurfaceAdmissaoSuperficie` (motivo sem prefixo). */
function admissaoPara(
  identidade: SurfaceIdentity,
  allowlist: AllowlistDeAdmissao,
): SurfaceAdmissaoSuperficie {
  const decisao = decidirAutorizacao(identidade, allowlist)
  if (decisao.ok) return { admitido: true }
  return { admitido: false, motivo: decisao.reason.slice('deny:'.length) }
}

/**
 * Composicao que o CORE consome como `SurfaceAuth`. Ordem do funil (PAIR-006/007):
 * pareamento PRIMEIRO (via `receber`), allowlist DEPOIS (via `admitirComando`/
 * `admitirAcao`). `semearDono` fecha o receptor E da ao dono os dois eixos.
 */
export function criarAuthDeSuperficie(deps: SurfaceAuthFacadeDeps): SurfaceAuthDaSuperficie {
  const allowlist = criarAllowlistIncremental(deps.users ?? [], deps.chats ?? [])
  const receiver = criarReceptorDePareamento({
    challenge: deps.challenge,
    clock: deps.clock,
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(deps.owner === undefined ? {} : { owner: deps.owner }),
  })

  // Se o facade nasce com dono, a allowlist ja o aceita nos dois eixos.
  if (deps.owner !== undefined) {
    allowlist.adicionarUser(deps.owner.userKey)
    allowlist.adicionarChat(deps.owner.chatKey)
  }

  return {
    receber(evento: SurfaceCommandEvent): SurfacePareamentoResultadoSuperficie {
      const resultado = receiver.receive(evento)
      switch (resultado.kind) {
        case 'paired':
          return { kind: 'pareado', dono: resultado.owner, reply: resultado.reply }
        case 'welcome':
          return { kind: 'boas-vindas', reply: resultado.reply, chat: resultado.chat }
        case 'refused':
          return {
            kind: 'recusado',
            reply: resultado.reply,
            delayMs: resultado.delayMs,
            chat: resultado.chat,
          }
        case 'ignored':
          return { kind: 'ignorado' }
      }
    },

    admitirComando(identidade: SurfaceIdentity): SurfaceAdmissaoSuperficie {
      return admissaoPara(identidade, allowlist)
    },

    admitirAcao(identidade: SurfaceIdentity, _action: SurfaceAction): SurfaceAdmissaoSuperficie {
      // A REVALIDACAO de identidade (S6) nao depende da acao: qualquer membro
      // estranho de um grupo autorizado e barrado em TG-024, qualquer que seja
      // o botao. O `_action` existe na assinatura que o core espera.
      return admissaoPara(identidade, allowlist)
    },

    estado(): SurfaceEstadoPareamentoSuperficie {
      const estado = receiver.state()
      if (estado.status === 'fechado') return { status: 'fechado', dono: estado.owner }
      return { status: 'aberto' }
    },

    rotacionarDesafio(desafio: SurfacePairingChallenge): void {
      receiver.rotateChallenge(desafio)
    },

    semearDono(dono: PairedOwner): void {
      receiver.semearDono(dono)
      // O dono persistido passa a ser aceite nos DOIS eixos (8c).
      allowlist.adicionarUser(dono.userKey)
      allowlist.adicionarChat(dono.chatKey)
    },
  }
}