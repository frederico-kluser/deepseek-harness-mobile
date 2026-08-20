/**
 * `worker/commands/router.ts` — a lista publicada, o funil do update, e o
 * descarte silencioso e contado (TG-089).
 *
 * COBRE TG-080 (setMyCommands: o ARRAY INTEIRO, na ordem), TG-081 (comandos
 * mortos nao roteados para intent nenhum), TG-089 (identidade nao pareada
 * descartada em silencio e contada), o roteamento do pareamento (PAIR-006/007)
 * e a leitura do comando (incluindo o sufixo `@bot` dos grupos).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  COMANDOS_PUBLICADOS,
  cortarTexto,
  extrairNomeDeComando,
  formatarDuracao,
  gerarRequestId,
  registarComandosPublicados,
  textoDeEstado,
  textoDeRecusa,
} from '../../../../worker/commands/router.ts'
import type { IpcErrorCode } from '../../../../src/contracts/ipc.ts'
import {
  callbackQuery,
  channelPost,
  dmMessage,
  groupMessage,
  OWNER,
  pairCommand,
  STRANGER,
  startCommand,
} from '../../../support/fixtures/telegram/updates.ts'
import { montarBancada, tick } from './apoio.ts'

/* ========================================================================== */
/* TG-080 — setMyCommands: o array inteiro, na ordem                          */
/* ========================================================================== */

describe('TG-080: setMyCommands publica EXATAMENTE a lista canonica, na ordem', () => {
  it('o array inteiro chega a setMyCommands, na ordem de D5, e nada mais', async () => {
    const { api } = montarBancada()
    await registarComandosPublicados({ setMyCommands: (o) => api.registrarComandos(o.commands) })

    assert.equal(api.setMyCommands.length, 1)
    assert.deepEqual(api.setMyCommands[0], [
      { command: 'ligar', description: 'Liga o túnel de acesso (pede confirmação)' },
      { command: 'desligar', description: 'Desliga o túnel (pede confirmação)' },
      { command: 'status', description: 'Estado atual: túnel, tempo no ar e quando expira' },
      { command: 'acessar', description: 'Envia o link mágico de acesso único' },
      { command: 'rotacionar', description: 'Gera senha nova (pede confirmação)' },
      { command: 'parear', description: 'Parear com o código <código> mostrado no terminal' },
      { command: 'emergencia', description: 'Emergência: desliga o túnel e este bot' },
    ])
  })

  it('a lista tem EXATAMENTE sete comandos, e /start NAO esta la (PAIR-006)', () => {
    assert.equal(COMANDOS_PUBLICADOS.length, 7)
    const nomes = COMANDOS_PUBLICADOS.map((c) => c.command)
    assert.deepEqual(nomes, ['ligar', 'desligar', 'status', 'acessar', 'rotacionar', 'parear', 'emergencia'])
    assert.ok(!nomes.includes('start'))
  })

  it('forma de registo (emenda D5): command e [a-z0-9_]{1,32}, descricao 1..256', () => {
    for (const { command, description } of COMANDOS_PUBLICADOS) {
      assert.match(command, /^[a-z0-9_]{1,32}$/u, command)
      assert.ok(description.length >= 1 && description.length <= 256, command)
    }
    // `parear` sem barra e sem argumento; `emergencia` sem acento; o `<código>`
    // e o acento vivem na descricao.
    assert.equal(COMANDOS_PUBLICADOS[5]?.command, 'parear')
    assert.ok(COMANDOS_PUBLICADOS[5].description.includes('<código>'))
    assert.equal(COMANDOS_PUBLICADOS[6]?.command, 'emergencia')
    assert.ok(!COMANDOS_PUBLICADOS[6].description.includes('emergência'))
  })
})

/* ========================================================================== */
/* TG-081 — comandos mortos                                                   */
/* ========================================================================== */

describe('TG-081: comandos mortos nao sao roteados para intent nenhum', () => {
  const mortos = ['/parar', '/parar_bot', '/desligar_servidor', '/abrir_tunel', '/vincular']

  it('cada comando morto, do dono pareado, nao gera intent nenhum', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    assert.equal(bancada.ipc.intents.length, 0)

    for (const morto of mortos) {
      await bancada.tratar(dmMessage(OWNER, morto))
    }

    assert.equal(bancada.ipc.intents.length, 0, 'nenhum intent para comandos mortos')
  })

  it('o dono recebe uma palavra amigavel, sem ecoar o comando morto', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(OWNER, '/parar'))

    assert.equal(bancada.api.mensagens.at(-1)?.texto, 'Não conheço este comando.')
  })

  it('os nomes mortos so existem nesta tabela de correcao, nunca no codigo', () => {
    // TG-081: «git grep deles no repositorio devolve zero fora de tabela de
    // correcao». A tabela e esta lista; o codigo dos comandos nao os conhece.
    const fonte = readFileSync(
      new URL('../../../../worker/commands/router.ts', import.meta.url),
      'utf8',
    )
    for (const morto of mortos) {
      assert.ok(!fonte.includes(morto), `${morto} apareceu no roteador`)
    }
  })
})

/* ========================================================================== */
/* TG-089 — identidade nao pareada: silencio e contagem                       */
/* ========================================================================== */

describe('TG-089: comando de identidade nao pareada e descartado em silencio e contado', () => {
  it('sem pareamento, NENHUM comando do dono chega ao canal — e contado', async () => {
    const bancada = montarBancada()
    // A allowlist dinamica nasce vazia: default deny (TG-007).
    await bancada.tratar(dmMessage(OWNER, '/ligar'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.api.mensagens.length, 0, 'silencio total: nenhuma resposta')
    assert.match(bancada.log.all(), /deny:not-configured/u)
  })

  it('um estranho, com o pareamento fechado, e descartado e contado (TG-089)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(dmMessage(STRANGER, '/desligar'))
    await bancada.tratar(dmMessage(STRANGER, '/status'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.api.mensagens.length, 1, 'so a resposta do pareamento')
    // Contado: o descarte aparece no log de auditoria com a identidade forense.
    assert.match(bancada.log.all(), /deny:not-allowlisted/u)
  })

  it('callback de estranho: answer SEMPRE (TG-027), mas nenhum intent', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(
      callbackQuery({ from: STRANGER, chat: OWNER, data: 'g1:tunnel.down:AAAAAAAAAAA' }),
    )

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.api.respostas.length, 1, 'o girador para, sem conteudo')
    assert.equal(bancada.api.respostas[0]?.outras, undefined, 'silencio de conteudo')
  })

  it('uma superficie que nao carrega comando (channel_post) nao chega ao canal', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))

    await bancada.tratar(channelPost(OWNER, '/desligar'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.match(bancada.log.all(), /deny:surface-not-actionable|deny:missing-from/u)
  })
})

/* ========================================================================== */
/* O pareamento pelo funil                                                    */
/* ========================================================================== */

describe('o funil: o pareamento corre ANTES da allowlist (PAIR-006/007)', () => {
  it('o dono pareia com o codigo certo, e a resposta confirma', async () => {
    const bancada = montarBancada()

    await bancada.tratar(pairCommand(OWNER, '123456'))

    assert.equal(bancada.api.mensagens.length, 1)
    assert.match(bancada.api.mensagens[0]?.texto ?? '', /Pareado/u)
    // A partir daqui o dono comanda.
    await bancada.tratar(dmMessage(OWNER, '/status'))
    assert.equal(bancada.ipc.intents.at(-1)?.intent, 'tunnel.status')
  })

  it('codigo errado: resposta generica, atrasada pelo relogio injetado', async () => {
    const bancada = montarBancada()
    const antes = bancada.time.now()

    await bancada.tratar(pairCommand(STRANGER, '000000'))

    assert.equal(bancada.api.mensagens.length, 1)
    assert.match(bancada.api.mensagens[0]?.texto ?? '', /Nao foi possivel parear/u)
    assert.ok(bancada.time.now() >= antes, 'o atraso passou pelo relogio injetado')
    assert.ok(!bancada.api.mensagens[0]?.texto?.includes('000000'), 'o candidato nao e ecoado')
  })

  it('/start e boas-vindas inocua, e NAO pareia ninguem (PAIR-006)', async () => {
    const bancada = montarBancada()

    await bancada.tratar(startCommand(STRANGER))

    assert.equal(bancada.api.mensagens.length, 1)
    assert.match(bancada.api.mensagens[0]?.texto ?? '', /Ola/u)
    assert.equal(bancada.ipc.intents.length, 0)
    // E o estranho continua sem comandar.
    await bancada.tratar(dmMessage(STRANGER, '/status'))
    assert.equal(bancada.ipc.intents.length, 0)
  })

  it('/parear@nome_do_bot funciona em grupo (o sufixo @ e descartado)', async () => {
    const bancada = montarBancada()
    await bancada.tratar({ ...groupMessage(OWNER, OWNER, '/parear@dsh_guard_bot 123456') })
    assert.equal(bancada.api.mensagens.length, 1)
    assert.match(bancada.api.mensagens[0]?.texto ?? '', /Pareado/u)
  })
})

/* ========================================================================== */
/* A leitura do comando                                                       */
/* ========================================================================== */

describe('extrairNomeDeComando', () => {
  it('le o nome, o sufixo @bot, o argumento e o caso (minisculas)', () => {
    assert.equal(extrairNomeDeComando('/ligar'), 'ligar')
    assert.equal(extrairNomeDeComando('/ligar@meu_bot'), 'ligar')
    assert.equal(extrairNomeDeComando('/ligar@meu_bot agora'), 'ligar')
    assert.equal(extrairNomeDeComando('/parear 123456'), 'parear')
    assert.equal(extrairNomeDeComando('/EMERGENCIA'), 'emergencia')
    assert.equal(extrairNomeDeComando('   /status  '), 'status')
  })

  it('devolve undefined para texto sem comando', () => {
    assert.equal(extrairNomeDeComando('olá'), undefined)
    assert.equal(extrairNomeDeComando(''), undefined)
    assert.equal(extrairNomeDeComando('/'), undefined)
    assert.equal(extrairNomeDeComando('/ '), undefined)
  })
})

/* ========================================================================== */
/* Cortar texto (pergunta 4 da revisao: o limite de 4096)                     */
/* ========================================================================== */

describe('cortarTexto — o limite de 4096 da Bot API nunca estoura', () => {
  it('texto curto passa intacto; texto longo e cortado', () => {
    assert.equal(cortarTexto('curto'), 'curto')
    const longo = 'x'.repeat(5_000)
    const cortado = cortarTexto(longo)
    assert.ok(cortado.length <= 4_096)
    assert.ok(cortado.endsWith('…'))
  })
})

/* ========================================================================== */
/* O requestId (ULID)                                                         */
/* ========================================================================== */

describe('gerarRequestId — ULID de 26 caracteres com o relogio injetado', () => {
  it('tem 26 caracteres Crockford (alfabeto sem I/L/O/U)', () => {
    const id = gerarRequestId(1_700_000_000_000)
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/u)
  })

  it('ids diferentes para tempos diferentes (monotonia aproximada)', () => {
    const a = gerarRequestId(1_000)
    const b = gerarRequestId(2_000)
    assert.notEqual(a, b)
  })
})
/* ========================================================================== */
/* O vocabulario de recusa (fechado em ipc.ts)                                  */
/* ========================================================================== */

describe('textoDeRecusa — o vocabulario FECHADO, um texto por codigo', () => {
  it('cobre os NOVE codigos do contrato, e nenhum devolve undefined', () => {
    const codigos: IpcErrorCode[] = [
      'SHUTDOWN_IN_PROGRESS',
      'EXPOSURE_DISABLED',
      'RESTRICTED_MODE',
      'PROBE_FAILED',
      'TUNNEL_FAILED',
      'NOT_PAIRED',
      'NONCE_INVALID',
      'RATE_LIMITED',
      'INTERNAL',
    ]
    for (const codigo of codigos) {
      const texto = textoDeRecusa(codigo)
      assert.ok(typeof texto === 'string' && texto.length > 0, codigo)
    }
    // O vocabulario e o mesmo do parser do canal (o roteador nunca inventa um).
    const fonte = readFileSync(
      new URL('../../../../worker/commands/router.ts', import.meta.url),
      'utf8',
    )
    for (const codigo of codigos) {
      assert.ok(fonte.includes(codigo), `${codigo} desapareceu do roteador`)
    }
  })

  it('SHUTDOWN_IN_PROGRESS diz ao dono que o tunel esta a desligar (D29, CTL-007)', () => {
    assert.match(textoDeRecusa('SHUTDOWN_IN_PROGRESS'), /a desligar/u)
    assert.match(textoDeRecusa('RESTRICTED_MODE'), /modo restrito/u)
    assert.match(textoDeRecusa('NOT_PAIRED'), /não está pareado/u)
  })
})

/* ========================================================================== */
/* formatarDuracao — o ramo das horas (deterministico)                         */
/* ========================================================================== */

describe('formatarDuracao', () => {
  it('cobre o ramo das horas, com e sem resto', () => {
    assert.equal(formatarDuracao(0), 'agora')
    assert.equal(formatarDuracao(-5), 'agora')
    assert.equal(formatarDuracao(30_000), 'menos de 1 min')
    assert.equal(formatarDuracao(59_999), 'menos de 1 min')
    assert.equal(formatarDuracao(60_000), '1 min')
    assert.equal(formatarDuracao(59 * 60_000), '59 min')
    assert.equal(formatarDuracao(60 * 60_000), '1 h')
    assert.equal(formatarDuracao(90 * 60_000), '1 h 30 min')
    assert.equal(formatarDuracao(150 * 60_000), '2 h 30 min')
  })
})

/* ========================================================================== */
/* textoDeEstado — antes da primeira difusao                                   */
/* ========================================================================== */

describe('textoDeEstado', () => {
  it('sem estado ainda, diz desconhecido em vez de inventar (TG-084)', () => {
    const texto = textoDeEstado({ state: undefined, seq: 0 }, 1_000)
    assert.match(texto, /desconhecido/u)
    assert.match(texto, /host ainda não enviou estado/u)
  })
})

/* ========================================================================== */
/* Os caminhos do ack/erro/state/notify que o funil nao toca                  */
/* ========================================================================== */

/** O data do UNICO botao do teclado de uma resposta. */
function dataDoBotao(bancada: { api: { mensagens: Array<{ opcoes: { reply_markup?: { inline_keyboard?: unknown[] } } | undefined }> } }): string {
  const ultima = bancada.api.mensagens.at(-1)
  assert.ok(ultima !== undefined, 'nenhuma mensagem com teclado')
  const teclado = ultima.opcoes?.reply_markup?.inline_keyboard as
    | Array<Array<{ callback_data?: string }>>
    | undefined
  const data = teclado?.[0]?.[0]?.callback_data
  assert.ok(typeof data === 'string', 'esperava um botao com callback_data')
  return data
}

describe('o ack aceite de /ligar e /rotacionar edita o teclado in-place (TG-028)', () => {
  it('/ligar: ack aceite -> «A ligar o túnel…» na mensagem do botao', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)

    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STARTING' })
    await tick(6)

    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.match(edicao.texto, /A ligar o túnel/u)
  })

  it('/rotacionar: ack aceite -> «A rodar a senha…» na mensagem do botao', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/rotacionar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)

    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STARTING' })
    await tick(6)

    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.match(edicao.texto, /A rodar a senha/u)
  })

  it('ack noop de /desligar -> «Já estava assim.» editado in-place no teclado (TG-028)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)

    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: intent.requestId, result: 'noop', state: 'STOPPED' })
    await tick(6)

    const edicao = bancada.api.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.match(edicao.texto, /Já estava assim/u)
  })

  it('um callback SEM message (withMessage false) morre no guard: answer, NENHUM intent', async () => {
    // O guard nao consegue resolver o chat de um callback sem mensagem: o
    // update e descartado e o girador para (TG-027). O ramo «pendente sem
    // messageId» do roteador e defesa inalcancavel por este caminho — um
    // callback admitido tem sempre message_id (ver o comentario no funil).
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)

    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data, withMessage: false }))

    assert.equal(bancada.ipc.intents.length, 0, 'nenhum intent')
    assert.equal(bancada.api.respostas.length, 1, 'o answer sempre vem')
  })
})

describe('caminhos de erro e difusao (S4: nunca lancam)', () => {
  it('onState fora de ordem (seq <= ultimo) e DESCARTADA e registada em debug', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    bancada.roteador.onState({ v: 1, type: 'state', state: 'READY', seq: 2, url: 'https://x.trycloudflare.com', expiresAt: bancada.time.now() + 60_000 })
    await tick(6)
    bancada.roteador.onState({ v: 1, type: 'state', state: 'STOPPED', seq: 1 })
    await tick(6)
    assert.match(bancada.log.all(), /fora de ordem/u)
  })

  it('o canal recusa o intent: log de erro e o pendente NAO e registado', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/ligar'))
    const data = dataDoBotao(bancada)
    // A rede do canal cai; o clique da confirmacao (que AUMENTA exposicao) e
    // quem passa pelo funil `enviarIntent` com log de recusa.
    bancada.ipc.falhar = true
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    assert.equal(bancada.ipc.intents.length, 0, 'o intent nao saiu')
    assert.match(bancada.log.all(), /intent recusada pelo canal/u)
  })

  it('erro do host com requestId SEM intent pendente: registado em debug, nada renderizado', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const antes = bancada.api.mensagens.length
    bancada.roteador.onError({ v: 1, type: 'error', requestId: 'r-inexistente', code: 'INTERNAL', message: 'erro orfao' })
    await tick(6)
    assert.equal(bancada.api.mensagens.length, antes, 'nenhuma mensagem nova')
    assert.match(bancada.log.all(), /erro sem intent pendente/u)
  })

  it('erro do host de /desligar: mensagem PROPIA, nunca edicao do painel', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    await bancada.tratar(dmMessage(OWNER, '/desligar'))
    const data = dataDoBotao(bancada)
    await bancada.tratar(callbackQuery({ from: OWNER, chat: OWNER, data }))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)

    bancada.roteador.onError({ v: 1, type: 'error', requestId: intent.requestId, code: 'TUNNEL_FAILED', message: 'o tunel caiu' })
    await tick(6)

    assert.equal(bancada.api.edicoes.length, 0, 'o erro nao edita in-place')
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /o tunel caiu/u)
  })

  it('notify so com o marcador (sem corpo): nada a mostrar, aviso em log', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const antes = bancada.api.mensagens.length
    bancada.roteador.onNotify({ v: 1, type: 'notify', texto: 'alerta:sessao-nova' })
    await tick(6)
    assert.equal(bancada.api.mensagens.length, antes, 'nenhuma mensagem para um notify sem corpo')
    assert.match(bancada.log.all(), /notify sem corpo/u)
  })

  it('texto sem comando do dono: silencio total (nao e intent, nao e resposta)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const antes = bancada.api.mensagens.length
    await bancada.tratar(dmMessage(OWNER, 'olá, isto não é um comando'))
    assert.equal(bancada.ipc.intents.length, 0, 'nenhum intent')
    assert.equal(bancada.api.mensagens.length, antes, 'nenhuma resposta')
  })
})

/* ========================================================================== */
/* O teto defensivo do mapa de pendentes (MAX_PENDENTES)                      */
/* ========================================================================== */

describe('MAX_PENDENTES: o mapa de intents pendentes nao cresce sem limite', () => {
  it('65 intents seguidos: o mais antigo e expulso (FIFO) e o mais novo responde', async () => {
    const bancada = montarBancada()
    await bancada.tratar(pairCommand(OWNER, '123456'))
    const primeiro = bancada.ipc.intents.length

    for (let i = 0; i < 65; i += 1) {
      await bancada.tratar(dmMessage(OWNER, '/status'))
    }
    const intents = bancada.ipc.intents.slice(primeiro)
    assert.equal(intents.length, 65)
    const primeiroRequestId = intents[0]?.requestId
    const ultimoRequestId = intents.at(-1)?.requestId
    assert.ok(primeiroRequestId !== undefined && ultimoRequestId !== undefined)

    // O 1o foi expulso pelo teto: o ack dele nao encontra pendente nenhum.
    const antes = bancada.api.mensagens.length
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: primeiroRequestId, result: 'accepted', state: 'STARTING' })
    await tick(6)
    assert.equal(bancada.api.mensagens.length, antes, 'o ack do expulso nao renderiza nada')
    assert.match(bancada.log.all(), /ack sem intent pendente/u)

    // O 65o ainda esta la: o ack dele renderiza o estado.
    bancada.roteador.onAck({ v: 1, type: 'ack', requestId: ultimoRequestId, result: 'accepted', state: 'STARTING' })
    await tick(6)
    assert.match(bancada.api.mensagens.at(-1)?.texto ?? '', /Estado: ligando \(STARTING\)/u)
  })
})

