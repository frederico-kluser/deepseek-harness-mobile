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
 * ---- `ttlMinutes`: obrigatorio, tecto 480, e SEM default no codigo ----
 *
 * D6 e `02-SEGURANCA.md` L1 dizem "default 60"; `04-TESTES.md` TUN-019 diz
 * "`0`, ausente, negativo, nao inteiro ou `> 480` => `assertValidConfig` recusa
 * no load, com erro accionavel; NENHUM default silencioso". Lidos a letra
 * parecem contradizer-se. Nao contradizem, e a reconciliacao esta congelada
 * aqui porque decidir isto dentro de uma sub-tarefa produziria dois
 * comportamentos incompativeis em duas worktrees:
 *
 *   O DEFAULT DE 60 VIVE NO `cordis.patch.yml`, NAO NO CODIGO.
 *
 * O manifesto entrega `ttlMinutes: 60` explicitamente. E um valor que o
 * utilizador VE e pode editar — logo nao e silencioso. O codigo, esse, nao tem
 * fallback nenhum: valor em falta LANCA no load, como qualquer outro valor
 * invalido. Por isso a propriedade e OBRIGATORIA neste tipo.
 *
 * Recusa no load (`assertValidConfig`, T3.3): ausente, `0`, negativo, nao
 * inteiro, `> 480`. NUNCA clamp. Um `ttlMinutes: 10080` reduzido em silencio a
 * 480 diz ao utilizador que ele pediu uma semana e recebeu uma semana. Fail
 * LOUD.
 *
 * A ameaca concreta e T10 de `02-SEGURANCA.md`: abre-se o tunel numa terca a
 * noite, fecha-se o portatil, e descobre-se no domingo que ele nunca fechou.
 * Ao expirar (TUN-016..TUN-018): derruba o tunel, INVALIDA TODAS AS SESSOES
 * EMITIDAS, regista em auditoria, e SO DEPOIS avisa no Telegram. A ordem
 * importa — o aviso e o passo que pode falhar (rede), e a auditoria nao pode
 * depender dele.
 *
 * TUN-026: um `/status` ou um acesso NAO estendem o TTL. So um `start`
 * explicito abre janela nova.
 *
 * O TTL tem de sobreviver a mais do que um `setTimeout`, que morre com o event
 * loop. A base e o `startedAt` PERSISTIDO: o boot seguinte compara-o com o
 * relogio e conclui que o prazo ja passou.
 */
export interface TunnelConfig {
  /** Default (do manifesto) `'quick'` (D6). */
  readonly mode: TunnelMode
  /**
   * OBRIGATORIO. Tecto `480`. Ver a nota acima — sem default no codigo, sem
   * clamp, e ausente e tao invalido quanto `0`.
   */
  readonly ttlMinutes: number
  /**
   * Caminho do binario do `cloudflared`.
   *
   * ESTA CHAVE E O QUE TORNA A SUITE POSSIVEL. Sem ela nao ha como injectar
   * `test/bin/fake-cloudflared.mjs`, e `04-TESTES.md` 5.4 inteiro — TUN-001 a
   * TUN-026, SUP-001 a SUP-015 — deixa de ser executavel sem subir um tunel a
   * serio. E o tunel a serio publica na internet o que estiver na porta: foi
   * assim que a pesquisa expos o DSH real do utilizador por ~40 s. Nenhum teste
   * de `unit`, `integration`, `security` ou `e2e` invoca o `cloudflared`
   * verdadeiro (D10); so `test/live/**` e o roteiro manual M2.
   *
   * Omitida significa `'cloudflared'`, resolvido pelo `PATH`.
   */
  readonly binaryPath?: string | undefined
  /**
   * So para `mode: 'named'`. Caminho de um ficheiro `0600` com o token.
   *
   * >>> NUNCA `--token` em `argv`. <<< `argv` e legivel por qualquer processo
   * do mesmo utilizador em `/proc/<pid>/cmdline` e no `ps`. E `--token-file`,
   * sempre (TUN-014).
   */
  readonly tokenFile?: string | undefined
  /**
   * Porta do servidor de metricas, sempre em `127.0.0.1`.
   *
   * OMITIDA significa "o plugin escolhe uma porta livre e passa-a
   * explicitamente" — NAO significa "deixa o cloudflared decidir".
   *
   * >>> NAO AFIRMAMOS QUAL E O DEFAULT DO `cloudflared`. <<< As nossas duas
   * fontes contradizem-se: a doc oficial fala da faixa 20241-20245, e o
   * cabecalho de `test/bin/fake-cloudflared.mjs` afirma que ele "pega 20241".
   * Resolver isto exigiria medir o binario real, o que esta PROIBIDO na suite
   * (D10). A conclusao operacional e a mesma nos dois mundos e e a unica que
   * este contrato sustenta: **passa-se sempre `--metrics 127.0.0.1:<porta>`
   * explicito, e nunca se adivinha** (TUN-011). Quem escrever "o default e X"
   * em codigo ou comentario esta a afirmar o que nao medimos.
   */
  readonly metricsPort?: number | undefined
  /**
   * Janela de terminacao graciosa: `SIGTERM` ao GRUPO -> espera -> `SIGKILL`
   * (SUP-014). O `--grace-period` do proprio `cloudflared` tem default 30 s; o
   * nosso e passado explicitamente e o teste assere o valor no spawn spec
   * (SUP-015). Omitido significa `3000`, alinhado com `worker.graceMs`.
   */
  readonly graceMs?: number | undefined
  /**
   * Orcamento de reinicio. Os valores sao os mesmos que o supervisor do worker
   * ja usa, e isso e deliberado: T3.1 GENERALIZA o supervisor existente em vez
   * de o duplicar. Se ficarem dois blocos de backoff no repositorio, a
   * generalizacao e ficticia e a revisao adversarial rejeita.
   *
   * `resetAfterMs` e o detalhe que separa um supervisor correcto de um que
   * reinicia para sempre: o contador zera apos UPTIME SAUDAVEL, nunca "a cada
   * sucesso" — senao um processo que morre aos 5 minutos reinicia
   * indefinidamente com o backoff sempre zerado (SUP-004).
   */
  readonly backoff?:
    | {
        readonly initialDelayMs: number
        readonly maxDelayMs: number
        readonly maxAttempts: number
        readonly resetAfterMs: number
      }
    | undefined
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
   *
   * ---------------------------------------------------------------------------
   * OBRIGACAO DO CHAMADOR, e ela e DURA (acrescentada no COMMIT PREP 4)
   * ---------------------------------------------------------------------------
   * Quem passa este fluxo TEM DE MANTER UM CONSUMIDOR DURAVEL ligado a ele
   * durante toda a vida do processo — ligado ANTES de chamar `discover()` e
   * so retirado no `'close'`. `discover()` e LEITOR OPORTUNISTA: acrescenta e
   * remove apenas o listener dele, e o `dispose()` do scanner NAO chama
   * `resume()` de proposito, porque faze-lo descartaria em silencio o log de
   * arranque que o supervisor quer registar.
   *
   * O modo de falha de nao haver consumidor duravel foi MEDIDO na costura da
   * Onda 3: um filho que escreve em `stderr` sem ninguem a ler para de
   * progredir aos **190 464 bytes** (buffer de pipe do SO mais a fila interna
   * de escrita do Node; para o `cloudflared`, que escreve de Go direto ao fd,
   * o tecto e o proprio buffer do pipe). O resultado e **um tunel que congela
   * sem erro, sem log e sem sinal** — a pior forma de falhar que este projeto
   * tem, porque nada a denuncia.
   *
   * Medicao que corrige um mal-entendido comum, e por isso fica escrita:
   * remover o ultimo ouvinte `'data'` **NAO pausa** um `Readable` — o
   * `readableFlowing` fica `true` e os dados sao **descartados em silencio**.
   * Logo o modo de falha nao e "o scanner pausou o fluxo", e sim "ninguem
   * chegou a retomar o fluxo, e o pipe encheu".
   *
   * UMA `discover()` POR PROCESSO SPAWNADO. Um retry e processo novo com
   * `stderr` novo. `discover()` nao e reentrante por desenho: o acumulador e
   * por instancia, e o que ja passou pelo fluxo nao volta.
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
