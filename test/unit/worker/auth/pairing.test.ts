/**
 * `worker/auth/pairing.ts` — PAIR-002..PAIR-010 de `04-TESTES.md`.
 *
 * O pareamento e a unica porta deste worker por onde um `from.id` DESCONHECIDO e
 * legitimamente processado — a allowlist, por definicao, nao o pode filtrar. E
 * por isso que o teto de tentativas vive aqui, e nao la.
 *
 * Relogio INJETADO em todos os casos: o TTL e de 5 minutos e nenhum teste espera
 * tempo real.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FakeClock } from '../../../support/clock.ts'
import {
  callbackQuery,
  dmMessage,
  editedMessage,
  GROUP,
  OTHER_GROUP,
  OWNER,
  pairCommand,
  pairCommandInGroup,
  startCommand,
  STRANGER,
} from '../../../support/fixtures/telegram/updates.ts'
import { WorkerAuthError } from '../../../../worker/auth/allowlist.ts'
import {
  createPairingChallenge,
  createPairingReceiver,
  DEFAULT_PAIRING_LIMITS,
  PAIRING_ALREADY_PAIRED_REPLY,
  PAIRING_REFUSAL_REPLY,
  PAIRING_WELCOME_REPLY,
  type PairingLimits,
  type PairingOutcome,
  type PairingReceiver,
} from '../../../../worker/auth/pairing.ts'

/** O codigo de 6 digitos que T4.1 gera no host e mostra SO no terminal. */
const CODE = '482913'
const TTL_MS = 5 * 60 * 1000
const T0 = 1_700_000_000_000

interface Bancada {
  readonly receiver: PairingReceiver
  readonly clock: FakeClock
}

function bancada(limits?: PairingLimits): Bancada {
  const clock = new FakeClock(T0)
  const challenge = createPairingChallenge(CODE, T0 + TTL_MS)
  return { receiver: createPairingReceiver({ challenge, clock, limits }), clock }
}

/**
 * Assinatura de ASERCAO (`asserts ... is`), e nao um `void`: assim o estreitamento
 * atravessa a chamada e o teste le `outcome.reply` sem ternario -- que e o que
 * permite asserir o SILENCIO, e nao so o `reason`.
 */
function assertRefused(
  outcome: PairingOutcome,
  reason: string,
): asserts outcome is Extract<PairingOutcome, { kind: 'refused' }> {
  assert.equal(outcome.kind, 'refused', `esperava recusa, veio ${outcome.kind}`)
  assert.equal(outcome.reason, reason)
}

// ---------------------------------------------------------------------------

describe('createPairingChallenge -- o codigo entra e nao sai', () => {
  it('recusa codigo fora da forma acordada com T4.1, sem o citar', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 456']) {
      assert.throws(
        () => createPairingChallenge(bad, T0 + TTL_MS),
        (error: unknown) => {
          if (!(error instanceof WorkerAuthError)) return false
          assert.equal(error.code, 'PAIRING_CHALLENGE_INVALID')
          // PAIR-010 vale ate na mensagem de erro do caso invalido.
          assert.equal(error.message.includes(bad) && bad.length > 0, false)
          return true
        },
      )
    }
  })

  it('verifica em tempo constante, e um candidato absurdo devolve `false` em vez de lancar', () => {
    const challenge = createPairingChallenge(CODE, T0 + TTL_MS)
    assert.equal(challenge.verify(CODE), true)
    assert.equal(challenge.verify('482914'), false)
    // Comparar digests de 32 bytes torna a comparacao TOTAL: `timingSafeEqual`
    // lanca `RangeError` com comprimentos diferentes, e ramificar no comprimento
    // vazaria o comprimento.
    assert.equal(challenge.verify(''), false)
    assert.equal(challenge.verify('x'.repeat(10_000)), false)
  })

  it('o desafio NAO retem o claro -- e a asercao tem de ver closures e propriedades escondidas', () => {
    // >>> PORQUE ISTO NAO E `JSON.stringify(challenge).includes(CODE)`.
    // Essa asercao e quase vazia: `JSON.stringify` OMITE funcoes por completo,
    // nao ve closures e nao ve propriedades nao enumeraveis. Duas mutacoes
    // triviais passavam por ela sem um teste vermelho:
    //   (1) `verify: (c) => c === code`  -- mata o tempo constante E ressuscita
    //       o claro numa closure viva;
    //   (2) `Object.defineProperty(obj, 'plaintext', { value: code,
    //       enumerable: false })` -- o claro vira propriedade do objecto.
    // As duas asercoes abaixo matam uma cada.
    const challenge = createPairingChallenge(CODE, T0 + TTL_MS)

    // (2): a superficie do objecto e EXACTAMENTE esta. Nada de contrabando.
    assert.deepEqual(Object.getOwnPropertyNames(challenge).toSorted(), ['expiresAt', 'verify'])
    for (const nome of Object.getOwnPropertyNames(challenge)) {
      assert.equal(String(Reflect.get(challenge, nome)).includes(CODE), false, `a propriedade ${nome} retem o codigo`)
    }

    // (1): o corpo de `verify` tem de comparar com `timingSafeEqual`. Uma
    // comparacao com `===` sobre o claro nao passa aqui.
    const corpo = String(challenge.verify)
    assert.ok(corpo.includes('timingSafeEqual'), `verify nao compara em tempo constante: ${corpo}`)
    assert.equal(corpo.includes(CODE), false)
  })
})

// ---------------------------------------------------------------------------

describe('PAIR-002 / TG-065 -- o codigo certo pareia, e grava os DOIS eixos', () => {
  it('grava `from.id` E `chat.id` do update que carrega o codigo correcto', () => {
    const { receiver, clock } = bancada()
    clock.advance(1_000)

    const outcome = receiver.receive(pairCommandInGroup(OWNER, GROUP, CODE))
    assert.equal(outcome.kind, 'paired')
    assert.deepEqual(outcome.owner, { from: OWNER, chat: GROUP, pairedAt: T0 + 1_000 })
    assert.deepEqual(receiver.state(), { status: 'fechado', owner: outcome.owner })
  })

  it('os ids saem do update CORRECTO, nunca do primeiro que chegou', () => {
    // TG-066: dois updates, um com codigo errado e outro com o certo. So o
    // segundo pareia -- e o dono e ele, nao quem chegou primeiro.
    const { receiver } = bancada()

    assertRefused(receiver.receive(pairCommand(STRANGER, '000000')), 'refuse:wrong-code')
    const ok = receiver.receive(pairCommand(OWNER, CODE))

    assert.equal(ok.kind, 'paired')
    assert.equal(ok.owner.from, OWNER)
    assert.notEqual(ok.owner.from, STRANGER)
  })

  it('so a superficie `message` pareia -- nem edicao, nem botao', () => {
    // Editar a mesma mensagem N vezes gera N updates e NENHUM deles aparece como
    // mensagem nova no ecra do dono: seria forca bruta dentro de um unico balao
    // de conversa.
    const { receiver } = bancada()
    assert.deepEqual(receiver.receive(editedMessage(STRANGER, STRANGER, `/parear ${CODE}`)), { kind: 'ignored' })
    assert.deepEqual(receiver.receive(callbackQuery({ from: STRANGER, chat: STRANGER, data: `/parear ${CODE}` })), {
      kind: 'ignored',
    })
    assert.deepEqual(receiver.state(), { status: 'aberto' })
  })

  it('ignora o que nao e comando de pareamento', () => {
    const { receiver } = bancada()
    assert.deepEqual(receiver.receive(dmMessage(OWNER, 'ola')), { kind: 'ignored' })
    assert.deepEqual(receiver.receive(dmMessage(OWNER, '/status')), { kind: 'ignored' })
    assert.deepEqual(receiver.receive(dmMessage(OWNER, '')), { kind: 'ignored' })
    assert.equal(receiver.stats().attempts, 0, 'o que nao e `/parear` nao gasta orcamento nenhum')
  })

  it('`/parear` SEM argumento responde SILENCIO, conta-se como SONDA e NAO gasta palpite', () => {
    // Nao basta asserir o `reason`. Interessam tres coisas, e cada uma tem o seu
    // porque:
    //   (a) SILENCIO -- e o que fecha o oraculo do estado do pareamento e o que
    //       impede o amplificador 1:1 contra o limite de 1 msg/s por chat;
    //   (b) conta como SONDA -- o dono precisa de ver que alguem anda a bater a
    //       porta;
    //   (c) NAO gasta palpite -- senao sondar vira o caminho mais barato para
    //       fechar o pareamento a toda a gente, sem adivinhar uma unica vez.
    const { receiver } = bancada()

    const outcome = receiver.receive(dmMessage(OWNER, '/parear'))

    assertRefused(outcome, 'refuse:malformed')
    assert.equal(outcome.reply, undefined, '(a) um comando sem palpite nao merece resposta nenhuma')
    assert.equal(outcome.audit.orcamento, 'sonda', '(b) o audit tem de dizer a QUE orcamento foi debitado')
    assert.equal(receiver.stats().probes, 1, '(b) contado')
    assert.equal(receiver.stats().attempts, 0, '(c) e ZERO palpites gastos')
    assert.ok(outcome.delayMs > 0, 'estrangulada na mesma, para o ciclo nao ser gratuito em CPU')
  })
})

// ---------------------------------------------------------------------------

describe('PAIR-003 -- codigo errado: nao pareia, e contado, e a resposta nao conta digitos', () => {
  it('a resposta e IDENTICA quer se acerte 0 quer se acerte 5 dos 6 digitos', () => {
    // Se a resposta variasse com a proximidade, 10^6 deixaria de ser o espaco de
    // busca: bastaria descer um digito de cada vez.
    const { receiver } = bancada()
    const zero = receiver.receive(pairCommand(STRANGER, '000000'))
    const quase = receiver.receive(pairCommand(STRANGER, '482910'))

    assertRefused(zero, 'refuse:wrong-code')
    assertRefused(quase, 'refuse:wrong-code')
    assert.equal(zero.reply, PAIRING_REFUSAL_REPLY)
    assert.equal(quase.reply, PAIRING_REFUSAL_REPLY)
    assert.equal(receiver.state().status, 'aberto')
  })

  it('a MESMA resposta serve codigo errado e codigo expirado -- e o malformado nao responde de todo', () => {
    // Um texto por caso seria um oraculo: "expirado" confirma que o codigo era
    // valido, so tarde. Os dois ramos que CARREGAM UM PALPITE partilham a mesma
    // constante. O ramo sem palpite (`/parear` seco) nao responde: nao ha nada
    // para lhe dizer que ele ja nao saiba, e responder-lhe seria um canal de
    // sondagem a mais.
    const a = bancada()
    const errado = a.receiver.receive(pairCommand(STRANGER, '000000'))

    const b = bancada()
    b.clock.advance(TTL_MS + 1)
    const expirado = b.receiver.receive(pairCommand(STRANGER, CODE))

    const c = bancada()
    const malformado = c.receiver.receive(pairCommand(STRANGER, ''))

    const replies = [errado, expirado, malformado].map((o) => (o.kind === 'refused' ? o.reply : 'NAO-RECUSADO'))
    assert.deepEqual(replies, [PAIRING_REFUSAL_REPLY, PAIRING_REFUSAL_REPLY, undefined])
  })

  it('e CONTADO', () => {
    const { receiver } = bancada()
    receiver.receive(pairCommand(STRANGER, '000000'))
    receiver.receive(pairCommand(STRANGER, '111111'))

    const stats = receiver.stats()
    assert.equal(stats.attempts, 2)
    assert.equal(stats.refused, 2)
    assert.equal(stats.byReason['refuse:wrong-code'], 2)
  })
})

// ---------------------------------------------------------------------------

describe('PAIR-004 -- TTL de 5 min, medido pelo relogio injetado', () => {
  it('um milissegundo antes pareia; no instante da expiracao, nao', () => {
    const dentro = bancada()
    dentro.clock.advance(TTL_MS - 1)
    assert.equal(dentro.receiver.receive(pairCommand(OWNER, CODE)).kind, 'paired')

    const fora = bancada()
    fora.clock.advance(TTL_MS)
    assertRefused(fora.receiver.receive(pairCommand(OWNER, CODE)), 'refuse:expired')
    assert.equal(fora.receiver.state().status, 'aberto')
  })

  it('rotacionar o desafio NAO devolve orcamento de tentativas ao atacante', () => {
    // Se os contadores fossem zerados a cada codigo novo, esperar pelo seguinte
    // daria tentativas de graca e o teto seria decorativo.
    const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, maxAttemptsPerChat: 2 }
    const { receiver, clock } = bancada(limits)

    receiver.receive(pairCommand(STRANGER, '000000'))
    receiver.receive(pairCommand(STRANGER, '111111'))
    assertRefused(receiver.receive(pairCommand(STRANGER, '222222')), 'refuse:rate-limited')

    clock.advance(TTL_MS + 1)
    receiver.rotateChallenge(createPairingChallenge('999999', clock.now() + TTL_MS))
    assertRefused(receiver.receive(pairCommand(STRANGER, '999999')), 'refuse:rate-limited')
  })
})

// ---------------------------------------------------------------------------

describe('PAIR-005 / PAIR-009 -- o SEGUNDO pareamento e recusado, sem excepcao', () => {
  it('PAIR-005: recusado mesmo com codigo valido e vindo do PROPRIO DONO', () => {
    const { receiver } = bancada()
    assert.equal(receiver.receive(pairCommand(OWNER, CODE)).kind, 'paired')

    const outra = receiver.receive(pairCommand(OWNER, CODE))
    assertRefused(outra, 'refuse:already-paired')
    // Ao dono, o caminho de recuperacao. E ele passa pela MAQUINA.
    assert.equal(outra.reply, PAIRING_ALREADY_PAIRED_REPLY)
    assert.ok(PAIRING_ALREADY_PAIRED_REPLY.includes('--reset-pairing'))
  })

  it('PAIR-005: a um estranho, o pareamento fechado responde SILENCIO', () => {
    // TG-089: nenhuma resposta confirma a existencia do bot a quem nao e dono.
    const { receiver } = bancada()
    receiver.receive(pairCommand(OWNER, CODE))

    const intruso = receiver.receive(pairCommand(STRANGER, CODE))
    assertRefused(intruso, 'refuse:already-paired')
    assert.equal(intruso.reply, undefined)
  })

  it('ACHADO 6 -- em GRUPO, a resposta de "ja pareado" exige os DOIS eixos', () => {
    // Em DM `from.id` e `chat.id` sao o MESMO numero, logo `isOwner` com `||` em
    // vez de `&&` passa despercebido em todos os outros testes deste ficheiro.
    // Aqui separam-se: o dono pareou NO GRUPO, e outro membro do MESMO grupo
    // manda `/parear`. Com `||`, esse membro receberia a mensagem que contem
    // `--reset-pairing` -- ou seja, o caminho de tomada de posse, entregue a
    // quem so precisava de estar na sala.
    const { receiver } = bancada()
    assert.equal(receiver.receive(pairCommandInGroup(OWNER, GROUP, CODE)).kind, 'paired')

    const membroDoGrupo = receiver.receive(pairCommandInGroup(STRANGER, GROUP, '000000'))
    assertRefused(membroDoGrupo, 'refuse:already-paired')
    assert.equal(membroDoGrupo.reply, undefined, 'o eixo `from` sozinho tem de bastar para calar a resposta')

    // O espelho: o proprio dono, mas noutra conversa. O eixo `chat` sozinho
    // tambem tem de bastar.
    const donoNoutroChat = receiver.receive(pairCommand(OWNER, '000000'))
    assertRefused(donoNoutroChat, 'refuse:already-paired')
    assert.equal(donoNoutroChat.reply, undefined)

    // E o dono, no chat certo, continua a receber o caminho de recuperacao.
    const dono = receiver.receive(pairCommandInGroup(OWNER, GROUP, '000000'))
    assertRefused(dono, 'refuse:already-paired')
    assert.equal(dono.reply, PAIRING_ALREADY_PAIRED_REPLY)
  })

  it('nao existe caminho de reabertura neste modulo -- so `--reset-pairing` na maquina', () => {
    const { receiver } = bancada()
    receiver.receive(pairCommand(OWNER, CODE))
    // Um `reopen()` aqui seria uma porta que a rede pode bater.
    assert.equal(Object.hasOwn(receiver, 'reopen'), false)
    assert.equal('reset' in receiver, false)

    receiver.rotateChallenge(createPairingChallenge('999999', T0 + TTL_MS))
    assertRefused(receiver.receive(pairCommand(STRANGER, '999999')), 'refuse:already-paired')
    assert.equal(receiver.state().status, 'fechado')
  })

  it('PAIR-009: dois `/parear` correctos no MESMO tick dao UM dono, determinista', () => {
    // `receive` nao tem um unico `await`: entre ler o estado e gravar o dono nao
    // ha ponto de suspensao, logo o event loop nao pode intercalar. O vencedor e
    // o primeiro a CHEGAR, e "chegar" e uma ordem total num loop unico.
    const { receiver, clock } = bancada()
    const antes = clock.now()

    const primeiro = receiver.receive(pairCommand(OWNER, CODE))
    const segundo = receiver.receive(pairCommand(STRANGER, CODE))

    assert.equal(clock.now(), antes, 'nenhum tempo passou entre os dois: e o mesmo tick')
    assert.equal(primeiro.kind, 'paired')
    assertRefused(segundo, 'refuse:already-paired')

    const state = receiver.state()
    assert.equal(state.status, 'fechado')
    assert.equal(state.owner.from, OWNER)
  })

  it('PAIR-009 invertido: quem chega primeiro ganha, seja quem for -- e so isso muda', () => {
    const { receiver } = bancada()
    receiver.receive(pairCommand(STRANGER, CODE))
    const state = receiver.state()
    assert.equal(state.status === 'fechado' ? state.owner.from : 0, STRANGER)
    // O determinismo e o ponto. Quem impede o estranho de chegar primeiro nao e
    // este modulo: e o codigo estar SO no terminal.
  })

  it('nasce FECHADO quando o host ja tem dono persistido', () => {
    const clock = new FakeClock(T0)
    const receiver = createPairingReceiver({
      challenge: createPairingChallenge(CODE, T0 + TTL_MS),
      clock,
      owner: { from: OWNER, chat: OWNER, pairedAt: T0 - 1 },
    })
    assertRefused(receiver.receive(pairCommand(OWNER, CODE)), 'refuse:already-paired')
  })
})

// ---------------------------------------------------------------------------

describe('PAIR-006 -- `/start` responde boas-vindas e NAO pareia ninguem', () => {
  it('de um estranho: boas-vindas inocuas, estado intacto', () => {
    const { receiver } = bancada()
    const outcome = receiver.receive(startCommand(STRANGER))

    assert.equal(outcome.kind, 'welcome')
    assert.equal(outcome.reply, PAIRING_WELCOME_REPLY)
    assert.deepEqual(receiver.state(), { status: 'aberto' })
  })

  it('a mesma resposta para o dono e para o estranho -- nao diz se ha dono', () => {
    const { receiver } = bancada()
    const antes = receiver.receive(startCommand(OWNER))
    receiver.receive(pairCommand(OWNER, CODE))
    const depois = receiver.receive(startCommand(STRANGER))

    assert.equal(antes.kind === 'welcome' ? antes.reply : 'a', depois.kind === 'welcome' ? depois.reply : 'b')
  })

  it('`/start <codigo>` -- deep link -- NAO pareia', () => {
    // O payload de `/start` viaja dentro de uma URL `t.me/bot?start=...`, que e
    // partilhavel, aparece em historico e em pre-visualizacao de link. Aceitar
    // ali o codigo poria a raiz de confianca deste sistema num sitio onde ela
    // circula por copiar e colar.
    const { receiver } = bancada()
    assert.equal(receiver.receive(startCommand(STRANGER, CODE)).kind, 'welcome')
    assert.deepEqual(receiver.state(), { status: 'aberto' })
  })
})

// ---------------------------------------------------------------------------

describe('PAIR-007 -- forca bruta: limitada e atrasada', () => {
  it('teto POR CHAT: as excedentes sao descartadas sem resposta', () => {
    const { receiver } = bancada()
    for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxAttemptsPerChat; i += 1) {
      assertRefused(receiver.receive(pairCommand(STRANGER, '000000')), 'refuse:wrong-code')
    }

    const excedente = receiver.receive(pairCommand(STRANGER, '111111'))
    assertRefused(excedente, 'refuse:rate-limited')
    // Sem resposta: responder a cada excedente faria do bot um amplificador e
    // estouraria o limite de 1 msg/s por chat da propria Bot API.
    assert.equal(excedente.reply, undefined)
  })

  it('o teto corre ANTES da verificacao: um chat esgotado nem chega a TESTAR o codigo', () => {
    // Se o teto corresse depois, cada tentativa excedente continuaria a ser um
    // palpite valido e o limite so mudaria a resposta, nao a forca bruta.
    const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, maxAttemptsPerChat: 1 }
    const { receiver } = bancada(limits)

    receiver.receive(pairCommand(STRANGER, '000000'))
    assertRefused(receiver.receive(pairCommand(STRANGER, CODE)), 'refuse:rate-limited')
    assert.equal(receiver.state().status, 'aberto', 'nem o codigo CERTO passa depois do teto')
  })

  it('teto GLOBAL: rodar `chat.id` nao devolve orcamento -- e este o controlo que fecha 10^6', () => {
    const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, maxAttemptsPerChat: 3, maxAttemptsGlobal: 5 }
    const { receiver } = bancada(limits)

    for (let i = 0; i < 3; i += 1) assertRefused(receiver.receive(pairCommand(STRANGER, '000000')), 'refuse:wrong-code')
    assertRefused(receiver.receive(pairCommand(STRANGER, '000000')), 'refuse:rate-limited')

    // Conta nova, chat novo: so consegue DUAS tentativas antes de o teto global
    // a apanhar, apesar de o seu proprio teto ser tres.
    assertRefused(receiver.receive(pairCommand(OWNER, '111111')), 'refuse:wrong-code')
    assertRefused(receiver.receive(pairCommand(OWNER, '222222')), 'refuse:wrong-code')
    assertRefused(receiver.receive(pairCommand(OWNER, '333333')), 'refuse:rate-limited')
  })

  it('ACHADO 6 -- o contador e por CHAT: cinco membros do mesmo grupo partilham UM orcamento', () => {
    // Se a chave fosse `from.id`, cada membro do grupo trazia orcamento novo e o
    // teto por chat nao existia -- um grupo com N membros daria N x 5 palpites.
    // Em DM isto e invisivel, porque os dois eixos sao o mesmo numero.
    const { receiver } = bancada()
    for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxAttemptsPerChat; i += 1) {
      assertRefused(receiver.receive(pairCommandInGroup(STRANGER + i, GROUP, '000000')), 'refuse:wrong-code')
    }
    const sextoMembro = receiver.receive(pairCommandInGroup(STRANGER + 99, GROUP, '000000'))
    assertRefused(sextoMembro, 'refuse:rate-limited')
  })

  it('ACHADO 6 -- e e MESMO por chat: o mesmo `from` noutra conversa traz orcamento proprio', () => {
    // O espelho do teste acima. Juntos, fixam a chave: se a leitura e a escrita
    // usassem eixos diferentes, um dos dois partia.
    const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, maxAttemptsPerChat: 2 }
    const { receiver } = bancada(limits)

    assertRefused(receiver.receive(pairCommandInGroup(STRANGER, GROUP, '000000')), 'refuse:wrong-code')
    assertRefused(receiver.receive(pairCommandInGroup(STRANGER, GROUP, '111111')), 'refuse:wrong-code')
    assertRefused(receiver.receive(pairCommandInGroup(STRANGER, GROUP, '222222')), 'refuse:rate-limited')

    // Mesma pessoa, outra conversa: o teto do grupo nao a segue.
    assertRefused(receiver.receive(pairCommandInGroup(STRANGER, OTHER_GROUP, '333333')), 'refuse:wrong-code')
  })

  it('o atraso e uma INTENCAO devolvida e cresce em escada; nunca se dorme aqui dentro', () => {
    const { receiver, clock } = bancada()
    const antes = clock.now()
    const delays: number[] = []
    for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxAttemptsPerChat + 1; i += 1) {
      const outcome = receiver.receive(pairCommand(STRANGER, '000000'))
      delays.push(outcome.kind === 'refused' ? outcome.delayMs : -1)
    }

    assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, 4_000])
    assert.equal(clock.now(), antes, 'a decisao e pura: nao move o relogio nem espera nele')
  })

  it('o `Map` de contadores fica limitado pelo teto global -- o limitador nao vira DoS de memoria', () => {
    const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, maxAttemptsPerChat: 1, maxAttemptsGlobal: 4 }
    const { receiver } = bancada(limits)
    for (let i = 0; i < 50; i += 1) receiver.receive(pairCommand(1_000_000_000_000 + i, '000000'))
    // Nao ha como registar mais chats distintos do que tentativas globais.
    assert.equal(receiver.stats().attempts, 4)
  })

  it('recusa tetos incoerentes em vez de os aceitar como limite decorativo', () => {
    for (const bad of [{ maxAttemptsPerChat: 0 }, { maxAttemptsGlobal: 0 }, { maxDelayMs: 1, baseDelayMs: 2 }]) {
      assert.throws(
        () => bancada({ ...DEFAULT_PAIRING_LIMITS, ...bad }),
        (error: unknown) => error instanceof WorkerAuthError && error.code === 'PAIRING_LIMITS_INVALID',
      )
    }
  })
})

// ---------------------------------------------------------------------------

/** Tudo o que um estranho consegue OBSERVAR de fora: houve mensagem, ou nao. */
function observar(receiver: PairingReceiver, update: unknown): 'MENSAGEM' | 'SILENCIO' {
  const outcome = receiver.receive(update)
  if (outcome.kind === 'ignored') return 'SILENCIO'
  if (outcome.kind === 'refused') return outcome.reply === undefined ? 'SILENCIO' : 'MENSAGEM'
  return 'MENSAGEM'
}

describe('a janela ABERTA e a janela FECHADA sao indistinguiveis para um estranho', () => {
  function aberta(): PairingReceiver {
    return createPairingReceiver({
      challenge: createPairingChallenge(CODE, T0 + TTL_MS),
      clock: new FakeClock(T0),
    })
  }

  function fechada(): PairingReceiver {
    return createPairingReceiver({
      challenge: createPairingChallenge(CODE, T0 + TTL_MS),
      clock: new FakeClock(T0),
      owner: { from: OWNER, chat: OWNER, pairedAt: T0 - 1 },
    })
  }

  it('mil sondas `/parear` sem argumento nao distinguem os dois estados', () => {
    // ISTO E O ORACULO QUE ESTE MODULO NAO PODE TER. Se `/parear` seco
    // respondesse enquanto a janela esta aberta e calasse depois de fechada, um
    // estranho sondava de graca, em ciclo, ate VER a janela abrir -- o instante
    // exacto em que o dono corre o setup e o codigo aparece no terminal -- e so
    // entao gastava os palpites, dentro dos 5 minutos vivos.
    const naAberta = new Set<string>()
    const naFechada = new Set<string>()
    const a = aberta()
    const f = fechada()
    for (let i = 0; i < 1_000; i += 1) {
      naAberta.add(observar(a, pairCommand(STRANGER, '')))
      naFechada.add(observar(f, pairCommand(STRANGER, '')))
    }
    assert.deepEqual([...naAberta], ['SILENCIO'])
    assert.deepEqual([...naFechada], ['SILENCIO'])
  })

  it('INVARIANTE 1: a indistinguibilidade NAO depende do estado dos contadores', () => {
    // A versao anterior deste modulo debitava as sondas ao orcamento de
    // palpites, e entao a indistinguibilidade valia "enquanto ha orcamento".
    // Com contadores separados ela passa a valer SEMPRE -- e e isso que este
    // teste fixa, varrendo os quatro estados de contador que existem.
    const cenarios: ReadonlyArray<readonly [string, () => PairingReceiver]> = [
      ['contadores intactos', aberta],
      [
        'orcamento de PALPITES esgotado',
        () => {
          const r = aberta()
          for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxAttemptsGlobal + 5; i += 1) {
            r.receive(pairCommand(STRANGER + (i % 7), '000000'))
          }
          return r
        },
      ],
      [
        'mapa de SONDAS cheio',
        () => {
          const r = aberta()
          for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxProbeChatsTracked + 20; i += 1) {
            r.receive(pairCommand(STRANGER + i, ''))
          }
          return r
        },
      ],
      ['os dois esgotados', () => {
        const r = aberta()
        for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxAttemptsGlobal + 5; i += 1) {
          r.receive(pairCommand(STRANGER + (i % 7), '000000'))
        }
        for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxProbeChatsTracked + 20; i += 1) {
          r.receive(pairCommand(STRANGER + i, ''))
        }
        return r
      }],
    ]

    for (const [rotulo, montar] of cenarios) {
      const a = montar()
      const f = fechada()
      const observadoAberta = new Set<string>()
      const observadoFechada = new Set<string>()
      for (let i = 0; i < 50; i += 1) {
        observadoAberta.add(observar(a, pairCommand(STRANGER + 500 + i, '')))
        observadoFechada.add(observar(f, pairCommand(STRANGER + 500 + i, '')))
      }
      assert.deepEqual([...observadoAberta], ['SILENCIO'], rotulo)
      assert.deepEqual([...observadoFechada], ['SILENCIO'], rotulo)
    }
  })

  it('INVARIANTE 2: sondar NAO consome palpites -- mil sondas e o codigo certo ainda pareia', () => {
    // O custo que a fusao dos contadores criava: um estranho fechava o
    // pareamento a toda a gente com comandos secos, sem adivinhar uma vez.
    const a = aberta()
    for (let i = 0; i < 1_000; i += 1) a.receive(pairCommand(STRANGER, ''))

    assert.equal(a.stats().probes, 1_000, 'as sondas sao TODAS contadas')
    assert.equal(a.stats().attempts, 0, 'e nenhuma delas tocou no orcamento de palpites')

    const ok = a.receive(pairCommand(OWNER, CODE))
    assert.equal(ok.kind, 'paired', 'o dono continua a conseguir parear depois de mil sondas de um estranho')
  })

  it('INVARIANTE 3: o audit distingue quem ADIVINHA de quem SONDA', () => {
    // Sem isto, T5.4 teria de saber de cor quais motivos carregam palpite para
    // montar o relatorio horario -- e essa tabela divergiria no primeiro motivo
    // novo.
    const a = aberta()
    const sonda = a.receive(pairCommand(STRANGER, ''))
    const palpite = a.receive(pairCommand(STRANGER, '000000'))
    const boasVindas = a.receive(startCommand(STRANGER))

    assertRefused(sonda, 'refuse:malformed')
    assertRefused(palpite, 'refuse:wrong-code')
    assert.equal(sonda.audit.orcamento, 'sonda')
    assert.equal(palpite.audit.orcamento, 'palpite')
    assert.equal(boasVindas.kind === 'welcome' ? boasVindas.audit.orcamento : '', 'nenhum')

    assert.deepEqual(a.stats(), {
      attempts: 1,
      probes: 1,
      refused: 2,
      byReason: { 'refuse:malformed': 1, 'refuse:wrong-code': 1 },
    })
  })

  it('o teto de sondas e SO memoria: acima dele o silencio mantem-se igual', () => {
    // `maxProbeChatsTracked` nao e um controlo de seguranca -- e o limite do
    // `Map`. O efeito observavel de um chat nao registado e apenas o atraso ir
    // ao maximo; a resposta continua a ser silencio, e o escalar continua a
    // contar para o dono ver o volume.
    const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, maxProbeChatsTracked: 2 }
    const clock = new FakeClock(T0)
    const r = createPairingReceiver({ challenge: createPairingChallenge(CODE, T0 + TTL_MS), clock, limits })

    const registado = r.receive(pairCommand(STRANGER, ''))
    r.receive(pairCommand(STRANGER + 1, ''))
    const naoRegistado = r.receive(pairCommand(STRANGER + 2, ''))

    assertRefused(registado, 'refuse:malformed')
    assertRefused(naoRegistado, 'refuse:malformed')
    assert.equal(registado.delayMs, DEFAULT_PAIRING_LIMITS.baseDelayMs, 'chat registado: escada normal')
    assert.equal(naoRegistado.delayMs, DEFAULT_PAIRING_LIMITS.maxDelayMs, 'chat fora do mapa: atraso maximo')
    assert.equal(naoRegistado.reply, undefined, 'e o SILENCIO nao muda acima do teto')
    assert.equal(r.stats().probes, 3, 'o escalar conta as tres, sem crescer em memoria')
  })

  it('com palpite, o oraculo existe -- e esta LIMITADO ao orcamento, que e o desenho', () => {
    // PAIR-003 EXIGE resposta generica a um codigo errado, logo enquanto ha
    // orcamento a janela aberta responde e a fechada nao. Este teste nao esconde
    // isso: mede-o. Esgotado o teto, os dois estados voltam a ser identicos.
    const a = aberta()
    const f = fechada()
    const antes = [observar(a, pairCommand(STRANGER, '000000')), observar(f, pairCommand(STRANGER, '000000'))]
    assert.deepEqual(antes, ['MENSAGEM', 'SILENCIO'], 'o oraculo limitado e conhecido e declarado')

    for (let i = 0; i < DEFAULT_PAIRING_LIMITS.maxAttemptsPerChat; i += 1) {
      observar(a, pairCommand(STRANGER, '000000'))
    }
    const depois = [observar(a, pairCommand(STRANGER, '000000')), observar(f, pairCommand(STRANGER, '000000'))]
    assert.deepEqual(depois, ['SILENCIO', 'SILENCIO'], 'gasto o teto, os dois estados colapsam')
  })

  it('so o ramo que RESPONDE debita palpite -- e nenhum outro devolve sinal a quem nao e dono', () => {
    // A REGRA que liga os dois contadores, e que impede a proxima pessoa de os
    // uniformizar outra vez: **um ramo so devolve sinal a quem nao e dono se
    // tiver debitado um palpite.** Este teste percorre todos os ramos
    // observaveis por um estranho e verifica a bi-implicacao nos dois sentidos.
    const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, maxAttemptsPerChat: 2, maxAttemptsGlobal: 2 }
    const clock = new FakeClock(T0)
    const r = createPairingReceiver({ challenge: createPairingChallenge(CODE, T0 + TTL_MS), clock, limits })

    const ramos = [
      r.receive(pairCommand(STRANGER, '')), // sonda      -> silencio, 'sonda'
      r.receive(pairCommand(STRANGER, '000000')), // errado -> RESPONDE, 'palpite'
      r.receive(pairCommand(STRANGER, '111111')), // errado -> RESPONDE, 'palpite'
      r.receive(pairCommand(STRANGER, '222222')), // sem orcamento -> silencio
      r.receive(pairCommand(STRANGER, '')), // sonda de novo -> silencio
    ]

    for (const ramo of ramos) {
      assert.equal(ramo.kind, 'refused')
      const respondeu = ramo.reply !== undefined
      const debitouPalpite = ramo.audit.orcamento === 'palpite' && ramo.reason !== 'refuse:rate-limited'
      assert.equal(
        respondeu,
        debitouPalpite,
        `ramo ${ramo.reason}: responder=${respondeu} mas palpite=${debitouPalpite} -- a regra quebrou`,
      )
    }

    assert.equal(r.stats().attempts, 2, 'so os dois ramos que responderam gastaram orcamento')
    assert.equal(r.stats().probes, 2)
  })

  it('o bot nunca e amplificador: dez mil pedidos sem palpite produzem ZERO mensagens', () => {
    // A Bot API limita a 1 msg/s por chat. Um estranho em ciclo poria o bot a
    // bater no 429, e a resposta legitima ao dono entrava na mesma fila.
    const a = aberta()
    let mensagens = 0
    for (let i = 0; i < 10_000; i += 1) {
      if (observar(a, pairCommand(STRANGER, '')) === 'MENSAGEM') mensagens += 1
    }
    assert.equal(mensagens, 0)
  })
})

// ---------------------------------------------------------------------------

describe('PAIR-010 -- o codigo NUNCA aparece em resposta, registo ou payload', () => {
  it('nenhum resultado de nenhum caminho contem o codigo', () => {
    const { receiver, clock } = bancada()

    const resultados: PairingOutcome[] = [
      receiver.receive(startCommand(STRANGER, CODE)),
      receiver.receive(pairCommand(STRANGER, '000000')),
      receiver.receive(pairCommand(OWNER, CODE)),
      receiver.receive(pairCommand(OWNER, CODE)),
      receiver.receive(startCommand(OWNER)),
    ]
    clock.advance(1)

    for (const outcome of resultados) {
      const serializado = JSON.stringify(outcome)
      assert.equal(serializado.includes(CODE), false, `o codigo vazou em ${outcome.kind}: ${serializado}`)
    }
  })

  it('nem o resultado do pareamento BEM SUCEDIDO ecoa o codigo', () => {
    const { receiver } = bancada()
    const ok = receiver.receive(pairCommand(OWNER, CODE))
    assert.equal(ok.kind, 'paired')
    assert.equal(ok.reply.includes(CODE), false)
    assert.equal(JSON.stringify(ok.audit).includes(CODE), false)
    // O registo de auditoria nao tem sequer um campo onde o codigo coubesse.
    assert.deepEqual(Object.keys(ok.audit).toSorted(), ['chat', 'evento', 'from', 'motivo', 'orcamento', 'resultado'])
  })

  it('ACHADO 7 -- o codigo nao passa por nenhuma `RegExp`, logo nao fica nas estaticas globais', () => {
    // `RegExp.prototype.test` e `String.prototype.search` publicam o sujeito e o
    // trecho casado em `RegExp.input` / `RegExp.lastMatch`, que sao propriedades
    // do construtor GLOBAL e sobrevivem ao retorno da funcao. Antes desta
    // correccao, `/^[0-9]{6}$/.test(code)` deixava `482913` em `lastMatch`, e
    // `trimmed.search(/\s/u)` deixava a linha `/parear 482913` em `input` --
    // legiveis por qualquer outro ficheiro do processo.
    const CANARIO = 'canario-de-regexp'
    new RegExp(CANARIO, 'u').test(CANARIO)

    const { receiver } = bancada()
    receiver.receive(pairCommand(OWNER, CODE))

    // Capturado ANTES de qualquer `assert`, para nenhuma regex de terceiros se
    // intrometer entre o fluxo e a leitura.
    const input = RegExp.input
    const lastMatch = RegExp.lastMatch

    assert.equal(input.includes(CODE), false, `o codigo ficou em RegExp.input: ${input}`)
    assert.equal(lastMatch.includes(CODE), false, `o codigo ficou em RegExp.lastMatch: ${lastMatch}`)
    // Mais forte: o canario intacto prova que NENHUMA regex correu no fluxo.
    assert.equal(input, CANARIO, 'alguma operacao do fluxo usou RegExp')
  })

  it('nem os contadores retem o candidato apresentado', () => {
    const { receiver } = bancada()
    receiver.receive(pairCommand(STRANGER, CODE.slice(0, 5) + '0'))
    assert.equal(JSON.stringify(receiver.stats()).includes(CODE.slice(0, 5)), false)
  })
})
