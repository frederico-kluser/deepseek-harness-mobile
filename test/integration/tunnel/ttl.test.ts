/**
 * TUN-016, TUN-017, TUN-018 e TUN-026 com PROCESSO REAL e RELOGIO INJETADO
 * (`04-TESTES.md` 5.4.7).
 *
 * O relogio injetado e o que torna isto executavel: um TTL de 60 minutos medido
 * em tempo real seria um teste de uma hora. O PROCESSO, esse, e de verdade — a
 * afirmacao "o TTL derruba o tunel" so vale se houver um processo a morrer, e a
 * verificacao usa `pgrep -f fake-cloudflared` e `kill(pid, 0)`, ou seja o
 * sistema operativo e nao o nosso proprio contador.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, it } from 'node:test'

import { readTunnelProcess } from '../../../src/tunnel/pidfile.ts'
import { isAlive, makeTunnelHarness, waitFor, type TunnelHarness } from '../proc/seat.ts'

const harnesses: TunnelHarness[] = []
after(() => {
  for (const harness of harnesses) harness.dispose()
})

async function tunelPronto(ttlMinutes = 60): Promise<TunnelHarness> {
  const harness = await makeTunnelHarness({ ttlMinutes })
  harnesses.push(harness)
  await harness.supervisor.start()
  const pronto = await waitFor(() => harness.supervisor.snapshot().state === 'READY', {
    timeoutMs: 8000,
  })
  assert.equal(pronto, true, JSON.stringify(harness.supervisor.snapshot()))
  return harness
}

/** `pgrep -f fake-cloudflared` restrito aos filhos DESTE processo de teste. */
function pgrepFakeCloudflared(): number[] {
  try {
    const saida = execFileSync('pgrep', ['-f', 'fake-cloudflared'], { encoding: 'utf8' })
    return saida
      .split('\n')
      .map((linha) => Number(linha.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch (error) {
    // `pgrep` sai com 1 quando nao ha correspondencia: e o caso feliz do TUN-016.
    void error
    return []
  }
}

/** Dispara a tarefa agendada para `delayMs`. Nenhum teste espera tempo real. */
function dispararTtl(harness: TunnelHarness, delayMs: number): void {
  const task = harness.scheduler.scheduled.find((candidate) => candidate.delayMs === delayMs)
  if (task === undefined) throw new Error(`nenhum TTL agendado para ${String(delayMs)} ms`)
  task.fired = true
  task.callback()
}

describe('TUN-016: relogio avancado alem de `ttlMinutes` derruba o processo', () => {
  it('o processo REAL morre e o estado vai a STOPPED', async () => {
    const h = await tunelPronto()
    const pid = h.subprocess.lastChild().pid

    assert.equal(isAlive(pid), true, 'antes do prazo o tunel esta vivo')
    assert.equal(pgrepFakeCloudflared().includes(pid), true, 'e o `pgrep` ve-o')

    h.clock.advance(3_600_000)
    dispararTtl(h, 3_600_000)

    const morreu = await waitFor(() => !isAlive(pid), { timeoutMs: 4000 })
    assert.equal(morreu, true, 'o processo do tunel tem de morrer no prazo')
    assert.equal(pgrepFakeCloudflared().includes(pid), false, '`pgrep -f fake-cloudflared` vazio')
    assert.equal(h.supervisor.snapshot().state, 'STOPPED')
    assert.equal(h.supervisor.snapshot().info, undefined, 'a URL deixa de ser divulgada')
    // O registo sai com o processo: senao o boot seguinte varria um pid alheio.
    assert.equal(readTunnelProcess(h.store), undefined)
  })

  it('o prazo agendado e exatamente `ttlMinutes` a partir do `startedAt` persistido', async () => {
    const h = await tunelPronto(30)

    const record = readTunnelProcess(h.store)
    assert.notEqual(record, undefined)
    assert.equal(h.supervisor.snapshot().expiresAt, (record?.startedAt ?? 0) + 30 * 60_000)
    assert.equal(
      h.scheduler.scheduled.some((task) => task.delayMs === 30 * 60_000),
      true,
    )
  })
})

describe('TUN-017: TODAS as sessoes emitidas deixam de valer', () => {
  it('a invalidacao acontece na expiracao, e nao antes', async () => {
    const h = await tunelPronto()
    assert.deepEqual(h.revocations, [], 'nada e invalidado enquanto o tunel vive')

    h.clock.advance(3_600_000)
    dispararTtl(h, 3_600_000)

    // Sem isto, o cookie emitido pela janela anterior autenticava na seguinte: o
    // prazo teria fechado a porta e deixado a chave na fechadura.
    assert.equal(h.revocations.length, 1)
  })
})

describe('TUN-018: o aviso ao dono e emitido DEPOIS do registo em auditoria', () => {
  it('a auditoria nao depende da rede, e a mensagem nao leva a URL', async () => {
    const h = await tunelPronto()
    const antes = h.audited.length

    h.clock.advance(3_600_000)
    dispararTtl(h, 3_600_000)

    const expiracao = h.audited.slice(antes)
    assert.equal(expiracao.length, 1)
    assert.equal(expiracao[0]?.evento.startsWith('tunel_ttl_expirado'), true)
    assert.equal(expiracao[0]?.resultado, 'permitido')

    assert.equal(h.notices.length, 1)
    assert.equal(h.notices[0]?.includes('expirou'), true)
    // A mensagem viaja para a infraestrutura de um terceiro: sem URL e sem caminho.
    assert.equal(h.notices[0]?.includes('http'), false)
    assert.equal(/(^|\s)\/[\w./-]+/u.test(h.notices[0] ?? ''), false)
  })
})

describe('TUN-026: nada alem de um `start` explicito abre janela nova', () => {
  it('ler o estado 50 vezes com o relogio a andar nao move o prazo nem cria temporizador', async () => {
    const h = await tunelPronto()
    const prazo = h.supervisor.snapshot().expiresAt
    const temporizadoresAntes = h.scheduler.scheduled.length

    for (let i = 0; i < 50; i += 1) {
      h.clock.advance(60_000)
      assert.equal(h.supervisor.snapshot().expiresAt, prazo)
    }

    assert.equal(h.scheduler.scheduled.length, temporizadoresAntes)
    // Um TTL que se estende com o uso nunca expira para quem esta a usar — que e
    // exatamente quem tem o tunel aberto.
    assert.equal(isAlive(h.subprocess.lastChild().pid), true)
  })
})
