/**
 * Autorizacao por `from.id` **E** `chat.id`, fail-closed, descarte silencioso
 * contado.
 *
 * DONO: T4.4.
 *
 * ===========================================================================
 * PORQUE ESTE FICHEIRO E O CONTROLO MAIS IMPORTANTE DO PROJETO
 * ===========================================================================
 * A Bot API do Telegram **nao oferece nada pronto** para isto. A propria
 * documentacao poe a responsabilidade no backend: *"Your backend should always
 * verify that received commands are valid and that the user was authorized to
 * use them regardless of scope."* Sem allowlist, `t.me/seu_bot` e um endpoint
 * PUBLICO de administracao e qualquer pessoa que descubra o nome do bot executa
 * `/desligar` (`02-SEGURANCA.md` 7.1).
 *
 * ===========================================================================
 * AS SEIS ARMADILHAS, E QUAL LINHA DE CODIGO FECHA CADA UMA
 * ===========================================================================
 * 1. **Dois eixos, sempre.** `callback_query` chega com `callback_query.from`.
 *    Num GRUPO, **qualquer membro** pode apertar o botao de uma mensagem que o
 *    bot enviou — o `chat.id` continua a ser o do grupo autorizado enquanto o
 *    `from.id` e de um estranho. Quem validou so `chat.id` esta furado (TG-003).
 *    O inverso tambem: `from.id` do dono num grupo nao listado (TG-005).
 *    -> {@link decideUpdate} exige `allowlist.has(from) && allowlist.has(chat)`.
 *
 * 2. **`message.from` e OPCIONAL.** Ausente em channel posts. Ausencia e
 *    NEGACAO, nunca `undefined === undefined` (TG-004).
 *    -> {@link extractIdentity} devolve `motivo: 'deny:missing-from'`, e o
 *       veredito nunca compara dois `undefined`.
 *
 * 3. **Nunca por `username`.** Username e mutavel e sequestravel: quem larga o
 *    seu, outra pessoa pode tomar. A allowlist e **SO NUMERICA** (TG-008). Nao
 *    existe neste ficheiro nenhuma leitura de `.username` — e `allowlist.test.ts`
 *    assere isso lendo o proprio fonte.
 *
 * 4. **52 bits significativos.** `Chat.id` e `User.id` cabem em 52 bits. O
 *    double do JS e exacto ate 2^53, logo `number` serve; `int32` **PARTE**
 *    (TG-010). -> {@link isTelegramId} exige `Number.isSafeInteger`.
 *
 * 5. **`chat.id` NEGATIVO e normal.** Supergrupo e canal usam id negativo
 *    (TG-011). Nenhum sinal e tratado como erro; o sinal e parte do numero.
 *
 * 6. **Default DENY.** Allowlist vazia nega **tudo, inclusive o dono**
 *    (TG-007) — a mesma semantica de `trustedRemotes: []` que o plugin ja
 *    implementa. Um bot sem pareamento e um bot inerte, nao um bot permissivo.
 *
 * ===========================================================================
 * O QUE ESTE MODULO NAO FAZ, E E ESTRUTURAL
 * ===========================================================================
 * **Nao valida nonce nenhum.** O nonce de confirmacao de duas etapas e emitido
 * e consumido no HOST (`src/control/confirm.ts`, T5.1); ver a invariante **S5**
 * de `src/contracts/ipc.ts`. Um nonce validado no processo que fala com a
 * internet **nao e um controlo, e uma variavel**.
 *
 * **Nao faz I/O.** {@link decideUpdate} e uma funcao PURA: recebe um retrato do
 * update e devolve um VEREDITO com as intencoes. Quem escreve no audit, quem
 * responde ao Telegram e quem espera no relogio e o chamador. Toda a matriz de
 * `04-TESTES.md` TG-001..TG-016 vive aqui e testa-se sem rede, sem disco e sem
 * tempo real.
 */

// ---------------------------------------------------------------------------
// Erro tipado com codigo estavel
// ---------------------------------------------------------------------------

/**
 * Codigos estaveis do modulo de autorizacao do worker.
 *
 * PORQUE NAO REUTILIZA `GuardErrorCode` de `src/errors.ts`: o worker e OUTRO
 * PROCESSO e `05-QUALIDADE-CODIGO.md` 5.5 proibe-lhe importar de `src/` o que
 * nao seja tipo de `src/contracts/`. Importar `src/errors.ts` compilaria, cor-
 * reria em teste unitario e carregaria meio plugin dentro do processo do bot em
 * producao. A duplicacao de 20 linhas e o preco declarado dessa fronteira.
 */
export type WorkerAuthErrorCode =
  /** Um id da allowlist nao e inteiro seguro: erro de configuracao, nao de update. */
  | 'ALLOWLIST_INVALID_ID'
  /** `callback_data` construido acima dos 64 BYTES que a Bot API aceita. */
  | 'CALLBACK_DATA_TOO_LONG'
  /** `callback_data` construido vazio: a Bot API exige 1..64 bytes. */
  | 'CALLBACK_DATA_EMPTY'
  /** Codigo de pareamento fora da forma exigida pelo host (T4.1). */
  | 'PAIRING_CHALLENGE_INVALID'
  /** Tetos de tentativa incoerentes: seria limite decorativo. */
  | 'PAIRING_LIMITS_INVALID'

/**
 * Erro do modulo de autorizacao do worker.
 *
 * Campo atribuido a mao, sem "parameter property": o `node --test` corre os
 * `.ts` em STRIP-ONLY MODE, que recusa essa sintaxe porque ela EMITE codigo em
 * vez de so apagar tipos. A mesma regra vale para `enum` e `namespace`.
 */
export class WorkerAuthError extends Error {
  override readonly name = 'WorkerAuthError'
  readonly code: WorkerAuthErrorCode

  constructor(code: WorkerAuthErrorCode, detail: string) {
    super(`[worker/auth] ${code}: ${detail}`)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// A forma minima do `Update` — estrutural, e de proposito
// ---------------------------------------------------------------------------

/**
 * Retrato do update, na forma MINIMA de que a decisao precisa.
 *
 * PORQUE NAO O TIPO DO grammY: este modulo nao depende do grammY e nao precisa
 * dele — a decisao e pura sobre um objecto. Depender do tipo da biblioteca
 * acoplaria o unico controlo critico do canal a uma dependencia externa e
 * obrigaria T4.2 e T4.4 a partilhar `package.json`, que a fronteira das
 * sub-tarefas proibe.
 *
 * PORQUE OS CAMPOS SAO `unknown` E NAO `number`: isto e JSON vindo da INTERNET.
 * Declarar `id: number` faria o compilador prometer o que a rede nao promete, e
 * o `"100000000000001"` de TG-009 passaria por baixo do tipo. Aqui o tipo diz a
 * verdade — "nao sei o que e" — e {@link isTelegramId} decide em runtime.
 */
export interface RawTelegramUpdate {
  readonly update_id?: unknown
  readonly message?: RawTelegramMessage | undefined
  readonly edited_message?: RawTelegramMessage | undefined
  readonly channel_post?: RawTelegramMessage | undefined
  readonly edited_channel_post?: RawTelegramMessage | undefined
  readonly callback_query?: RawTelegramCallbackQuery | undefined
  readonly inline_query?: RawTelegramInlineQuery | undefined
  readonly my_chat_member?: RawTelegramChatMemberUpdate | undefined
  readonly chat_member?: RawTelegramChatMemberUpdate | undefined
  /** A Bot API cresce. Um campo que ainda nao existe cai em `'unknown'`. */
  readonly [extra: string]: unknown
}

export interface RawTelegramUser {
  /** `unknown` porque vem da rede. So `Number.isSafeInteger` o promove a id. */
  readonly id?: unknown
  readonly [extra: string]: unknown
}

export interface RawTelegramChat {
  readonly id?: unknown
  readonly [extra: string]: unknown
}

export interface RawTelegramMessage {
  /**
   * OPCIONAL NA API, e e disto que TG-004 trata. Em channel post nao existe.
   * Ausencia e NEGACAO.
   */
  readonly from?: RawTelegramUser | undefined
  readonly chat?: RawTelegramChat | undefined
  readonly text?: unknown
  readonly [extra: string]: unknown
}

export interface RawTelegramCallbackQuery {
  /** Id da consulta. STRING na Bot API — e o argumento de `answerCallbackQuery`. */
  readonly id?: unknown
  /** Quem carregou no botao. Num grupo, pode nao ser o dono da conversa. */
  readonly from?: RawTelegramUser | undefined
  /** A mensagem de origem. E dela que sai o `chat.id`. */
  readonly message?: RawTelegramMessage | undefined
  /** 1..64 BYTES fornecidos pelo cliente. NUNCA prova de autorizacao. */
  readonly data?: unknown
  readonly [extra: string]: unknown
}

export interface RawTelegramInlineQuery {
  readonly id?: unknown
  readonly from?: RawTelegramUser | undefined
  /** Nao ha `chat` numa inline query — e por isso que ela e negada (TG-015). */
  readonly [extra: string]: unknown
}

export interface RawTelegramChatMemberUpdate {
  readonly from?: RawTelegramUser | undefined
  readonly chat?: RawTelegramChat | undefined
  readonly [extra: string]: unknown
}

// ---------------------------------------------------------------------------
// Superficies
// ---------------------------------------------------------------------------

/**
 * A superficie do update — qual campo de topo o trouxe.
 *
 * `'unknown'` e um valor de primeira classe, nao um erro: a Bot API evolui e um
 * update de tipo futuro tem de ser IGNORADO SEM EXCECAO (TG-014). Lancar aqui
 * transformaria uma novidade do Telegram numa queda do worker.
 */
export type UpdateSurface =
  | 'message'
  | 'edited_message'
  | 'channel_post'
  | 'edited_channel_post'
  | 'callback_query'
  | 'inline_query'
  | 'my_chat_member'
  | 'chat_member'
  | 'unknown'

/**
 * As UNICAS superficies que podem carregar um comando.
 *
 * PORQUE UMA LISTA E NAO UMA NEGACAO: uma superficie nova da Bot API nasce
 * **fora** desta lista, logo nasce inerte. A regra inversa ("tudo menos estas")
 * faria cada novidade do Telegram nascer accionavel — fail-open por omissao.
 *
 * `edited_message` fica DE FORA de proposito: e a superficie esquecida de
 * TG-012. Um comando que executa ao ser EDITADO deixa o dono sem forma de saber
 * o que correu, porque o texto no ecra ja e o texto novo. O polling ainda pede
 * `allowed_updates: ["message","callback_query"]` (T4.2), mas isso e
 * configuracao no servidor do Telegram — estado invisivel que alguem pode mudar
 * sem tocar neste repositorio. Esta lista e a defesa que viaja com o codigo.
 */
export const ACTIONABLE_SURFACES: readonly UpdateSurface[] = ['message', 'callback_query']

// ---------------------------------------------------------------------------
// Motivos de recusa
// ---------------------------------------------------------------------------

/**
 * Vocabulario FECHADO de motivos de recusa. Cada um e um codigo estavel para o
 * audit — o dono precisa de distinguir "estranho a bater na porta" de
 * "configuracao por fazer" sem ler prosa.
 *
 * NENHUM DESTES MOTIVOS SAI PARA O TELEGRAM. Sao para o log local. Responder ao
 * estranho POR QUE foi negado da-lhe um oraculo gratis sobre o estado do
 * sistema (`02-SEGURANCA.md` 7.2, passo 7).
 */
export type DenyReason =
  /** Allowlist vazia: o pareamento ainda nao aconteceu. Nega ATE O DONO (TG-007). */
  | 'deny:not-configured'
  /** `from` ausente — channel post e afins. Ausencia e negacao (TG-004). */
  | 'deny:missing-from'
  /** Nao ha `chat` de onde falar — `inline_query`, por exemplo (TG-015). */
  | 'deny:missing-chat'
  /** Id que nao e inteiro seguro: string, `NaN`, fraccionario, acima de 2^53 (TG-009). */
  | 'deny:non-numeric-id'
  /** Um dos dois eixos ficou fora da lista (TG-002, TG-003, TG-005, TG-006, TG-008). */
  | 'deny:not-allowlisted'
  /** Identidade valida, mas a superficie nao pode carregar comando (TG-012, TG-013). */
  | 'deny:surface-not-actionable'
  /** Campo de topo que este worker nao conhece. Ignorado sem excecao (TG-014). */
  | 'deny:unsupported-surface'

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Allowlist NUMERICA e IMUTAVEL.
 *
 * Nao expoe os ids: quem a tem responde `has()`, nao itera. E deliberado — um
 * `ids` publico convidaria a construir mensagens com o id do dono lá dentro.
 */
export interface Allowlist {
  /** Quantos ids distintos. `0` significa NEGA TUDO, e e o estado inicial. */
  readonly size: number
  has(id: number): boolean
}

/**
 * Constroi a allowlist a partir de ids numericos.
 *
 * FALHA ALTO em id invalido (`ALLOWLIST_INVALID_ID`). Um `NaN` ou uma string na
 * configuracao **nao pode** virar "entrada que nunca casa": isso seria uma
 * allowlist silenciosamente mais estreita do que o operador julga, e o modo de
 * falha ("o bot nao me responde") e indistinguivel de um bug. O contrario —
 * ignorar e seguir — e a categoria de erro que este plano proibe: nenhum caminho
 * de erro termina em "deixa passar" nem em "finge que esta bem".
 *
 * COPIA os ids para dentro de um `Set` proprio: mutar o array de origem depois
 * da construcao nao muda a allowlist. Um controlo que o chamador consegue
 * alargar por acidente nao e um controlo.
 */
export function createAllowlist(ids: readonly number[]): Allowlist {
  const set = new Set<number>()
  for (const id of ids) {
    if (!isTelegramId(id)) {
      throw new WorkerAuthError(
        'ALLOWLIST_INVALID_ID',
        `id de allowlist tem de ser inteiro seguro (52 bits significativos bastam; int32 NAO): recebido ${JSON.stringify(id)}`,
      )
    }
    set.add(id)
  }
  return Object.freeze({
    size: set.size,
    has: (id: number): boolean => set.has(id),
  })
}

/** A allowlist do arranque: VAZIA, e portanto inerte. Ver TG-007. */
export const EMPTY_ALLOWLIST: Allowlist = createAllowlist([])

/**
 * `true` sse o valor e um id de Telegram utilizavel.
 *
 * `Chat.id` e `User.id` tem ate **52 bits significativos**; o double do JS e
 * exacto ate 2^53, logo `Number.isSafeInteger` e exactamente o predicado certo:
 * aceita `4503599627370495` (2^52-1) sem perder um bit e recusa qualquer coisa
 * acima de 2^53-1, onde a igualdade deixaria de ser fiavel.
 *
 * Recusa, com intencao: `string` (TG-009 — nada de `==` frouxo), `NaN`,
 * `Infinity`, `bigint` (nao e `number`; converter aqui seria coercao silenciosa)
 * e fraccionarios. ACEITA negativos: supergrupo e canal tem id negativo
 * (TG-011) e o sinal e parte do numero, nao um erro.
 */
export function isTelegramId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

// ---------------------------------------------------------------------------
// Extraccao de identidade
// ---------------------------------------------------------------------------

/** Os dois eixos, ja provados numericos, mais a superficie que os trouxe. */
export interface UpdateIdentity {
  readonly from: number
  readonly chat: number
  readonly surface: UpdateSurface
}

/**
 * Resultado da extraccao. E um TIPO DE RETORNO, nao uma excecao: TG-014 exige
 * que um update desconhecido seja ignorado **sem excecao**, e um `throw` no
 * caminho de leitura convida quem chama a deixar o erro subir ate matar o
 * processo do bot por causa de um campo novo da Bot API.
 */
export type IdentityExtraction =
  | { readonly ok: true; readonly identity: UpdateIdentity }
  | { readonly ok: false; readonly reason: DenyReason; readonly surface: UpdateSurface }

/**
 * Qual campo de topo trouxe o update.
 *
 * A ORDEM importa e e a da Bot API: um update legitimo traz exactamente um
 * destes campos. Se um update forjado trouxesse dois, ganha o primeiro desta
 * lista — determinista, e nunca "o mais permissivo".
 */
export function detectSurface(update: unknown): UpdateSurface {
  if (!isObject(update)) return 'unknown'
  if (isObject(update.message)) return 'message'
  if (isObject(update.edited_message)) return 'edited_message'
  if (isObject(update.channel_post)) return 'channel_post'
  if (isObject(update.edited_channel_post)) return 'edited_channel_post'
  if (isObject(update.callback_query)) return 'callback_query'
  if (isObject(update.inline_query)) return 'inline_query'
  if (isObject(update.my_chat_member)) return 'my_chat_member'
  if (isObject(update.chat_member)) return 'chat_member'
  return 'unknown'
}

/**
 * Extrai `from.id` e `chat.id`, cada um do sitio certo para a sua superficie.
 *
 * ISTO E O CORACAO DA ARMADILHA DO GRUPO. Repare em `callback_query`:
 *   - `from`  vem de `callback_query.from`            — QUEM CARREGOU no botao;
 *   - `chat`  vem de `callback_query.message.chat.id` — ONDE estava a mensagem.
 * Em DM os dois numeros sao IGUAIS por construcao, e e exactamente por isso que
 * validar so um passa despercebido em teste manual (`docs/spikes/telegram.md`
 * 10). Num grupo eles separam-se, e o eixo `from` e o unico que distingue o dono
 * de um membro qualquer que carregou no mesmo botao.
 */
export function extractIdentity(update: unknown): IdentityExtraction {
  const surface = detectSurface(update)
  // `detectSurface` so devolve algo diferente de `'unknown'` depois de provar
  // que `update` e um objecto; esta guarda existe para o compilador, e o
  // `'unknown'` que ela devolve e o mesmo caminho de TG-014.
  if (!isObject(update)) return { ok: false, reason: 'deny:unsupported-surface', surface }

  switch (surface) {
    case 'message':
    case 'edited_message':
    case 'channel_post':
    case 'edited_channel_post': {
      const box = update[surface] as RawTelegramMessage
      // `box.from?.id` — o `?.` aqui NAO e conveniencia, e o controlo: sem ele,
      // um channel post daria `undefined` de ambos os lados e um `===` frouxo
      // aprovaria (TG-004).
      return finish(box.from?.id, box.chat?.id, surface)
    }
    case 'callback_query': {
      const cq = update.callback_query as RawTelegramCallbackQuery
      return finish(cq.from?.id, cq.message?.chat?.id, surface)
    }
    case 'inline_query': {
      // Ha `from`, mas nao ha conversa nenhuma: uma inline query nao acontece
      // num chat. Sem o segundo eixo, o veredito e negacao — nunca "meio
      // autorizado" (TG-015).
      const iq = update.inline_query as RawTelegramInlineQuery
      return finish(iq.from?.id, undefined, surface)
    }
    case 'my_chat_member':
    case 'chat_member': {
      const cm = update[surface] as RawTelegramChatMemberUpdate
      return finish(cm.from?.id, cm.chat?.id, surface)
    }
    case 'unknown':
      return { ok: false, reason: 'deny:unsupported-surface', surface }
  }
}

/**
 * Fecha a extraccao aplicando, por esta ordem: presenca de `from`, presenca de
 * `chat`, e so entao a natureza numerica dos dois.
 *
 * A ORDEM E DELIBERADA. "Falta o `from`" e uma condicao de ESTRUTURA (o update e
 * de um tipo que nao tem autor) e "o id nao e numero" e uma condicao de
 * CONTEUDO (alguem mandou lixo). Distingui-las no audit e o que permite ao dono
 * ver a diferenca entre um canal mal configurado e um cliente forjado.
 */
function finish(rawFrom: unknown, rawChat: unknown, surface: UpdateSurface): IdentityExtraction {
  if (rawFrom === undefined || rawFrom === null) return { ok: false, reason: 'deny:missing-from', surface }
  if (rawChat === undefined || rawChat === null) return { ok: false, reason: 'deny:missing-chat', surface }
  if (!isTelegramId(rawFrom) || !isTelegramId(rawChat)) {
    return { ok: false, reason: 'deny:non-numeric-id', surface }
  }
  return { ok: true, identity: { from: rawFrom, chat: rawChat, surface } }
}

// ---------------------------------------------------------------------------
// O veredito
// ---------------------------------------------------------------------------

/**
 * O veredito da allowlist. Uniao discriminada, nao um booleano: um `boolean`
 * obrigaria quem chama a redescobrir o motivo para o audit, e o motivo e metade
 * do controlo ("descartado em silencio **e contado**").
 */
export type UpdateVerdict =
  | {
      readonly outcome: 'accept'
      readonly identity: UpdateIdentity
    }
  | {
      readonly outcome: 'deny'
      readonly reason: DenyReason
      readonly surface: UpdateSurface
      /**
       * Os ids, quando se conseguiram ler. Valor FORENSE: e como o dono sabe
       * QUEM esta a bater na porta. `undefined` quando nem se leram.
       */
      readonly from?: number | undefined
      readonly chat?: number | undefined
    }

/** O que {@link decideUpdate} precisa de saber. Nada mais entra. */
export interface AllowlistDeps {
  readonly allowlist: Allowlist
  /**
   * Superficies que podem carregar comando. Injetavel para o teste conseguir
   * exercitar a regra; o valor de producao e {@link ACTIONABLE_SURFACES}.
   */
  readonly actionableSurfaces?: readonly UpdateSurface[] | undefined
}

/**
 * A UNICA funcao onde a autorizacao do canal se decide.
 *
 * PURA: sem relogio, sem rede, sem disco, sem estado. Recebe um retrato e
 * devolve um veredito. Contar, registar e responder sao do chamador
 * ({@link ../guard.ts}).
 *
 * A ORDEM DAS GUARDAS E CONTRATO, e cada passo fecha um caso de `04-TESTES.md`:
 *
 *   1. superficie desconhecida            -> ignora sem excecao      (TG-014)
 *   2. identidade ausente / nao numerica  -> NEGA                    (TG-004, TG-009, TG-015)
 *   3. allowlist vazia                    -> NEGA, inclusive o dono  (TG-007)
 *   4. `from` OU `chat` fora da lista     -> NEGA                    (TG-002/003/005/006/008)
 *   5. superficie nao accionavel          -> NEGA                    (TG-012, TG-013)
 *   6. so entao                           -> aceita                  (TG-001)
 *
 * Note o passo 5 DEPOIS do 4: um `edited_message` de um estranho e negado por
 * IDENTIDADE, nao por acidente de superficie. Se a ordem fosse a inversa, o
 * audit registaria "superficie inerte" e o dono nunca saberia que alguem
 * desconhecido lhe bateu a porta.
 */
export function decideUpdate(update: unknown, deps: AllowlistDeps): UpdateVerdict {
  const extraction = extractIdentity(update)
  if (!extraction.ok) {
    return { outcome: 'deny', reason: extraction.reason, surface: extraction.surface }
  }

  const { from, chat, surface } = extraction.identity

  // TG-007 — DEFAULT DENY. Lista vazia nega tudo, inclusive o dono. Um motivo
  // proprio, e nao `not-allowlisted`, porque o operador precisa de distinguir
  // "ainda nao pareei" de "alguem estranho apareceu": as duas linhas do log
  // pedem accoes opostas.
  if (deps.allowlist.size === 0) {
    return { outcome: 'deny', reason: 'deny:not-configured', surface, from, chat }
  }

  // OS DOIS EIXOS. Nao ha `||` aqui, e nunca pode haver.
  if (!deps.allowlist.has(from) || !deps.allowlist.has(chat)) {
    return { outcome: 'deny', reason: 'deny:not-allowlisted', surface, from, chat }
  }

  const actionable = deps.actionableSurfaces ?? ACTIONABLE_SURFACES
  if (!actionable.includes(surface)) {
    return { outcome: 'deny', reason: 'deny:surface-not-actionable', surface, from, chat }
  }

  return { outcome: 'accept', identity: extraction.identity }
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/**
 * `typeof null === 'object'` — a armadilha mais velha do JavaScript. Um
 * `update.message = null` forjado passaria por `typeof x === 'object'` e faria
 * `detectSurface` devolver `'message'` para um update sem mensagem nenhuma.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
