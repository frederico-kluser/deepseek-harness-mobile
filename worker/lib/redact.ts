/**
 * Mascaramento de segredo do lado do WORKER.
 *
 * ===========================================================================
 * PORQUE E UMA COPIA, E NAO UM `import` DE `src/logging/redact.ts`
 * ===========================================================================
 * `05-QUALIDADE-CODIGO.md` 5.5 proibe `worker/ -> src/` fora de tipos de
 * `src/contracts/`, e a lista de verificacao de 10 diz o mesmo por outras
 * palavras. O worker e outro processo: o que ele carrega e superficie do
 * processo que fala com a Internet, e "e so uma funcao pura" e exatamente o
 * argumento com que meia arvore de `src/` acaba la dentro.
 *
 * Duas camadas, e a ordem importa — a mesma de `src/logging/redact.ts`:
 *
 *   1. LITERAIS CONHECIDOS. Aqui sabemos o segredo: o token vem do ambiente. A
 *      substituicao literal e exata e NAO depende de a agulha ter o formato
 *      esperado — o BotFather pode mudar o alfabeto do token amanha e esta
 *      camada continua a funcionar. E a camada fiavel.
 *   2. FORMAS. Para o que nao conhecemos.
 *
 * ===========================================================================
 * PORQUE ISTO IMPORTA MAIS AQUI DO QUE EM QUALQUER OUTRO SITIO
 * ===========================================================================
 * O token do bot E SENHA DE CONTROLO TOTAL: sem segundo fator, sem escopo, sem
 * allowlist de IP. E ele VIAJA NA URL de cada chamada
 * (`https://api.telegram.org/bot<id>:<segredo>/getUpdates`), portanto qualquer
 * cliente HTTP que imprima "falhou o pedido a <url>" publica-o. Nao e
 * hipotetico: e o formato normal da mensagem de erro do `node-fetch`, que e o
 * cliente que o grammY 1.45.1 usa no Node (`out/shim.node.js`).
 *
 * Quem tiver o token personifica o bot, ROUBA A FILA DE UPDATES (medido: um
 * `getUpdates` com `offset` positivo APAGA os updates no servidor — o dono
 * legitimo nunca chega a ver aqueles comandos) e sequestra o canal por
 * `setWebhook`.
 */

/** Substituto visivel: um log com isto diz ao operador que houve corte. */
export const REDACTED = '[REDACTED]'

/**
 * Comprimento minimo de um literal conhecido para ser mascarado. Um segredo
 * curto (ou um valor de teste como `'x'`) casaria com meio texto e transformava
 * o log em ruido; abaixo disto nao e segredo utilizavel de qualquer maneira.
 */
const MIN_LITERAL_LENGTH = 8

/**
 * Formas heuristicas. `keep: '$1'` preserva o prefixo que NOMEIA o segredo (sem
 * ele a linha fica ilegivel); `keep: ''` apaga o casamento inteiro.
 */
const SECRET_SHAPES: ReadonlyArray<{ pattern: RegExp; keep: string }> = [
  /*
   * Token de bot: `<id numerico>:<segredo>`, a forma que viaja DENTRO do
   * caminho da URL. Sem `\b` a abrir, de proposito: o token aparece colado ao
   * prefixo `bot` (`/bot123:AA.../getUpdates`), onde nao ha fronteira de
   * palavra, e um `\b` fazia a forma nunca casar no unico caso que interessa.
   */
  { pattern: /((?<!\d)\d{6,12}:)([A-Za-z0-9_-]{20,})/gu, keep: '$1' },
  // Valor de um cabecalho de autorizacao num dump de pedido. Ate ao fim da
  // linha, e nao `\S+`: `Basic <credencial>` tem espaco no meio.
  { pattern: /((?:proxy-)?authorization\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
  // Valor de cookie (o nome pode ficar; o valor nunca).
  { pattern: /((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
  /*
   * O `$HOME`, E SO O `$HOME`. Mascarar caminho absoluto a granel e a forma
   * mais facil de destruir uma mensagem de erro util: `/usr/lib/...` e igual em
   * todas as maquinas e nao identifica ninguem. O que identifica o UTILIZADOR e
   * `/home/<nome>`, `/Users/<nome>` e `/root` — e um caminho destes numa
   * mensagem que o bot mostre ao dono atravessa a infraestrutura do Telegram.
   */
  { pattern: /(?<![\w.~-])\/(?:(?:home|Users)\/[^/\s"'<>)\];,:]+|root)(?![\w-])/gu, keep: '' },
]

/** Escapa um literal para uso seguro dentro de uma expressao regular. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Devolve `text` com os segredos mascarados.
 *
 * @param text texto arbitrario — tipicamente a mensagem de um erro de rede.
 * @param knownSecrets literais que sabemos ser segredos (o token do bot).
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

/**
 * Descricao segura de um valor arbitrario para log.
 *
 * PORQUE NAO `String(value)` DIRETO: um `Error` responde `"Error: msg"` e perde
 * a `cause`; um objeto responde `"[object Object]"`, que e ruido puro. E porque
 * `JSON.stringify` de um erro devolve `{}` — o pior dos dois mundos.
 *
 * O resultado passa SEMPRE por {@link redact}: e este o caminho por onde a
 * mensagem do `node-fetch`, com a URL e o token dentro, tentaria sair.
 */
export function describeForLog(value: unknown, knownSecrets: readonly string[] = []): string {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? '' : ` <- ${describeForLog(value.cause, knownSecrets)}`
    return redact(`${value.name}: ${value.message}${cause}`, knownSecrets)
  }
  if (typeof value === 'string') return redact(value, knownSecrets)
  if (value === null || value === undefined || typeof value !== 'object') {
    return redact(String(value), knownSecrets)
  }
  try {
    // `JSON.stringify` de um objeto normal devolve sempre string; e para os
    // casos em que NAO devolve (getter que lanca, `BigInt`, ciclo) que existe o
    // `catch` — nao ha caminho em que ele devolva `undefined` aqui.
    return redact(JSON.stringify(value), knownSecrets)
  } catch (error) {
    // Referencia circular, `BigInt`, getter que lanca. Nunca engolir: diz-se o
    // que aconteceu em vez de fingir que o valor era vazio.
    return redact(`[nao serializavel: ${error instanceof Error ? error.name : 'desconhecido'}]`)
  }
}
