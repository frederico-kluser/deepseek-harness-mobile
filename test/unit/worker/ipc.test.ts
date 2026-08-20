/**
 * `worker/ipc.ts` -- o lado WORKER do canal JSONL.
 *
 * TRES COISAS QUE SO AQUI PODEM SER PROVADAS:
 *
 *   1. O GATE DE EQUIVALENCIA. O codec esta DUPLICADO (o worker so pode importar
 *      `src/contracts/ipc.ts` de `src/`), e duplicacao sem gate e divergencia
 *      adiada. A tabela abaixo corre pelos DOIS analisadores e assere veredito
 *      identico -- e o que impede uma correccao de entrar num e nao no outro.
 *   2. O DEAD-MAN'S SWITCH, com streams injetados: EOF no `stdin` termina o
 *      worker. O tempo REAL disso e medido em
 *      `test/integration/proc/dead-mans-switch.test.ts`.
 *   3. S2: o `stdout` do worker so leva JSONL; TODO o texto humano vai para
 *      `stderr`. Violada, o pai ve ruido e o modo de falha e silencioso.
 */

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { describe, it } from 'node:test'

import type { IpcIntentMessage, IpcMessageToWorker } from '../../../src/contracts/ipc.ts'
import { WORKER_IPC_ENV_MARK } from '../../../src/proc/env.ts'
import {
  parseIpcLine as parseHost,
  serializeIpcMessage as serializeHost,
  validateIpcMessage as validateHost,
  type IpcDirection,
} from '../../../src/telegram/ipc.ts'
import {
  bindWorkerIpcToProcess,
  createWorkerIpc,
  createWorkerLineDecoder,
  DEAD_MANS_SWITCH_EXIT_CODE,
  parseWorkerIpcLine,
  serializeWorkerIpcMessage,
  validateWorkerIpcMessage,
  WORKER_IPC_ENV_VAR,
  type WorkerIpc,
} from '../../../worker/ipc.ts'

/**
 * `Readable.end()` emite `'end'` no tick SEGUINTE -- e o EOF real de um pipe
 * tambem chega assim. Sem esta espera o teste media o estado ANTES do evento.
 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

const INTENCAO: IpcIntentMessage = {
  v: 1,
  type: 'intent',
  intent: 'tunnel.up',
  requestId: '01J0000000000000000000000A',
  from: 123456789,
  chat: 987654321,
}

/* ========================================================================== */
/* Bancada                                                                    */
/* ========================================================================== */

interface Bancada {
  ipc: WorkerIpc
  /** `stdin` do worker: o teste escreve aqui o que o host "diz". */
  entrada: PassThrough
  stdout(): string
  stderr(): string
  recebidas: IpcMessageToWorker[]
  desligamentos: string[]
}

function montar(options: { onMessage?: (m: IpcMessageToWorker) => void; env?: NodeJS.ProcessEnv } = {}): Bancada {
  const entrada = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const recebidas: IpcMessageToWorker[] = []
  const desligamentos: string[] = []

  const ipc = createWorkerIpc({
    input: entrada,
    output: stdout,
    diagnostics: stderr,
    ...(options.env === undefined ? {} : { env: options.env }),
    onMessage: (message): void => {
      recebidas.push(message)
      options.onMessage?.(message)
    },
    onDisconnect: (reason): void => {
      desligamentos.push(reason)
    },
  })

  return {
    ipc,
    entrada,
    recebidas,
    desligamentos,
    stdout: (): string => stdout.read()?.toString() ?? '',
    stderr: (): string => stderr.read()?.toString() ?? '',
  }
}

/* ========================================================================== */
/* 1. O GATE DE EQUIVALENCIA                                                  */
/* ========================================================================== */

describe('os DOIS analisadores dao o MESMO veredito (a duplicacao esta presa)', () => {
  /**
   * Tabela deliberadamente larga: forma valida, forma quase-valida, e todas as
   * quatro razoes de recusa do contrato. Cada entrada corre nos DOIS sentidos.
   */
  const LINHAS: readonly string[] = [
    // Validas em algum dos sentidos.
    JSON.stringify(INTENCAO),
    JSON.stringify({ ...INTENCAO, nonce: '01JNONCE' }),
    '{"v":1,"type":"state","state":"STOPPED","seq":0}',
    '{"v":1,"type":"state","state":"READY","seq":9,"url":"https://x.trycloudflare.com","expiresAt":1}',
    '{"v":1,"type":"ack","requestId":"r","result":"noop","state":"READY"}',
    '{"v":1,"type":"ack","requestId":"r","result":"rejected","state":"STOPPING","code":"SHUTDOWN_IN_PROGRESS"}',
    '{"v":1,"type":"error","code":"RATE_LIMITED","message":"devagar"}',
    // PREP 5: as duas mensagens novas, validas no sentido host -> worker.
    '{"v":1,"type":"notify","texto":"o tunel expira em 5 minutos"}',
    '{"v":1,"type":"notify","texto":"linha 1\nlinha 2"}',
    '{"v":1,"type":"pairing.challenge","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":1}',
    // Recusadas.
    '',
    '   ',
    'null',
    'true',
    '42',
    '"texto"',
    '[]',
    '[{"v":1,"type":"intent"}]',
    '{',
    '{"v":1,"type":"inte',
    '{"v":0,"type":"intent"}',
    '{"v":2,"type":"state","state":"READY","seq":1}',
    '{"v":"1","type":"state","state":"READY","seq":1}',
    '{"type":"state","state":"READY","seq":1}',
    '{"v":1}',
    '{"v":1,"type":"notify","text":"do PREP 5"}',
    '{"v":1,"type":"notify","texto":""}',
    '{"v":1,"type":"notify","texto":"com controlo \u0007"}',
    '{"v":1,"type":"notify","texto":42}',
    '{"v":1,"type":"pairing.challenge","code":"123456"}',
    '{"v":1,"type":"pairing.challenge","digest":"curto","expiresAt":1}',
    '{"v":1,"type":"pairing.challenge","digest":"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg","expiresAt":1}',
    '{"v":1,"type":"pairing.challenge","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    '{"v":1,"type":"pairing.challenge","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":"amanha"}',
    '{"v":1,"type":"intent","intent":"shutdown","requestId":"r","from":1,"chat":1}',
    '{"v":1,"type":"intent","intent":"emergency","requestId":"","from":1,"chat":1}',
    '{"v":1,"type":"intent","intent":"emergency","requestId":"r","from":"@dono","chat":1}',
    '{"v":1,"type":"intent","intent":"emergency","requestId":"r","from":1,"chat":1.25}',
    '{"v":1,"type":"state","state":"PRONTO","seq":1}',
    '{"v":1,"type":"state","state":"READY","seq":"9","url":"https://x.com","expiresAt":1}',
    '{"v":1,"type":"state","state":"STARTING","seq":1,"url":"https://x.com","expiresAt":1}',
    '{"v":1,"type":"state","state":"READY","seq":1,"url":"http://x.com","expiresAt":1}',
    '{"v":1,"type":"ack","requestId":"r","result":"talvez","state":"READY"}',
    '{"v":1,"type":"ack","requestId":"r","result":"accepted","state":"READY","code":"INTERNAL"}',
    '{"v":1,"type":"error","code":"NAO_EXISTE","message":"x"}',
    '{"v":1,"type":"error","code":"INTERNAL"}',
    '{"v":1,"type":"error","code":"INTERNAL","message":""}',
  ]

  const SENTIDOS: readonly IpcDirection[] = ['to-host', 'to-worker']

  for (const direction of SENTIDOS) {
    it(`veredito identico em ${direction} para as ${String(LINHAS.length)} linhas da tabela`, () => {
      for (const linha of LINHAS) {
        assert.deepEqual(
          parseWorkerIpcLine(linha, direction),
          parseHost(linha, direction),
          `divergiram em ${direction}: ${linha}`,
        )
      }
    })

    it(`validacao identica em ${direction} sobre valores ja desserializados`, () => {
      for (const linha of LINHAS) {
        let valor: unknown
        try {
          valor = JSON.parse(linha)
        } catch {
          continue
        }
        assert.deepEqual(
          validateWorkerIpcMessage(valor, direction),
          validateHost(valor, direction),
          `divergiram em ${direction}: ${linha}`,
        )
      }
    })
  }

  it('as duas serializacoes produzem BYTE A BYTE a mesma linha', () => {
    const amostras: ReadonlyArray<[IpcMessageToWorker | IpcIntentMessage, IpcDirection]> = [
      [INTENCAO, 'to-host'],
      [{ ...INTENCAO, nonce: 'opaco' }, 'to-host'],
      [{ v: 1, type: 'state', state: 'READY', seq: 3, url: 'https://x.trycloudflare.com', expiresAt: 7 }, 'to-worker'],
      [{ v: 1, type: 'ack', requestId: 'r', result: 'rejected', state: 'STOPPING', code: 'RESTRICTED_MODE' }, 'to-worker'],
      [{ v: 1, type: 'error', code: 'INTERNAL', message: 'a\nb' }, 'to-worker'],
    ]
    for (const [message, direction] of amostras) {
      assert.equal(
        serializeWorkerIpcMessage(message, direction),
        serializeHost(message, direction),
        `divergiram em ${direction}`,
      )
    }
  })

  it('a marca de ambiente e a MESMA constante dos dois lados', () => {
    // Duplicada por fronteira de modulo (o worker nao pode importar
    // `src/proc/env.ts`); presa por este teste em vez de por uma promessa.
    assert.equal(WORKER_IPC_ENV_VAR, WORKER_IPC_ENV_MARK)
  })
})

/* ========================================================================== */
/* 2. O DEAD-MAN'S SWITCH                                                     */
/* ========================================================================== */

describe("o dead-man's switch: EOF no stdin termina o worker", () => {
  it('o EOF chama `onDisconnect` UMA vez, com motivo `eof`', async () => {
    const b = montar()
    b.entrada.end()
    await flush()

    assert.deepEqual(b.desligamentos, ['eof'])
    assert.match(b.stderr(), /EOF no stdin.*dead-mans switch/u)
  })

  it("`'end'` e `'close'` juntos nao disparam o switch duas vezes", () => {
    const b = montar()
    b.entrada.emit('end')
    b.entrada.emit('close')
    b.entrada.emit('end')

    assert.deepEqual(b.desligamentos, ['eof'], 'accionado uma so vez')
  })

  it('um ERRO no stdin conta como desligamento -- a ligacao ao host quebrou', () => {
    const b = montar()
    b.entrada.emit('error', new Error('ECONNRESET'))

    assert.deepEqual(b.desligamentos, ['error'])
    assert.match(b.stderr(), /ECONNRESET/u)
  })

  it('um EPIPE no stdout tambem desliga: sem leitor nao ha canal', () => {
    const entrada = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const desligamentos: string[] = []
    createWorkerIpc({
      input: entrada,
      output: stdout,
      diagnostics: stderr,
      onMessage: (): void => {},
      onDisconnect: (reason): void => {
        desligamentos.push(reason)
      },
    })

    // Sem absorvedor, um `'error'` sem ouvinte LANCA e o worker morre com stack
    // trace em vez de sair pelo caminho previsto.
    assert.doesNotThrow(() => stdout.emit('error', new Error('EPIPE')))
    assert.deepEqual(desligamentos, ['error'])
  })

  it('depois de desligado, `send` nao volta a escrever no stdout', async () => {
    const b = montar()
    b.entrada.end()
    await flush()
    assert.equal(b.ipc.send(INTENCAO), false)
    assert.equal(b.stdout(), '')
  })

  it('`bindWorkerIpcToProcess` sai com o codigo do switch, e poe o stdin a fluir', async () => {
    const entrada = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const saidas: number[] = []

    const proc = {
      stdin: entrada,
      stdout,
      stderr,
      env: { [WORKER_IPC_ENV_VAR]: '1' },
      exit: (code: number): void => {
        saidas.push(code)
      },
    } as unknown as NodeJS.Process

    bindWorkerIpcToProcess(proc, { onMessage: (): void => {} })
    // `resume()` e o que faz o `'end'` chegar. Sem ele o EOF nunca dispara -- e
    // a falha seria invisivel: o worker continuaria a parecer saudavel.
    assert.equal(entrada.isPaused(), false, 'o stdin tem de estar a fluir')

    entrada.end()
    await flush()
    assert.deepEqual(saidas, [DEAD_MANS_SWITCH_EXIT_CODE])
  })

  it('F3: `pause()` no stdin NAO desarma o switch -- o canal contra-ataca', async () => {
    const entrada = new PassThrough()
    const saidas: number[] = []
    const proc = {
      stdin: entrada,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      env: { [WORKER_IPC_ENV_VAR]: '1' },
      exit: (code: number): void => {
        saidas.push(code)
      },
    } as unknown as NodeJS.Process

    bindWorkerIpcToProcess(proc, { onMessage: (): void => {} })

    // Uma linha perfeitamente normal em `worker/telegram-bot.ts` -- que e de
    // T4.2, nao desta sub-tarefa. Sem defesa, ela desarmava EM SILENCIO a unica
    // protecao que sobrevive a um SIGKILL no DSH: medido, o worker sobrevivia
    // indefinidamente ao host.
    entrada.pause()
    await flush()
    assert.equal(entrada.isPaused(), false, 'o canal tem de voltar a por o stdin a fluir')

    entrada.end()
    await flush()
    assert.deepEqual(saidas, [DEAD_MANS_SWITCH_EXIT_CODE])
  })

  it('F3: `dispose()` larga o LEITOR do protocolo, mas nao o switch', async () => {
    const entrada = new PassThrough()
    const saidas: number[] = []
    const proc = {
      stdin: entrada,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      env: { [WORKER_IPC_ENV_VAR]: '1' },
      exit: (code: number): void => {
        saidas.push(code)
      },
    } as unknown as NodeJS.Process

    const ipc = bindWorkerIpcToProcess(proc, { onMessage: (): void => {} })
    ipc.dispose()

    // `dispose()` e uma operacao do CANAL; o dead-mans switch e o contrato de
    // sobrevivencia do PROCESSO. Enquanto ele existir, a morte do host tem de o
    // levar junto -- senao fica a falar com a internet sem supervisor.
    entrada.end()
    await flush()
    assert.deepEqual(saidas, [DEAD_MANS_SWITCH_EXIT_CODE])
  })

  it('sem a marca de ambiente, avisa em stderr e continua armado', async () => {
    const b = montar({ env: {} })
    assert.match(b.stderr(), new RegExp(`${WORKER_IPC_ENV_VAR} ausente`, 'u'))

    b.entrada.end()
    await flush()
    assert.deepEqual(b.desligamentos, ['eof'], 'o switch NAO depende da marca')
  })
})

/* ========================================================================== */
/* 3. S2 -- disciplina de fluxo                                               */
/* ========================================================================== */

describe('S2: stdout so leva JSONL; todo o texto humano vai para stderr', () => {
  it('`log()` escreve em stderr e NAO toca no stdout', () => {
    const b = montar()
    b.ipc.log('a sondar updates')

    assert.equal(b.stdout(), '', 'nada de humano no stdout')
    assert.match(b.stderr(), /a sondar updates/u)
  })

  it('tudo o que sai no stdout e uma linha JSON valida do protocolo', () => {
    const b = montar()
    b.ipc.log('ruido antes')
    b.ipc.send(INTENCAO)
    b.ipc.log('ruido depois')
    // Uma linha malformada do host tambem produz log -- e ele nao pode ir para
    // o stdout, porque o pai le o stdout como protocolo.
    b.entrada.write('{lixo\n')
    b.ipc.send({ ...INTENCAO, requestId: 'r2', intent: 'emergency' })

    const linhas = b.stdout().split('\n').filter((l) => l !== '')
    assert.equal(linhas.length, 2)
    for (const linha of linhas) {
      assert.equal(parseHost(linha, 'to-host').ok, true, `nao e protocolo: ${linha}`)
    }
    assert.match(b.stderr(), /descartada \(json-invalido\)/u)
  })

  it('uma intencao invalida NAO chega ao stdout: o erro fica em stderr', () => {
    const b = montar()
    const invalida = { ...INTENCAO, from: 'nao-e-id' } as unknown as IpcIntentMessage

    assert.equal(b.ipc.send(invalida), false)
    assert.equal(b.stdout(), '')
    assert.match(b.stderr(), /IPC_MESSAGE_INVALID/u)
  })
})

/* ========================================================================== */
/* F5 -- o MESMO teto, no sentido inverso                                     */
/* ========================================================================== */

describe('backpressure worker -> host: recusa em vez de crescer sem limite', () => {
  /** `Writable` que nunca chama o `callback`: o host parou de ler. */
  function hostQueNaoLe(): Writable {
    return new Writable({ highWaterMark: 128, write: (): void => {} })
  }

  it('acima do teto, `send` devolve FALSE -- e nao finge que passou', () => {
    const entrada = new PassThrough()
    const stdout = hostQueNaoLe()
    const stderr = new PassThrough()

    const ipc = createWorkerIpc({
      input: entrada,
      output: stdout,
      diagnostics: stderr,
      onMessage: (): void => {},
      onDisconnect: (): void => {},
      maxPendingBytes: 256,
    })

    let aceites = 0
    let recusadas = 0
    for (let i = 0; i < 500; i += 1) {
      if (ipc.send({ ...INTENCAO, requestId: `r${String(i)}` })) aceites += 1
      else recusadas += 1
    }

    assert.ok(recusadas > 0, 'tem de recusar quando o host para de ler')
    assert.equal(aceites + recusadas, 500)
    /**
     * PORQUE NAO HA COALESCENCIA DESTE LADO, ao contrario do host: o que o
     * worker envia sao INTENCOES, e cada uma e uma accao do dono. Nao existe "a
     * proxima traz o mesmo" -- por isso a resposta e `false`, para que quem
     * chama tenha de dizer ao dono que o comando nao passou.
     */
    assert.ok(
      stdout.writableLength <= 256 + 256,
      `fila em ${String(stdout.writableLength)} -- sem teto media 1 668 418 bytes`,
    )
  })

  it('o aviso e UM por episodio, e ha resumo quando o host volta', () => {
    const entrada = new PassThrough()
    const pendentes: Array<() => void> = []
    let bloqueado = true
    const stdout = new Writable({
      highWaterMark: 128,
      write(_chunk, _encoding, callback): void {
        if (bloqueado) {
          pendentes.push(callback as () => void)
          return
        }
        callback()
      },
    })
    const stderr = new PassThrough()

    const ipc = createWorkerIpc({
      input: entrada,
      output: stdout,
      diagnostics: stderr,
      onMessage: (): void => {},
      onDisconnect: (): void => {},
      maxPendingBytes: 256,
    })

    for (let i = 0; i < 500; i += 1) ipc.send({ ...INTENCAO, requestId: `r${String(i)}` })
    bloqueado = false
    while (pendentes.length > 0) pendentes.shift()?.()
    ipc.send({ ...INTENCAO, requestId: 'depois' })

    const texto = stderr.read()?.toString() ?? ''
    const avisos = texto.split('\n').filter((linha: string) => linha.includes('o host parou de ler'))
    assert.equal(avisos.length, 1, 'uma linha por episodio, nao uma por mensagem')
    assert.match(texto, /o host voltou a ler; \d+ intencoes foram recusadas/u)
  })
})

/* ========================================================================== */
/* S4 e o acumulador, do lado do worker                                       */
/* ========================================================================== */

describe('S4 no worker: descarta a linha e sobrevive', () => {
  it('linha partida entre chunks e reconstruida', () => {
    const linha = serializeWorkerIpcMessage(
      { v: 1, type: 'ack', requestId: 'r', result: 'accepted', state: 'STARTING' },
      'to-worker',
    )
    const b = montar()
    b.entrada.write(linha.slice(0, 12))
    // `assert.deepEqual(x, [])` de `node:assert/strict` e uma ASSERTION
    // SIGNATURE e estreitaria `recebidas` para `never[]` no resto do bloco.
    assert.equal(b.recebidas.length, 0, 'metade de uma linha nao e mensagem')
    b.entrada.write(linha.slice(12))

    assert.equal(b.recebidas.length, 1)
    assert.equal(b.recebidas[0]?.type, 'ack')
  })

  it('malformada, depois boa: a boa passa e o canal continua aberto', () => {
    const b = montar()
    b.entrada.write('{"v":9,"type":"state"}\n')
    b.entrada.write('nao e json\n')
    b.entrada.write('{"v":1,"type":"state","state":"FAILED","seq":4}\n')

    assert.equal(b.recebidas.length, 1)
    assert.deepEqual(b.recebidas[0], { v: 1, type: 'state', state: 'FAILED', seq: 4 })
    assert.deepEqual(b.desligamentos, [], 'o canal NAO cai por causa de uma linha ma')
  })

  it('um consumidor que LANCA nao mata o canal nem a mensagem seguinte', () => {
    const b = montar({
      onMessage: (m): void => {
        if (m.type === 'state' && m.state === 'FAILED') throw new Error('defeito do consumidor')
      },
    })
    b.entrada.write('{"v":1,"type":"state","state":"FAILED","seq":1}\n')
    b.entrada.write('{"v":1,"type":"state","state":"STOPPED","seq":2}\n')

    assert.equal(b.recebidas.length, 2, 'a segunda foi processada na mesma')
    assert.match(b.stderr(), /o consumidor lancou/u)
    assert.deepEqual(b.desligamentos, [])
  })

  it('o acumulador nao cresce sem limite quando nunca chega um \\n', () => {
    const decoder = createWorkerLineDecoder({ direction: 'to-worker', maxLineBytes: 64 })
    assert.deepEqual(decoder.push('a'.repeat(100)), [{ ok: false, reason: 'forma-invalida' }])
    assert.equal(decoder.pending, 0)
  })

  it('o disposer e idempotente e larga os ouvintes de leitura', () => {
    const b = montar()
    assert.equal(b.entrada.listenerCount('data'), 1)

    b.ipc.dispose()
    b.ipc.dispose()
    b.ipc.dispose()

    assert.equal(b.entrada.listenerCount('data'), 0)
    assert.equal(b.entrada.listenerCount('end'), 0)
    assert.equal(b.ipc.send(INTENCAO), false)
  })
})
