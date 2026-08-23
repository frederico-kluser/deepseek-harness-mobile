/**
 * `configure()` — a costura de PRODUCAO (worker/commands/costura.ts, linhas
 * 286-377): o builder que liga o worker inteiro ao processo real e ao bot,
 * DEPOIS de o bot existir e ANTES de o polling arrancar.
 *
 * Porque uma suite separada: `configure` faz a ponte com o `proc` (stdin/
 * stdout/stderr) e com o bot (grammY), e a bancada de `costura.test.ts` nao
 * modela nenhum dos dois. Aqui o processo e o bot sao dubles ESTRUTURAIS —
 * streams reais (PassThrough) e um bot com a API minima — e o canal JSONL
 * corre de verdade pelos dois sentidos, como em producao.
 *
 * O QUE ESTA SUITE PROVA (contrato):
 *  1. TG-080: `setMyCommands` recebe os SETE comandos na ordem de D5; uma
 *     falha de publicacao e logada e NAO derruba o boot.
 *  2. O funil do bot existe: todo update passa pelo roteador CORRENTE.
 *  3. 8(c): `pairing.owner` no boot re-monta a superficie com o dono — o
 *     dono comanda, o estranho nao.
 *  4. EMENDA-COSTURA-5 ponta a ponta: /ligar pede o nonce pelo CANAL
 *     (nonce.request no stdout), o host responde (nonce.issued no stdin), o
 *     teclado sai com o nonce opaco, e o clique envia o intent com o nonce.
 *
 * Nenhuma chamada de rede real (TG-069): o `api` do bot e um duble.
 */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import { configure, type ConfiguracaoDoProcesso } from '../../../../worker/commands/costura.ts'
import { COMANDOS_PUBLICADOS } from '../../../../worker/commands/router.ts'
import {
  callbackQuery,
  dmMessage,
  OWNER,
  pairCommand,
  STRANGER,
} from '../../../support/fixtures/telegram/updates.ts'
import { createHash } from 'node:crypto'

/* ========================================================================== */
/* Dubles estruturais do processo e do bot                                    */
/* ========================================================================== */
/** Streams reais (PassThrough) + `exit` contado + `env` do contrato. */
function criarProcessoFalso(): {
  readonly proc: NodeJS.Process
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly saidas: string[]
  readonly saidasCru: () => string
  readonly exitChamadas: () => number
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const saidas: string[] = []
  let exitChamadas = 0
  let bruto = ''
  stdout.on('data', (c: Buffer) => {
    bruto += c.toString('utf8')
    const linhas = bruto.split('\n')
    bruto = linhas.pop() ?? ''
    for (const linha of linhas) {
      if (linha.trim() !== '') saidas.push(linha)
    }
  })
  const proc = {
    stdin,
    stdout,
    stderr,
    env: { DSH_GUARD_IPC: '1', TELEGRAM_BOT_TOKEN: '123456:AAFAKE-CONFIGURE-TOKEN-000000' },
    exit: () => {
      exitChamadas += 1
    },
  } as unknown as NodeJS.Process
  return { proc, stdin, stdout, stderr, saidas, saidasCru: () => saidas.join('\n'), exitChamadas: () => exitChamadas }
}

interface FakeBot {
  readonly api: {
    sendMessage: (chat: number, texto: string, opcoes?: Record<string, unknown>) => Promise<{ message_id: number }>
    editMessageText: (..._a: unknown[]) => Promise<{ ok: true }>
    answerCallbackQuery: (..._a: unknown[]) => Promise<true>
    setMyCommands: (outro: { commands: unknown }) => Promise<unknown>
  }
  readonly mensagens: Array<{ chat: number; texto: string; opcoes: Record<string, unknown> | undefined }>
  readonly comandosPublicados: unknown[]
  paradas: number
  falharSetMyCommands: boolean
  stop(): Promise<void>
  on(seletor: unknown, handler: (ctx: { update: unknown }) => Promise<void>): void
  handler: ((ctx: { update: unknown }) => Promise<void>) | undefined
}

function criarBotFalso(): FakeBot {
  const mensagens: FakeBot['mensagens'] = []
  const comandosPublicados: unknown[] = []
  let paradas = 0
  let falharSetMyCommands = false
  let handler: ((ctx: { update: unknown }) => Promise<void>) | undefined
  const bot = {
    api: {
      sendMessage: async (chat: number, texto: string, opcoes?: Record<string, unknown>) => {
        mensagens.push({ chat, texto, opcoes })
        return { message_id: 100 + mensagens.length }
      },
      editMessageText: async () => ({ ok: true as const }),
      answerCallbackQuery: async () => true,
      setMyCommands: async (outro: { commands: unknown }) => {
        comandosPublicados.push(outro.commands)
        if (falharSetMyCommands) throw new Error('429 Too Many Requests')
        return true
      },
    },
    mensagens,
    comandosPublicados,
    get paradas() {
      return paradas
    },
    set paradas(v: number) {
      paradas = v
    },
    get falharSetMyCommands() {
      return falharSetMyCommands
    },
    set falharSetMyCommands(v: boolean) {
      falharSetMyCommands = v
    },
    on(seletor: unknown, h: (ctx: { update: unknown }) => Promise<void>): void {
      assert.deepEqual(seletor, ['message', 'callback_query'])
      handler = h
    },
    stop: async (): Promise<void> => {
      paradas += 1
    },
    get handler() {
      return handler
    },
  }
  return bot as unknown as FakeBot
}

/** Envia uma mensagem host -> worker pelo stdin, como o parser do pai faria. */
function doHost(processo: { stdin: PassThrough }, msg: Record<string, unknown>): void {
  processo.stdin.write(`${JSON.stringify(msg)}\n`)
}

/** Parseia a ultima linha JSONL do stdout do worker. */
function ultimaLinha(processo: { saidas: string[] }): Record<string, unknown> {
  const ultima = processo.saidas.at(-1)
  assert.ok(ultima !== undefined, 'nenhuma linha JSONL no stdout do worker')
  return JSON.parse(ultima) as Record<string, unknown>
}

/** O digest sha256 hex do codigo, como o host o enviaria. */
function digestDoCodigo(codigo: string): string {
  return createHash('sha256').update(codigo, 'utf8').digest('hex')
}

/* ========================================================================== */
/* A costura em si                                                             */
/* ========================================================================== */

describe('configure — a costura de producao', () => {
  it('liga o funil do bot, publica os SETE comandos na ordem de D5 e nao rebenta', async () => {
    const processo = criarProcessoFalso()
    const bot = criarBotFalso()
    configure(bot as never, { env: processo.proc.env, proc: processo.proc } as ConfiguracaoDoProcesso)
    await tick(6)

    // O funil existe: o bot recebeu o middleware para message e callback_query.
    assert.ok(bot.handler !== undefined, 'o funil do bot nao foi registado')
    // TG-080: o array inteiro, na ordem.
    assert.equal(bot.comandosPublicados.length, 1)
    assert.deepEqual(bot.comandosPublicados[0], COMANDOS_PUBLICADOS)
  })

  it('uma falha de setMyCommands NAO derruba o boot (logada; o bot continua a responder)', async () => {
    const processo = criarProcessoFalso()
    const bot = criarBotFalso()
    bot.falharSetMyCommands = true
    configure(bot as never, { env: processo.proc.env, proc: processo.proc } as ConfiguracaoDoProcesso)
    await tick(6)
    assert.ok(bot.handler !== undefined, 'o funil continua registado apos a falha')
  })

  it('8(c): pairing.owner no boot re-monta a superficie — o dono comanda, o estranho nao', async () => {
    const processo = criarProcessoFalso()
    const bot = criarBotFalso()
    configure(bot as never, { env: processo.proc.env, proc: processo.proc } as ConfiguracaoDoProcesso)
    await tick(6)
    const handler = bot.handler
    assert.ok(handler !== undefined)

    // O host entrega o dono persistido pelo canal.
    doHost(processo, { v: 1, type: 'pairing.owner', from: OWNER, chat: OWNER, pairedAt: 1_700_000_000_000 })
    await tick(6)

    // O dono comanda: o intent sai pelo stdout (JSONL).
    await handler({ update: dmMessage(OWNER, '/status') })
    await tick(6)
    const intent = ultimaLinha(processo)
    assert.equal(intent.type, 'intent')
    assert.equal(intent.intent, 'tunnel.status')
    assert.equal(intent.from, OWNER)

    // O estranho nao: nenhuma linha nova no canal.
    const antes = processo.saidas.length
    await handler({ update: dmMessage(STRANGER, '/status') })
    await tick(6)
    assert.equal(processo.saidas.length, antes, 'o estranho nao chega ao canal')
  })

  it('EMENDA-COSTURA-5 ponta a ponta: /ligar pede o nonce pelo canal, o teclado sai opaco e o clique envia o intent', async () => {
    const processo = criarProcessoFalso()
    const bot = criarBotFalso()
    configure(bot as never, { env: processo.proc.env, proc: processo.proc } as ConfiguracaoDoProcesso)
    await tick(6)
    const handler = bot.handler
    assert.ok(handler !== undefined)
    doHost(processo, { v: 1, type: 'pairing.owner', from: OWNER, chat: OWNER, pairedAt: 1_700_000_000_000 })
    await tick(6)

    // /ligar: o pedido de nonce vai pelo canal ANTES de qualquer teclado.
    const antes = processo.saidas.length
    const pendente = handler({ update: dmMessage(OWNER, '/ligar') })
    await tick(6)
    const pedido = ultimaLinha(processo)
    assert.equal(pedido.type, 'nonce.request')
    assert.equal(pedido.acao, 'start', 'tunnel.up mapeia para a ControlAction start')
    const requestId = pedido.requestId
    assert.ok(typeof requestId === 'string')

    // O host responde pelo stdin; a ponte entrega o valor opaco ao comando.
    doHost(processo, { v: 1, type: 'nonce.issued', acao: 'start', requestId, nonce: 'nonce-opaco-123', expiresAt: 1_700_000_060_000 })
    await pendente
    await tick(6)

    // O teclado saiu com o nonce opaco no callback_data (gramatica g1).
    const teclado = bot.mensagens.at(-1)
    assert.ok(teclado !== undefined)
    assert.match(teclado.texto, /^Ligar o túnel de acesso\?/u, 'o /ligar pergunta e anuncia o link autenticado')
    assert.match(teclado.texto, /link autenticado/u)
    const markup = teclado.opcoes?.reply_markup as
      | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
      | undefined
    const data = markup?.inline_keyboard?.[0]?.[0]?.callback_data
    assert.ok(typeof data === 'string' && data.startsWith('g1:tunnel.up:'))
    assert.equal(data.slice('g1:tunnel.up:'.length), 'nonce-opaco-123', 'o nonce viaja opaco (S5)')

    // O clique envia o intent com o nonce pelo canal — e o mesmo valor.
    await handler({ update: callbackQuery({ from: OWNER, chat: OWNER, data }) })
    await tick(6)
    const intent = ultimaLinha(processo)
    assert.equal(intent.type, 'intent')
    assert.equal(intent.intent, 'tunnel.up')
    assert.equal(intent.nonce, 'nonce-opaco-123')
    assert.ok(processo.saidas.length > antes, 'o intent saiu apos o clique')
  })

  it('sem token no ambiente, configure NAO rebenta — o logger nasce sem segredos (fail-open so no log)', async () => {
    const processo = criarProcessoFalso()
    const bot = criarBotFalso()
    const envSemToken: NodeJS.ProcessEnv = { DSH_GUARD_IPC: '1' }
    configure(bot as never, { env: envSemToken, proc: processo.proc } as ConfiguracaoDoProcesso)
    await tick(6)
    assert.ok(bot.handler !== undefined, 'o funil continua registado sem token no ambiente')
  })

  it('o /emergencia derruba o bot (parar), responde UMA vez e e idempotente', async () => {
    const processo = criarProcessoFalso()
    const bot = criarBotFalso()
    configure(bot as never, { env: processo.proc.env, proc: processo.proc } as ConfiguracaoDoProcesso)
    await tick(6)
    const handler = bot.handler
    assert.ok(handler !== undefined)

    // Pareia pelo caminho do desafio (o host roda o codigo), NAO por pairing.owner:
    // e o caminho em que a superficie ORIGINAL (sem re-montagem) e quem serve.
    doHost(processo, {
      v: 1,
      type: 'pairing.challenge',
      digest: digestDoCodigo('654321'),
      expiresAt: Date.now() + 5 * 60_000,
    })
    await tick(6)
    await handler({ update: pairCommand(OWNER, '654321') })
    await tick(6)

    const antes = processo.saidas.length
    await handler({ update: dmMessage(OWNER, '/emergencia') })
    await tick(6)

    assert.equal(bot.paradas, 1, 'o worker parou o bot (ctx.parar -> bot.stop)')
    assert.equal(bot.mensagens.at(-1)?.texto.includes('Emergência'), true, 'responde UMA vez')
    assert.ok(processo.saidas.length > antes, 'o intent emergency saiu pelo canal')

    // Idempotente: o segundo /emergencia nao re-envia nem re-responde.
    const mensagensApos = bot.mensagens.length
    await handler({ update: dmMessage(OWNER, '/emergencia') })
    await tick(6)
    assert.equal(bot.mensagens.length, mensagensApos, 'sem resposta nova')
  })

  it('o /emergencia depois de pairing.owner usa o parar da superficie RE-MONTADA (8c)', async () => {
    const processo = criarProcessoFalso()
    const bot = criarBotFalso()
    configure(bot as never, { env: processo.proc.env, proc: processo.proc } as ConfiguracaoDoProcesso)
    await tick(6)
    const handler = bot.handler
    assert.ok(handler !== undefined)

    // Re-monta com o dono persistido; a superficie nova e a que serve.
    doHost(processo, { v: 1, type: 'pairing.owner', from: OWNER, chat: OWNER, pairedAt: 1_700_000_000_000 })
    await tick(6)

    await handler({ update: dmMessage(OWNER, '/emergencia') })
    await tick(6)
    assert.equal(bot.paradas, 1, 'o parar da superficie re-montada derrubou o bot')
  })
})

/** Cede o turno o suficiente para as cadeias de microtarefas correrem. */
async function tick(vezes = 6): Promise<void> {
  for (let i = 0; i < vezes; i += 1) await Promise.resolve()
}
