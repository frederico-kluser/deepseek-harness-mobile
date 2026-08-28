/**
 * `worker/providers/discord/parse.ts` — a traducao do payload do gateway para
 * o {@link SurfaceEvent} neutro. Port do `parse.test.ts` do telegram para a
 * forma do Discord.
 *
 * Cobre: D4 (snowflakes STRING na fronteira — um id > 2^53 atravessa byte a
 * byte; nunca `Number(...)`), TG-027 (answerTarget SEMPRE nos cliques), TG-089
 * (descartado e contado), S5 (token OPACO — nunca validado, nunca forjado), a
 * gramatica `g1:<acao>:<token>` com teto de 100 bytes, e a superficie nao
 * accionavel (READY/RESUMED/HEARTBEAT_ACK/MESSAGE_UPDATE) ignorada sem
 * excecao (TG-012..015).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SurfaceEvent } from '../../../../../worker/surface/contract.ts'
import {
  buildCustomId,
  CUSTOM_ID_MAX_BYTES,
  criarParse,
  lerAnswerTarget,
  montarAnswerTarget,
  parseCustomId,
  utf8Bytes,
} from '../../../../../worker/providers/discord/parse.ts'
import {
  fakeDispatchOutro,
  fakeHeartbeatAck,
  fakeInteractionCreate,
  fakeMessageCreate,
  fakeReady,
  fakeResumed,
  GUILD_ID,
  OWNER_CHANNEL,
  OWNER_SNOWFLAKE,
} from '../../../../support/fixtures/discord/updates.ts'

describe('provider/discord/parse — comando (MESSAGE_CREATE)', () => {
  it('mensagem de DM vira SurfaceCommandEvent com os dois eixos STRING', () => {
    const { mapear } = criarParse()
    const e = mapear(fakeMessageCreate({ content: '/status' }))
    assert.equal(e?.kind, 'comando')
    const comando = e as Extract<SurfaceEvent, { kind: 'comando' }>
    assert.equal(comando.identity.userKey, OWNER_SNOWFLAKE)
    assert.equal(comando.identity.chatKey, OWNER_CHANNEL)
    assert.equal(comando.text, '/status')
  })

  it('mensagem de GUILD tambem vira comando (chatKey e o channel_id, nao o guild_id)', () => {
    const { mapear } = criarParse()
    const e = mapear(fakeMessageCreate({ content: 'ola', guildId: GUILD_ID }))
    assert.equal(e?.kind, 'comando')
    const comando = e as Extract<SurfaceEvent, { kind: 'comando' }>
    assert.equal(comando.identity.userKey, OWNER_SNOWFLAKE)
    assert.equal(comando.identity.chatKey, OWNER_CHANNEL)
  })

  it('userKey e chatKey sao sempre STRINGS (D4) — o snowflake gigante atravessa byte a byte', () => {
    const { mapear } = criarParse()
    const e = mapear(fakeMessageCreate({ content: '/ligar' })) as Extract<SurfaceEvent, { kind: 'comando' }>
    assert.equal(typeof e.identity.userKey, 'string')
    assert.equal(e.identity.userKey, OWNER_SNOWFLAKE)
    // 1057992969437413409 > Number.MAX_SAFE_INTEGER: o cast numerico perderia
    // o valor (arredondaria para ...400). A string e o formato certo.
    assert.equal(String(Number(OWNER_SNOWFLAKE)), '1057992969437413400')
  })

  it('mensagem sem author/channel_id ou sem texto e descartada (contada, TG-089)', () => {
    const { mapear, descartados } = criarParse()
    assert.equal(mapear(fakeMessageCreate({ content: '' })), undefined)
    assert.equal(mapear({ op: 0, t: 'MESSAGE_CREATE', s: 1, d: { id: 'x', channel_id: OWNER_CHANNEL, content: 'oi' } }), undefined)
    assert.equal(descartados(), 2)
  })
})

describe('provider/discord/parse — clique bem formado (INTERACTION_CREATE)', () => {
  it('botao com g1:<acao>:<token> vira SurfaceActionEvent com answerTarget e messageTarget', () => {
    const { mapear } = criarParse()
    const evento = mapear(fakeInteractionCreate({ customId: 'g1:tunnel.up:ABCxyz-123' }))
    assert.equal(evento?.kind, 'acao')
    const acao = evento as Extract<SurfaceEvent, { kind: 'acao' }>
    assert.equal(acao.action, 'tunnel.up')
    assert.equal(acao.token, 'ABCxyz-123') // OPACO (S5): transporta, nao valida
    assert.equal(acao.messageTarget, '1300112233445566778')
    assert.equal(acao.identity.userKey, OWNER_SNOWFLAKE)
    assert.equal(acao.identity.chatKey, OWNER_CHANNEL)
    // TG-027: o answerTarget carrega o PAR (interactionId, interactionToken).
    const alvo = lerAnswerTarget(acao.answerTarget)
    assert.deepEqual(alvo, {
      interactionId: '1300223344556677889',
      interactionToken: 'interacao-token-sintetico',
    })
  })

  it('clique em GUILD le o user de member.user (o par answerTarget vem igual)', () => {
    const { mapear } = criarParse()
    const evento = mapear(fakeInteractionCreate({ inGuild: true, customId: 'g1:menu:tok' }))
    assert.equal(evento?.kind, 'acao')
    const acao = evento as Extract<SurfaceEvent, { kind: 'acao' }>
    assert.equal(acao.identity.userKey, OWNER_SNOWFLAKE)
  })

  it('o token viaja TAL QUAL foi emitido — nunca alterado nem validado (S5)', () => {
    const { mapear } = criarParse()
    const token = 'someHostnonceXyz'
    const evento = mapear(fakeInteractionCreate({ customId: `g1:secret.rotate:${token}` })) as Extract<
      SurfaceEvent,
      { kind: 'acao' }
    >
    assert.equal(evento.token, token)
  })
})

describe('provider/discord/parse — clique malformado (TG-027 + S5)', () => {
  it('custom_id fora da gramatica morre, com answerTarget SEMPRE e SEM action/token forjados', () => {
    const { mapear } = criarParse()
    const evento = mapear(fakeInteractionCreate({ customId: 'srv:off:v1' }))
    assert.equal(evento?.kind, 'acao-invalida')
    const rejeitado = evento as Extract<SurfaceEvent, { kind: 'acao-invalida' }>
    assert.ok(lerAnswerTarget(rejeitado.answerTarget) !== undefined, 'TG-027: o nucleo responde sempre')
    assert.ok(rejeitado.reason !== undefined)
    assert.equal('action' in rejeitado, false, 'NUNCA forjar action (S5)')
    assert.equal('token' in rejeitado, false, 'NUNCA forjar token (S5)')
  })

  it('interacao sem identidade (sem user/member) nao forja identidade — mas responde', () => {
    const { mapear } = criarParse()
    const d = {
      id: '1300223344556677889',
      type: 3,
      token: 'tok',
      channel_id: OWNER_CHANNEL,
      message: { id: '1300112233445566778', channel_id: OWNER_CHANNEL },
      data: { custom_id: 'g1:tunnel.up:abc', component_type: 2 },
    }
    const evento = mapear({ op: 0, t: 'INTERACTION_CREATE', s: 11, d })
    assert.equal(evento?.kind, 'acao-invalida')
    const rejeitado = evento as Extract<SurfaceEvent, { kind: 'acao-invalida' }>
    assert.ok(lerAnswerTarget(rejeitado.answerTarget) !== undefined)
    assert.equal(rejeitado.identity, undefined, 'sem eixos nao ha identidade para forjar')
  })

  it('interacao sem id OU sem token nao existe na API — fail-closed, descartada', () => {
    const { mapear, descartados } = criarParse()
    const semId = fakeInteractionCreate({ interactionId: 'x' })
    ;(semId.d as Record<string, unknown>)['id'] = undefined
    assert.equal(mapear(semId), undefined)
    const semToken = fakeInteractionCreate({})
    ;(semToken.d as Record<string, unknown>)['token'] = undefined
    assert.equal(mapear(semToken), undefined)
    assert.equal(descartados(), 2)
  })

  it('slash command (type 2) e select (component_type != 2) nao sao superficie de botao', () => {
    const { mapear, descartados } = criarParse()
    const slash = fakeInteractionCreate({})
    ;(slash.d as Record<string, unknown>)['type'] = 2
    assert.equal(mapear(slash), undefined)
    const select = fakeInteractionCreate({})
    ;((select.d as Record<string, unknown>)['data'] as Record<string, unknown>)['component_type'] = 3
    assert.equal(mapear(select), undefined)
    assert.equal(descartados(), 2)
  })
})

describe('provider/discord/parse — superficie nao accionavel', () => {
  it('READY/RESUMED/HEARTBEAT_ACK/outros dispatches -> undefined, sem excecao (TG-012..015)', () => {
    const { mapear, descartados } = criarParse()
    assert.equal(mapear(fakeReady()), undefined)
    assert.equal(mapear(fakeResumed()), undefined)
    assert.equal(mapear(fakeHeartbeatAck()), undefined)
    assert.equal(mapear(fakeDispatchOutro()), undefined)
    assert.equal(mapear({ op: 2, d: { token: 'x' } }), undefined, 'identify nao e superficie')
    assert.equal(mapear(null), undefined)
    assert.equal(mapear('nao-objecto'), undefined)
    // READY + RESUMED + MESSAGE_UPDATE contam (dispatches ignorados); o
    // HEARTBEAT_ACK (op 11) e o identify (op 2) sao protocolo, nao superficie.
    assert.equal(descartados(), 5, 'TG-089: descartado e contado')
  })
})

describe('provider/discord/parse — gramatica do custom_id (g1:<acao>:<token>)', () => {
  it('buildCustomId monta e parseCustomId le a forma (o token viaja opaco)', () => {
    const data = buildCustomId('tunnel.up', 'nonceABC')
    assert.equal(data, 'g1:tunnel.up:nonceABC')
    assert.deepEqual(parseCustomId(data), { ok: true, action: 'tunnel.up', token: 'nonceABC' })
  })

  it('estouro dos 100 BYTES falha ALTO na construcao (TG-026)', () => {
    assert.throws(() => buildCustomId('secret.rotate', 'x'.repeat(200)), /limite 100/u)
  })

  it('token vazio ou fora do alfabeto base64url recusa na construcao e no parse (S5: a forma sim, o valor nao)', () => {
    assert.throws(() => buildCustomId('menu', ''), /sem token/u)
    assert.throws(() => buildCustomId('menu', 'tem:separador'), /fora do alfabeto/u)
    assert.equal(parseCustomId('g1:menu:').ok, false, 'sem token, rejeitado')
    assert.equal(parseCustomId('g1:menu:sem separador').ok, false)
    assert.equal(parseCustomId('srv:off:v1').ok, false, 'TG-025: payload administrativo morre no parser')
    assert.equal(parseCustomId('g1:acao-desconhecida:tok').ok, false)
  })

  it('o teto e medido em BYTES, nao caracteres', () => {
    assert.equal(CUSTOM_ID_MAX_BYTES, 100)
    const comAcento = buildCustomId('menu', 't'.repeat(90))
    assert.ok(utf8Bytes(comAcento) <= CUSTOM_ID_MAX_BYTES)
    assert.equal(utf8Bytes('á'), 2, 'um acento vale 2 bytes')
  })

  it('o answerTarget e um par JSON round-trip (D4: string unica, sem separadores no token)', () => {
    const alvo = montarAnswerTarget({ interactionId: '1300', interactionToken: 'tok' })
    assert.deepEqual(lerAnswerTarget(alvo), { interactionId: '1300', interactionToken: 'tok' })
    assert.equal(lerAnswerTarget('lixo'), undefined)
    assert.equal(lerAnswerTarget('{"i":1,"t":"x"}'), undefined, 'campos tem de ser strings')
  })
})
