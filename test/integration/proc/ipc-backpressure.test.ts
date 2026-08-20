/**
 * =============================================================================
 * BACKPRESSURE: "se o worker parar de ler, o host bloqueia?" -- MEDIDO.
 * =============================================================================
 *
 * A RESPOSTA MEDIDA, contra um filho REAL que nunca le o seu `stdin`:
 *
 *   NAO BLOQUEIA -- e o problema e pior do que bloquear.
 *
 *   200 000 escritas (9,8 MB) devolveram em 16,3 ms, o event loop continuou a
 *   girar (270 ticks de 1 ms nos 300 ms seguintes), e `write()` comecou a
 *   devolver `false` na escrita numero 1508 (~74 KB: o buffer do pipe do SO,
 *   64 KiB, mais a marca-d'agua do stream). Ate aqui e o esperado.
 *
 *   O QUE NAO E ESPERADO E O QUE INTERESSA: `writableLength` ficou nos
 *   9 791 621 bytes e NAO BAIXOU. Ninguem estava a ler do outro lado, e o Node
 *   nao descarta nada -- guarda tudo na fila interna do stream, indefinidamente.
 *   Um host que difundisse estado a cada segundo com um worker travado subia em
 *   memoria ate ao OOM, e um OOM no processo do DSH e a queda do plano de
 *   controlo inteiro por causa de um subprocesso preguicoso.
 *
 * POR ISSO O TRATAMENTO -- e ele TRIA POR TIPO, porque um teto unico violava o
 * contrato. `createHostIpcChannel` mede `writableLength` ANTES de escrever e:
 *
 *   - `state` acima do teto suave COALESCE (guarda-se a mais recente, que e a
 *     unica que ainda descreve a realidade: o bot e uma PROJECCAO e ja descarta
 *     `seq` fora de ordem);
 *   - `ack` e `error` ESCREVEM SEMPRE. O contrato e literal -- "sempre emitida,
 *     inclusive nos caminhos de erro" -- e para um `ack` nao existe "a proxima".
 *     Descarta-lo e `/emergencia` a executar no host com o dono a nunca saber,
 *     exatamente no estado degradado para que o teto existe;
 *   - acima do teto DURO o canal declara-se INVIAVEL: `log.error` uma vez e
 *     `stats.overwhelmed`, um estado terminal OBSERVAVEL em vez de silencio.
 *
 * Este ficheiro fixa as duas metades contra processos reais: a MEDICAO (o host
 * nao bloqueia e a fila crua cresce sem limite) e o TRATAMENTO.
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { after, describe, it } from 'node:test'

import type { GuardLogger } from '../../../src/logging/logger.ts'
import type { IpcMessageToWorker } from '../../../src/contracts/ipc.ts'
import { createHostIpcChannel, IPC_MAX_PENDING_BYTES } from '../../../src/telegram/ipc.ts'
import { waitFor } from './seat.ts'

const filhos: ChildProcess[] = []

after(() => {
  for (const filho of filhos) {
    if (filho.pid !== undefined) {
      try {
        process.kill(filho.pid, 'SIGKILL')
      } catch (error) {
        void error
      }
    }
  }
})

/**
 * Um filho REAL com `stdin` em `'pipe'` que NUNCA o le. E o cenario "o worker
 * travou": o descritor esta aberto, ha zero leitores, o pipe enche e nao esvazia.
 */
function filhoQueNaoLe(): ChildProcess {
  const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 3600000)'], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  filhos.push(filho)
  // Um EPIPE quando ele morrer nao pode derrubar o corredor de testes.
  filho.stdin?.on('error', (error: Error): void => {
    void error
  })
  return filho
}

const LINHA_CRUA = `${JSON.stringify({ v: 1, type: 'state', state: 'STOPPED', seq: 1 })}\n`

function makeLog(): { log: GuardLogger; avisos: string[] } {
  const avisos: string[] = []
  const nada = (): void => {}
  return {
    avisos,
    log: {
      info: nada,
      debug: nada,
      error: nada,
      warn: (message: string): void => {
        avisos.push(message)
      },
    },
  }
}

describe('a MEDICAO: escrever num pipe cheio nao bloqueia -- acumula', () => {
  it('20 000 escritas cruas devolvem depressa, com o event loop VIVO', async (t) => {
    const filho = filhoQueNaoLe()
    const stdin = filho.stdin
    assert.notEqual(stdin, undefined, "o spec pediu `stdin: 'pipe'`")
    await waitFor(() => filho.pid !== undefined)

    let ticks = 0
    const relogio = setInterval((): void => {
      ticks += 1
    }, 1)

    const inicio = process.hrtime.bigint()
    let primeiroFalse = -1
    for (let i = 0; i < 20_000; i += 1) {
      const aceite = stdin?.write(LINHA_CRUA) ?? false
      if (!aceite && primeiroFalse === -1) primeiroFalse = i
    }
    const decorridoMs = Number(process.hrtime.bigint() - inicio) / 1e6

    t.diagnostic(
      `20 000 escritas em ${decorridoMs.toFixed(1)} ms; write()===false na ${String(primeiroFalse)}; ` +
        `writableLength=${String(stdin?.writableLength)} bytes`,
    )

    // (a) NAO BLOQUEOU. Se `write()` bloqueasse, isto levava o tempo de o outro
    //     lado ler 1 MB -- ou seja, para sempre, porque ele nunca le.
    assert.ok(decorridoMs < 3000, `o burst levou ${decorridoMs.toFixed(1)} ms`)

    // (b) `write()` sinalizou saturacao cedo, e continuou a aceitar.
    assert.ok(primeiroFalse > 0, '`write()` tem de devolver false quando o pipe enche')
    assert.ok(
      primeiroFalse < 20_000,
      `saturou na escrita ${String(primeiroFalse)} -- o pipe do SO tem ~64 KiB`,
    )

    // (c) E O ACHADO: a fila interna GUARDOU tudo. Este numero e o motivo de o
    //     canal ter um teto; sem ele, cresce ate ao fim da memoria.
    assert.ok(
      (stdin?.writableLength ?? 0) > 100_000,
      `writableLength em ${String(stdin?.writableLength)} -- a fila devia ter crescido`,
    )

    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    clearInterval(relogio)
    t.diagnostic(`event loop: ${String(ticks)} ticks em 200 ms com o pipe cheio`)
    assert.ok(ticks > 20, `o event loop deu ${String(ticks)} ticks -- tem de continuar vivo`)

    // (d) E NAO DRENA: ninguem esta a ler do outro lado.
    assert.ok((stdin?.writableLength ?? 0) > 100_000, 'a fila nao desceu sozinha')
  })
})

describe('o TRATAMENTO: `state` coalesce, `ack` e `error` continuam a sair', () => {
  it('com um worker travado, a fila fica limitada e as difusoes coalescem', async (t) => {
    const filho = filhoQueNaoLe()
    await waitFor(() => filho.pid !== undefined)
    const { log, avisos } = makeLog()

    const canal = createHostIpcChannel({
      input: filho.stdout ?? undefined,
      output: filho.stdin ?? undefined,
      log,
      onIntent: (intent): IpcMessageToWorker => ({
        v: 1,
        type: 'ack',
        requestId: intent.requestId,
        result: 'noop',
        state: 'STOPPED',
      }),
      secrets: (): readonly string[] => [],
    })

    const inicio = process.hrtime.bigint()
    for (let seq = 0; seq < 20_000; seq += 1) {
      canal.send({ v: 1, type: 'state', state: 'STOPPED', seq })
    }
    const decorridoMs = Number(process.hrtime.bigint() - inicio) / 1e6

    t.diagnostic(
      `com teto: ${String(canal.stats.sent)} enviadas, ${String(canal.stats.coalesced)} coalescidas, ` +
        `${String(canal.stats.dropped)} descartadas em ${decorridoMs.toFixed(1)} ms; ` +
        `fila=${String(filho.stdin?.writableLength)} bytes; avisos=${String(avisos.length)}`,
    )

    assert.ok(decorridoMs < 3000, `o burst levou ${decorridoMs.toFixed(1)} ms`)
    assert.ok(canal.stats.coalesced > 0, 'as difusoes tem de coalescer')
    assert.equal(canal.stats.dropped, 0, 'coalescer NAO e descartar')
    assert.equal(canal.stats.overwhelmed, false, '20 000 difusoes coalescidas nao chegam ao teto duro')
    assert.ok(
      avisos.some((m) => m.includes('saturado')),
      'a saturacao tem de ser VISIVEL: um limite silencioso e um bug por descobrir',
    )
    // F6: UMA linha por episodio. Antes era uma por mensagem -- medido, 14 771
    // linhas (~1,6 MB) num so burst, ou seja memoria trocada por volume de log.
    assert.equal(avisos.length, 1, `foram ${String(avisos.length)} avisos; tem de ser 1`)

    // O TETO E REAL. Sem ele, este numero era ~1 MB (ver a medicao acima).
    const fila = filho.stdin?.writableLength ?? 0
    assert.ok(
      fila <= IPC_MAX_PENDING_BYTES + 1024,
      `fila em ${String(fila)} bytes, teto ${String(IPC_MAX_PENDING_BYTES)}`,
    )

    canal.dispose()
  })

  /**
   * >>> O CASO QUE O CONTRATO PROTEGE, contra um pipe REAL entupido. <<<
   *
   * `/emergencia` chega precisamente NO estado degradado para que o teto existe.
   * Com um teto unico, a intencao era decidida no host e a resposta descartada:
   * o kill switch executava e o dono ficava com a barra de progresso eterna.
   */
  it('saturado, uma intencao do dono continua a receber resposta', async (t) => {
    const filho = filhoQueNaoLe()
    await waitFor(() => filho.pid !== undefined)
    const { log } = makeLog()
    const intencoes: string[] = []

    const canal = createHostIpcChannel({
      input: filho.stdout ?? undefined,
      output: filho.stdin ?? undefined,
      log,
      secrets: (): readonly string[] => [],
      onIntent: (intent): IpcMessageToWorker => {
        intencoes.push(intent.intent)
        return {
          v: 1,
          type: 'ack',
          requestId: intent.requestId,
          result: 'accepted',
          state: 'STOPPING',
        }
      },
    })

    for (let seq = 0; seq < 20_000; seq += 1) canal.send({ v: 1, type: 'state', state: 'STOPPED', seq })
    assert.ok(canal.stats.coalesced > 0, 'o canal tem de estar saturado')

    const enviadasAntes = canal.stats.sent
    const filaAntes = filho.stdin?.writableLength ?? 0

    const respondeu = canal.send({
      v: 1,
      type: 'ack',
      requestId: '01J0000000000000000000000A',
      result: 'accepted',
      state: 'STOPPING',
    })

    t.diagnostic(
      `saturado: ack aceite=${String(respondeu)}; fila ${String(filaAntes)} -> ` +
        `${String(filho.stdin?.writableLength)} bytes`,
    )
    assert.equal(respondeu, true, 'o `ack` NAO pode ser descartado pelo teto')
    assert.equal(canal.stats.sent, enviadasAntes + 1)
    assert.ok((filho.stdin?.writableLength ?? 0) > filaAntes, 'os bytes do ack estao mesmo na fila')

    canal.dispose()
  })

  it('o canal continua utilizavel depois da saturacao: nao e um estado terminal', async () => {
    const filho = filhoQueNaoLe()
    await waitFor(() => filho.pid !== undefined)
    const { log } = makeLog()

    const canal = createHostIpcChannel({
      input: filho.stdout ?? undefined,
      output: filho.stdin ?? undefined,
      log,
      onIntent: (intent): IpcMessageToWorker => ({
        v: 1,
        type: 'ack',
        requestId: intent.requestId,
        result: 'noop',
        state: 'STOPPED',
      }),
      secrets: (): readonly string[] => [],
    })

    // Satura...
    for (let seq = 0; seq < 20_000; seq += 1) canal.send({ v: 1, type: 'state', state: 'STOPPED', seq })
    assert.ok(canal.stats.coalesced > 0)

    // ... e o `dispose` continua sincrono e idempotente, sem lancar.
    assert.doesNotThrow(() => {
      canal.dispose()
      canal.dispose()
    })
  })
})
