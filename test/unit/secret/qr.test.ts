/**
 * `src/secret/qr.ts` -- o codificador de QR contra a implementacao de
 * REFERENCIA, bit a bit.
 *
 * PORQUE VECTORES DE OURO E NAO SO PROPRIEDADES: um QR "quase certo" nao le.
 * Uma suite que verificasse apenas estrutura (localizadores no sitio, tamanho
 * certo, temporizadores a alternar) passaria com a tabela de correccao de erros
 * trocada, com o zigue-zague ao contrario ou com a intercalacao de blocos
 * errada -- e o defeito so aparecia com uma camara na mao. Estes 23 vectores sao
 * a matriz produzida pela `libqrencode` 4.1.1, a biblioteca C do utilitario
 * `qrencode`.
 *
 * PROVENIENCIA, para quem tiver de os regerar (nivel M, versao automatica,
 * `hint = QR_MODE_8`, `casesensitive = 1`):
 *
 *   python3 - <<'EOF'
 *   import ctypes, ctypes.util, hashlib
 *   lib = ctypes.CDLL(ctypes.util.find_library('qrencode'))
 *   class QRcode(ctypes.Structure):
 *       _fields_ = [('version', ctypes.c_int), ('width', ctypes.c_int),
 *                   ('data', ctypes.POINTER(ctypes.c_ubyte))]
 *   lib.QRcode_encodeString.restype = ctypes.POINTER(QRcode)
 *   lib.QRcode_encodeString.argtypes = [ctypes.c_char_p] + [ctypes.c_int] * 4
 *   qr = lib.QRcode_encodeString(TEXTO.encode(), 0, 1, 2, 1)
 *   w = qr.contents.width
 *   rows = [''.join('#' if (qr.contents.data[y * w + x] & 1) else '.'
 *                   for x in range(w)) for y in range(w)]
 *   print(qr.contents.version, hashlib.sha256('\n'.join(rows).encode()).hexdigest())
 *   EOF
 *
 * OS COMPRIMENTOS NAO SAO AO ACASO: cada par consecutivo cerca uma fronteira de
 * capacidade (20/21, 38/39, 61/62, 90/91, 122/123 em alfanumerico; 14/15,
 * 26/27, 42/43, 62/63, 84/85 em byte). Um numero trocado na tabela de versoes
 * faria a versao saltar e o vector do lado de la falhava.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { renderQrAscii } from '../../../src/secret/generate.ts'
import { encodeQr, QrEncodeError } from '../../../src/secret/qr.ts'

/** `[texto, versao esperada, sha256 das linhas da matriz unidas por \n]`. */
const VECTORS: ReadonlyArray<readonly [string, number, string]> = [
  ['7P335YE2MYV62EVZ32CT', 1, 'd64c3cf4a8a653eb262c8ba809697d31d759035ed12503a1c7792e3cd5a138c2'],
  ['3TSDESDUR3LNLSJBSSN2H', 2, '4f71d025c0f44225d767dc0bf1c8fee3bd2c4f0fde34ddbb8f0400c41f73f543'],
  ['YUAFDZC7AB4TMG7CXJ26Q34CAQVB27QL4NKZLE', 2, '1b2ffa22a2414a15395a026833f3affd7b91c53bf3a67fa92d166807203e8781'],
  ['3CILSERVE4DY43ILC3MYYWOBNV6P3U5HXCNGTFW', 3, '6957d2717a72d2f56a2e3725bbcfaa47d944e4213fb49f58f9a33bc50dee3ccc'],
  ['XSDSFMOFB7ITWONTX7YOLLI6QIBFMNLGWK532HOFGQFVJKO4DX7A', 3, 'cc209abe9194e76dfbbb8455988124fb9c9f9d3eec62adf111eaa9b1a304b0d0'],
  ['ZOP4VM32Y4SZSW4O4225K2LHF26GN4LPTEZDWMGHHWADKTYB4KQBVRVUIVYS6', 3, 'b37a092d37517bf1fe068b2841af06b1c61d523b050edb9f4598f4464d0d3148'],
  ['5MCDDZNQIFBIJN3GD3DZWGJRPV6B6SZJIH6YHL7QHGS7DIDLZJYWSTAGMRDDOT', 4, '98ff4fe921781b0c9db73095e306a33d1f3490507aec60de018f97ba2cc320c3'],
  ['E2KMGCRBIAPAQ7XUYDKO53VQV525MASG7LBTZ55LDAL2MSCDXAPF6YPODRRJHBLTEOPUAU6H5IPAGOC4SR6KI2XXJ6', 4, 'd53c731787b751b797b3a99b635e78b54d7ca01f1f3bc307b3117ce4e8c3cbc9'],
  ['774Q6RXNWKVZ6NEAEVMVITURQ5FYN4X2KGAKEACEIC6H544MNRSQ6E6O6HCEHLZXSGCR45SBUI42WUNFNUCUA4XRXSB', 5, 'd01f53f7bcc4c96c1abd5faddca35cbeddf9449547f1737cb31079131540ec13'],
  ['JMHYVOGPO2HPZ3524DQMGMHDT5XJ277RV3IXOQOYQBVAXF5A66Z5KTE6GGTEARB2U75ZCFXTRJQNKPHG65XQ4O5KEVVMYZNS7EG6XCOAFM4NE55OEJ3U33ZV3L', 5, 'f8dfaa357400d21e547b18d0aea409e7f9be7e678cff43b4c1cc6584edd29905'],
  ['IIT5IYPLHQD634B2OTAYSDO6XYECJABHMH5AZXO7IC4HRHZICAIQIXW6FC474WIG23VGRMFSTOZLB7AOJQAFWRKNEVTDGQPUIYRC7CX3E5HF6A27AMUGJHA3DFA', 6, '1d92c4df76d0be70439804bfed3a28127afa88497269de7393a69f8e55508c72'],
  ['M5TZWMXYBBEK3OWAVXCAIQDKLUX3Q6WLN3B7F5YDE7W5DI7NJVVOPVCS26UR5VUOPB7RXBWW5IQSZJ5F3AZH5JUOWYHMPHQPLJTFK3VKWXOVHJFVIG772L6DCKPZWN6UYELCXNYGG444QIBXHEPLCI5N2B', 6, '57be81341e722c7a6fb9618cd844a7b0ee7874774f0e19003f50c756e5f800d2'],
  ['bnjtewwhytohkf', 1, '5ef189734daea2442d77acb77306f0d7f21550d929c054377c1333e7b959e256'],
  ['aguphztogitqjke', 2, '0752579ff2d7d046eb10417338f0152d66c3c8fc1a76f1759fe43a8cbfe91648'],
  ['glfvubslolpkdnvemryuwbwneh', 2, '0bbe8418adacbe8c3602fcbabf6049ac1f09920a3aee4946713881411573e1c0'],
  ['zcsibteyrbirzrgiealdlagtmsb', 3, '7154002963e0567ce1511575668f38d91f31a02393c79f40bc38da0d5a94e355'],
  ['hwhwypjjctssgtsxuozzrjgksutawfpiedijfditzi', 3, 'e694dd8760741e6a7390b0151d61298678df20ab94c7e3878e470b31ebca8cab'],
  ['aacxfpfzlzmqfqrpslimxjirzmcegkcukglbcfdxxxo', 4, 'dbf4214068d05e9a6c7d3938cd1d326e7f58292a80551b4299cf57d363a5ef91'],
  ['gkdpywgfltnsnmhlywrfprxhdqpwkkuohagzdsbtemsxizbnfuigaarwuclxll', 4, '0075a76a85f45e35dc681955bf9cc1b07db432aa17ebbe626748df4b46f2085b'],
  ['ikqbcyzeojsgmgtszwspturxqecetkkfucmjooleapwasfiwpcglojzgrdybydu', 5, '3caccaed7f490ea82a0ddded13f4e483dabf0afad8b3b36b432f9ce57ecc15e6'],
  ['gnbclqkfvewtenlftstcefxlnydpekrgrrazyrmtylbfgqqrengsxmadyzfjksyocdbmtppnotpogzhkqthx', 5, '4c30b20cb0a0d0b45e3d3641e4e3a17692ef80342e4affbb6db3551abeb58968'],
  ['ozlwpxxualoqjixngfrygsomxczfgujjwdxwquddxgysifoankksljdfgapwkdsnzujrvvtktikumeeyqcxaq', 6, '470ed559d739153577bf320af5c422104e59a639fe1640fecc81e78f79aa5e9c'],
  ['gmzouzhglitweqrnylmvabpmbimsnnjcgimnuxnrphtluckgldtpcrnfjzsfrndncmujsrjiypivvlaeowupkhuubcsrwqxyobmfkkazon', 6, '1364d2454b542579ab8c3da1073b99b52093a57f116f6ee4a0f12536bd88fd07'],
]

/** A matriz em texto, na mesma serializacao que a referencia usa. */
function serialize(text: string): string {
  const qr = encodeQr(text)
  const lines: string[] = []
  for (let y = 0; y < qr.size; y += 1) {
    let line = ''
    for (let x = 0; x < qr.size; x += 1) line += qr.dark[y * qr.size + x] === 1 ? '#' : '.'
    lines.push(line)
  }
  return lines.join('\n')
}

describe('encodeQr', () => {
  it('reproduz a libqrencode 4.1.1 bit a bit nos 23 vectores', () => {
    for (const [text, version, sha256] of VECTORS) {
      const qr = encodeQr(text)
      assert.equal(qr.version, version, `versao para ${text.length} caracteres`)
      assert.equal(qr.size, version * 4 + 17)
      const got = createHash('sha256').update(serialize(text)).digest('hex')
      assert.equal(got, sha256, `matriz de ${text.length} caracteres`)
    }
  })

  it('a matriz da versao 1 esta escrita por extenso, para se ver a olho', () => {
    assert.equal(serialize('bnjtewwhytohkf'), REFERENCE_V1.join('\n'))
    const qr = encodeQr('bnjtewwhytohkf')
    assert.equal(qr.dark[6 * qr.size + 8], 1, 'temporizador horizontal escuro na coluna 8')
    assert.equal(qr.dark[(qr.size - 8) * qr.size + 8], 1, 'modulo sempre escuro em (size-8, 8)')
  })

  it('escolhe alfanumerico quando pode e byte quando tem de ser', () => {
    // Os mesmos 52 caracteres: em maiusculas cabem na versao 3 (alfanumerico,
    // 5,5 bits/caractere), em minusculas obrigam a modo byte (8 bits) e saltam
    // para a versao 4 -- quatro modulos mais largos, de graca, so pela caixa.
    const alnum = 'XSDSFMOFB7ITWONTX7YOLLI6QIBFMNLGWK532HOFGQFVJKO4DX7A'
    assert.equal(encodeQr(alnum).version, 3)
    assert.equal(encodeQr(alnum.toLowerCase()).version, 4)
  })

  it('recusa o que nao cabe, em vez de truncar', () => {
    assert.throws(() => encodeQr('A'.repeat(155)), QrEncodeError)
    assert.throws(() => encodeQr('a'.repeat(107)), QrEncodeError)
    assert.doesNotThrow(() => encodeQr('A'.repeat(154)))
    assert.doesNotThrow(() => encodeQr('a'.repeat(106)))
  })
})

/** Le o desenho de volta a matriz: meio bloco em cima, meio em baixo. */
function parseDrawing(drawing: string, invert: boolean): (y: number, x: number) => boolean {
  const lines = drawing.split('\n')
  return (y: number, x: number): boolean => {
    const glyph = lines[Math.floor((y + 4) / 2)]![x + 4]!
    const top = glyph === ' ' || glyph === '▄'
    const bottom = glyph === ' ' || glyph === '▀'
    return ((y + 4) % 2 === 0 ? top : bottom) !== invert
  }
}

describe('renderQrAscii', () => {
  it('desenha exatamente a matriz, com moldura de 4 modulos', () => {
    const text = 'XSDSFMOFB7ITWONTX7YOLLI6QIBFMNLGWK532HOFGQFVJKO4DX7A'
    const qr = encodeQr(text)
    for (const invert of [false, true]) {
      const drawing = renderQrAscii(text, { invert })
      const lines = drawing.split('\n')
      assert.equal(lines.length, Math.ceil((qr.size + 8) / 2))
      assert.equal(lines[0]!.length, qr.size + 8)
      const read = parseDrawing(drawing, invert)
      for (let y = 0; y < qr.size; y += 1) {
        for (let x = 0; x < qr.size; x += 1) {
          assert.equal(read(y, x), qr.dark[y * qr.size + x] === 1, `modulo (${y},${x}) invert=${invert}`)
        }
      }
    }
  })

  it('a moldura clara existe nos quatro lados', () => {
    const lines = renderQrAscii('HELLO').split('\n')
    assert.ok(lines.every((line) => line.startsWith('████') && line.endsWith('████')))
    assert.ok([...lines[0]!].every((glyph) => glyph === '█'), 'a primeira linha e so moldura')
    assert.ok([...lines.at(-1)!].every((glyph) => glyph === '█'), 'a ultima tambem')
  })
})

/** Vector de ouro por extenso: `libqrencode` 4.1.1, nivel M, `bnjtewwhytohkf`. */
const REFERENCE_V1: readonly string[] = [
  '#######.#.#.#.#######',
  '#.....#.###...#.....#',
  '#.###.#.#...#.#.###.#',
  '#.###.#..##.#.#.###.#',
  '#.###.#.#####.#.###.#',
  '#.....#...###.#.....#',
  '#######.#.#.#.#######',
  '..........#..........',
  '#..###########..#.###',
  '.##.##.##.#......#...',
  '..#.#.###...#.#..#.##',
  '.#####..#....#.#..#.#',
  '...#.##..#.#....##.##',
  '........###..#.##..#.',
  '#######.#..##...#....',
  '#.....#.#...####.##..',
  '#.###.#.##.#.#.....#.',
  '#.###.#.##.#.#.#..#..',
  '#.###.#..##.###.#####',
  '#.....#..###..##.####',
  '#######.####.##.#....',
]
