/**
 * =============================================================================
 * A PERGUNTA DA REVISAO, RESPONDIDA POR MEDICAO:
 * passar `stdin` de `'ignore'` para `'pipe'` alterou o tree-kill ou o `detached`?
 * =============================================================================
 *
 * >>> NAO. E a evidencia e `ps -o pid,ppid,pgid,sid`, nao raciocinio. <<<
 *
 * A Onda 3 fixou tres invariantes que esta onda nao pode regredir, e cada uma
 * tem aqui um caso com processos REAIS:
 *
 *   1. `detached: true` faz do filho o LIDER DO SEU PROPRIO GRUPO (`setsid(2)`).
 *      Sem isso, `process.kill(-pid)` nao designa grupo nenhum e o tree-kill
 *      simplesmente nao acontece. O caso 1 le `pgid` e `sid` com `ps`, nos DOIS
 *      `stdio`, e compara-os.
 *   2. O SIGKILL ao GRUPO leva o NETO junto. O caso 2 cria um neto e verifica
 *      que ele morre com o grupo -- com `stdin` em `'pipe'`.
 *   3. O tree-kill IGNORA `child.killed` de proposito (`src/proc/tree-kill.ts`):
 *      o Node poe `killed = true` de forma SINCRONA ao processar o `abort`, e a
 *      guarda `!child.killed` do exemplo canonico tornava o kill do grupo codigo
 *      morto. O caso 2 e exatamente o cenario que essa guarda quebrava -- se
 *      alguem a repuser, o neto sobrevive e este ficheiro fica vermelho.
 *
 * A rede de seguranca contra falsos verdes: o caso 1 corre a MESMA medicao com
 * `stdin: 'ignore'` e com `stdin: 'pipe'` e assere que as duas dao o mesmo. Um
 * teste que so medisse `'pipe'` nao responderia a pergunta -- responderia
 * "'pipe' funciona", que nao e o mesmo que "nada mudou".
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, it } from 'node:test'

import type { BackoffConfig } from '../../../src/config/schema.ts'
import type { SubprocessSpawnSpec } from '../../../src/dsh/adapter.ts'
import { createProcessSupervisor, type ProcessSupervisor } from '../../../src/proc/supervisor.ts'
import { FakeScheduler, makeSupervisorDeps } from '../../support/child-double.ts'
import {
  isAlive,
  makeBinDir,
  makeRealContext,
  waitFor,
  writeExecutableShim,
  type RealSubprocessService,
} from './seat.ts'

/**
 * DERIVADO do spec e nao importado como tipo proprio: `SubprocessStdio` nao esta
 * na superficie reexportada por `src/dsh/adapter.ts`, e alargar a fronteira com
 * o DSH so para nomear um tipo de teste seria pagar caro por nada (D1: o
 * adaptador e o UNICO ponto que toca a API do host).
 */
type ModoStdin = SubprocessSpawnSpec['stdio']['stdin']

const BACKOFF: BackoffConfig = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 10,
  resetAfterMs: 60_000,
}

const bin = makeBinDir()
const supervisores: ProcessSupervisor[] = []
const servicos: RealSubprocessService[] = []

after(() => {
  for (const supervisor of supervisores) supervisor.dispose()
  for (const servico of servicos) servico.killAll()
  bin.cleanup()
})

/** Anuncia-se e fica vivo. Ignora SIGTERM: so o SIGKILL do grupo o mata. */
const TEIMOSO = writeExecutableShim(
  bin.path,
  'fake-teimoso-pipe',
  [
    "process.on('SIGTERM', () => {})",
    "process.stderr.write('PRONTO\\n')",
    'setInterval(() => {}, 1000)',
  ].join('\n') + '\n',
)

/** Cria um NETO e publica o pid dele em `stderr` (o `stdout` fica livre). */
const COM_NETO = writeExecutableShim(
  bin.path,
  'fake-com-neto',
  [
    "import { spawn } from 'node:child_process'",
    "const neto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'process.stderr.write(`PRONTO neto=${neto.pid}\\n`)',
    'setInterval(() => {}, 1000)',
  ].join('\n') + '\n',
)

interface Medida {
  pid: number
  ppid: number
  pgid: number
  sid: number
}

function ps(pid: number): Medida | undefined {
  try {
    const linha = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,sess=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    const campos = linha.split(/\s+/u).map(Number)
    const [lido, ppid, pgid, sid] = campos
    if (lido === undefined || ppid === undefined || pgid === undefined || sid === undefined) {
      return undefined
    }
    return { pid: lido, ppid, pgid, sid }
  } catch {
    return undefined
  }
}

function montar(command: string, stdin: ModoStdin): {
  supervisor: ProcessSupervisor
  subprocess: RealSubprocessService
} {
  const { ctx, subprocess } = makeRealContext()
  servicos.push(subprocess)
  const { deps } = makeSupervisorDeps(new FakeScheduler())

  const supervisor = createProcessSupervisor(
    ctx,
    {
      name: 'processo-de-teste',
      backoff: BACKOFF,
      buildSpec: (signal: AbortSignal) => ({
        argv: [command],
        cwd: bin.path,
        stdio: { stdin, stdout: 'pipe', stderr: 'pipe' },
        graceMs: 120,
        signal,
      }),
    },
    deps,
  )
  supervisores.push(supervisor)
  return { supervisor, subprocess }
}

/* ========================================================================== */
/* Caso 1 -- `ps` com os dois `stdio`                                         */
/* ========================================================================== */

describe('1. `ps -o pid,ppid,pgid,sid`: o `stdin` nao muda a topologia de processos', () => {
  const modos: ReadonlyArray<ModoStdin> = ['ignore', 'pipe']
  const medidas = new Map<string, Medida>()

  for (const stdin of modos) {
    it(`com stdin='${String(stdin)}' o filho e lider do seu grupo E da sua sessao`, async () => {
      const h = montar(TEIMOSO, stdin)
      h.supervisor.start()
      const child = h.subprocess.lastChild()
      await waitFor(() => child.pid > 0 && isAlive(child.pid))

      const medida = ps(child.pid)
      assert.notEqual(medida, undefined, 'o `ps` tem de ver o processo')
      assert.equal(medida?.pgid, child.pid, 'pgid === pid: `detached` deu-lhe grupo proprio')
      assert.equal(medida?.sid, child.pid, 'sid === pid: `setsid(2)` correu')
      assert.equal(medida?.ppid, process.pid, 'e o pai continua a ser este corredor de testes')

      // O `stdin` esta REALMENTE presente ou ausente conforme pedido -- sem
      // isto o teste podia estar a medir duas vezes a mesma configuracao.
      assert.equal(
        h.subprocess.lastChild().stdin === undefined,
        stdin === 'ignore',
        'o handle tem de publicar `stdin` sse o spec pediu `pipe`',
      )

      medidas.set(String(stdin), medida as Medida)
      h.supervisor.dispose()
      await waitFor(() => !isAlive(child.pid), { timeoutMs: 4000 })
    })
  }

  it('as duas medicoes tem a MESMA forma: nada regrediu', () => {
    const comIgnore = medidas.get('ignore')
    const comPipe = medidas.get('pipe')
    assert.notEqual(comIgnore, undefined)
    assert.notEqual(comPipe, undefined)

    // A comparacao e sobre a RELACAO (pid === pgid === sid, ppid === corredor),
    // que e o que define "lider do proprio grupo"; os numeros absolutos mudam
    // entre processos e nao significam nada.
    const forma = (m: Medida): string =>
      `${String(m.pgid === m.pid)}/${String(m.sid === m.pid)}/${String(m.ppid === process.pid)}`
    assert.equal(forma(comPipe as Medida), forma(comIgnore as Medida))
    assert.equal(forma(comPipe as Medida), 'true/true/true')
  })
})

/* ========================================================================== */
/* Caso 2 -- o neto morre com o grupo, com `stdin: 'pipe'`                    */
/* ========================================================================== */

describe('2. o tree-kill do GRUPO continua a levar o NETO, com `stdin: pipe`', () => {
  it('o neto morre com o grupo -- e e isto que a guarda `!child.killed` quebrava', async () => {
    const h = montar(COM_NETO, 'pipe')
    h.supervisor.start()
    const child = h.subprocess.lastChild()

    let netoPid = 0
    child.stderr?.on('data', (chunk: Buffer): void => {
      const match = /neto=(\d+)/u.exec(chunk.toString())
      if (match?.[1] !== undefined) netoPid = Number(match[1])
    })
    await waitFor(() => netoPid > 0)
    assert.equal(isAlive(netoPid), true, 'o neto tem de estar vivo antes do dispose')

    const doNeto = ps(netoPid)
    assert.equal(doNeto?.pgid, child.pid, 'o neto herdou o GRUPO do filho -- e por isso morre com ele')

    h.supervisor.dispose()

    assert.equal(
      await waitFor(() => !isAlive(netoPid), { timeoutMs: 4000 }),
      true,
      'o neto sobreviveu: o tree-kill do grupo regrediu',
    )
    assert.equal(await waitFor(() => !isAlive(child.pid), { timeoutMs: 4000 }), true)
  })

  it('o SIGKILL chega mesmo a quem IGNORA SIGTERM, com `stdin: pipe`', async () => {
    const h = montar(TEIMOSO, 'pipe')
    h.supervisor.start()
    const child = h.subprocess.lastChild()
    await waitFor(() => child.pid > 0 && isAlive(child.pid))
    const { pid } = child

    h.supervisor.dispose()

    assert.equal(
      await waitFor(() => !isAlive(pid), { timeoutMs: 4000 }),
      true,
      'sem a escalada ate SIGKILL, este processo ficava vivo para sempre',
    )
  })
})
