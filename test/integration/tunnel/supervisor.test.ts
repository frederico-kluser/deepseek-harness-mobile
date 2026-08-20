/**
 * Ciclo de vida do tunel com o dublê CONGELADO e processos REAIS
 * (`04-TESTES.md` 5.4.3).
 *
 * O `cloudflared` verdadeiro NAO entra aqui, nem local, nem em CI, nem no gate
 * (D10): `cloudflared --url http://localhost:PORTA` publica na Internet o que
 * estiver naquela porta, e foi assim que a pesquisa expos o DSH real do
 * utilizador durante ~40 segundos. O executavel e `test/bin/fake-cloudflared.mjs`,
 * e a origem e um servidor que o proprio teste abriu numa porta efemera.
 *
 * NOTA sobre o dublê: ele NAO tem os modos `--fake=` que `04-TESTES.md` 5.4.1
 * descreve (divergencia doc-codigo registada para o COMMIT PREP 4). A sua
 * interface real e por ambiente: `FAKE_CF_HOSTNAME`, `FAKE_CF_URL_DELAY_MS`,
 * `FAKE_CF_READY_AFTER_MS`. Os cenarios de queda vivem em
 * `test/integration/proc/lifecycle.test.ts`, construidos com processos proprios.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { readTunnelProcess } from '../../../src/tunnel/pidfile.ts'
import { isAlive, makeTunnelHarness, waitFor, type TunnelHarness } from '../proc/seat.ts'

const harnesses: TunnelHarness[] = []
after(() => {
  for (const harness of harnesses) harness.dispose()
})

async function novo(options: Parameters<typeof makeTunnelHarness>[0] = {}): Promise<TunnelHarness> {
  const harness = await makeTunnelHarness(options)
  harnesses.push(harness)
  return harness
}

describe('subida real: probe -> spawn -> URL -> READY', () => {
  it('o processo sobe, a URL vem do servidor de metricas na porta que NOS fixamos, e o estado vai a READY', async () => {
    const h = await novo()

    const inicial = await h.supervisor.start()
    assert.equal(inicial.state, 'STARTING')

    const pronto = await waitFor(() => h.supervisor.snapshot().state === 'READY', { timeoutMs: 8000 })
    assert.equal(pronto, true, JSON.stringify(h.supervisor.snapshot()))

    const snapshot = h.supervisor.snapshot()
    assert.equal(snapshot.info?.url.startsWith('https://'), true)
    assert.equal(snapshot.info?.url.includes('trycloudflare.com'), true)
    assert.equal(snapshot.info?.mode, 'quick')
    // TUN-011 medido: a URL so pode ter vindo da porta que passamos em
    // `--metrics`, porque foi ela que a descoberta interrogou.
    assert.equal(h.subprocess.calls[0]?.argv.includes(`127.0.0.1:${String(h.metricsPort)}`), true)
  })

  it('TUN-011 / TUN-013 / TUN-014: o argv efetivo do processo real e o argv seguro', async () => {
    const h = await novo()
    await h.supervisor.start()

    const argv = h.subprocess.calls[0]?.argv ?? []
    const flat = argv.join(' ')

    assert.equal(flat.includes(`--metrics 127.0.0.1:${String(h.metricsPort)}`), true)
    assert.equal(flat.includes('--loglevel debug'), false)
    assert.equal(flat.includes('--loglevel trace'), false)
    assert.equal(argv.includes('--token'), false)
    assert.equal(flat.includes('--no-autoupdate'), true)
    // A origem e a porta do servidor que ESTE teste abriu, e mais nenhuma.
    assert.equal(flat.includes(`http://127.0.0.1:${String(h.originPort)}`), true)
    assert.notEqual(h.originPort, 3080)
  })

  it('SUP-015: `graceMs` explicito e `AbortSignal` no spec do processo real', async () => {
    const h = await novo()
    await h.supervisor.start()

    assert.equal(h.subprocess.calls[0]?.graceMs, 3000)
    assert.equal(h.subprocess.calls[0]?.signal instanceof AbortSignal, true)
    assert.deepEqual(h.subprocess.calls[0]?.stdio, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  })

  it('o pidfile guarda o pid REAL do processo, e nunca a URL', async () => {
    const h = await novo()
    await h.supervisor.start()
    await waitFor(() => h.supervisor.snapshot().state === 'READY', { timeoutMs: 8000 })

    const record = readTunnelProcess(h.store)
    assert.notEqual(record, undefined)
    assert.equal(record?.pid, h.subprocess.lastChild().pid)
    assert.equal(isAlive(record?.pid ?? -1), true, 'o pid registado tem de estar vivo')

    // A URL do quick tunnel e efemera: um valor velho entregaria um link morto.
    const persisted = JSON.stringify(h.store.read())
    assert.equal(persisted.includes('trycloudflare'), false)
    assert.equal(persisted.includes('https://'), false)
  })
})

describe('paragem: o processo morre mesmo, e o registo sai com ele', () => {
  it('`stop()` derruba a arvore e limpa o pidfile', async () => {
    const h = await novo()
    await h.supervisor.start()
    await waitFor(() => h.supervisor.snapshot().state === 'READY', { timeoutMs: 8000 })
    const pid = h.subprocess.lastChild().pid

    h.supervisor.stop()

    const morreu = await waitFor(() => !isAlive(pid), { timeoutMs: 4000 })
    assert.equal(morreu, true, 'o processo real tem de morrer')
    assert.equal(h.supervisor.snapshot().state, 'STOPPED')
    assert.equal(readTunnelProcess(h.store), undefined)
  })

  it('o disposer e SINCRONO, idempotente, e derruba o processo real', async () => {
    const h = await novo()
    await h.supervisor.start()
    await waitFor(() => h.subprocess.calls.length === 1)
    const pid = h.subprocess.lastChild().pid

    const resultado: unknown = h.supervisor.dispose()
    h.supervisor.dispose()
    h.supervisor.dispose()

    assert.equal(resultado, undefined, 'Q-2: o disposer nao pode devolver thenable')
    assert.equal(await waitFor(() => !isAlive(pid), { timeoutMs: 4000 }), true)
  })
})

describe('o probe reprovado NAO chega a spawnar processo nenhum', () => {
  it('com o gate desarmado (200) nao ha processo real na maquina', async () => {
    const h = await novo({ probeStatus: 200 })

    const snapshot = await h.supervisor.start()

    // >>> A prova pedida pela pergunta falsificavel 6, agora com processos reais.
    assert.equal(h.subprocess.calls.length, 0)
    assert.equal(h.subprocess.children.length, 0)
    assert.equal(snapshot.state, 'FAILED')
    assert.equal(snapshot.failure?.code, 'PROBE_FAILED')
    assert.equal(readTunnelProcess(h.store), undefined)
  })
})
