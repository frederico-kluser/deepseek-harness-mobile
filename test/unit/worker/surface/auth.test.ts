/**
 * `worker/surface/auth.ts` — PORTE NEUTRO de `worker/auth/{allowlist,guard,
 * pairing}.ts`: allowlist de DOIS eixos com default DENY (TG-007), receptor de
 * pareamento (PAIR-002..010) sobre {@link SurfaceCommandEvent}, guard neutro com
 * descarte CONTADO (TG-089) e resposta ao clique (TG-027).
 *
 * AO CONTRÁRIO do funil Telegram, a identidade ja chega NORMALIZADA
 * (`SurfaceIdentity{userKey,chatKey}` STRINGS, D4) — por isso nao ha aqui
 * parsing de update cru; isso e do adaptador (Onda 3). As REGRAS portam-se
 * integras.
 *
 * Relogio INJETADO em todos os casos: o TTL e de 5 min e nenhum teste espera
 * tempo real.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALLOWLIST_VAZIA,
  AUMENTA_EXPOSICAO,
  autorizar,
  criarAllowlistSurface,
  criarAuthDeSuperficie,
  criarDesafioDePareamento,
  criarGuardDeIdentidade,
  criarReceptorDePareamento,
  decidirAutorizacao,
  LIMITES_PAREAMENTO_PADRAO,
  RESPOSTA_BOAS_VINDAS,
  RESPOSTA_JA_PAREADO,
  RESPOSTA_PAREAMENTO_RECUSADO,
  SurfaceAuthError,
  type PairedOwner,
  type SurfacePairingLimits,
  type SurfacePairingOutcome,
  type SurfacePairingReceiver,
} from '../../../../worker/surface/auth.ts'
import type { SurfaceIdentity } from '../../../../worker/surface/contract.ts'

/** O codigo de 6 digitos que o host gera e mostra SO no terminal. */
const CODE = '482913'
const TTL_MS = 5 * 60 * 1000
const T0 = 1_700_000_000_000

const OWNER: SurfaceIdentity = { userKey: '111-a', chatKey: '111-a' }
const STRANGER: SurfaceIdentity = { userKey: '999-z', chatKey: '999-z' }
const GROUP = 'g-42'
const OWNER_IN_GROUP: SurfaceIdentity = { userKey: OWNER.userKey, chatKey: GROUP }

class FakeClock {
  private current: number

  constructor(startAt = T0) {
    this.current = startAt
  }

  now(): number {
    return this.current
  }

  advance(ms: number): void {
    this.current += ms
  }
}

/** Converte um comando de texto num {@link SurfaceCommandEvent}. */
function comando(identity: SurfaceIdentity, text: string) {
  return { kind: 'comando' as const, identity, text }
}

interface Bancada {
  readonly receiver: SurfacePairingReceiver
  readonly clock: FakeClock
}

function bancada(limits?: SurfacePairingLimits): Bancada {
  const clock = new FakeClock(T0)
  const challenge = criarDesafioDePareamento(CODE, T0 + TTL_MS)
  return { receiver: criarReceptorDePareamento({ challenge, clock, limits }), clock }
}

/** Asercao de estrito: estreita para `{ kind: 'refused' }`. */
function assertRecusou(
  outcome: SurfacePairingOutcome,
  reason: string,
): asserts outcome is Extract<SurfacePairingOutcome, { kind: 'refused' }> {
  assert.equal(outcome.kind, 'refused', `esperava recusa, veio ${outcome.kind}`)
  assert.equal(outcome.reason, reason)
}

/* ========================================================================== */
/* ALLOWLIST NEUTRA — DOIS EIXOS, DEFAULT DENY                                 */
/* ========================================================================== */

describe('criarAllowlistSurface — dois eixos, DEFAULT DENY (TG-007)', () => {
  it('lista vazia nega tudo, INCLUSIVE o dono', () => {
    const allowlist = ALLOWLIST_VAZIA
    assert.deepEqual(decidirAutorizacao(OWNER, allowlist), { ok: false, reason: 'deny:not-configured' })
    assert.equal(autorizar(OWNER, allowlist), false)
  })

  it('exige os DOIS eixos: user listado MAS chat fora -> negado (TG-003)', () => {
    // Num grupo, `chatKey` e o do grupo autorizado enquanto `userKey` e de um
    // estranho — validar so um e o buraco de TG-003.
    const allowlist = criarAllowlistSurface({ users: [OWNER.userKey], chats: [GROUP] })
    // O dono em PM mantem o user, mas o chatKey dele nao esta na lista -> negado.
    assert.equal(decidirAutorizacao(OWNER, allowlist).ok, false)
    // No grupo autorizado, o dono passa.
    assert.deepEqual(decidirAutorizacao(OWNER_IN_GROUP, allowlist), { ok: true })
  })

  it('os DOIS eixos precisam estar — `&&`, nunca `||`', () => {
    const allowlist = criarAllowlistSurface({ users: [OWNER.userKey], chats: [OWNER.chatKey] })
    assert.deepEqual(decidirAutorizacao(OWNER, allowlist), { ok: true })
    // user certo, chat errado
    assert.deepEqual(
      decidirAutorizacao({ userKey: OWNER.userKey, chatKey: STRANGER.chatKey }, allowlist),
      { ok: false, reason: 'deny:not-allowlisted' },
    )
    // user errado, chat certo
    assert.deepEqual(
      decidirAutorizacao({ userKey: STRANGER.userKey, chatKey: OWNER.chatKey }, allowlist),
      { ok: false, reason: 'deny:not-allowlisted' },
    )
  })

  it('identidade incompleta (sem eixo legitimo) e NEGADA — ausencia e NEGACAO', () => {
    const allowlist = criarAllowlistSurface({ users: [OWNER.userKey], chats: [OWNER.chatKey] })
    assert.deepEqual(decidirAutorizacao(undefined, allowlist), {
      ok: false,
      reason: 'deny:incomplete-identity',
    })
  })

  it('copia as chaves: mutar a origem depois nao alarga a allowlist', () => {
    const users = [OWNER.userKey]
    const allowlist = criarAllowlistSurface({ users, chats: [GROUP] })
    users.push(STRANGER.userKey)
    assert.equal(decidirAutorizacao({ userKey: STRANGER.userKey, chatKey: GROUP }, allowlist).ok, false)
  })

  it('fecha ALTO em chave vazia ou so espaco, sem a guardar como entrada morta', () => {
    assert.throws(
      () => criarAllowlistSurface({ users: [''], chats: [] }),
      (e: unknown) => e instanceof SurfaceAuthError && e.code === 'ALLOWLIST_INVALID_KEY',
    )
    assert.throws(
      () => criarAllowlistSurface({ users: [], chats: ['   '] }),
      (e: unknown) => e instanceof SurfaceAuthError && e.code === 'ALLOWLIST_INVALID_KEY',
    )
  })
})

/* ========================================================================== */
/* O DESAFIO DE PAREAMENTO (PAIR-010: o codigo entra e nao sai)                */
/* ========================================================================== */

describe('criarDesafioDePareamento — o codigo entra e nao sai', () => {
  it('recusa codigo fora da forma, sem o citar', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 456']) {
      assert.throws(
        () => criarDesafioDePareamento(bad, T0 + TTL_MS),
        (e: unknown) => {
          if (!(e instanceof SurfaceAuthError)) return false
          assert.equal(e.code, 'PAIRING_CHALLENGE_INVALID')
          assert.equal(e.message.includes(bad) && bad.length > 0, false, 'PAIR-010 ate no erro')
          return true
        },
      )
    }
  })

  it('verifica em tempo constante; candidato absurdo devolve `false` em vez de lancar', () => {
    const c = criarDesafioDePareamento(CODE, T0 + TTL_MS)
    assert.equal(c.verify(CODE), true)
    assert.equal(c.verify('482914'), false)
    assert.equal(c.verify(''), false)
    assert.equal(c.verify('x'.repeat(10_000)), false)
  })

  it('o desafio NAO retem o claro — nem em closures nem em propriedades escondidas', () => {
    const c = criarDesafioDePareamento(CODE, T0 + TTL_MS)
    assert.deepEqual(Object.getOwnPropertyNames(c).toSorted(), ['expiresAt', 'verify'])
    for (const nome of Object.getOwnPropertyNames(c)) {
      assert.equal(String(Reflect.get(c, nome)).includes(CODE), false, `a propriedade ${nome} retem o codigo`)
    }
    const corpo = String(c.verify)
    assert.ok(corpo.includes('timingSafeEqual'), `verify nao compara em tempo constante`)
    assert.equal(corpo.includes(CODE), false)
  })
})

/* ========================================================================== */
/* PAIR-002 / TG-065 — o codigo certo pareia, com os DOIS eixos               */
/* ========================================================================== */

describe('pareamento — PAIR-002 o codigo certo pareia e grava os DOIS eixos', () => {
  it('grava `userKey` E `chatKey` do evento que carrega o codigo correcto', () => {
    const { receiver, clock } = bancada()
    clock.advance(1_000)

    const outcome = receiver.receive(comando(OWNER_IN_GROUP, `/parear ${CODE}`))
    assert.equal(outcome.kind, 'paired')
    if (outcome.kind !== 'paired') return
    assert.deepEqual(outcome.owner, { userKey: OWNER.userKey, chatKey: GROUP, pairedAt: T0 + 1_000 })
    assert.deepEqual(receiver.state(), { status: 'fechado', owner: outcome.owner })
  })

  it('os eixos vem do evento CORRECTO, nunca do primeiro que chegou', () => {
    const { receiver } = bancada()
    assertRecusou(receiver.receive(comando(STRANGER, '/parear 000000')), 'refuse:wrong-code')
    const ok = receiver.receive(comando(OWNER, `/parear ${CODE}`))
    assert.equal(ok.kind, 'paired')
    if (ok.kind !== 'paired') return
    assert.equal(ok.owner.userKey, OWNER.userKey)
    assert.notEqual(ok.owner.userKey, STRANGER.userKey)
  })

  it('ignora o que nao e comando de pareamento', () => {
    const { receiver } = bancada()
    assert.deepEqual(receiver.receive(comando(OWNER, 'ola')), { kind: 'ignored' })
    assert.deepEqual(receiver.receive(comando(OWNER, '/status')), { kind: 'ignored' })
    assert.equal(receiver.stats().attempts, 0, 'o que nao e `/parear` nao gasta orcamento')
  })

  it('`/parear` SEM argumento responde SILENCIO, conta como SONDA e NAO gasta palpite', () => {
    const { receiver } = bancada()
    const outcome = receiver.receive(comando(STRANGER, '/parear'))
    assertRecusou(outcome, 'refuse:malformed')
    assert.equal(outcome.reply, undefined, '(a) sem palpite nao merece resposta')
    assert.equal(outcome.audit.orcamento, 'sonda', '(b) o audit diz a QUE orcamento foi debitado')
    assert.equal(receiver.stats().probes, 1, '(b) contado')
    assert.equal(receiver.stats().attempts, 0, '(c) ZERO palpites gastos')
    assert.ok(outcome.delayMs > 0, 'estrangulada na mesma')
  })
})

/* ========================================================================== */
/* PAIR-003 / PAIR-004                                                         */
/* ========================================================================== */

describe('PAIR-003/004 — codigo errado e expirado', () => {
  it('a resposta e IDENTICA quer se acerte 0 quer se acerte 5 dos 6 digitos', () => {
    const { receiver } = bancada()
    const zero = receiver.receive(comando(STRANGER, '/parear 000000'))
    const quase = receiver.receive(comando(STRANGER, '/parear 482910'))
    assertRecusou(zero, 'refuse:wrong-code')
    assertRecusou(quase, 'refuse:wrong-code')
    assert.equal(zero.reply, RESPOSTA_PAREAMENTO_RECUSADO)
    assert.equal(quase.reply, RESPOSTA_PAREAMENTO_RECUSADO)
  })

  it('a mesma resposta serve errado e expirado; malformado nao responde de todo', () => {
    const a = bancada()
    const errado = a.receiver.receive(comando(STRANGER, '/parear 000000'))
    const b = bancada()
    b.clock.advance(TTL_MS + 1)
    const expirado = b.receiver.receive(comando(STRANGER, `/parear ${CODE}`))
    const c = bancada()
    const malformado = c.receiver.receive(comando(STRANGER, '/parear'))

    const replies = [errado, expirado, malformado].map((o) => (o.kind === 'refused' ? o.reply : 'NAO-RECUSADO'))
    assert.deepEqual(replies, [RESPOSTA_PAREAMENTO_RECUSADO, RESPOSTA_PAREAMENTO_RECUSADO, undefined])
  })

  it('e CONTADO (PAIR-003)', () => {
    const { receiver } = bancada()
    receiver.receive(comando(STRANGER, '/parear 000000'))
    receiver.receive(comando(STRANGER, '/parear 111111'))
    const stats = receiver.stats()
    assert.equal(stats.attempts, 2)
    assert.equal(stats.refused, 2)
    assert.equal(stats.byReason['refuse:wrong-code'], 2)
  })

  it('TTL de 5 min: um ms antes pareia; no instante, nao', () => {
    const dentro = bancada()
    dentro.clock.advance(TTL_MS - 1)
    assert.equal(dentro.receiver.receive(comando(OWNER, `/parear ${CODE}`)).kind, 'paired')

    const fora = bancada()
    fora.clock.advance(TTL_MS)
    assertRecusou(fora.receiver.receive(comando(OWNER, `/parear ${CODE}`)), 'refuse:expired')
  })

  it('rotacionar o desafio NAO devolve orcamento nem reabre', () => {
    const limits: SurfacePairingLimits = { ...LIMITES_PAREAMENTO_PADRAO, maxAttemptsPerChat: 2 }
    const { receiver, clock } = bancada(limits)
    receiver.receive(comando(STRANGER, '/parear 000000'))
    receiver.receive(comando(STRANGER, '/parear 111111'))
    assertRecusou(receiver.receive(comando(STRANGER, '/parear 222222')), 'refuse:rate-limited')
    clock.advance(TTL_MS + 1)
    receiver.rotateChallenge(criarDesafioDePareamento('999999', clock.now() + TTL_MS))
    assertRecusou(receiver.receive(comando(STRANGER, '/parear 999999')), 'refuse:rate-limited')
  })
})

/* ========================================================================== */
/* PAIR-005 / PAIR-006 / PAIR-007                                              */
/* ========================================================================== */

describe('PAIR-005 — o SEGUNDO pareamento e recusado, sem excepcao', () => {
  it('recusado mesmo com codigo valido e do PROPRIO DONO', () => {
    const { receiver } = bancada()
    receiver.receive(comando(OWNER, `/parear ${CODE}`))
    const outra = receiver.receive(comando(OWNER, `/parear ${CODE}`))
    assertRecusou(outra, 'refuse:already-paired')
    assert.equal(outra.reply, RESPOSTA_JA_PAREADO)
  })

  it('a um estranho, o pareamento fechado responde SILENCIO', () => {
    const { receiver } = bancada()
    receiver.receive(comando(OWNER, `/parear ${CODE}`))
    const intruso = receiver.receive(comando(STRANGER, `/parear ${CODE}`))
    assertRecusou(intruso, 'refuse:already-paired')
    assert.equal(intruso.reply, undefined)
  })

  it('em GRUPO, a resposta de "ja pareado" exige os DOIS eixos', () => {
    const { receiver } = bancada()
    receiver.receive(comando(OWNER_IN_GROUP, `/parear ${CODE}`))

    // Outro membro do MESMO grupo: eixo `userKey` falha -> silencio.
    const membro = receiver.receive(comando({ userKey: STRANGER.userKey, chatKey: GROUP }, `/parear ${CODE}`))
    assertRecusou(membro, 'refuse:already-paired')
    assert.equal(membro.reply, undefined, 'o eixo userKey sozinho tem de bastar para calar')

    // O proprio dono noutra conversa: eixo `chatKey` falha -> silencio.
    const donoNoutroChat = receiver.receive(comando(OWNER, `/parear ${CODE}`))
    assertRecusou(donoNoutroChat, 'refuse:already-paired')
    assert.equal(donoNoutroChat.reply, undefined)

    // Dono no chat certo: caminho de recuperacao.
    const dono = receiver.receive(comando(OWNER_IN_GROUP, `/parear ${CODE}`))
    assert.equal(dono.kind === 'refused' ? dono.reply : '', RESPOSTA_JA_PAREADO)
  })

  it('PAIR-009: dois `/parear` correctos no MESMO tick dao UM dono, determinista', () => {
    const { receiver, clock } = bancada()
    const antes = clock.now()
    const primeiro = receiver.receive(comando(OWNER, `/parear ${CODE}`))
    const segundo = receiver.receive(comando(STRANGER, `/parear ${CODE}`))
    assert.equal(clock.now(), antes, 'mesmo tick: nada de tempo a passar')
    assert.equal(primeiro.kind, 'paired')
    assertRecusou(segundo, 'refuse:already-paired')
    const state = receiver.state()
    assert.equal(state.status, 'fechado')
  })

  it('nao existe reabertura neste modulo', () => {
    const { receiver } = bancada()
    receiver.receive(comando(OWNER, `/parear ${CODE}`))
    assert.equal(Object.hasOwn(receiver, 'reopen'), false)
    assert.equal('reset' in receiver, false)
  })

  it('nasce FECHADO quando o host ja tem dono persistido', () => {
    const clock = new FakeClock(T0)
    const owner: PairedOwner = { userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 - 1 }
    const r = criarReceptorDePareamento({
      challenge: criarDesafioDePareamento(CODE, T0 + TTL_MS),
      clock,
      owner,
    })
    assertRecusou(r.receive(comando(OWNER, `/parear ${CODE}`)), 'refuse:already-paired')
  })
})

describe('PAIR-006 — `/start` responde boas-vindas e NAO pareia ninguem', () => {
  it('de um estranho: boas-vindas inocuas, estado intacto', () => {
    const { receiver } = bancada()
    const outcome = receiver.receive(comando(STRANGER, '/start'))
    assert.equal(outcome.kind, 'welcome')
    if (outcome.kind === 'welcome') assert.equal(outcome.reply, RESPOSTA_BOAS_VINDAS)
    assert.deepEqual(receiver.state(), { status: 'aberto' })
  })

  it('a mesma resposta para o dono e o estranho', () => {
    const { receiver } = bancada()
    const antes = receiver.receive(comando(OWNER, '/start'))
    receiver.receive(comando(OWNER, `/parear ${CODE}`))
    const depois = receiver.receive(comando(STRANGER, '/start'))
    assert.equal(
      antes.kind === 'welcome' ? antes.reply : 'a',
      depois.kind === 'welcome' ? depois.reply : 'b',
    )
  })

  it('`/start <codigo>` — deep link — NAO pareia', () => {
    const { receiver } = bancada()
    assert.equal(receiver.receive(comando(STRANGER, `/start ${CODE}`)).kind, 'welcome')
    assert.deepEqual(receiver.state(), { status: 'aberto' })
  })
})

describe('PAIR-007 — forca bruta: limitada e atrasada', () => {
  it('teto POR CHAT: as excedentes sao descartadas sem resposta', () => {
    const { receiver } = bancada()
    for (let i = 0; i < LIMITES_PAREAMENTO_PADRAO.maxAttemptsPerChat; i += 1) {
      assertRecusou(receiver.receive(comando(STRANGER, '/parear 000000')), 'refuse:wrong-code')
    }
    const excedente = receiver.receive(comando(STRANGER, '/parear 111111'))
    assertRecusou(excedente, 'refuse:rate-limited')
    assert.equal(excedente.reply, undefined, 'sem resposta: o bot nao e amplificador')
  })

  it('o teto corre ANTES da verificacao: chat esgotado nem chega a TESTAR o codigo', () => {
    const limits: SurfacePairingLimits = { ...LIMITES_PAREAMENTO_PADRAO, maxAttemptsPerChat: 1 }
    const { receiver } = bancada(limits)
    receiver.receive(comando(STRANGER, '/parear 000000'))
    assertRecusou(receiver.receive(comando(STRANGER, `/parear ${CODE}`)), 'refuse:rate-limited')
  })

  it('teto GLOBAL: rodar `chatKey` nao devolve orcamento', () => {
    const limits: SurfacePairingLimits = { ...LIMITES_PAREAMENTO_PADRAO, maxAttemptsPerChat: 3, maxAttemptsGlobal: 5 }
    const { receiver } = bancada(limits)
    for (let i = 0; i < 3; i += 1) assertRecusou(receiver.receive(comando(STRANGER, '/parear 000000')), 'refuse:wrong-code')
    assertRecusou(receiver.receive(comando(STRANGER, '/parear 000000')), 'refuse:rate-limited')
    // Chat novo: so duas tentativas antes de o teto global o apanhar.
    assertRecusou(receiver.receive(comando(OWNER, '/parear 111111')), 'refuse:wrong-code')
    assertRecusou(receiver.receive(comando(OWNER, '/parear 222222')), 'refuse:wrong-code')
    assertRecusou(receiver.receive(comando(OWNER, '/parear 333333')), 'refuse:rate-limited')
  })

  it('o contador e por CHAT: membros do mesmo grupo partilham UM orcamento', () => {
    const { receiver } = bancada()
    for (let i = 0; i < LIMITES_PAREAMENTO_PADRAO.maxAttemptsPerChat; i += 1) {
      assertRecusou(
        receiver.receive(comando({ userKey: `m-${i}`, chatKey: GROUP }, '/parear 000000')),
        'refuse:wrong-code',
      )
    }
    const sexto = receiver.receive(comando({ userKey: 'm-99', chatKey: GROUP }, '/parear 000000'))
    assertRecusou(sexto, 'refuse:rate-limited')
  })

  it('o atraso e uma INTENCAO devolvida e cresce em escada; nunca se dorme aqui dentro', () => {
    const { receiver, clock } = bancada()
    const antes = clock.now()
    const delays: number[] = []
    for (let i = 0; i < LIMITES_PAREAMENTO_PADRAO.maxAttemptsPerChat + 1; i += 1) {
      const outcome = receiver.receive(comando(STRANGER, '/parear 000000'))
      delays.push(outcome.kind === 'refused' ? outcome.delayMs : -1)
    }
    assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, 4_000])
    assert.equal(clock.now(), antes, 'a decisao e pura: nao move o relogio')
  })

  it('recusa tetos incoerentes', () => {
    for (const bad of [{ maxAttemptsPerChat: 0 }, { maxAttemptsGlobal: 0 }, { maxDelayMs: 1, baseDelayMs: 2 }]) {
      assert.throws(
        () => bancada({ ...LIMITES_PAREAMENTO_PADRAO, ...bad }),
        (e: unknown) => e instanceof SurfaceAuthError && e.code === 'PAIRING_LIMITS_INVALID',
      )
    }
  })
})

/* ========================================================================== */
/* O ORACULO: janela aberta vs fechada sao indistinguiveis para um estranho    */
/* ========================================================================== */

describe('a janela aberta e a fechada sao indistinguiveis para um estranho', () => {
  function aberta(): SurfacePairingReceiver {
    return criarReceptorDePareamento({
      challenge: criarDesafioDePareamento(CODE, T0 + TTL_MS),
      clock: new FakeClock(T0),
    })
  }
  function fechada(): SurfacePairingReceiver {
    return criarReceptorDePareamento({
      challenge: criarDesafioDePareamento(CODE, T0 + TTL_MS),
      clock: new FakeClock(T0),
      owner: { userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 - 1 },
    })
  }

  /** O que um estranho observa de fora: houve mensagem, ou nao. */
  function observar(receiver: SurfacePairingReceiver, identity: SurfaceIdentity, texto: string): 'MENSAGEM' | 'SILENCIO' {
    const outcome = receiver.receive(comando(identity, texto))
    if (outcome.kind === 'ignored') return 'SILENCIO'
    if (outcome.kind === 'refused') return outcome.reply === undefined ? 'SILENCIO' : 'MENSAGEM'
    return 'MENSAGEM'
  }

  it('mil sondas `/parear` sem argumento nao distinguem os dois estados', () => {
    const observado = new Map<string, Set<string>>([
      ['aberta', new Set()],
      ['fechada', new Set()],
    ])
    const a = aberta()
    const f = fechada()
    for (let i = 0; i < 1_000; i += 1) {
      observado.get('aberta')?.add(observar(a, STRANGER, '/parear'))
      observado.get('fechada')?.add(observar(f, STRANGER, '/parear'))
    }
    assert.deepEqual([...observado.get('aberta')!], ['SILENCIO'])
    assert.deepEqual([...observado.get('fechada')!], ['SILENCIO'])
  })

  it('INVARIANTE 1: a indistinguibilidade nao depende do estado dos contadores', () => {
    const cenarios: ReadonlyArray<[string, () => SurfacePairingReceiver]> = [
      ['contadores intactos', aberta],
      [
        'orcamento de PALPITES esgotado',
        () => {
          const r = aberta()
          for (let i = 0; i < LIMITES_PAREAMENTO_PADRAO.maxAttemptsGlobal + 5; i += 1) {
            r.receive(comando({ userKey: `u-${i % 7}`, chatKey: `c-${i % 7}` }, '/parear 000000'))
          }
          return r
        },
      ],
      [
        'mapa de SONDAS cheio',
        () => {
          const r = aberta()
          for (let i = 0; i < LIMITES_PAREAMENTO_PADRAO.maxProbeChatsTracked + 20; i += 1) {
            r.receive(comando({ userKey: `u-${i}`, chatKey: `c-${i}` }, '/parear'))
          }
          return r
        },
      ],
    ]
    for (const [rotulo, montar] of cenarios) {
      const a = montar()
      const f = fechada()
      const obsA = new Set<string>()
      const obsF = new Set<string>()
      for (let i = 0; i < 50; i += 1) {
        obsA.add(observar(a, { userKey: `x-${i}`, chatKey: `x-${i}` }, '/parear'))
        obsF.add(observar(f, { userKey: `x-${i}`, chatKey: `x-${i}` }, '/parear'))
      }
      assert.deepEqual([...obsA], ['SILENCIO'], rotulo)
      assert.deepEqual([...obsF], ['SILENCIO'], rotulo)
    }
  })

  it('INVARIANTE 2: sondar NAO consome palpites — o codigo certo ainda pareia', () => {
    const a = aberta()
    for (let i = 0; i < 1_000; i += 1) a.receive(comando(STRANGER, '/parear'))
    assert.equal(a.stats().probes, 1_000)
    assert.equal(a.stats().attempts, 0)
    assert.equal(a.receive(comando(OWNER, `/parear ${CODE}`)).kind, 'paired')
  })

  it('INVARIANTE 3: o audit distingue quem ADIVINHA de quem SONDA', () => {
    const a = aberta()
    const sonda = a.receive(comando(STRANGER, '/parear'))
    const palpite = a.receive(comando(STRANGER, '/parear 000000'))
    const boasVindas = a.receive(comando(STRANGER, '/start'))
    assertRecusou(sonda, 'refuse:malformed')
    assertRecusou(palpite, 'refuse:wrong-code')
    assert.equal(sonda.audit.orcamento, 'sonda')
    assert.equal(palpite.audit.orcamento, 'palpite')
    assert.equal(boasVindas.kind === 'welcome' ? boasVindas.audit.orcamento : '', 'nenhum')
  })

  it('so o ramo que RESPONDE debita palpite', () => {
    const limits: SurfacePairingLimits = { ...LIMITES_PAREAMENTO_PADRAO, maxAttemptsPerChat: 2, maxAttemptsGlobal: 2 }
    const clock = new FakeClock(T0)
    const r = criarReceptorDePareamento({
      challenge: criarDesafioDePareamento(CODE, T0 + TTL_MS),
      clock,
      limits,
    })
    const ramos = [
      r.receive(comando(STRANGER, '/parear')),
      r.receive(comando(STRANGER, '/parear 000000')),
      r.receive(comando(STRANGER, '/parear 111111')),
      r.receive(comando(STRANGER, '/parear 222222')),
      r.receive(comando(STRANGER, '/parear')),
    ]
    for (const ramo of ramos) {
      assert.equal(ramo.kind, 'refused')
      if (ramo.kind !== 'refused') continue
      const respondeu = ramo.reply !== undefined
      const debitouPalpite = ramo.audit.orcamento === 'palpite' && ramo.reason !== 'refuse:rate-limited'
      assert.equal(respondeu, debitouPalpite, `ramo ${ramo.reason}: respond||palpite`)
    }
    assert.equal(r.stats().attempts, 2)
    assert.equal(r.stats().probes, 2)
  })

  it('com palpite, o oraculo existe e esta LIMITADO ao orcamento, que e o desenho', () => {
    const a = aberta()
    const f = fechada()
    const antes = [observar(a, STRANGER, '/parear 000000'), observar(f, STRANGER, '/parear 000000')]
    assert.deepEqual(antes, ['MENSAGEM', 'SILENCIO'], 'o oraculo limitado e known and declared')
    for (let i = 0; i < LIMITES_PAREAMENTO_PADRAO.maxAttemptsPerChat; i += 1) {
      observar(a, STRANGER, '/parear 000000')
    }
    const depois = [observar(a, STRANGER, '/parear 000000'), observar(f, STRANGER, '/parear 000000')]
    assert.deepEqual(depois, ['SILENCIO', 'SILENCIO'], 'gasto o teto, os dois estados colapsam')
  })

  it('o bot nunca e amplificador: mil pedidos sem palpite produzem ZERO mensagens', () => {
    const a = aberta()
    let mensagens = 0
    for (let i = 0; i < 1_000; i += 1) {
      if (observar(a, STRANGER, '/parear') === 'MENSAGEM') mensagens += 1
    }
    assert.equal(mensagens, 0)
  })
})

/* ========================================================================== */
/* PAIR-010 — o codigo NUNCA aparece em resposta, registo ou payload           */
/* ========================================================================== */

describe('PAIR-010 — o codigo nunca vaza', () => {
  it('nenhum resultado de nenhum caminho contem o codigo', () => {
    const { receiver, clock } = bancada()
    const resultados = [
      receiver.receive(comando(STRANGER, `/start ${CODE}`)),
      receiver.receive(comando(STRANGER, '/parear 000000')),
      receiver.receive(comando(OWNER, `/parear ${CODE}`)),
      receiver.receive(comando(OWNER, `/parear ${CODE}`)),
    ]
    clock.advance(1)
    for (const outcome of resultados) {
      const serializado = JSON.stringify(outcome)
      assert.equal(serializado.includes(CODE), false, `o codigo vazou em ${outcome.kind}`)
    }
  })

  it('nem o pareamento BEM SUCEDIDO ecoa o codigo, e o audit nao tem campo p/ ele', () => {
    const { receiver } = bancada()
    const ok = receiver.receive(comando(OWNER, `/parear ${CODE}`))
    assert.equal(ok.kind, 'paired')
    if (ok.kind !== 'paired') return
    assert.equal(ok.reply.includes(CODE), false)
    assert.equal(JSON.stringify(ok.audit).includes(CODE), false)
    assert.deepEqual(Object.keys(ok.audit).toSorted(), [
      'chatKey',
      'evento',
      'motivo',
      'orcamento',
      'resultado',
      'userKey',
    ])
  })

  it('o codigo nao passa por nenhuma RegExp, logo nao fica nas estaticas globais', () => {
    const CANARIO = 'canario-de-regexp'
    new RegExp(CANARIO, 'u').test(CANARIO)
    const { receiver } = bancada()
    receiver.receive(comando(OWNER, `/parear ${CODE}`))
    const input = RegExp.input
    const lastMatch = RegExp.lastMatch
    assert.equal(input.includes(CODE), false, `o codigo ficou em RegExp.input: ${input}`)
    assert.equal(lastMatch.includes(CODE), false)
    assert.equal(input, CANARIO, 'alguma operacao do fluxo usou RegExp')
  })
})

/* ========================================================================== */
/* O GUARD NEUTRO — revalidacao e contagem (TG-024, TG-027, TG-089, S5)        */
/* ========================================================================== */

describe('criarGuardDeIdentidade — decisao por evento, descartado CONTADO', () => {
  const allowlist = criarAllowlistSurface({ users: [OWNER.userKey], chats: [OWNER.chatKey, GROUP] })
  const guardDe = (): ReturnType<typeof criarGuardDeIdentidade> => criarGuardDeIdentidade({ allowlist })

  it('comando do dono no chat autorizado e admitido', () => {
    const d = guardDe().admit(comando(OWNER, '/status'))
    assert.equal(d.kind, 'comando')
    if (d.kind === 'comando') assert.equal(d.identity.chatKey, OWNER.chatKey)
  })

  it('comando de identidade NAO pareada e descartado em silencio e CONTADO (TG-089)', () => {
    const g = guardDe()
    const d = g.admit(comando(STRANGER, '/status'))
    assert.equal(d.kind, 'rejeitado')
    if (d.kind === 'rejeitado') {
      assert.equal(d.reason, 'deny:not-allowlisted')
      assert.equal(d.answerTarget, undefined, 'comando nao tem clique a responder')
    }
    assert.equal(g.stats().descartado, 1)
    assert.equal(g.stats().admitido, 0)
  })

  it('comando com a allowlist vazia nega ATE o dono (TG-007)', () => {
    const g = criarGuardDeIdentidade({ allowlist: ALLOWLIST_VAZIA })
    const d = g.admit(comando(OWNER, '/status'))
    assert.equal(d.kind, 'rejeitado')
    if (d.kind === 'rejeitado') assert.equal(d.reason, 'deny:not-configured')
  })

  it('acao do OWNER no chat autorizado e encaminhada com token OPACO', () => {
    const d = guardDe().admit({
      kind: 'acao',
      identity: OWNER,
      action: 'tunnel.up',
      token: 'TOKEN',
      answerTarget: 'clique-1',
    })
    assert.equal(d.kind, 'acao')
    if (d.kind === 'acao') {
      assert.equal(d.action, 'tunnel.up')
      assert.equal(d.token, 'TOKEN', 'o token viaja BYTE A BYTE; o worker nao o interpreta')
      assert.equal(d.increasesExposure, true)
      assert.equal(d.answerTarget, 'clique-1')
    }
  })

  it('TG-024: clicar no botao de um GRUPO autorizado com `userKey` de estranho e REJEITADO', () => {
    const g = guardDe()
    const d = g.admit({
      kind: 'acao',
      identity: { userKey: STRANGER.userKey, chatKey: GROUP },
      action: 'tunnel.down',
      token: 'TOKEN',
      answerTarget: 'clique-2',
    })
    assert.equal(d.kind, 'rejeitado')
    if (d.kind === 'rejeitado') {
      assert.equal(d.reason, 'deny:not-allowlisted')
      assert.equal(d.answerTarget, 'clique-2', 'TG-027: responde na negacao tambem')
    }
    assert.equal(g.stats().admitido, 0, 'nenhum encaminhamento')
    assert.equal(g.stats().descartado, 1)
  })

  it('TG-027: todos os caminhos de `acao` devolvem alvo de resposta', () => {
    const caminhos = [
      {
        kind: 'acao' as const,
        identity: OWNER,
        action: 'tunnel.down' as const,
        token: 'TOKEN',
        answerTarget: 'clique-A',
      },
      {
        kind: 'acao' as const,
        identity: { userKey: STRANGER.userKey, chatKey: GROUP },
        action: 'tunnel.down' as const,
        token: 'TOKEN',
        answerTarget: 'clique-B',
      },
      {
        kind: 'acao-invalida' as const,
        identity: OWNER,
        answerTarget: 'clique-C',
        reason: 'deny:callback-data-too-long',
      },
    ]
    for (const evento of caminhos) {
      const d = guardDe().admit(evento)
      const resposta = d.kind === 'acao' || d.kind === 'rejeitado' ? d.answerTarget : undefined
      assert.ok(resposta !== undefined && resposta.length > 0, `caminho sem alvo de resposta: ${JSON.stringify(evento)}`)
    }
  })

  it('`acao-invalida` (payload malformado) e rejeitado, respondido e CONTADO — e nao inventa token', () => {
    const g = guardDe()
    const d = g.admit({ kind: 'acao-invalida', answerTarget: 'clique-D', reason: 'deny:callback-data-too-long' })
    assert.equal(d.kind, 'rejeitado')
    if (d.kind === 'rejeitado') {
      assert.equal(d.reason, 'deny:callback-data-too-long')
      assert.equal(d.answerTarget, 'clique-D')
    }
    assert.equal(g.stats().descartado, 1)
  })

  it('S5: o token e OPACO — nao ha uso unico local', () => {
    const g = guardDe()
    const evento = {
      kind: 'acao' as const,
      identity: OWNER,
      action: 'tunnel.up' as const,
      token: 'TOKEN',
      answerTarget: 'clique-1',
    }
    const a = g.admit(evento)
    const b = g.admit(evento)
    assert.equal(a.kind, 'acao')
    assert.equal(b.kind, 'acao')
    if (a.kind === 'acao' && b.kind === 'acao') {
      assert.equal(a.token, 'TOKEN')
      assert.equal(b.token, 'TOKEN')
    }
  })

  it('a tabela de exposicao cobre TODO o vocabulario (SurfaceAction = IpcIntentName)', () => {
    assert.deepEqual(AUMENTA_EXPOSICAO, {
      'tunnel.up': true,
      'tunnel.down': false,
      'tunnel.status': false,
      'session.issue': true,
      'secret.rotate': true,
      emergency: false,
    })
    assert.equal(AUMENTA_EXPOSICAO.emergency, false, 'em panico, o botao tem de funcionar a primeira')
  })

  it('acumula por motivo, e a auditoria nunca pode carregar o token', () => {
    const g = guardDe()
    g.admit(comando(STRANGER, '/status'))
    g.admit(comando(STRANGER, '/status'))
    g.admit({ kind: 'acao', identity: { userKey: STRANGER.userKey, chatKey: GROUP }, action: 'tunnel.down', token: 'SEGREDINHO', answerTarget: 'x' })
    g.admit(comando(OWNER, '/status'))

    const stats = g.stats()
    assert.equal(stats.descartado, 3)
    assert.equal(stats.admitido, 1)
    assert.equal(stats.byReason['deny:not-allowlisted'], 3)
    assert.equal(stats.byReason['ok'], 1)

    // Nenhum audit pode carregar o token (S3/S5).
    const evento = { kind: 'acao' as const, identity: OWNER, action: 'tunnel.up' as const, token: 'MY-TOKEN', answerTarget: 'y' }
    const d = g.admit(evento)
    assert.equal(JSON.stringify(d.audit).includes('MY-TOKEN'), false)
  })
})

/* ========================================================================== */
/* `semearDono` do receptor — re-montagem 8c quando `pairing.owner` chega      */
/* ========================================================================== */

describe('semearDono — o dono persistido chega DEPOIS do boot (core.ts onOwner)', () => {
  function montar() {
    const clock = new FakeClock(T0)
    const receiver = criarReceptorDePareamento({
      challenge: criarDesafioDePareamento(CODE, T0 + TTL_MS),
      clock,
    })
    return { receiver, clock }
  }

  it('o receptor passa a fechado com o dono semeado, e `/parear` e recusado sem nova parelha', () => {
    const { receiver } = montar()
    assert.deepEqual(receiver.state(), { status: 'aberto' })

    receiver.semearDono({ userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 })

    assert.deepEqual(receiver.state(), {
      status: 'fechado',
      owner: { userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 },
    })
    // `semearDono` NAO pareia: a resposta de um `/parear` de quem quer que seja
    // e recusada, nao um novo `paired`.
    const out = receiver.receive(comando(OWNER, `/parear ${CODE}`))
    assertRecusou(out, 'refuse:already-paired')
  })

  it('semearDono num ja-fechado substitui o dono, sem zerar o orcamento de palpites', () => {
    const { receiver, clock } = montar()
    // Consome um palpite que falta: recebe um `/parear` com codigo errado.
    receiver.receive(comando(STRANGER, '/parear 000000'))
    clock.advance(1)
    const tentativasUsadas = receiver.stats().attempts

    receiver.semearDono({ userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: clock.now() })

    // A semeadura NAO devolve tentativas novas ao atacante (o contador nao zera).
    assert.equal(receiver.stats().attempts, tentativasUsadas)
    // O pareamento fechado recusa quem quer que seja, com silencio para o estranho
    // (o `already-paired` corre ANTES de qualquer checagem de teto).
    const silencioso = receiver.receive(comando(STRANGER, `/parear ${CODE}`))
    assertRecusou(silencioso, 'refuse:already-paired')
    assert.equal(silencioso.reply, undefined, 'estranho nao ve nem a existencia do bot')
  })
})

/* ========================================================================== */
/* O FACADE `criarAuthDeSuperficie` — a forma que o NUCLEO (core.ts) consome   */
/* ========================================================================== */

describe('criarAuthDeSuperficie — facade SurfaceAuth para o nucleo', () => {
  function facade(owner?: PairedOwner) {
    const clock = new FakeClock(T0)
    const auth = criarAuthDeSuperficie({
      challenge: criarDesafioDePareamento(CODE, T0 + TTL_MS),
      clock,
      ...(owner === undefined ? {} : { owner }),
    })
    return { auth, clock }
  }

  it('`admitirComando` devolve SurfaceAdmissao com motivo SEM prefixo `deny:`', () => {
    const { auth } = facade()
    assert.deepEqual(auth.admitirComando(OWNER), { admitido: false, motivo: 'not-configured' })
  })

  it('`admitirComando` aceita o dono quando a allowlist o tem (default deny fechado por users/chats)', () => {
    const clock = new FakeClock(T0)
    const auth = criarAuthDeSuperficie({
      challenge: criarDesafioDePareamento(CODE, T0 + TTL_MS),
      clock,
      users: [OWNER.userKey],
      chats: [OWNER.chatKey],
    })
    assert.deepEqual(auth.admitirComando(OWNER), { admitido: true })
    assert.deepEqual(auth.admitirAcao(OWNER, 'tunnel.up'), { admitido: true })
    // Estrangeiro num chat autorizado: TG-003/TG-024.
    assert.deepEqual(
      auth.admitirAcao({ userKey: STRANGER.userKey, chatKey: OWNER.chatKey }, 'tunnel.down'),
      { admitido: false, motivo: 'not-allowlisted' },
    )
  })

  it('`admitirAcao` revalida a identidade (S6) — nao depende da acao', () => {
    const { auth } = facade({ userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 - 1 })
    assert.deepEqual(auth.admitirAcao(OWNER, 'tunnel.down'), { admitido: true })
    assert.deepEqual(auth.admitirAcao(STRANGER, 'emergency'), { admitido: false, motivo: 'not-allowlisted' })
  })

  it('`receber` traduz as unioes para a forma do core, incluindo `recusado.chat`', () => {
    const { auth } = facade()
    const boasVindas = auth.receber(comando(STRANGER, '/start'))
    assert.deepEqual(boasVindas, { kind: 'boas-vindas', reply: RESPOSTA_BOAS_VINDAS, chat: STRANGER.chatKey })

    const sonda = auth.receber(comando(STRANGER, '/parear'))
    assert.equal(sonda.kind, 'recusado')
    if (sonda.kind === 'recusado') {
      assert.equal(sonda.chat, STRANGER.chatKey)
      assert.equal(sonda.reply, undefined)
      assert.equal(sonda.delayMs > 0, true)
    }

    assert.deepEqual(auth.receber(comando(OWNER, '/status')), { kind: 'ignorado' })
  })

  it('`receber` pareado devolve dono e reply; `estado` e a forma do core (dono, nao owner)', () => {
    const { auth } = facade()
    const pareado = auth.receber(comando(OWNER, `/parear ${CODE}`))
    assert.equal(pareado.kind, 'pareado')
    if (pareado.kind === 'pareado') {
      assert.deepEqual(pareado.dono, { userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 })
      assert.ok(pareado.reply.length > 0)
    }
    assert.deepEqual(auth.estado(), {
      status: 'fechado',
      dono: { userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 },
    })
  })

  it('`rotacionarDesafio` troca o desafio em runtime', () => {
    const { auth, clock } = facade()
    clock.advance(TTL_MS + 1)
    // Depois do TTL, o codigo antigo nem vale; o facade traduz para `recusado`.
    const expirado = auth.receber(comando(OWNER, `/parear ${CODE}`))
    assert.equal(expirado.kind, 'recusado')

    auth.rotacionarDesafio(criarDesafioDePareamento('999999', clock.now() + TTL_MS))
    const novo = auth.receber(comando(OWNER, '/parear 999999'))
    assert.equal(novo.kind, 'pareado')
  })

  it('`semearDono` fecha o receptor E da ao dono os DOIS eixos da allowlist', () => {
    const { auth } = facade()
    // Antes de semear, o dono nem tem acesso (allowlist vazia -> nao configurado).
    assert.deepEqual(auth.admitirComando(OWNER), { admitido: false, motivo: 'not-configured' })

    auth.semearDono({ userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 })

    assert.deepEqual(auth.admitirComando(OWNER), { admitido: true })
    assert.deepEqual(auth.estado(), {
      status: 'fechado',
      dono: { userKey: OWNER.userKey, chatKey: OWNER.chatKey, pairedAt: T0 },
    })
    // /parear agora e recusado, sem nova parelha.
    const out = auth.receber(comando(STRANGER, `/parear ${CODE}`))
    assert.equal(out.kind, 'recusado')
  })
})