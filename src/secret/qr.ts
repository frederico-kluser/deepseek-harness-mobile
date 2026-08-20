/**
 * Codificador de QR code -- funcao pura `string -> matriz de bits`, SEM
 * DEPENDENCIA NOVA. Quem o desenha em texto e `generate.ts`.
 *
 * PORQUE CODIFICADOR PROPRIO, e nao um pacote: a Onda 2 declara `package.json`
 * como singleton de NINGUEM (`03-ONDAS.md` 4.1) e o custo de supply chain de um
 * pacote de QR numa camada de autenticacao nao se paga. Este ficheiro nao toca
 * em rede, disco, processo nem no segredo persistido.
 *
 * PORQUE UM QR DE TODO (`03-ONDAS.md` 7, T2.1): com `control.magicLink`
 * desligado, a alternativa e o dono copiar 52 caracteres a mao para o telemovel.
 *
 * O QUE ESTA IMPLEMENTADO, e o que nao esta:
 *   - Nivel de correccao M (~15%), versoes 1 a 6 (21x21 a 41x41).
 *   - Modo ALFANUMERICO (11 bits por 2 caracteres) quando toda a entrada cabe no
 *     alfabeto do ISO/IEC 18004 tabela 5; senao, modo BYTE. O segredo e base32
 *     maiusculo, logo cai sempre no alfanumerico: 52 caracteres dao versao 3
 *     (29x29, 37 colunas com moldura) em vez da versao 4 do modo byte (33x33,
 *     41 colunas) -- quanto menor o simbolo, menos exigente e a leitura por
 *     camara a partir de um terminal.
 *   - NAO ha segmentacao mista nem versao >= 7 (que exigiria o bloco de
 *     informacao de versao). Entrada mista vai inteira em modo byte: correcta e
 *     legivel, apenas nao a menor possivel.
 *
 * VERIFICACAO: `test/unit/secret/qr.test.ts` compara a matriz produzida aqui,
 * bit a bit, com a da `libqrencode` 4.1.1 -- a implementacao de referencia em C
 * do utilitario `qrencode` -- em 23 vectores que cobrem as fronteiras de
 * capacidade de todas as versoes suportadas, nos dois modos.
 */

/** Alfabeto do modo alfanumerico (ISO/IEC 18004, tabela 5). A ordem E o valor. */
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

/** Tabelas de GF(2^8) com o polinomio primitivo 0x11D do QR (x^8+x^4+x^3+x^2+1). */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!
}

/**
 * Parametros por versao no nivel M. `dataCodewords` e o total de bytes de dados
 * da versao; `blocks` divide-os em partes IGUAIS (no nivel M, versoes 1-6, nao
 * existe grupo de tamanhos diferentes) e cada parte leva `ecPerBlock` bytes de
 * correccao. `alignment` e a coordenada do unico padrao de alinhamento (0 = a
 * versao 1 nao tem nenhum).
 */
interface VersionSpec {
  readonly version: number
  readonly dataCodewords: number
  readonly ecPerBlock: number
  readonly blocks: number
  readonly alignment: number
}

const SPECS: readonly VersionSpec[] = [
  { version: 1, dataCodewords: 16, ecPerBlock: 10, blocks: 1, alignment: 0 },
  { version: 2, dataCodewords: 28, ecPerBlock: 16, blocks: 1, alignment: 18 },
  { version: 3, dataCodewords: 44, ecPerBlock: 26, blocks: 1, alignment: 22 },
  { version: 4, dataCodewords: 64, ecPerBlock: 18, blocks: 2, alignment: 26 },
  { version: 5, dataCodewords: 86, ecPerBlock: 24, blocks: 2, alignment: 30 },
  { version: 6, dataCodewords: 108, ecPerBlock: 16, blocks: 4, alignment: 34 },
]

/** Matriz de modulos. `dark[y * size + x] === 1` e um modulo escuro. */
export interface QrMatrix {
  readonly size: number
  readonly version: number
  readonly dark: Uint8Array
}

/** Falha de codificacao. Fail loud: nada de QR truncado, que nao le. */
export class QrEncodeError extends Error {
  override readonly name = 'QrEncodeError'
}

class BitBuffer {
  readonly bits: number[] = []
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }
}

function isAlphanumeric(text: string): boolean {
  for (const ch of text) if (!ALPHANUMERIC.includes(ch)) return false
  return text.length > 0
}

/** Bits do segmento, sem cabecalho: 11 por par alfanumerico, 8 por byte. */
function payloadBits(text: string, alnum: boolean): number {
  if (alnum) return 11 * Math.floor(text.length / 2) + 6 * (text.length % 2)
  return 8 * Buffer.byteLength(text, 'utf8')
}

/** Escreve modo + contagem + dados. Contagem: 9 bits (alnum) ou 8 (byte) ate a versao 9. */
function writeSegment(buffer: BitBuffer, text: string, alnum: boolean): void {
  if (alnum) {
    buffer.push(0b0010, 4)
    buffer.push(text.length, 9)
    for (let i = 0; i + 1 < text.length; i += 2) {
      buffer.push(ALPHANUMERIC.indexOf(text[i]!) * 45 + ALPHANUMERIC.indexOf(text[i + 1]!), 11)
    }
    if (text.length % 2 === 1) buffer.push(ALPHANUMERIC.indexOf(text[text.length - 1]!), 6)
    return
  }
  const bytes = Buffer.from(text, 'utf8')
  buffer.push(0b0100, 4)
  buffer.push(bytes.length, 8)
  for (const byte of bytes) buffer.push(byte, 8)
}

/** Bits -> codewords de dados, com terminador, alinhamento a byte e enchimento. */
function toDataCodewords(buffer: BitBuffer, spec: VersionSpec): Uint8Array {
  const capacity = spec.dataCodewords * 8
  const bits = buffer.bits
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const codewords = new Uint8Array(spec.dataCodewords)
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i + b]!
    codewords[i / 8] = byte
  }
  // Bytes de enchimento alternados 0xEC/0x11 (ISO/IEC 18004, 8.4.9).
  for (let i = bits.length / 8; i < spec.dataCodewords; i += 1) {
    codewords[i] = (i - bits.length / 8) % 2 === 0 ? 0xec : 0x11
  }
  return codewords
}

/** Resto da divisao do bloco pelo polinomio gerador de grau `ecLen`. */
function reedSolomon(block: Uint8Array, ecLen: number): Uint8Array {
  const generator = new Uint8Array(ecLen + 1)
  generator[0] = 1
  for (let i = 0; i < ecLen; i += 1) {
    for (let j = i + 1; j > 0; j -= 1) generator[j] = generator[j - 1]! ^ gfMul(generator[j]!, GF_EXP[i]!)
    generator[0] = gfMul(generator[0]!, GF_EXP[i]!)
  }
  const remainder = new Uint8Array(ecLen)
  for (const byte of block) {
    const factor = byte ^ remainder[0]!
    remainder.copyWithin(0, 1)
    remainder[ecLen - 1] = 0
    for (let j = 0; j < ecLen; j += 1) remainder[j] = remainder[j]! ^ gfMul(generator[ecLen - 1 - j]!, factor)
  }
  return remainder
}

/** Intercala os blocos de dados e depois os de correccao (ISO/IEC 18004, 8.6). */
function interleave(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const perBlock = spec.dataCodewords / spec.blocks
  const ecBlocks: Uint8Array[] = []
  for (let b = 0; b < spec.blocks; b += 1) {
    ecBlocks.push(reedSolomon(data.subarray(b * perBlock, (b + 1) * perBlock), spec.ecPerBlock))
  }
  const out = new Uint8Array(spec.dataCodewords + spec.blocks * spec.ecPerBlock)
  let k = 0
  for (let i = 0; i < perBlock; i += 1) {
    for (let b = 0; b < spec.blocks; b += 1) out[k++] = data[b * perBlock + i]!
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (let b = 0; b < spec.blocks; b += 1) out[k++] = ecBlocks[b]![i]!
  }
  return out
}

interface Canvas {
  readonly size: number
  readonly dark: Uint8Array
  readonly fixed: Uint8Array
}

function place(canvas: Canvas, y: number, x: number, value: number): void {
  canvas.dark[y * canvas.size + x] = value
  canvas.fixed[y * canvas.size + x] = 1
}

/** Localizadores, separadores, temporizadores, alinhamento, modulo escuro e reservas. */
function functionPatterns(spec: VersionSpec): Canvas {
  const size = spec.version * 4 + 17
  const canvas: Canvas = { size, dark: new Uint8Array(size * size), fixed: new Uint8Array(size * size) }
  for (const [oy, ox] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const y = oy + dy
        const x = ox + dx
        if (y < 0 || x < 0 || y >= size || x >= size) continue
        const ring = Math.max(Math.abs(dy - 3), Math.abs(dx - 3))
        place(canvas, y, x, ring === 2 || ring > 3 ? 0 : 1)
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    place(canvas, 6, i, i % 2 === 0 ? 1 : 0)
    place(canvas, i, 6, i % 2 === 0 ? 1 : 0)
  }
  if (spec.alignment > 0) {
    const c = spec.alignment
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        place(canvas, c + dy, c + dx, Math.max(Math.abs(dy), Math.abs(dx)) === 1 ? 0 : 1)
      }
    }
  }
  place(canvas, size - 8, 8, 1)
  for (let i = 0; i <= 8; i += 1) {
    if (canvas.fixed[8 * size + i] === 0) place(canvas, 8, i, 0)
    if (canvas.fixed[i * size + 8] === 0) place(canvas, i, 8, 0)
  }
  for (let i = 0; i < 8; i += 1) {
    if (canvas.fixed[8 * size + (size - 1 - i)] === 0) place(canvas, 8, size - 1 - i, 0)
    if (canvas.fixed[(size - 1 - i) * size + 8] === 0) place(canvas, size - 1 - i, 8, 0)
  }
  return canvas
}

/** Zigue-zague de baixo para cima, duas colunas de cada vez, saltando a coluna 6. */
function placeCodewords(canvas: Canvas, codewords: Uint8Array): void {
  const size = canvas.size
  let bit = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right <= 6 ? right - 1 : right
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step
      for (const x of [col, col - 1]) {
        if (canvas.fixed[y * size + x] === 1) continue
        const byte = codewords[bit >>> 3]
        canvas.dark[y * size + x] = byte === undefined ? 0 : (byte >>> (7 - (bit & 7))) & 1
        bit += 1
      }
    }
    upward = !upward
  }
}

const MASKS: ReadonlyArray<(y: number, x: number) => boolean> = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
]

/** Informacao de formato: 5 bits (nivel M = 00 + mascara) com BCH(15,5) e XOR 0x5412. */
function formatBits(mask: number): number {
  const data = 0b00_000 | mask
  let rest = data << 10
  for (let i = 14; i >= 10; i -= 1) if ((rest >>> i) & 1) rest ^= 0b101_0011_0111 << (i - 10)
  return ((data << 10) | rest) ^ 0b101_0100_0001_0010
}

function writeFormat(canvas: Canvas, mask: number): void {
  const size = canvas.size
  const bits = formatBits(mask)
  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >>> i) & 1
    // Copia 1: desce a coluna 8 ate a linha 8 e depois corre para a esquerda,
    // em volta do localizador superior esquerdo (ISO/IEC 18004, 8.9).
    const row = i < 6 ? i : i < 8 ? i + 1 : 8
    const col = i < 8 ? 8 : i === 8 ? 7 : 14 - i
    canvas.dark[row * size + col] = bit
    // Copia 2: os 8 primeiros bits correm a linha 8 da direita para a esquerda;
    // os 7 ultimos sobem a coluna 8 desde o fundo. O modulo sempre escuro fica
    // uma linha abaixo desses sete e por isso nao e tocado aqui.
    if (i < 8) canvas.dark[8 * size + (size - 1 - i)] = bit
    else canvas.dark[(size - 15 + i) * size + 8] = bit
  }
}

/**
 * Comprimentos de sequencia de uma linha ou coluna.
 *
 * Uma linha que COMECA escura recebe uma sentinela `-1` a frente. E isso que
 * torna "indice impar" sinonimo de "sequencia escura" na regra N3 abaixo, sem
 * ter de carregar a cor a par do comprimento.
 */
function runLengths(size: number, at: (i: number) => number): number[] {
  const runs: number[] = at(0) === 1 ? [-1, 1] : [1]
  let previous = at(0)
  for (let i = 1; i < size; i += 1) {
    const current = at(i)
    if (current === previous) runs[runs.length - 1]! += 1
    else {
      runs.push(1)
      previous = current
    }
  }
  return runs
}

/**
 * N1 (sequencia de 5 ou mais modulos da mesma cor) e N3 (o padrao 1:1:3:1:1 do
 * localizador com 4 modulos claros de um dos lados), do ISO/IEC 18004 8.8.2.
 *
 * N3 E POR RAZAO, NAO POR JANELA DE 11 MODULOS: a norma escreve o padrao como
 * uma RAZAO, e por isso ele conta em qualquer escala (2:2:6:2:2 tambem confunde
 * o leitor, que procura o localizador por proporcao). Esta e a leitura da
 * `libqrencode`, contra a qual `test/unit/secret/qr.test.ts` compara bit a bit.
 */
function calcN1N3(runs: readonly number[]): number {
  let demerit = 0
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!
    if (run >= 5) demerit += 3 + (run - 5)
    if ((i & 1) === 0 || i < 3 || i >= runs.length - 2 || run % 3 !== 0) continue
    const fact = run / 3
    if (runs[i - 2] !== fact || runs[i - 1] !== fact || runs[i + 1] !== fact || runs[i + 2] !== fact) continue
    if (i === 3 || runs[i - 3]! >= 4 * fact) demerit += 40
    else if (i + 4 >= runs.length || runs[i + 3]! >= 4 * fact) demerit += 40
  }
  return demerit
}

/** Demerito total da matriz ja mascarada e com a informacao de formato escrita. */
function penalty(canvas: Canvas): number {
  const size = canvas.size
  const at = (y: number, x: number): number => canvas.dark[y * size + x]!
  let demerit = 0
  let dark = 0
  for (let y = 1; y < size; y += 1) {
    for (let x = 1; x < size; x += 1) {
      const v = at(y, x)
      // N2: cada quadrado 2x2 de cor uniforme.
      if (v === at(y - 1, x) && v === at(y, x - 1) && v === at(y - 1, x - 1)) demerit += 3
    }
  }
  for (let i = 0; i < size; i += 1) {
    demerit += calcN1N3(runLengths(size, (j) => at(i, j)))
    demerit += calcN1N3(runLengths(size, (j) => at(j, i)))
    for (let j = 0; j < size; j += 1) dark += at(i, j)
  }
  // N4: desvio da proporcao de escuros em relacao a 50%, em degraus de 5 pontos.
  // A percentagem e ARREDONDADA (nao truncada) antes do degrau, que e o que a
  // implementacao de referencia faz e o que a norma descreve.
  const total = size * size
  const ratio = Math.trunc(Math.trunc((200 * dark + total) / total) / 2)
  return demerit + Math.trunc(Math.abs(ratio - 50) / 5) * 10
}

/** Codifica `text` num QR de nivel M. Lanca se nao couber na versao 6. */
export function encodeQr(text: string): QrMatrix {
  const alnum = isAlphanumeric(text)
  const headerBits = alnum ? 4 + 9 : 4 + 8
  const needed = headerBits + payloadBits(text, alnum)
  const spec = SPECS.find((candidate) => needed <= candidate.dataCodewords * 8)
  if (spec === undefined) {
    throw new QrEncodeError(
      `entrada de ${text.length} caracteres nao cabe num QR nivel M versao 6 (${needed} bits > ${SPECS[5]!.dataCodewords * 8})`,
    )
  }
  const buffer = new BitBuffer()
  writeSegment(buffer, text, alnum)
  const codewords = interleave(toDataCodewords(buffer, spec), spec)

  let best: Canvas | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const canvas = functionPatterns(spec)
    placeCodewords(canvas, codewords)
    const shouldFlip = MASKS[mask]!
    for (let y = 0; y < canvas.size; y += 1) {
      for (let x = 0; x < canvas.size; x += 1) {
        if (canvas.fixed[y * canvas.size + x] === 0 && shouldFlip(y, x)) {
          canvas.dark[y * canvas.size + x]! ^= 1
        }
      }
    }
    writeFormat(canvas, mask)
    const score = penalty(canvas)
    if (score < bestScore) {
      bestScore = score
      best = canvas
    }
  }
  const chosen = best!
  return { size: chosen.size, version: spec.version, dark: chosen.dark }
}
