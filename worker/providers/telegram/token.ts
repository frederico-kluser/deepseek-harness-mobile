/**
 * O TOKEN TELEGRAM: de onde vem, por onde NAO pode vir, e o que ele vale.
 *
 * Port fiel de `worker/lib/token.ts` (DONO de referencia: Onda 0/1). A regra
 * da fronteira D4 proibe o adaptador de IMPORTAR de `worker/lib/*`; este
 * modulo PORTEIA a semantica — a mesma, byte a byte, incluindo TG-069 (token
 * NUNCA em `argv`).
 *
 * ===========================================================================
 * O TOKEN E SENHA DE CONTROLO TOTAL
 * ===========================================================================
 * Sem segundo fator, sem escopo, sem allowlist de IP, sem expiracao. Quem o
 * tem E o bot. E ele VIAJA NA URL de cada chamada, o que faz de qualquer log
 * de cliente HTTP um vazamento em potencia (daí o mascaramento em
 * `./interno.ts`).
 *
 * O token chega por AMBIENTE, NUNCA por `argv`: `/proc/<pid>/cmdline` e
 * legivel por qualquer processo local do mesmo utilizador; um `ps` casual
 * entrega o token a quem estiver a olhar para o ecra (TG-069).
 */

import { ProviderError, WORKER_EXIT } from './interno.ts'

/** O nome que o HOST escreve no ambiente do worker. Contrato com o host. */
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
 * @throws {ProviderError} `TOKEN_MISSING` se ausente ou so espacos. A mensagem
 * nomeia a variavel e NAO cita o valor lido — citar um valor "invalido" e como
 * se vaza um token com um espaco a mais.
 */
export function lerTokenDoAmbiente(env: NodeJS.ProcessEnv): string {
  const cru = env[TOKEN_ENV_VAR]
  if (cru === undefined || cru.trim() === '') {
    throw new ProviderError(
      WORKER_EXIT.CONFIG,
      'TOKEN_MISSING',
      `a variavel de ambiente ${TOKEN_ENV_VAR} esta ausente ou vazia; ` +
        'o host constroi o ambiente do worker por allowlist e e ela que a escreve',
    )
  }
  return cru.trim()
}

/**
 * Recusa arrancar se o token — ou QUALQUER coisa com forma de token — estiver
 * na linha de comando (TG-069).
 *
 * Duas verificacoes, e as duas sao precisas: a literal apanha o nosso token
 * ainda que o formato mude; a de forma apanha o token de OUTRO bot que alguem
 * passou por engano, que e o caso em que ninguem repara.
 */
export function assertTokenNotInArgv(argv: readonly string[], token?: string): void {
  for (const [index, arg] of argv.entries()) {
    const literal = token !== undefined && token.length >= 8 && arg.includes(token)
    if (literal || BOT_TOKEN_SHAPE.test(arg)) {
      throw new ProviderError(
        WORKER_EXIT.CONFIG,
        'TOKEN_IN_ARGV',
        `argv[${index}] contem algo com forma de token do Telegram. ` +
          `/proc/<pid>/cmdline e legivel por qualquer processo local: o token entra por ${TOKEN_ENV_VAR}, ` +
          'nunca por linha de comando.',
      )
    }
  }
}