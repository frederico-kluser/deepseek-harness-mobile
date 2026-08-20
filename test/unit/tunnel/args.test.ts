/**
 * `src/tunnel/args.ts` -- TUN-011, TUN-013, TUN-014 e a prova de posse da origem.
 *
 * Estes tres casos existem porque cada um ja causou, ou causaria, uma fuga:
 *   - TUN-011: a porta de metricas default e DISPUTADA; ler o servidor de
 *     metricas errado e ler a URL do tunel de outra pessoa;
 *   - TUN-013: `--loglevel debug` regista TODOS os cabecalhos, incluindo o
 *     `Authorization` e o cookie de sessao do dono;
 *   - TUN-014: `argv` e legivel por qualquer processo local em
 *     `/proc/<pid>/cmdline` e no `ps`.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { describe, it } from 'node:test'

import {
  assertNoForbiddenArgv,
  buildCloudflaredArgv,
  buildCloudflaredEnv,
  originPortOfOwnServer,
  resolveCloudflaredCommand,
} from '../../../src/tunnel/args.ts'
import { SpawnSpecError } from '../../../src/proc/failure.ts'

const QUICK = {
  binaryPath: '/opt/bin/cloudflared',
  mode: 'quick',
  originPort: 45_123,
  metricsPort: 37_373,
} as const

/** Sobe um servidor numa porta EFEMERA. Nunca uma porta fixa, nunca a 3080. */
function listenEphemeral(): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

describe('TUN-011: `--metrics` e sempre explicito, em 127.0.0.1', () => {
  it('a flag existe e leva a porta que NOS escolhemos', () => {
    const argv = buildCloudflaredArgv(QUICK)
    const index = argv.indexOf('--metrics')

    assert.notEqual(index, -1, 'sem --metrics a descoberta le a porta que o binario escolher')
    assert.equal(argv[index + 1], '127.0.0.1:37373')
  })

  it('recusa uma porta que nao seja um inteiro de 1 a 65535', () => {
    for (const metricsPort of [0, -1, 1.5, 65_536, Number.NaN]) {
      assert.throws(() => buildCloudflaredArgv({ ...QUICK, metricsPort }), SpawnSpecError)
    }
  })
})

describe('TUN-013: `--loglevel debug` e impossivel de ativar', () => {
  it('o argv leva um nivel EXPLICITO e nunca `debug`', () => {
    const argv = buildCloudflaredArgv(QUICK)
    const flat = argv.join(' ')

    assert.equal(flat.includes('--loglevel debug'), false)
    assert.equal(flat.includes('--loglevel trace'), false)
    assert.equal(argv[argv.indexOf('--loglevel') + 1], 'info')
  })

  it('a guarda recusa a flag proibida em TODAS as grafias que o `urfave/cli` aceita', () => {
    /*
     * A versao anterior desta guarda procurava a substring `'--loglevel debug'`
     * na linha inteira, e por isso era CEGA a `--loglevel=debug` — que nao e uma
     * forma exotica, e a forma CANONICA do `urfave/cli`, a biblioteca de linha de
     * comando do proprio `cloudflared`. A guarda prometia fazer tropecar quem
     * acrescentasse uma flag "so para depurar" e deixava passar precisamente a
     * escrita mais provavel. Cada linha abaixo passava antes.
     */
    const proibidos: ReadonlyArray<readonly string[]> = [
      ['cloudflared', 'tunnel', '--loglevel', 'debug'],
      ['cloudflared', 'tunnel', '--LOGLEVEL', 'DEBUG'],
      ['cloudflared', 'tunnel', '--loglevel=debug'],
      ['cloudflared', 'tunnel', '--LOGLEVEL=DEBUG'],
      ['cloudflared', 'tunnel', '--log-level', 'debug'],
      ['cloudflared', 'tunnel', '--log-level=debug'],
      ['cloudflared', 'tunnel', '-loglevel=debug'],
      ['cloudflared', 'tunnel', '--loglevel', 'trace'],
      ['cloudflared', 'tunnel', '--loglevel=trace'],
    ]
    for (const argv of proibidos) {
      assert.throws(() => assertNoForbiddenArgv(argv), SpawnSpecError, argv.join(' '))
    }
  })

  it('a guarda recusa `--token` nas duas grafias, e NAO confunde com `--token-file`', () => {
    assert.throws(
      () => assertNoForbiddenArgv(['cloudflared', 'run', '--token', 'eyJhIjoiU0VHUkVETyJ9']),
      SpawnSpecError,
    )
    assert.throws(
      () => assertNoForbiddenArgv(['cloudflared', 'run', '--token=eyJhIjoiU0VHUkVETyJ9']),
      SpawnSpecError,
    )
    // `--token-file` leva um CAMINHO, nao o segredo: e a forma correcta e tem de
    // continuar a passar, nas duas grafias.
    assert.doesNotThrow(() => assertNoForbiddenArgv(['cloudflared', 'run', '--token-file', '/x/y']))
    assert.doesNotThrow(() => assertNoForbiddenArgv(['cloudflared', 'run', '--token-file=/x/y']))
  })

  it('niveis permitidos passam nas duas grafias', () => {
    assert.doesNotThrow(() => assertNoForbiddenArgv(['cloudflared', '--loglevel', 'info']))
    assert.doesNotThrow(() => assertNoForbiddenArgv(['cloudflared', '--loglevel=info']))
    assert.doesNotThrow(() => assertNoForbiddenArgv(['cloudflared', '--loglevel', 'warn']))
  })

  it('o nivel tambem nao pode entrar por ambiente: `TUNNEL_LOGLEVEL` leva lapide', () => {
    const env = buildCloudflaredEnv()
    // `undefined` e uma LAPIDE no contrato do assento: remove a entrada ambiente
    // do filho. A chave TEM de existir no objeto -- omiti-la deixava a variavel
    // do shell do utilizador passar.
    assert.equal(Object.hasOwn(env, 'TUNNEL_LOGLEVEL'), true)
    assert.equal(env['TUNNEL_LOGLEVEL'], undefined)
  })
})

describe('TUN-014: o token de named tunnel entra por ficheiro, NUNCA por argv', () => {
  const SEGREDO = 'eyJhIjoiSEVSRS1FU1RBLU8tU0VHUkVET' // token de teste, forma realista

  it('usa `--token-file` e o SEGREDO nao aparece em lado nenhum do argv', () => {
    const argv = buildCloudflaredArgv({
      binaryPath: '/opt/bin/cloudflared',
      mode: 'named',
      originPort: 45_123,
      metricsPort: 37_373,
      tokenFile: '/caminho/para/token',
    })

    assert.equal(argv.includes('--token-file'), true)
    assert.equal(argv.includes('--token'), false)
    assert.equal(
      argv.some((argument) => argument.includes(SEGREDO)),
      false,
      'Q-4: /proc/<pid>/cmdline e legivel por qualquer processo do mesmo utilizador',
    )
    assert.equal(argv[argv.indexOf('--token-file') + 1], '/caminho/para/token')
  })

  it('`named` sem `tokenFile` e recusado, e nao ha caminho que caia para `--token`', () => {
    assert.throws(
      () =>
        buildCloudflaredArgv({
          binaryPath: undefined,
          mode: 'named',
          originPort: 45_123,
          metricsPort: 37_373,
        }),
      SpawnSpecError,
    )
  })

  it('`TUNNEL_TOKEN` do ambiente do utilizador tambem leva lapide', () => {
    assert.equal(buildCloudflaredEnv()['TUNNEL_TOKEN'], undefined)
    assert.equal(Object.hasOwn(buildCloudflaredEnv(), 'TUNNEL_TOKEN'), true)
  })
})

describe('modo quick: a origem e sempre loopback', () => {
  it('aponta para `http://127.0.0.1:<porta>` e nunca para `localhost`', () => {
    const argv = buildCloudflaredArgv(QUICK)
    assert.equal(argv[argv.indexOf('--url') + 1], 'http://127.0.0.1:45123')
    // `localhost` pode resolver para `::1` e apontar para OUTRO socket que nao o
    // que provamos ser nosso.
    assert.equal(argv.join(' ').includes('localhost'), false)
  })

  it('`--no-autoupdate` esta presente: um binario que se troca sozinho troca o que medimos', () => {
    assert.equal(buildCloudflaredArgv(QUICK).includes('--no-autoupdate'), true)
  })
})

describe('o alvo do tunel e um SERVIDOR PROVADO, nunca um numero de porta', () => {
  it('deriva a porta de um `net.Server` deste processo em escuta', async () => {
    const server = await listenEphemeral()
    try {
      const port = originPortOfOwnServer(server)
      assert.equal(typeof port, 'number')
      assert.equal(port > 0, true)
      assert.notEqual(port, 3080, 'nenhum teste desta suite toca na porta do DSH real')
    } finally {
      server.close()
    }
  })

  it('RECUSA um servidor que ainda nao fez listen(): sem listen nao ha prova de posse', () => {
    const server = createServer()
    assert.throws(() => originPortOfOwnServer(server), SpawnSpecError)
  })

  it('a guarda `listening` e a que decide, e NAO o `address()` a devolver null', () => {
    /*
     * Num servidor real do Node, `address()` passa a devolver `null` assim que
     * `listening` fica `false`, e por isso a guarda seguinte apanhava o caso por
     * ACIDENTE — removendo `!server.listening` nenhum teste morria. Isso e um
     * detalhe de implementacao do Node, nao uma garantia documentada, e a linha
     * de cima chama-se "o controlo mais importante do ficheiro".
     *
     * Este duble separa as duas coisas: `listening: false` com um endereco
     * perfeitamente valido. Se a guarda desaparecer, isto devolve 45123 e o teste
     * fica vermelho — que e o unico estado em que a guarda esta viva.
     */
    const naoEscuta = {
      listening: false,
      address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 45_123 }),
    } as unknown as Server

    assert.throws(() => originPortOfOwnServer(naoEscuta), SpawnSpecError)
  })

  it('RECUSA ausencia de servidor', () => {
    assert.throws(() => originPortOfOwnServer(undefined), SpawnSpecError)
    assert.throws(() => originPortOfOwnServer(null), SpawnSpecError)
  })

  it('a posse e verificada no INSTANTE DO USO: um servidor ja fechado deixa de servir', async () => {
    const server = await listenEphemeral()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // `cloudflared --url http://localhost:3080` publica o que estiver na porta.
    // Verificar uma vez no arranque deixava a janela em que o servidor morre e a
    // porta e ocupada por outra coisa qualquer.
    assert.throws(() => originPortOfOwnServer(server), SpawnSpecError)
  })
})

describe('resolucao do comando', () => {
  it('ausente significa `cloudflared`, resolvido pelo PATH do assento', () => {
    assert.equal(resolveCloudflaredCommand(undefined), 'cloudflared')
    assert.equal(resolveCloudflaredCommand('   '), 'cloudflared')
    assert.equal(resolveCloudflaredCommand('/opt/bin/cloudflared'), '/opt/bin/cloudflared')
  })
})
