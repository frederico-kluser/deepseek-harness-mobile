/**
 * =============================================================================
 * `src/tunnel/discover.ts` contra PROCESSOS e SOCKETS de verdade.
 * =============================================================================
 *
 * A suite de unidade injeta a sondagem HTTP; esta NAO injeta. Aqui corre o
 * `probeQuickTunnel` real, contra um `node:http.Server` real ou contra o
 * servidor de metricas de um processo filho real. E o unico sitio onde se prova
 * que a costura de rede (`node:http`, `agent: false`, o tecto de tempo, o
 * `'close'` que evita a promessa pendurada) esta certa.
 *
 * O QUE CONTINUA A NAO ACONTECER: o `cloudflared` REAL. Nem local, nem em CI,
 * nem no gate (D10). Subir um quick tunnel de verdade publica na internet o que
 * estiver na porta — foi assim que a pesquisa expos o DSH real do utilizador
 * durante cerca de 40 s. O que se usa e `test/bin/fake-cloudflared.mjs`, que e
 * PREP-OWNED e reproduz as propriedades MEDIDAS do 2026.7.3.
 *
 * O RELOGIO CONTINUA A SER FALSO. Os 30 s de prazo passam no `FakeClock`; o que
 * corre em tempo real e apenas o custo verdadeiro de cada ida ao socket, que e
 * de milissegundos. Nenhum teste daqui espera 30 segundos.
 *
 * PORTAS: pedidas sempre ao SO com `listen(0)`. Nenhum numero fixo — dois testes
 * em paralelo, ou uma maquina com o intervalo ocupado, tornavam a suite
 * intermitente por uma razao que nada tem a ver com o codigo sob teste.
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { setTimeout as dormirDeVerdade } from 'node:timers/promises'
import { after, describe, it, type TestContext } from 'node:test'

import {
  createTunnelDiscovery,
  defaultDiscoveryDeps,
  MIN_DISCOVERY_TIMEOUT_MS,
  probeHttp,
  STDERR_URL_PATTERN,
  TunnelError,
  type DiscoveryDeps,
  type HttpProbe,
} from '../../../src/tunnel/discover.ts'
import {
  createTunnelReadiness,
  defaultReadinessDeps,
  type ReadinessDeps,
} from '../../../src/tunnel/readiness.ts'
import { FakeClock } from '../../support/clock.ts'

import type { ReadinessOutcome, TunnelDiscoveryInput } from '../../../src/contracts/tunnel.ts'

/* ========================================================================== */
/* Apoio                                                                      */
/* ========================================================================== */

const DUBLE = new URL('../../bin/fake-cloudflared.mjs', import.meta.url)
const HOSTNAME = 'integracao-t3-2-descoberta.trycloudflare.com'

/**
 * O dublê corre DENTRO de um envoltorio que vigia o proprio pai.
 *
 * PORQUE, e isto foi MEDIDO e nao imaginado: as tres redes de limpeza deste
 * ficheiro (`t.after`, `process.on('exit')`, sinais) correm todas DENTRO do
 * processo de teste. Se esse processo for morto a tiro — `SIGKILL` do runner,
 * timeout duro de CI, OOM — nenhuma delas corre, e o dublê fica vivo a segurar
 * a porta de metricas. Reproduzido: `node --test ... | head -3` deixou dois
 * orfaos na maquina, e foram encontrados por outra sub-tarefa depois de o gate
 * ter ficado verde.
 *
 * O Linux tem `PR_SET_PDEATHSIG` para isto; o Node nao o expoe. O unico sinal
 * que chega a um processo cujo pai morreu e o `ppid` mudar (passa a 1, ou ao
 * subreaper). Vigia-se isso de 50 em 50 ms e o processo sai sozinho.
 *
 * O envoltorio IMPORTA o dublê em vez de o lancar como neto: assim o `pid` que
 * a suite guarda continua a ser o do processo que serve `/quicktunnel`, e
 * `kill` sobre ele continua a ser suficiente. Matar um intermediario a tiro
 * teria o defeito que se esta a corrigir.
 *
 * O `'--'` a cabeca nao e decorativo: com `node -e`, o `process.argv` fica
 * `[execPath, ...args]` — sem `argv[1]`. O dublê le `process.argv.slice(2)`,
 * logo precisa de um primeiro argumento a queimar para o `--metrics` cair na
 * posicao certa. O dublê e PREP-OWNED e nao se toca.
 */
const ENVOLTORIO_VIGIA = [
  '--input-type=module',
  '-e',
  `const pai = process.ppid
   setInterval(() => { if (process.ppid !== pai) process.exit(0) }, 50)
   await import(${JSON.stringify(DUBLE.href)})`,
  '--',
]

/**
 * `stdin` fica em `'ignore'`: o `cloudflared` nao le da entrada padrao e um pipe
 * aberto para um processo que nunca o le e um descritor a mais por teste.
 */
type FilhoComPipes = ChildProcessByStdio<null, Readable, Readable>

/* -------------------------------------------------------------------------- *
 * HIGIENE DE PROCESSOS — porque um `after` no fim do ficheiro NAO chega
 * -------------------------------------------------------------------------- *
 *
 * DEFEITO REAL, REPRODUZIDO: uma versao anterior deste ficheiro matava os
 * filhos num unico `after` assincrono no fim da suite. Bastou correr o runner
 * com a saida truncada (`node --test ... | head -3`) para o processo do
 * ficheiro de teste morrer ANTES de esse `after` chegar ao fim — e o dublê
 * ficou vivo, a segurar a porta de metricas, depois de o gate ter ficado verde.
 * Dois orfaos assim foram encontrados na maquina por outra sub-tarefa. O mesmo
 * acontece com um timeout duro de CI, um `Ctrl-C`, ou um OOM do runner.
 *
 * Isto nao e cosmetica. `04-TESTES.md` exige zero processo remanescente no
 * teardown; cada orfao segura uma porta e a corrida seguinte pode apanha-la,
 * passando (ou falhando) pela razao errada. E, sobretudo: o `cloudflared`
 * orfao e o cenario central de `02-SEGURANCA.md` 9 — um tunel que sobrevive ao
 * supervisor e uma URL publica viva sem portao por tras. Uma suite que deixa o
 * DUBLE orfao nao pode ser a suite que prova que o produto nao deixa o REAL.
 *
 * TRES REDES, por ordem de aperto:
 *   1. `t.after` POR TESTE — o filho morre quando o teste dele acaba, passe ou
 *      falhe. A janela de exposicao passa de "o ficheiro inteiro" para "um
 *      teste".
 *   2. `process.on('exit')` SINCRONO — cobre saida abrupta mas ordeira
 *      (excepcao por apanhar, `EPIPE` na saida truncada). Um `after`
 *      assincrono nao corre aqui; um `kill` sincrono corre.
 *   3. sinais — mata e RE-EMITE o sinal, para nao falsear o codigo de saida.
 *
 * Contra `SIGKILL` do runner nao ha rede possivel sem tocar no dublê, que e
 * prep-owned. Fica declarado, e nao escondido.
 * -------------------------------------------------------------------------- */

/** Todos os PIDs que esta suite arrancou. Base do teste de higiene final. */
const pidsArrancados: number[] = []
/** Os que ainda nao emitiram `'close'`. */
const vivos = new Set<ChildProcess>()

const servidores: Server[] = []
const temporarios: string[] = []

/** Rede 2 e 3: sincrono de proposito — um `await` aqui nunca chegava ao fim. */
function matarTodosJa(): void {
  for (const filho of vivos) {
    if (filho.exitCode === null && filho.signalCode === null) filho.kill('SIGKILL')
  }
}

process.on('exit', matarTodosJa)
for (const sinal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(sinal, () => {
    matarTodosJa()
    // Re-emitir em vez de `process.exit`: o `once` ja se removeu, logo o sinal
    // volta a ter o comportamento por omissao e o codigo de saida do runner
    // continua a ser o verdadeiro.
    process.kill(process.pid, sinal)
  })
}

/** Rede 1: liga a vida do filho a vida do TESTE que o arrancou. */
function registarFilho(t: TestContext, filho: ChildProcess): void {
  const { pid } = filho
  if (pid !== undefined) pidsArrancados.push(pid)
  vivos.add(filho)
  filho.on('close', () => {
    vivos.delete(filho)
  })
  t.after(async () => {
    await encerrar(filho)
  })
}

/**
 * Mata e ESPERA a morte.
 *
 * Esperar importa: sem o `'close'`, o teste seguinte comeca a competir por
 * portas com um processo que ainda esta a sair, e o `pid` continuaria a
 * responder ao teste de higiene final.
 */
async function encerrar(filho: ChildProcess): Promise<void> {
  if (filho.exitCode !== null || filho.signalCode !== null) {
    vivos.delete(filho)
    return
  }
  filho.kill('SIGKILL')
  await once(filho, 'close')
  vivos.delete(filho)
}

/** `kill(pid, 0)` nao envia sinal nenhum: so pergunta se o processo existe. */
function estaVivo(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (erro) {
    // `ESRCH` = nao existe. Qualquer outra coisa (`EPERM`, por exemplo) e
    // resposta conservadora: existe e nao e nosso.
    return (erro as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

after(async () => {
  matarTodosJa()
  for (const servidor of servidores) {
    await new Promise<void>((resolve) => {
      servidor.close(() => {
        resolve()
      })
    })
  }
  for (const caminho of temporarios) await rm(caminho, { recursive: true, force: true })
})

/**
 * Uma porta que o SO acabou de dizer estar livre.
 *
 * Fecha-se logo a seguir: quem a vai usar e o processo filho ou o servidor do
 * teste. Ha uma janela teorica de reutilizacao — e ela e preferivel a fixar um
 * numero, que transforma "outro teste a correr" em falha intermitente.
 */
async function portaLivre(): Promise<number> {
  const servidor = createNetServer()
  await new Promise<void>((resolve) => {
    servidor.listen(0, '127.0.0.1', resolve)
  })
  const { port } = servidor.address() as AddressInfo
  await new Promise<void>((resolve) => {
    servidor.close(() => {
      resolve()
    })
  })
  return port
}

/**
 * Dependencias com rede REAL e relogio FALSO.
 *
 * `tickMs` e o unico tempo de parede que existe: da a maquinaria do Node uma
 * volta do ciclo de eventos entre sondagens, para que a saida do processo filho
 * seja entregue. O prazo de 30 s continua a passar-se no relogio falso.
 */
function depsReais(clock: FakeClock, pollIntervalMs = 250, tickMs = 2): DiscoveryDeps {
  return {
    ...defaultDiscoveryDeps,
    now: () => clock.now(),
    sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
      clock.advance(ms)
      await dormirDeVerdade(tickMs, undefined, { signal })
    },
    pollIntervalMs,
    attemptTimeoutMs: 1000,
  }
}

function arrancarDuble(
  t: TestContext,
  metricsPort: number,
  env: Record<string, string> = {},
): FilhoComPipes {
  const filho = spawn(
    process.execPath,
    [...ENVOLTORIO_VIGIA, '--metrics', `127.0.0.1:${String(metricsPort)}`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_CF_HOSTNAME: HOSTNAME, ...env },
    },
  )
  registarFilho(t, filho)
  return filho
}

/**
 * Espera de parede LIMITADA, so para o arranque de um processo.
 *
 * Nao e a espera do prazo de descoberta — essa e virtual. E o custo real de o
 * SO criar um processo, medido em dezenas de milissegundos. Sem um ponto de
 * sincronizacao aqui, o teste passaria a medir a rapidez da maquina.
 */
async function ateQue(condicao: () => boolean, oQue: string): Promise<void> {
  for (let tentativa = 0; tentativa < 2000; tentativa += 1) {
    if (condicao()) return
    await dormirDeVerdade(5)
  }
  throw new Error(`nunca aconteceu: ${oQue}`)
}

function entrada(over: {
  metricsPort: number
  stderr: Readable | null
  signal?: AbortSignal
  timeoutMs?: number
}): TunnelDiscoveryInput {
  return {
    metricsPort: over.metricsPort,
    stderr: over.stderr,
    signal: over.signal ?? new AbortController().signal,
    timeoutMs: over.timeoutMs ?? MIN_DISCOVERY_TIMEOUT_MS,
  }
}

async function falha(promessa: Promise<unknown>): Promise<TunnelError> {
  try {
    await promessa
  } catch (error) {
    assert.ok(error instanceof TunnelError, `esperava TunnelError, veio ${String(error)}`)
    return error
  }
  throw new Error('a promessa resolveu quando devia ter falhado')
}

/* ========================================================================== */
/* TUN-001 / TUN-002 — o caminho primario, com HTTP a serio                   */
/* ========================================================================== */

describe('TUN-001/TUN-002 — `/quicktunnel` de um processo real', () => {
  it('devolve `https://` + hostname pelo caminho `metrics`', async (t) => {
    const porta = await portaLivre()
    const filho = arrancarDuble(t, porta)
    const clock = new FakeClock(0)

    const resultado = await createTunnelDiscovery(depsReais(clock)).discover(
      entrada({ metricsPort: porta, stderr: filho.stderr }),
    )

    assert.deepEqual(resultado, { url: `https://${HOSTNAME}`, via: 'metrics' })
    // O endpoint devolve o hostname SEM esquema; a prefixacao e nossa e e uma
    // so vez, contra dados que atravessaram um socket de verdade.
    assert.equal(resultado.url.split('https://').length - 1, 1)
  })
})

/* ========================================================================== */
/* TUN-003 — o polling insiste contra um servidor que muda de ideias          */
/* ========================================================================== */

describe('TUN-003 — 404 nas primeiras tentativas, depois 200', () => {
  it('persiste ate ao prazo e tem sucesso', async () => {
    let pedidos = 0
    const servidor = createHttpServer((req, res) => {
      pedidos += 1
      if (req.url !== '/quicktunnel') {
        res.writeHead(404)
        res.end()
        return
      }
      if (pedidos <= 3) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('404 page not found')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hostname: HOSTNAME }))
    })
    servidores.push(servidor)
    await new Promise<void>((resolve) => {
      servidor.listen(0, '127.0.0.1', resolve)
    })
    const { port } = servidor.address() as AddressInfo
    const clock = new FakeClock(0)

    const resultado = await createTunnelDiscovery(depsReais(clock)).discover(
      entrada({ metricsPort: port, stderr: null }),
    )

    assert.deepEqual(resultado, { url: `https://${HOSTNAME}`, via: 'metrics' })
    assert.equal(pedidos, 4)
    assert.equal(clock.now(), 3 * 250)
  })
})

/* ========================================================================== */
/* TUN-004 — o endpoint nao existe; a URL vem do log                          */
/* ========================================================================== */

describe('TUN-004 — `/quicktunnel` inalcancavel (ECONNREFUSED) durante todo o warmup', () => {
  it('o fallback por regex sobre `stderr` funciona, e o `via` prova-o', async (t) => {
    const portaDoDuble = await portaLivre()
    // Porta FECHADA de proposito: o `probeQuickTunnel` real vai apanhar
    // ECONNREFUSED de verdade, volta apos volta, do inicio ao fim.
    const portaMorta = await portaLivre()
    const filho = arrancarDuble(t, portaDoDuble)

    // Espelho do `stderr`: o `pipe` e o listener de contagem recebem os MESMOS
    // chunks. Isto e o que torna o teste determinista sem lhe tirar realidade —
    // o texto continua a ser o que um processo escreveu num pipe do SO.
    const espelho = new PassThrough()
    let visto = ''
    filho.stderr.on('data', (chunk: Buffer) => {
      visto += chunk.toString('utf8')
    })
    filho.stderr.pipe(espelho)
    await ateQue(() => STDERR_URL_PATTERN.test(visto), 'o duble escrever a URL em stderr')

    const clock = new FakeClock(0)
    const resultado = await createTunnelDiscovery(depsReais(clock)).discover(
      entrada({ metricsPort: portaMorta, stderr: espelho }),
    )

    assert.deepEqual(resultado, { url: `https://${HOSTNAME}`, via: 'stderr' })
    assert.notEqual(portaMorta, portaDoDuble)
  })

  it('sem log e sem endpoint, falha por prazo com o motivo de rede medido', async () => {
    const portaMorta = await portaLivre()
    const clock = new FakeClock(0)

    const erro = await falha(
      createTunnelDiscovery(depsReais(clock, 5000)).discover(
        entrada({ metricsPort: portaMorta, stderr: null }),
      ),
    )

    assert.equal(erro.code, 'READINESS_TIMEOUT')
    assert.equal(erro.message.includes('ECONNREFUSED'), true)
    assert.equal(clock.now() >= MIN_DISCOVERY_TIMEOUT_MS, true)
  })
})

/* ========================================================================== */
/* TUN-005 — o parser le `stderr`, e SO `stderr`                              */
/* ========================================================================== */

describe('TUN-005 — URL so em stdout, de um processo real', () => {
  it('NAO e aceite: o processo publicou em stdout e a descoberta falha por prazo', async (t) => {
    // Medido: o `cloudflared` 2026.7.3 deixa `stdout` com EXATAMENTE 0 bytes em
    // duas execucoes. Um processo que so escreva ali e, portanto, um processo
    // que nao publicou nada — e e assim que este parser tem de o tratar.
    const portaMorta = await portaLivre()
    const filho = spawn(
      process.execPath,
      ['-e', `process.stdout.write("INF |  https://${HOSTNAME}  |\\n")`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    registarFilho(t, filho)

    let saidaPadrao = ''
    filho.stdout.on('data', (chunk: Buffer) => {
      saidaPadrao += chunk.toString('utf8')
    })
    await new Promise<void>((resolve) => {
      filho.on('close', () => {
        resolve()
      })
    })
    assert.equal(STDERR_URL_PATTERN.test(saidaPadrao), true, 'a URL ESTAVA mesmo em stdout')

    const clock = new FakeClock(0)
    const erro = await falha(
      createTunnelDiscovery(depsReais(clock, 5000)).discover(
        entrada({ metricsPort: portaMorta, stderr: filho.stderr }),
      ),
    )

    assert.equal(erro.code, 'READINESS_TIMEOUT')
  })
})

/* ========================================================================== */
/* TUN-010 — o processo morre a meio do warmup                                */
/* ========================================================================== */

describe('TUN-010 — processo morre DURANTE o warmup', () => {
  it('a espera aborta no `signal` do `close`, sem consumir o prazo inteiro', async (t) => {
    const portaDoDuble = await portaLivre()
    const portaMorta = await portaLivre()
    // O duble fica vivo mas nunca publica: o unico fim possivel e a morte dele.
    const filho = arrancarDuble(t, portaDoDuble, { FAKE_CF_URL_DELAY_MS: '600000' })
    let arrancou = false
    filho.stderr.on('data', () => {
      arrancou = true
    })
    await ateQue(() => arrancou, 'o duble comecar a escrever em stderr')

    const controlador = new AbortController()
    filho.on('close', () => {
      controlador.abort()
    })

    const clock = new FakeClock(0)
    const promessa = createTunnelDiscovery(depsReais(clock, 250, 5)).discover(
      entrada({ metricsPort: portaMorta, stderr: filho.stderr, signal: controlador.signal }),
    )
    filho.kill('SIGTERM')

    const erro = await falha(promessa)

    assert.equal(erro.code, 'PROCESS_EXITED')
    assert.equal(erro.retryable, true)
    // A prova: o relogio virtual mal andou. Sem o `signal`, esta chamada so
    // desistia aos 30 000 ms — e o supervisor ficava 30 s a segurar um processo
    // que ja nao existe antes de poder transitar para `DEGRADED`.
    assert.equal(clock.now() < MIN_DISCOVERY_TIMEOUT_MS, true, `clock=${String(clock.now())}`)
  })
})

/* ========================================================================== */
/* TUN-012 — a COMPOSICAO: URL disponivel **E** readiness confirmado          */
/* ========================================================================== */

/**
 * O que T3.1 vai fazer, na ordem em que o vai fazer.
 *
 * Esta funcao existe no teste, e nao no `src`, porque a composicao pertence ao
 * supervisor — mas a ORDEM e uma afirmacao de T3.2 e tem de ser exercitada
 * aqui: readiness NUNCA corre antes de haver URL, e a URL sozinha NUNCA
 * significa `READY`.
 */
async function subirAteUtilizavel(
  discoveryDeps: DiscoveryDeps,
  input: TunnelDiscoveryInput,
  readinessDeps: ReadinessDeps,
): Promise<{ url: string; resultado: ReadinessOutcome }> {
  const { url } = await createTunnelDiscovery(discoveryDeps).discover(input)
  const resultado = await createTunnelReadiness(readinessDeps).waitUntilUsable({
    url,
    signal: input.signal,
    timeoutMs: 30_000,
  })
  return { url, resultado }
}

describe('TUN-012 — porta aberta nao e app pronta, e URL nao e `READY`', () => {
  it('depois da URL, e o readiness que fecha a transicao — e so ele', async (t) => {
    const porta = await portaLivre()
    const filho = arrancarDuble(t, porta)

    // A "aplicacao por tras do tunel": 503 duas vezes (a borda ja atende antes
    // de o conector registar) e so depois o 401 do portao armado.
    let pedidos = 0
    const aplicacao = createHttpServer((_req, res) => {
      pedidos += 1
      res.writeHead(pedidos <= 2 ? 503 : 401)
      res.end()
    })
    servidores.push(aplicacao)
    await new Promise<void>((resolve) => {
      aplicacao.listen(0, '127.0.0.1', resolve)
    })
    const { port: portaDaApp } = aplicacao.address() as AddressInfo

    const alvos: string[] = []
    const clock = new FakeClock(0)
    const readinessDeps: ReadinessDeps = {
      ...defaultReadinessDeps,
      now: () => clock.now(),
      sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
        clock.advance(ms)
        await dormirDeVerdade(2, undefined, { signal })
      },
      pollIntervalMs: 500,
      attemptTimeoutMs: 1000,
      // O readiness recebe a URL DESCOBERTA e e ela que se assere. O pedido em
      // si vai para o servidor local: contactar `*.trycloudflare.com` a serio e
      // exactamente o que D10 proibe, porque um quick tunnel publica na
      // internet o que estiver na porta.
      probeUrl: async (target: URL, signal: AbortSignal, timeoutMs: number): Promise<HttpProbe> => {
        alvos.push(target.host)
        return await probeHttp({
          target: new URL(`http://127.0.0.1:${String(portaDaApp)}/`),
          signal,
          timeoutMs,
          maxBodyBytes: 0,
        })
      },
    }

    const { url, resultado } = await subirAteUtilizavel(
      depsReais(new FakeClock(0)),
      entrada({ metricsPort: porta, stderr: filho.stderr }),
      readinessDeps,
    )

    assert.equal(url, `https://${HOSTNAME}`)
    assert.deepEqual(resultado, { usable: true, status: 401 })
    // Foi mesmo a URL descoberta que se sondou, e mais do que uma vez.
    assert.deepEqual([...new Set(alvos)], [HOSTNAME])
    assert.equal(alvos.length, 3)
  })

  it('sem URL nao ha readiness nenhum: ele nem chega a ser consultado', async () => {
    // A ordem e a afirmacao. Um supervisor que corresse readiness "a ver se
    // entretanto sobe" estaria a sondar um endereco que ainda nao existe — e a
    // primeira coisa que aprenderia era a aceitar um endereco vazio.
    const portaMorta = await portaLivre()
    let sondagens = 0
    const readinessDeps: ReadinessDeps = {
      ...defaultReadinessDeps,
      probeUrl: (): Promise<HttpProbe> => {
        sondagens += 1
        return Promise.resolve({ kind: 'response', status: 401, body: '' })
      },
    }

    await falha(
      subirAteUtilizavel(
        depsReais(new FakeClock(0), 5000),
        entrada({ metricsPort: portaMorta, stderr: null }),
        readinessDeps,
      ),
    )

    assert.equal(sondagens, 0)
  })
})

/* ========================================================================== */
/* O tecto de corpo e o corpo interrompido — a costura de HTTP                 */
/* ========================================================================== */

describe('a resposta do `/quicktunnel` e input nao confiavel tambem em TAMANHO', () => {
  it('um corpo de 4 MB e cortado no tecto em vez de ser lido inteiro', async () => {
    // O endpoint nao e contratual e do outro lado esta um processo externo.
    // Sem tecto, uma resposta enorme (ou um socket que nunca fecha a escrever)
    // enche a memoria do host do DSH. O tecto nao tem defeito hoje — tem
    // AUSENCIA DE PROVA, e sem prova o proximo refactor apaga-o em silencio.
    const enorme = Buffer.alloc(4 * 1024 * 1024, 'a')
    const servidor = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(enorme)
    })
    servidores.push(servidor)
    await new Promise<void>((resolve) => {
      servidor.listen(0, '127.0.0.1', resolve)
    })
    const { port } = servidor.address() as AddressInfo

    const tecto = 8 * 1024
    const probe = await probeHttp({
      target: new URL(`http://127.0.0.1:${String(port)}/quicktunnel`),
      signal: new AbortController().signal,
      timeoutMs: 5000,
      maxBodyBytes: tecto,
    })

    // `assert.equal` ja estreita o tipo: um `assert.ok` a seguir era condicao
    // sempre verdadeira, e um aviso de lint que se aprende a ignorar.
    assert.equal(probe.kind, 'response')
    assert.equal(probe.status, 200)
    assert.equal(probe.body.length, tecto, 'leu exactamente o tecto, nao os 4 MB')
  })

  it('um corpo gigante nao trava a descoberta: e recusado e o ciclo segue', async () => {
    // A mesma coisa pelo caminho real, com o tecto de producao: o corpo cortado
    // nao e JSON valido, a leitura e RECUSADA na fronteira, e o ciclo continua
    // ate ao prazo em vez de rebentar ou ficar presa.
    const enorme = Buffer.alloc(4 * 1024 * 1024, 'a')
    const servidor = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(enorme)
    })
    servidores.push(servidor)
    await new Promise<void>((resolve) => {
      servidor.listen(0, '127.0.0.1', resolve)
    })
    const { port } = servidor.address() as AddressInfo

    const erro = await falha(
      createTunnelDiscovery(depsReais(new FakeClock(0), 5000)).discover(
        entrada({ metricsPort: port, stderr: null }),
      ),
    )

    assert.equal(erro.code, 'READINESS_TIMEOUT')
    assert.equal(erro.message.includes('resposta 200 recusada'), true)
  })

  it('um corpo interrompido a meio da resposta e tratado como VOLTA PERDIDA', async () => {
    // MEDIDO, e o resultado contraria a intuicao: o servidor anuncia 10 000
    // bytes, escreve 10 e destroi o socket — e o Node reporta o corte no
    // PEDIDO (`ECONNRESET`), nao na resposta. Logo o observavel e
    // `unreachable`, e nao "resposta com corpo truncado".
    //
    // Este teste existe para FIXAR isso, por duas razoes. Primeira: e a
    // resposta conservadora certa — um corpo cortado nao e JSON valido e um
    // `401` cuja ligacao rebentou nao prova que a aplicacao esta utilizavel.
    // Segunda: a versao anterior deste ficheiro AFIRMAVA o contrario num
    // comentario do `src`, e a afirmacao era falsa. O comentario foi corrigido
    // e passou a dizer que o ouvinte de `'error'` da resposta e uma GUARDA
    // contra `'error'` sem ouvinte (que derrubaria o processo do DSH), nao um
    // caminho de comportamento.
    const servidor = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '10000' })
      res.write('0123456789')
      res.socket?.destroy()
    })
    servidores.push(servidor)
    await new Promise<void>((resolve) => {
      servidor.listen(0, '127.0.0.1', resolve)
    })
    const { port } = servidor.address() as AddressInfo

    const probe = await probeHttp({
      target: new URL(`http://127.0.0.1:${String(port)}/quicktunnel`),
      signal: new AbortController().signal,
      timeoutMs: 5000,
      maxBodyBytes: 8 * 1024,
    })

    assert.deepEqual(probe, { kind: 'unreachable', reason: 'ECONNRESET' })
  })
})

/* ========================================================================== */
/* TUN-015 — nada e escrito em disco                                          */
/* ========================================================================== */

describe('TUN-015 — a URL do tunel nao chega ao disco', () => {
  it('uma descoberta completa nao cria nem altera ficheiro nenhum', async (t) => {
    // A URL de um quick tunnel muda a cada arranque. Um valor velho lido do
    // disco entrega ao dono um link MORTO com toda a confianca — e ele so
    // descobre quando ja esta fora de casa a tentar usa-lo.
    const raiz = await mkdtemp(join(tmpdir(), 'dsh-guard-tun015-'))
    temporarios.push(raiz)

    const porta = await portaLivre()
    const filho = arrancarDuble(t, porta)
    const antes = await readdir(raiz)

    const resultado = await createTunnelDiscovery(depsReais(new FakeClock(0))).discover(
      entrada({ metricsPort: porta, stderr: filho.stderr }),
    )

    assert.equal(resultado.url, `https://${HOSTNAME}`)
    assert.deepEqual(await readdir(raiz), antes)
    assert.deepEqual(antes, [])
  })
})


/* ========================================================================== */
/* HIGIENE — sockets                                                          */
/* ========================================================================== */

describe('a descoberta nao deixa ligacao viva a borda', () => {
  it('depois de a URL chegar, o servidor de metricas nao tem ligacao nossa aberta', async () => {
    // MATA `agent: false`. Medido: com o `globalAgent` do Node (que ja vem com
    // `keepAlive` ligado) e o corpo consumido — que e o caso do
    // `/quicktunnel` — fica UMA ligacao viva por descoberta. Num plugin que
    // reabre o tunel a cada falha, isso e um descritor por tentativa.
    //
    // O teste anterior desta familia vivia no ficheiro do readiness e era
    // DECORATIVO: sobrevivia a remocao de `agent: false`, de `connection:
    // close` E do `res.destroy()`, porque as tres eram redundantes entre si. O
    // `connection: close` foi retirado do `src` justamente para as outras duas
    // passarem a ser falsificaveis, uma em cada caminho.
    const servidor = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hostname: HOSTNAME }))
    })
    servidores.push(servidor)
    await new Promise<void>((resolve) => {
      servidor.listen(0, '127.0.0.1', resolve)
    })
    const { port } = servidor.address() as AddressInfo

    const resultado = await createTunnelDiscovery(depsReais(new FakeClock(0))).discover(
      entrada({ metricsPort: port, stderr: null }),
    )
    assert.equal(resultado.via, 'metrics')

    await dormirDeVerdade(60)
    const abertas = await new Promise<number>((resolve, reject) => {
      servidor.getConnections((erro, quantas) => {
        if (erro !== null) reject(erro)
        else resolve(quantas)
      })
    })

    assert.equal(abertas, 0, 'ficou uma ligacao viva ao servidor de metricas')
  })
})

/* ========================================================================== */
/* HIGIENE — o teste que impede o orfao de voltar                             */
/* ========================================================================== */

describe('a suite nao deixa processo orfao', () => {
  // ULTIMO `describe` do ficheiro DE PROPOSITO: a rede 1 (`t.after` por teste)
  // ja correu para todos os anteriores, portanto neste ponto todos os filhos
  // TEM de estar mortos. Se alguem acrescentar um `spawn` sem o registar, ou
  // trocar a limpeza por um `after` unico no fim, este teste fica vermelho —
  // que e exactamente o aviso que faltava quando dois dublês ficaram vivos na
  // maquina depois de o gate ter passado.
  it('todos os processos que ela arrancou ja morreram', () => {
    const aindaVivos = pidsArrancados.filter(estaVivo)

    assert.deepEqual(aindaVivos, [], 'ha dublê(s) orfao(s) a segurar porta de metricas')
    assert.equal(vivos.size, 0, 'ha filhos registados que nunca emitiram `close`')
  })

  it('arrancou exactamente os processos que declara arrancar', () => {
    // Canario deliberado. Nao e um numero magico: e o inventario da suite, e
    // muda-lo obriga quem acrescentar um `spawn` a olhar para a limpeza dele.
    assert.equal(
      pidsArrancados.length,
      6,
      'o inventario de processos mudou — confirme que o novo `spawn` passa por `arrancarDuble`/`registarFilho`',
    )
  })
})
