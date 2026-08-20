/**
 * `worker/lib/outbox.ts` — TG-048 (4096) e TG-049 (1 msg/s por chat).
 *
 * O espacamento e medido com {@link FakeTime}: os instantes de envio sao
 * IGUALDADES (0, 1000, 2000), nao tolerancias. Nenhum teste deste ficheiro
 * espera tempo real.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createOutbox,
  DEFAULT_MIN_INTERVAL_MS,
  splitMessageText,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  truncateMessageText,
} from '../../../../worker/lib/outbox.ts'
import { captureLog, FakeTime } from './apoio.ts'

/** No-op ao nivel do modulo: evita uma arrow aninhada que nao captura nada. */
const NADA = (): void => undefined

/**
 * `true` se a string contiver um substituto SOLTO — meia unidade de um par.
 *
 * Verificacao melhor do que `% 2 === 0` sobre o comprimento, que passa
 * trivialmente em qualquer string de emojis alinhada e por isso nao consegue
 * falhar quando o recuo e apagado.
 */
function temSubstitutoSolto(texto: string): boolean {
  for (let i = 0; i < texto.length; i += 1) {
    const code = texto.charCodeAt(i)
    const alto = code >= 0xd8_00 && code <= 0xdb_ff
    const baixo = code >= 0xdc_00 && code <= 0xdf_ff
    if (alto) {
      const seguinte = i + 1 < texto.length ? texto.charCodeAt(i + 1) : 0
      if (!(seguinte >= 0xdc_00 && seguinte <= 0xdf_ff)) return true
      i += 1
    } else if (baixo) {
      return true
    }
  }
  return false
}

interface Envio {
  readonly chat: number
  readonly text: string
  readonly at: number
}

function bancada(opcoes: { minIntervalMs?: number; maxLength?: number; falharEm?: number } = {}) {
  const time = new FakeTime()
  const log = captureLog()
  const envios: Envio[] = []
  let n = 0

  const outbox = createOutbox(
    async (chat, text) => {
      n += 1
      if (opcoes.falharEm === n) throw new Error(`falha guionada no envio ${n}`)
      envios.push({ chat, text, at: time.now() })
      return Promise.resolve(true)
    },
    {
      time,
      log: log.logger,
      ...(opcoes.minIntervalMs === undefined ? {} : { minIntervalMs: opcoes.minIntervalMs }),
      ...(opcoes.maxLength === undefined ? {} : { maxLength: opcoes.maxLength }),
    },
  )

  return { time, log, envios, outbox }
}

describe('worker/lib/outbox — TG-048: 4096 caracteres', () => {
  it('o limite documentado e 4096', () => {
    assert.equal(TELEGRAM_MESSAGE_MAX_LENGTH, 4096)
  })

  it('texto no limite exato passa inteiro, sem particionar', () => {
    const texto = 'x'.repeat(4096)
    assert.deepEqual(splitMessageText(texto), [texto])
  })

  it('texto acima do limite e particionado, e NENHUM pedaco excede o limite', () => {
    const texto = 'y'.repeat(10_000)
    const pedacos = splitMessageText(texto)
    assert.ok(pedacos.length >= 3)
    for (const pedaco of pedacos) {
      assert.ok(pedaco.length <= 4096, `pedaco com ${pedaco.length} caracteres`)
    }
  })

  it('particionar NAO perde um caracter: a concatenacao e identica ao original', () => {
    const texto = `${'a'.repeat(5000)}\n${'b'.repeat(5000)} ${'c'.repeat(200)}`
    assert.equal(splitMessageText(texto).join(''), texto)
  })

  it('corta de preferencia na quebra de linha, e so depois no espaco', () => {
    const linha = `${'a'.repeat(4000)}\n${'b'.repeat(4000)}`
    const pedacos = splitMessageText(linha)
    assert.equal(pedacos[0], `${'a'.repeat(4000)}\n`, 'cortou na quebra de linha')

    const frase = `${'a'.repeat(4000)} ${'b'.repeat(4000)}`
    assert.equal(splitMessageText(frase)[0], `${'a'.repeat(4000)} `, 'cortou no espaco')
  })

  it('emoji alinhado: o limite cai numa fronteira LIMPA e nao ha nada a recuar', () => {
    // 2048 emojis = 4096 unidades UTF-16. `charCodeAt(4095)` e a metade BAIXA de
    // um par, portanto o ramo de recuo NAO e entrado — este caso mede o corte
    // alinhado, e so isso. O caso que exercita o recuo e o seguinte.
    const texto = '😀'.repeat(2049)
    const pedacos = splitMessageText(texto)
    assert.equal(pedacos.join(''), texto, 'nada se perde')
    assert.equal(pedacos[0]?.length, 4096, 'coube exatamente, sem recuo')
    for (const pedaco of pedacos) {
      assert.equal(temSubstitutoSolto(pedaco), false)
    }
  })

  it('ACHADO 4: o corte duro cai EM CIMA de um par substituto, e recua um', () => {
    // O 'A' inicial desalinha tudo: `charCodeAt(4095)` passa a ser a metade
    // ALTA do emoji 2048. Sem o recuo, o primeiro pedaco acaba num substituto
    // SOLTO — meio caracter, que o cliente do Telegram mostra como `�`.
    const texto = `A${'😀'.repeat(2049)}`
    assert.equal(
      texto.charCodeAt(4095) >= 0xd8_00 && texto.charCodeAt(4095) <= 0xdb_ff,
      true,
      'pre-condicao do caso: o limite cai numa metade ALTA',
    )

    const pedacos = splitMessageText(texto)

    assert.equal(pedacos.join(''), texto, 'nada se perde')
    assert.equal(pedacos[0]?.length, 4095, 'recuou UM: 4096 partiria o par ao meio')
    for (const pedaco of pedacos) {
      assert.ok(pedaco.length <= 4096)
      assert.equal(
        temSubstitutoSolto(pedaco),
        false,
        'nenhum pedaco acaba (nem comeca) com meio par substituto',
      )
    }
  })

  it('a mensagem particionada sai em varios envios, e o texto original e recuperavel', async () => {
    const b = bancada({ maxLength: 10, minIntervalMs: 0 })
    await b.outbox.send(42, 'abcdefghijklmnopqrstuvwxyz')
    assert.equal(b.envios.length, 3)
    assert.equal(b.envios.map((e) => e.text).join(''), 'abcdefghijklmnopqrstuvwxyz')
    for (const envio of b.envios) assert.ok(envio.text.length <= 10)
  })

  it('nada estoura na API: o corte acontece ANTES do envio', async () => {
    const b = bancada({ minIntervalMs: 0 })
    await b.outbox.send(7, 'z'.repeat(9000))
    assert.ok(b.envios.length > 1)
    for (const envio of b.envios) {
      assert.ok(envio.text.length <= TELEGRAM_MESSAGE_MAX_LENGTH)
    }
  })

  it('truncar tambem respeita o limite — marcador incluido', () => {
    const cortado = truncateMessageText('w'.repeat(9000), 100)
    assert.equal(cortado.length, 100)
    assert.ok(cortado.endsWith('…'))
    assert.equal(truncateMessageText('curto', 100), 'curto')
  })

  it('texto vazio nao vira uma chamada a API com text vazio', async () => {
    const b = bancada({ minIntervalMs: 0 })
    await assert.rejects(() => b.outbox.send(1, ''), /MESSAGE_EMPTY/u)
    assert.equal(b.envios.length, 0)
  })
})

describe('worker/lib/outbox — TG-049: 1 mensagem/segundo por chat', () => {
  it('o intervalo por omissao e de um segundo', () => {
    assert.equal(DEFAULT_MIN_INTERVAL_MS, 1000)
  })

  it('tres mensagens para o MESMO chat saem a 0, 1000 e 2000 no relogio injetado', async () => {
    const b = bancada()

    await Promise.all([b.outbox.send(555, 'um'), b.outbox.send(555, 'dois'), b.outbox.send(555, 'tres')])

    assert.deepEqual(
      b.envios.map((e) => e.at),
      [0, 1000, 2000],
      'o emissor SERIALIZA e espaca; nao ha rajada',
    )
    assert.deepEqual(
      b.envios.map((e) => e.text),
      ['um', 'dois', 'tres'],
      'e a ordem e preservada',
    )
    assert.deepEqual(b.time.sleeps, [1000, 1000])
  })

  it('os pedacos de UMA mensagem grande tambem sao espacados entre si', async () => {
    const b = bancada({ maxLength: 5 })
    await b.outbox.send(9, 'aaaaabbbbbccccc')
    assert.deepEqual(
      b.envios.map((e) => e.at),
      [0, 1000, 2000],
    )
  })

  it('o tempo JA gasto conta: se o envio demorou 700 ms, so se esperam 300', async () => {
    const b = bancada()
    await b.outbox.send(1, 'primeira')
    b.time.advance(700)
    await b.outbox.send(1, 'segunda')
    assert.deepEqual(b.time.sleeps, [300], 'espera o que falta, nao o intervalo inteiro')
    assert.deepEqual(
      b.envios.map((e) => e.at),
      [0, 1000],
    )
  })

  it('CHATS DIFERENTES nao esperam um pelo outro: o limite e por chat, nao global', async () => {
    const b = bancada()
    await Promise.all([b.outbox.send(1, 'para A'), b.outbox.send(2, 'para B')])
    assert.deepEqual(
      b.envios.map((e) => e.at),
      [0, 0],
      'uma fila unica transformaria o limite por chat num limite global',
    )
    assert.deepEqual(b.time.sleeps, [])
  })

  it('ACHADO 5: as filas sao mesmo INDEPENDENTES — um chat pendurado nao trava o outro', async () => {
    // Os carimbos `[0, 0]` do teste anterior NAO provam independencia: com uma
    // fila global eles sairiam iguais na mesma, porque o espacamento vem do
    // mapa `lastSentAt`, que ja e por chat. O que prova e CONCORRENCIA — deixar
    // um chat pendurado e ver o outro completar.
    const time = new FakeTime()
    const envios: number[] = []
    let libertarA: () => void = NADA
    const presoA = new Promise<void>((resolve) => {
      libertarA = resolve
    })

    const outbox = createOutbox(
      async (chat) => {
        if (chat === 1) await presoA
        envios.push(chat)
        return Promise.resolve(true)
      },
      { time },
    )

    const a = outbox.send(1, 'fica preso')
    const bPromise = outbox.send(2, 'tem de passar')

    let bTerminou = false
    void (async (): Promise<void> => {
      await bPromise
      bTerminou = true
    })()

    // Cede o turno varias vezes SEM avancar o relogio real: com filas por chat,
    // B completa em poucos microtasks; com fila global, fica preso atras de A
    // para sempre e este `assert` falha.
    for (let i = 0; i < 50; i += 1) await Promise.resolve()

    assert.equal(bTerminou, true, 'uma fila GLOBAL deixaria B preso atras de A indefinidamente')
    assert.deepEqual(envios, [2], 'so B saiu; A continua pendurado')

    libertarA()
    await Promise.all([a, bPromise])
    assert.deepEqual(envios, [2, 1], 'e A completa quando o envio dele resolve')
  })

  it('um envio falhado NAO encrava o chat, e a falha CHEGA a quem chamou', async () => {
    const b = bancada({ falharEm: 1, minIntervalMs: 0 })
    await assert.rejects(() => b.outbox.send(3, 'vai falhar'), /falha guionada/u)
    // A fila continua utilizavel a seguir — se a cauda propagasse o erro, este
    // segundo envio nunca aconteceria.
    await b.outbox.send(3, 'segue')
    assert.deepEqual(
      b.envios.map((e) => e.text),
      ['segue'],
    )
  })

  it('drain espera o que estiver em fila', async () => {
    const b = bancada()
    const pendentes = [b.outbox.send(4, 'a'), b.outbox.send(4, 'b')]
    await b.outbox.drain()
    assert.equal(b.envios.length, 2)
    await Promise.all(pendentes)
  })
})
