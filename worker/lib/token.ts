/**
 * O TOKEN: de onde vem, por onde NAO pode vir, e o que ele vale.
 *
 * ===========================================================================
 * O TOKEN E SENHA DE CONTROLO TOTAL
 * ===========================================================================
 * Sem segundo fator, sem escopo, sem allowlist de IP, sem expiracao. Quem o tem
 * E o bot. E ele VIAJA NA URL de cada chamada, o que faz de qualquer log de
 * cliente HTTP um vazamento em potencia (ver `./redact.ts`).
 *
 * O que um atacante com o token consegue:
 *   - personificar o bot perante qualquer chat;
 *   - ROUBAR A FILA DE UPDATES — `getUpdates` com `offset` positivo confirma
 *     E APAGA os updates no servidor (medido em `docs/spikes/telegram.md` 7),
 *     portanto o dono legitimo NUNCA chega a ver os comandos roubados;
 *   - sequestrar o canal por `setWebhook`, redirecionando os updates para si.
 *
 * O que ele NAO consegue neste desenho — e a razao esta em `./polling.ts` — e
 * FABRICAR um update com identidade allowlistada.
 *
 * ===========================================================================
 * O TOKEN CHEGA POR AMBIENTE, NUNCA POR `argv`
 * ===========================================================================
 * `/proc/<pid>/cmdline` e legivel por qualquer processo local; um `ps` casual
 * entrega o token a quem estiver a olhar para o ecra. O ambiente do worker e
 * CONSTRUIDO POR ALLOWLIST no host (`buildWorkerEnv`, `src/proc/env.ts`) e nao
 * herda `process.env` inteiro — e por isso que `ADMIN_PASS` do plano de
 * controlo nao viaja para dentro do processo que fala com a Internet.
 *
 * `NODE_OPTIONS` fica DELIBERADAMENTE de fora dessa allowlist: ele aceita
 * `--require`, ou seja, carga de codigo arbitrario no filho. Uma variavel de
 * ambiente que executa codigo nao e configuracao, e um vetor.
 *
 * Este modulo fecha o lado do FILHO: se o token aparecer em `argv`, o processo
 * recusa arrancar. Fail-closed, e nao um aviso — um aviso seria lido no dia
 * seguinte, e o token ja estaria em todo o lado.
 */

import { WorkerError } from './errors.ts'

/** O nome que `buildWorkerEnv` escreve. Contrato com o host. */
export const TOKEN_ENV_VAR = 'TELEGRAM_BOT_TOKEN'

/** Nome opcional para apontar o cliente a um servidor Bot API proprio ou de teste. */
export const API_ROOT_ENV_VAR = 'TELEGRAM_API_ROOT'

/**
 * Forma de um token do BotFather: `<id numerico>:<segredo>`.
 *
 * Serve para DETETAR (nos testes de vazamento e no rastreio de `argv`), nunca
 * para VALIDAR: recusar um token que nao case com esta forma seria apostar que
 * o BotFather nunca muda o alfabeto, e o unico juiz de um token e o `getMe`.
 */
export const BOT_TOKEN_SHAPE = /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{20,}/u

/**
 * Le o token do ambiente.
 *
 * @throws {WorkerError} `TOKEN_MISSING` se ausente ou so espacos. A mensagem
 * nomeia a variavel e NAO cita o valor lido — citar um valor "invalido" e como
 * se vaza um token com um espaco a mais.
 */
export function readBotToken(env: NodeJS.ProcessEnv): string {
  const raw = env[TOKEN_ENV_VAR]
  if (raw === undefined || raw.trim() === '') {
    throw new WorkerError(
      'TOKEN_MISSING',
      `a variavel de ambiente ${TOKEN_ENV_VAR} esta ausente ou vazia; ` +
        'o host constroi o ambiente do worker por allowlist e e ele que a escreve',
    )
  }
  return raw.trim()
}

/**
 * Recusa arrancar se o token — ou QUALQUER coisa com forma de token — estiver
 * na linha de comando.
 *
 * Duas verificacoes, e as duas sao precisas: a literal apanha o nosso token
 * ainda que o formato mude; a de forma apanha o token de OUTRO bot que alguem
 * passou por engano, que e o caso em que ninguem repara.
 *
 * @throws {WorkerError} `TOKEN_IN_ARGV`.
 */
export function assertTokenNotInArgv(argv: readonly string[], token?: string): void {
  for (const [index, arg] of argv.entries()) {
    // `argv[0]` e o executavel e `argv[1]` o script; um token la seria absurdo,
    // mas verificam-se na mesma — custa nada e o absurdo acontece.
    const literal = token !== undefined && token.length >= 8 && arg.includes(token)
    if (literal || BOT_TOKEN_SHAPE.test(arg)) {
      throw new WorkerError(
        'TOKEN_IN_ARGV',
        `argv[${index}] contem algo com forma de token do Telegram. ` +
          `/proc/<pid>/cmdline e legivel por qualquer processo local: o token entra por ${TOKEN_ENV_VAR}, ` +
          'nunca por linha de comando.',
      )
    }
  }
}
