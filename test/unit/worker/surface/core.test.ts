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
  runsTerminadosDesde,
  textoDeRecusa,
  type ComandoPublicado,
} from '../../../../worker/surface/core.ts'
import {
  RESPOSTA_AGUARDANDO_CANCELADO,
  RESPOSTA_AGUARDANDO_EXPIROU,
  RESPOSTA_PEDIR_VALOR,
  RESPOSTA_PEDIR_VALOR_MALFORMADO,
} from '../../../../worker/surface/auth.ts'
import type { IpcErrorCode } from '../../../../src/contracts/ipc.ts'
import { comandoDoDono, DONO, ESTRANHO, IDENTIDADE_DONO, montarBancada, tick, type Bancada } from './apoio.ts'

const URL_TUNEL = 'https://x.trycloudflare.com'

/** Estado READY no formato do contrato IPC. */
function ready(seq: number): IpcStateMessage {
  return { v: 2, type: 'state', state: 'READY', seq, url: URL_TUNEL, expiresAt: 9_000 }
}

function starting(seq: number): IpcStateMessage {
  return { v: 2, type: 'state', state: 'STARTING', seq }
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
      { command: 'parear', description: 'Parear com um código' },
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
    bancada.nucleo.onState({ v: 2, type: 'state', state: 'STOPPED', seq: 1 })
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
    bancada.nucleo.onError({ v: 2, type: 'error', requestId: 'r-inexistente', code: 'INTERNAL', message: 'erro orfao' })
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

    bancada.nucleo.onError({ v: 2, type: 'error', requestId: intent.requestId, code: 'TUNNEL_FAILED', message: 'o tunel caiu' })
    await tick(6)

    assert.equal(bancada.sender.edicoes.length, 0, 'o erro nao edita in-place')
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /o tunel caiu/u)
  })

  it('notify so com o marcador (sem corpo): nada a mostrar, aviso em log', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.sender.mensagens.length
    bancada.nucleo.onNotify({ v: 2, type: 'notify', texto: 'alerta:sessao-nova' })
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
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: primeiroRequestId, result: 'accepted', state: 'STARTING' })
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
      v: 2,
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
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId, result: 'accepted', state: 'READY' })
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
    bancada.nucleo.onState({ v: 2, type: 'state', state: 'STARTING', seq: 3 })
    await tick()

    await bancada.tratar(comandoDoDono('/status'))
    const requestId = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestId !== undefined)
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId, result: 'accepted', state: 'STARTING' })
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

    bancada.nucleo.onNotify({ v: 2, type: 'notify', texto: 'alerta:auth-falha\nTentativa de acesso falhada.' })
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
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
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
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
    bancada.nucleo.onState(ready(1))

    bancada.nucleo.onNotify({
      v: 2,
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

    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: upRequest, result: 'accepted', state: 'STARTING' })
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

    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: upRequest, result: 'noop', state: 'READY' })
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
      v: 2,
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
    assert.match(cartao.texto, /🎛 Remote Access/u)
    const linhas = cartao.opcoes?.actionRows
    assert.ok(linhas !== undefined)
    // Teclado do cartao: UMA acao por linha (coluna unica), sem o botao Inicio.
    const rotulos = linhas.map((linha) => linha.map((b) => b.label))
    assert.deepEqual(rotulos, [
      ['🟢 Ligar'],
      ['🔴 Desligar'],
      ['📶 Status'],
      // Onda 5: os agentes ganham botao proprio (a resposta e o agent.report).
      ['🤖 Agentes'],
      ['🔗 Link de acesso'],
      ['⇄ Nova chave'],
      ['🚨 Emergência'],
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

  it('o botao `🟢 Ligar` DO CARTAO INICIA o fluxo de ligar: toast `Ligando…` + EDITA o mesmo cartao (confirmacao)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const cartaoId = await abrirCartao(bancada)
    const antesIntents = bancada.ipc.intents.length
    const antesMensagens = bancada.sender.mensagens.length
    const botao = bancada.sender.mensagens.at(-1)?.opcoes?.actionRows?.flat().find((b) => b.label === '🟢 Ligar')
    assert.ok(botao !== undefined)

    await bancada.tratar(accaoDoDono('tunnel.up', botao.token, cartaoId))

    // Iniciou: ainda NAO envia o intent (2a etapa) e responde ao clique.
    assert.equal(bancada.ipc.intents.length, antesIntents, 'a iniciacao ainda nao envia o intent (2a etapa)')
    const resp = bancada.sender.respostas.at(-1)
    assert.equal(resp?.outras?.text, 'Ligando…', 'toast do §4 no clique do cartao')
    // FIX do Ligar (Tarefa 1): o confirm reutiliza o MESMO messageTarget — o
    // cartao foi EDITADO in-place com a tela de confirmacao, sem mensagem nova.
    assert.equal(bancada.sender.mensagens.length, antesMensagens, 'o confirm edita o cartao, NAO envia mensagem nova')
    const edicao = bancada.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined, 'o cartao foi editado para a confirmacao')
    assert.equal(edicao.messageId, cartaoId, 'o confirm reutiliza o MESMO messageTarget (cartao)')
    assert.match(edicao.texto, /Ligar o túnel agora\?/u)
  })

  it('o botao `🔴 Desligar` DO CARTAO INICIA /desligar: toast `Desligando…` + EDITA o mesmo cartao', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const cartaoId = await abrirCartao(bancada)
    const botao = bancada.sender.mensagens.at(-1)?.opcoes?.actionRows?.flat().find((b) => b.label === '🔴 Desligar')
    assert.ok(botao !== undefined)

    await bancada.tratar(accaoDoDono('tunnel.down', botao.token, cartaoId))

    assert.equal(bancada.ipc.intents.length, 0, 'a iniciacao ainda nao confirma')
    const resp = bancada.sender.respostas.at(-1)
    assert.equal(resp?.outras?.text, 'Desligando…', 'toast do §4 no clique do cartao')
    const edicao = bancada.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.equal(edicao.messageId, cartaoId, 'o desligar tambem edita o mesmo cartao')
    assert.match(edicao.texto, /Desligar o túnel derruba o acesso remoto/u)
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

/* ========================================================================== */
/* Onda 5 — CONTRATO §4 Regra 4: botao de CANCELAMENTO das confirmacoes        */
/* ========================================================================== */

describe('CONTRATO §4 Regra 4 / Onda 5: cancelamento local das confirmacoes', () => {
  /** Carpeta conveniente para a acao `cancel` (token local opaco de um botao). */
  function cancelDoDono(messageTarget?: string): SurfaceActionEvent {
    return accaoDoDono('cancel', 'tok-cancel', messageTarget)
  }

  it('cancelar responde `Ok, cancelado.` e edita a mensagem para o texto de cancelado, SEM intent', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.ipc.intents.length
    const confirmId = 'msg-confirmacao'

    await bancada.tratar(cancelDoDono(confirmId))

    // NENHUM intent (nao executa, nao rotaciona nonce, nao muda estado do host).
    assert.equal(bancada.ipc.intents.length, antes, 'cancelar nao envia intent')
    // TG-027: responder ao clique com o texto de cancelado.
    const resp = bancada.sender.respostas.at(-1)
    assert.equal(resp?.outras?.text, 'Ok, cancelado.')
    // Edita a propria mensagem da confirmacao para o texto de cancelado.
    const edicao = bancada.sender.edicoes.at(-1)
    assert.equal(edicao?.messageId, confirmId)
    assert.equal(edicao?.texto, 'Cancelado. Nada foi alterado.')
    // SEM actionRows: converge, na chegada ao adaptador, em teclado destruido
    // (anti duplo-toque — CONTRATO §4 Regra 2).
    assert.equal(edicao?.opcoes?.actionRows, undefined, 'o teclado e destruido ao cancelar')
  })

  it('cancelar SEM messageTarget so responde; nao inventa destino de edicao', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antesEdicoes = bancada.sender.edicoes.length

    await bancada.tratar(cancelDoDono(undefined))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.sender.respostas.at(-1)?.outras?.text, 'Ok, cancelado.', 'TG-027 sempre')
    assert.equal(bancada.sender.edicoes.length, antesEdicoes, 'sem messageTarget nao ha o que editar')
  })

  it('cancelar depois do clique positivo NAO desarma o autolink que o positivo armou', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    // O /ligar armou o nonce na tela; o clique POSITIVO confirma (autolink armado).
    await bancada.tratar(comandoDoDono('/ligar'))
    const nonceToken = tokenDoBotao(bancada)
    await bancada.tratar(accaoDoDono('tunnel.up', nonceToken, messageDoBotao(bancada)))
    assert.equal(bancada.ipc.intents.length, 1, 'o positivo ja confirmou tunnel.up')

    // Um cancelar DEPOIS nao desfaz nada: nao re-serializa, nao novo intent.
    const antes = bancada.ipc.intents.length
    await bancada.tratar(cancelDoDono(messageDoBotao(bancada)))
    assert.equal(bancada.ipc.intents.length, antes, 'o cancelar nao envia intent nem desarma o confirmado')

    // O autolink daquela ligacao ainda VIVE: READY pede session.issue UMA vez.
    bancada.nucleo.onState(ready(7))
    await tick()
    assert.equal(bancada.ipc.intents.length, antes + 1, 'session.issue continua a sair (autolink intacto)')
    assert.equal(bancada.ipc.intents.at(-1)?.intent, 'session.issue')
  })

  it('um estranho que clique em cancelar e descartado em silencio (TG-089): answer VAZIO, sem edicao', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.sender.edicoes.length
    const antesInt = bancada.ipc.intents.length

    await bancada.tratar({ kind: 'acao', identity: { userKey: ESTRANHO, chatKey: ESTRANHO }, action: 'cancel', token: 'tok-estranho', answerTarget: 'cq-x', messageTarget: 'm-1' })

    assert.equal(bancada.ipc.intents.length, antesInt, 'sem intent')
    assert.equal(bancada.sender.edicoes.length, antes, 'sem edicao para o estranho')
    const resp = bancada.sender.respostas.at(-1)
    assert.equal(resp?.outras, undefined, 'answer VAZIO para o estranho — sem oraculo')
    assert.match(bancada.log.all(), /deny:not-allowlisted/u)
  })
})

/* ========================================================================== */
/* runsTerminadosDesde — a base da difusao proativa (teste directo)           */
/* ========================================================================== */

/** Um run sintetico para o teste directo do diff de terminados. */
function corrido(id: string, status: 'running' | 'done' | 'failed' | 'cancelled') {
  return { id, skill: 'eco', status, startedAt: 1_000 }
}

describe('runsTerminadosDesde — quais runs contam como «terminados»', () => {
  it('sem historico (primeiro report), todos os terminais contam; os vivos nao', () => {
    const terminados = runsTerminadosDesde(undefined, [
      corrido('A', 'done'),
      corrido('B', 'running'),
      corrido('C', 'failed'),
    ])
    assert.deepEqual(terminados.map((r) => r.id), ['A', 'C'])
  })

  it('com historico, so os que mudaram de vivo (ou ausente) para terminal contam', () => {
    const anterior = [corrido('A', 'running'), corrido('B', 'done'), corrido('D', 'cancelled')]
    const terminados = runsTerminadosDesde(anterior, [
      corrido('A', 'done'), // mudou: conta
      corrido('B', 'done'), // ja estava terminal: nao conta
      corrido('C', 'failed'), // ausente antes (podado): conta
      corrido('D', 'cancelled'), // ja estava: nao conta
      corrido('E', 'running'), // vivo: nao conta
    ])
    assert.deepEqual(terminados.map((r) => r.id), ['A', 'C'])
  })

  it('status terminal -> running (impossivel no host, mas defensivo) nao conta', () => {
    const terminados = runsTerminadosDesde(
      [corrido('A', 'done')],
      [corrido('A', 'running')],
    )
    assert.equal(terminados.length, 0)
  })

  it('relatorio VAZIO devolve vazio, mesmo com historico cheio (nada novo, nada a notificar)', () => {
    assert.deepEqual(runsTerminadosDesde([corrido('A', 'running'), corrido('B', 'done')], []), [])
    assert.deepEqual(runsTerminadosDesde(undefined, []), [])
  })

  it('um run que ESTAVA no historico e SUMIU do report atual nao e notificado (a lista atual e a fonte)', () => {
    // O host pode podar runs de memoria entre difusoes: o que desapareceu nao
    // pode ser anunciado como «terminado agora» — a lista ATUAL e a verdade.
    const terminados = runsTerminadosDesde([corrido('A', 'running'), corrido('B', 'done')], [corrido('B', 'done')])
    assert.deepEqual(terminados.map((r) => r.id), [])
  })
})

/* ========================================================================== */
/* Onda 5 — OS AGENTES NA SUPERFICIE: /agente, /agentes, /parar-agente e a   */
/* difusao proativa do agent.report                                           */
/* ========================================================================== */

describe('Onda 5: /agente — 2 etapas com nonce, dispatch com params, ack final', () => {
  it('confirma o /agente: o clique envia agent.dispatch com nonce + params e o ack edita a confirmacao', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/agente eco diz oi'))
    assert.equal(bancada.ipc.intents.length, 0, 'a 1a etapa nao envia intent (2 etapas)')
    const confirmacao = bancada.sender.mensagens.at(-1)
    assert.ok(confirmacao !== undefined)
    assert.match(confirmacao.texto, /Disparar o agente "eco"\?/u)
    const botao = confirmacao.opcoes?.actionRows?.[0]?.[0]
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'agent.dispatch')
    assert.equal(botao.label, '✅ Sim, disparar')

    await bancada.tratar(accaoDoDono('agent.dispatch', botao.token, confirmacao.id))

    assert.equal(bancada.ipc.intents.length, 1, 'so o dispatch apos a confirmacao')
    const intent = bancada.ipc.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.dispatch')
    assert.equal(intent.nonce, botao.token, 'o nonce (o token do botao) viaja OPACO (S5)')
    assert.deepEqual(intent.params, { skill: 'eco', prompt: 'diz oi' })
    assert.equal(bancada.sender.respostas.length, 1, 'o clique foi respondido (TG-027)')

    // O ack accepted edita a MENSAGEM DA CONFIRMACAO in-place (TG-028).
    const requestId = intent.requestId
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId, result: 'accepted', state: 'STOPPED' })
    await tick()
    const edicao = bancada.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.equal(edicao.messageId, confirmacao.id)
    assert.equal(edicao.texto, 'Agente disparado. O resultado chega aqui quando terminar.')
  })

  it('o `✕ Não` da confirmacao do /agente cancela SEM intent (Regra 4)', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/agente eco diz oi'))
    const confirmacao = bancada.sender.mensagens.at(-1)
    assert.ok(confirmacao !== undefined)
    const cancel = confirmacao.opcoes?.actionRows?.[0]?.find((b) => b.action === 'cancel')
    assert.ok(cancel !== undefined)

    await bancada.tratar(accaoDoDono('cancel', cancel.token, confirmacao.id))

    assert.equal(bancada.ipc.intents.length, 0, 'cancelar nao envia intent')
    assert.equal(bancada.sender.respostas.at(-1)?.outras?.text, 'Ok, cancelado.')
  })

  it('/agente sem skill mostra a instrucao de uso, sem intent', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/agente'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(
      bancada.sender.mensagens.at(-1)?.texto,
      'Uso: /agente <skill> <o que o agente deve fazer>',
    )
  })

  it('/agente sem prompt mostra a instrucao de uso, sem intent', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/agente eco'))

    assert.equal(bancada.ipc.intents.length, 0)
    // O duplo responde com o uso; a distincao EXACTA (Falta o prompt vs uso) e
    // do modulo real de comandos (commands.test.ts) — aqui so o funil importa.
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Uso: \/agente/u)
  })

  it('sem nonce do host, /agente falha FECHADO (CTL-023) — sem intent nem botao', async () => {
    const bancada = montarBancada({ emitirNonce: async () => undefined })
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/agente eco diz oi'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Não foi possível obter a confirmação/u)
  })

  it('ack noop do agent.dispatch cobre o tipo: «Já estava assim.» (o host nunca o envia — defesa)', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/agente eco diz oi'))
    const confirmacao = bancada.sender.mensagens.at(-1)
    assert.ok(confirmacao !== undefined)
    const botao = confirmacao.opcoes?.actionRows?.[0]?.[0]
    assert.ok(botao !== undefined)
    await bancada.tratar(accaoDoDono('agent.dispatch', botao.token, confirmacao.id))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)

    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: intent.requestId, result: 'noop', state: 'STOPPED' })
    await tick()

    const edicao = bancada.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined)
    assert.equal(edicao.messageId, confirmacao.id)
    assert.equal(edicao.texto, 'Já estava assim.')
  })
})

describe('Onda 5 fix recusa visivel: a recusa de um intent de AGENTE chega ao dono SEMPRE', () => {
  /**
   * Dispara um /agente confirmado e devolve o requestId do dispatch pendente.
   * A RECUSA do host (skill nao autorizada / teto / harness) chega como `error`
   * COM esse requestId — e o pendente (guardado por `acao`) que o correlaciona.
   */
  async function dispararAgente(bancada: Bancada): Promise<string> {
    await bancada.tratar(comandoDoDono('/agente eco diz oi'))
    const confirmacao = bancada.sender.mensagens.at(-1)
    assert.ok(confirmacao !== undefined)
    const botao = confirmacao.opcoes?.actionRows?.[0]?.[0]
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'agent.dispatch')
    await bancada.tratar(accaoDoDono('agent.dispatch', botao.token, confirmacao.id))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.dispatch')
    return intent.requestId
  }

  it('com o cartao VISIVEL, a recusa de agent.dispatch chega ao dono como mensagem propria (nao so re-render)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    // /menu abre o cartao: dali em diante `mostrarEstado` re-renderiza-o e
    // DESCARTE o texto — o bug reproduzido (0 mensagens, 1 re-render).
    await bancada.tratar(comandoDoDono('/menu'))
    const cartao = bancada.sender.mensagens.at(-1)
    assert.ok(cartao !== undefined)

    const requestId = await dispararAgente(bancada)
    const mensagensAntesDoErro = bancada.sender.mensagens.length
    bancada.nucleo.onError({
      v: 2,
      type: 'error',
      requestId,
      code: 'INTERNAL',
      message: 'A skill "eco" nao esta autorizada neste plugin (config agents.skills).',
    })
    await tick(6)

    // A recusa e UMA mensagem propria NOVA, com o texto accionavel do host.
    assert.equal(bancada.sender.mensagens.length, mensagensAntesDoErro + 1, 'a recusa sai como mensagem propria')
    const recusa = bancada.sender.mensagens.at(-1)
    assert.ok(recusa !== undefined)
    assert.match(recusa.texto, /nao esta autorizada/u)
    // NUNCA um re-render do cartao que engula o texto.
    const reRenders = bancada.sender.edicoes.filter((e) => e.messageId === cartao.id)
    assert.equal(reRenders.length, 0, 'o cartao nao e re-renderizado com a recusa')
  })

  it('sem cartao, a recusa de agent.dispatch chega ao dono como mensagem propria', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    const requestId = await dispararAgente(bancada)
    bancada.nucleo.onError({
      v: 2,
      type: 'error',
      requestId,
      code: 'INTERNAL',
      message: 'Ja ha agentes a correr ate o limite (config agents.maxRuns). Espera um terminar ou cancela um.',
    })
    await tick(6)

    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /ate o limite/u)
  })

  it('o error de agent.status (botao Agentes DO CARTAO) tambem chega ao dono como mensagem propria', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/menu'))
    const cartao = bancada.sender.mensagens.at(-1)
    assert.ok(cartao !== undefined)
    const botao = cartao.opcoes?.actionRows?.flat().find((b) => b.label === '🤖 Agentes')
    assert.ok(botao !== undefined)

    await bancada.tratar(accaoDoDono('agent.status', botao.token, cartao.id))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.status')
    const mensagensAntes = bancada.sender.mensagens.length

    bancada.nucleo.onError({
      v: 2,
      type: 'error',
      requestId: intent.requestId,
      code: 'INTERNAL',
      message: 'Este comando ainda nao esta disponivel nesta instalacao.',
    })
    await tick(6)

    assert.equal(bancada.sender.mensagens.length, mensagensAntes + 1, 'a recusa sai como mensagem propria')
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /nao esta disponivel/u)
    const reRenders = bancada.sender.edicoes.filter((e) => e.messageId === cartao.id)
    assert.equal(reRenders.length, 0, 'o cartao nao engole a recusa')
  })

  it('regressao zero: error de OUTRA intent (tunnel.status) com cartao visivel CONTINUA no comportamento atual (re-render, sem mensagem)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/menu'))
    const cartao = bancada.sender.mensagens.at(-1)
    assert.ok(cartao !== undefined)

    await bancada.tratar(comandoDoDono('/status'))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'tunnel.status')
    const mensagensAntes = bancada.sender.mensagens.length
    const edicoesAntes = bancada.sender.edicoes.length

    bancada.nucleo.onError({
      v: 2,
      type: 'error',
      requestId: intent.requestId,
      code: 'TUNNEL_FAILED',
      message: 'o tunel caiu',
    })
    await tick(6)

    // Comportamento atual PRESERVADO: nenhuma mensagem nova com o texto — o
    // cartao e re-renderizado (uma edicao do proprio cartao, sem o texto).
    assert.equal(bancada.sender.mensagens.length, mensagensAntes, 'nenhuma mensagem nova')
    const reRender = bancada.sender.edicoes.slice(edicoesAntes)
    assert.equal(reRender.length, 1, 'um re-render do cartao, como antes')
    const reRenderDaRecusa = reRender[0]
    assert.ok(reRenderDaRecusa !== undefined)
    assert.equal(reRenderDaRecusa.messageId, cartao.id)
    assert.ok(!reRenderDaRecusa.texto.includes('o tunel caiu'), 'o texto do erro nao aparece no cartao')
  })
})

describe('Onda 5: /agentes — a resposta e o agent.report, o ack e silencioso', () => {
  it('pede agent.status e, quando o report chega, renderiza a lista numa mensagem propria', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const agora = bancada.time.now()

    await bancada.tratar(comandoDoDono('/agentes'))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.status')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'leitura pura')

    // O host difunde a lista ANTES do ack (o padrao do tunnel.status).
    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [
        { id: '01HZAAAA', skill: 'eco', status: 'running', startedAt: agora - 2 * 60_000 },
        {
          id: '01HZBBBB',
          skill: 'dataviz',
          status: 'done',
          startedAt: agora - 5 * 60_000,
          summary: 'gráfico gerado',
        },
      ],
    })
    await tick()

    const msg = bancada.sender.mensagens.at(-1)
    assert.ok(msg !== undefined)
    assert.match(msg.texto, /🤖 Agentes:/u)
    assert.match(msg.texto, /01HZAAAA — eco — rodando há 2 min/u)
    assert.match(msg.texto, /01HZBBBB — dataviz — concluído há 5 min/u)
    assert.match(msg.texto, /💬 gráfico gerado/u)
    // Mensagem PROPIA: nunca edita o painel de estado com a lista.
    assert.equal(bancada.sender.edicoes.length, 0, 'a lista e enviada, nao editada por cima do cartao')

    // O ack noop de agent.status NAO renderiza nada por cima da lista.
    const antes = bancada.sender.mensagens.length
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: intent.requestId, result: 'noop', state: 'STOPPED' })
    await tick()
    assert.equal(bancada.sender.mensagens.length, antes, 'o ack de agent.status e silencioso')
  })

  it('lista vazia: «Nenhum agente rodando.»', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/agentes'))
    bancada.nucleo.onAgentReport({ v: 2, type: 'agent.report', runs: [] })
    await tick()

    assert.equal(bancada.sender.mensagens.at(-1)?.texto, 'Nenhum agente rodando.')
  })
})

describe('Onda 5: difusao proativa — um run termina e o dono e avisado', () => {
  it('report SEM agent.status pendente notifica so os runs que TERMINARAM desde o ultimo', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const agora = bancada.time.now()

    // 1o report: resposta a /agentes — a lista completa (2 runs, 1 terminal).
    await bancada.tratar(comandoDoDono('/agentes'))
    const requestDoStatus = bancada.ipc.intents.at(-1)?.requestId
    assert.ok(requestDoStatus !== undefined)
    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [
        { id: '01HZAAAA', skill: 'eco', status: 'running', startedAt: agora - 60_000 },
        { id: '01HZBBBB', skill: 'dataviz', status: 'done', startedAt: agora - 3 * 60_000, summary: 'ok' },
      ],
    })
    await tick()
    const depoisDaResposta = bancada.sender.mensagens.length

    // O ack de agent.status retira o pendente (em producao o host difunde a
    // lista e responde noop a seguir) — a partir daqui o report e difusao.
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: requestDoStatus, result: 'noop', state: 'STOPPED' })
    await tick()

    // 2o report: difusao PROATIVA (nenhum pendente) — so o 01HZAAAA terminou.
    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [
        { id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: agora - 60_000, summary: 'feito' },
        { id: '01HZBBBB', skill: 'dataviz', status: 'done', startedAt: agora - 3 * 60_000, summary: 'ok' },
      ],
    })
    await tick()

    assert.equal(bancada.sender.mensagens.length, depoisDaResposta + 1, 'uma notificacao proativa')
    const notificacao = bancada.sender.mensagens.at(-1)
    assert.ok(notificacao !== undefined)
    assert.match(notificacao.texto, /🤖 Atualização de agentes:/u)
    assert.match(notificacao.texto, /01HZAAAA — eco — concluído há 1 min/u)
    assert.match(notificacao.texto, /💬 feito/u)
    assert.ok(!notificacao.texto.includes('01HZBBBB'), 'o run que ja estava terminal nao repete')
  })

  it('o primeiro report proativo (sem historico) notifica os terminais que traz', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const agora = bancada.time.now()

    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [
        { id: '01HZAAAA', skill: 'eco', status: 'failed', startedAt: agora - 60_000 },
        { id: '01HZCCCC', skill: 'eco', status: 'running', startedAt: agora - 60_000 },
      ],
    })
    await tick()

    const notificacao = bancada.sender.mensagens.at(-1)
    assert.ok(notificacao !== undefined)
    assert.match(notificacao.texto, /01HZAAAA — eco — falhou há 1 min/u)
    assert.ok(!notificacao.texto.includes('01HZCCCC'), 'o run vivo nao notifica')
  })

  it('difusao sem mudanca terminal nao notifica nada', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const agora = bancada.time.now()
    const antes = bancada.sender.mensagens.length

    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [{ id: '01HZAAAA', skill: 'eco', status: 'running', startedAt: agora }],
    })
    await tick()

    assert.equal(bancada.sender.mensagens.length, antes, 'solo runs vivos: sem notificacao')
  })

  it('VARIOS runs terminam no MESMO report: UMA notificacao com as linhas de TODOS', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const agora = bancada.time.now()
    const depoisDoPareamento = bancada.sender.mensagens.length

    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [
        { id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: agora - 60_000, summary: 'feito' },
        { id: '01HZBBBB', skill: 'dataviz', status: 'failed', startedAt: agora - 2 * 60_000 },
        { id: '01HZCCCC', skill: 'eco', status: 'cancelled', startedAt: agora - 3 * 60_000 },
      ],
    })
    await tick()

    assert.equal(bancada.sender.mensagens.length, depoisDoPareamento + 1, 'uma unica notificacao proativa')
    const notificacao = bancada.sender.mensagens.at(-1)
    assert.ok(notificacao !== undefined)
    assert.match(notificacao.texto, /🤖 Atualização de agentes:/u)
    assert.match(notificacao.texto, /01HZAAAA — eco — concluído há 1 min/u)
    assert.match(notificacao.texto, /01HZBBBB — dataviz — falhou há 2 min/u)
    assert.match(notificacao.texto, /01HZCCCC — eco — cancelado há 3 min/u)
  })

  it('EM SEQUENCIA: a segunda difusao proativa notifica so o NOVO terminal, sem repetir o anterior', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const agora = bancada.time.now()

    // 1a difusao: o run A terminou (notificado).
    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [
        { id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: agora - 60_000, summary: 'feito' },
        { id: '01HZBBBB', skill: 'dataviz', status: 'running', startedAt: agora },
      ],
    })
    await tick()
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /01HZAAAA/u)

    // 2a difusao: agora o B terminou; o A ja era terminal no report anterior.
    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [
        { id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: agora - 60_000, summary: 'feito' },
        { id: '01HZBBBB', skill: 'dataviz', status: 'failed', startedAt: agora, summary: 'erro' },
      ],
    })
    await tick()

    const notificacao = bancada.sender.mensagens.at(-1)
    assert.ok(notificacao !== undefined)
    assert.match(notificacao.texto, /01HZBBBB — dataviz — falhou agora mesmo/u)
    assert.ok(!notificacao.texto.includes('01HZAAAA'), 'o run ja terminal nao repete a notificacao')
  })

  it('SEM DONO (worker sem pareamento): o report proativo e silencio total', async () => {
    const bancada = montarBancada()
    // Sem `paired()`: o nucleo nao tem dono — a difusao nao tem para onde ir.
    const antes = bancada.sender.mensagens.length

    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [{ id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: 1_000 }],
    })
    await tick()

    assert.equal(bancada.sender.mensagens.length, antes, 'sem dono nada e enviado')
  })

  it('best-effort (S4): a falha de envio da notificacao NAO derruba o canal', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    bancada.sender.falharEnvio = true

    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [{ id: '01HZAAAA', skill: 'eco', status: 'done', startedAt: 1_000 }],
    })
    await tick()

    // A falha foi registada (emSegundoPlano), nao propagada: o nucleo segue vivo.
    assert.match(bancada.log.all(), /falha ao renderizar para o chat/u)
    // E o canal continua a servir os proximos eventos sem rebentar.
    bancada.sender.falharEnvio = false
    bancada.nucleo.onAgentReport({
      v: 2,
      type: 'agent.report',
      runs: [{ id: '01HZBBBB', skill: 'eco', status: 'cancelled', startedAt: 1_000 }],
    })
    await tick()
    assert.equal(bancada.sender.mensagens.at(-1)?.texto.includes('01HZBBBB'), true, 'o canal seguiu vivo')
  })
})

describe('Onda 5: /parar-agente — o ack decide o texto com o id do run', () => {
  it('id valido: agent.cancel com params {agentId}; ack accepted responde «Agente <id> cancelado.»', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/parar-agente 01HZABCD'))

    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.cancel')
    assert.deepEqual(intent.params, { agentId: '01HZABCD' })
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'CTL-024: cancelar dispensa nonce')

    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STOPPED' })
    await tick()

    // Mensagem PROPIA — nunca edita o painel de estado.
    assert.equal(bancada.sender.mensagens.at(-1)?.texto, 'Agente 01HZABCD cancelado.')
    assert.equal(bancada.sender.edicoes.length, 0, 'a resposta do cancel e enviada, nao editada')
  })

  it('ack noop: «Agente <id> não encontrado.»', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/parar-agente 01HZABCD'))
    const intent = bancada.ipc.intents.at(-1)
    assert.ok(intent !== undefined)
    bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: intent.requestId, result: 'noop', state: 'STOPPED' })
    await tick()

    assert.equal(bancada.sender.mensagens.at(-1)?.texto, 'Agente 01HZABCD não encontrado.')
  })

  it('id fora da forma: recusado antes de ir ao host, com o uso', async () => {
    const bancada = montarBancada()
    await paired(bancada)

    await bancada.tratar(comandoDoDono('/parar-agente 12345'))

    assert.equal(bancada.ipc.intents.length, 0)
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Id inválido/u)
  })
})

describe('Onda 5: o cartao de controlo ganha o botao de Agentes', () => {
  it('o botao `🤖 Agentes` DO CARTAO acusa e pede a lista (agent.status)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    await bancada.tratar(comandoDoDono('/menu'))
    const cartao = bancada.sender.mensagens.at(-1)
    assert.ok(cartao !== undefined)
    const botao = cartao.opcoes?.actionRows?.flat().find((b) => b.label === '🤖 Agentes')
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'agent.status')

    await bancada.tratar(accaoDoDono('agent.status', botao.token, cartao.id))

    assert.equal(bancada.sender.respostas.at(-1)?.outras?.text, 'A consultar…', 'toast do §4 no clique')
    assert.equal(bancada.ipc.intents.at(-1)?.intent, 'agent.status', 'pediu a lista ao host')
  })

  it('um clique solto de agent.status fora do cartao e descartado (sem botao renderizado)', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.ipc.intents.length

    await bancada.tratar(accaoDoDono('agent.status', 'tok-solto', undefined))

    assert.equal(bancada.ipc.intents.length, antes, 'nenhum intent inventado')
    assert.equal(bancada.sender.respostas.length, 1, 'TG-027: o girador fecha')
  })

  it('um clique solto de agent.cancel (sem botao que o produza) e descartado', async () => {
    const bancada = montarBancada()
    await paired(bancada)
    const antes = bancada.ipc.intents.length

    await bancada.tratar(accaoDoDono('agent.cancel', 'tok-solto', undefined))

    assert.equal(bancada.ipc.intents.length, antes, 'sem intent inventado')
    assert.equal(bancada.sender.respostas.length, 1, 'TG-027')
  })
})

/* ========================================================================== */
/* CONVERSA INTELIGENTE ("skills pedem valores") — docs/ux/04-CONVERSA-       */
/* INTELIGENTE.md. O `/parear` vazio (clique no menu) pergunta o codigo e a   */
/* PROXIMA mensagem de texto puro do mesmo chat+user e a resposta.            */
/* ========================================================================== */

describe('CONVERSA INTELIGENTE: skills pedem valores', () => {
  const CODIGO = '123456' // o codigo fixo do FakeAuth da bancada

  it('`/parear` vazio (sem valor) PERGUNTA, e o estado armado captura a proxima mensagem no MESMO chat+user', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))

    // 1a pergunta (inocua e uniforme) + "aguardando" armado no MESMO tick.
    assert.equal(bancada.sender.mensagens.length, 1, 'so a pergunta, nada mais')
    assert.equal(bancada.sender.mensagens[0]?.texto, RESPOSTA_PEDIR_VALOR)

    // A proxima mensagem de TEXTO PURO do mesmo chat+user valida e pareia.
    await bancada.tratar(comandoDoDono(CODIGO))
    const textos = bancada.sender.mensagens.map((m) => m.texto)
    assert.equal(textos.filter((t) => /Pareado/u.test(t)).length, 1, 'o codigo certo pareia')
    // Dali em diante o dono comanda.
    await bancada.tratar(comandoDoDono('/status'))
    assert.equal(bancada.ipc.intents.at(-1)?.intent, 'tunnel.status')
  })

  it('o inline `/parear <codigo>` continua 100% funcional (mesmo fluxo, sem espera)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono(`/parear ${CODIGO}`))
    assert.equal(bancada.sender.mensagens.length, 1)
    assert.match(bancada.sender.mensagens[0]?.texto ?? '', /Pareado/u)
  })

  it('valor BEM-FORMADO errado do mesmo chat valida pelo MESMO budget (resposta uniforme + backoff)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    assert.equal(bancada.sender.mensagens.length, 1)
    const aguardandoAntes = bancada.time.now()

    // UMA captura: o valor bem-formado errado é debitado e recebe a resposta
    // uniforme; a espera e consumida (nao fica a repetir na mesma janela).
    await bancada.tratar(comandoDoDono('000000'))

    const textos = bancada.sender.mensagens.map((m) => m.texto)
    assert.equal(textos.filter((t) => t.includes('Código errado ou expirado')).length, 1, 'resposta uniforme')
    assert.ok(bancada.time.now() >= aguardandoAntes, 'o backoff dormiu pelo relogio injetado')
    assert.equal(bancada.ipc.pareamentos.length, 0, 'nada pareou')
    assert.equal(bancada.ipc.intents.length, 0)

    // A espera terminou: um segundo valor sem novo `/parear` NAO e capturado.
    const antes2 = bancada.sender.mensagens.length
    await bancada.tratar(comandoDoDono('111111'))
    assert.equal(bancada.sender.mensagens.length, antes2, 'o segundo valor nao re-abre a janela')
  })

  it('valor MALFORMADO re-pede SEM ecoar o texto e SEM debitar; a espera continua', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    await bancada.tratar(comandoDoDono('abc'))

    const textos = bancada.sender.mensagens.map((m) => m.texto)
    assert.equal(textos.some((t) => t.includes(RESPOSTA_PEDIR_VALOR_MALFORMADO)), true, 're-pede o formato')
    assert.equal(textos.some((t) => t.includes('abc')), false, 'NAO ecoa o que foi digitado')
    assert.equal(bancada.ipc.pareamentos.length, 0, 'malformado nao pareia')

    // A espera CONTINUA: o codigo certo a seguir ainda pareia.
    await bancada.tratar(comandoDoDono(CODIGO))
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Pareado/u)
  })

  it('UM comando NOVO durante a espera CANCELA o aguardando e roda normal (o texto de comando NUNCA e valor)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    assert.equal(bancada.sender.mensagens.length, 1, 'a pergunta')

    // `/menu` (um comando qualquer) durante a espera cancela e roda normal.
    await bancada.tratar(comandoDoDono('/menu'))
    // A espera acabou: o valor digita depois NAO e capturado (vai ao guard normal
    // — o user ainda nao pareou, logo nem chega a intent nem a resposta).
    const antes = bancada.sender.mensagens.length
    await bancada.tratar(comandoDoDono(CODIGO))
    assert.equal(bancada.sender.mensagens.length, antes, 'o valor pos-comando nao e capturado')
    assert.equal(bancada.ipc.intents.length, 0, 'sem intent para o texto "solto"')
    assert.equal(bancada.ipc.pareamentos.length, 0, 'nada pareou')
  })

  it('`/parear <codigo>` durante a espera cancela e valida inline (roda normal)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    assert.equal(bancada.sender.mensagens.length, 1, 'a pergunta')

    await bancada.tratar(comandoDoDono(`/parear ${CODIGO}`))
    assert.ok(
      bancada.sender.mensagens.some((m) => /Pareado/u.test(m.texto)),
      'o inline durante a espera pareia (cancela e roda normal)',
    )
  })

  it('`/cancelar` durante a espera cancela com `Ok, cancelado.` e o estado sai', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    await bancada.tratar(comandoDoDono('/cancelar'))

    assert.equal(bancada.sender.mensagens.at(-1)?.texto, RESPOSTA_AGUARDANDO_CANCELADO)
    // Estado removido: um valor a seguir NAO e capturado.
    const antes = bancada.sender.mensagens.length
    await bancada.tratar(comandoDoDono(CODIGO))
    assert.equal(bancada.sender.mensagens.length, antes, 'nada apos cancelar')
    assert.equal(bancada.ipc.pareamentos.length, 0)
  })

  it('texto puro `cancelar` / `não` durante a espera tambe cancela com `Ok, cancelado.`', async () => {
    for (const adeus of ['cancelar', 'não']) {
      const bancada = montarBancada()
      await bancada.tratar(comandoDoDono('/parear'))
      await bancada.tratar(comandoDoDono(adeus))
      assert.equal(bancada.sender.mensagens.at(-1)?.texto, RESPOSTA_AGUARDANDO_CANCELADO, `via <<${adeus}>>`)
    }
  })

  it('TIMEOUT da espera (relogio injetado): `O código expirou. Use /parear de novo.` e o valor tardio NAO valida', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    assert.equal(bancada.sender.mensagens.length, 1, 'a pergunta')

    bancada.time.advance(5 * 60_000 + 1) // ESPERA_TTL = 5 min (<= TTL do codigo)

    await bancada.tratar(comandoDoDono(CODIGO))
    assert.equal(bancada.sender.mensagens.at(-1)?.texto, RESPOSTA_AGUARDANDO_EXPIROU)
    assert.equal(bancada.ipc.pareamentos.length, 0, 'o valor tardio NAO valida')
    assert.equal(bancada.ipc.intents.length, 0)
  })

  it('TIMEOUT: um COMANDO tardio (depois do TTL) cancela em silencio e NAO manda o aviso de valor', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    bancada.time.advance(5 * 60_000 + 1)
    const antes = bancada.sender.mensagens.length

    await bancada.tratar(comandoDoDono('/menu'))
    assert.equal(bancada.sender.mensagens.length, antes, 'comando tardio e descartado/silencioso, sem aviso de valor')
  })

  it('valor de OUTRO chat (mesmo fluxo noutra conversa) NAO cruza para o fluxo daqui', async () => {
    const bancada = montarBancada()
    // ESTRANHO (222/222) arma a espera no chat 222.
    await bancada.tratar({ kind: 'comando', identity: { userKey: ESTRANHO, chatKey: ESTRANHO }, text: '/parear' })
    assert.equal(bancada.sender.mensagens.length, 1, 'a pergunta do estranho')
    // DONO (111/111) manda o codigo NO CHAT DELE — outra conversa, sem espera.
    await bancada.tratar(comandoDoDono(CODIGO))
    // A espera do chat 222 continua intacta, mas o valor do chat 111 nao pareia(aqui).
    assert.equal(bancada.ipc.pareamentos.length, 0, 'o codigo do chat do dono nao rouba a espera do estranho')
  })

  it('valor do MESMO chat mas de OUTRO user NAO e capturado (fica a esperar)', async () => {
    const bancada = montarBancada()
    await bancada.tratar({ kind: 'comando', identity: { userKey: DONO, chatKey: DONO }, text: '/parear' })
    assert.equal(bancada.sender.mensagens.length, 1, 'a pergunta')

    // Um terceiro no MESMO chat (chatKey=DONO) manda um valor de 6 digitos.
    await bancada.tratar({ kind: 'comando', identity: { userKey: '999', chatKey: DONO }, text: '999999' })
    assert.equal(bancada.ipc.pareamentos.length, 0, 'outro user nao captura o fluxo')

    // A espera CONTINUA para o dono: o codigo certo ainda pareia.
    await bancada.tratar(comandoDoDono(CODIGO))
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Pareado/u)
  })

  it('ESTRANHO: pergunta uniforme; valor bem-formado -> resposta uniforme + budget + backoff; botoes descartados (TG-089)', async () => {
    const bancada = montarBancada()
    await bancada.tratar({ kind: 'comando', identity: { userKey: ESTRANHO, chatKey: ESTRANHO }, text: '/parear' })
    assert.equal(bancada.sender.mensagens[0]?.texto, RESPOSTA_PEDIR_VALOR, 'a pergunta e uniforme para o estranho')

    await bancada.tratar({ kind: 'comando', identity: { userKey: ESTRANHO, chatKey: ESTRANHO }, text: '000000' })
    assert.equal(
      bancada.sender.mensagens.at(-1)?.texto,
      'Código errado ou expirado. Confere no painel e tenta de novo.',
      'valor bem-formado errado de estranho recebe a mesma resposta uniforme',
    )

    // O clique de estranho (botao/callback): descartado em silencio, answer vazio.
    const antesMsgs = bancada.sender.mensagens.length
    await bancada.tratar({
      kind: 'acao',
      identity: { userKey: ESTRANHO, chatKey: ESTRANHO },
      action: 'menu',
      token: 'AAAAAAAAAAA',
      answerTarget: 'cq-estranho',
    })
    assert.equal(bancada.sender.mensagens.length, antesMsgs, 'o clique de estranho nao gera mensagem')
    assert.equal(bancada.sender.respostas.at(-1)?.outras, undefined, 'answer vazio (sem oraculo)')
    assert.equal(bancada.ipc.intents.length, 0)
    assert.match(bancada.log.all(), /deny:not-configured|deny:not-allowlisted/u)
  })

  it('o sender NUNCA ecoa o valor/codigo do user em nenhum caminho (audit e saida limpos)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    await bancada.tratar(comandoDoDono('12a45')) // malformado (nao 6 digitos)
    await bancada.tratar(comandoDoDono('777777')) // bem-formado errado
    await bancada.tratar(comandoDoDono(CODIGO)) // mais um valor (ja sem espera)

    // O valor DIGITADO pelo user nunca ecoa. Distinguimos dos literais fixos:
    // '123456' circula como EXEMPLO estatico da re-pergunta (ok), o resto nao.
    for (const msg of bancada.sender.mensagens) {
      assert.equal(msg.texto.includes('12a45'), false, `sender ecoou o malformado: <<${msg.texto}>>`)
      assert.equal(msg.texto.includes('777777'), false, `sender ecoou o bem-formado errado: <<${msg.texto}>>`)
    }
    assert.equal(bancada.log.all().includes('12a45'), false, 'o malformado nao vai ao log')
    assert.equal(bancada.log.all().includes('777777'), false, 'o bem-formado errado nao vai ao log')
  })

  it('N cliques em `/parear` no menu geram UMA pergunta (anti-bomba, nao ecoam N vezes)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    for (let i = 0; i < 5; i += 1) await bancada.tratar(comandoDoDono('/parear'))
    const perguntas = bancada.sender.mensagens.filter((m) => m.texto === RESPOSTA_PEDIR_VALOR).length
    assert.equal(perguntas, 1, 'repetido `/parear` vazio nao reinicia nem repete o pedido')
  })

  it('ANTI-FARM (rev adversarial): estranho manda 6+ lixo na espera — max 5 re-asks e depois SILENCIO no teto', async () => {
    const bancada = montarBancada()
    await bancada.tratar({ kind: 'comando', identity: { userKey: ESTRANHO, chatKey: ESTRANHO }, text: '/parear' })
    assert.equal(bancada.sender.mensagens.length, 1, 'a pergunta')

    // 6 lixo bem separados -> exatamente 5 respostas malformadas e a 6a calada.
    for (let i = 0; i < 6; i += 1) {
      await bancada.tratar({ kind: 'comando', identity: { userKey: ESTRANHO, chatKey: ESTRANHO }, text: 'lixo' })
    }
    const respostasMalformadas = bancada.sender.mensagens.filter((m) =>
      m.texto.includes(RESPOSTA_PEDIR_VALOR_MALFORMADO),
    ).length
    assert.equal(respostasMalformadas, 5, 'no maximo 5 re-asks "Nao entendi o codigo"')
    assert.equal(bancada.sender.mensagens.length, 1 + 5, 'a 6a onda NAO responde (teto -> silencio)')

    // A espera foi removida: um valor certo depois nao e capturado (silence).
    const antes = bancada.sender.mensagens.length
    await bancada.tratar(comandoDoDono(CODIGO))
    assert.equal(bancada.sender.mensagens.length, antes, 'apos o teto, nem o codigo certo valida (espera removida)')
    assert.equal(bancada.ipc.pareamentos.length, 0)
  })

  it('ANTI-FARM: um legitimo continua a re-pedir normalmente ate o teto (sem debitar tentativa)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))
    // 4 lixo: todas re-ask (nenhum palpite nem sonda debitada no receptor).
    for (let i = 0; i < 4; i += 1) await bancada.tratar(comandoDoDono('ab4'))
    assert.equal(
      bancada.sender.mensagens.filter((m) => m.texto.includes(RESPOSTA_PEDIR_VALOR_MALFORMADO)).length,
      4,
      '4 lixo -> 4 re-asks',
    )
    // Sem debitar tentativa (nem sondas, nem palpites) — so o fluxo de espera.
    assert.equal(bancada.ipc.intents.length, 0)
    assert.equal(bancada.ipc.pareamentos.length, 0)
    // A quinta re-ask esgota o teto; a seguir um lixo fica calado, mas o fluxo
    // legitimo ainda pode recomecar com um novo `/parear`.
    await bancada.tratar(comandoDoDono('ab4')) // 5 -> teto
    const antes = bancada.sender.mensagens.length
    await bancada.tratar(comandoDoDono('ab4')) // 6 -> silencio
    assert.equal(bancada.sender.mensagens.length, antes, '6o lixo após o teto fica calado')

    // Novo `/parear` rearma e o codigo certo pareia (contador zerado ao armar).
    await bancada.tratar(comandoDoDono('/parear'))
    await bancada.tratar(comandoDoDono(CODIGO))
    assert.match(bancada.sender.mensagens.at(-1)?.texto ?? '', /Pareado/u)
  })

  it('ANTI-FARM: o TTL da espera continua a expirar mesmo com malformados (relogio injetado)', async () => {
    const bancada = montarBancada()
    await bancada.tratar(comandoDoDono('/parear'))

    // Dois malformados (re-asks) dentro da janela.
    await bancada.tratar(comandoDoDono('xyz'))
    await bancada.tratar(comandoDoDono('xyz'))
    // Avanca Alem do TTL da espera (5 min), mesmo com re-asks a decorrer.
    bancada.time.advance(5 * 60_000 + 1)

    // O valor certo agora e tardio: aviso de timeout, NAO valida.
    await bancada.tratar(comandoDoDono(CODIGO))
    assert.equal(bancada.sender.mensagens.at(-1)?.texto, RESPOSTA_AGUARDANDO_EXPIROU)
    assert.equal(bancada.ipc.pareamentos.length, 0, 'o valor tardio nao valida mesmo apos malformados')
  })
})
