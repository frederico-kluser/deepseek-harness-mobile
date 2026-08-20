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
  gerarRequestId,
  registarComandosPublicados,
} from '../../../../worker/commands/router.ts'
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
import { montarBancada } from './apoio.ts'

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
