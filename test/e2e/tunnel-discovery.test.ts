
/**
 * =============================================================================
 * T6.1 — DESCOBERTA DA URL CONTRA O DUBLÊ REAL, PELOS DOIS CAMINHOS (T3.2).
 * =============================================================================
 *
 * DONO: T6.1. Territorio exclusivo: `test/e2e/tunnel-*.test.ts`.
 *
 * O QUE ESTA SUITE PROVA, E A PERGUNTA FALSIFICAVEL DE CADA TESTE
 * -----------------------------------------------------------------------------
 * O contrato de `src/tunnel/discover.ts` diz que a URL sai por DOIS caminhos
 * complementares — e nao primario/reserva:
 *
 *   (a) `GET /quicktunnel` no servidor de metricas, que devolve `{"hostname":
 *       "..."}` SEM esquema (o consumidor prefixa `https://`);
 *   (b) regex sobre STDERR — medido, o `cloudflared` deixa `stdout` com 0 bytes
 *       e escreve o banner da URL em `stderr`.
 *
 * Os testes unitarios provam cada caminho com fluxos em memoria. Esta suite
 * prova os MESMOS dois caminhos contra o DUBLÊ CONGELADO
 * (`test/bin/fake-cloudflared.mjs`, prep-owned, nunca editado) corrido como
 * PROCESSO REAL: a pergunta falsificavel e "a URL do tunel e realmente extraida
 * do processo que o dublê finge ser, ou so de um stream fabricado?".
 *
 * OS TRES CENARIOS, E COMO CADA UM E FORCADO A ESCOLHER O SEU CAMINHO
 * -----------------------------------------------------------------------------
 *   1. via == 'metrics':  o dublê e spawnado com a porta de metricas PINADA
 *      (a forma canonica do produto, `buildCloudflaredArgv`) e o banner de
 *      stderr e ATRASADO (`FAKE_CF_URL_DELAY_MS=3000`). A descoberta so pode
 *      ganhar pelo endpoint — e ganha.
 *   2. via == 'stderr':   o dublê corre com metricas em porta EFEMERA (o seu
 *      default) enquanto a aplicacao sonda uma porta DEDICADA onde ninguem
 *      atende. O endpoint nunca responde e o regex tem de salvar o dia — e
 *      salva. E o cenario real do contrato: `/quicktunnel` nao e documentado,
 *      "pode desaparecer numa versao qualquer sem aviso" — o fallback tem de
 *      funcionar quando o caminho estruturado FALHA.
 *   3. TUN-005:           a URL viaja so em STDOUT e nunca em stderr. A
 *      descoberta TEM de recusar (timeout) — nunca "aceitar a URL e seguir".
 *      O dublê nao tem modo `stdout-only` (adicionar um modo era mudanca de
 *      contrato); o cenario e montado com um involucro `sh` que redireciona o
 *      stderr do dublê para o stdout do involucro e silencia o stderr proprio.
 *      O controlo POSITIVO (o stdout do involucro CONTEM a URL) prova que o
 *      resultado negativo nao veio de a URL nao existir.
 *
 * PORQUE ISTO E E2E E NAO UNITARIO
 * -----------------------------------------------------------------------------
 * O processo e real: spawn, pipes, SIGTERM. O teardown de cada teste mata o
 * processo e ESPERA o fecho (nunca "fire and forget"), e o `after` da suite
 * MATA TUDO o que ela criou (`killAll` + `settleAll`, o fecho de cada handle)
 * — sem pgrep global: o orquestrador corre suites em paralelo na mesma
 * maquina, e a varredura GLOBAL de orfaos e do job test-e2e do CI.
 *
 * >>> NENHUM `cloudflared` REAL E INVOCADO (D10) <<< e nada aqui toca a rede:
 * todas as portas sao efemeras em 127.0.0.1 e o unico "internet" que existe e
 * o hostname `*.trycloudflare.com` que o DUBLÊ anuncia.
 *
 * Strip-only mode (`node --test` corre os .ts sem os compilar): sem enum,
 * sem namespace, sem parameter properties. Import relativo leva `.ts`.
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { after, describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as timersSleep } from 'node:timers/promises'

import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '../../src/dsh/adapter.ts'
import { buildCloudflaredArgv, buildCloudflaredEnv } from '../../src/tunnel/args.ts'
import { createTunnelDiscovery } from '../../src/tunnel/discover.ts'
import type { TunnelDiscovery } from '../../src/contracts/tunnel.ts'

/** O dublê CONGELADO (prep-owned). NUNCA editado por esta suite (D15). */
const DOUBLE_PATH = fileURLToPath(new URL('../bin/fake-cloudflared.mjs', import.meta.url))

/** Piso do timeout de descoberta — o mesmo do contrato de T3.2. */
const DISCOVERY_TIMEOUT_MS = 30_000

/** Hostnames anunciados pelo dublê, um por cenario. Casam com o padrao do contrato. */
const HOSTNAME_METRICS = 'e2e-descoberta-metrics.trycloudflare.com'
const HOSTNAME_STDERR = 'e2e-descoberta-stderr.trycloudflare.com'
const HOSTNAME_STDOUT = 'e2e-descoberta-stdout.trycloudflare.com'

/** Reserva uma porta livre soltando-a a seguir. Nunca uma porta fixa. */
async function reservePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('sem porta')
  return address.port
}

/** Abre um servidor HTTP de ORIGEM (o alvo do `--url`) numa porta efemera. */
async function listenOrigin(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('origem')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return { server, port: address.port }
}

/**
 * Assento de subprocesso REAL, minimo e honesto — o mesmo molde do assento de
 * integracao, sem importar de la: a suite e2e tem de ser auto-contida para nao
 * herdar a arvore de integracao.
 *
 * O que importa para esta suite:
 *   - `done` resolve NO FECHO (`'close'`), nunca no `'exit'` (facto 520:
 *     num ENOENT a sequencia e `error -> close` e `'exit'` nunca dispara);
 *   - `terminate()` escala `SIGTERM -> graceMs -> SIGKILL` sobre o GRUPO
 *     (`detached: true` faz do filho o lider do proprio grupo);
 *   - o `stdio` vem do spec, nunca fixo.
 */
class RealSubprocessHandle {
  readonly child: ChildProcess
  readonly done: Promise<SubprocessOutcome>
  private readonly spec: SubprocessSpawnSpec
  private terminated = false
  private killTimer: ReturnType<typeof setTimeout> | undefined

  constructor(spec: SubprocessSpawnSpec) {
    this.spec = spec
    this.child = spawn(spec.argv[0] ?? '', spec.argv.slice(1), {
      cwd: spec.cwd,
      detached: true,
      stdio: [
        spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore',
        spec.stdio.stdout === 'pipe' ? 'pipe' : 'ignore',
        spec.stdio.stderr === 'pipe' ? 'pipe' : 'ignore',
      ],
      env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })

    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      let spawnError: Error | undefined
      let didSpawn = false
      this.child.on('spawn', (): void => {
        didSpawn = true
      })
      this.child.on('error', (error: Error): void => {
        if (!didSpawn) spawnError = error
      })
      this.child.on('close', (code, signal): void => {
        if (this.killTimer !== undefined) clearTimeout(this.killTimer)
        if (spawnError !== undefined) {
          reject(spawnError)
          return
        }
        resolve({ exitCode: code, signal })
      })
    })
  }

  get pid(): number {
    return this.child.pid ?? -1
  }

  get stdout(): NodeJS.ReadableStream | undefined {
    return this.child.stdout ?? undefined
  }

  get stderr(): NodeJS.ReadableStream | undefined {
    return this.child.stderr ?? undefined
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    const { pid } = this
    if (pid <= 0) return
    signalGroup(pid, 'SIGTERM')
    this.killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), this.spec.graceMs)
    this.killTimer.unref()
  }

  async waitForExit(): Promise<boolean> {
    return this.done.then(
      () => true,
      () => true,
    )
  }
}

/** `-pid` alveja o GRUPO inteiro. ESRCH significa "ja nao existe": objetivo cumprido. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    void error
  }
}

class RealSubprocessService {
  readonly children: RealSubprocessHandle[] = []

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new RealSubprocessHandle(spec)
    this.children.push(handle)
    return handle as unknown as SubprocessHandle
  }

  /** Rede de seguranca: nenhum teste pode deixar processo vivo atras de si. */
  killAll(): void {
    for (const child of this.children) {
      if (child.pid > 0) signalGroup(child.pid, 'SIGKILL')
    }
  }

  async settleAll(): Promise<void> {
    await Promise.race([
      Promise.all(this.children.map((child) => child.done.catch(() => undefined))),
      timersSleep(10_000),
    ])
  }
}

/** Espera ATIVA por uma condicao (o predicado pode ser assincrono). */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await timersSleep(stepMs)
  }
  return predicate()
}

/** Acumula um stream num buffer (consumidor DURAVEL, exigido pelo contrato). */
function accumulate(stream: NodeJS.ReadableStream | undefined | null): { text: () => string } {
  let buffer = ''
  if (stream !== undefined && stream !== null) {
    stream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
  }
  return { text: (): string => buffer }
}

describe('T6.1 — descoberta da URL pelos DOIS caminhos, contra o dublê REAL', () => {
  const service = new RealSubprocessService()
  const origins: Server[] = []

  after(async () => {
    service.killAll()
    await service.settleAll()
    for (const origin of origins) {
      await new Promise<void>((resolve) => origin.close(() => resolve()))
    }
  })

  it('caminho metrics: a URL sai do GET /quicktunnel e o stderr fica para o log', async () => {
    const { server: origin, port: originPort } = await listenOrigin()
    origins.push(origin)
    const metricsPort = await reservePort()

    // O SPEC CANONICO do produto (T3.1): argv montado por buildCloudflaredArgv
    // com a porta de metricas PINADA — nunca adivinhada (TUN-011).
    const spec: SubprocessSpawnSpec = {
      argv: buildCloudflaredArgv({
        binaryPath: DOUBLE_PATH,
        mode: 'quick',
        originPort,
        metricsPort,
      }),
      cwd: tmpdir(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      env: { ...buildCloudflaredEnv(), FAKE_CF_HOSTNAME: HOSTNAME_METRICS, FAKE_CF_URL_DELAY_MS: '3000' },
    }
    const handle = service.spawn(spec)

    // Consumidor DURAVEL do stderr, ligado ANTES da descoberta (obrigacao do
    // contrato de TunnelDiscoveryInput: sem ele o pipe enche e o tunel congela).
    const stderrText = accumulate(handle.stderr)
    // O stdout do cloudflared fica com 0 bytes — medido. Asserido no fim.
    const stdoutText = accumulate(handle.stdout)

    // O servidor de metricas leva uns milissegundos a bindar. Espera-se que o
    // endpoint exista ANTES de chamar a descoberta, para que o caminho metrics
    // ganhe por merito e nao por corrida com o banner (que esta atrasado 3 s).
    const metricsUp = await waitFor(
      async (): Promise<boolean> => {
        try {
          const response = await fetch('http://127.0.0.1:' + String(metricsPort) + '/quicktunnel')
          return response.status === 200
        } catch (error) {
          void error
          return false
        }
      },
      { timeoutMs: 10_000 },
    )
    assert.equal(metricsUp, true, 'o servidor de metricas do dublê nunca ficou pronto')

    const discovery: TunnelDiscovery = createTunnelDiscovery()
    const result = await discovery.discover({
      metricsPort,
      stderr: handle.stderr ?? null,
      signal: new AbortController().signal,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    })

    assert.equal(result.via, 'metrics')
    assert.equal(result.url, 'https://' + HOSTNAME_METRICS)
    // O banner CHEGA pelo stderr COM ATRASO (FAKE_CF_URL_DELAY_MS=3000) — e o
    // consumidor duravel (nao o scanner, ja desligado) que o regista. A URL
    // existe nos dois fluxos, mas o endpoint estruturado e o preferido.
    const bannerChegou = await waitFor(
      () => stderrText.text().includes('https://' + HOSTNAME_METRICS),
      { timeoutMs: 6_000 },
    )
    assert.equal(bannerChegou, true, 'o banner da URL devia ter passado pelo stderr')
    // Medido: o stdout do cloudflared fica com 0 bytes. O dublê honra isso.
    assert.equal(stdoutText.text(), '', 'o stdout do cloudflared fica com 0 bytes (medido)')

    handle.terminate()
    const outcome = await handle.waitForExit()
    assert.equal(outcome, true, 'o dublê devia sair apos SIGTERM')
  })

  it('caminho stderr: com /quicktunnel inalcancavel, o regex salva o dia (via=stderr)', async () => {
    // A aplicacao sonda a porta PINADA... onde NINGUEM atende: o dublê corre
    // com metricas em porta efemera (o default do binario real quando a porta
    // pinada nao liga). E o cenario que o contrato exige cobrir: /quicktunnel
    // nao e documentado e pode falhar sem aviso — o fallback e obrigatorio.
    const metricsPortApp = await reservePort()

    const spec: SubprocessSpawnSpec = {
      argv: [DOUBLE_PATH, '--metrics', '127.0.0.1:0'],
      cwd: tmpdir(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3000,
      env: { ...buildCloudflaredEnv(), FAKE_CF_HOSTNAME: HOSTNAME_STDERR },
    }
    const handle = service.spawn(spec)
    const stderrText = accumulate(handle.stderr)

    // A descoberta e chamada IMEDIATAMENTE apos o spawn: o scanner dela liga-se
    // ANTES de o banner passar (o dublê escreve-o ~50 ms depois de arrancar).
    // Se se esperasse pelo banner primeiro, o scanner perderia-o — o fluxo nao
    // repete — e o teste demoraria 30 s a falhar por uma razao de ORDEM.
    const discovery: TunnelDiscovery = createTunnelDiscovery()
    const result = await discovery.discover({
      metricsPort: metricsPortApp,
      stderr: handle.stderr ?? null,
      signal: new AbortController().signal,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    })

    assert.equal(result.via, 'stderr')
    assert.equal(result.url, 'https://' + HOSTNAME_STDERR)
    // Controlo positivo: o banner existiu mesmo no stderr (o scanner nao
    // inventou a URL — o consumidor duravel registou os mesmos bytes).
    assert.ok(
      stderrText.text().includes('https://' + HOSTNAME_STDERR),
      'o banner da URL devia ter passado pelo stderr',
    )

    handle.terminate()
    assert.equal(await handle.waitForExit(), true)
  })

  it('TUN-005: a URL que so existe no STDOUT e RECUSADA (timeout, nunca aceite)', async () => {
    // O dublê nao tem modo stdout-only (adicionar um modo era mudanca de
    // contrato). O cenario e montado com um involucro sh: o stderr do dublê e
    // redirecionado para o STDOUT do involucro e o stderr do involucro vai
    // para /dev/null. A descoberta le apenas o stderr do involucro — vazio —
    // e TEM de recusar a URL que esta no stdout (TUN-005).
    const metricsPortApp = await reservePort()

    const wrapper = spawn(
      'sh',
      [
        '-c',
        'exec 2>/dev/null; exec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(DOUBLE_PATH) +
          ' --metrics 127.0.0.1:0 2>&1',
      ],
      // O hostname do cenario entra por ambiente, herdado pelo dublê.
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FAKE_CF_HOSTNAME: HOSTNAME_STDOUT } },
    )
    const wrapperOut = accumulate(wrapper.stdout)
    const wrapperErr = accumulate(wrapper.stderr)

    // CONTROLOS POSITIVOS: a URL EXISTE, mas no fluxo errado.
    const urlNoStdout = await waitFor(
      () => wrapperOut.text().includes('https://' + HOSTNAME_STDOUT),
      { timeoutMs: 10_000 },
    )
    assert.equal(urlNoStdout, true, 'a URL devia estar no stdout do involucro')
    assert.equal(wrapperErr.text(), '', 'o stderr do involucro tem de estar vazio')

    const discovery: TunnelDiscovery = createTunnelDiscovery()
    // 30 s de relogio de parede, de proposito: e o piso do contrato
    // (MIN_DISCOVERY_TIMEOUT_MS) e o proprio teste e a prova — um parser que
    // aceitasse a URL do stdout devolveria AQUI em vez de esgotar o prazo.
    await assert.rejects(
      discovery.discover({
        metricsPort: metricsPortApp,
        stderr: wrapper.stderr,
        signal: new AbortController().signal,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /READINESS_TIMEOUT|nao publicou nenhuma URL/u)
        return true
      },
    )

    wrapper.kill('SIGKILL')
  })
})
