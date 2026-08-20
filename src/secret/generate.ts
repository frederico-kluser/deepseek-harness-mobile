/**
 * Geracao e APRESENTACAO do segredo do dono.
 *
 * ENTROPIA (`03-ONDAS.md` 7, T2.1): 32 bytes de `crypto.randomBytes`, ou seja
 * 256 bits de CSPRNG. A ASVS 5.0 11.5.1 exige, literalmente, que "all random
 * numbers and strings which are intended to be non-guessable must be generated
 * using a cryptographically secure pseudo-random number generator (CSPRNG) and
 * have at least 128 bits of entropy". 256 bits e o dobro do piso -- a folga nao
 * custa nada aqui (sao 20 caracteres a mais de base32) e e o que sustenta a
 * decisao de NAO usar um KDF caro, argumentada em `verify.ts`.
 *
 * APRESENTACAO em base32 do RFC 4648 (5 bits por caractere). O alfabeto e
 * `A-Z` + `2-7`: nao contem `0`, `1`, `8` nem `9`, precisamente porque `0`/`O`
 * e `1`/`l`/`I` sao os pares que se confundem a ler e a ditar (RFC 4648 3.4).
 * Nao ha padding: 256 bits dao 52 caracteres exatos de 5 bits com 4 bits de
 * sobra no ultimo, e os bits de enchimento sao zero, como o RFC 3.5 exige da
 * codificacao canonica -- por isso o ultimo caractere e sempre de indice par.
 *
 * O SEGREDO EM CLARO NAO VIVE AQUI. `generateSecret()` devolve-o e nao guarda
 * copia: nao ha variavel de modulo, cache nem log neste ficheiro. O buffer de
 * bytes crus e zerado antes do retorno; a string em si nao se pode apagar
 * (strings sao imutaveis em JS e a sua vida acaba no colector de lixo) -- por
 * isso o unico contrato honesto e "o chamador nao a guarda", que e o que
 * `store.ts` faz: hasheia, persiste o digest e deixa a string sair de ambito.
 */

import { randomBytes } from 'node:crypto'

import { encodeQr } from './qr.ts'

/** 256 bits (ASVS 5.0 11.5.1 pede >= 128). */
export const SECRET_BYTES = 32

/** 52 caracteres de 5 bits: `Math.ceil(256 / 5)`. */
export const SECRET_LENGTH = 52

/** Alfabeto base32 do RFC 4648 seccao 6. Sem `0`, `1`, `8` e `9`. */
export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Caracteres por grupo visual. Quatro e o tamanho que se dita de uma vez. */
const GROUP_SIZE = 4

/** Moldura clara obrigatoria em volta do QR (ISO/IEC 18004, 9.1). */
const QUIET_ZONE = 4

/**
 * Codifica bytes em base32 RFC 4648 SEM padding.
 *
 * Acumulador de bits em vez de tabela de blocos de 5 bytes: o unico chamador
 * tem 32 bytes (que nao e multiplo de 5) e um resto tratado a parte seria um
 * ramo a mais para o mesmo resultado.
 */
export function encodeBase32(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(acc >>> bits) & 0b11111]
    }
  }
  // Sobra de 1 a 4 bits: completa-se com zeros a direita (RFC 4648 3.5).
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 0b11111]
  return out
}

/**
 * Gera um segredo novo. O valor devolvido e a UNICA copia em claro que existe.
 */
export function generateSecret(): string {
  const bytes = randomBytes(SECRET_BYTES)
  const secret = encodeBase32(bytes)
  // Higiene: o buffer cru e nosso e pode ser apagado. Nao e teatro -- e o que
  // impede o material bruto de ficar num bloco de heap reutilizavel depois de a
  // funcao sair. Ver o cabecalho quanto ao que NAO se pode apagar (a string).
  bytes.fill(0)
  return secret
}

/** `MJDN-2GVY-...`: grupos de 4 separados por `-`, para ditar sem perder o sitio. */
export function groupSecret(canonical: string): string {
  const groups: string[] = []
  for (let i = 0; i < canonical.length; i += GROUP_SIZE) {
    groups.push(canonical.slice(i, i + GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * Desenha um QR em texto, dois modulos por linha (meio bloco).
 *
 * FUNDO ESCURO POR OMISSAO: num terminal de fundo escuro o glifo desenhado e
 * CLARO, logo o modulo ESCURO do QR e a AUSENCIA de glifo. Com `invert` a
 * convencao troca, para terminal ou pagina de fundo claro -- um leitor de QR
 * espera contraste na polaridade certa e um codigo invertido nao le em muitos
 * telemoveis. Um modulo ocupa uma celula de largura e meia de altura, que e o
 * que o torna quadrado no ecra (a celula de texto e cerca de duas vezes mais
 * alta que larga).
 */
export function renderQrAscii(text: string, options?: { readonly invert?: boolean }): string {
  const { size, dark } = encodeQr(text)
  const span = size + 2 * QUIET_ZONE
  const invert = options?.invert === true
  const isDark = (y: number, x: number): boolean => {
    const my = y - QUIET_ZONE
    const mx = x - QUIET_ZONE
    const inside = my >= 0 && mx >= 0 && my < size && mx < size
    return (inside && dark[my * size + mx] === 1) !== invert
  }
  const lines: string[] = []
  for (let y = 0; y < span; y += 2) {
    let line = ''
    for (let x = 0; x < span; x += 1) {
      const top = isDark(y, x)
      const bottom = y + 1 < span ? isDark(y + 1, x) : invert
      line += top ? (bottom ? ' ' : '▄') : bottom ? '▀' : '█'
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * O painel de apresentacao: o texto agrupado e o QR na MESMA tela.
 *
 * PORQUE OS DOIS JUNTOS (`03-ONDAS.md` 7, T2.1): com `control.magicLink`
 * desligado nao ha link para tocar, e o telemovel e onde o dono vai usar isto.
 * O QR e o caminho curto para quem tem a camara a mao; o texto agrupado e o
 * caminho de quem esta ao telefone com outra pessoa, ou cujo leitor de QR nao
 * enxerga o terminal. Devolver so um deles obrigaria o chamador a escolher por
 * nos, e havia dois chamadores (o CLI de T4.1 e a rota de T3.4).
 *
 * Sem prosa aqui: a moldura de texto ("guarde isto", "mostrado uma unica vez")
 * pertence a superficie que apresenta, nao a esta camada.
 */
export function renderSecretPanel(canonical: string, options?: { readonly invert?: boolean }): string {
  return `${groupSecret(canonical)}\n\n${renderQrAscii(canonical, options)}`
}
