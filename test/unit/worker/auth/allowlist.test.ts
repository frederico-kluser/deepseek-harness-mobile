/**
 * `worker/auth/allowlist.ts` — a matriz TG-001..TG-016 de `04-TESTES.md`, que o
 * documento chama de **o teste de seguranca mais importante do projeto**.
 *
 * Sem allowlist, `t.me/seu_bot` e um endpoint publico de administracao: qualquer
 * pessoa que descubra o nome do bot executa `/desligar`. Cada caso abaixo e um
 * modo de falha REAL, e a maioria e invisivel em teste manual porque **em DM
 * `from.id` e `chat.id` sao o mesmo numero**.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  ACTIONABLE_SURFACES,
  createAllowlist,
  decideUpdate,
  detectSurface,
  EMPTY_ALLOWLIST,
  isTelegramId,
  WorkerAuthError,
  type Allowlist,
  type UpdateVerdict,
} from '../../../../worker/auth/allowlist.ts'
import {
  callbackQuery,
  channelPost,
  chatMemberUpdate,
  dmMessage,
  editedMessage,
  futureUpdate,
  GROUP,
  groupMessage,
  inlineQuery,
  MAX_52_BIT_ID,
  MAX_52_BIT_ID_TRUNCATED_TO_INT32,
  nonNumericIdMessage,
  OTHER_GROUP,
  OWNER,
  STRANGER,
  usernameSpoofMessage,
} from '../../../support/fixtures/telegram/updates.ts'

/** A configuracao real depois do pareamento: o dono, e o grupo onde ele opera. */
const paired = createAllowlist([OWNER, GROUP])

function decide(update: unknown, allowlist: Allowlist = paired): UpdateVerdict {
  return decideUpdate(update, { allowlist })
}

/** Assere negacao E o motivo. O motivo e metade do controlo: "descartado em
 *  silencio **e contado**" exige saber o que contar. */
function assertDenied(verdict: UpdateVerdict, reason: string, message?: string): void {
  // `assert.equal` de `node:assert/strict` tem assinatura de asercao
  // (`asserts actual is T`), logo o compilador estreita `verdict` para o ramo de
  // negacao a partir daqui -- e `verdict.reason` le-se sem ternario nenhum.
  assert.equal(verdict.outcome, 'deny', message ?? `esperava negacao, veio ${verdict.outcome}`)
  assert.equal(verdict.reason, reason, message)
}

// ---------------------------------------------------------------------------

describe('createAllowlist -- default DENY e falha alta na configuracao', () => {
  it('TG-007: allowlist VAZIA nega tudo, INCLUSIVE o dono', () => {
    // A mesma semantica de `trustedRemotes: []` que o plugin ja implementa. Um
    // bot por parear e um bot INERTE, nao um bot permissivo -- se a lista vazia
    // aceitasse, a janela entre "o bot existe" e "o pareamento aconteceu" seria
    // administracao aberta a internet.
    assert.equal(EMPTY_ALLOWLIST.size, 0)
    assertDenied(decide(dmMessage(OWNER), EMPTY_ALLOWLIST), 'deny:not-configured')
    assertDenied(decide(callbackQuery({ from: OWNER, chat: OWNER }), EMPTY_ALLOWLIST), 'deny:not-configured')
    assertDenied(decide(groupMessage(OWNER, GROUP), EMPTY_ALLOWLIST), 'deny:not-configured')
  })

  it('recusa id que nao e inteiro seguro, em vez de o guardar como entrada morta', () => {
    // Guardar silenciosamente daria uma allowlist mais ESTREITA do que o
    // operador julga, com sintoma ("o bot nao me responde") indistinguivel de um
    // bug de rede. Nenhum caminho de erro deste plano termina em "finge que esta
    // bem".
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53, '100000000000001']) {
      assert.throws(
        () => createAllowlist([bad as number]),
        (error: unknown) => error instanceof WorkerAuthError && error.code === 'ALLOWLIST_INVALID_ID',
        `deveria recusar ${String(bad)}`,
      )
    }
  })

  it('ACHADO 4 -- `has` e ESTRITO: a string que coerciona para um id listado nao entra', () => {
    // TG-009 prova a estritez de `isTelegramId` dentro de `decideUpdate`, logo a
    // string nunca CHEGA a `has` por esse caminho. Mas `Allowlist` e exportado:
    // qualquer chamador futuro (T4.2, T5.2) pode consultar `has` directamente, e
    // ai a estritez tem de valer por si. Sem este teste, trocar o `Set` por uma
    // busca com `==` deixava a suite inteira verde.
    const list = createAllowlist([OWNER])

    assert.equal(list.has('100000000000001' as unknown as number), false, 'a string coerciona para OWNER, e nao pode passar')
    assert.equal(list.has(Number('100000000000001')), true, 'o mesmo valor, mas numero, passa')
    for (const frouxo of [true, null, undefined, [OWNER], { valueOf: () => OWNER }, `${OWNER}`]) {
      assert.equal(list.has(frouxo as unknown as number), false, `${String(frouxo)} nao pode passar`)
    }
  })

  it('copia os ids: mutar o array de origem depois nao alarga a allowlist', () => {
    const source = [OWNER]
    const list = createAllowlist(source)
    source.push(STRANGER)
    assert.equal(list.has(STRANGER), false, 'um controlo que o chamador alarga por acidente nao e um controlo')
    assert.equal(list.size, 1)
  })
})

describe('isTelegramId -- 52 bits significativos, e o sinal faz parte do numero', () => {
  it('TG-010/TG-011: aceita 2^52-1 e aceita negativos; recusa string, NaN e >2^53', () => {
    assert.equal(isTelegramId(MAX_52_BIT_ID), true)
    assert.equal(isTelegramId(GROUP), true, 'supergrupo tem id negativo, e isso e normal')
    assert.equal(isTelegramId('100000000000001'), false, 'string nunca -- evita `==` frouxo')
    assert.equal(isTelegramId(Number.NaN), false)
    assert.equal(isTelegramId(2 ** 53), false, 'acima de 2^53 a igualdade deixa de ser fiavel')
    assert.equal(isTelegramId(10n as unknown), false, 'bigint nao e number; converter aqui seria coercao silenciosa')
  })
})

// ---------------------------------------------------------------------------

describe('decideUpdate -- os DOIS eixos, sempre', () => {
  it('TG-001: OWNER em DM e aceite', () => {
    const verdict = decide(dmMessage(OWNER))
    assert.equal(verdict.outcome, 'accept')
    assert.deepEqual(verdict.identity, { from: OWNER, chat: OWNER, surface: 'message' })
  })

  it('TG-002: STRANGER em DM e negado, e a decisao nao tem efeito colateral nenhum', () => {
    const update = dmMessage(STRANGER)
    const before = structuredClone(update)

    const first = decide(update)
    const second = decide(update)

    assertDenied(first, 'deny:not-allowlisted')
    assert.deepEqual(second, first, 'a decisao e pura: mesma entrada, mesmo veredito')
    assert.deepEqual(update, before, 'o update de entrada NAO pode ser mutado')
    // Nao ha resposta, nao ha mensagem, nao ha campo de saida para o Telegram:
    // o veredito e so um veredito. Quem responde e quem conta esta noutra camada.
    assert.equal(Object.hasOwn(first, 'reply'), false)
    assert.equal(Object.hasOwn(first, 'answer'), false)
  })

  it('TG-003 (*): callback_query de STRANGER sobre mensagem do bot EM GRUPO e negado', () => {
    // O caso decisivo. A mensagem foi enviada pelo bot no grupo autorizado,
    // portanto `chat.id` esta na lista. Quem validou SO `chat.id` esta furado:
    // num grupo, QUALQUER MEMBRO pode apertar o botao.
    const verdict = decide(callbackQuery({ from: STRANGER, chat: GROUP, data: 'g1:tunnel.down:Zm9vYmFyMDE' }))
    assertDenied(verdict, 'deny:not-allowlisted')
    assert.equal(verdict.outcome === 'deny' ? verdict.from : null, STRANGER)
    assert.equal(verdict.outcome === 'deny' ? verdict.chat : null, GROUP, 'o chat ESTAVA na lista; foi o `from` que salvou')
  })

  it('TG-004 (*): message SEM `from` (channel post) e negado -- ausencia e NEGACAO', () => {
    // A armadilha e `undefined === undefined`. Se a comparacao fosse
    // `update.message.from?.id === donoId` com `donoId` tambem por definir, um
    // channel post passava. Aqui a ausencia tem motivo proprio.
    const verdict = decide(channelPost(OWNER))
    assertDenied(verdict, 'deny:missing-from')
    assert.equal(verdict.outcome === 'deny' ? verdict.from : 'presente', undefined)

    // E mesmo com o chat do canal na allowlist, continua negado.
    assertDenied(decide(channelPost(GROUP), createAllowlist([OWNER, GROUP])), 'deny:missing-from')
  })

  it('TG-005: from=OWNER num grupo NAO listado e negado', () => {
    assertDenied(decide(groupMessage(OWNER, OTHER_GROUP)), 'deny:not-allowlisted')
  })

  it('TG-006: from=STRANGER no chat do OWNER e negado (o eixo invertido)', () => {
    assertDenied(decide(groupMessage(STRANGER, OWNER)), 'deny:not-allowlisted')
  })

  it('TG-008: `username` do dono com `from.id` de outra pessoa e negado', () => {
    // Username e MUTAVEL e SEQUESTRAVEL: quem larga o seu, outra pessoa toma-o
    // minutos depois. A allowlist e SO NUMERICA.
    const verdict = decide(usernameSpoofMessage(STRANGER, 'dono_legitimo', OWNER))
    assertDenied(verdict, 'deny:not-allowlisted')
  })

  it('TG-009: `from.id` como STRING e negado -- nada de `==` frouxo', () => {
    // Documenta a armadilha exacta: a string COERCIONA para o mesmo numero, logo
    // um `==` frouxo (ou um `find` com coercao) autorizaria este update.
    assert.equal(Number('100000000000001'), OWNER)
    assertDenied(decide(nonNumericIdMessage('100000000000001', '100000000000001')), 'deny:non-numeric-id')
    assertDenied(decide(nonNumericIdMessage(OWNER, '100000000000001')), 'deny:non-numeric-id')
    assertDenied(decide(nonNumericIdMessage(Number.NaN, OWNER)), 'deny:non-numeric-id')
  })

  it('TG-010 (*): id com 52 bits significativos e aceite SEM PERDA DE PRECISAO', () => {
    const list = createAllowlist([MAX_52_BIT_ID])
    const verdict = decide(dmMessage(MAX_52_BIT_ID), list)

    assert.equal(verdict.outcome, 'accept')
    const got = verdict.identity.from
    assert.equal(got, MAX_52_BIT_ID)
    // A prova de que nao passou por int32 em lado nenhum do caminho.
    assert.notEqual(got, MAX_52_BIT_ID_TRUNCATED_TO_INT32)
    assert.equal(String(got), '4503599627370495', 'ida e volta bit a bit')
  })

  it('TG-011: chat.id NEGATIVO de supergrupo e tratado como numero', () => {
    const verdict = decide(groupMessage(OWNER, GROUP))
    assert.equal(verdict.outcome, 'accept')
    assert.equal(verdict.identity.chat, GROUP)
    assert.equal(Math.sign(GROUP), -1, 'a fixture tem mesmo de ser negativa, senao o caso nao existe')
  })
})

// ---------------------------------------------------------------------------

describe('decideUpdate -- superficies que nunca podem executar comando', () => {
  it('TG-012: edited_message de STRANGER e negado POR IDENTIDADE', () => {
    // A ordem das guardas importa: identidade ANTES de superficie. Se fosse ao
    // contrario, o audit registava "superficie inerte" e o dono nunca sabia que
    // alguem desconhecido lhe bateu a porta.
    assertDenied(decide(editedMessage(STRANGER, OWNER)), 'deny:not-allowlisted')
  })

  it('TG-012: edited_message do PROPRIO OWNER tambem nao executa comando', () => {
    // A superficie esquecida: um comando accionado por EDICAO nao deixa rasto
    // legivel, porque o texto no ecra ja e o texto novo.
    assertDenied(decide(editedMessage(OWNER, OWNER)), 'deny:surface-not-actionable')
    assert.equal(ACTIONABLE_SURFACES.includes('edited_message'), false)
  })

  it('TG-013: my_chat_member e chat_member nunca executam comando', () => {
    for (const field of ['my_chat_member', 'chat_member'] as const) {
      assertDenied(decide(chatMemberUpdate(OWNER, GROUP, field)), 'deny:surface-not-actionable')
      assertDenied(decide(chatMemberUpdate(STRANGER, GROUP, field)), 'deny:not-allowlisted')
    }
  })

  it('TG-014: update de tipo desconhecido/futuro e ignorado SEM EXCECAO', () => {
    // A Bot API cresce sozinha. Lancar aqui transformaria uma novidade do
    // Telegram numa queda do worker -- e o worker morto e o tunel sem dono.
    assertDenied(decide(futureUpdate()), 'deny:unsupported-surface')

    const lixo: unknown[] = [null, undefined, 42, 'update', [], {}, { message: null }, { callback_query: 'x' }]
    for (const value of lixo) {
      assert.doesNotThrow(() => decide(value), `entrada ${String(value)} nao pode lancar`)
      assertDenied(decide(value), 'deny:unsupported-surface', `entrada ${String(value)}`)
    }
    assert.equal(detectSurface(undefined), 'unknown')
    assert.equal(detectSurface({ message: null }), 'unknown', '`typeof null === "object"` e a armadilha mais velha do JS')
  })

  it('TG-015: inline_query e channel_post sao negados', () => {
    // inline_query tem `from` mas nao acontece num chat: sem o segundo eixo, o
    // veredito e negacao -- nunca "meio autorizado".
    assertDenied(decide(inlineQuery(OWNER)), 'deny:missing-chat')
    assertDenied(decide(channelPost(OWNER)), 'deny:missing-from')
  })
})

// ---------------------------------------------------------------------------

describe('TG-016 (*) -- a mutacao: remover o ouvinte de allowlist tem de partir a suite', () => {
  /**
   * O corpus de negacoes que existem POR CAUSA da allowlist. Nao inclui
   * negacoes estruturais (sem `from`, superficie inerte): essas continuariam a
   * ser negadas mesmo sem allowlist nenhuma, e portanto nao matam o mutante.
   */
  const corpus: ReadonlyArray<readonly [string, unknown]> = [
    ['TG-002 estranho em DM', dmMessage(STRANGER)],
    ['TG-003 callback de estranho em grupo', callbackQuery({ from: STRANGER, chat: GROUP })],
    ['TG-005 dono em grupo nao listado', groupMessage(OWNER, OTHER_GROUP)],
    ['TG-006 estranho no chat do dono', groupMessage(STRANGER, OWNER)],
    ['TG-008 username do dono, id de outro', usernameSpoofMessage(STRANGER, 'dono_legitimo', OWNER)],
  ]

  it('o corpus e todo negado pelo codigo real', () => {
    for (const [label, update] of corpus) {
      assertDenied(decide(update), 'deny:not-allowlisted', label)
    }
  })

  it('MATA O MUTANTE: com a allowlist neutralizada, o corpus passa a ser aceite', () => {
    // Este e o teste que `04-TESTES.md` TG-016 pede. O mutante e literalmente
    // "o ouvinte de allowlist foi removido": uma lista que responde `true` a
    // tudo. Se um dia este teste ficar VERDE sem o `assert.notEqual` disparar, e
    // porque os casos acima deixaram de depender da allowlist -- ou seja, o gate
    // sumiu e ninguem viu.
    const mutante: Allowlist = { size: 1, has: () => true }

    let flipped = 0
    for (const [label, update] of corpus) {
      const real = decide(update)
      const mutated = decideUpdate(update, { allowlist: mutante })
      assert.equal(real.outcome, 'deny', label)
      if (mutated.outcome === 'accept') flipped += 1
    }
    assert.equal(flipped, corpus.length, 'TODO o corpus tem de virar quando a allowlist e neutralizada')
  })

  it('a decisao consulta os DOIS eixos, com os valores certos e nesta ordem', () => {
    // Prova directa de que nao ha `||` no lugar do `&&`, e de que os dois
    // numeros consultados sao mesmo `from` e `chat` -- e nao o mesmo id duas
    // vezes, que em DM seria indistinguivel.
    const consultados: number[] = []
    const espia: Allowlist = {
      size: 2,
      has: (id: number) => {
        consultados.push(id)
        return id === OWNER || id === GROUP
      },
    }

    decideUpdate(groupMessage(OWNER, GROUP), { allowlist: espia })
    assert.deepEqual(consultados, [OWNER, GROUP], 'os dois eixos, nesta ordem')

    consultados.length = 0
    decideUpdate(callbackQuery({ from: OWNER, chat: GROUP }), { allowlist: espia })
    assert.deepEqual(consultados, [OWNER, GROUP], 'em callback_query, `from` vem da consulta e `chat` da mensagem')
  })
})

// ---------------------------------------------------------------------------

/** Remove comentarios de linha e de bloco. O JSDoc FALA de username; o codigo nao pode USAR. */
function codeOnly(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/(^|\s)\/\/.*$/gmu, '$1')
}

describe('invariantes estruturais do modulo (perguntas 4 e 5 da revisao adversarial)', () => {
  const SOURCES = ['allowlist.ts', 'guard.ts', 'pairing.ts'] as const

  for (const file of SOURCES) {
    it(`${file}: nenhuma linha de CODIGO le \`username\``, () => {
      const url = new URL(`../../../../worker/auth/${file}`, import.meta.url)
      const code = codeOnly(readFileSync(url, 'utf8'))
      assert.equal(
        /\busername\b/u.test(code),
        false,
        'username e mutavel e sequestravel: nenhum caminho de autorizacao pode toca-lo',
      )
    })
  }
})
