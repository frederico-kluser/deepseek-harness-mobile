/**
 * Contrato do tunel. CONGELADO no COMMIT PREP 3.
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA ate ao COMMIT PREP 4.
 *
 * PORQUE ESTE FICHEIRO EXISTE. A Onda 3 tem quatro sub-tarefas que so nao
 * colidem porque partilham VOCABULARIO em vez de partilharem FICHEIRO:
 *
 *   T3.1 `w3-tunnel-supervisor`      -> supervisiona o processo, corre o probe,
 *                                        arma o TTL, gere o pidfile e o argv
 *   T3.2 `w3-tunnel-descoberta-url`  -> descobre a URL e mede o readiness
 *   T3.3 `w3-gate-integra-sessao`    -> fia o gate e amplia a `Config`
 *   T3.4 `w3-painel-guard-http`      -> mostra estado e URL no painel
 *
 * A ordem de merge e T3.2 -> T3.4 -> T3.1 -> T3.3 (`03-ONDAS.md` 13.1). Repare
 * que T3.3, dona de `src/config/**`, entra por ULTIMO. Se T3.1 importasse os
 * tipos de configuracao de `src/config/schema.ts`, o snapshot de integracao de
 * T3.1 nao compilaria — o ficheiro que os declara ainda nao teria entrado. Por
 * isso as FORMAS de `tunnel.*` e `exposure.*` sao congeladas AQUI e T3.3
 * limita-se a compo-las na `Config` dela. Isto nao e estilo: e o que torna a
 * ordem de merge de 13.1 executavel.
 */

import type { Readable } from 'node:stream'

// ---------------------------------------------------------------------------
// 1. VOCABULARIO DE ESTADO — seis estados, em ingles
// ---------------------------------------------------------------------------

/**
 * `01-ARQUITETURA.md` 6 e `09-DECISOES-CANONICAS.md` D7. Circulavam DOIS
 * conjuntos de nomes e a divergencia nao era de traducao: um tinha `DEGRADADO`
 * (re-tenta sozinho) e o outro `FAILED` (exige accao humana). Sao semanticas
 * diferentes. Vale este enum, e so este, em codigo, em teste e no payload IPC.
 *
 * - `STOPPED`  — nao ha processo. Estado inicial e final feliz.
 * - `STARTING` — `spawn` feito, URL ainda nao obtida.
 * - `READY`    — URL obtida E readiness respondeu. So aqui a URL e divulgada.
 * - `DEGRADED` — falhou E AINDA HA ORCAMENTO: re-tenta sozinho com backoff.
 * - `STOPPING` — a derrubar: SIGTERM ao grupo, janela de graca, SIGKILL.
 * - `FAILED`   — TERMINAL. Orcamento esgotado ou erro nao-retryable. NUNCA sai
 *                sozinho; so com `reset()` explicito do dono.
 *
 * Os rotulos em portugues ("desligado", "ligando", "online", "instavel,
 * tentando de novo", "desligando", "falhou — precisa de accao sua") existem
 * APENAS como texto de UI em `src/panel/**` e no bot. Nenhum codigo, teste ou
 * mensagem IPC usa o rotulo.
 */
export type TunnelState =
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'DEGRADED'
  | 'STOPPING'
  | 'FAILED'

/**
 * A TABELA DE TRANSICOES NAO ESTA AQUI, DE PROPOSITO. Ela e congelada no
 * COMMIT PREP 5 (`src/contracts/control.ts`), junto com `ControlIntent` e a
 * regra de D29 (`start` durante `STOPPING` e REJEITADO, nunca enfileirado).
 * Duplicar a maquina em dois contratos criaria duas fontes da verdade que
 * divergiriam na primeira correccao. A Onda 3 precisa apenas do VOCABULARIO.
 */

// ---------------------------------------------------------------------------
// 2. MODO E INFORMACAO DO TUNEL
// ---------------------------------------------------------------------------

/**
 * `09-DECISOES-CANONICAS.md` D6. AMBOS existem na v0.1.
 *
 * - `'quick'` — DEFAULT. Unico com onboarding automatizado, unico que o README
 *   promete. Zero estado em disco. URL aleatoria a cada restart, publica e
 *   descoberta em massa. Nao aceita Cloudflare Access a frente (Access exige
 *   `zone_id`). Logo, TODA a autenticacao vive dentro do plugin.
 * - `'named'` — suportado como TRANSPORTE. Token entregue por `--token-file`.
 *   Sem onboarding automatizado: conta, dominio e politica de Access sao do
 *   utilizador, fora do plugin.
 *
 * NAO EXISTE, E NUNCA VAI EXISTIR, uma flag "tenho Access, dispensa senha". A
 * validacao de `Cf-Access-Jwt-Assertion` e roadmap v0.2 e adia-la nao enfraquece
 * a linha de base precisamente porque o portao de credencial continua
 * obrigatorio nos dois modos.
 */
export type TunnelMode = 'quick' | 'named'

/**
 * O que se sabe de um tunel VIVO. Emitido apenas no estado `READY`.
 *
 * `url` traz SEMPRE o esquema. O endpoint `/quicktunnel` do servidor de metricas
 * devolve `{"hostname":"..."}` SEM esquema; quem consome o contrato nao tem de
 * saber disso — a normalizacao e obrigacao de quem implementa `TunnelDiscovery`.
 *
 * A URL NAO E PERSISTIDA (`src/contracts/state.ts`): e efemera e muda a cada
 * restart. O que se persiste e `pid` + `startedAt`, que e o que permite a
 * varredura de orfao no boot.
 */
export interface TunnelInfo {
  /** Absoluta, com esquema. Invariante: comeca por `https://`. */
  readonly url: string
  /** Epoch em milissegundos. Base do TTL que sobrevive a reinicio. */
  readonly startedAt: number
  readonly mode: TunnelMode
}

// ---------------------------------------------------------------------------
// 3. FALHA — porque a mensagem tem de NOMEAR a sonda
// ---------------------------------------------------------------------------

/**
 * As QUATRO sondas anonimas de `02-SEGURANCA.md` L1 / D11, corridas contra
 * `127.0.0.1:<porta>` ANTES de o `cloudflared` subir.
 *
 * - `spa-fallback`      — `GET /`, o fallback da SPA. Espera `401`.
 * - `api-rpc`           — `POST /api/<rpc de leitura>` com corpo vazio. `401`.
 * - `websocket-upgrade` — `GET /` com `Upgrade: websocket`. Socket destruido ou `401`.
 * - `unguarded-canary`  — `GET /__guard/probe-canary-<aleatorio>`, caminho FORA
 *   de `guardedPrefixes`. `401`. Um `404` aqui significa que o pedido nao passou
 *   pelo gate.
 *
 * O modo de falha real que isto cobre e ORDEM DE CARREGAMENTO: `/` vem do
 * `registerFallback` de `@deepseek-ai/dsh-host-frontend-static` e `/api` vem de
 * outro registo. Provar `/` NAO prova `/api`.
 */
export type ProbeId =
  | 'spa-fallback'
  | 'api-rpc'
  | 'websocket-upgrade'
  | 'unguarded-canary'

export interface ProbeOutcome {
  readonly probe: ProbeId
  readonly passed: boolean
  /** Codigo observado. `null` quando o socket foi destruido (sonda 3, caso feliz). */
  readonly status: number | null
}

/**
 * Classificacao da falha. `retryable: false` sai do loop IMEDIATAMENTE em vez de
 * consumir orcamento: tentar de novo nunca vai funcionar.
 *
 * - `PROBE_FAILED`          — o gate NAO esta armado. `probe` diz qual sonda.
 * - `BINARY_NOT_FOUND`      — `ENOENT`. ATENCAO: em `ENOENT` o evento `'exit'`
 *   NUNCA dispara; so `'error'` e `'close'`. Quem escuta so `'exit'` trava.
 * - `BINARY_NOT_EXECUTABLE` — `EACCES`.
 * - `INVALID_CONFIG`        — recusado no load (ver `TunnelConfig`).
 * - `READINESS_TIMEOUT`     — subiu mas nunca ficou utilizavel. RETRYABLE.
 * - `PROCESS_EXITED`        — `close`/`error` do processo. RETRYABLE.
 * - `BUDGET_EXHAUSTED`      — orcamento acabou. Terminal por definicao.
 * - `TTL_EXPIRED`           — prazo cumprido. Nao e erro: e o controlo a agir.
 */
export type TunnelFailureCode =
  | 'PROBE_FAILED'
  | 'BINARY_NOT_FOUND'
  | 'BINARY_NOT_EXECUTABLE'
  | 'INVALID_CONFIG'
  | 'READINESS_TIMEOUT'
  | 'PROCESS_EXITED'
  | 'BUDGET_EXHAUSTED'
  | 'TTL_EXPIRED'

/**
 * INVARIANTE DE APRESENTACAO, herdada de T2.4: `message` e MOSTRADA ao dono no
 * painel e no Telegram. Portanto NAO pode conter segredo, token, caminho
 * absoluto de ficheiro nem a URL do tunel. Um caminho de ficheiro numa mensagem
 * que viaja para o Telegram e divulgacao do layout do disco do utilizador para
 * um terceiro (a infraestrutura do Telegram).
 */
export interface TunnelFailure {
  readonly code: TunnelFailureCode
  /** Preenchido SE E SO SE `code === 'PROBE_FAILED'`. */
  readonly probe?: ProbeId | undefined
  /** Accionavel, em portugues, sem segredo e sem caminho. */
  readonly message: string
  readonly retryable: boolean
}

// ---------------------------------------------------------------------------
// 4. CONFIGURACAO — a forma, congelada; a composicao, de T3.3
// ---------------------------------------------------------------------------

/**
 * Eixo `exposure` da `Config`. Todos os defaults sao os SEGUROS.
 *
 * `trustEdgeHeaders` merece a nota mais dura deste ficheiro. Ele so pode virar
 * `true` se ficar provado que a borda SOBRESCREVE o cabecalho de IP do cliente
 * — nunca se ela apenas ACRESCENTA. Uma borda que acrescenta deixa o cliente
 * escolher o proprio IP, e nesse mundo o rate limit por IP e o audit log por IP
 * passam a ser controlados pelo atacante. Enquanto `false`, `Identity.ip` fica
 * `undefined` — e e por isso que `src/contracts/auth.ts` o declara opcional.
 */
export interface ExposureConfig {
  /** `'loopback'` = so 127.0.0.1. `'tunnel'` = o `cloudflared` pode subir. */
  readonly mode: 'loopback' | 'tunnel'
  /**
   * Default `false`, e o default e a decisao. Um tunel que abre sozinho a cada
   * boot e um tunel que fica aberto sem ninguem saber.
   */
  readonly autoStart: boolean
  /** Default `false`. Ver a nota acima antes de sequer pensar em `true`. */
  readonly trustEdgeHeaders: boolean
}

/**
 * Eixo `tunnel` da `Config`.
 *
 * ---- `ttlMinutes`: default 60, tecto 480, e NENHUM caminho sem TTL ----
 *
 * `02-SEGURANCA.md` 10.2 e D6 dizem "default 60, tecto 480, `0`/ausente e config
 * invalida recusada no load". Lidas a letra, "tem default" e "ausente e
 * invalido" contradizem-se. Resolucao do orquestrador, registada no TASK_PLAN e
 * congelada aqui, que preserva a INTENCAO das duas metades — nunca existir um
 * tunel sem prazo, e nunca haver clamp silencioso:
 *
 *   - chave OMITIDA        -> aplica-se `60`. O `cordis.patch.yml` entrega `60`
 *                             explicitamente, portanto na pratica nunca falta.
 *   - `0`, negativo, `null`, nao-inteiro, ou `> 480` -> LANCA no load.
 *
 * NUNCA fazer clamp. Um `ttlMinutes: 10080` silenciosamente reduzido a 480 diz
 * ao utilizador que ele pediu uma semana e recebeu uma semana. Fail LOUD.
 *
 * A ameaca concreta e T10 de `02-SEGURANCA.md`: abre-se o tunel numa terca a
 * noite, fecha-se o portatil, e descobre-se no domingo que ele nunca fechou.
 * Ao expirar: derruba o tunel, INVALIDA TODAS AS SESSOES EMITIDAS, avisa no
 * Telegram. Invalidar as sessoes nao e opcional — sem isso o cookie sobrevive
 * ao tunel e autentica no seguinte.
 *
 * O TTL tem de sobreviver a mais do que um `setTimeout`, que morre com o event
 * loop. A base e o `startedAt` PERSISTIDO: o boot seguinte compara-o com o
 * relogio e conclui que o prazo ja passou.
 */
export interface TunnelConfig {
  /** Default `'quick'` (D6). */
  readonly mode: TunnelMode
  /** Default `60`. Tecto `480`. Ver a nota acima — nao ha clamp. */
  readonly ttlMinutes: number
  /**
   * So para `mode: 'named'`. Caminho de um ficheiro `0600` com o token.
   *
   * >>> NUNCA `--token` em `argv`. <<< `argv` e legivel por qualquer processo
   * do mesmo utilizador em `/proc/<pid>/cmdline`. E `--token-file`, sempre.
   */
  readonly tokenFile?: string | undefined
  /**
   * Porta do servidor de metricas, sempre em `127.0.0.1`.
   *
   * OMITIDA significa "o plugin escolhe uma porta livre e passa-a
   * explicitamente" — NAO significa "deixa o cloudflared decidir". O default do
   * `cloudflared` e porta ALEATORIA, e a faixa 20241-20245 que circula na
   * internet nao e contrato nenhum. Adivinhar a porta e o bug.
   */
  readonly metricsPort?: number | undefined
}

// ---------------------------------------------------------------------------
// 5. A COSTURA T3.1 <-> T3.2
// ---------------------------------------------------------------------------

/**
 * Tudo o que T3.2 precisa de saber sobre um processo que T3.1 ja spawnou.
 * T3.2 NAO spawna, NAO mata e NAO conhece o `ChildProcess`.
 */
export interface TunnelDiscoveryInput {
  /** A porta que T3.1 FIXOU com `--metrics 127.0.0.1:PORT`. */
  readonly metricsPort: number
  /**
   * `stderr` do processo. Repare: e `stderr`, nao `stdout` — o `cloudflared`
   * deixa `stdout` com ZERO bytes e escreve o banner da URL em `stderr`.
   * `null` quando o chamador nao capturou o fluxo; nesse caso so o caminho
   * primario esta disponivel.
   */
  readonly stderr: Readable | null
  /**
   * Abortado por T3.1 em `'close'` OU `'error'` do processo. Sem isto, o
   * polling espera o timeout inteiro por uma URL que ja nao vai chegar.
   */
  readonly signal: AbortSignal
  /** >= 30_000. A URL levou 6-7 s nas medicoes; a margem e para maquina lenta. */
  readonly timeoutMs: number
}

/**
 * `via` faz parte do contrato porque a pergunta falsificavel de T3.2 e "a URL
 * veio do `/quicktunnel` ou do regex?". Sem isto no valor de retorno, provar o
 * fallback exigiria espreitar o interior da funcao.
 */
export interface TunnelDiscoveryResult {
  /** Absoluta, com `https://` ja prefixado. */
  readonly url: string
  readonly via: 'metrics' | 'stderr'
}

export interface TunnelDiscovery {
  /**
   * PRIMARIO: `GET http://127.0.0.1:<metricsPort>/quicktunnel`, que devolve
   * `{"hostname":"..."}` SEM esquema.
   * FALLBACK: `https://[-a-z0-9]+\.trycloudflare\.com` sobre `stderr`.
   *
   * Rejeita com `TunnelFailure` (`READINESS_TIMEOUT` ou `PROCESS_EXITED`).
   */
  discover(input: TunnelDiscoveryInput): Promise<TunnelDiscoveryResult>
}

/**
 * FRONTEIRA QUE JA CUSTOU CARO, e por isso esta escrita no contrato.
 *
 * `TunnelReadiness` responde "a URL do tunel ja e utilizavel?" e corre DEPOIS de
 * o tunel subir. O probe fail-closed (T3.1, `ProbeId` acima) responde "o gate
 * esta armado?" e corre ANTES de o tunel subir. Confundir as duas foi o que
 * expos o DSH real do utilizador publicamente durante ~40 s na pesquisa:
 *
 *     "a aplicacao responde"  !=  "a aplicacao responde 401 a quem nao tem credencial"
 *
 * E tambem por isso `waitUntilUsable` devolve `status`: "porta aberta" e
 * "aplicacao responde" nao sao a mesma afirmacao, e o contrato obriga quem
 * chama a olhar para o codigo.
 */
export interface ReadinessOutcome {
  readonly usable: boolean
  /** Ultimo codigo observado. `null` se nunca houve resposta HTTP. */
  readonly status: number | null
}

export interface TunnelReadiness {
  waitUntilUsable(input: {
    readonly url: string
    readonly signal: AbortSignal
    readonly timeoutMs: number
  }): Promise<ReadinessOutcome>
}

// ---------------------------------------------------------------------------
// 6. PROJECCAO PUBLICA DO ESTADO
// ---------------------------------------------------------------------------

/**
 * O que o painel (T3.4) e, mais tarde, o bot leem. E uma PROJECCAO: nem o
 * painel nem o bot mantem estado proprio.
 *
 * `info` esta presente SE E SO SE `state === 'READY'`. Isto e deliberado: a URL
 * de um tunel e informacao sensivel de operacao, e o contrato torna
 * impossivel divulga-la a partir de `STARTING` ou de `DEGRADED`.
 */
export interface TunnelSnapshot {
  readonly state: TunnelState
  readonly info?: TunnelInfo | undefined
  /** Presente em `DEGRADED` e em `FAILED`. */
  readonly failure?: TunnelFailure | undefined
  /** Tentativas ja consumidas do orcamento. Zera so apos uptime saudavel. */
  readonly attempts: number
  /** Epoch ms em que o TTL expira. Presente sse `state === 'READY'`. */
  readonly expiresAt?: number | undefined
}
