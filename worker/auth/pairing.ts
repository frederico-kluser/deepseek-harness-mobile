/**
 * Recepcao de `/parear <codigo>`; o **segundo** pareamento e recusado.
 *
 * DONO: T4.4. A **geracao** do codigo e do host (T4.1, `src/telegram/pairing.ts`):
 * 6 digitos de CSPRNG, TTL 5 min, exibidos **so no terminal/painel local**.
 * Aqui recebe-se o codigo e decide-se.
 *
 * ===========================================================================
 * PORQUE CODIGO, E NAO "O PRIMEIRO `/start` VENCE"
 * ===========================================================================
 * O segundo desenho e uma **CORRIDA QUE O ATACANTE GANHA**. Nomes de bot sao
 * adivinhaveis; o dono esta a ler o tutorial enquanto o atacante tem um script.
 * E ganhar essa corrida nao lhe da so o chat: `/acessar` emite sessao, portanto
 * da-lhe **shell na maquina do dono sem ele nunca ver a senha**.
 *
 * O codigo amarra a identidade do Telegram a **posse do terminal**, que e a raiz
 * de confianca real deste sistema (`02-SEGURANCA.md` 7.2). Por isso, e sem
 * excepcao: **`/start` nao pareia ninguem** (D8). Nem o primeiro, nem o do dono.
 *
 * ===========================================================================
 * A AMEACA QUE A ALLOWLIST **NAO** FILTRA, E QUE POR ISSO VIVE AQUI
 * ===========================================================================
 * Seis digitos sao 10^6. E as tentativas de `/parear` chegam, **por definicao**,
 * de um `from.id` DESCONHECIDO — se ja fosse conhecido nao havia nada para
 * parear. Logo `worker/auth/allowlist.ts` **nao pode** barra-las: este e o unico
 * caminho do worker onde um estranho e legitimamente processado.
 *
 * Sem contagem por chat e teto com descarte, 10^6 e enumeravel dentro dos 5 min
 * de TTL. O teto esta em {@link DEFAULT_PAIRING_LIMITS} e o atraso e devolvido
 * como intencao (`delayMs`), nunca dormido aqui dentro.
 *
 * NOTA DE HONESTIDADE sobre o atraso, para nao copiar mal o gate HTTP: em
 * `src/ratelimit/**` o atraso corre ANTES da comparacao, porque la a resposta e
 * desenhada para ser indistinguivel e o tempo seria o unico oraculo restante
 * (CWE-208). AQUI nao ha esse oraculo a proteger — quem tentou parear observa
 * directamente se ficou pareado ou nao. O atraso aqui e **estrangulamento**, e
 * so isso; declarar-lhe uma propriedade de tempo constante que ele nao tem seria
 * o "controlo inerte que parece activo" que `02-SEGURANCA.md` 0.2 condena.
 *
 * ===========================================================================
 * O CODIGO NAO SAI DAQUI (PAIR-010) — E O LIMITE EXACTO DESSA AFIRMACAO
 * ===========================================================================
 * O que E estrutural, e o que cada teste vigia:
 *
 *   - {@link createPairingChallenge} calcula o `sha256` e devolve um objecto com
 *     EXACTAMENTE duas propriedades proprias, `expiresAt` e `verify`. Nenhuma
 *     retem o claro, e `verify` compara com `timingSafeEqual`. O teste assere
 *     `Object.getOwnPropertyNames` e o corpo de `verify` — porque
 *     `JSON.stringify` nao ve closures, nao ve propriedades nao enumeraveis e
 *     OMITE funcoes, logo uma asercao sobre ele nao vigia nada.
 *   - Nenhuma resposta, nenhum registo de auditoria e nenhum contador interpola
 *     o candidato: as respostas sao **constantes de modulo**.
 *   - Nenhuma operacao deste modulo toca o codigo com uma `RegExp`. Isto nao e
 *     estilo. `RegExp.prototype.test` e `String.prototype.search` publicam o
 *     sujeito e o trecho casado nas estaticas GLOBAIS `RegExp.input` e
 *     `RegExp.lastMatch`, que sobrevivem ao retorno da funcao — um `test` sobre
 *     o codigo deixa-o legivel a qualquer outro ficheiro do processo ate a
 *     operacao seguinte o sobrescrever. Por isso a validacao da forma e a
 *     divisao do comando sao por varrimento de `charCodeAt`, e ha um teste que
 *     le `RegExp.input` depois do fluxo completo.
 *
 * O QUE NAO E VERDADE, e este texto nao vai fingir que e: nao existe forma, em
 * JavaScript, de APAGAR da memoria do processo uma string ja criada. O codigo em
 * claro vive enquanto o argumento do construtor e o texto da mensagem nao forem
 * recolhidos pelo GC, e nenhuma atribuicao muda isso — strings sao imutaveis.
 *
 * A defesa contra quem LE a memoria deste processo nao vive neste ficheiro e nao
 * pode viver: vive em o worker ser um processo SEPARADO com ambiente construido
 * por allowlist (ver o cabecalho de `src/contracts/ipc.ts`). Sem essa separacao,
 * um core dump ou `/proc/self/environ` entregam tudo, e nenhuma disciplina
 * dentro deste modulo o impediria.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { extractIdentity, WorkerAuthError, type UpdateIdentity } from './allowlist.ts'

// ---------------------------------------------------------------------------
// O desafio
// ---------------------------------------------------------------------------

/** Quantos digitos o codigo de T4.1 tem. */
const PAIRING_CODE_DIGITS = 6

/**
 * Forma do codigo — **por varrimento, nunca por `RegExp`**.
 *
 * `/^[0-9]{6}$/.test(code)` faria exactamente o que se quer... e deixaria o
 * codigo em `RegExp.input` e em `RegExp.lastMatch`, que sao propriedades
 * ESTATICAS do construtor global e ficam legiveis para todo o processo ate a
 * proxima operacao de regex as sobrescrever. Um varrimento de `charCodeAt` nao
 * publica nada em lado nenhum.
 */
function isSixDigitCode(value: string): boolean {
  if (value.length !== PAIRING_CODE_DIGITS) return false
  for (let i = 0; i < PAIRING_CODE_DIGITS; i += 1) {
    const digit = value.charCodeAt(i)
    // 0x30..0x39 = '0'..'9'. Sem `Number.isNaN`, sem `parseInt`: ambos aceitam
    // formas que nao sao seis digitos ('1e5', '+12345', espacos a volta).
    if (digit < 0x30 || digit > 0x39) return false
  }
  return true
}

/**
 * O desafio, na forma em que o worker o pode guardar: um VERIFICADOR e um
 * prazo. Nunca o codigo.
 */
export interface PairingChallenge {
  /** `true` sse o candidato e o codigo. Comparacao em tempo constante. */
  verify(candidate: string): boolean
  /** Epoch ms em que o codigo deixa de valer. TTL de 5 min, decidido no host. */
  readonly expiresAt: number
}

/**
 * Constroi o desafio a partir do codigo em claro, e **descarta o claro**.
 *
 * PORQUE COMPARAR DIGESTS E NAO STRINGS: `timingSafeEqual` LANCA `RangeError`
 * com buffers de comprimentos diferentes; comparar material cru obrigaria a
 * ramificar no comprimento primeiro, e esse ramo vazaria o comprimento. Reduzir
 * os dois lados a `sha256` da sempre 32 bytes e torna a comparacao total. E a
 * mesma decisao ja tomada em `src/secret/verify.ts` — repetida aqui, e nao
 * importada, porque o worker e outro processo (`05-QUALIDADE-CODIGO.md` 5.5).
 *
 * FALHA ALTO se o codigo nao tiver a forma acordada com T4.1. Um desafio
 * malformado que "nunca casa" seria um pareamento impossivel com sintoma
 * ("mandei o codigo e nao acontece nada") indistinguivel de um bug de rede.
 */
export function createPairingChallenge(code: string, expiresAt: number): PairingChallenge {
  if (!isSixDigitCode(code)) {
    // A mensagem NAO cita o codigo — nem o invalido. Ver PAIR-010.
    throw new WorkerAuthError(
      'PAIRING_CHALLENGE_INVALID',
      `codigo de pareamento tem de ser 6 digitos decimais (recebido: ${code.length} caracteres)`,
    )
  }
  if (!Number.isFinite(expiresAt)) {
    throw new WorkerAuthError('PAIRING_CHALLENGE_INVALID', 'expiresAt tem de ser um epoch em ms finito')
  }

  // O UNICO sitio deste ficheiro onde o codigo em claro existe. A partir do
  // `return`, `code` sai do alcance e so o digest sobrevive na closure.
  const digest = sha256(code)

  return {
    expiresAt,
    verify: (candidate: string): boolean => timingSafeEqual(sha256(candidate), digest),
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

// ---------------------------------------------------------------------------
// Tetos
// ---------------------------------------------------------------------------

export interface PairingLimits {
  /** Tentativas por `chat.id` antes de o chat passar a ser descartado. */
  readonly maxAttemptsPerChat: number
  /**
   * Tentativas somadas de TODOS os chats. E este o teto que fecha a forca
   * bruta: rodar `chat.id` custa uma conta de Telegram nova por tentativa, mas
   * sem um teto global custaria zero.
   */
  readonly maxAttemptsGlobal: number
  /**
   * Quantos chats distintos o contador de SONDAS chega a registar.
   *
   * NAO e um controlo de seguranca, e o comentario existe para ninguem o
   * confundir com um: uma sonda seca e SILENCIOSA em qualquer estado, logo nao
   * ha nada para limitar do lado do atacante. Este numero existe apenas para o
   * `Map` nao crescer sem limite quando alguem roda `chat.id`. Cheio o mapa,
   * para-se de criar entradas — e o silencio mantem-se exactamente igual.
   */
  readonly maxProbeChatsTracked: number
  /** Primeiro atraso. Dobra a cada falha do mesmo chat. */
  readonly baseDelayMs: number
  /** Tecto do atraso. Acima disto o utilizador legitimo desiste antes do atacante. */
  readonly maxDelayMs: number
}

/**
 * Os numeros, e a conta que os justifica.
 *
 * Com 20 PALPITES globais contra 10^6 hipoteses, a probabilidade de acerto
 * dentro de uma janela de TTL e 2 x 10^-5. O TTL de 5 min fecha a janela e o
 * codigo seguinte e outro, logo os palpites gastos nao acumulam conhecimento.
 * Cinco por chat mantem o dono confortavel (erro de digitacao acontece) sem
 * transformar cada conta nova do atacante num orcamento util.
 *
 * ===========================================================================
 * DOIS ORCAMENTOS, E PORQUE ELES NAO PODEM SER UM SO
 * ===========================================================================
 * `maxAttempts*` conta **PALPITES** — tentativas que carregam um candidato a
 * codigo. `maxProbeChatsTracked` pertence a um contador SEPARADO, o de
 * **SONDAS** (`/parear` seco, sem argumento).
 *
 * Houve uma versao deste ficheiro que os fundia, e estava errada. O raciocinio
 * que a corrige:
 *
 *   - **O que fecha o oraculo do estado do pareamento e o SILENCIO, nao a
 *     contagem.** Uma sonda seca responde silencio com a janela aberta e
 *     silencio com ela fechada; nao devolve informacao nem no corpo nem na
 *     existencia de resposta. Contar sondas nao compra seguranca nenhuma.
 *   - **E compra um custo real.** Debitadas ao mesmo orcamento, 20 comandos
 *     secos fecham o pareamento a toda a gente sem o atacante adivinhar uma
 *     unica vez. Adivinhar exige gastar palpites, que e o comportamento que o
 *     orcamento existe para limitar; sondar nao exige nada. Fundir os dois da
 *     ao atacante o caminho MAIS BARATO para o mesmo dano.
 *
 * Consequencia que fica declarada: um estranho ainda pode fechar o pareamento
 * gastando 20 PALPITES, e isso e fail-closed com recuperacao na maquina. O que
 * ele ja nao pode e faze-lo de graca.
 */
export const DEFAULT_PAIRING_LIMITS: PairingLimits = Object.freeze({
  maxAttemptsPerChat: 5,
  maxAttemptsGlobal: 20,
  maxProbeChatsTracked: 64,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
})

function assertLimits(limits: PairingLimits): void {
  const positive =
    limits.maxAttemptsPerChat > 0 &&
    limits.maxAttemptsGlobal > 0 &&
    limits.maxProbeChatsTracked > 0 &&
    limits.baseDelayMs >= 0 &&
    limits.maxDelayMs >= limits.baseDelayMs
  if (!positive) {
    throw new WorkerAuthError(
      'PAIRING_LIMITS_INVALID',
      'tetos tem de ser positivos e maxDelayMs >= baseDelayMs; um teto <= 0 seria limite decorativo',
    )
  }
}

// ---------------------------------------------------------------------------
// Estado e resultados
// ---------------------------------------------------------------------------

/** O dono, tal como gravado. **Os dois eixos**, lidos do mesmo update. */
export interface PairedOwner {
  readonly from: number
  readonly chat: number
  readonly pairedAt: number
}

/**
 * `'aberto'` aceita um pareamento; `'fechado'` nao aceita mais **nenhum**.
 *
 * Nao existe transicao `fechado -> aberto` neste modulo, e a ausencia e o
 * controlo: reabrir exige `--reset-pairing` **na maquina** (PAIR-008, T4.1), o
 * que reconstroi o processo do worker com um desafio novo. Um metodo `reopen()`
 * aqui seria uma porta que a rede pode bater.
 */
export type PairingState =
  | { readonly status: 'aberto' }
  | { readonly status: 'fechado'; readonly owner: PairedOwner }

/** Vocabulario FECHADO de recusas. Codigos para o audit; nunca para o chat. */
export type PairingRefusal =
  /** Ja ha dono. Recusado **mesmo com codigo valido, mesmo do proprio dono** (PAIR-005/009). */
  | 'refuse:already-paired'
  /** Codigo nao confere (PAIR-003). */
  | 'refuse:wrong-code'
  /** Codigo expirado (PAIR-004). */
  | 'refuse:expired'
  /** Teto de tentativas atingido: descartado (PAIR-007). */
  | 'refuse:rate-limited'
  /** `/parear` sem argumento, ou argumento fora da forma. */
  | 'refuse:malformed'
  /** Sem `from` ou sem `chat`, ou numa superficie que nao pode parear. */
  | 'refuse:missing-identity'

/**
 * A que orcamento a tentativa foi debitada.
 *
 * Existe para o dono distinguir **"alguem esta a adivinhar"** de **"alguem esta
 * a sondar"** sem ter de saber de cor quais motivos carregam palpite — e para
 * T5.4 poder agregar as duas coisas em separado no relatorio horario. Sao
 * ameacas diferentes e pedem reaccoes diferentes: adivinhar consome orcamento e
 * tem fim; sondar e barulho de fundo que so interessa em volume.
 */
export type PairingBudget = 'palpite' | 'sonda' | 'nenhum'

export interface PairingAuditIntent {
  readonly evento: 'telegram.pareamento.concluido' | 'telegram.pareamento.recusado' | 'telegram.pareamento.boas-vindas'
  readonly resultado: 'permitido' | 'negado'
  readonly motivo: PairingRefusal | 'ok'
  readonly orcamento: PairingBudget
  /**
   * Quem tentou. Valor forense.
   * **NUNCA** ha aqui um campo para o codigo, nem para o candidato (PAIR-010).
   */
  readonly from?: number | undefined
  readonly chat?: number | undefined
}

/**
 * O que fazer a seguir. `reply` `undefined` significa **silencio total**: nao se
 * manda nada ao Telegram.
 */
export type PairingOutcome =
  | {
      readonly kind: 'paired'
      readonly owner: PairedOwner
      readonly reply: string
      readonly audit: PairingAuditIntent
    }
  | {
      readonly kind: 'welcome'
      readonly reply: string
      readonly audit: PairingAuditIntent
    }
  | {
      readonly kind: 'refused'
      readonly reason: PairingRefusal
      /** `undefined` = descarte silencioso. Ver a nota sobre a janela, abaixo. */
      readonly reply?: string | undefined
      /** O chamador espera este tempo ANTES de responder. Nunca dormimos aqui. */
      readonly delayMs: number
      readonly audit: PairingAuditIntent
    }
  | {
      /** Nao e `/parear` nem `/start`: nao e assunto deste modulo. */
      readonly kind: 'ignored'
    }

// ---------------------------------------------------------------------------
// Os textos. Constantes de modulo, e e por isso que PAIR-003 e PAIR-010 valem.
// ---------------------------------------------------------------------------

/**
 * A resposta **UNICA** a qualquer tentativa falhada durante a janela aberta.
 *
 * A mesma string para codigo errado, codigo expirado e comando malformado. Nao
 * diz quantos digitos acertaram, nao diz se o codigo existiu, nao diz se
 * expirou. Sendo **uma constante**, nao ha caminho por onde uma variante
 * informativa entre — que e a forma como PAIR-003 se torna verdade estrutural em
 * vez de disciplina de quem escreve.
 */
export const PAIRING_REFUSAL_REPLY = 'Nao foi possivel parear. Confirme o codigo no terminal da maquina e tente de novo.'

/**
 * A resposta ao DONO que manda `/parear` outra vez. So o dono a ve — para
 * qualquer outra identidade, o pareamento fechado responde **silencio**.
 */
export const PAIRING_ALREADY_PAIRED_REPLY =
  'Este bot ja esta pareado. Para trocar de dono, rode `--reset-pairing` na maquina onde o DSH esta instalado.'

/**
 * Boas-vindas de `/start`. **Inocua e igual para toda a gente** (PAIR-006).
 *
 * Nao diz se ha dono, nao diz se o pareamento esta aberto e nao ensina o
 * comando: quem tem direito de parear esta a olhar para o terminal, e e o
 * terminal que da a instrucao (TG-063, texto de T4.1). Uma resposta que
 * distinguisse dono de estranho seria um oraculo de estado do sistema.
 */
export const PAIRING_WELCOME_REPLY = 'Ola. Este bot e privado e responde apenas ao dono da maquina onde esta instalado.'

// ---------------------------------------------------------------------------
// O receptor
// ---------------------------------------------------------------------------

export interface PairingStats {
  /**
   * **PALPITES** processados: tentativas que carregaram um candidato a codigo,
   * falhadas e bem sucedidas. E este o orcamento que a forca bruta gasta, e o
   * unico que os tetos de {@link PairingLimits} limitam.
   */
  readonly attempts: number
  /**
   * **SONDAS**: `/parear` seco, sem argumento. Contadas A PARTE de proposito —
   * ver a nota dos dois orcamentos em {@link DEFAULT_PAIRING_LIMITS}. Nao
   * gastam palpite nenhum e nao aproximam ninguem do codigo.
   */
  readonly probes: number
  readonly refused: number
  /** Contagem por motivo. E o que o relatorio horario ao dono usa. */
  readonly byReason: Readonly<Record<string, number>>
}

export interface PairingReceiver {
  /**
   * Processa um update. **SINCRONO, e isso e o contrato de PAIR-009** — ver a
   * nota em {@link createPairingReceiver}.
   */
  receive(update: unknown): PairingOutcome
  state(): PairingState
  stats(): PairingStats
  /**
   * Troca o desafio quando o host gera outro codigo (TG-064).
   *
   * **O orcamento de PALPITES nao e zerado.** Se fosse, esperar pelo codigo
   * seguinte daria ao atacante palpites novos de graca e o teto seria
   * decorativo. Nao reabre um pareamento fechado: `fechado` e terminal.
   */
  rotateChallenge(next: PairingChallenge): void
}

/** Relogio injetado (`test/support/clock.ts`). Nenhum teste espera tempo real. */
export interface PairingClock {
  now(): number
}

export interface PairingDeps {
  readonly challenge: PairingChallenge
  readonly clock: PairingClock
  readonly limits?: PairingLimits | undefined
  /**
   * Dono ja persistido, quando o host arranca com pareamento fechado. O worker
   * nasce entao **fechado**, e `/parear` e recusado a partida.
   */
  readonly owner?: PairedOwner | undefined
}

/**
 * Constroi o receptor.
 *
 * ===========================================================================
 * PAIR-009 — A CORRIDA, E PORQUE ELA NAO EXISTE AQUI
 * ===========================================================================
 * Dois `/parear` com o codigo correcto no MESMO tick tem de produzir **UM**
 * dono, de forma determinista, com o segundo a receber recusa. Isso e verdade
 * por uma razao que se escreve numa linha e se perde numa refactorizacao
 * distraida: **`receive` nao tem um unico `await`.**
 *
 * Entre a leitura de `state.status` e a gravacao do dono nao existe ponto de
 * suspensao, logo o event loop nao pode intercalar a segunda chamada. O
 * vencedor e o primeiro a CHEGAR, e "chegar" e uma ordem total num loop de
 * evento unico. No dia em que alguem tornar `receive` assincrono — para chamar o
 * host, para escrever o audit, para o que for — a janela abre-se e dois donos
 * passam a ser possiveis. **Se precisar de I/O, faca-o com o resultado, nunca
 * dentro da decisao.**
 */
export function createPairingReceiver(deps: PairingDeps): PairingReceiver {
  const limits = deps.limits ?? DEFAULT_PAIRING_LIMITS
  assertLimits(limits)

  let challenge = deps.challenge
  let state: PairingState = deps.owner === undefined ? { status: 'aberto' } : { status: 'fechado', owner: deps.owner }

  /** Orcamento de PALPITES: por chat e global. E o que a forca bruta gasta. */
  const attemptsByChat = new Map<number, number>()
  let attemptsGlobal = 0
  let attempts = 0

  /**
   * Contador de SONDAS, separado e sem influencia nenhuma sobre o de palpites.
   * O `Map` existe so para a escada de atraso e e limitado por
   * `maxProbeChatsTracked`; `probes` e um escalar, logo conta sem crescer.
   */
  const probesByChat = new Map<number, number>()
  let probes = 0

  let refused = 0
  const byReason = new Map<string, number>()

  function refuse(
    reason: PairingRefusal,
    reply: string | undefined,
    delayMs: number,
    identity: UpdateIdentity | undefined,
    orcamento: PairingBudget,
  ): PairingOutcome {
    refused += 1
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    return {
      kind: 'refused',
      reason,
      reply,
      delayMs,
      audit: {
        evento: 'telegram.pareamento.recusado',
        resultado: 'negado',
        motivo: reason,
        orcamento,
        from: identity?.from,
        chat: identity?.chat,
      },
    }
  }

  /**
   * Atraso exponencial em funcao das falhas ANTERIORES deste chat.
   *
   * O expoente e limitado antes de `2 **` correr: o contador de sondas nao tem
   * teto (e um escalar), e `2 ** 5000` seria `Infinity` a atravessar a
   * aritmetica so para ser cortado no fim. Cortar o expoente diz o mesmo sem
   * passar por la.
   */
  function delayFor(priorFailures: number): number {
    const raw = limits.baseDelayMs * 2 ** Math.min(priorFailures, 32)
    return Math.min(limits.maxDelayMs, raw)
  }

  return {
    receive(update: unknown): PairingOutcome {
      const command = parseCommand(update)
      if (command === undefined) return { kind: 'ignored' }

      // -----------------------------------------------------------------
      // `/start` — boas-vindas, e NADA MAIS (D8, PAIR-006).
      //
      // O argumento e IGNORADO de proposito. `/start <payload>` e o deep link
      // do Telegram: o payload viaja dentro de uma URL `t.me/bot?start=...`,
      // que e partilhavel, aparece em historico e em pre-visualizacao de link.
      // Aceitar ali um codigo de pareamento poria a raiz de confianca deste
      // sistema num sitio onde ela circula por copiar e colar.
      // -----------------------------------------------------------------
      if (command.name === 'start') {
        return {
          kind: 'welcome',
          reply: PAIRING_WELCOME_REPLY,
          audit: {
            evento: 'telegram.pareamento.boas-vindas',
            resultado: 'negado',
            motivo: 'ok',
            orcamento: 'nenhum',
            from: command.identity.from,
            chat: command.identity.chat,
          },
        }
      }

      if (command.name !== 'parear') return { kind: 'ignored' }

      const identity = command.identity

      // -----------------------------------------------------------------
      // PAIR-005 / PAIR-009 — o SEGUNDO pareamento e recusado.
      //
      // Esta guarda vem ANTES de tudo: antes do teto, antes do TTL e antes de o
      // codigo sequer ser verificado. E recusa **inclusive o proprio dono** com
      // codigo valido. Verificar primeiro e recusar depois deixaria um oraculo
      // ("este codigo ainda vale") a quem nao tem nada que o saber.
      // -----------------------------------------------------------------
      if (state.status === 'fechado') {
        const isOwner = identity.from === state.owner.from && identity.chat === state.owner.chat
        // Ao dono, uma explicacao. A qualquer outra identidade, SILENCIO — a
        // regra de TG-089: nenhuma resposta confirma a existencia do bot a quem
        // nao e dono.
        return refuse(
          'refuse:already-paired',
          isOwner ? PAIRING_ALREADY_PAIRED_REPLY : undefined,
          0,
          identity,
          'nenhum',
        )
      }

      // =================================================================
      // SONDA SEM PALPITE — `/parear` seco. SILENCIO SEMPRE, e orcamento
      // PROPRIO.
      // =================================================================
      // O silencio e o controlo, e e ele sozinho que fecha o oraculo do estado
      // do pareamento: com a janela aberta este ramo cala, com o pareamento
      // fechado o ramo `already-paired` acima tambem cala. Um estranho nao
      // distingue os dois estados nem pelo corpo da resposta nem pela sua
      // EXISTENCIA — e nao os distingue seja qual for o valor dos contadores,
      // porque nenhum contador muda o que ele ve.
      //
      // >>> PORQUE ESTE RAMO NAO DEBITA O ORCAMENTO DE PALPITES.
      // Houve uma versao que debitava, e era pior. Como a sonda nao devolve
      // informacao nenhuma, conta-la nao comprava seguranca — comprava so o
      // custo: 20 comandos secos fechavam o pareamento a toda a gente sem o
      // atacante adivinhar uma unica vez. Adivinhar exige gastar palpites, que
      // e o comportamento que o orcamento existe para limitar; sondar nao exige
      // nada. Fundir os dois dava ao atacante o caminho MAIS BARATO para o
      // mesmo dano.
      //
      // O teto `maxProbeChatsTracked` que aparece aqui NAO e um controlo de
      // seguranca: e so o limite de memoria do `Map`. Cheio, para-se de criar
      // entradas e o silencio mantem-se identico.
      // =================================================================
      if (command.arg.length === 0) {
        probes += 1
        const seen = probesByChat.get(identity.chat)
        let priorProbes: number
        if (seen !== undefined) {
          priorProbes = seen
          probesByChat.set(identity.chat, seen + 1)
        } else if (probesByChat.size < limits.maxProbeChatsTracked) {
          priorProbes = 0
          probesByChat.set(identity.chat, 1)
        } else {
          // Mapa cheio: nao se regista o chat novo. O escalar `probes` continua
          // a subir — o dono ve o volume no audit — e o atraso vai ao maximo.
          priorProbes = Number.MAX_SAFE_INTEGER
        }
        return refuse('refuse:malformed', undefined, delayFor(priorProbes), identity, 'sonda')
      }

      // =================================================================
      // A PARTIR DAQUI TODA A TENTATIVA CARREGA UM PALPITE.
      // =================================================================
      // TETO ANTES DA VERIFICACAO (PAIR-007). A ordem e o controlo: um chat que
      // esgotou o orcamento nao chega a TESTAR o codigo. Se o teto corresse
      // depois, cada tentativa excedente continuaria a ser um palpite valido e
      // o limite so mudaria a resposta, nao a forca bruta.
      //
      // Consequencia aceite e declarada: um dono que se engane cinco vezes fica
      // de fora, e um estranho que gaste as 20 globais — **adivinhando**, que e
      // o unico modo de as gastar — fecha o pareamento a toda a gente ate a
      // maquina reiniciar o worker. Sao os dois fail-closed, e o caminho de
      // recuperacao e o mesmo: ir a maquina, que e onde a confianca deste
      // sistema mora. Um teto que se repusesse sozinho devolveria ao atacante o
      // orcamento que ele acabou de gastar.
      const chatFailures = attemptsByChat.get(identity.chat) ?? 0
      if (chatFailures >= limits.maxAttemptsPerChat || attemptsGlobal >= limits.maxAttemptsGlobal) {
        // Sem `reply`: as excedentes sao DESCARTADAS. Responder a cada uma
        // faria do bot um amplificador e estouraria o limite de 1 msg/s por
        // chat da propria Bot API.
        return refuse('refuse:rate-limited', undefined, limits.maxDelayMs, identity, 'palpite')
      }

      attempts += 1
      attemptsGlobal += 1
      attemptsByChat.set(identity.chat, chatFailures + 1)

      // TTL — PAIR-004. Relogio INJETADO: nenhum teste espera 5 minutos reais.
      if (deps.clock.now() >= challenge.expiresAt) {
        return refuse('refuse:expired', PAIRING_REFUSAL_REPLY, delayFor(chatFailures), identity, 'palpite')
      }

      if (!challenge.verify(command.arg)) {
        // ---------------------------------------------------------------
        // >>> O UNICO RAMO QUE DEVOLVE SINAL A QUEM NAO E DONO. <<<
        //
        // Ele responde porque `04-TESTES.md` PAIR-003 o EXIGE — "resposta
        // generica que nao diz quantos digitos acertou" pressupoe que ha
        // resposta —, e o dono precisa dela para saber que se enganou a
        // digitar.
        //
        // E e exactamente POR RESPONDER que ele e o ramo que consome o
        // orcamento de palpites. Enquanto ha orcamento, a janela aberta
        // responde e a fechada cala: isso e um oraculo, conhecido, e limitado
        // ao numero de palpites. Gasto o teto, os dois estados voltam a ser
        // indistinguiveis.
        //
        // >>> NAO "UNIFORMIZE" ESTE CONTADOR COM O DAS SONDAS. A regra que
        // >>> liga os dois factos e: **um ramo so devolve sinal a quem nao e
        // >>> dono se tiver debitado um palpite.** Um contador unico quebra-a
        // >>> nos dois sentidos — ou a sonda passa a custar, ou este ramo passa
        // >>> a responder de graca.
        // ---------------------------------------------------------------
        return refuse('refuse:wrong-code', PAIRING_REFUSAL_REPLY, delayFor(chatFailures), identity, 'palpite')
      }

      // -----------------------------------------------------------------
      // PAREADO. Os dois eixos vem DESTE update — o que carrega o codigo
      // correcto — e nunca do primeiro update que chegou (TG-065).
      // -----------------------------------------------------------------
      const owner: PairedOwner = { from: identity.from, chat: identity.chat, pairedAt: deps.clock.now() }
      state = { status: 'fechado', owner }
      byReason.set('ok', (byReason.get('ok') ?? 0) + 1)

      return {
        kind: 'paired',
        owner,
        // Nao ecoa o codigo. Ver PAIR-010.
        reply: 'Pareado. Este chat passa a ser o unico autorizado a comandar este bot.',
        audit: {
          evento: 'telegram.pareamento.concluido',
          resultado: 'permitido',
          motivo: 'ok',
          // O pareamento bem sucedido gastou um palpite, como qualquer outro.
          orcamento: 'palpite',
          from: owner.from,
          chat: owner.chat,
        },
      }
    },

    state(): PairingState {
      return state
    },

    stats(): PairingStats {
      return { attempts, probes, refused, byReason: Object.fromEntries(byReason) }
    },

    rotateChallenge(next: PairingChallenge): void {
      challenge = next
    },
  }
}

// ---------------------------------------------------------------------------
// Leitura do comando
// ---------------------------------------------------------------------------

interface ParsedCommand {
  /** Sem `/` e sem `@bot`, em minusculas. */
  readonly name: string
  /** O resto da linha, aparado. String vazia quando nao ha argumento. */
  readonly arg: string
  readonly identity: UpdateIdentity
}

/** Limite da propria Bot API para `Message.text`. Nao processamos alem disso. */
const MAX_TEXT_CHARS = 4_096

/**
 * Le `/comando argumento` de um update — **e so de um `message`**.
 *
 * PORQUE SO `message`, e isto e um controlo e nao uma simplificacao:
 *
 * - **`edited_message` nao pareia.** Seria forca bruta gratuita: editar a mesma
 *   mensagem N vezes gera N updates, e nenhum deles aparece como mensagem nova
 *   no ecra do dono. O atacante enumeraria o codigo dentro de um unico balao de
 *   conversa. O teto de {@link DEFAULT_PAIRING_LIMITS} continuaria a contar,
 *   mas nao ha razao nenhuma para abrir a superficie.
 * - **`callback_query` nao pareia.** Um botao so pode ter sido emitido pelo
 *   bot, e o bot nunca emite botoes antes de haver dono.
 * - **`channel_post` nao pareia**, e nem chega aqui: nao tem `from`.
 *
 * A identidade sai de `extractIdentity`, o mesmo extractor da allowlist — e nao
 * de uma leitura a mao. Duas leituras de `from`/`chat` em ficheiros diferentes
 * divergem no dia em que uma delas for corrigida.
 */
function parseCommand(update: unknown): ParsedCommand | undefined {
  const extraction = extractIdentity(update)
  if (!extraction.ok || extraction.identity.surface !== 'message') return undefined

  const message = (update as { message?: { text?: unknown } }).message
  const text = message?.text
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS) return undefined

  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined

  // `trimmed.search(/\s/u)` seria o idiomatico — e publicaria a LINHA INTEIRA,
  // codigo incluido, em `RegExp.input`. Varrimento manual, pela mesma razao que
  // {@link isSixDigitCode} nao usa regex.
  const space = indexOfAsciiSpace(trimmed)
  const head = space === -1 ? trimmed : trimmed.slice(0, space)
  const arg = space === -1 ? '' : trimmed.slice(space + 1).trim()

  // `/parear@meu_bot 123456` — em grupo o cliente do Telegram acrescenta o
  // `@username` do bot. Cortar no `@` NAO e comparar username: nada aqui decide
  // identidade, so se descarta um sufixo de encaminhamento.
  const at = head.indexOf('@')
  const name = (at === -1 ? head.slice(1) : head.slice(1, at)).toLowerCase()
  if (name.length === 0) return undefined

  return { name, arg, identity: extraction.identity }
}

/**
 * Indice do primeiro espaco em branco ASCII, ou `-1`.
 *
 * Cobre ` `, `\t`, `\n`, `\r`, `\v` e `\f`, que e o que separa um comando do
 * seu argumento em qualquer cliente do Telegram. Um separador exotico
 * (`\u00A0`, por exemplo) faz o nome do comando deixar de bater com `'parear'`
 * e o update cai em `ignored` — que e falhar FECHADO, e nao a passar.
 */
function indexOfAsciiSpace(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i)
    if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) return i
  }
  return -1
}
