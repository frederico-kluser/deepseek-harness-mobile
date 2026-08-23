/**
 * `worker/surface/core.ts` — o NUCLEO NEUTRO da superficie (onda 2 — nucleo).
 * Port fiel de `test/unit/worker/commands/router.test.ts`, `status.test.ts` e
 * `autolink.test.ts` (DONO de referencia: T5.2), REescrito contra eventos NEUTROS
 * ({@link SurfaceEvent}) e a bancada neutra de `./apoio.ts`.
 *
 * COBRE: TG-080 (publicacao da lista), TG-081 (comandos mortos), TG-089 (descarte
 * silencioso e contado), o funil pareamento-antes-allowlist (PAIR-006/007),
 * extrairNomeDeComando, os caminhos de ack/error/state/notify (S4), MAX_PENDENTES,
 * TG-084 (/status), TG-087 (/emergencia), CTL-024 (emergencia sem nonce) e o
 * AUTOLINK (onda1: /ligar -> READY -> session.issue uma vez).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import type { IpcStateMessage } from '../../../../src/contracts/ipc.ts'
import type { SurfaceActionEvent } from '../../../../worker/surface/contract.ts'
import {
  extrairNomeDeComando,
  textoDeRecusa,
  type ComandoPublicado,
} from '../../../../worker/surface/core.ts'
import type { IpcErrorCode } from '../../../../src/contracts/ipc.ts'
import { comandoDoDono, DONO, ESTRANHO, IDENTIDADE_DONO, montarBancada, tick, type Bancada } from './apoio.ts'

const URL_TUNEL = 'https://x.trycloudflare.com'

/** Estado READY no formato do contrato IPC. */
function ready(seq: number): IpcStateMessage {
  return { v: 1, type: 'state', state: 'READY', seq, url: URL_TUNEL, expiresAt: 9_000 }
}

function starting(seq: number): IpcStateMessage {
  return { v: 1, type: 'state', state: 'STARTING', seq }
}

function paired(bancada: Bancada): Promise<void> {
  return bancada.tratar(comandoDoDono('/parear 123456'))
}

/** O token do UNICO botao da ultima mensagem (a accao de confirmacao). */
function tokenDoBotao(bancada: Bancada): string {
  const ultima = bancada.sender.mensagens.at(-1)
  assert.ok(ultima !== undefined, 'nenhuma mensagem com botoes')
  const linhas = ultima.opcoes?.actionRows
  const token = linhas?.[0]?.[0]?.token
  assert.ok(typeof token === 'string', 'esperava um botao com token')
  return token
}

/** O `messageTarget` da ultima mensagem (o id da mensagem onde o botao vive). */
function messageDoBotao(bancada: Bancada): string {
  const ultima = bancada.sender.mensagens.at(-1)
  assert.ok(ultima !== undefined, 'nenhuma mensagem com botoes')
  return ultima.id
}

/* ========================================================================== */
/* TG-080 — setMyCommands: o array inteiro, na ordem                          */
/* ========================================================================== */

describe('TG-080: os comandos publicados chegam inteiros, na ordem de D5', () => {
  it('o array inteiro chega a setMyCommands, na ordem, e nada mais', async () => {
    const { registrarComandos } = montarBancada()
    const registos: ComandoPublicado[][] = []
    await registrarComandos(registos)

    assert.equal(registos.length, 1)
    assert.deepEqual(registos[0], [
      { command: 'menu', description: 'Abrir o painel de controlo' },
      { command: 'status', description: 'Ver estado do túnel' },
      { command: 'parear', description: 'Parear com um código' },
      { command: 'emergencia', description: 'Derrubar tudo de imediato' },
      { command: 'ajuda', description: 'Ver como usar' },
    ])
  })
})

/* ========================================================================== */
/* extrairNomeDeComando                                                        */
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
/* TG-081 — comandos mortos                                                   */
/* ========================================================================== */

describe('TG-081: comandos mortos nao sao roteados para intent nenhum', () => {
  const mortos = ['/parar', '/parar_bot', '/desligar_servidor', '/abrir_tunel', '/vincular']

  it('cada comando morto, do dono pareado, nao gera intent nenhum', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    assert.equal(bancada.ipc.intents.length, 0)

    for (const morto of mortos) {
      await bancada.tratar(comandoDoDono(morto))
    }

    assert.equal(bancada.ipc.intents.length, 0, 'nenhum intent para comandos mortos')
  })

  it('o dono recebe uma palavra amigavel, sem ecoar o comando morto', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/parar'))

    assert.equal(bancada.sender.mensagens.at(-1)?.texto, 'Não entendi. Queres fazer o quê?')
  })

  it('os nomes mortos so existem nesta tabela de correcao, nunca no nucleo', () => {
    const fonte = readFileSync(new URL('../../../../worker/surface/core.ts', import.meta.url), 'utf8')
    for (const morto of mortos) {
      assert.ok(!fonte.includes(morto), `${morto} apareceu no nucleo`)
    }
  })
})

/* ========================================================================== */
/* TG-089 — identidade nao pareada: silencio e contagem                       */
/* ========================================================================== */

describe('TG-089: comando de identidade nao pareada e descartado e contado', () => {
  it('sem pareamento, NENHUM comando do dono chega ao canal — e contado', async () => {
    const bancada = montarBancada()
    // A auth dupla nasce vazia: default deny (TG-007).
    await bancada.tratar(comandoDoDono('/ligar'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.sender.mensagens.length, 0, 'silencio total: nenhuma resposta')
    assert.match(bancada.log.all(), /deny:not-configured/u)
  })

  it('um estranho, com o pareamento fechado, e descartado e contado', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar({
      kind: 'comando',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      text: '/desligar',
    })
    await bancada.tratar({
      kind: 'comando',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      text: '/status',
    })

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.sender.mensagens.length, 1, 'so a resposta do pareamento')
    // Contado: o descarte aparece na auditoria com o motivo.
    assert.match(bancada.log.all(), /deny:not-allowlisted/u)
  })

  it('um estranho manda `/ligar` com o pareamento fechado: silencio (sem intent) e CONTADO', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.sender.mensagens.length

    await bancada.tratar({
      kind: 'comando',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      text: '/ligar',
    })

    // O comando de estranho NAO chega ao canal: nenhum intent (TG-024 revalida
    // a identidade em todo evento) e nenhuma resposta na conversa (silencio).
    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.sender.mensagens.length, antes, 'silencio total: o estranho nao ve nada')
    // Mas E CONTADO na auditoria (TG-089).
    assert.match(bancada.log.all(), /deny:not-allowlisted/u)
  })

  it('accao de estranho: answer SEMPRE (TG-027), mas nenhum intent', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar({
      kind: 'acao',
      identity: { userKey: ESTRANHO, chatKey: DONO },
      action: 'tunnel.down',
      token: 'AAAAAAAAAAA',
      answerTarget: 'cq-9',
    })

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.sender.respostas.length, 1, 'o girador para, sem conteudo')
    assert.equal(bancada.sender.respostas[0]?.outras, undefined, 'silencio de conteudo')
  })

  it('acao-invalida (forma rejeitada pelo adaptador): respondida SEMPRE, sem forjar (S5)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.sender.respostas.length

    await bancada.tratar({ kind: 'acao-invalida', answerTarget: 'cq-bosta' })

    assert.equal(bancada.sender.respostas.length, antes + 1, 'o girador para (TG-027)')
    assert.equal(bancada.ipc.intents.length, 0, 'nenhum intent forjado')
    // TG-089: o descarte e contado na auditoria.
    assert.match(bancada.log.all(), /deny:acao-invalida/u)
  })
})

/* ========================================================================== */
/* O pareamento pelo funil                                                     */
/* ========================================================================== */

describe('o funil: o pareamento corre ANTES da allowlist (PAIR-006/007)', () => {
  it('o dono pareia com o codigo certo, e a resposta confirma', async () => {
    const bancada = montarBancada()

    await bancada.tratar(comandoDoDono('/parear 123456'))

    assert.equal(bancada.sender.mensagens.length, 1)
    assert.match(bancada.sender.mensagens[0]?.texto ?? '', /Pareado/u)
    // A partir daqui o dono comanda.
    await bancada.tratar(comandoDoDono('/status'))
    assert.equal(bancada.ipc.intents.at(-1)?.intent, 'tunnel.status')
  })

  it('EMENDA ONDA-1: ao parear, a bridge comunica `pairing.success` com os DOIS eixos', async () => {
    const bancada = montarBancada()

    await bancada.tratar(comandoDoDono('/parear 123456'))

    // O aviso ao HOST saiu com o dono dos dois eixos (D4: STRING).
    assert.equal(bancada.ipc.pareamentos.length, 1)
    const aviso = bancada.ipc.pareamentos[0]
    assert.ok(aviso !== undefined)
    assert.equal(aviso.userKey, DONO)
    assert.equal(aviso.chatKey, DONO)
    assert.equal(aviso.pairedAt, bancada.time.now(), 'o pairedAt e o do instante do pareamento')
  })

  it('codigo errado: resposta generica, atrasada pelo relogio injetado', async () => {
    const bancada = montarBancada()
    const antes = bancada.time.now()

    await bancada.tratar({
      kind: 'comando',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      text: '/parear 000000',
    })

    assert.equal(bancada.sender.mensagens.length, 1)
    assert.match(bancada.sender.mensagens[0]?.texto ?? '', /Código errado ou expirado/u)
    assert.ok(bancada.time.now() >= antes, 'o atraso passou pelo relogio injetado')
    assert.ok(!bancada.sender.mensagens[0]?.texto?.includes('000000'), 'o candidato nao e ecoado')
  })

  it('/start e boas-vindas inocua, e NAO pareia ninguem (PAIR-006)', async () => {
    const bancada = montarBancada()

    await bancada.tratar({
      kind: 'comando',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      text: '/start',
    })

    assert.equal(bancada.sender.mensagens.length, 1)
    assert.match(bancada.sender.mensagens[0]?.texto ?? '', /Olá/u)
    assert.equal(bancada.ipc.intents.length, 0)
    // E o estranho continua sem comandar.
    await bancada.tratar({
      kind: 'comando',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      text: '/status',
    })
    assert.equal(bancada.ipc.intents.length, 0)
  })

  it('/parear@nome_do_bot funciona em grupo (o sufixo @ e descartado)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear@dsh_guard_bot 123456'))
    assert.equal(bancada.sender.mensagens.length, 1)
    assert.match(bancada.sender.mensagens[0]?.texto ?? '', /Pareado/u)
  })
})

/* ========================================================================== */
/* textoDeRecusa — o vocabulario FECHADO                                       */
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
    const fonte = readFileSync(new URL('../../../../worker/surface/core.ts', import.meta.url), 'utf8')
    for (const codigo of codigos) {
      assert.ok(fonte.includes(codigo), `${codigo} desapareceu do nucleo`)
    }
  })
})

/* ========================================================================== */
/* Os caminhos do ack/error/state/notify (S4: nunca lancam)                   */
/* ========================================================================== */

describe('caminhos de erro e difusao', () => {
  it('onState fora de ordem (seq <= ultimo) e DESCARTADA e registada em debug', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    bancada.nucleo.onState(ready(2))
    await tick(6)
    bancada.nucleo.onState({ v: 1, type: 'state', state: 'STOPPED', seq: 1 })
    await tick(6)
    assert.match(bancada.log.all(), /fora de ordem/u)
  })

  it('o canal recusa o intent: log de erro e o pendente NAO e registado', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/ligar'))
    const token = tokenDoBotao(bancada)
    // A rede do canal cai; o clique da confirmacao e quem passa pelo funil.
    bancada.ipc.falhar = true
    await bancada.tratar(accaoDoDono('tunnel.up', token, messageDoBotao(bancada)))
    assert.equal(bancada.ipc.intents.length, 0, 'o intent nao saiu')
    assert.match(bancada.log.all(), /intent recusada pelo canal/u)
  })

  it('erro do host com requestId SEM intent pendente: debug, nada renderizado', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.sender.mensagens.length
    bancada.nucleo.onError({ v: 1, type: 'error', requestId: 'r-inexistente', code: 'INTERNAL', message: 'erro orfao' })
    await tick(6)
    assert.equal(bancada.sender.mensagens.length, antes, 'nenhuma mensagem nova')
    assert.match(bancada.log.all(), /erro sem intent pendente/u)
  })

  it('erro do host de /desligar: mensagem PROPIA, nunca edicao do painel', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/desligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.down', token, messageDoBotao(bancada)))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)

    bancada.nucleo.onError({ v: 1, type: 'error', requestId: intent.requestId, code: 'TUNNEL_FAILED', message: 'o tunel caiu' })
    await tick(6)

    assert.equal(bancada.sender.edicoes.length, 0, 'o erro nao edita in-place')
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /o tunel caiu/u)
  })

  it('notify so com o marcador (sem corpo): nada a mostrar, aviso em log', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.sender.mensagens.length
    bancada.nucleo.onNotify({ v: 1, type: 'notify', texto: 'alerta:sessao-nova' })
    await tick(6)
    assert.equal(bancada.sender.mensagens.length, antes, 'nenhuma mensagem para um notify sem corpo')
    assert.match(bancada.log.all(), /notify sem corpo/u)
  })

  it('texto sem comando do dono: silencio total', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.ipc.intents.length
    await bancada.tratar(comandoDoDono('olá, isto não é um comando'))
    assert.equal(bancada.ipc.intents.length, antes, 'nenhum intent')
    // CONTRATO §6: texto livre (nao-comando) com o dono recebe o fallback.
    assert.equal(bancada.sender.mensagens.at(-1)?.texto, 'Não entendi. Queres fazer o quê?')
  })
})

/** Uma accao do dono com `action`, `token`, `answerTarget` e `messageTarget`. */
function accaoDoDono(
  action: SurfaceActionEvent['action'],
  token: string,
  messageTarget?: string,
): SurfaceActionEvent {
  return {
    kind: 'acao',
    identity: IDENTIDADE_DONO,
    action,
    token,
    answerTarget: 'cq-1',
    messageTarget,
  }
}

/* ========================================================================== */
/* MAX_PENDENTES: o mapa de intents pendentes nao cresce sem limite            */
/* ========================================================================== */

describe('MAX_PENDENTES: o mapa de intents pendentes nao cresce sem limite', () => {
  it('65 intents seguidos: o mais antigo e expulso (FIFO) e o mais novo responde', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const primeiro = bancada.ipc.intents.length

    for (let i = 0; i < 65; i += 1) {
      await bancada.tratar(comandoDoDono('/status'))
    }
    const intents = bancada.ipc.intents.slice(primeiro)
    assert.equal(intents.length, 65)
    const primeiroRequestId = intents[0]?.requestId
    const ultimoRequestId = intents.at(-1)?.requestId
    assert.ok(primeiroRequestId !== undefined && ultimoRequestId !== undefined)

    // O 1o foi expulso pelo teto: o ack dele nao encontra pendente nenhum.
    const antes = bancada.sender.mensagens.length
    bancada.nucleo.onAck({ v: 1, type: 'ack', requestId: primeiroRequestId, result: 'accepted', state: 'STARTING' })
    await tick(6)
    assert.equal(bancada.sender.mensagens.length, antes, 'o ack do expulso nao renderiza nada')
    assert.match(bancada.log.all(), /ack sem intent pendente/u)
  })
})

/* ========================================================================== */
/* TG-084: /status — estado, seq, tunel, tempo no ar, expiracao do TTL         */
/* ========================================================================== */

describe('TG-084: /status — estado, seq, tunel, tempo no ar e expiracao do TTL', () => {
  it('responde a partir do ack, com estado, seq, URL, tempo no ar e TTL', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    // O host difunde READY (seq 7, URL, expira em 5 min).
    bancada.nucleo.onState({
      v: 1,
      type: 'state',
      state: 'READY',
      seq: 7,
      url: 'https://exemplo.trycloudflare.com',
      expiresAt: bancada.time.now() + 5 * 60_000,
    })
    await tick()
    bancada.time.advance(2 * 60_000) // 2 minutos depois

    await bancada.tratar(comandoDoDono('/status'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)
    bancada.nucleo.onAck({ v: 1, type: 'ack', requestId, result: 'accepted', state: 'READY' })
    await tick()

    // A resposta de /status EDITA a mensagem da difusao in-place (TG-028).
    const edicao = bancada.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    const texto = edicao.texto
    // CONTRATO §5: /status usa o texto CURTO (1-3 linhas PT-BR, sem Sequencia).
    assert.match(texto, /Túnel \*online\* há 2 min/u)
    assert.match(texto, /Link: https:\/\/exemplo\.trycloudflare\.com/u)
    assert.match(texto, /Expira daqui a 3 min/u)
    assert.ok(!texto.includes('Sequência'), 'a linha de debug/seq fica so no log')
  })

  it('fora de READY nao ha URL: a difusao de STARTING nao a divulga', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    bancada.nucleo.onState({ v: 1, type: 'state', state: 'STARTING', seq: 3 })
    await tick()

    await bancada.tratar(comandoDoDono('/status'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)
    bancada.nucleo.onAck({ v: 1, type: 'ack', requestId, result: 'accepted', state: 'STARTING' })
    await tick()

    const edicao = bancada.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    const texto = edicao.texto
    assert.match(texto, /Túnel a ligar/u)
    assert.ok(!texto.includes('https://'), 'a URL so existe em READY')
    assert.ok(!texto.includes('Túnel: https'), 'a URL so existe em READY')
  })

  it('o intent tunnel.status nao estende o TTL (leitura pura)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/status'))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'tunnel.status')
    assert.equal(Object.hasOwn(intent, 'nonce'), false)
  })
})

/* ========================================================================== */
/* TG-087: /emergencia — derruba tunel e worker, responde uma vez, idempotente */
/* ========================================================================== */

describe('TG-087: /emergencia — derruba tunel e worker, responde uma vez, idempotente', () => {
  it('envia o intent emergency SEM nonce e responde UMA vez', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/emergencia'))

    assert.equal(bancada.ipc.intents.length, 1)
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'emergency')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'CTL-024: a acao que reduz nao exige nonce')
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Emergência disparada\. Túnel a desligar/u)
    assert.equal(bancada.paradas(), 1, 'o worker foi derrubado')
  })

  it('o segundo /emergencia e IDEMPOTENTE: nada de novo', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/emergencia'))
    const intents = bancada.ipc.intents.length
    const mensagens = bancada.sender.mensagens.length

    await bancada.tratar(comandoDoDono('/emergencia'))

    assert.equal(bancada.ipc.intents.length, intents, 'nenhum intent novo')
    assert.equal(bancada.sender.mensagens.length, mensagens, 'nenhuma resposta nova')
    assert.equal(bancada.paradas(), 1, 'o worker nao e derrubado duas vezes')
  })

  it('o botao de um notify (da auth) derruba tudo e responde uma vez', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    bancada.nucleo.onNotify({ v: 1, type: 'notify', texto: 'alerta:auth-falha\nTentativa de acesso falhada.' })
    await tick()
    const botao = bancada.sender.mensagens.at(-1)?.opcoes?.actionRows?.[0]?.[0]?.token
    assert.ok(typeof botao === 'string')

    await bancada.tratar({
      kind: 'acao',
      identity: IDENTIDADE_DONO,
      action: 'emergency',
      token: botao,
      answerTarget: 'cq-3',
    })

    assert.equal(bancada.ipc.intents.at(-1)?.intent, 'emergency')
    assert.equal(bancada.paradas(), 1)
    assert.equal(bancada.sender.respostas.length, 1, 'o clique do botao foi respondido (TG-027)')
  })
})

/* ========================================================================== */
/* AUTOLINK (onda1): /ligar -> READY -> o link da chave de acesso sai          */
/* ========================================================================== */

describe('autolink: /ligar -> READY -> o link da chave de acesso sai', () => {
  it('confirma o /ligar, o tunel fica READY e pede session.issue UMA vez', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/ligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.up', token, messageDoBotao(bancada)))

    assert.equal(bancada.ipc.intents.length, 1, 'so o tunnel.up apos a confirmacao')
    assert.equal(bancada.ipc.intents[0]?.intent, 'tunnel.up')

    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)
    bancada.nucleo.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
    bancada.nucleo.onState(starting(1))
    bancada.nucleo.onState(ready(2))

    assert.equal(bancada.ipc.intents.length, 2, 'o autolink pediu session.issue')
    const pedido = bancada.ipc.intents[1]
    assert.ok(pedido !== undefined)
    assert.equal(pedido.intent, 'session.issue')
    assert.equal(pedido.userKey, DONO, 'a identidade do /ligar do dono (chave STRING neutra)')
    assert.equal(Object.hasOwn(pedido, 'nonce'), false, 'session.issue nao exige nonce (TG-085)')
  })

  it('o notify que o host devolve ao READY renderiza UMA mensagem com ?key= e NAO com #mk=', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/ligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.up', token, messageDoBotao(bancada)))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)
    bancada.nucleo.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
    bancada.nucleo.onState(ready(1))

    bancada.nucleo.onNotify({
      v: 1,
      type: 'notify',
      texto:
        'alerta:link-magico\nSeu link com a chave de acesso (abre e entra, sem senha):\nhttps://x.trycloudflare.com/?key=ABC234GHJ5678LMNPQRSTVWXYZ234567',
    })
    await tick()

    const textosComLink = bancada.sender.mensagens
      .map((m) => m.texto)
      .filter((t) => t.includes('x.trycloudflare.com'))
    assert.equal(textosComLink.length, 1, 'exatamente UMA mensagem do link')
    assert.match(textosComLink[0] ?? '', /\?key=/u, 'a chave vai na query ?key=')
    assert.ok(!(textosComLink[0] ?? '').includes('#mk='), 'NAO usa o fragmento #mk=')
    assert.match(textosComLink[0] ?? '', /sem senha/u, 'o texto anuncia acesso sem senha')
  })

  it('dedupe: difusoes seguintes de READY (mesma ligacao) NAO reenviam o pedido', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/ligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.up', token, messageDoBotao(bancada)))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)

    bancada.nucleo.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
    bancada.nucleo.onState(ready(1))
    assert.equal(bancada.ipc.intents.length, 2, 'primeiro READY pede o link')

    bancada.nucleo.onState(ready(2))
    bancada.nucleo.onState(ready(3))
    assert.equal(bancada.ipc.intents.length, 2, 'o autolink e de UMA ligacao')
  })

  it('confirma o /desligar e o tunel READY — nenhum session.issue', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/desligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.down', token, messageDoBotao(bancada)))

    assert.equal(bancada.ipc.intents.length, 1, 'so o tunnel.down')
    assert.equal(bancada.ipc.intents[0]?.intent, 'tunnel.down')

    bancada.nucleo.onState(starting(1))
    bancada.nucleo.onState(ready(2))

    assert.equal(bancada.ipc.intents.length, 1, 'sem autolink no /desligar: nenhum session.issue')
  })

  it('tunnel.up accepted mas ack noop (o tunel JÁ estava READY) — nenhum link', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/ligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.up', token, messageDoBotao(bancada)))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)

    bancada.nucleo.onAck({ v: 1, type: 'ack', requestId: upRequest, result: 'noop', state: 'READY' })
    bancada.nucleo.onState(ready(1))

    assert.equal(bancada.ipc.intents.length, 1, 'noop em READY nao gera link (nao ha ligacao nova)')
  })

  it('tunnel.up rejected (nonce invalido) — nenhum link', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/ligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.up', token, messageDoBotao(bancada)))
    const upRequest = bancada.ipc.intents[0]?.requestId
    assert.ok(upRequest !== undefined)

    bancada.nucleo.onAck({
      v: 1,
      type: 'ack',
      requestId: upRequest,
      result: 'rejected',
      state: 'STOPPED',
      code: 'NONCE_INVALID',
    })
    bancada.nucleo.onState(ready(1))

    assert.equal(bancada.ipc.intents.length, 1, 'tunnel.up recusado nao arma autolink')
  })

  it('a confirmacao pose /ligar o nonce OPACO viaja no intent (S5)', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/ligar'))
    const token = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.up', token, messageDoBotao(bancada)))

    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.nonce, token, 'o token do botao vai tal e qual no nonce do intent (S5)')
  })
})
/* ========================================================================== */
/* CONTRATO §4/: /menu (cartao de controlo), /ajuda, cartao edit-in-place e   */
/* os botoes do cartao que INICIAM os fluxos, com toast do §4                */
/* ========================================================================== */

describe('CONTRATO §4/: cartao de controlo (/menu), ajudas e navegacao local', () => {
  /** Abre o cartao e devolve o `messageTarget` (id) da mensagem do cartao. */
  async function abrirCartao(bancada: Bancada): Promise<string> {
    await bancada.tratar(comandoDoDono('/menu'))
    const cartao = bancada.sender.mensagens.at(-1)
    assert.ok(cartao !== undefined, 'o /menu manda o cartao')
    return cartao.id
  }

  it('/menu abre o cartao de controlo com o titulo e o teclado do §4 (só o dono)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/menu'))

    const cartao = bancada.sender.mensagens.at(-1)
    assert.ok(cartao !== undefined)
    assert.match(cartao.texto, /🎛️ Controlo do Harness/u)
    const linhas = cartao.opcoes?.actionRows
    assert.ok(linhas !== undefined)
    const rotulos = linhas.flat().map((b) => b.label)
    assert.deepEqual(rotulos, [
      '🟢 Ligar',
      '🔴 Desligar',
      '📶 Status',
      '🔗 Link de acesso',
      '⇄ Nova chave',
      '🚨 Emergência',
      '🏠 Início',
    ])
  })

  it('um estranho NAO abre o cartao: /menu e descartado em silencio (TG-089)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.sender.mensagens.length
    await bancada.tratar({
      kind: 'comando',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      text: '/menu',
    })
    assert.equal(bancada.sender.mensagens.length, antes, 'o estranho nao ve o cartao')
    assert.match(bancada.log.all(), /deny:not-allowlisted/u)
  })

  it('o botao `🟢 Ligar` DO CARTAO INICIA o fluxo de ligar (tela de confirmacao) e toast `Ligando…`', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const cartaoId = await abrirCartao(bancada)
    const antes = bancada.ipc.intents.length
    const botao = bancada.sender.mensagens.at(-1)?.opcoes?.actionRows?.flat().find((b) => b.label === '🟢 Ligar')
    assert.ok(botao !== undefined)

    await bancada.tratar(accaoDoDono('tunnel.up', botao.token, cartaoId))

    // Iniciou: pediu o nonce e mandou a tela de confirmacao NO CARD nao no intent.
    assert.equal(bancada.ipc.intents.length, antes, 'a iniciacao ainda nao envia o intent (2a etapa)')
    const resp = bancada.sender.respostas.at(-1)
    assert.equal(resp?.outras?.text, 'Ligando…', 'toast do §4 no clique do cartao')
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Ligar o túnel agora\?/u)
  })

  it('o botao `🔴 Desligar` DO CARTAO INICIA /desligar (confirmacao destrutiva) e toast `Desligando…`', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const cartaoId = await abrirCartao(bancada)
    const botao = bancada.sender.mensagens.at(-1)?.opcoes?.actionRows?.flat().find((b) => b.label === '🔴 Desligar')
    assert.ok(botao !== undefined)

    await bancada.tratar(accaoDoDono('tunnel.down', botao.token, cartaoId))

    assert.equal(bancada.ipc.intents.length, 0, 'a iniciacao ainda nao confirma')
    const resp = bancada.sender.respostas.at(-1)
    assert.equal(resp?.outras?.text, 'Desligando…', 'toast do §4 no clique do cartao')
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Desligar o túnel derruba o acesso remoto/u)
  })

  it('o botao `🏠 Início` re-exibe o cartao (nav local, sem intent)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const cartaoId = await abrirCartao(bancada)
    const botao = bancada.sender.mensagens.at(-1)?.opcoes?.actionRows?.flat().find((b) => b.label === '🏠 Início')
    assert.ok(botao !== undefined)

    await bancada.tratar(accaoDoDono('inicio', botao.token, cartaoId))

    assert.equal(bancada.ipc.intents.length, 0, 'nav nunca vai ao host')
  })

  it('/ajuda mostra a ajuda curta ao dono (sem intent)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/ajuda'))
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /ℹ️ Este bot controla o acesso/u)
    assert.equal(bancada.ipc.intents.length, 0)
  })

  it('o fallback (`Não entendi…`) so ao dono; um texto livre do dono ganha os botoes do §6', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('texto de graca'))
    const msg = bancada.sender.mensagens.at(-1)
    assert.ok(msg !== undefined)
    assert.equal(msg.texto, 'Não entendi. Queres fazer o quê?')
    const rotulos = msg.opcoes?.actionRows?.flat().map((b) => b.label) ?? []
    assert.deepEqual(rotulos, ['🔘 Abrir menu', '📶 Estado', 'ℹ️ Ajuda'])
  })
})
