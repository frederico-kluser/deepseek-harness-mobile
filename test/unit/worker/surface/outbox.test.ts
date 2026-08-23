/**
 * `worker/surface/outbox.ts` — PORTE NEUTRO de `worker/lib/outbox.ts`: TG-048
 * (particionar/cortar pelo limite do PROVEDOR) e TG-049 (1 msg/s por chat).
 *
 * O espacamento e medido com {@link FakeTime}: os instantes de envio sao
 * IGUALDADES (0, 1000, 2000), nao tolerancias. Nenhum teste espera tempo real.
 * A chave da fila e o `chatKey` (STRING, D4).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  criarOutbox,
  INTERVALO_MINIMO_PADRAO_MS,
  particionarTexto,
  truncarTexto,
  type SurfaceOutbox,
  type SendText,
} from '../../../../worker/surface/outbox.ts'
import type { SurfaceCommandLog } from '../../../../worker/surface/contract.ts'

/** Relogio + espera falsos: a espera ANDA com o relogio. Arranca em 0. */
class FakeTime {
  private current = 0
  readonly sleeps: number[] = []

  now(): number {
    return this.current
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    if (ms > 0) this.current += ms
    await Promise.resolve()
  }

  advance(ms: number): void {
    this.current += ms
  }
}

function capturarLog(): { readonly log: SurfaceCommandLog; readonly lines: string[] } {
  const lines: string[] = []
  const record = (level: string) => (message: string, fields?: Readonly<Record<string, unknown>>) => {
    const extra =
      fields === undefined
        ? ''
        : Object.entries(fields)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => ` ${k}=${String(v)}`)
            .join('')
    lines.push(`${level.toUpperCase()} ${message}${extra}`)
  }
  return {
    log: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    lines,
  }
}

interface Envio {
  readonly chat: string
  readonly text: string
  readonly at: number
}

function bancada(opcoes: { minIntervalMs?: number; maxLength?: number; falharEm?: number } = {}) {
  const time = new FakeTime()
  const log = capturarLog()
  const envios: Envio[] = []
  let n = 0

  const send: SendText = async (chat, text) => {
    n += 1
    if (opcoes.falharEm === n) throw new Error(`falha guionada no envio ${n}`)
    envios.push({ chat, text, at: time.now() })
    return Promise.resolve(true)
  }

  const outbox: SurfaceOutbox = criarOutbox(send, {
    time,
    log: log.log,
    ...(opcoes.minIntervalMs === undefined ? {} : { minIntervalMs: opcoes.minIntervalMs }),
    ...(opcoes.maxLength === undefined ? {} : { maxLength: opcoes.maxLength }),
  })

  return { time, log, envios, outbox }
}

const MAX = 4096

/** No-op ao nivel do modulo: evita uma arrow que nao captura nada. */
const NADA = (): void => undefined

describe('worker/surface/outbox — TG-048: o corte e NO NOSSO limite, antes do fio', () => {
  it('o intervalo por omissao e de um segundo (1 msg/s por chat)', () => {
    assert.equal(INTERVALO_MINIMO_PADRAO_MS, 1000)
  })

  it('texto no limite exato passa inteiro, sem particionar', () => {
    const texto = 'x'.repeat(MAX)
    assert.deepEqual(particionarTexto(texto, MAX), [texto])
  })

  it('texto acima do limite e particionado, e NENHUM pedaco excede o limite', () => {
    const texto = 'y'.repeat(10_000)
    const pedacos = particionarTexto(texto, MAX)
    assert.ok(pedacos.length >= 3)
    for (const pedaco of pedacos) assert.ok(pedaco.length <= MAX)
  })

  it('particionar NAO perde um caracter: a concatenacao e identica ao original', () => {
    const texto = `${'a'.repeat(5000)}\n${'b'.repeat(5000)} ${'c'.repeat(200)}`
    assert.equal(particionarTexto(texto, MAX).join(''), texto)
  })

  it('corta de preferencia na quebra de linha, e so depois no espaco', () => {
    const linha = `${'a'.repeat(4000)}\n${'b'.repeat(4000)}`
    assert.equal(particionarTexto(linha, MAX)[0], `${'a'.repeat(4000)}\n`, 'cortou na quebra de linha')

    const frase = `${'a'.repeat(4000)} ${'b'.repeat(4000)}`
    assert.equal(particionarTexto(frase, MAX)[0], `${'a'.repeat(4000)} `, 'cortou no espaco')
  })

  it('emoji alinhado: o limite cai numa fronteira LIMPA, sem recuo', () => {
    const texto = '😀'.repeat(2049)
    const pedacos = particionarTexto(texto, MAX)
    assert.equal(pedacos.join(''), texto)
    assert.equal(pedacos[0]?.length, MAX, 'coube exatamente, sem recuo')
    for (const pedaco of pedacos) assert.equal(temSubstitutoSolto(pedaco), false)
  })

  it('corte duro em cima de um par substituto: recua um (sem meio-caracter)', () => {
    const texto = `A${'😀'.repeat(2049)}` // o 'A' desalinha o limite para uma metade ALTA
    assert.equal(
      texto.charCodeAt(MAX - 1) >= 0xd8_00 && texto.charCodeAt(MAX - 1) <= 0xdb_ff,
      true,
      'pre-condicao: o limite cai numa metade ALTA',
    )
    const pedacos = particionarTexto(texto, MAX)
    assert.equal(pedacos.join(''), texto)
    assert.equal(pedacos[0]?.length, MAX - 1, 'recuou um: 4096 partiria o par ao meio')
    for (const pedaco of pedacos) assert.equal(temSubstitutoSolto(pedaco), false)
  })

  it('a mensagem particionada sai em varios envios, e o texto original e recuperavel', async () => {
    const b = bancada({ maxLength: 10, minIntervalMs: 0 })
    await b.outbox.send('c1', 'abcdefghijklmnopqrstuvwxyz')
    assert.equal(b.envios.length, 3)
    assert.equal(b.envios.map((e) => e.text).join(''), 'abcdefghijklmnopqrstuvwxyz')
    for (const envio of b.envios) assert.ok(envio.text.length <= 10)
  })

  it('nada estoura na API: o corte acontece ANTES do envio', async () => {
    const b = bancada({ minIntervalMs: 0 })
    await b.outbox.send('c2', 'z'.repeat(9000))
    assert.ok(b.envios.length > 1)
    for (const envio of b.envios) assert.ok(envio.text.length <= MAX)
  })

  it('truncar tambem respeita o limite — marcador incluido', () => {
    const cortado = truncarTexto('w'.repeat(9000), 100)
    assert.equal(cortado.length, 100)
    assert.ok(cortado.endsWith('…'))
    assert.equal(truncarTexto('curto', 100), 'curto')
  })

  it('texto vazio nao vira uma chamada ao canal com text vazio', async () => {
    const b = bancada({ minIntervalMs: 0 })
    await assert.rejects(() => b.outbox.send('c3', ''), /sem texto/u)
    assert.equal(b.envios.length, 0)
  })
})

describe('worker/surface/outbox — TG-049: 1 mensagem/segundo POR CHAT', () => {
  it('tres mensagens para o MESMO chat saem a 0, 1000 e 2000 no relogio injetado', async () => {
    const b = bancada()
    await Promise.all([b.outbox.send('555', 'um'), b.outbox.send('555', 'dois'), b.outbox.send('555', 'tres')])

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
    await b.outbox.send('9', 'aaaaabbbbbccccc')
    assert.deepEqual(b.envios.map((e) => e.at), [0, 1000, 2000])
  })

  it('o tempo JA gasto conta: se o envio demorou 700 ms, so se esperam 300', async () => {
    const b = bancada()
    await b.outbox.send('1', 'primeira')
    b.time.advance(700)
    await b.outbox.send('1', 'segunda')
    assert.deepEqual(b.time.sleeps, [300])
    assert.deepEqual(b.envios.map((e) => e.at), [0, 1000])
  })

  it('CHATS DIFERENTES nao esperam um pelo outro: o limite e por chat, nao global', async () => {
    const b = bancada()
    await Promise.all([b.outbox.send('a', 'para A'), b.outbox.send('b', 'para B')])
    assert.deepEqual(b.envios.map((e) => e.at), [0, 0], 'uma fila unica faria do limite por chat um limite global')
    assert.deepEqual(b.time.sleeps, [])
  })

  it('as filas sao mesmo INDEPENDENTES — um chat pendurado nao trava o outro', async () => {
    const time = new FakeTime()
    const envios: string[] = []
    let libertar: () => void = NADA
    const preso = new Promise<void>((resolve) => {
      libertar = resolve
    })
    const outbox = criarOutbox(
      async (chat) => {
        if (chat === '1') await preso
        envios.push(chat)
        return true
      },
      { time },
    )
    const a = outbox.send('1', 'fica preso')
    const b = outbox.send('2', 'tem de passar')
    let bTerminou = false
    void (async () => {
      await b
      bTerminou = true
    })()
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
    assert.equal(bTerminou, true, 'uma fila GLOBAL deixaria B preso atras de A indefinidamente')
    assert.deepEqual(envios, ['2'])
    libertar()
    await Promise.all([a, b])
    assert.deepEqual(envios, ['2', '1'])
  })

  it('um envio falhado NAO encrava o chat, e a falha CHEGA a quem chamou', async () => {
    const b = bancada({ falharEm: 1, minIntervalMs: 0 })
    await assert.rejects(() => b.outbox.send('3', 'vai falhar'), /falha guionada/u)
    await b.outbox.send('3', 'segue')
    assert.deepEqual(b.envios.map((e) => e.text), ['segue'])
  })

  it('drain espera o que estiver em fila', async () => {
    const b = bancada()
    const pendentes = [b.outbox.send('4', 'a'), b.outbox.send('4', 'b')]
    await b.outbox.drain()
    assert.equal(b.envios.length, 2)
    await Promise.all(pendentes)
  })
})

/** `true` se a string contiver um substituto SOLTO — meia unidade de um par. */
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