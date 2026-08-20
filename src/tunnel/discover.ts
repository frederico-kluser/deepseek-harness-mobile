/**
 * =============================================================================
 * DESCOBERTA DA URL DO QUICK TUNNEL — `GET /quicktunnel` + regex sobre STDERR.
 * =============================================================================
 *
 * DONO: T3.2. Implementa `TunnelDiscovery` de `src/contracts/tunnel.ts`
 * (CONGELADO no COMMIT PREP 3 — leitura livre, escrita proibida).
 *
 * PORQUE DOIS CAMINHOS, E PORQUE NENHUM DELES E DECORATIVO
 * -----------------------------------------------------------------------------
 * Os dois foram MEDIDOS contra `cloudflared 2026.7.3`, e cada facto medido aqui
 * e o que impede a proxima pessoa de "simplificar" e reintroduzir o defeito:
 *
 *   1. A URL sai 100 % em STDERR. Em duas execucoes medidas o `stdout` ficou
 *      com EXATAMENTE 0 bytes. Quem capturar so `stdout` nunca ve a URL. E por
 *      isso que `TunnelDiscoveryInput` so tem `stderr` — e por isso que este
 *      ficheiro nao contem a palavra `stdout` fora de comentario.
 *   2. `--output json` NAO ajuda: a URL continua embutida numa caixa ASCII
 *      dentro do campo `message`. Nao ha caminho estruturado nos logs.
 *   3. O endpoint `/quicktunnel` NAO esta documentado na pagina oficial de
 *      metricas, que so menciona `/metrics`. Ele e fiavel mas NAO e contratual:
 *      pode desaparecer numa versao qualquer sem aviso e sem nota de release.
 *      Logo o fallback por regex e OBRIGATORIO, e nao um cinto a mais.
 *   4. Entre lancar o processo e a URL aparecer mediram-se 6-7 SEGUNDOS. Daqui
 *      sai o piso de 30 s do timeout: nao e folga generosa, e margem para
 *      maquina lenta e rede de saida congestionada.
 *   5. Num dos runs medidos o STDERR chegou ANTES do endpoint (7826 ms contra
 *      8031 ms). Por isso o ciclo consulta os DOIS em cada volta em vez de
 *      esgotar um antes de tentar o outro.
 *
 * PORQUE A PORTA DE METRICAS ENTRA POR PARAMETRO E NUNCA E ADIVINHADA
 * -----------------------------------------------------------------------------
 * A documentacao afirma a faixa 20241-20245; o binario 2026.7.3 afirma
 * `localhost:0`, ou seja porta ALEATORIA. Duas fontes, duas afirmacoes
 * incompativeis — e a porta e ainda DISPUTADA entre instancias. Adivinhar a
 * faixa e o defeito TUN-011. Aqui a porta chega em
 * `TunnelDiscoveryInput.metricsPort`, ja fixada por quem faz o `spawn` (T3.1)
 * com `--metrics 127.0.0.1:<porta>`, e um valor que nao seja porta valida e
 * RECUSADO em vez de ser corrigido por defeito silencioso.
 *
 * O QUE ESTE MODULO NAO FAZ, DE PROPOSITO
 * -----------------------------------------------------------------------------
 *   - NAO faz `spawn`, NAO mata processo, NAO conhece `ChildProcess`. Recebe o
 *     `stderr` ja aberto e um `AbortSignal` ja ligado ao `'close'`/`'error'`.
 *   - NAO ESCREVE EM DISCO (TUN-015). A URL de um quick tunnel muda a cada
 *     arranque: um valor velho lido do disco entrega um link MORTO com toda a
 *     confianca. O que se persiste e `pid` + `startedAt` (T2.5), nunca a URL.
 *     Este ficheiro nao importa `node:fs` nem `../state/**` — e ha um teste que
 *     o assere lendo o proprio fonte, porque a regra so vale se for verificavel.
 *   - NAO valida seguranca. "A aplicacao responde" nao e "a aplicacao responde
 *     401 a quem nao tem credencial". Ver o cabecalho de `readiness.ts`.
 *
 * Strip-only mode (`node --test` corre estes `.ts` sem os compilar): sem `enum`,
 * sem `namespace`, sem parameter properties. Import relativo leva `.ts`.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as timersSleep } from 'node:timers/promises'

import type { Readable } from 'node:stream'
import type {
  TunnelDiscovery,
  TunnelDiscoveryInput,
  TunnelDiscoveryResult,
  TunnelFailure,
  TunnelFailureCode,
} from '../contracts/tunnel.ts'

/* ========================================================================== */
/* Erros                                                                      */
/* ========================================================================== */

/**
 * Erro tipado com codigo estavel (`05-QUALIDADE-CODIGO.md` 6.1), no mesmo molde
 * de `GuardError` (`src/errors.ts`) e `StateError` (`src/state/schema.ts`): a
 * mensagem e para o humano e pode ser reescrita; o `code` e para o programa e so
 * muda por quebra deliberada.
 *
 * `implements TunnelFailure` NAO e enfeite: o contrato manda `discover()`
 * rejeitar com um `TunnelFailure`, e um objecto cru lancado com `throw` perderia
 * o `stack` e falharia qualquer `instanceof Error` a jusante. Sendo as duas
 * coisas ao mesmo tempo, o supervisor pode po-lo directamente em
 * `TunnelSnapshot.failure` e o log continua a ver um `Error` de verdade.
 *
 * DIVERGENCIA DELIBERADA FACE A `GuardError`/`StateError`: aqui a `message` NAO
 * leva o prefixo `[<plugin>] <CODIGO>:`. Aquelas duas sobem para o log do DSH no
 * meio do de outros plugins, onde um erro sem dono e um erro que ninguem
 * investiga. Esta atravessa a invariante de apresentacao do contrato — e
 * MOSTRADA ao dono no painel e no Telegram — e ali o prefixo e ruido para quem
 * ja sabe de que bot veio a notificacao. Quem precisa de identificar a origem
 * por programa tem o `code`, que e exactamente para isso.
 *
 * `probe` fica por declarar: e opcional no contrato e so e preenchido em
 * `PROBE_FAILED`, que e do probe fail-closed de T3.1 e nunca sai daqui.
 */
export class TunnelError extends Error implements TunnelFailure {
  override readonly name = 'TunnelError'
  readonly code: TunnelFailureCode
  readonly retryable: boolean

  // Campos atribuidos a mao, e nao "parameter properties": `node --test` corre
  // os `.ts` em strip-only mode, que recusa essa sintaxe porque ela EMITE
  // codigo em vez de so apagar tipos.
  constructor(code: TunnelFailureCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Recusa no limiar de entrada. NAO e retryable de proposito: um `metricsPort`
 * adivinhado ou um `timeoutMs` mais curto do que a propria medicao continuaria
 * errado na tentativa seguinte, e gastar orcamento de reinicio com isso apenas
 * atrasa o momento em que alguem le a mensagem.
 */
function invalidInput(detail: string): TunnelError {
  return new TunnelError('INVALID_CONFIG', detail, false)
}

/* ========================================================================== */
/* Constantes medidas                                                         */
/* ========================================================================== */

/**
 * Piso do `timeoutMs`. A medicao deu 6-7 s; 30 s e o piso que o contrato exige e
 * o que este modulo faz cumprir. Um valor mais curto e RECUSADO, nunca elevado
 * em silencio: um timeout que o codigo corrige por dentro diz ao operador que
 * ele configurou uma coisa e executa outra.
 */
export const MIN_DISCOVERY_TIMEOUT_MS = 30_000

/**
 * A URL como ela sai no `stderr`, ja com esquema.
 *
 * Sem `g`: `RegExp` global guarda `lastIndex` entre chamadas, e um padrao ao
 * nivel do modulo com estado seria estado global de modulo — a coisa que
 * `05-QUALIDADE-CODIGO.md` proibe. Sem `g`, `exec` devolve sempre a
 * PRIMEIRA ocorrencia (TUN-008), que e a que interessa: a caixa ASCII repete a
 * mesma URL e um `stderr` com duas URLs so pode ter a boa em primeiro lugar.
 */
export const STDERR_URL_PATTERN = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/u

/**
 * O que o `/quicktunnel` tem direito a devolver em `hostname`.
 *
 * ANCORADO NOS DOIS EXTREMOS, e e isso que faz o trabalho. O endpoint e input
 * NAO CONFIAVEL: e um processo externo, nao documentado, a falar por um socket.
 * Um `hostname` que ja venha com esquema NAO casa com este padrao e por isso e
 * RECUSADO — nunca prefixado — o que torna `https://https://...` inconstruivel
 * em vez de meramente improvavel (TUN-002).
 */
export const QUICKTUNNEL_HOSTNAME_PATTERN = /^[-a-z0-9]+\.trycloudflare\.com$/u

/**
 * Tecto do acumulador de `stderr`.
 *
 * O `cloudflared` escreve log enquanto viver; sem tecto, um arranque que demore
 * faz o buffer crescer sem limite. Corta-se pela CABECA, guardando a CAUDA: uma
 * URL partida entre dois chunks (TUN-006) fica no fim do buffer e sobrevive ao
 * corte. E o buffer e sempre varrido ANTES de ser cortado.
 */
const MAX_STDERR_BUFFER_CHARS = 64 * 1024

/** Corpo maximo lido do `/quicktunnel`. A resposta real tem dezenas de bytes. */
const MAX_QUICKTUNNEL_BODY_BYTES = 8 * 1024

/* ========================================================================== */
/* Costura de HTTP — partilhada com `readiness.ts`                            */
/* ========================================================================== */

/**
 * Resultado de UMA tentativa HTTP.
 *
 * `'unreachable'` NAO e excepcao engolida: durante o warmup medido de 6-7 s o
 * servidor de metricas AINDA NAO EXISTE, e um `ECONNREFUSED` ali e a condicao
 * esperada, nao um erro. A distincao fica no tipo em vez de ficar num `catch`
 * mudo, e o `reason` sobe ate a mensagem final para que o operador saiba se
 * ninguem atendeu ou se atenderam mal.
 */
export type HttpProbe =
  | { readonly kind: 'response'; readonly status: number; readonly body: string }
  | { readonly kind: 'unreachable'; readonly reason: string }

export interface HttpProbeOptions {
  readonly target: URL
  readonly signal: AbortSignal
  readonly timeoutMs: number
  /** `0` descarta o corpo assim que os cabecalhos chegam. */
  readonly maxBodyBytes: number
}

/**
 * Um GET, sem credencial nenhuma, com tecto de tempo e de corpo.
 *
 * >>> `auth: null` E O SEGUNDO FECHO, E NAO E ENFEITE. <<<
 * `http.request(url, ...)` chama `urlToHttpOptions(url)`, que copia
 * `url.username`/`url.password` para `options.auth`, e o `ClientRequest`
 * transforma isso num cabecalho `Authorization: Basic ...` sem avisar ninguem.
 * Um endereco com `dono:senha@` chega aqui e pulveriza o segredo na borda a
 * cada volta do ciclo — ate 1200 voltas por sessao de readiness. O primeiro
 * fecho e recusar o endereco em `parseUsableUrl` (`readiness.ts`); este e o
 * segundo, para o dia em que aparecer um chamador que nao passe por la.
 *
 * DUAS defesas contra socket pendurado, e sao DUAS porque cada uma cobre um
 * caminho diferente. A matriz foi MEDIDA (servidor local, tres pedidos,
 * `getConnections()` 60 ms depois):
 *
 *   agent:false + connection:close   corpo consumido -> 0   corpo por ler -> 0
 *   so agent:false                   corpo consumido -> 0   corpo por ler -> 0
 *   so connection:close              corpo consumido -> 0   corpo por ler -> 0
 *   nenhum dos dois                  corpo consumido -> 1   corpo por ler -> 1
 *
 * Ou seja: as tres eram MUTUAMENTE REDUNDANTES, e por isso nenhum teste
 * conseguia distinguir a remocao de UMA delas — foi o que a revisao
 * adversarial mostrou, com o teste anterior a sobreviver a remocao das tres.
 * `connection: close` FOI RETIRADO: era a unica que dependia de o servidor
 * cooperar, e mante-la so servia para tornar as outras duas infalsificaveis.
 *
 * Ficaram as duas que cobrem caminhos distintos, e agora cada uma tem o seu
 * teste que a mata:
 *   - `agent: false` — sem pool. O `globalAgent` do Node ja vem com `keepAlive`
 *     ligado; sem isto, cada arranque de tunel deixava uma ligacao a borda
 *     viva. Cobre o caminho em que o corpo E consumido (`/quicktunnel`).
 *   - `res.destroy()` no caminho `maxBodyBytes === 0` — sem ele, uma resposta
 *     com corpo que ninguem le prende o socket. Cobre o readiness, que so quer
 *     o codigo de estado e nunca le a pagina de erro que a borda devolve.
 *
 * O `reason` de falha usa SO o `code` do erro (`ECONNREFUSED`, `ETIMEDOUT`, ...)
 * e nunca a `message`: mensagens de erro de rede do Node embutem caminho de
 * socket e nome de host, e este texto pode acabar numa notificacao de Telegram.
 */
export function probeHttp(options: HttpProbeOptions): Promise<HttpProbe> {
  const { target, signal, timeoutMs, maxBodyBytes } = options

  return new Promise<HttpProbe>((resolve) => {
    let settled = false
    let timedOut = false
    const settle = (probe: HttpProbe): void => {
      if (settled) return
      settled = true
      resolve(probe)
    }

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      target,
      {
        method: 'GET',
        signal,
        agent: false,
        // Ver a nota acima: sem isto, `username:password` do `URL` vira
        // `Authorization: Basic` em silencio.
        auth: null,
        headers: { accept: '*/*' },
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (maxBodyBytes === 0) {
          // Ver a nota do cabecalho: sem este `destroy`, uma resposta com corpo
          // que ninguem le prende o socket ate ao timeout do servidor — e o
          // readiness sonda em ciclo.
          res.destroy()
          settle({ kind: 'response', status, body: '' })
          return
        }
        res.setEncoding('utf8')
        let body = ''
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.length >= maxBodyBytes) {
            body = body.slice(0, maxBodyBytes)
            res.destroy()
            settle({ kind: 'response', status, body })
          }
        })
        res.on('end', () => {
          settle({ kind: 'response', status, body })
        })
        // GUARDA, e nao caminho de comportamento — e a distincao esta aqui
        // escrita porque foi MEDIDA. Um `'error'` sem ouvinte num `Readable`
        // e LANCADO, e este codigo corre dentro do processo do DSH: derrubava
        // o host inteiro por causa de um socket. O ouvinte tem de existir.
        //
        // O que ele NAO e: a forma de tratar um corpo interrompido. Medido —
        // servidor que anuncia 10 000 bytes, escreve 10 e destroi o socket — o
        // Node reporta o corte no PEDIDO (`ECONNRESET`), nao na resposta, e o
        // resultado observavel e `unreachable`. Ha um teste que fixa isso. Nao
        // se conhece entrada que faca este ramo disparar; se ele disparar, o
        // codigo de estado ja chegou e devolve-se o que se aprendeu.
        res.on('error', () => {
          settle({ kind: 'response', status, body })
        })
      },
    )

    req.setTimeout(timeoutMs, () => {
      timedOut = true
      req.destroy()
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      settle({ kind: 'unreachable', reason: timedOut ? 'ETIMEDOUT' : (error.code ?? 'ERR_REDE') })
    })
    // `req.destroy()` sem argumento fecha SEM emitir `'error'`. Sem este
    // `'close'` a promessa ficava pendurada para sempre no caso do timeout.
    req.on('close', () => {
      settle({ kind: 'unreachable', reason: timedOut ? 'ETIMEDOUT' : 'ECLOSED' })
    })
    req.end()
  })
}

/** O alvo do caminho primario. Sempre `127.0.0.1`, nunca `localhost`. */
export function quickTunnelUrl(metricsPort: number): URL {
  // `127.0.0.1` literal e nao `localhost`: `localhost` resolve para `::1`
  // primeiro em muitas maquinas, e o servidor de metricas escuta no IPv4 que
  // lhe foi dado em `--metrics 127.0.0.1:<porta>`.
  return new URL(`http://127.0.0.1:${String(metricsPort)}/quicktunnel`)
}

/* ========================================================================== */
/* Acumulador de `stderr`                                                     */
/* ========================================================================== */

/** Leitor de `stderr` com disposer SINCRONO (Q-2). */
export interface StderrScanner {
  /** A primeira URL vista ate agora, ou `null`. */
  url(): string | null
  /** Motivo de o fluxo ter falhado, se falhou. Diagnostico, nunca engolido. */
  failure(): string | null
  /** Remove o listener. Sincrono, idempotente. */
  dispose(): void
}

/**
 * Acumula `stderr` e devolve a PRIMEIRA URL que passar pelo padrao.
 *
 * PORQUE ACUMULA EM VEZ DE CASAR CHUNK A CHUNK: o `stderr` de um processo chega
 * em pedacos arbitrarios, definidos pelo buffer do pipe e nao pelas linhas. A
 * URL parte-se ao meio com toda a naturalidade (TUN-006) e um parser que testa
 * cada chunk isolado perde-a sem deixar rasto.
 *
 * SOBRE O `StringDecoder`, e com honestidade: ele NAO e o que faz TUN-006
 * passar. A URL e 100 % ASCII, e `Buffer.toString('utf8')` sobre um pedaco
 * cortado a meio de um caractere multi-byte so troca ESSE caractere por
 * U+FFFD — a URL continuava a casar. Quem faz TUN-006 passar e o acumulador,
 * duas linhas acima. O decodificador esta ca para o TEXTO A VOLTA da URL (a
 * caixa que o `cloudflared` real desenha com `─` e `│`) nao ficar corrompido no
 * dia em que alguem quiser ler daqui mais do que a URL. Nao ha teste que o
 * distinga, e ele foi tentado: o mutante e equivalente. Fica declarado como
 * higiene, nao como garantia medida.
 */
export function createStderrScanner(stream: Readable | null): StderrScanner {
  let buffer = ''
  let found: string | null = null
  let failed: string | null = null
  let disposed = false
  const decoder = new StringDecoder('utf8')

  const onData = (chunk: unknown): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer)
    if (found === null) {
      const match = STDERR_URL_PATTERN.exec(buffer)
      if (match !== null) found = match[0]
    }
    if (buffer.length > MAX_STDERR_BUFFER_CHARS) {
      buffer = buffer.slice(buffer.length - MAX_STDERR_BUFFER_CHARS)
    }
  }
  const onError = (error: NodeJS.ErrnoException): void => {
    // Nao se engole: o motivo sobe ate a mensagem de timeout, porque um
    // `stderr` que rebentou explica um fallback que nunca disparou.
    failed = error.code ?? 'ERR_STDERR'
  }

  stream?.on('data', onData)
  stream?.on('error', onError)

  return {
    url: (): string | null => found,
    failure: (): string | null => failed,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      stream?.off('data', onData)
      stream?.off('error', onError)
      // NAO se chama `resume()` aqui de proposito. Quem e dono do processo
      // (T3.1) e que decide se continua a drenar e a registar o `stderr`;
      // consumi-lo em silencio a partir daqui apagava o log do arranque.
    },
  }
}

/* ========================================================================== */
/* Dependencias injetaveis                                                    */
/* ========================================================================== */

/**
 * O tempo e a rede entram por parametro. Sem isto, provar TUN-009 custava 30
 * segundos de relogio de parede por execucao e provar TUN-004 exigia derrubar
 * um servidor a meio do teste.
 */
export interface DiscoveryDeps {
  readonly now: () => number
  /** Tem de REJEITAR quando `signal` aborta — e o que torna TUN-010 imediato. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly probeQuickTunnel: (
    metricsPort: number,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<HttpProbe>
  readonly pollIntervalMs: number
  readonly attemptTimeoutMs: number
}

export const defaultDiscoveryDeps: DiscoveryDeps = {
  now: Date.now,
  sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
    await timersSleep(ms, undefined, { signal })
  },
  probeQuickTunnel: (metricsPort: number, signal: AbortSignal, timeoutMs: number): Promise<HttpProbe> =>
    probeHttp({
      target: quickTunnelUrl(metricsPort),
      signal,
      timeoutMs,
      maxBodyBytes: MAX_QUICKTUNNEL_BODY_BYTES,
    }),
  // 250 ms: com 6-7 s de espera medida sao ~28 sondagens ate ao caso feliz.
  // Mais curto martela um servidor que ainda nem existe; mais longo desperdica
  // ate um quarto de segundo depois de a URL ja estar publicada.
  pollIntervalMs: 250,
  attemptTimeoutMs: 2000,
}

/* ========================================================================== */
/* Leitura do `/quicktunnel`                                                  */
/* ========================================================================== */

/**
 * O que uma sondagem ao endpoint produziu, ja classificado.
 *
 * Exportado porque `readQuickTunnelBody` o devolve e a emissao de `.d.ts`
 * precisa de o conseguir nomear — e porque a validacao de fronteira e
 * exactamente o que a revisao adversarial quer poder exercitar isolada.
 */
export type MetricsReading =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'rejected'; readonly reason: string }

/**
 * Valida na fronteira e confia no interior.
 *
 * O corpo vem de um processo externo por um endpoint NAO DOCUMENTADO. Aqui ele e
 * tratado como texto hostil: tem de ser JSON, tem de ser objecto, `hostname` tem
 * de ser string e tem de casar com {@link QUICKTUNNEL_HOSTNAME_PATTERN} INTEIRO.
 * O que nao casar e recusado — nunca prefixado e devolvido.
 */
export function readQuickTunnelBody(body: string): MetricsReading {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { kind: 'rejected', reason: 'corpo nao e JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'rejected', reason: 'corpo nao e um objecto JSON' }
  }
  const hostname = (parsed as Record<string, unknown>)['hostname']
  if (typeof hostname !== 'string' || hostname === '') {
    return { kind: 'rejected', reason: 'sem campo `hostname`' }
  }
  if (!QUICKTUNNEL_HOSTNAME_PATTERN.test(hostname)) {
    // Inclui o caso de o hostname ja vir com esquema. Recusar e o que torna
    // `https://https://` impossivel de construir (TUN-002).
    return { kind: 'rejected', reason: 'hostname fora da forma de quick tunnel' }
  }
  // O endpoint devolve o hostname SEM esquema. Prefixar e obrigacao de quem
  // implementa o contrato — `TunnelInfo.url` promete comecar por `https://`.
  return { kind: 'url', url: `https://${hostname}` }
}

/* ========================================================================== */
/* Descoberta                                                                 */
/* ========================================================================== */

function assertUsableInput(input: TunnelDiscoveryInput): void {
  const { metricsPort, timeoutMs } = input

  if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65_535) {
    throw invalidInput(
      'A porta do servidor de metricas do cloudflared nao foi fixada. ' +
        'Ela tem de ser escolhida por quem faz o arranque e passada tanto em ' +
        '`--metrics 127.0.0.1:<porta>` como aqui: no 2026.7.3 o valor por ' +
        'omissao e uma porta ALEATORIA, e a faixa 20241-20245 que a ' +
        'documentacao promete e disputada por qualquer outro tunel na mesma ' +
        'maquina. Adivinhar a porta entrega a URL do tunel errado.',
    )
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_DISCOVERY_TIMEOUT_MS) {
    throw invalidInput(
      `O prazo de descoberta tem de ser um numero finito de pelo menos ${String(MIN_DISCOVERY_TIMEOUT_MS)} ms. ` +
        'Medido em campo, a URL do quick tunnel leva 6 a 7 segundos a aparecer; ' +
        'um prazo mais curto declara falha antes de o tunel ter tido hipotese, ' +
        'e um prazo infinito deixa o arranque preso para sempre sem ninguem ' +
        'saber. Corrija o valor em vez de esperar que ele seja corrigido por si.',
    )
  }
}

function timeoutFailure(
  timeoutMs: number,
  attempts: number,
  lastMetricsReason: string,
  stderrFailure: string | null,
): TunnelError {
  const stderrNote =
    stderrFailure === null
      ? ''
      : ` O fluxo de saida do processo falhou (${stderrFailure}), pelo que a leitura por log tambem nao pode acontecer.`
  return new TunnelError(
    'READINESS_TIMEOUT',
    `O tunel arrancou mas nao publicou nenhuma URL em ${String(Math.round(timeoutMs / 1000))} s. ` +
      `Foram feitas ${String(attempts)} consultas ao servidor de metricas (ultimo resultado: ${lastMetricsReason}) ` +
      'e o log do processo nunca trouxe o endereco.' +
      stderrNote +
      ' Nas medicoes esta etapa demora 6 a 7 segundos; demorar mais costuma ser ' +
      'saida HTTPS para a Cloudflare bloqueada, ou o servidor de metricas a ' +
      'escutar noutra porta. Confirme a ligacao a internet da maquina e volte a ' +
      'ligar o acesso remoto; se falhar sempre, desligue o acesso remoto e use ' +
      'a interface local enquanto investiga.',
    true,
  )
}

function processExitedFailure(cause?: unknown): TunnelError {
  return new TunnelError(
    'PROCESS_EXITED',
    'O processo do tunel terminou durante o arranque, antes de publicar qualquer ' +
      'endereco. A espera foi interrompida de imediato em vez de consumir o prazo ' +
      'inteiro. Va ver o registo de arranque do plugin: a causa costuma ser ' +
      'binario em falta, binario sem permissao de execucao, ou saida de rede ' +
      'bloqueada. O acesso remoto vai ser tentado de novo.',
    true,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Constroi a implementacao de {@link TunnelDiscovery}.
 *
 * FABRICA e nao singleton: `05-QUALIDADE-CODIGO.md` proibe estado global de
 * modulo, e as dependencias fechadas nesta closure sao por INSTANCIA. Dois
 * tuneis em paralelo — ou dois testes no mesmo ficheiro — nao partilham nada.
 */
export function createTunnelDiscovery(deps: DiscoveryDeps = defaultDiscoveryDeps): TunnelDiscovery {
  async function discover(input: TunnelDiscoveryInput): Promise<TunnelDiscoveryResult> {
    assertUsableInput(input)

    const { metricsPort, signal, timeoutMs } = input
    // O leitor de `stderr` liga-se ANTES da primeira sondagem. Se so ligasse
    // depois, a janela entre o `spawn` e a primeira volta do ciclo era tempo em
    // que o banner podia passar sem ninguem a ler.
    const scanner = createStderrScanner(input.stderr)
    const deadline = deps.now() + timeoutMs

    let attempts = 0
    let lastMetricsReason = 'nunca chegou a ser consultado'

    // `signal.aborted` e mutado de FORA — por quem e dono do processo, no
    // `'close'`/`'error'` dele. O compilador nao sabe disso: depois da primeira
    // leitura ele estreita a propriedade para `false` e NAO volta a alargar nem
    // sequer depois de um `await`. A segunda leitura passava a parecer codigo
    // morto ao `no-unnecessary-condition`, sendo ela precisamente a que apanha
    // o processo a morrer NO MEIO da sondagem. Ler por chamada de funcao e o
    // que faz o compilador e o leitor concordarem — e um aviso de lint que se
    // aprende a ignorar e um aviso que deixou de proteger.
    const aborted = (): boolean => signal.aborted

    try {
      for (;;) {
        if (aborted()) throw processExitedFailure()

        attempts += 1
        const probe = await deps.probeQuickTunnel(metricsPort, signal, deps.attemptTimeoutMs)

        // Reavaliado AQUI, e nao so no topo: a sondagem e assincrona e o
        // processo pode ter morrido durante ela. Sem esta verificacao, um
        // `stderr` com lixo residual podia devolver uma URL de um tunel que ja
        // nao existe.
        if (aborted()) throw processExitedFailure()

        if (probe.kind === 'response') {
          if (probe.status === 200) {
            const reading = readQuickTunnelBody(probe.body)
            // O caminho PREFERIDO ganha dentro de cada volta: quando os dois
            // tem resposta, vale o endpoint, que e dado estruturado, e nao o
            // log, que e texto para humanos.
            if (reading.kind === 'url') return { url: reading.url, via: 'metrics' }
            lastMetricsReason = `resposta 200 recusada (${reading.reason})`
          } else {
            lastMetricsReason = `HTTP ${String(probe.status)}`
          }
        } else {
          lastMetricsReason = probe.reason
        }

        const fromStderr = scanner.url()
        if (fromStderr !== null) return { url: fromStderr, via: 'stderr' }

        if (deps.now() >= deadline) {
          throw timeoutFailure(timeoutMs, attempts, lastMetricsReason, scanner.failure())
        }

        try {
          await deps.sleep(deps.pollIntervalMs, signal)
        } catch (error) {
          // Abortar durante a espera e o caso NORMAL de TUN-010, e nao um
          // defeito. Qualquer outra falha sobe intacta: engolir uma excepcao
          // aqui transformava um erro de programacao num timeout de 30 s.
          if (aborted()) throw processExitedFailure(error)
          throw error
        }
      }
    } finally {
      scanner.dispose()
    }
  }

  return { discover }
}
