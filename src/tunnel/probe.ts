/**
 * =============================================================================
 * PROBE FAIL-CLOSED — pre-condicao de `STOPPED -> STARTING` (D11 / 02 L1).
 * =============================================================================
 *
 * ISTO CORRE ANTES DO `spawn`. Nao e detalhe de ordem: se corresse depois, a
 * janela de exposicao ja teria aberto e o controlo seria um relatorio, nao um
 * portao. O supervisor (`./supervisor.ts`) chama `runGateProbe` e SO chama
 * `start()` do processo se o resultado passar; com o gate desarmado nao existe
 * `spawn` nenhum (TUN-020..TUN-023).
 *
 * -----------------------------------------------------------------------------
 * PORQUE QUATRO SONDAS E NAO UMA
 * -----------------------------------------------------------------------------
 * O modo de falha real e ORDEM DE CARREGAMENTO, e nao "o gate nao foi instalado".
 * Medido em `docs/spikes/superficie-ui.md` sobre a composicao real de 196
 * pacotes: `/` vem do `registerFallback` de `@deepseek-ai/dsh-host-frontend-static`
 * e `/api` e um PREFIXO nomeado de `@deepseek-ai/dsh-client-connection` — outro
 * pacote, outro momento de registo, outra tabela de rotas. O roteador consulta as
 * tabelas nomeadas ANTES do fallback. E portanto perfeitamente possivel — e e o
 * caso mais provavel — que o fallback caia DEPOIS do nosso `apply()` e o `/api`
 * ANTES: o probe de `/` passa, o tunel sobe, e `POST /api/...` fica publico.
 *
 * Provar `/` NAO prova `/api`. Foi exatamente essa diferenca que expos o DSH real
 * do utilizador, publicamente e sem autenticacao, durante ~40 segundos.
 *
 * -----------------------------------------------------------------------------
 * FAIL-CLOSED ATE NO PROPRIO ERRO
 * -----------------------------------------------------------------------------
 * Excepcao, timeout ou erro de rede DENTRO do probe conta como FALHA (TUN-025).
 * Nunca "nao consegui medir, entao deixa subir". `runGateProbe` nao lanca: devolve
 * sempre um veredito, e o veredito de um erro e `passed: false`.
 *
 * As sondas sao ANONIMAS — nenhuma leva credencial. Uma sonda autenticada mediria
 * "a aplicacao responde a quem tem credencial", que e a pergunta errada.
 */

import { request as httpRequest } from 'node:http'

import type { AuditSink } from '../contracts/auth.ts'
import type { ProbeId, ProbeOutcome, TunnelFailure } from '../contracts/tunnel.ts'

/** Codigo que TODA sonda anonima tem de receber de um gate armado. */
export const EXPECTED_STATUS = 401

/**
 * RPC de LEITURA usada pela sonda 2. Tem de ser de leitura: se o gate estiver
 * desarmado, o pedido CHEGA a aplicacao, e uma sonda que escreve deixaria efeito
 * colateral exatamente no cenario em que ja ha um problema de seguranca.
 *
 * O caminho so precisa de estar sob o prefixo `/api` — o gate decide ANTES do
 * encaminhamento, portanto o que se mede e o prefixo, nao a existencia do metodo.
 * Um `404` aqui e tao reprovado quanto um `200`: os dois significam que o pedido
 * passou do gate para o roteador.
 */
export const DEFAULT_API_READ_PATH = '/api/state'

/** Prefixo do canario. Fora de `guardedPrefixes` de proposito (D11, sonda 4). */
export const CANARY_PATH_PREFIX = '/__guard/probe-canary-'

/** O que uma sonda observou na camada de transporte. */
export type ProbeTransportResult =
  | { readonly kind: 'response'; readonly status: number }
  /** O servidor destruiu o socket sem completar uma resposta HTTP. */
  | { readonly kind: 'destroyed' }
  /** Nao houve medicao: rede, timeout ou excepcao. FALHA, sempre. */
  | { readonly kind: 'error'; readonly reason: string }

/** Um pedido de sonda, ja resolvido (o canario ja tem o sufixo aleatorio). */
export interface ProbeRequest {
  readonly probe: ProbeId
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Costura de rede do probe. Injetada: nenhum teste unitario abre socket. */
export interface ProbeTransport {
  send(request: ProbeRequest, signal: AbortSignal): Promise<ProbeTransportResult>
}

export interface GateProbeInput {
  readonly transport: ProbeTransport
  /** Sufixo aleatorio do canario. Injetado para o teste ser determinista. */
  readonly canaryToken: string
  /** Aborta as sondas quando o ciclo de vida do supervisor e descartado. */
  readonly signal: AbortSignal
  /** Caminho da RPC de leitura da sonda 2. Ver {@link DEFAULT_API_READ_PATH}. */
  readonly apiReadPath?: string | undefined
}

export interface GateProbeResult {
  readonly passed: boolean
  /** SEMPRE as quatro, na ordem do plano — e o que vai para a auditoria. */
  readonly outcomes: readonly ProbeOutcome[]
  /** Presente sse `passed === false`. NOMEIA a sonda que reprovou. */
  readonly failure?: TunnelFailure | undefined
}

/**
 * As quatro sondas, na ordem canonica de D11.
 *
 * A ordem e estavel porque a auditoria e a mensagem ao dono a citam; trocar a
 * ordem mudaria o significado de um registo ja escrito.
 */
export function buildProbePlan(canaryToken: string, apiReadPath?: string): readonly ProbeRequest[] {
  return [
    // 1 — o assento de fallback da SPA (`registerFallback` do frontend estatico).
    { probe: 'spa-fallback', method: 'GET', path: '/', headers: {}, body: '' },
    // 2 — o prefixo `/api`, que e OUTRO registo. A superficie da vulnerabilidade
    //     que este plugin fecha, e a que um probe so em `/` nao cobre.
    {
      probe: 'api-rpc',
      method: 'POST',
      path: apiReadPath ?? DEFAULT_API_READ_PATH,
      headers: { 'content-type': 'application/json', 'content-length': '0' },
      body: '',
    },
    // 3 — o handshake de `Connection: Upgrade`, que tem tratador PROPRIO no
    //     `node:http.Server` e nao passa pelo caminho de `'request'`.
    {
      probe: 'websocket-upgrade',
      method: 'GET',
      path: '/',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
      body: '',
    },
    // 4 — canario FORA de `guardedPrefixes`, com sufixo aleatorio para que nao
    //     possa colidir com rota nenhuma. Prova que o gate e UNIVERSAL.
    {
      probe: 'unguarded-canary',
      method: 'GET',
      path: `${CANARY_PATH_PREFIX}${canaryToken}`,
      headers: {},
      body: '',
    },
  ]
}

/** Decide se UMA sonda passou. Toda a politica fail-closed esta aqui. */
export function judgeProbe(probe: ProbeId, result: ProbeTransportResult): ProbeOutcome {
  if (result.kind === 'response') {
    return { probe, passed: result.status === EXPECTED_STATUS, status: result.status }
  }

  if (result.kind === 'destroyed') {
    /**
     * Socket destruido sem resposta completa. So a sonda 3 aceita isto: o
     * tratador de `'upgrade'` do gate escreve a recusa CRUA no socket e destroi-o
     * (`src/http/responses.ts`), e um handshake recusado assim e uma recusa tao
     * boa quanto um `401`. Para as outras tres, um socket que morre e uma
     * medicao que nao aconteceu — e uma medicao que nao aconteceu reprova.
     */
    return { probe, passed: probe === 'websocket-upgrade', status: null }
  }

  // `error`: sem medicao. Fail-closed, sem excepcao e sem "na duvida deixa subir".
  return { probe, passed: false, status: null }
}

/**
 * Corre as QUATRO sondas e devolve o veredito.
 *
 * NUNCA LANCA. Uma excepcao que escapasse daqui subiria para o chamador e, num
 * `catch` distraido la em cima, viraria "o probe nao correu, continua". As quatro
 * correm SEMPRE, mesmo depois de a primeira reprovar: a auditoria de TUN-024
 * exige o resultado das quatro, e um relatorio parcial esconde se o gate falhou
 * numa superficie ou em todas.
 */
export async function runGateProbe(input: GateProbeInput): Promise<GateProbeResult> {
  const plan = buildProbePlan(input.canaryToken, input.apiReadPath)
  const outcomes: ProbeOutcome[] = []

  for (const probeRequest of plan) {
    let result: ProbeTransportResult
    try {
      result = await input.transport.send(probeRequest, input.signal)
    } catch (error) {
      // A excepcao NAO e engolida: vira um resultado `error` explicito, com a
      // razao no veredito e, por consequencia, no registo de auditoria.
      result = { kind: 'error', reason: describeReason(error) }
    }
    outcomes.push(judgeProbe(probeRequest.probe, result))
  }

  const failed = outcomes.find((outcome) => !outcome.passed)
  if (failed === undefined) return { passed: true, outcomes }

  return { passed: false, outcomes, failure: describeFailure(failed) }
}

/**
 * Mensagem que NOMEIA a sonda reprovada.
 *
 * INVARIANTE DE APRESENTACAO: viaja para o painel e para o Telegram. Sem segredo,
 * sem caminho absoluto de ficheiro e sem a URL do tunel — a mensagem sai da
 * maquina, e um caminho de ficheiro numa mensagem que sai da maquina divulga o
 * layout do disco do utilizador a um terceiro.
 */
export function describeFailure(outcome: ProbeOutcome): TunnelFailure {
  return {
    code: 'PROBE_FAILED',
    probe: outcome.probe,
    message:
      `o tunel NAO subiu: a sonda \`${outcome.probe}\` ${describeObservation(outcome)}, ` +
      'e nao o 401 que um portao armado devolve a quem nao tem credencial. ' +
      'Abrir o tunel agora publicaria o Harness sem autenticacao. Recarregue o ' +
      'plugin e tente de novo; se persistir, o portao nao esta a cobrir essa superficie.',
    retryable: false,
  }
}

function describeObservation(outcome: ProbeOutcome): string {
  if (outcome.status === null) return 'nao pode ser medida (socket fechado, timeout ou erro de rede)'
  if (outcome.probe === 'unguarded-canary' && outcome.status === 404) {
    // O 404 do canario tem significado PROPRIO e ele e o achado: significa que o
    // pedido chegou ao roteador, ou seja NAO passou pelo gate.
    return 'devolveu 404, o que significa que o pedido chegou ao roteador sem passar pelo portao'
  }
  return `devolveu ${String(outcome.status)}`
}

function describeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ========================================================================== */
/* Registo em auditoria da decisao                                            */
/* ========================================================================== */

/** Nomes de evento. O vocabulario fechado e de T5.4 (`src/audit/events.ts`). */
export const EVENTO_PROBE = 'tunel_probe'
export const EVENTO_PROBE_DECISAO = 'tunel_probe_decisao'

/**
 * Regista o resultado das QUATRO sondas e a decisao final (TUN-024).
 *
 * PORQUE UMA LINHA POR SONDA e nao um resumo: seis meses depois, "o probe
 * reprovou" nao diz onde o portao estava aberto. Uma linha por superficie diz.
 * O nome do evento leva o codigo observado, porque um `404` no canario significa
 * uma coisa muito diferente de um `200` — e essa diferenca e o achado.
 *
 * PODE LANCAR: o sink e fail-closed por desenho (disco cheio recusa escrever), e
 * quem chama TEM de tratar a excepcao como recusa de subida. Um tunel que sobe
 * sem prova de que o portao foi verificado e o estado que isto existe para impedir.
 */
export function auditProbeDecision(audit: AuditSink, result: GateProbeResult): void {
  for (const outcome of result.outcomes) {
    audit.append({
      evento: `${EVENTO_PROBE}:${outcome.probe}:${outcome.status === null ? 'sem-resposta' : String(outcome.status)}`,
      resultado: outcome.passed ? 'permitido' : 'negado',
    })
  }
  audit.append({ evento: EVENTO_PROBE_DECISAO, resultado: result.passed ? 'permitido' : 'negado' })
}

/* ========================================================================== */
/* Transporte HTTP real — loopback, anonimo, com timeout proprio              */
/* ========================================================================== */

export interface HttpProbeTransportOptions {
  /** Sempre `127.0.0.1`: o probe mede a ORIGEM local, nunca a borda. */
  readonly host: string
  readonly port: number
  readonly timeoutMs: number
}

/**
 * Transporte real das sondas.
 *
 * DISTINGUIR "destruido" DE "erro" e a unica subtileza: a sonda 3 aceita um
 * socket destruido e as outras tres nao, portanto confundir os dois casos ou
 * deixava passar um gate desarmado (se `error` contasse como destruido) ou
 * impedia o tunel de subir com o gate armado (o contrario). O discriminador e se
 * a ligacao TCP chegou a estabelecer-se: um `ECONNREFUSED` acontece ANTES disso,
 * um `ECONNRESET` provocado pelo `socket.destroy()` do gate acontece DEPOIS.
 */
export function createHttpProbeTransport(options: HttpProbeTransportOptions): ProbeTransport {
  return {
    send(probeRequest: ProbeRequest, signal: AbortSignal): Promise<ProbeTransportResult> {
      return new Promise<ProbeTransportResult>((resolve) => {
        let settled = false
        let connected = false

        const finish = (result: ProbeTransportResult): void => {
          if (settled) return
          settled = true
          resolve(result)
        }

        const clientRequest = httpRequest({
          host: options.host,
          port: options.port,
          method: probeRequest.method,
          path: probeRequest.path,
          headers: probeRequest.headers,
          // O sinal do ciclo de vida: descartar o plugin durante o probe aborta o
          // pedido em vez de o deixar pendurado ate ao timeout.
          signal,
          timeout: options.timeoutMs,
        })

        clientRequest.on('socket', (socket): void => {
          if (!socket.connecting) connected = true
          socket.once('connect', (): void => {
            connected = true
          })
        })

        clientRequest.on('response', (response): void => {
          // O corpo nao interessa; o que interessa e o codigo. Destruir em vez de
          // consumir evita reter bytes de uma origem que pode estar desarmada.
          response.destroy()
          finish({ kind: 'response', status: response.statusCode ?? 0 })
        })

        // `101 Switching Protocols`: o handshake COMPLETOU. Para a sonda 3 isto e
        // a reprovacao — um WebSocket aberto sem credencial.
        clientRequest.on('upgrade', (response, socket): void => {
          socket.destroy()
          finish({ kind: 'response', status: response.statusCode ?? 101 })
        })

        clientRequest.on('timeout', (): void => {
          clientRequest.destroy()
          finish({ kind: 'error', reason: `sem resposta em ${String(options.timeoutMs)} ms` })
        })

        clientRequest.on('error', (error: NodeJS.ErrnoException): void => {
          const reset = error.code === 'ECONNRESET' || error.code === 'EPIPE'
          if (connected && reset) {
            finish({ kind: 'destroyed' })
            return
          }
          finish({ kind: 'error', reason: `${error.code ?? 'ERRO'}: ${error.message}` })
        })

        // Fim do pedido sem resposta nem erro: a outra forma de o servidor
        // destruir o socket, quando o `FIN` chega antes de qualquer byte.
        clientRequest.on('close', (): void => {
          finish(connected ? { kind: 'destroyed' } : { kind: 'error', reason: 'ligacao fechada sem resposta' })
        })

        clientRequest.end(probeRequest.body)
      })
    },
  }
}
