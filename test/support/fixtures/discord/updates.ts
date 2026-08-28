/**
 * FABRICAS DE PAYLOADS DO GATEWAY DO DISCORD — dubles sinteticos para os
 * testes do adaptador (parse/teclado/gateway/adapter/e2e).
 *
 * Ficheiro sem sufixo `.test.ts`: nao e executado como suite.
 *
 * ===========================================================================
 * POR QUE A FORMA E A DO GATEWAY, NAO A DE UMA CLASSE
 * ===========================================================================
 * O JSON do gateway e `{op, t?, s?, d?}`; os ids (snowflakes) viajam como
 * STRINGS (o Discord serializa assim — um `Number(...)` > 2^53 truncaria).
 * As fabricas recebem os ids como string e devolvem objectos NOVOS (nenhum
 * estado partilhado entre testes).
 *
 * Os ids sao SINTETICOS e nao correspondem a contas reais. `OWNER_SNOWFLAKE`
 * (1057992969437413409) tem 50 bits — MUITO acima de 2^53/2 — e e o caso que
 * o envelope IPC V2 existe para preservar: tem de atravessar byte a byte.
 */

// ---------------------------------------------------------------------------
// Identidades
// ---------------------------------------------------------------------------

/** O dono: 1057992969437413409 > 2^53 — o caso que o V2 existe para preservar. */
export const OWNER_SNOWFLAKE = '1057992969437413409'

/** O estranho: vizinho do dono, para um bug de truncagem ser dificil de ver. */
export const STRANGER_SNOWFLAKE = '1057992969437413410'

/** O canal (DM) do dono. */
export const OWNER_CHANNEL = '112233445566778899'

/** Uma guild sintetica (o `guild_id` de MESSAGE_CREATE em servidor). */
export const GUILD_ID = '883322110099887766'

// ---------------------------------------------------------------------------
// Fabricas
// ---------------------------------------------------------------------------

/** Envolve QUALQUER payload num frame de gateway `{op, t?, s?, d?}`. */
export function frameDoGateway(payload: {
  readonly op: number
  readonly t?: string
  readonly s?: number
  readonly d?: unknown
}): Record<string, unknown> {
  return {
    op: payload.op,
    ...(payload.t === undefined ? {} : { t: payload.t }),
    ...(payload.s === undefined ? {} : { s: payload.s }),
    ...(payload.d === undefined ? {} : { d: payload.d }),
  }
}

/** O Hello (op 10) com o intervalo de heartbeat em ms. */
export function fakeHello({ heartbeatIntervalMs = 100_000, s = 0 } = {}): Record<string, unknown> {
  return frameDoGateway({ op: 10, s, d: { heartbeat_interval: heartbeatIntervalMs } })
}

/** O Ready (op 0, t=READY) com `session_id` (e resume_gateway_url opcional). */
export function fakeReady({
  sessionId = 'sessao-1',
  resumeUrl = 'ws://127.0.0.1:1/resume',
  s = 1,
} = {}): Record<string, unknown> {
  return frameDoGateway({
    op: 0,
    t: 'READY',
    s,
    d: { session_id: sessionId, resume_gateway_url: resumeUrl, user: { id: OWNER_SNOWFLAKE, username: 'bot' } },
  })
}

/** O RESUMED (op 0, t=RESUMED) — o arranque apos um resume com sucesso. */
export function fakeResumed({ s = 2 } = {}): Record<string, unknown> {
  return frameDoGateway({ op: 0, t: 'RESUMED', s, d: {} })
}

/** O HEARTBEAT_ACK (op 11). */
export function fakeHeartbeatAck(): Record<string, unknown> {
  return frameDoGateway({ op: 11 })
}

/** Um MESSAGE_CREATE de DM: `author.id` + `channel_id` + `content`. */
export function fakeMessageCreate({
  messageId = '1300112233445566778',
  channelId = OWNER_CHANNEL,
  authorId = OWNER_SNOWFLAKE,
  content = '/status',
  guildId,
  s = 10,
}: {
  messageId?: string
  channelId?: string
  authorId?: string
  content?: string
  guildId?: string
  s?: number
} = {}): Record<string, unknown> {
  return frameDoGateway({
    op: 0,
    t: 'MESSAGE_CREATE',
    s,
    d: {
      id: messageId,
      channel_id: channelId,
      author: { id: authorId, username: 'alguem' },
      content,
      ...(guildId === undefined ? {} : { guild_id: guildId }),
    },
  })
}

/** Um INTERACTION_CREATE de BOTAO (type 3, component_type 2). */
export function fakeInteractionCreate({
  interactionId = '1300223344556677889',
  interactionToken = 'interacao-token-sintetico',
  channelId = OWNER_CHANNEL,
  userId = OWNER_SNOWFLAKE,
  messageId = '1300112233445566778',
  customId = 'g1:tunnel.up:nonce-opaco',
  inGuild = false,
  s = 11,
}: {
  interactionId?: string
  interactionToken?: string
  channelId?: string
  userId?: string
  messageId?: string
  customId?: string
  inGuild?: boolean
  s?: number
} = {}): Record<string, unknown> {
  const user =
    inGuild
      ? { member: { user: { id: userId, username: 'alguem' } } }
      : { user: { id: userId, username: 'alguem' } }
  return frameDoGateway({
    op: 0,
    t: 'INTERACTION_CREATE',
    s,
    d: {
      id: interactionId,
      type: 3,
      token: interactionToken,
      channel_id: channelId,
      message: { id: messageId, channel_id: channelId },
      data: { custom_id: customId, component_type: 2 },
      ...user,
    },
  })
}

/** Um dispatch de tipo DESCONHECIDO (ex.: MESSAGE_UPDATE) — nao accionavel. */
export function fakeDispatchOutro({ t = 'MESSAGE_UPDATE', s = 12 } = {}): Record<string, unknown> {
  return frameDoGateway({ op: 0, t, s, d: { id: '1300' } })
}
