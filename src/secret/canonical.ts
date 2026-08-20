/**
 * `canonicalizeSecret` -- a forma UNICA sobre a qual se calcula o digest.
 *
 * PORQUE EXISTE: o segredo e apresentado agrupado (`MJDN-2GVY-KP7S-...`) porque
 * assim se dita ao telefone sem perder o sitio. Quem o volta a escrever pode
 * escreve-lo agrupado, corrido, em minusculas, ou colado do telemovel com um
 * espaco inquebravel no fim. Todas essas formas designam O MESMO segredo. Se a
 * normalizacao vivesse em cada chamador, cada um normalizaria uma coisa
 * diferente e o mesmo segredo passaria num caminho e falhasse noutro.
 *
 * O QUE ELA NAO FAZ, de proposito:
 *   - NAO traduz `0` para `O` nem `1` para `I`/`L`. O alfabeto base32 do RFC
 *     4648 nao contem `0`, `1`, `8` nem `9` exatamente para que nao haja par
 *     ambiguo (RFC 4648 3.4: "The characters '0' and 'O' are easily confused, as
 *     are '1', 'l', and 'I'. In the base32 alphabet below, where 0 (zero) and 1
 *     (one) are not present, a decoder may interpret 0 as O, and 1 as I or L
 *     depending on case. (However, by default it should not [...])"). Seguimos o
 *     "by default it should not": um `0` escrito a mais e recusado em vez de
 *     reinterpretado em silencio.
 *   - NAO valida o alfabeto. Validar aqui obrigaria a decidir o que fazer com um
 *     caractere invalido, e a unica decisao segura -- recusar -- ja e a que o
 *     digest toma sozinho, sem ramo extra e sem mensagem diferente para
 *     "caractere invalido" e "segredo errado" (`02-SEGURANCA.md` 6.1).
 */

/**
 * Teto de caracteres processados.
 *
 * NAO E UM CONTROLO DE SEGURANCA: e um limite de trabalho. O segredo tem 52
 * caracteres e, com separadores, nunca passa de ~70; qualquer coisa acima disto
 * so pode ser engano ou tentativa de fazer o processo gastar CPU a hashear
 * megabytes. Cortar por um valor FIXO nao depende de nenhum byte do segredo
 * guardado, logo nao e canal temporal.
 */
const MAX_INPUT_LENGTH = 512

/**
 * Separadores aceites: qualquer branco (o `\\s` do JS ja inclui o espaco
 * inquebravel U+00A0, que e o que um telemovel cola) e qualquer traco -- o `-`
 * do teclado, os tracos tipograficos U+2010..U+2015 e o sinal de menos U+2212,
 * em que um corretor automatico pode transformar o `-`.
 */
const SEPARATORS = /[\s\u2010-\u2015\u2212-]+/gu

/** Devolve a forma canonica: maiusculas, sem separadores. */
export function canonicalizeSecret(input: string): string {
  return input.slice(0, MAX_INPUT_LENGTH).replace(SEPARATORS, '').toUpperCase()
}
