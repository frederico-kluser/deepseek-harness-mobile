/**
 * Erros tipados do PROCESSO do bot, com codigo estavel.
 *
 * ---------------------------------------------------------------------------
 * PORQUE NAO IMPORTA `GuardError` DE `src/errors.ts`
 * ---------------------------------------------------------------------------
 * `05-QUALIDADE-CODIGO.md` 5.5 e literal: «um `import` de `worker/` para dentro
 * de `src/` que nao seja um tipo de `src/contracts/` e rejeicao de PR — ele
 * compila, roda em teste unitario, e falha em producao carregando metade do
 * plugin dentro do processo do bot». O worker e OUTRO PROCESSO e o grafo de
 * modulos respeita isso: aqui nao entra nada de `src/` alem de tipos de
 * `src/contracts/`.
 *
 * O que se copia e o PADRAO, nao o codigo: codigo estavel + mensagem prefixada
 * pelo dono, campo atribuido a mao (nada de parameter properties — o
 * `node --test` corre estes `.ts` em STRIP-ONLY MODE, que recusa a sintaxe que
 * EMITE codigo em vez de so apagar tipos; a mesma regra vale para `enum` e
 * `namespace`).
 */

/**
 * Prefixo das mensagens. Duplicado de `PLUGIN_NAME` por desenho (ver acima),
 * com o sufixo `/worker` porque estas linhas saem no `stderr` do FILHO e o
 * operador tem de conseguir separa-las das do host num log intercalado.
 */
export const WORKER_LOG_NAME = 'dsh-guard-messenger/worker'

/**
 * Vocabulario FECHADO. Cada codigo e uma condicao que o operador tem de
 * conseguir distinguir sem ler prosa — e, no caso dos tres primeiros, sem a
 * qual ele nao sabe se deve reiniciar o processo ou parar de tentar.
 *
 * - `TOKEN_MISSING`         — `TELEGRAM_BOT_TOKEN` ausente ou vazio no ambiente.
 *                             Nao melhora com nova tentativa.
 * - `TOKEN_IN_ARGV`         — alguem pos o token na linha de comando. Recusa
 *                             FAIL-CLOSED: `/proc/<pid>/cmdline` e legivel por
 *                             qualquer processo local do mesmo utilizador.
 * - `POLLING_CONFLICT`      — 409 `terminated by other getUpdates request`. Ha
 *                             um segundo consumidor. Terminal (ver `polling.ts`).
 * - `POLLING_UNAUTHORIZED`  — 401. O token foi revogado ou esta errado. Terminal.
 * - `POLLING_FAILED`        — o `bot.start()` rejeitou por outra razao.
 * - `BOOT_TIMEOUT`          — o arranque nao chegou a receber updates dentro do
 *                             prazo. Ver a medicao em `./polling.ts`.
 * - `CALLBACK_DATA_TOO_LONG` — `callback_data` acima de 64 BYTES (nao caracteres).
 * - `MESSAGE_EMPTY`         — pedido de envio sem texto: a Bot API recusa, e
 *                             deixar rebentar la e desperdicar uma chamada.
 */
export type WorkerErrorCode =
  | 'TOKEN_MISSING'
  | 'TOKEN_IN_ARGV'
  | 'POLLING_CONFLICT'
  | 'POLLING_UNAUTHORIZED'
  | 'POLLING_FAILED'
  | 'BOOT_TIMEOUT'
  | 'CALLBACK_DATA_TOO_LONG'
  | 'MESSAGE_EMPTY'

/**
 * Erro do worker com codigo legivel por programa.
 *
 * A `message` NAO e um sitio para segredo: ela vai para o `stderr`, que o host
 * encaminha para o log do DSH. Quem construir um `WorkerError` a partir de
 * texto de terceiros passa-o por `redact()` ANTES.
 */
export class WorkerError extends Error {
  override readonly name = 'WorkerError'
  readonly code: WorkerErrorCode

  constructor(code: WorkerErrorCode, detail: string, options?: { readonly cause?: unknown }) {
    super(`[${WORKER_LOG_NAME}] ${code}: ${detail}`, options)
    this.code = code
  }
}

/**
 * Codigos de saida do processo, estaveis.
 *
 * PORQUE EXISTEM, e porque nao sao `1` para tudo: o host observa o `close` do
 * subprocesso e projeta `DEGRADED`. Um codigo distinto por causa terminal e a
 * diferenca entre o operador ver «worker morreu» e ver «ha DUAS instancias do
 * bot a correr com o mesmo token». O supervisor NAO depende destes valores hoje
 * (`src/proc/failure.ts` classifica por `errno` de spawn, nao por codigo de
 * saida); eles existem para o log e para o dia em que dependa.
 *
 * Fora da gama 1..63 nao ha nada de especial; evita-se 0 (sucesso) e a gama
 * 128+N, que o shell usa para «morto pelo sinal N».
 */
export const WORKER_EXIT = Object.freeze({
  /** Paragem limpa: `bot.stop()` completou e o polling terminou. */
  OK: 0,
  /** `TOKEN_MISSING` ou `TOKEN_IN_ARGV`: configuracao, nao instabilidade. */
  CONFIG: 10,
  /** 409. Ha um segundo `getUpdates` vivo com o mesmo token. */
  CONFLICT: 11,
  /** 401. Token revogado/errado. */
  UNAUTHORIZED: 12,
  /** Qualquer outra falha terminal do polling. */
  POLLING: 13,
  /** O arranque expirou sem nunca receber updates. */
  BOOT_TIMEOUT: 14,
})

/** Codigo de saida que corresponde a cada causa terminal. */
export function exitCodeFor(code: WorkerErrorCode): number {
  switch (code) {
    case 'TOKEN_MISSING':
    case 'TOKEN_IN_ARGV':
      return WORKER_EXIT.CONFIG
    case 'POLLING_CONFLICT':
      return WORKER_EXIT.CONFLICT
    case 'POLLING_UNAUTHORIZED':
      return WORKER_EXIT.UNAUTHORIZED
    case 'BOOT_TIMEOUT':
      return WORKER_EXIT.BOOT_TIMEOUT
    case 'POLLING_FAILED':
    case 'CALLBACK_DATA_TOO_LONG':
    case 'MESSAGE_EMPTY':
      return WORKER_EXIT.POLLING
  }
}
