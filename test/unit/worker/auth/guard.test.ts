/**
 * `worker/auth/guard.ts` — TG-024..TG-027 de `04-TESTES.md`, mais as invariantes
 * ESTRUTURAIS que a revisao adversarial de `03-ONDAS.md` pergunta em voz alta:
 *
 *   (3) O worker valida algum nonce localmente? **Se validar, e defeito.**
 *   (5) O `callback_data` e usado para decidir autorizacao nalgum ponto?
 *
 * As duas ultimas nao se provam a ler codigo — provam-se por comportamento, e e
 * o que a seccao final faz.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAllowlist, WorkerAuthError } from '../../../../worker/auth/allowlist.ts'
import {
  buildCallbackData,
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_SCHEMA,
  createIdentityGuard,
  INCREASES_EXPOSURE,
  parseCallbackData,
  utf8Bytes,
  type GuardDecision,
} from '../../../../worker/auth/guard.ts'
import {
  callbackQuery,
  dmMessage,
  GROUP,
  groupMessage,
  OWNER,
  STRANGER,
} from '../../../support/fixtures/telegram/updates.ts'

const paired = createAllowlist([OWNER, GROUP])
const guard = (): ReturnType<typeof createIdentityGuard> => createIdentityGuard({ allowlist: paired })

/** Um token com a forma do nonce do host: `randomBytes(8).toString('base64url')`. */
const TOKEN = 'Zm9vYmFyMDE'

function assertDiscarded(decision: GuardDecision, reason: string): void {
  // `assert.equal` de `node:assert/strict` estreita o tipo (`asserts actual is T`).
  assert.equal(decision.kind, 'discarded', `esperava descarte, veio ${decision.kind}`)
  assert.equal(decision.reason, reason)
}

// ---------------------------------------------------------------------------

describe('buildCallbackData -- TG-026: o estouro dos 64 BYTES falha em TESTE, nao em producao', () => {
  it('constroi a forma canonica e cabe folgado no caso real', () => {
    const data = buildCallbackData('tunnel.up', TOKEN)
    assert.equal(data, `${CALLBACK_SCHEMA}:tunnel.up:${TOKEN}`)
    assert.ok(utf8Bytes(data) <= CALLBACK_DATA_MAX_BYTES)
    assert.equal(utf8Bytes(data), 24, 'o orcamento real gasta 24 dos 64 bytes')
  })

  it('TG-026: recusa a construcao acima de 64 BYTES', () => {
    // O sintoma em producao seria uma chamada a `sendMessage` recusada pela Bot
    // API no exacto momento em que o dono precisa do teclado. Um `catch` que
    // "enviasse sem botao" transformaria o defeito num silencio.
    const enorme = 'A'.repeat(64)
    assert.throws(
      () => buildCallbackData('tunnel.up', enorme),
      (error: unknown) => error instanceof WorkerAuthError && error.code === 'CALLBACK_DATA_TOO_LONG',
    )
  })

  it('TG-026 na SAIDA: fechado por CONSTRUCAO, nao por medicao -- e a nota e deliberada', () => {
    // >>> NOTA HONESTA, e o teste existe para a sustentar.
    // Trocar `utf8Bytes(...)` por `.length` dentro de `buildCallbackData` NAO
    // parte nada, e isso nao e um buraco de cobertura: e um MUTANTE
    // EQUIVALENTE. O alfabeto do token e base64url e o vocabulario de accoes e
    // fechado -- ambos ASCII puro -- logo, para todo o input que esta funcao
    // ACEITA, bytes e caracteres coincidem. Fuzz de 200 000 tokens: 170 003
    // aceites, ZERO divergencias.
    //
    // A medicao em bytes fica na mesma, por duas razoes: (a) o mesmo helper
    // corre no PARSER, onde a entrada vem do cliente e nao e ASCII -- e la o
    // mutante MORRE, no teste seguinte; (b) se alguem alargar o alfabeto um dia,
    // a medicao certa ja esta no sitio.
    //
    // O que se pode testar aqui e a PROPRIEDADE que fecha o caso: a guarda do
    // alfabeto dispara antes de o tamanho sequer importar.
    for (const naoAscii of ['ação', 'é'.repeat(40), 'ç', '🙂']) {
      assert.throws(
        () => buildCallbackData('tunnel.up', naoAscii),
        (error: unknown) => error instanceof WorkerAuthError && error.code === 'CALLBACK_DATA_EMPTY',
        `"${naoAscii}" tem de morrer no alfabeto, nao no tamanho`,
      )
    }
    for (const token of ['a', 'Zm9vYmFyMDE', '-_09azAZ', 'A'.repeat(49)]) {
      const data = buildCallbackData('tunnel.down', token)
      assert.equal(utf8Bytes(data), data.length, 'na saida, bytes e caracteres coincidem por construcao')
    }
  })

  it('TG-026 na ENTRADA: o parser mede BYTES, e AQUI o mutante morre', () => {
    // A entrada do parser vem do CLIENTE e nao tem alfabeto garantido. 40
    // caracteres acentuados sao 80 bytes: uma validacao por `.length` aprova
    // (40 <= 64) e so descobre o problema mais a frente, com outro veredito.
    const acentuado = 'é'.repeat(40)
    assert.equal(acentuado.length, 40)
    assert.equal(utf8Bytes(acentuado), 80, 'um acento consome 2 bytes')
    assert.ok(utf8Bytes(acentuado) > CALLBACK_DATA_MAX_BYTES)

    const parse = parseCallbackData(acentuado)
    assert.equal(parse.ok, false)
    // Com `.length` no lugar de `utf8Bytes`, este veredito seria
    // 'deny:callback-data-unknown-schema' -- a negacao acontecia na mesma, mas o
    // audit passava a mentir sobre O QUE chegou. O vocabulario de motivos e
    // contrato: e por ele que o dono distingue "payload gigante" de "formato
    // errado".
    assert.equal(parse.reason, 'deny:callback-data-too-long')

    // E com o esquema certo mas token acentuado: 43 caracteres, 73 bytes.
    const comEsquema = `${CALLBACK_SCHEMA}:tunnel.up:${'é'.repeat(30)}`
    assert.equal(comEsquema.length, 43)
    assert.equal(utf8Bytes(comEsquema), 73)
    const parse2 = parseCallbackData(comEsquema)
    assert.equal(parse2.ok, false)
    assert.equal(parse2.reason, 'deny:callback-data-too-long')
  })

  it('recusa token vazio e token com separador dentro', () => {
    // Um `:` dentro do token partiria o parser em quatro partes e a gramatica
    // deixaria de ser determinista.
    assert.throws(() => buildCallbackData('tunnel.down', ''), WorkerAuthError)
    assert.throws(() => buildCallbackData('tunnel.down', 'abc:def'), WorkerAuthError)
  })
})

// ---------------------------------------------------------------------------

describe('parseCallbackData -- forma, nunca valor', () => {
  it('TG-025: `srv:off:v1` -- payload administrativo DIRECTO -- e recusado', () => {
    // O formato que circulou nos spikes, e que um cliente modificado manda a
    // vontade. Nao tem o prefixo de esquema deste bot: morre no parser, antes de
    // qualquer accao.
    const parse = parseCallbackData('srv:off:v1')
    assert.equal(parse.ok, false)
    assert.equal(parse.reason, 'deny:callback-data-unknown-schema')
  })

  it('recusa accao fora do vocabulario fechado do contrato IPC', () => {
    assert.equal(parseCallbackData(`${CALLBACK_SCHEMA}:server.wipe:${TOKEN}`).ok, false)
    // `in` percorreria o prototipo e `constructor` responderia `true`.
    assert.equal(parseCallbackData(`${CALLBACK_SCHEMA}:constructor:${TOKEN}`).ok, false)
    assert.equal(parseCallbackData(`${CALLBACK_SCHEMA}:toString:${TOKEN}`).ok, false)
  })

  it('recusa accao conhecida SEM token -- seria comando administrativo numa etapa', () => {
    const parse = parseCallbackData(`${CALLBACK_SCHEMA}:tunnel.down:`)
    assert.equal(parse.ok, false)
    assert.equal(parse.reason, 'deny:callback-data-missing-token')
  })

  it('recusa partes a mais: uma gramatica que aceita "e o resto" deixa o resto ao atacante', () => {
    assert.equal(parseCallbackData(`${CALLBACK_SCHEMA}:tunnel.down:${TOKEN}:extra`).ok, false)
  })

  it('recusa ausencia, tipo errado e estouro de bytes', () => {
    for (const bad of [undefined, null, 42, '', {}]) {
      assert.equal(parseCallbackData(bad).ok, false, `deveria recusar ${String(bad)}`)
    }
    assert.equal(parseCallbackData(`${CALLBACK_SCHEMA}:tunnel.down:${'A'.repeat(64)}`).ok, false)
  })

  it('a tabela de exposicao cobre TODO o vocabulario do contrato congelado', () => {
    // Se `IpcIntentName` ganhar uma intencao nova, `INCREASES_EXPOSURE` deixa de
    // compilar e alguem e OBRIGADO a decidir se ela aumenta exposicao. Aqui so
    // se assere a assimetria que `02-SEGURANCA.md` 7.3 exige.
    assert.deepEqual(INCREASES_EXPOSURE, {
      'tunnel.up': true,
      'tunnel.down': false,
      'tunnel.status': false,
      'session.issue': true,
      'secret.rotate': true,
      emergency: false,
    })
    assert.equal(INCREASES_EXPOSURE['emergency'], false, 'em panico, o botao tem de funcionar a primeira')
  })
})

// ---------------------------------------------------------------------------

describe('createIdentityGuard -- revalidacao de identidade em TODO callback_query', () => {
  it('caminho feliz: OWNER em DM com data bem formado e encaminhado, token OPACO', () => {
    const decision = guard().admit(
      callbackQuery({ from: OWNER, chat: OWNER, data: buildCallbackData('tunnel.up', TOKEN) }),
    )
    assert.equal(decision.kind, 'callback')
    assert.equal(decision.action, 'tunnel.up')
    assert.equal(decision.token, TOKEN, 'o token viaja BYTE A BYTE; o worker nao o interpreta')
    assert.equal(decision.increasesExposure, true)
    assert.equal(decision.identity.from, OWNER)
  })

  it('TG-024: token bem formado apresentado por OUTRO from.id e REJEITADO', () => {
    // A ligacao nonce<->emissor e validada no HOST (S5). O que o worker garante,
    // e que e o que TG-024 mede aqui, e que um `callback_query` de outra
    // identidade **nunca chega a ser encaminhado** -- portanto o host nem sequer
    // ve o token para ter de o recusar.
    const g = guard()
    const forjado = callbackQuery({ from: STRANGER, chat: GROUP, data: buildCallbackData('tunnel.up', TOKEN) })

    const decision = g.admit(forjado)
    assertDiscarded(decision, 'deny:not-allowlisted')
    assert.equal(g.stats().admitted, 0, 'nenhum encaminhamento aconteceu')
    assert.equal(g.stats().discarded, 1)
  })

  it('TG-025: nenhum comando destrutivo e accionavel numa etapa', () => {
    const g = guard()
    // Identidade PERFEITA -- e o proprio dono, no proprio chat. O que falha e o
    // payload: veio de fora do fluxo e nao carrega token emitido pelo host.
    for (const data of ['srv:off:v1', 'tunnel.down', `${CALLBACK_SCHEMA}:tunnel.down`, `${CALLBACK_SCHEMA}:tunnel.down:`]) {
      const decision = g.admit(callbackQuery({ from: OWNER, chat: OWNER, data }))
      assert.equal(decision.kind, 'discarded', `\`${data}\` nao pode acionar nada`)
      assert.ok(decision.answer, 'TG-027 vale aqui tambem')
    }
    assert.equal(g.stats().admitted, 0)
    assert.equal(g.stats().discarded, 4)
  })

  it('TG-003 revisitado: em grupo, o membro que carrega no botao e revalidado', () => {
    const decision = guard().admit(
      callbackQuery({ from: STRANGER, chat: GROUP, data: buildCallbackData('tunnel.down', TOKEN) }),
    )
    assertDiscarded(decision, 'deny:not-allowlisted')
  })

  it('callback_query sem `message` (mensagem antiga) nao tem segundo eixo: negado', () => {
    const decision = guard().admit(
      callbackQuery({ from: OWNER, chat: OWNER, data: buildCallbackData('tunnel.down', TOKEN), withMessage: false }),
    )
    assertDiscarded(decision, 'deny:missing-chat')
  })

  it('mensagem de comando do OWNER passa como `command`, sem tocar em callback_data', () => {
    const decision = guard().admit(dmMessage(OWNER, '/status'))
    assert.equal(decision.kind, 'command')
    assert.equal(decision.identity.surface, 'message')
  })
})

// ---------------------------------------------------------------------------

describe('TG-027 -- `answerCallbackQuery` em TODOS os caminhos, inclusive na negacao', () => {
  it('a negacao responde ao protocolo e NAO diz nada ao utilizador', () => {
    // A tensao com "descartado em silencio" resolve-se separando protocolo de
    // conteudo: o `answerCallbackQuery` para o girador; o `text` ausente e o que
    // nao da oraculo nenhum ao estranho.
    const decision = guard().admit(callbackQuery({ from: STRANGER, chat: GROUP }))
    assert.equal(decision.kind, 'discarded')
    assert.ok(decision.answer, 'sem resposta, o cliente fica com a barra de progresso a girar')
    assert.equal(decision.answer.callbackQueryId, '4382512721')
    assert.equal(decision.answer.text, undefined, 'nenhum texto: "nao autorizado" seria um oraculo')
    assert.equal(decision.answer.showAlert, false)
  })

  it('todos os caminhos de callback devolvem resposta -- aceite, identidade errada e data errado', () => {
    const g = guard()
    const caminhos = [
      callbackQuery({ from: OWNER, chat: OWNER, data: buildCallbackData('tunnel.down', TOKEN) }),
      callbackQuery({ from: STRANGER, chat: GROUP, data: buildCallbackData('tunnel.down', TOKEN) }),
      callbackQuery({ from: OWNER, chat: OWNER, data: 'srv:off:v1' }),
      callbackQuery({ from: OWNER, chat: OWNER, data: undefined }),
    ]
    for (const update of caminhos) {
      const decision = g.admit(update)
      const answer = decision.kind === 'callback' || decision.kind === 'discarded' ? decision.answer : undefined
      assert.ok(answer, `caminho sem answerCallbackQuery: ${JSON.stringify(decision.kind)}`)
      assert.equal(answer.callbackQueryId, '4382512721')
    }
  })

  it('sem `callback_query.id` nao ha como responder -- e por isso NAO se executa', () => {
    // Fail-closed. Uma accao que se executa sem poder responder e uma accao
    // invisivel; e um `callback_query` sem `id` nao existe na Bot API, logo ou e
    // forjado ou o parser esta errado.
    const decision = guard().admit(
      callbackQuery({ from: OWNER, chat: OWNER, id: undefined, data: buildCallbackData('tunnel.down', TOKEN) }),
    )
    assertDiscarded(decision, 'deny:callback-data-absent')
    assert.equal(decision.kind === 'discarded' ? decision.answer : 'x', undefined)
  })
})

// ---------------------------------------------------------------------------

describe('contagem -- descartado em silencio E CONTADO', () => {
  it('acumula por motivo, e o motivo e o que o relatorio ao dono usa', () => {
    const g = guard()
    g.admit(dmMessage(STRANGER))
    g.admit(dmMessage(STRANGER))
    g.admit(callbackQuery({ from: STRANGER, chat: GROUP }))
    g.admit(dmMessage(OWNER))

    const stats = g.stats()
    assert.equal(stats.discarded, 3)
    assert.equal(stats.admitted, 1)
    assert.equal(stats.byReason['deny:not-allowlisted'], 3)
    assert.equal(stats.byReason['ok'], 1)
  })

  it('toda decisao carrega a intencao de auditoria, e ela NUNCA carrega callback_data', () => {
    const g = guard()
    const decision = g.admit(callbackQuery({ from: STRANGER, chat: GROUP, data: 'g1:tunnel.up:SEGREDINHO' }))
    assert.equal(decision.kind, 'discarded')
    assert.deepEqual(decision.audit, {
      evento: 'telegram.update.descartado',
      resultado: 'negado',
      motivo: 'deny:not-allowlisted',
      surface: 'callback_query',
      from: STRANGER,
      chat: GROUP,
    })
    assert.equal(JSON.stringify(decision.audit).includes('SEGREDINHO'), false)
  })
})

// ---------------------------------------------------------------------------

describe('S5 -- o worker NAO valida nonce, e isto e o teste que o prova', () => {
  it('o MESMO callback_data e encaminhado DUAS vezes: nao ha uso unico local', () => {
    // ISTO NAO E UM DEFEITO. Uso unico, TTL e ligacao ao emissor sao decididos
    // no HOST (`src/control/confirm.ts`, T5.1). Um nonce validado no processo
    // que fala com a internet nao e um controlo, e uma variavel: cai junto com o
    // processo que ele deveria proteger.
    //
    // >>> SE ESTE TESTE FICAR VERMELHO, alguem acrescentou validacao de nonce ao
    // >>> worker e o controlo mudou de lado. A correccao e REMOVER essa
    // >>> validacao, nao ajustar este teste.
    const g = guard()
    const data = buildCallbackData('tunnel.up', TOKEN)

    const first = g.admit(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const second = g.admit(callbackQuery({ from: OWNER, chat: OWNER, data }))

    assert.equal(first.kind, 'callback')
    assert.equal(second.kind, 'callback')
    assert.equal(first.token, TOKEN)
    assert.equal(second.token, TOKEN)
  })

  it('o token e opaco: qualquer base64url passa a FORMA, e e o host que recusa o VALOR', () => {
    // A distincao que a revisao adversarial procura: verificar a FORMA nao e
    // validar o nonce. Um atacante fabrica 11 caracteres base64url sem esforco;
    // o que ele nao fabrica e a identidade do `from.id`, e nao ha nonce nenhum
    // aqui para ele adivinhar ou consumir.
    const decision = guard().admit(
      callbackQuery({ from: OWNER, chat: OWNER, data: `${CALLBACK_SCHEMA}:tunnel.up:AAAAAAAAAAA` }),
    )
    assert.equal(decision.kind, 'callback')
    assert.equal(decision.token, 'AAAAAAAAAAA')
  })

  it('o guard nao retem estado por accao: dois guards independentes decidem igual', () => {
    const data = buildCallbackData('secret.rotate', TOKEN)
    const a = guard().admit(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const b = guard().admit(callbackQuery({ from: OWNER, chat: OWNER, data }))
    assert.equal(a.kind, b.kind)
    assert.equal(a.kind === 'callback' ? a.token : 'a', b.kind === 'callback' ? b.token : 'b')
  })

  it('a autorizacao NAO vem do callback_data: mudar so o payload nao autoriza um estranho', () => {
    // Pergunta 5 da revisao adversarial, medida. O `callback_data` "perfeito"
    // nao move a agulha de um `from.id` fora da lista.
    const perfeito = buildCallbackData('tunnel.down', TOKEN)
    assertDiscarded(guard().admit(callbackQuery({ from: STRANGER, chat: GROUP, data: perfeito })), 'deny:not-allowlisted')
    assertDiscarded(guard().admit(callbackQuery({ from: STRANGER, chat: STRANGER, data: perfeito })), 'deny:not-allowlisted')
    assertDiscarded(guard().admit(groupMessage(STRANGER, GROUP)), 'deny:not-allowlisted')
  })
})
