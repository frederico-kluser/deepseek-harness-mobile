/**
 * =============================================================================
 * `argv` do `cloudflared`. Array SEMPRE, `shell` NUNCA.
 * =============================================================================
 *
 * Tres controlos de seguranca vivem neste ficheiro, e nenhum deles e convencao:
 *
 * 1. `--metrics 127.0.0.1:PORT` EXPLICITO E FIXO — E NAO SE AFIRMA AQUI QUAL E O
 *    DEFAULT. As fontes congeladas deste repositorio contradizem-se sobre isso:
 *    `src/contracts/tunnel.ts` e `04-TESTES.md` TUN-011 dizem "porta aleatoria,
 *    com fallback 20241-20245"; o cabecalho de `test/bin/fake-cloudflared.mjs`
 *    diz, com enfase, o oposto. Resolver a contradicao exigiria medir o binario
 *    REAL, e este plano proibe faze-lo aqui (D10). Escrever uma das versoes seria
 *    afirmar o que nao se sabe.
 *
 *    A CONCLUSAO OPERACIONAL NAO DEPENDE DE QUAL DELAS ESTA CERTA, e e por isso
 *    que o controlo existe na mesma: nos dois mundos a porta default e
 *    DISPUTADA. Dois `cloudflared` na mesma maquina, ou qualquer processo sentado
 *    na porta que o binario escolher, deslocam-na em silencio — e a descoberta de
 *    URL passaria a ler o servidor de metricas DE OUTRO TUNEL. Nao se confia no
 *    default, nao se adivinha a faixa: passa-se a porta, sempre.
 *
 * 2. `--token-file`, NUNCA `--token`. `argv` e legivel por qualquer processo do
 *    mesmo utilizador em `/proc/<pid>/cmdline` e no `ps`. Um token de named
 *    tunnel em `argv` e uma credencial publicada para a maquina inteira. Q-4:
 *    "segredo nunca em argv".
 *
 * 3. `--loglevel debug` PROIBIDO POR CODIGO. O modo debug do `cloudflared` regista
 *    URLs, metodos e TODOS os cabecalhos das requisicoes que atravessam o tunel
 *    — ou seja, o `Authorization` e o `Cookie` de sessao dos pedidos autenticados
 *    do dono. Nao basta "nao escrever a flag": o nivel tambem entra por ambiente
 *    (`TUNNEL_LOGLEVEL`), e por isso o nivel e escrito EXPLICITAMENTE no `argv` e
 *    a variavel de ambiente e apagada com uma lapide.
 *
 * NAO MEDIDO, e declarado como tal (`05-QUALIDADE-CODIGO.md` 7.4): a precedencia
 * "flag de linha de comando ganha da variavel de ambiente" e o comportamento
 * normal do `urfave/cli`, que o `cloudflared` usa, mas NAO foi medido por esta
 * sub-tarefa. Por isso os dois controlos existem em vez de um: a flag explicita E
 * a lapide no ambiente. Se a precedencia fosse ao contrario, a lapide sozinha
 * ainda fecharia o caso.
 */

import type { Server } from 'node:http'
import { tmpdir } from 'node:os'

import type { TunnelConfig, TunnelFailure, TunnelMode } from '../contracts/tunnel.ts'
import type { SubprocessSpawnSpec } from '../dsh/adapter.ts'
import { SpawnSpecError, type ProcessFailure } from '../proc/failure.ts'

/** Interface de escuta do servidor de metricas. Loopback, e so loopback. */
export const METRICS_HOST = '127.0.0.1'

/**
 * Nivel de log escrito explicitamente no `argv`.
 *
 * `'info'` e o nivel em que o banner da URL sai em `stderr` — que e o caminho de
 * fallback da descoberta (T3.2). Baixar para `warn` calaria esse banner e
 * deixaria a descoberta so com o caminho primario.
 */
export const CLOUDFLARED_LOGLEVEL = 'info'

/**
 * Nomes de flag de nivel de log, ja sem os tracos iniciais.
 *
 * `log-level` esta aqui porque o `urfave/cli` aceita alias, e um alias que
 * ninguem verificou e a flag proibida por outro nome.
 */
const LOGLEVEL_FLAG_NAMES: ReadonlySet<string> = new Set(['loglevel', 'log-level'])

/** Niveis que registam URLs, metodos e TODOS os cabecalhos. */
const FORBIDDEN_LOGLEVELS: ReadonlySet<string> = new Set(['debug', 'trace'])

/** `--token` entrega o segredo em `argv`. `--token-file` entrega um CAMINHO. */
const FORBIDDEN_FLAG_NAMES: ReadonlySet<string> = new Set(['token'])

/**
 * Janela de graca por omissao (`SubprocessSpawnSpec.graceMs`), alinhada com
 * `worker.graceMs`. O `--grace-period` do proprio `cloudflared` tem default 30 s;
 * o nosso e passado EXPLICITAMENTE porque o assento nao aplica defaults nenhuns
 * ("this seam applies no defaults") e um `graceMs` em falta seria um erro de spec.
 */
export const DEFAULT_GRACE_MS = 3000

/**
 * Orcamento de reinicio por omissao. Os numeros sao os MESMOS do supervisor do
 * worker, e isso e deliberado: T3.1 generaliza o supervisor em vez de o duplicar,
 * e dois orcamentos diferentes para o mesmo mecanismo seriam a primeira fenda por
 * onde a generalizacao deixaria de ser real.
 */
export const DEFAULT_TUNNEL_BACKOFF = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 10,
  resetAfterMs: 60_000,
} as const

/** Comando efetivo do `cloudflared`. Ausente = resolvido pelo `PATH` do assento. */
export function resolveCloudflaredCommand(binaryPath: string | undefined): string {
  const declared = binaryPath?.trim()
  if (declared !== undefined && declared.length > 0) return declared

  /**
   * DETECTAR E RESOLVER UM NOME, NAO INSTALAR NADA. Nao ha varredura de `PATH`
   * aqui de proposito: quem resolve executaveis e o assento de subprocessos
   * (`resolveExecutable`, "bare names use the provider's scrubbed PATH"), e uma
   * varredura nossa seria uma SEGUNDA resposta a mesma pergunta — com uma janela
   * entre verificar e usar, e com o `PATH` deste processo em vez do `PATH` do
   * mundo de execucao do assento. A ausencia do binario e detectada onde ela
   * acontece: `ENOENT` no spawn, classificado como NAO-RETRYABLE
   * (`src/proc/failure.ts`), com mensagem accionavel e sem gastar orcamento.
   */
  return 'cloudflared'
}

/**
 * Porta da ORIGEM, derivada de um `net.Server` DESTE processo e EM ESCUTA.
 *
 * PORQUE NAO ACEITA UM NUMERO, e este e o controlo mais importante do ficheiro:
 * `cloudflared --url http://localhost:3080` publica na Internet o que estiver
 * naquela porta, sem perguntar nada a ninguem. Durante a pesquisa que originou
 * este plano a porta 3080 ja estava ocupada pelo DSH do utilizador, o origin de
 * teste nao conseguiu bindar, e o quick tunnel expos o Harness real, publicamente
 * e sem autenticacao, durante ~40 segundos.
 *
 * Um numero de porta e uma AFIRMACAO sobre o mundo ("ali esta o meu servidor"). Um
 * `Server` com `listening === true` e uma PROVA: `listen()` numa porta que outro
 * processo ja serve falha com `EADDRINUSE` antes de existir servidor. A posse e
 * verificada no INSTANTE DO USO — o `buildSpec` do supervisor chama isto a cada
 * tentativa — e nao uma vez no arranque, porque um servidor fechado entretanto
 * deixa de ser prova.
 */
export function originPortOfOwnServer(server: Server | undefined | null): number {
  if (server === undefined || server === null) {
    throw new SpawnSpecError(
      'o alvo do tunel precisa de ser um servidor HTTP deste processo; nao foi fornecido nenhum.',
    )
  }
  if (!server.listening) {
    throw new SpawnSpecError(
      'o servidor alvo do tunel nao esta em escuta; sem `listen()` bem sucedido nao ha prova de posse da porta.',
    )
  }

  const address = server.address()
  if (address === null || typeof address === 'string') {
    // Socket de dominio UNIX (ou endereco indisponivel): nao ha porta TCP para
    // apontar, e inventar uma seria apontar o tunel para um servico qualquer.
    throw new SpawnSpecError(
      'o servidor alvo do tunel nao esta ligado a uma porta TCP; nao ha origem que se possa publicar.',
    )
  }
  if (!Number.isInteger(address.port) || address.port <= 0 || address.port > 65535) {
    throw new SpawnSpecError('o servidor alvo do tunel devolveu uma porta invalida.')
  }

  return address.port
}

/** Tudo o que decide a linha de comando de uma tentativa de tunel. */
export interface CloudflaredArgvInput {
  readonly binaryPath: string | undefined
  readonly mode: TunnelMode
  /** Porta da origem, ja PROVADA por {@link originPortOfOwnServer}. */
  readonly originPort: number
  /** Porta do servidor de metricas, escolhida por nos e sempre explicita. */
  readonly metricsPort: number
  /** Caminho do ficheiro `0600` com o token. Obrigatorio sse `mode === 'named'`. */
  readonly tokenFile?: string | undefined
}

/**
 * Monta o `argv` do `cloudflared`.
 *
 * O `argv` e TOTALMENTE determinado por esta funcao: nao ha campo de "argumentos
 * extra" na configuracao, e essa ausencia e a decisao. Um canal por onde o
 * utilizador injeta flags e um canal por onde `--loglevel debug` volta.
 */
export function buildCloudflaredArgv(input: CloudflaredArgvInput): readonly string[] {
  assertUsablePort(input.metricsPort, 'metricsPort')
  assertUsablePort(input.originPort, 'originPort')

  const argv: string[] = [
    resolveCloudflaredCommand(input.binaryPath),
    'tunnel',
    // Um binario que se actualiza sozinho troca, sem aviso, o programa que este
    // supervisor mede e cujo comportamento os testes congelam.
    '--no-autoupdate',
    // Nivel EXPLICITO: ver o controlo 3 no cabecalho.
    '--loglevel',
    CLOUDFLARED_LOGLEVEL,
    // Porta de metricas EXPLICITA: ver o controlo 1 no cabecalho.
    '--metrics',
    `${METRICS_HOST}:${String(input.metricsPort)}`,
  ]

  if (input.mode === 'named') {
    const tokenFile = input.tokenFile?.trim()
    if (tokenFile === undefined || tokenFile.length === 0) {
      throw new SpawnSpecError(
        'tunnel.mode e `named` mas nao ha `tunnel.tokenFile`. O token de um named tunnel ' +
          'entra por ficheiro, nunca por argv — e sem ele nao ha tunel nenhum a subir.',
      )
    }
    // `run` + `--token-file`: o token fica no ficheiro, e o `argv` so carrega o
    // CAMINHO. Ver o controlo 2 no cabecalho.
    argv.push('run', '--token-file', tokenFile)
  } else {
    // Quick tunnel: a origem e a porta PROVADA acima, sempre em loopback. Nunca
    // `localhost`, que pode resolver para `::1` e apontar para outro socket.
    argv.push('--url', `http://${METRICS_HOST}:${String(input.originPort)}`)
  }

  assertNoForbiddenArgv(argv)
  return argv
}

/**
 * O SPEC COMPLETO de uma tentativa de spawn do `cloudflared`.
 *
 * Vive aqui, e nao no supervisor, porque tudo o que ele decide e "como se lanca
 * este binario": o `argv`, o ambiente, o `cwd` e a janela de graca. O supervisor
 * decide QUANDO lancar; este ficheiro decide COM O QUE.
 */
export function buildCloudflaredSpec(input: {
  readonly config: TunnelConfig
  readonly metricsPort: number
  readonly origin: Server
  readonly signal: AbortSignal
}): SubprocessSpawnSpec {
  const { config } = input

  return {
    argv: buildCloudflaredArgv({
      binaryPath: config.binaryPath,
      mode: config.mode,
      originPort: originPortOfOwnServer(input.origin),
      metricsPort: input.metricsPort,
      tokenFile: config.tokenFile,
    }),
    // O temporario do sistema existe sempre e NAO e o workspace do utilizador: um
    // ficheiro perdido nunca aterra num repositorio versionado.
    cwd: tmpdir(),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    signal: input.signal,
    env: buildCloudflaredEnv(),
  }
}

/**
 * Ambiente EXPLICITO do `cloudflared`.
 *
 * `undefined` e uma LAPIDE no contrato do assento ("a tombstone that removes an
 * ordinary ambient entry from the child"), e e isso que se usa aqui: o nivel de
 * log e o token nao podem entrar por ambiente herdado. Sem as lapides, um
 * `TUNNEL_TOKEN` exportado no shell do utilizador passaria a ser a credencial
 * efetiva do tunel sem que nada na configuracao o dissesse, e um
 * `TUNNEL_LOGLEVEL=debug` reactivaria o registo de cabecalhos que o controlo 3
 * existe para impedir.
 */
export function buildCloudflaredEnv(): NodeJS.ProcessEnv {
  return {
    TUNNEL_TOKEN: undefined,
    TUNNEL_LOGLEVEL: undefined,
    TUNNEL_METRICS: undefined,
    TUNNEL_ORIGIN_CERT: undefined,
  }
}

/**
 * Parte o `argv` em TOKENS, resolvendo a forma `--flag=valor`.
 *
 * ISTO E O DEFEITO QUE A VERIFICACAO ANTERIOR TINHA, e ele era grave: ela
 * procurava a substring `'--loglevel debug'` na linha inteira e por isso era CEGA
 * a `--loglevel=debug`, a `--token=<segredo>` e ao alias `--log-level debug`. E
 * `--flag=valor` nao e uma forma exotica: e a forma CANONICA do `urfave/cli`, que
 * e a biblioteca de linha de comando do proprio `cloudflared`. A guarda prometia
 * fazer tropecar quem acrescentasse uma flag "so para depurar" e deixava passar
 * precisamente a escrita mais provavel.
 *
 * O nome da flag e devolvido sem tracos e em minusculas; o valor fica intacto.
 */
function tokenizeArgv(argv: readonly string[]): Array<{ flag: string | null; value: string }> {
  const tokens: Array<{ flag: string | null; value: string }> = []

  for (const argument of argv) {
    if (!argument.startsWith('-')) {
      tokens.push({ flag: null, value: argument })
      continue
    }
    const separator = argument.indexOf('=')
    const name = separator === -1 ? argument : argument.slice(0, separator)
    // Um ou dois tracos: o `urfave/cli` aceita `-flag` e `--flag` como o mesmo.
    tokens.push({ flag: name.replace(/^-+/u, '').toLowerCase(), value: '' })
    if (separator !== -1) tokens.push({ flag: null, value: argument.slice(separator + 1) })
  }

  return tokens
}

/**
 * Recusa um `argv` proibido.
 *
 * PORQUE EXISTE, se o `argv` e todo montado acima: e o guardiao da proxima
 * edicao. Alguem que acrescente uma flag "so para depurar" tropeca aqui, e o
 * teste TUN-013 falha antes de o commit sair da maquina. Um controlo que so
 * existe no cuidado de quem escreve nao e um controlo — e um controlo que so
 * reconhece UMA das duas grafias da mesma flag tambem nao.
 */
export function assertNoForbiddenArgv(argv: readonly string[]): void {
  const tokens = tokenizeArgv(argv)

  for (const [index, token] of tokens.entries()) {
    if (token.flag === null) continue

    if (FORBIDDEN_FLAG_NAMES.has(token.flag)) {
      throw new SpawnSpecError(
        'o argv do cloudflared nao pode conter `--token`: o `argv` e legivel por ' +
          'qualquer processo do mesmo utilizador em `/proc/<pid>/cmdline` e no `ps`. ' +
          'O token de um named tunnel entra por `--token-file`.',
      )
    }

    if (!LOGLEVEL_FLAG_NAMES.has(token.flag)) continue

    const level = (tokens[index + 1]?.value ?? '').toLowerCase()
    if (!FORBIDDEN_LOGLEVELS.has(level)) continue

    throw new SpawnSpecError(
      `o argv do cloudflared nao pode pedir nivel de log \`${level}\`: ` +
        'esse nivel regista URLs, metodos e TODOS os cabecalhos das requisicoes que ' +
        'atravessam o tunel — ou seja, o `Authorization` e o cookie de sessao do dono.',
    )
  }
}

function assertUsablePort(port: number, field: string): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SpawnSpecError(`${field} tem de ser uma porta TCP inteira entre 1 e 65535.`)
  }
}

/**
 * Projecta a falha GENERICA do supervisor de processos na falha do TUNEL.
 *
 * VIVE NESTE FICHEIRO porque a unica coisa que ela acrescenta e CONHECIMENTO
 * SOBRE O BINARIO — onde se instala, o que significa nao o poder executar — e e
 * este o ficheiro que sabe o que e o executavel do `cloudflared`. Nao pode viver
 * em `src/proc/**`: o supervisor generico nao sabe (nem deve saber) que existe um
 * repositorio da Cloudflare em `pkg.cloudflare.com`.
 */
export function toTunnelFailure(processFailure: ProcessFailure): TunnelFailure {
  switch (processFailure.kind) {
    case 'BINARY_NOT_FOUND':
      return {
        code: 'BINARY_NOT_FOUND',
        message:
          'cloudflared nao encontrado. Instale-o pelo repositorio oficial da Cloudflare ' +
          '(pkg.cloudflare.com) ou indique o caminho do binario na configuracao. ' +
          'Tentar de novo sem isso nao adianta.',
        retryable: false,
      }
    case 'BINARY_NOT_EXECUTABLE':
      return {
        code: 'BINARY_NOT_EXECUTABLE',
        message:
          'o cloudflared existe mas esta conta nao o pode executar. ' +
          'Verifique o bit de execucao e volte a ligar.',
        retryable: false,
      }
    case 'INVALID_SPEC':
      return { code: 'INVALID_CONFIG', message: processFailure.message, retryable: false }
    case 'BUDGET_EXHAUSTED':
      return { code: 'BUDGET_EXHAUSTED', message: processFailure.message, retryable: false }
  }
}
