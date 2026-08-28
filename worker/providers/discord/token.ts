/**
 * O TOKEN DISCORD: de onde vem, por onde NAO pode vir, e o que ele vale.
 *
 * Port do `token.ts` do telegram (fronteira D4: este modulo NAO importa de
 * `worker/lib/*` nem de outro provedor). A diferenca de transporte face ao
 * Telegram e estrutural e vale a pena dizer em voz alta: o token do Telegram
 * viaja NO CAMINHO do URL (`/bot<token>/<metodo>`); o token do Discord viaja
 * NO CABECALHO `Authorization: Bearer` de cada chamada e no corpo do
 * `identify` do gateway — NUNCA num URL. Isso nao o torna menos segredo: quem
 * o tem E o bot, e o mascaramento em `./interno.ts` vale igual.
 *
 * ===========================================================================
 * O TOKEN E SENHA DE CONTROLO TOTAL
 * ===========================================================================
 * Sem segundo fator, sem escopo fino, sem expiracao pratica. O token chega por
 * AMBIENTE, NUNCA por `argv`: `/proc/<pid>/cmdline` e legivel por qualquer
 * processo local do mesmo utilizador; um `ps` casual entrega o token a quem
 * estiver a olhar para o ecra (TG-069).
 */

import { ProviderError } from './interno.ts'

/** O nome que o HOST escreve no ambiente do worker. Contrato com o host. */
export const TOKEN_ENV_VAR = 'DISCORD_BOT_TOKEN'

/** Nome opcional para apontar o cliente a um servidor API proprio ou de teste. */
export const API_ROOT_ENV_VAR = 'DISCORD_API_ROOT'

/** A raiz publica da API do Discord (v10), SEM barra final. */
export const DEFAULT_DISCORD_API_ROOT = 'https://discord.com/api/v10'

/**
 * Forma de DETECCAO de um token do Discord em `argv` — conservadora de
 * proposito. Os tokens do Discord NAO tem formato publico estavel (a doc
 * oficial trata-os como opacos), logo esta forma nao tenta validar NADA: uma
 * sequencia longa (>= 50 chars) do alfabeto base64url com separadores comuns
 * e, na pratica, um token — e a deteccao serve os testes de vazamento e o
 * rastreio de `argv`, nunca para validar (o unico juiz de um token e o
 * gateway).
 */
export const DISCORD_TOKEN_SHAPE = /^[A-Za-z0-9_.-]{50,}$/u

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
      'TOKEN_MISSING',
      `a variavel de ambiente ${TOKEN_ENV_VAR} esta ausente ou vazia; ` +
        'o host constroi o ambiente do worker por allowlist e e ela que a escreve',
    )
  }
  return cru.trim()
}

/**
 * Resolve a raiz da API do provedor a partir do ambiente (ou a publica).
 *
 * O nome da variavel e o MESMO que a sonda do host le
 * (`src/onboarding/sonda.ts::apiRootDe`); a paridade e um teste, nao um
 * import (cone de import).
 */
export function lerApiRootDoAmbiente(env: NodeJS.ProcessEnv): string {
  const cru = env[API_ROOT_ENV_VAR]?.trim()
  return cru === undefined || cru === '' ? DEFAULT_DISCORD_API_ROOT : cru.replace(/\/+$/u, '')
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
    if (literal || DISCORD_TOKEN_SHAPE.test(arg)) {
      throw new ProviderError(
        'TOKEN_IN_ARGV',
        `argv[${index}] contem algo com forma de token do Discord. ` +
          `/proc/<pid>/cmdline e legivel por qualquer processo local: o token entra por ${TOKEN_ENV_VAR}, ` +
          'nunca por linha de comando.',
      )
    }
  }
}
