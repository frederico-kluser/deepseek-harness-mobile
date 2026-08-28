/**
 * ENTRYPOINT do processo do bot — BOOT GENERICO POR PROVEDOR (onda 4).
 *
 * Nome do ficheiro PRESERVADO por D1: o host spawna `dist/worker/telegram-bot.js`
 * relativo a `import.meta.url`. O que este processo e, porém, deixou de ser
 * "o bot telegram": a Onda 4 absorveu a costura antiga (`worker/commands/costura.ts`,
 * que a Onda 5 apaga) e passou a montar o NUCLEO NEUTRO de
 * `worker/surface/core.ts` sobre o ADAPTADOR que o registry resolver.
 *
 * ===========================================================================
 * A SEQÜENCIA DO BOOT (D1/D4/D5)
 * ===========================================================================
 * So corre quando e o processo real (ver {@link main}); `runTelegramWorker` e o
 * caminho testavel com env/argv/log/time/ipc injetaveis. A ordem:
 *
 *   1. resolver o provedor (`worker/providers/registry.ts`, fail-closed);
 *   2. ler o token do ambiente (via o token reader DO PROVEDOR); o logger nasce
 *      ANTES, para a falha de leitura sair por algum lado;
 *   3. `assertTokenNaoEmArgv` (TG-069: token NUNCA em `argv`);
 *   4. criar o adaptador: `prov.create({token, apiRoot?, log, time})` — a raiz
 *      da API vem de `prov.apiRootVar` (cada provedor com a SUA env);
 *   5. `sender = adapter.sender()` e `limites = adapter.limits`;
 *   6. armar o canal IPC (`bindWorkerIpcToProcess` + despacho por TABELA +
 *      ponte de nonce + `pairing.owner` -> `nucleo.onOwner` = `auth.semearDono`);
 *   7. montar o NUCLEO neutro com as deps (log, time, ipc bridge, sender,
 *      limites, emitirNonce, parar, auth, comandos);
 *   8. `adapter.start(tratarEvento)` (o polling arranca; um erro terminal faz o
 *      `start()` rejeitar com o `code` do contrato comum e o proceso SAI com
 *      esse codigo — 409/401 do telegram = 11/12, o e2e depende disto);
 *   9. `adapter.publishCommands(COMANDOS_PUBLICADOS)` — TG-080: uma falha e
 *      logada, NAO derruba o boot.
 *
 * O dead-man's switch fica PRESERVADO: o bind do canal (`worker/ipc.ts`)
 * mantém o EOF no stdin -> `proc.exit(0)` quando o host desaparece.
 *
 * ===========================================================================
 * S2 — `stdout` E EXCLUSIVAMENTE JSONL
 * ===========================================================================
 * Nada aqui escreve em `stdout`. Todo o log humano vai para `stderr` via
 * `./lib/log.ts`. O lado JSONL do canal e de T4.3 (`worker/ipc.ts`).
 *
 * ===========================================================================
 * A DEPENDENCIA
 * ===========================================================================
 * `grammy` e a UNICA dependencia de runtime do pacote e e carregada SO pelo
 * adaptador telegram. Este boot nao a importa (o adaptador fornece o contrato
 * neutro). A frase "UMA dependencia de runtime, carregada so pelo processo
 * `worker/`" continua verdadeira.
 */

import { pathToFileURL } from 'node:url'

import type { IpcMessageToWorker } from '../src/contracts/ipc.ts'

import { systemTime, type TimeSource } from './lib/clock.ts'
import { createWorkerLogger, type WorkerLogger, type WorkerLogLevel } from './lib/log.ts'
import { bindWorkerIpcToProcess, type WorkerIpc } from './ipc.ts'
import {
  ProvedorDesconhecidoError,
  criarPonteDeNonce,
  criarSurfaceIpcBridge,
  resolverProvedor,
  type PonteDeNonce,
  type ProvedorDescrito,
} from './providers/registry.ts'
import { isWorkerExitCode, WORKER_EXIT } from './lib/errors.ts'
import { describeForLog } from './lib/redact.ts'
import { criarAuthDeSuperficie, criarDesafioDePareamento } from './surface/auth.ts'
import { criarComandosDeSuperficie, COMANDOS_PUBLICADOS } from './surface/commands.ts'
import type { ProviderAdapter } from './surface/contract.ts'
import { criarNucleo, type Nucleo, type SurfaceAuth } from './surface/core.ts'

/** O que um teste pede ao boot para o parar limpo e ler o codigo de saida. */
export interface BootEmCurso {
  /** Para o adaptador (o polling) e resolve o `runTelegramWorker` com OK. */
  readonly parar: () => Promise<void>
}

/** Tudo o que o processo toca do mundo exterior, para o teste poder substitui-lo. */
export interface WorkerRuntime {
  readonly env?: NodeJS.ProcessEnv
  readonly argv?: readonly string[]
  readonly log?: WorkerLogger
  readonly time?: TimeSource
  /** Processo a que ligar o canal (o dead-man's switch). Omitido, `process`. */
  readonly proc?: NodeJS.Process
  /**
   * Canal IPC PRONTO. Omitido, o boot arma o canal real com
   * `bindWorkerIpcToProcess` (o dead-man's switch do processo). Injetado, o
   * boot usa-o directamente — o que faz o boot testavel sem tocar no `process`
   * do runner (o fake nao emite mensagens do host; so o `send` conta).
   */
  readonly ipc?: WorkerIpc
  /**
   * Descricao do provedor. Omitido, o boot resolve via `resolverProvedor(env)`.
   * Injetado, permite testar falhas do arranque de um provedor arbitrario.
   */
  readonly provider?: ProvedorDescrito
  /** Chamado quando o boot ficou a receber updates e o handle de paragem existe. */
  readonly onBooted?: (boot: BootEmCurso) => void
}

/**
 * O `code` NUMERICO do CONTRATO COMUM (`ProviderError` de
 * `worker/lib/errors.ts`), em QUALQUER erro — sem `instanceof` de classe de
 * provedor. Fora da gama fechada 10..14 (ex.: o `code` do corpo do Discord
 * num `DiscordApiError` que escape) NAO e do contrato e o erro cai no default.
 */
function codeDoContrato(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'number' && isWorkerExitCode(code) ? code : undefined
}

/** Extrai os campos que o nucleo precisa do adaptador — sem conhecer o provedor. */
function montarDoAdaptador(adapter: ProviderAdapter): {
  readonly sender: ReturnType<ProviderAdapter['sender']>
  readonly limites: ProviderAdapter['limits']
} {
  return { sender: adapter.sender(), limites: adapter.limits }
}

/**
 * Corre o worker do principio ao fim e devolve o codigo de saida.
 *
 * NAO chama `process.exit`: devolve. Quem mata o processo e {@link main}, e essa
 * separacao e o que torna todo este caminho testavel sem subprocesso.
 *
 * O retorno resolve:
 *   - com o codigo CLASSIFICADO quando o `adapter.start` rejeita ou o arranque
 *     falha: o boot le o campo `code` do erro (o CONTRATO COMUM de
 *     `worker/lib/errors.ts` — 10/11/12/13/14, numerico, sem `instanceof` de
 *     classe de provedor; os 409/401 do telegram chegam ja com 11/12 do
 *     `classifyPollingError` DO ADAPTADOR) e usa-o tal qual; `ProvedorDesconhecido`
 *     -> 10; qualquer outro erro -> 13 (POLLING, o default);
 *   - com OK apos {@link BootEmCurso.parar} (paragem limpa);
 *   - em producao NORMAL, fica pendente ate o dead-man's switch do canal chamar
 *     `proc.exit(0)` — a promessa e irrelevante quando o processo ja saiu.
 */
export async function runTelegramWorker(runtime: WorkerRuntime = {}): Promise<number> {
  const env = runtime.env ?? process.env
  const argv = runtime.argv ?? process.argv
  const time = runtime.time ?? systemTime

  // O logger nasce ANTES de haver token: se a leitura do token falhar, a falha
  // tem de sair por algum lado. Os segredos entram por FUNCAO (e nao por valor)
  // para que este logger mascare o token que so vai existir daqui a duas linhas.
  let token: string | undefined
  const segredosDe = (): readonly string[] => (token === undefined ? [] : [token])
  const log =
    runtime.log ??
    createWorkerLogger({
      clock: time,
      level: WORKER_LOG_LEVEL,
      secrets: segredosDe,
    })

  let adapter: ProviderAdapter | undefined
  // Para o adaptador (o polling). Com o `start()` do adaptador a aguardar o
  // outcome (resolve no `stopped`/rejeita no 409/401), parar aqui e o que faz
  // o `await adapter.start()` da linha final resolver com OK.
  const parar = async (): Promise<void> => {
    if (adapter !== undefined) {
      try {
        await adapter.stop()
      } catch (error) {
        log.error('falha ao parar o adaptador', { detail: describeForLog(error, segredosDe()) })
      }
    }
  }

  try {
    // 1. resolver o provedor (fail-closed); 2-3. token + argv.
    const prov = runtime.provider ?? resolverProvedor(env)
    token = prov.lerToken(env)
    prov.assertTokenNaoEmArgv(argv, token)

    // 4-5. o adaptador e os campos que o nucleo consome. A raiz da API e a
    // do PROVEDOR (`prov.apiRootVar` — cada um com a SUA env, nunca a do
    // telegram para outro canal); so e passada quando definida.
    const apiRoot = prov.apiRootVar === undefined ? undefined : env[prov.apiRootVar]
    adapter = prov.create({
      token,
      log,
      time,
      ...(apiRoot === undefined || apiRoot === '' ? {} : { apiRoot }),
    })
  } catch (error) {
    // Nunca engolir: a causa sai mascarada, com codigo quando ha codigo. O
    // codigo e lido do CAMPO `code` do erro (contrato comum, numerico) — nao
    // ha `instanceof` de classe de provedor: o erro de QUALQUER adaptador
    // (telegram hoje, discord amanha) classifica-se por si.
    if (error instanceof ProvedorDesconhecidoError) {
      log.error(error.message)
      return WORKER_EXIT.CONFIG
    }
    const code = codeDoContrato(error)
    if (code !== undefined) {
      log.error(error instanceof Error ? error.message : describeForLog(error, segredosDe()), {
        code,
      })
      return code
    }
    log.error('falha nao classificada no arranque do worker', {
      detail: describeForLog(error, segredosDe()),
    })
    return WORKER_EXIT.POLLING
  }

  // O catch retorna SEMPRE: aqui o adaptador existe (TS estreitou-o).
  const { sender, limites } = montarDoAdaptador(adapter)

  // 6. canal IPC + despacho por tabela + ponte de nonce. O `nucleo` nasce
  // DEPOIS do bind (estrutura circular resolvida por closure: o onMessage le
  // uma variavel preenchida a seguir). O `pairing.owner` (host -> worker) nao
  // e renderizavel: o `nucleo.onOwner` re-monta o dono via `auth.semearDono`
  // (8c). A ponte de nonce consome `nonce.issued`/`error` ANTES do nucleo.
  let nucleo: Nucleo | undefined
  let ponte: PonteDeNonce | undefined
  let ipc: WorkerIpc
  const despachar = (msg: IpcMessageToWorker): void => {
    const n = nucleo
    if (n === undefined) return
    switch (msg.type) {
      case 'pairing.owner':
        n.onOwner(msg)
        return
      case 'state':
        n.onState(msg)
        return
      case 'ack':
        n.onAck(msg)
        return
      case 'error':
        if (ponte?.onMessage(msg) === true) return
        n.onError(msg)
        return
      case 'notify':
        n.onNotify(msg)
        return
      case 'pairing.challenge':
        n.onPairingChallenge(msg)
        return
      case 'nonce.issued':
        ponte?.onMessage(msg)
        return
      case 'agent.report':
        // EMENDA ONDA-4-AGENTS-HOST: a lista de runs chega (resposta a
        // agent.status e difusao proativa). O codec VALIDA-a; a RENDERIZACAO
        // e da Onda 5 (superficie) — ate la, a mensagem e descartada de
        // proposito (S4: o desconhecido nao derruba o canal).
        return
    }
  }

  if (runtime.ipc !== undefined) {
    ipc = runtime.ipc
  } else {
    ipc = bindWorkerIpcToProcess(runtime.proc ?? process, { onMessage: (msg) => despachar(msg) })
  }

  const bridge = criarSurfaceIpcBridge(ipc)
  ponte = criarPonteDeNonce({ log, time, ipc })

  // O funil de autorizacao NEUTRO: desafio MORTO (expira no instante 0) ate o
  // host mandar `pairing.challenge`; o dono persistido chega por `pairing.owner`
  // e o `nucleo.onOwner` chama `auth.semearDono` (8c).
  const auth: SurfaceAuth = criarAuthDeSuperficie({
    challenge: criarDesafioDePareamento('000000', 0),
    clock: time,
  })

  // 7. o NUCLEO neutro — monta exatamente o que `criarNucleo` pede. A factory
  // dos comandos e `criarComandosDeSuperficie` (satisfaz `SurfaceComandosFactory`).
  nucleo = criarNucleo({
    log,
    time,
    ipc: bridge,
    sender,
    limites,
    emitirNonce: ponte.emitir,
    parar,
    auth,
    comandos: criarComandosDeSuperficie,
  })

  // 8. arranca o polling. O `adapter.start` cria o bot e entra no `runPolling`;
  // a parte sincrona corre JA (o `bot` existe), pelo que a publicacao e o handle
  // de paragem saem na MESMA tickada, sem esperar o outcome. O `await` da linha
  // final e o EIXO do ciclo de vida:
  //   - normal: o polling corre; `adapter.start` resolve quando o polling parar
  //     (`parar` da emergencia) e o processo devolve OK;
  //   - 409/401: `adapter.start` REJEITA (o bug de Onda 3 corrigido) e o processo
  //     sai com 11/12 — o e2e 409/401 depende disto.
  const arrancouDoPeer = adapter.start((event) => nucleo!.tratarEvento(event))

  // 9. publica a lista canonica (TG-080: falha logada, NAO derruba o boot).
  // O adaptador telegram ja tem `bot` nesta tickada (o `start` acima correu a
  // parte sincrona); se OUTRO provedor ainda nao o tiver, o publish loga e segue.
  void adapter
    .publishCommands(COMANDOS_PUBLICADOS)
    .catch((error: unknown) => {
      log.error('setMyCommands falhou; a lista nao ficou publicada (TG-080, nao derruba o boot)', {
        detail: describeForLog(error, segredosDe()),
      })
    })

  // Boot "up": o caller (teste) pode pegar no handle de paragem desde ja.
  runtime.onBooted?.({ parar })

  try {
    await arrancouDoPeer
  } catch (error) {
    // O erro terminal de `adapter.start` traz o `code` do CONTRATO COMUM
    // (numerico, 10..14) — o `runPolling`/`gateway` do adaptador ja o
    // classificou e ja registou o fatal; o boot so repete em `debug`. Os
    // 409/401 do telegram chegam aqui como `ProviderError` 11/12 (o e2e
    // depende disto) e o BOOT_TIMEOUT como 14. Sem `instanceof` de classe de
    // provedor: QUALQUER erro com `code` do contrato classifica-se por si.
    const code = codeDoContrato(error)
    if (code !== undefined) {
      // O adaptador ja registou o fatal a nivel error; aqui so se repete em
      // debug, com a causa legivel (o `reason` do ProviderError) para o log
      // continuar a distinguir vereditos sem ler codigos.
      log.debug('arranque terminou com veredito terminal', {
        code,
        exit_code: code,
        detail: describeForLog(error, segredosDe()),
      })
      await parar()
      return code
    }
    // Sem `code` do contrato: POLLING_FAILED (13), o default — o adaptador ja
    // registou a causa; o boot regista em `debug` para nao duplicar.
    log.debug('arranque terminou sem veredito do contrato; o polling falhou', {
      detail: describeForLog(error, segredosDe()),
    })
    await parar()
    return WORKER_EXIT.POLLING
  }

  // O polling parou limpo (via `parar`/emergencia). Em producao NORMAL isto
  // nunca resolve: o dead-man's switch do canal termina o processo primeiro.
  return WORKER_EXIT.OK
}

/**
 * Nivel de log do processo. CONSTANTE, e nao lido do ambiente.
 *
 * O valor e `debug` e nao `info` para que nada aqui seja codigo morto: os unicos
 * sitios que registam a este nivel sao eventos RAROS. MUDE SO PARA `'info'` se
 * acrescentar `log.debug` a um caminho por-update — senao um chat activo
 * enche o log do DSH (o `WORKER_ENV_ALLOWLIST` do host nao deixa a variavel
 * passar, pelo que ler do ambiente era um botao desligado do fio).
 */
export const WORKER_LOG_LEVEL: WorkerLogLevel = 'debug'

/**
 * Tempo de graca antes de forcar a saida.
 *
 * O timer e `unref()`ado: se o event loop esvaziar sozinho, o processo sai ANTES
 * disto com o `exitCode` ja definido e este timer nunca dispara. Ele so ganha
 * vida se sobrar algum handle agarrado — e ai o host precisa mesmo de ver o
 * `close`, porque e nele que baseia o `DEGRADED`.
 */
export const EXIT_GRACE_MS = 2000

/**
 * Entrada real. Separada para que importar este modulo num teste nao arranque nada.
 */
export async function main(): Promise<void> {
  const code = await runTelegramWorker()
  process.exitCode = code
  if (code !== WORKER_EXIT.OK) {
    const timer = setTimeout(() => {
      process.exit(code)
    }, EXIT_GRACE_MS)
    timer.unref()
  }
}

/**
 * So corre quando este ficheiro E o processo — nunca quando e importado.
 */
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}