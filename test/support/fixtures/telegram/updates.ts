/**
 * FABRICAS DE `Update` DO TELEGRAM — dubles sinteticos para as matrizes TG e PAIR.
 *
 * DONO: **T4.4**. As sub-tarefas irmas podem **LER** este ficheiro; so T4.4
 * escreve nele. Ficheiro sem sufixo `.test.ts`: nao e executado como suite.
 *
 * ===========================================================================
 * PORQUE ESTES DUBLES EXISTEM, EM VEZ DE OBJECTOS LITERAIS NO TESTE
 * ===========================================================================
 * A armadilha central da allowlist e que **em DM `from.id` e `chat.id` sao o
 * MESMO numero** (`docs/spikes/telegram.md` 10). Um teste que monta o update a
 * mao escreve o mesmo id duas vezes sem reparar, e o defeito de validar apenas
 * um eixo fica invisivel. Aqui os dois eixos sao **parametros separados e
 * obrigatorios** nas fabricas de grupo, o que obriga quem escreve o teste a
 * declarar qual e qual.
 *
 * Cada fabrica devolve um objecto NOVO. Nenhum estado partilhado entre testes.
 *
 * Os ids sao SINTETICOS e nao correspondem a contas reais. Sao grandes de
 * proposito: `100000000000001` precisa de 47 bits e **parte em `int32`**, que e
 * exactamente o que TG-010 vigia.
 */

// ---------------------------------------------------------------------------
// Identidades
// ---------------------------------------------------------------------------

/** O dono. 1e14+1: 47 bits significativos, muito acima de 2^31. */
export const OWNER = 100_000_000_000_001

/** O estranho. Vizinho do dono no espaco numerico, de proposito: um bug de
 *  truncagem que os confundisse seria dificil de ver a olho. */
export const STRANGER = 100_000_000_000_002

/**
 * Supergrupo. `chat.id` NEGATIVO e o caso normal para supergrupo e canal
 * (TG-011) — o sinal e parte do numero, nao um erro a corrigir.
 */
export const GROUP = -1_001_234_567_890

/** Um segundo grupo, este NAO listado. Serve TG-005. */
export const OTHER_GROUP = -1_009_876_543_210

/**
 * `2^52 - 1`. O maior inteiro com 52 bits significativos — o tecto declarado
 * para `User.id`/`Chat.id`. Serve TG-010: tem de sobreviver a ida e volta
 * **bit a bit**.
 */
export const MAX_52_BIT_ID = 4_503_599_627_370_495

/** O que `MAX_52_BIT_ID` viraria se alguem o passasse por um `int32`. */
export const MAX_52_BIT_ID_TRUNCATED_TO_INT32 = MAX_52_BIT_ID | 0

// ---------------------------------------------------------------------------
// Fabricas
// ---------------------------------------------------------------------------

let nextUpdateId = 1

/** `update_id` monotonico, para os updates nao serem indistinguiveis nos logs. */
function bumpUpdateId(): number {
  nextUpdateId += 1
  return nextUpdateId
}

export interface UserOverrides {
  readonly id?: unknown
  readonly username?: string
  readonly is_bot?: boolean
}

function user(id: unknown, overrides: UserOverrides = {}): Record<string, unknown> {
  return { id, is_bot: false, first_name: 'Sintetico', ...overrides }
}

function chat(id: unknown, type: string): Record<string, unknown> {
  return { id, type }
}

/**
 * Mensagem em CONVERSA PRIVADA.
 *
 * `from.id === chat.id`, como acontece de verdade no Telegram. E este alinhamento
 * que torna o caminho feliz incapaz de distinguir uma implementacao correcta de
 * uma que so olha para um dos eixos — por isso o caso decisivo e sempre o de
 * grupo.
 */
export function dmMessage(id: number, text = '/status'): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    message: {
      message_id: 10,
      date: 1_700_000_000,
      from: user(id),
      chat: chat(id, 'private'),
      text,
    },
  }
}

/** Mensagem em GRUPO: os dois eixos separam-se, e e obrigatorio declarar ambos. */
export function groupMessage(fromId: number, chatId: number, text = '/status'): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    message: {
      message_id: 11,
      date: 1_700_000_000,
      from: user(fromId),
      chat: chat(chatId, 'supergroup'),
      text,
    },
  }
}

/**
 * `edited_message` — a superficie esquecida de TG-012.
 *
 * Um comando que executa ao ser EDITADO nao deixa rasto legivel: o texto no ecra
 * do dono ja e o texto novo.
 */
export function editedMessage(fromId: number, chatId: number, text = '/desligar'): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    edited_message: {
      message_id: 12,
      date: 1_700_000_000,
      edit_date: 1_700_000_060,
      from: user(fromId),
      chat: chat(chatId, 'private'),
      text,
    },
  }
}

/**
 * CHANNEL POST — o update **sem `from`**, e o caso de TG-004.
 *
 * Repare que nao ha campo `from` nenhum: nao esta a `undefined`, nao existe. Uma
 * implementacao que faca `from === allowedFrom` com os dois `undefined` aprova
 * este update.
 */
export function channelPost(chatId: number, text = '/desligar'): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    channel_post: {
      message_id: 13,
      date: 1_700_000_000,
      chat: chat(chatId, 'channel'),
      text,
    },
  }
}

export interface CallbackQueryOptions {
  /** Quem CARREGOU no botao. Num grupo, pode nao ser o dono da conversa. */
  readonly from: number
  /** O chat ONDE estava a mensagem com o botao. */
  readonly chat: number
  /** O payload. 1..64 bytes, fornecido pelo cliente. */
  readonly data?: unknown
  /** `callback_query.id` — STRING na Bot API. */
  readonly id?: unknown
  /** `false` remove `callback_query.message`, como acontece em mensagens antigas. */
  readonly withMessage?: boolean
}

/**
 * `callback_query` — **o caso decisivo da allowlist** (TG-003).
 *
 * Num grupo, **qualquer membro** pode carregar no botao de uma mensagem que o
 * bot enviou. O `chat.id` continua a ser o do grupo autorizado; so o `from.id`
 * denuncia o estranho.
 */
export function callbackQuery(options: CallbackQueryOptions): Record<string, unknown> {
  // `Object.hasOwn` e nao `??`: passar `id: undefined` ou `data: undefined` TEM
  // de produzir um update SEM esse campo. Com `??`, `undefined` e nulo e o valor
  // por omissao voltaria -- e o teste do campo ausente nunca chegaria a existir.
  const query: Record<string, unknown> = {
    id: Object.hasOwn(options, 'id') ? options.id : '4382512721',
    from: user(options.from),
    chat_instance: '-1234567890',
    data: Object.hasOwn(options, 'data') ? options.data : 'g1:tunnel.down:Zm9vYmFyMDE',
  }
  if (options.withMessage !== false) {
    query['message'] = {
      message_id: 14,
      date: 1_700_000_000,
      chat: chat(options.chat, options.from === options.chat ? 'private' : 'supergroup'),
      text: 'estado',
    }
  }
  return { update_id: bumpUpdateId(), callback_query: query }
}

/** `inline_query`: tem `from`, **nao tem chat nenhum** (TG-015). */
export function inlineQuery(fromId: number): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    inline_query: { id: '99', from: user(fromId), query: '/desligar', offset: '' },
  }
}

/** `my_chat_member` / `chat_member` — nunca podem executar comando (TG-013). */
export function chatMemberUpdate(
  fromId: number,
  chatId: number,
  field: 'my_chat_member' | 'chat_member' = 'my_chat_member',
): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    [field]: {
      chat: chat(chatId, 'supergroup'),
      from: user(fromId),
      date: 1_700_000_000,
      old_chat_member: { status: 'member' },
      new_chat_member: { status: 'administrator' },
    },
  }
}

/**
 * Um update de tipo que este worker nao conhece — TG-014.
 *
 * A Bot API cresce sozinha e sem aviso. `business_message`, `purchased_paid_media`
 * e companhia apareceram depois de muito codigo estar escrito. O worker tem de
 * os ignorar **sem excecao**.
 */
export function futureUpdate(): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    // Nome deliberadamente inventado: representa o campo que ainda nao existe.
    quantum_reaction_v2: { chat: chat(OWNER, 'private'), from: user(OWNER), payload: '/desligar' },
  }
}

/**
 * Mensagem com `from.username` do dono e `from.id` de outra pessoa — TG-008.
 *
 * Username e **mutavel e sequestravel**: quem larga o seu, outra pessoa toma-o
 * minutos depois. Qualquer comparacao por username autoriza o sucessor.
 */
export function usernameSpoofMessage(realId: number, spoofedUsername: string, chatId: number): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    message: {
      message_id: 15,
      date: 1_700_000_000,
      from: user(realId, { username: spoofedUsername }),
      chat: chat(chatId, 'private'),
      text: '/desligar',
    },
  }
}

/**
 * Mensagem cujo `from.id` **nao e um numero** — TG-009.
 *
 * `"100000000000001" == 100000000000001` e `true` em JavaScript. Um `Set` de
 * numeros nao o contem, mas um `find` com `==` sim.
 *
 * ALCANCE EXACTO DESTE DUBLE, para nao prometer o que ele nao entrega: ele prova
 * que **`decideUpdate` nao aceita um id nao numerico** — e a recusa acontece em
 * `isTelegramId`, dentro de `finish()`, logo a string nunca CHEGA a
 * `Allowlist.has`. A estritez do proprio `has` (que e exportado, e que T4.2 e
 * T5.2 podem chamar directamente) e um teste SEPARADO em `allowlist.test.ts`,
 * que lhe passa a string a mao. Sao duas garantias distintas e precisam de dois
 * testes: sem o segundo, trocar o `Set` por uma busca com `==` nao partia nada.
 */
export function nonNumericIdMessage(rawId: unknown, chatId: unknown): Record<string, unknown> {
  return {
    update_id: bumpUpdateId(),
    message: {
      message_id: 16,
      date: 1_700_000_000,
      from: user(rawId),
      chat: chat(chatId, 'private'),
      text: '/desligar',
    },
  }
}

/** `/parear <codigo>` em DM. O caminho de PAIR-002..PAIR-009. */
export function pairCommand(id: number, code: string): Record<string, unknown> {
  return dmMessage(id, `/parear ${code}`)
}

/** `/parear@nome_do_bot <codigo>` — a forma que o cliente monta em GRUPO. */
export function pairCommandInGroup(fromId: number, chatId: number, code: string): Record<string, unknown> {
  return groupMessage(fromId, chatId, `/parear@dsh_guard_bot ${code}`)
}

/** `/start` — boas-vindas inocuo. **Nao pareia ninguem** (PAIR-006, D8). */
export function startCommand(id: number, payload = ''): Record<string, unknown> {
  return dmMessage(id, payload.length === 0 ? '/start' : `/start ${payload}`)
}
