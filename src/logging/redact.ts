/**
 * `redact()` -- mascara segredos antes de qualquer texto chegar ao log.
 *
 * PORQUE EXISTE, E PORQUE JA AGORA (Q-4: "segredo nunca em log"): o supervisor
 * encaminha stdout/stderr do worker para o logger do DSH. Esse worker e um
 * cliente HTTP do Telegram, e a API do Telegram poe o token DENTRO do caminho do
 * URL (`https://api.telegram.org/bot<n>:<token>/getUpdates`). Basta o bot
 * imprimir um erro de rede -- o que qualquer cliente HTTP faz por omissao -- para
 * o token do bot ficar em claro no log do plano de controlo. Nao e hipotetico:
 * e o formato normal de uma mensagem de excecao de `requests`/`httpx`.
 *
 * DUAS CAMADAS, e a ordem importa:
 *   1. LITERAIS CONHECIDOS. Se ja sabemos o segredo (o `worker.token` vem da
 *      configuracao), a substituicao literal e exata e nao depende de a agulha
 *      ter o formato esperado. E a camada fiavel.
 *   2. FORMAS. Para o que nao conhecemos: a forma de um token de bot, e o VALOR
 *      de um cabecalho `Authorization`/`Cookie` quando o texto e um dump de
 *      pedido. E heuristica, e esta declarada como tal -- apanha o caso comum,
 *      nao substitui a camada 1.
 *
 * O QUE NAO ESTA AQUI, de proposito: o `mk` do link magico e o URL do tunel. Sao
 * segredos que ainda nao existem no codigo (Ondas 2 e 3); acrescentar padroes
 * para formatos que ainda nao foram fixados seria adivinhar. Os donos desses
 * segredos acrescentam a sua forma a {@link SECRET_SHAPES} quando a fixarem.
 */

/** Substituto visivel: um log com isto diz ao operador que houve corte. */
export const REDACTED = '[REDACTED]'

/**
 * Comprimento minimo de um literal conhecido para ser mascarado.
 *
 * Um segredo curto (ou vazio, ou um valor de teste como `'x'`) casaria com meio
 * texto e transformava o log em ruido. Abaixo deste limite o valor nao e
 * segredo utilizavel de qualquer forma.
 */
const MIN_LITERAL_LENGTH = 8

/** Formas heuristicas. Cada entrada mascara SO o grupo de captura `$2`. */
const SECRET_SHAPES: ReadonlyArray<{ pattern: RegExp; keep: string }> = [
  // Token de bot do Telegram: `<id numerico>:<segredo>` -- a forma que viaja
  // dentro do caminho do URL da API. Sem `\b` a abrir: o token aparece colado ao
  // prefixo `bot` (`/bot123:AA.../getUpdates`), onde `t9` NAO e fronteira de
  // palavra e um `\b` fazia a forma nunca casar exatamente no caso real.
  { pattern: /((?<!\d)\d{6,12}:)([A-Za-z0-9_-]{20,})/gu, keep: '$1' },
  // Valor de um cabecalho de autorizacao num dump de pedido. Ate ao fim da
  // linha, e nao `\S+`: o valor de `Basic <credencial>` tem um espaco no meio, e
  // parar no primeiro branco deixava a credencial em claro.
  { pattern: /((?:proxy-)?authorization\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
  // Valor de um cookie (o nome pode ficar; o valor nunca).
  { pattern: /((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
]

/** Escapa um literal para uso seguro dentro de uma expressao regular. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Devolve `text` com os segredos mascarados.
 *
 * @param text texto arbitrario, tipicamente vindo de um processo de terceiros.
 * @param knownSecrets literais que sabemos ser segredos (ex.: `worker.token`).
 */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text

  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length < MIN_LITERAL_LENGTH) continue
    result = result.replace(new RegExp(escapeForRegExp(secret), 'gu'), REDACTED)
  }

  for (const { pattern, keep } of SECRET_SHAPES) {
    // `lastIndex` de uma regex global e estado partilhado entre chamadas; o
    // `replace` reinicia-o, mas construir a copia torna a funcao reentrante.
    result = result.replace(new RegExp(pattern.source, pattern.flags), `${keep}${REDACTED}`)
  }

  return result
}
