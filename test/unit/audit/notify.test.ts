/**
 * A composicao da notificacao proativa (`src/audit/notify.ts`, T5.4).
 *
 * O que este teste prende, e por que:
 *
 *   1. AS COMPOSICOES — cada texto comeca pelo marcador semantico fechado,
 *      o corpo nao tem caracteres de controlo, e o conteudo e o que o dono
 *      precisa ver (horario, hash curto, origem, URL do tunel — que NAO e
 *      segredo —, tempo restante do TTL). Nenhuma composicao recebe segredo
 *      nenhum; a disciplina S3 vale para o texto inteiro.
 *   2. BEST-EFFORT — o observador e `enviarNotificacao` NUNCA lancam para o
 *      chamador: canal morto, canal que devolve `false` ou canal hostil caem
 *      todos em `log.warn` (ou silencio, onde a assinatura congelada nao tem
 *      logger). Nenhuma notificacao bloqueia o request do utilizador.
 *   3. A REGRA DE OURO no relatorio periodico — o AuditSink e escrito ANTES
 *      do envio, e um append que falha (fail-closed) SUPRIME a notificacao:
 *      sem log, sem notificacao. O timer nasce com relogio injetado e o
 *      disposer limpa o pendente; a re-verificacao de `disposed` antes de
 *      reagendar e presa por mutacao dirigida (disposer disparado a meio do
 *      ciclo nao deixa ciclo vivo).
 *   4. COALESCENCIA de 30 s por categoria — o primeiro alerta da janela sai,
 *      o resto e descartado; categorias independentes nao se engolem.
 *   5. SEC-14 ESTENDIDO (Onda 5, aceite item 8) — segredo conhecido
 *      provisionado, TODOS os caminhos que produzem payload de IPC
 *      (toggle, notificacao, /status, /acessar, /rotacionar, erro),
 *      serializados, sem o segredo PERMANENTE em codificacao nenhuma. O `mk`
 *      do link magico e PERMITIDO nesse payload, e o teste prova as duas
 *      metades: o `mk` aparece no /acessar, o segredo permanente nunca.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { IPC_PROTOCOL_VERSION, type IpcMessageToWorker, type IpcNotifyMessage } from '../../../src/contracts/ipc.ts'
import { serializeIpcMessage } from '../../../src/telegram/ipc.ts'
import { canonicalizeSecret } from '../../../src/secret/canonical.ts'
import { createSecretStore } from '../../../src/secret/store.ts'
import { createFileStateStore } from '../secret/state-store-double.ts'
import { FakeClock } from '../../support/clock.ts'
import { FakeScheduler } from '../../support/child-double.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'
import type { SessaoNovaEvent } from '../../../src/audit/events.ts'
import type { HostIpcChannel } from '../../../src/telegram/ipc.ts'
import type { GuardLogger } from '../../../src/logging/logger.ts'
import {
  ALERTA_AUTH_FALHA,
  ALERTA_LINK_MAGICO,
  ALERTA_MAGIC_SUSPEITO,
  ALERTA_MODO_RESTRITO,
  ALERTA_RELATORIO,
  ALERTA_SESSAO_NOVA,
  ALERTA_TTL_EXPIRADO,
  ALERTA_TUNEL_DESLIGADO,
  ALERTA_TUNEL_LIGADO,
  COALESCENCIA_MS,
  comporTextoAuthFalha,
  comporTextoLinkMagico,
  comporTextoMagicSuspeito,
  comporTextoModoRestrito,
  comporTextoRelatorio,
  comporTextoSessaoNova,
  comporTextoTTLExpirado,
  comporTextoTunelToggle,
  criarCoalescedor,
  criarObservadorSessaoNova,
  criarRelatorioPeriodico,
  enviarNotificacao,
  formatarTempoRestante,
  HASH_CURTO_LEN,
  MAGIC_ROTA,
  RELATORIO_INTERVALO_MS,
} from '../../../src/audit/notify.ts'

const TS = 1_700_000_000_000
const HASH = 'e'.repeat(64)
const URL_DO_TUNEL = 'https://exemplo-de-tunel-publico.trycloudflare.com'

/** O minimo do AuditSink que o relatorio consome. */
interface AuditAppend {
  (evento: { readonly evento: string; readonly resultado: 'permitido' | 'negado' }): void
}

function canalMock(): {
  canal: Pick<HostIpcChannel, 'send'>
  enviadas: IpcNotifyMessage[]
} {
  const enviadas: IpcNotifyMessage[] = []
  const canal: Pick<HostIpcChannel, 'send'> = {
    send: (message: IpcMessageToWorker): boolean => {
      enviadas.push(message as IpcNotifyMessage)
      return true
    },
  }
  return { canal, enviadas }
}

function logMock(): { log: GuardLogger; avisos: string[] } {
  const avisos: string[] = []
  const log: GuardLogger = {
    info: (): void => {},
    warn: (mensagem: string): void => void avisos.push(mensagem),
    error: (): void => {},
    debug: (): void => {},
  }
  return { log, avisos }
}

/** Um texto de notificacao so pode conter controlo NAO; `\n` e legitimo. */
function assertTextoLimpo(texto: string): void {
  for (const char of texto) {
    const code = char.charCodeAt(0)
    if (code === 0x0a) continue
    assert.ok(code >= 0x20 && code !== 0x7f, `caracter de controlo ${String(code)} em ${JSON.stringify(texto)}`)
  }
}

function horarioEsperado(agoraMs: number): string {
  return new Date(agoraMs).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/* ========================================================================== */
/* 1. COMPOSICOES                                                              */
/* ========================================================================== */

describe('as composicoes produzem o marcador semantico e o corpo certo', () => {
  it('sessao nova: horario + hash curto de agente, marcador fechado', () => {
    const evento: SessaoNovaEvent = { evento: 'sessao_nova', resultado: 'permitido', sessao_id_hash: HASH }
    const texto = comporTextoSessaoNova(evento, TS)

    const [marcador, corpo] = texto.split('\n')
    assert.equal(marcador, ALERTA_SESSAO_NOVA)
    assert.ok(corpo?.includes(`as ${horarioEsperado(TS)}`), corpo)
    assert.ok(corpo?.includes(`agente ${HASH.slice(0, HASH_CURTO_LEN)}`), corpo)
    assert.ok(!corpo?.includes(HASH), 'o digest inteiro nao sai na mensagem')
    assertTextoLimpo(texto)
  })

  it('auth falha: com e sem IP normalizado — o IP so entra quando existe', () => {
    const comIp = comporTextoAuthFalha(
      { evento: 'auth_falha_primeira_janela', resultado: 'negado', ip_normalizado: '203.0.113.7' },
      TS,
    )
    const [marcador, corpo] = comIp.split('\n')
    assert.equal(marcador, ALERTA_AUTH_FALHA)
    assert.ok(corpo?.includes('de 203.0.113.7'), corpo)
    assert.ok(corpo?.includes('janela de 10 min'), corpo)

    const semIp = comporTextoAuthFalha(
      { evento: 'auth_falha_primeira_janela', resultado: 'negado' },
      TS,
    )
    assert.ok(!semIp.includes('— de '), 'sem IP nao se inventa origem')
    assertTextoLimpo(semIp)
  })

  it('toggle ligado: origem do sufixo + URL do tunel (que nao e segredo)', () => {
    const texto = comporTextoTunelToggle(
      { evento: 'tunel_ligar:telegram:123456', resultado: 'permitido' },
      TS,
      URL_DO_TUNEL,
    )
    const [marcador, corpo] = texto.split('\n')
    assert.equal(marcador, ALERTA_TUNEL_LIGADO)
    assert.ok(corpo?.includes('Tunel ligado'), corpo)
    assert.ok(corpo?.includes('origem: telegram:123456'), corpo)
    assert.ok(texto.includes(URL_DO_TUNEL), 'a URL viaja: e o caminho ate ao painel')
    assertTextoLimpo(texto)
  })

  it('A5: composicao de toggle RECUSA evento com origem vazia — o texto "(origem: )" nunca sai', () => {
    assert.throws(() => comporTextoTunelToggle({ evento: 'tunel_ligar:', resultado: 'permitido' }, TS), /EVENTO_TOGGLE_SEM_ORIGEM/u)
    assert.throws(() => comporTextoTunelToggle({ evento: 'tunel_desligar:', resultado: 'permitido' }, TS), /EVENTO_TOGGLE_SEM_ORIGEM/u)
  })

  it('toggle desligado: sem URL, com origem identificada', () => {
    const texto = comporTextoTunelToggle(
      { evento: 'tunel_desligar:painel:a1b2c3d4', resultado: 'permitido' },
      TS,
    )
    const [marcador, corpo] = texto.split('\n')
    assert.equal(marcador, ALERTA_TUNEL_DESLIGADO)
    assert.ok(corpo?.includes('Tunel desligado'), corpo)
    assert.ok(corpo?.includes('origem: painel:a1b2c3d4'), corpo)
    assert.ok(!texto.includes('URL:'), 'tunel desligado nao tem URL que mostrar')
    assertTextoLimpo(texto)
  })

  it('ttl expirado, modo restrito e magic suspeito: marcador e facto', () => {
    const ttl = comporTextoTTLExpirado({ evento: 'tunel_ttl_expirado:60min:timer', resultado: 'permitido' }, TS)
    assert.equal(ttl.split('\n')[0], ALERTA_TTL_EXPIRADO)
    assert.ok(ttl.includes('sessoes invalidadas'))

    const restrito = comporTextoModoRestrito({ evento: 'auth_modo_restrito', resultado: 'negado' }, TS)
    assert.equal(restrito.split('\n')[0], ALERTA_MODO_RESTRITO)
    assert.ok(restrito.includes('o tunel foi derrubado'))

    const suspeito = comporTextoMagicSuspeito(
      { evento: 'magic.crawler-suspect', resultado: 'negado' },
      TS,
    )
    assert.equal(suspeito.split('\n')[0], ALERTA_MAGIC_SUSPEITO)
    assert.ok(suspeito.includes('o token nao foi usado'))

    for (const texto of [ttl, restrito, suspeito]) assertTextoLimpo(texto)
  })

  it('relatorio: tempo restante do TTL e horario de expiracao', () => {
    const expiraEm = TS + 23 * 60_000
    const texto = comporTextoRelatorio(TS, expiraEm)
    const [marcador, corpo] = texto.split('\n')
    assert.equal(marcador, ALERTA_RELATORIO)
    assert.ok(corpo?.includes(`expira as ${horarioEsperado(expiraEm)}`), corpo)
    assert.ok(corpo?.includes('tempo restante: 23 min'), corpo)
    assertTextoLimpo(texto)
  })

  it('relatorio sem expiracao conhecida diz isso, nao inventa', () => {
    const texto = comporTextoRelatorio(TS, undefined)
    assert.ok(texto.includes('tempo restante indisponivel'))
    assertTextoLimpo(texto)
  })

  it('link magico: o mk viaja no FRAGMENTO e a rota e a fixa', () => {
    const mk = 'mk_9aF3kQ7zR1tY5uI8oP2sD6gH4jK0lZ'
    const texto = comporTextoLinkMagico(TS, URL_DO_TUNEL, mk, TS + 120_000)
    const [marcador, corpo] = texto.split('\n')
    assert.equal(marcador, ALERTA_LINK_MAGICO)
    assert.ok(corpo?.includes(`${URL_DO_TUNEL}${MAGIC_ROTA}#mk=${mk}`), corpo)
    assert.ok(texto.includes('expira em 2 min'), 'TTL de 120 s formatado')
    assertTextoLimpo(texto)
  })

  it('formatarTempoRestante arredonda para CIMA — nunca diz menos do que resta', () => {
    assert.equal(formatarTempoRestante(30_000), '1 min', '30 s sobem para 1 min: nunca dizer menos')
    assert.equal(formatarTempoRestante(59_000), '1 min')
    assert.equal(formatarTempoRestante(23 * 60_000), '23 min')
    assert.equal(formatarTempoRestante(65 * 60_000), '1 h 05 min')
    assert.equal(formatarTempoRestante(120 * 60_000), '2 h')
    assert.equal(formatarTempoRestante(0), 'menos de 1 min')
    assert.equal(formatarTempoRestante(-5_000), 'menos de 1 min')
  })
})

/* ========================================================================== */
/* 2. BEST-EFFORT — nunca lanca para o chamador                                */
/* ========================================================================== */

describe('o envio e best-effort: falha vira aviso, nunca excecao', () => {
  it('enviarNotificacao entrega e devolve true sem avisar', () => {
    const { canal, enviadas } = canalMock()
    const { log, avisos } = logMock()
    const ok = enviarNotificacao(canal, log, `${ALERTA_SESSAO_NOVA}\ncorpo`)
    assert.equal(ok, true)
    assert.equal(enviadas.length, 1)
    assert.deepEqual(enviadas[0], {
      v: IPC_PROTOCOL_VERSION,
      type: 'notify',
      texto: `${ALERTA_SESSAO_NOVA}\ncorpo`,
    })
    assert.equal(avisos.length, 0)
  })

  it('canal que devolve false: aviso e false, sem excecao', () => {
    const canal = {
      send: (message: IpcMessageToWorker): boolean => {
        void message
        return false
      },
    }
    const { log, avisos } = logMock()
    assert.equal(enviarNotificacao(canal, log, 'alerta:x\ncorpo'), false)
    assert.equal(avisos.length, 1, 'a falha de entrega fica no log do operador')
  })

  it('canal hostil que LANCA: aviso e false, sem excecao para o chamador', () => {
    const canal = {
      send: (): boolean => {
        throw new Error('canal avariado')
      },
    }
    const { log, avisos } = logMock()
    assert.equal(enviarNotificacao(canal, log, 'alerta:x\ncorpo'), false)
    assert.equal(avisos.length, 1)
  })

  it('o observador congelado compoe e envia UMA mensagem notify', () => {
    const { canal, enviadas } = canalMock()
    const observador = criarObservadorSessaoNova(canal)
    const evento: SessaoNovaEvent = { evento: 'sessao_nova', resultado: 'permitido', sessao_id_hash: HASH }

    assert.doesNotThrow(() => observador(evento))
    assert.equal(enviadas.length, 1)
    const enviada = enviadas[0]
    assert.ok(enviada !== undefined)
    assert.equal(enviada.type, 'notify')
    assert.ok(enviada.texto.startsWith(`${ALERTA_SESSAO_NOVA}\n`))
  })

  it('observador com canal morto ou hostil NAO lanca', () => {
    const morto = { send: (): boolean => false }
    const hostil = {
      send: (): boolean => {
        throw new Error('canal avariado')
      },
    }
    const evento: SessaoNovaEvent = { evento: 'sessao_nova', resultado: 'permitido', sessao_id_hash: HASH }
    assert.doesNotThrow(() => criarObservadorSessaoNova(morto)(evento))
    assert.doesNotThrow(() => criarObservadorSessaoNova(hostil)(evento))
  })
})

/* ========================================================================== */
/* 3. COALESCENCIA DE 30 S                                                     */
/* ========================================================================== */

describe('criarCoalescedor — alertas coalescidos em janela de 30 s', () => {
  it('o primeiro da janela sai; os seguintes sao descartados ate a janela fechar', () => {
    const clock = new FakeClock(0)
    const coalescedor = criarCoalescedor(() => clock.now())

    assert.equal(coalescedor.tentar('auth-falha'), true, 'primeiro da janela')
    assert.equal(coalescedor.tentar('auth-falha'), false, 'dentro da janela')
    clock.advance(COALESCENCIA_MS - 1)
    assert.equal(coalescedor.tentar('auth-falha'), false, '1 ms antes de fechar')
    clock.advance(1)
    assert.equal(coalescedor.tentar('auth-falha'), true, 'janela fechada: sai de novo')
  })

  it('categorias sao independentes: uma sessao nova nao engole uma rajada de falhas', () => {
    const clock = new FakeClock(0)
    const coalescedor = criarCoalescedor(() => clock.now())
    assert.equal(coalescedor.tentar('sessao-nova'), true)
    assert.equal(coalescedor.tentar('auth-falha'), true, 'outra categoria sai na mesma janela')
    assert.equal(coalescedor.tentar('sessao-nova'), false)
    assert.equal(coalescedor.tentar('auth-falha'), false)
  })

  it('MUTACAO dirigida: janela zero = sem coalescencia — o controlo e a janela', () => {
    const clock = new FakeClock(0)
    const coalescedor = criarCoalescedor(() => clock.now(), 0)
    assert.equal(coalescedor.tentar('x'), true)
    assert.equal(coalescedor.tentar('x'), true, 'janela zero descarta nada')
  })
})

/* ========================================================================== */
/* 4. RELATORIO PERIODICO — timer com disposer limpo                           */
/* ========================================================================== */

describe('criarRelatorioPeriodico — o lembrete de 30 min contra T10', () => {
  const INTERVALO = 30_000

  function bancada(estado: () => { aberto: boolean; expiraEm: number | undefined }) {
    const scheduler = new FakeScheduler()
    const clock = new FakeClock(TS)
    const { canal, enviadas } = canalMock()
    const { log, avisos } = logMock()
    const ordem: string[] = []
    const canalComOrdem: Pick<HostIpcChannel, 'send'> = {
      send: (message: IpcMessageToWorker): boolean => {
        ordem.push(`envio:${(message as IpcNotifyMessage).texto.split('\n')[0]}`)
        return canal.send(message)
      },
    }
    const append: AuditAppend = (evento) => {
      ordem.push(`audit:${evento.evento}`)
    }
    const relatorio = criarRelatorioPeriodico({
      canal: canalComOrdem,
      log,
      audit: { append },
      now: () => clock.now(),
      scheduler,
      estado,
      intervaloMs: INTERVALO,
    })
    return { scheduler, clock, relatorio, enviadas, avisos, ordem }
  }

  it('iniciar agenda o primeiro lembrete com 30 min (o default de L8)', () => {
    const scheduler = new FakeScheduler()
    const { log } = logMock()
    const relatorio = criarRelatorioPeriodico({
      canal: { send: (): boolean => true },
      log,
      audit: { append: (): void => {} },
      now: () => TS,
      scheduler,
      estado: () => ({ aberto: false, expiraEm: undefined }),
    })
    relatorio.iniciar()
    assert.equal(scheduler.scheduled.length, 1)
    assert.equal(scheduler.scheduled[0]?.delayMs, RELATORIO_INTERVALO_MS, 'default 30 min')
    relatorio.disposer()
  })

  it('com tunel aberto: APPEND ANTES do envio (a regra de ouro), e reagenda', () => {
    const b = bancada(() => ({ aberto: true, expiraEm: TS + 60 * 60_000 }))
    b.relatorio.iniciar()
    assert.equal(b.scheduler.pending.length, 1)

    b.scheduler.runLast()

    assert.deepEqual(
      b.ordem,
      ['audit:relatorio_periodico', 'envio:alerta:relatorio'],
      'log primeiro, Telegram depois',
    )
    assert.equal(b.enviadas.length, 1)
    assert.equal(b.scheduler.pending.length, 1, 'o ciclo reagendou')
    assert.equal(b.avisos.length, 0)
    b.relatorio.disposer()
  })

  it('com tunel FECHADO: nada sai — nem audit, nem envio — e o ciclo continua', () => {
    const b = bancada(() => ({ aberto: false, expiraEm: undefined }))
    b.relatorio.iniciar()
    b.scheduler.runLast()

    assert.equal(b.ordem.length, 0, 'tunel fechado nao incomoda ninguem')
    assert.equal(b.scheduler.pending.length, 1, 'o ciclo segue a observar')
    b.relatorio.disposer()
  })

  it('MUTACAO dirigida: projecao do tunel que LANCA nao escapa do timer — o ciclo continua', () => {
    const scheduler = new FakeScheduler()
    const clock = new FakeClock(TS)
    const { canal, enviadas } = canalMock()
    const { log, avisos } = logMock()
    const relatorio = criarRelatorioPeriodico({
      canal,
      log,
      audit: { append: (): void => {} },
      now: () => clock.now(),
      scheduler,
      estado: (): { aberto: boolean; expiraEm: number | undefined } => {
        throw new Error('estado avariado')
      },
      intervaloMs: INTERVALO,
    })
    relatorio.iniciar()
    // O teste falha com uncaughtException se a excecao escapar do callback.
    assert.doesNotThrow(() => scheduler.runLast())
    assert.equal(enviadas.length, 0, 'projecao avariada: nada sai')
    assert.equal(avisos.length, 1, 'o timer registou o ciclo falho no log do operador')
    assert.equal(scheduler.pending.length, 1, 'o timer continua vivo')
    relatorio.disposer()
  })

  it('MUTACAO dirigida: append que falha (fail-closed) SUPRIME a notificacao', () => {
    const scheduler = new FakeScheduler()
    const clock = new FakeClock(TS)
    const { canal, enviadas } = canalMock()
    const { log, avisos } = logMock()
    const relatorio = criarRelatorioPeriodico({
      canal,
      log,
      audit: {
        append: (): void => {
          throw new Error('nao foi possivel registar a auditoria — fail-closed')
        },
      },
      now: () => clock.now(),
      scheduler,
      estado: () => ({ aberto: true, expiraEm: TS + 60 * 60_000 }),
      intervaloMs: INTERVALO,
    })
    relatorio.iniciar()
    scheduler.runLast()

    assert.equal(enviadas.length, 0, 'sem log, sem notificacao')
    assert.equal(avisos.length, 1, 'o timer registou o silencio no log do operador')
    assert.equal(scheduler.pending.length, 1, 'o timer NAO morre com a falha do append')
    relatorio.disposer()
  })

  it('disposer limpa o temporizador pendente e e idempotente', () => {
    const b = bancada(() => ({ aberto: true, expiraEm: TS + 60 * 60_000 }))
    b.relatorio.iniciar()
    assert.equal(b.scheduler.pending.length, 1)

    b.relatorio.disposer()
    assert.equal(b.scheduler.pending.length, 0, 'nenhum timer orfao apos desmontar')
    assert.equal(b.scheduler.clearedIds.length, 1)

    b.relatorio.disposer()
    assert.equal(b.scheduler.clearedIds.length, 1, 'segundo disposer nao limpa o que ja nao existe')
  })

  it('MUTACAO dirigida: disposer disparado A MEIO do ciclo nao deixa o ciclo vivo', () => {
    const scheduler = new FakeScheduler()
    const clock = new FakeClock(TS)
    const { canal, enviadas } = canalMock()
    const { log } = logMock()
    let relatorio: ReturnType<typeof criarRelatorioPeriodico>
    const estado = (): { aberto: boolean; expiraEm: number | undefined } => {
      relatorio.disposer()
      return { aberto: true, expiraEm: TS + 60 * 60_000 }
    }
    relatorio = criarRelatorioPeriodico({
      canal,
      log,
      audit: { append: (): void => {} },
      now: () => clock.now(),
      scheduler,
      estado,
      intervaloMs: INTERVALO,
    })
    relatorio.iniciar()
    scheduler.runLast()

    assert.equal(enviadas.length, 1, 'o ciclo em voo completa o envio best-effort')
    assert.equal(scheduler.pending.length, 0, 'reagendar re-verificou disposed e NAO agendou')
    relatorio.disposer()
  })

  it('iniciar depois do disposer e no-op; iniciar repetido agenda uma vez so', () => {
    const b = bancada(() => ({ aberto: true, expiraEm: TS + 60 * 60_000 }))
    b.relatorio.iniciar()
    b.relatorio.iniciar()
    assert.equal(b.scheduler.scheduled.length, 1, 'idempotente')

    b.relatorio.disposer()
    b.relatorio.iniciar()
    assert.equal(b.scheduler.pending.length, 0, 'depois de desmontar, iniciar nao ressuscita')
  })
})

/* ========================================================================== */
/* 5. SEC-14 ESTENDIDO — o segredo PERMANENTE nunca sai em payload             */
/* ========================================================================== */

/**
 * OITO codificacoes — o padrao herdado de `test/unit/proc/ipc-segredo.test.ts`.
 * Cada uma e uma forma em que um segredo ja escapou de sistemas reais.
 */
function codificacoes(valor: string): ReadonlyArray<readonly [string, string]> {
  const bytes = Buffer.from(valor, 'utf8')
  return [
    ['literal', valor],
    ['minusculas', valor.toLowerCase()],
    ['maiusculas', valor.toUpperCase()],
    ['base64', bytes.toString('base64')],
    ['base64url', bytes.toString('base64url')],
    ['hex', bytes.toString('hex')],
    ['percent', encodeURIComponent(valor)],
    ['json-unicode', [...valor].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')],
  ]
}

/** Devolve a primeira codificacao do segredo encontrada no payload, ou undefined. */
function procurarFuga(payload: string, segredo: string): string | undefined {
  const alvo = payload.toLowerCase()
  for (const [forma, texto] of codificacoes(segredo)) {
    if (texto.length >= 8 && alvo.includes(texto.toLowerCase())) return forma
  }
  return undefined
}

describe('SEC-14 estendido (Onda 5): segredo conhecido, todos os caminhos de payload', () => {
  it('o detetor funciona: apanha um segredo plantado em cada codificacao', () => {
    const segredo = 'zk4m-7q2w-9f6t-3b8v-5n1r'
    for (const [forma, texto] of codificacoes(segredo)) {
      const fuga = procurarFuga(`{"v":1,"type":"notify","texto":"${texto}"}`, segredo)
      assert.notEqual(fuga, undefined, `detetor cego para ${forma}`)
    }
  })

  it('todos os caminhos que produzem payload: o segredo PERMANENTE nao aparece em nenhum', () => {
    const dir = makeTempStateDir()
    try {
      const store = createSecretStore({
        state: createFileStateStore(dir.statePath),
        sessions: { revokeAll: (): void => {} },
      })
      const segredo = canonicalizeSecret(store.provision().display.split('\n')[0]!)
      // O `mk` do link magico e PERMITIDO no payload de /acessar (D3); o
      // segredo permanente, nao — em codificacao nenhuma (SEC-14).
      const mk = 'mk_9aF3kQ7zR1tY5uI8oP2sD6gH4jK0lZ'

      const payloads: string[] = []
      const empurra = (mensagem: IpcMessageToWorker): void => {
        payloads.push(serializeIpcMessage(mensagem, 'to-worker'))
      }

      // toggle (ligar e desligar, com origem identificada)
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoTunelToggle({ evento: 'tunel_ligar:telegram:123', resultado: 'permitido' }, TS, URL_DO_TUNEL) })
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoTunelToggle({ evento: 'tunel_desligar:painel:a1b2c3d4', resultado: 'permitido' }, TS) })
      // notificacao (sessao nova)
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoSessaoNova({ evento: 'sessao_nova', resultado: 'permitido', sessao_id_hash: HASH }, TS) })
      // primeira falha da janela
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoAuthFalha({ evento: 'auth_falha_primeira_janela', resultado: 'negado', ip_normalizado: '203.0.113.7' }, TS) })
      // ttl expirado, modo restrito, magic suspeito
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoTTLExpirado({ evento: 'tunel_ttl_expirado:60min:timer', resultado: 'permitido' }, TS) })
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoModoRestrito({ evento: 'auth_modo_restrito', resultado: 'negado' }, TS) })
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoMagicSuspeito({ evento: 'magic.crawler-suspect', resultado: 'negado' }, TS) })
      // relatorio periodico
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoRelatorio(TS, TS + 23 * 60_000) })
      // /acessar — link magico: o `mk` e PERMITIDO, o segredo permanente nao
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: comporTextoLinkMagico(TS, URL_DO_TUNEL, mk, TS + 120_000) })
      // /status — a difusao de estado
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'state', state: 'READY', seq: 1, url: URL_DO_TUNEL, expiresAt: TS + 60 * 60_000 })
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'state', state: 'STOPPED', seq: 2 })
      // /rotacionar — o ack (a resposta do host a intencao)
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'ack', requestId: '01JQZ8Y7W6V5T4S3R2Q1P0N9M8', result: 'accepted', state: 'READY' })
      // erro — o vocabulario fechado de mensagens de erro
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'error', code: 'INTERNAL', message: 'Nao foi possivel processar o pedido. Tente novamente.' })
      // pairing.challenge — o digest (S3-b: nem o digest do codigo sai da maquina)
      empurra({ v: IPC_PROTOCOL_VERSION, type: 'pairing.challenge', digest: 'a'.repeat(64), expiresAt: TS })

      assert.ok(payloads.length >= 13, `esperava todos os caminhos, achei ${String(payloads.length)}`)
      for (const payload of payloads) {
        const fuga = procurarFuga(payload, segredo)
        assert.equal(fuga, undefined, `fuga do segredo permanente (${String(fuga)}) em ${payload}`)
      }

      // E a outra metade do invariante: o `mk` ESTA no payload de /acessar —
      // sem ele o dono nao chega ao painel pelo celular.
      const acessar = payloads.find((payload) => payload.includes(`#mk=${mk}`))
      assert.ok(acessar !== undefined, 'o payload de /acessar carrega o mk no fragmento')
    } finally {
      dir.cleanup()
    }
  })
})
