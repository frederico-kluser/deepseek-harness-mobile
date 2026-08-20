/**
 * O controlador de T5.1 contra o supervisor REAL de T3.1 (04-TESTES.md 5.6).
 *
 * As PERGUNTAS FALSIFICAVEIS da revisao, respondidas com processos reais:
 *
 *   1. Dois `start()` simultaneos (Telegram + painel, requestId distinto)
 *      criam DOIS cloudflared? -> CTL-018: um unico spawn.
 *   2. `stop()` durante STARTING deixa processo orfao? -> derruba a arvore.
 *   3. O estado e derivado do processo real? Mate o cloudflared por fora e veja
 *      convergir (CTL-025) — DEGRADED com orcamento, FAILED sem.
 *   4. FAILED -> STOPPED exige intervencao humana? -> so reset() (CTL-011/012).
 *   5. O disposer derruba tudo? -> zero processo vivo apos o dispose.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { ControlIntent } from '../../../src/contracts/control.ts'
import { isAlive, signalGroup, waitFor } from '../proc/seat.ts'
import { makeControlHarness, type ControlHarness } from './harness.ts'

const harnesses: ControlHarness[] = []
after(() => {
  for (const harness of harnesses) harness.dispose()
})

async function novo(options: Parameters<typeof makeControlHarness>[0] = {}): Promise<ControlHarness> {
  const harness = await makeControlHarness(options)
  harnesses.push(harness)
  return harness
}

let sequencia = 0
function intent(overrides: Partial<ControlIntent> = {}) {
  sequencia += 1
  return {
    action: 'start' as const,
    requestedBy: 'telegram:123',
    requestId: `int-${String(sequencia).padStart(4, '0')}`,
    at: 1_000,
    ...overrides,
  }
}

/** Sobe o tunel REAL ate o controlador ficar READY. */
async function subirAteReady(h: ControlHarness): Promise<void> {
  const resultado = await h.controlador.despachar(intent({ nonce: h.emitirNonce('start') }))
  assert.equal(resultado.estado, 'STARTING')
  const pronto = await waitFor(() => h.supervisor.snapshot().state === 'READY', { timeoutMs: 8000 })
  assert.equal(pronto, true, JSON.stringify(h.supervisor.snapshot()))
  h.rodarRepasse()
  assert.equal(h.controlador.snapshot().state, 'READY')
}

describe('CTL-033/034: o start de boot sobe o tunel REAL sem nonce (TENSAO-003)', () => {
  it('requestedBy boot, SEM nonce e com requerConfirmacao: true, spawna ate READY', async () => {
    const h = await novo()

    const resultado = await h.controlador.despachar(intent({ requestedBy: 'boot' }))

    assert.equal(resultado.recusa, undefined, 'a origem boot nao pode ser recusada por nonce ausente')
    assert.equal(resultado.estado, 'STARTING')

    const pronto = await waitFor(() => h.supervisor.snapshot().state === 'READY', { timeoutMs: 8000 })
    assert.equal(pronto, true, JSON.stringify(h.supervisor.snapshot()))
    h.rodarRepasse()
    assert.equal(h.controlador.snapshot().state, 'READY')
    assert.equal(h.subprocess.calls.length, 1, 'o spawn REAL aconteceu sem nenhum nonce')
    assert.equal(
      h.auditoria.some((e) => e.evento.includes('tunel_ligar:boot') && e.resultado === 'permitido'),
      true,
      'a origem do start de boot chega ao audit (CTL-031)',
    )
  })

  it('boot sem nonce nao contorna o probe: com o gate desarmado, FAILED sem spawn', async () => {
    const h = await novo({ probeStatus: 200 })

    const resultado = await h.controlador.despachar(intent({ requestedBy: 'boot' }))

    assert.equal(resultado.estado, 'FAILED', 'o probe fail-closed e pre-condicao tambem para o boot')
    assert.equal(h.subprocess.calls.length, 0, 'nenhum processo real na maquina')
  })
})

describe('CTL-018: start simultaneo das duas superficies -> UM UNICO spawn', () => {
  it('a corrida com requestId distinto nao cria um segundo cloudflared', async () => {
    const h = await novo()

    const telegram = h.controlador.despachar(intent({ requestId: 'corrida-telegram', nonce: h.emitirNonce('start') }))
    const painel = h.controlador.despachar(intent({ requestId: 'corrida-painel', nonce: h.emitirNonce('start') }))

    const r1 = await telegram
    const r2 = await painel
    assert.equal(r1.estado, 'STARTING')
    assert.equal(r2.estado, 'STARTING', 'a segunda intent e no-op idempotente')
    assert.equal(h.subprocess.calls.length, 1, 'UM UNICO cloudflared sob start() concorrente')

    // A promocao a READY: as duas superficies convergem para o mesmo estado.
    const pronto = await waitFor(() => h.supervisor.snapshot().state === 'READY', { timeoutMs: 8000 })
    assert.equal(pronto, true)
    h.rodarRepasse()
    assert.equal(h.controlador.snapshot().state, 'READY')
    assert.equal(h.controlador.snapshot().info?.url.startsWith('https://'), true)
    assert.equal(h.difusoes.at(-1)?.seq, h.controlador.snapshot().seq)
  })
})

describe('CTL-025: cloudflared morto por fora converge — nunca mente READY', () => {
  it('com orcamento, a morte externa leva o estado a DEGRADED', async () => {
    const h = await novo()
    await subirAteReady(h)

    const pid = h.subprocess.lastChild().pid
    signalGroup(pid, 'SIGKILL')

    const convergiu = await waitFor(() => h.supervisor.snapshot().state === 'DEGRADED', { timeoutMs: 4000 })
    assert.equal(convergiu, true, JSON.stringify(h.supervisor.snapshot()))
    h.rodarRepasse()
    assert.equal(h.controlador.snapshot().state, 'DEGRADED', 'converge, em vez de continuar a mentir READY')
    assert.equal(h.controlador.snapshot().info, undefined, 'a URL so existe em READY')
  })

  it('sem orcamento, a morte externa leva o estado a FAILED (terminal)', async () => {
    const h = await novo()
    await subirAteReady(h)

    // Esgota o orcamento: mata o processo e deixa o reinicio correr, ate o
    // supervisor declarar FAILED (DEFAULT_TUNNEL_BACKOFF: 10 tentativas).
    let convergiu = false
    for (let tentativa = 0; tentativa < 12; tentativa += 1) {
      if (h.supervisor.snapshot().state === 'FAILED') {
        convergiu = true
        break
      }
      const alvo = h.subprocess.lastChild().pid
      if (isAlive(alvo)) signalGroup(alvo, 'SIGKILL')
      // A MORTE do pid, nao o estado: o DEGRADED da iteracao anterior ainda
      // esta de pe, e esperar por ele retornaria antes de o fecho do processo
      // ser processado — e o reinicio so e agendado DEPOIS do fecho.
      const morreu = await waitFor(() => !isAlive(alvo), { timeoutMs: 4000 })
      assert.equal(morreu, true, `pid ${String(alvo)} tem de morrer`)
      const degradou = await waitFor(
        () => h.supervisor.snapshot().state === 'DEGRADED' || h.supervisor.snapshot().state === 'FAILED',
        { timeoutMs: 4000 },
      )
      assert.equal(degradou, true, JSON.stringify(h.supervisor.snapshot()))
      if (h.supervisor.snapshot().state === 'DEGRADED') {
        // O reinicio pendente (o ULTIMO agendado) dispara pelo agendador.
        h.scheduler.runLast()
        await waitFor(() => isAlive(h.subprocess.lastChild().pid), { timeoutMs: 4000 })
      }
    }
    assert.equal(convergiu, true, 'o orcamento tem de esgotar')
    h.rodarRepasse()
    assert.equal(h.controlador.snapshot().state, 'FAILED')
  })
})

describe('CTL-007: start durante STOPPING e rejeitado, nao enfileirado (D29)', () => {
  it('SHUTDOWN_IN_PROGRESS na chegada e nenhum spawn depois da paragem', async () => {
    const h = await novo()
    await subirAteReady(h)

    const paragem = await h.controlador.despachar(intent({ action: 'stop' }))
    assert.equal(paragem.estado, 'STOPPING')

    const rejeicao = await h.controlador.despachar(intent({ nonce: h.emitirNonce('start') }))
    assert.equal(rejeicao.recusa, 'SHUTDOWN_IN_PROGRESS')

    h.rodarRepasse()
    assert.equal(h.controlador.snapshot().state, 'STOPPED')
    const morreu = await waitFor(() => !isAlive(h.subprocess.lastChild().pid), { timeoutMs: 4000 })
    assert.equal(morreu, true, 'o processo morre de verdade')
    assert.equal(h.subprocess.calls.length, 1, 'o start rejeitado nao reconciliou spawn nenhum')
  })
})

describe('CTL-013: probe reprovado -> FAILED sem passar por STARTING', () => {
  it('com o gate desarmado nao ha spawn e nenhuma difusao observa STARTING', async () => {
    const h = await novo({ probeStatus: 200 })

    const resultado = await h.controlador.despachar(intent({ nonce: h.emitirNonce('start') }))

    assert.equal(resultado.estado, 'FAILED')
    assert.equal(h.subprocess.calls.length, 0, 'nenhum processo real na maquina')
    assert.equal(h.difusoes.some((d) => d.estado === 'STARTING'), false, 'CTL-013: sem STARTING')
  })
})

describe('CTL-011/012: FAILED e terminal — so o reset() humano sai', () => {
  it('o sistema nao se auto-cura; reset() abre caminho para um start novo', async () => {
    const h = await novo({ probeStatus: 200 })
    await h.controlador.despachar(intent({ nonce: h.emitirNonce('start') }))
    assert.equal(h.controlador.snapshot().state, 'FAILED')

    // start em FAILED e recusado, mesmo com nonce (CTL-011).
    const recusa = await h.controlador.despachar(intent({ nonce: h.emitirNonce('start') }))
    assert.equal(recusa.recusa, 'TERMINAL_SEM_RESET')

    // reset() com nonce: STOPPED (CTL-012).
    const reset = await h.controlador.despachar(intent({ action: 'reset', nonce: h.emitirNonce('reset') }))
    assert.equal(reset.estado, 'STOPPED')

    // E um start novo passa a funcionar: o probe deste harness e FIXO em 200
    // (gate desarmado), logo a subida reprova de novo — mas nao e RECUSADA:
    // o caminho esta aberto, o que prova que o reset destravou o terminal.
    const subida = await h.controlador.despachar(intent({ nonce: h.emitirNonce('start') }))
    assert.equal(subida.recusa, undefined, 'o reset abriu o caminho (nao ha TERMINAL_SEM_RESET)')
    assert.equal(subida.estado, 'FAILED', 'o probe (fixo em 200) reprova de novo')
  })
})

describe('stop durante STARTING nao deixa orfao (9.3)', () => {
  it('o down que chega a 5 ms do up serializa e a arvore morre inteira', async () => {
    const h = await novo()

    const up = h.controlador.despachar(intent({ nonce: h.emitirNonce('start') }))
    const down = h.controlador.despachar(intent({ action: 'stop' }))

    const resultadoUp = await up
    const resultadoDown = await down
    assert.equal(resultadoUp.estado, 'STARTING')
    assert.equal(resultadoDown.estado, 'STOPPING', 'o down ve o STARTING, nunca o STOPPED')

    h.rodarRepasse()
    assert.equal(h.controlador.snapshot().state, 'STOPPED')
    assert.equal(h.controlador.snapshot().seq, 3, 'STARTING(1) -> STOPPING(2) -> STOPPED(3)')

    // Nenhum processo orfao: o pidfile foi limpo e nada ficou vivo.
    const morreu = await waitFor(
      () => h.subprocess.children.every((c) => !isAlive(c.pid)),
      { timeoutMs: 4000 },
    )
    assert.equal(morreu, true, 'nenhum processo cloudflared vivo apos a paragem')
    assert.equal(h.subprocess.calls.length, 1, 'um unico spawn em todo o ciclo')
  })
})

describe('seq monotonico e disposer (CTL-010, pergunta falsificavel 5)', () => {
  it('um ciclo completo avanca o seq estritamente', async () => {
    const h = await novo()
    await subirAteReady(h)
    await h.controlador.despachar(intent({ action: 'stop' }))
    h.rodarRepasse()
    await waitFor(() => h.supervisor.snapshot().state === 'STOPPED')
    const seqs = h.difusoes.map((d) => d.seq)
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal(seqs[i]! > seqs[i - 1]!, true)
    }
  })

  it('o disposer do controlador derruba o supervisor e nao deixa processo vivo', async () => {
    const h = await novo()
    await subirAteReady(h)

    const pid = h.subprocess.lastChild().pid
    const resultado: unknown = h.controlador.dispose()
    assert.equal(resultado, undefined, 'Q-2: disposer sincrono')

    const morreu = await waitFor(() => !isAlive(pid), { timeoutMs: 4000 })
    assert.equal(morreu, true, 'o disposer derruba o cloudflared real')
  })
})
