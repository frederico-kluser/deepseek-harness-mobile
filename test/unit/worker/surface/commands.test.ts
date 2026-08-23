/**
 * `worker/surface/commands.ts` — PORTE NEUTRO de `worker/commands/{onoff,
 * access,status}.ts` e da LISTA CANONICA (TG-080).
 *
 * COBRE TG-082 (/ligar: 2 etapas com nonce do host), TG-083 (/desligar: 2
 * etapas, token LOCAL de uso unico TTL 60 s ligado ao emissor), CTL-023 (sem
 * nonce nao ha intent que aumente exposicao), CTL-024 (o intent que REDUZ nao
 * carrega nonce), TG-084 (/status), TG-085 (/acessar), TG-086 (/rotacionar),
 * TG-087 (/emergencia: idempotente, responde uma vez e derruba o worker) e
 * TG-080 (a lista canonica, na ordem de D5).
 *
 * Os TEXTOS sao byte a byte os de producao; os botoes viram `actionRows`
 * neutras. O intent emitido via {@link SurfaceCommandIntentRequest} carrega a
 * chave neutra (`chatKey`) — a ponte para o id numerico do host e Onda 4.
 *
 * NOTA DE FRONTEIRA: o TAP que confirma `/ligar`/`/rotacionar` (enviar o intent
 * com o nonce opaco) e responsabilidade do NUCLEO (o `acao` event depois do
 * guard), nao deste modulo. Aqui testa-se a PRIMEIRA etapa (pedir o nonce +
 * renderizar a actionRow) e a confirmacao de /desligar, que E local.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { montarBancada, OWNER } from './apoio-auth.ts'
import type { SurfaceIdentity } from '../../../../worker/surface/contract.ts'
import {
  COMANDOS_PUBLICADOS,
  comandoPublicado,
  criarComandosDaSuperficie,
  criarComandosDeSuperficie,
  TTL_TOKEN_DESLIGAR_MS,
  type ComandosDaSuperficie,
} from '../../../../worker/surface/commands.ts'
import { gerarRequestId } from '../../../../worker/surface/tokens.ts'

const DM: SurfaceIdentity = OWNER

describe('TG-080: a lista canonica neutra, publicada pelo adaptador', () => {
  it('tem EXATAMENTE sete comandos, na ordem de D5, e /start NAO esta la (PAIR-006)', () => {
    assert.equal(COMANDOS_PUBLICADOS.length, 7)
    assert.deepEqual(
      COMANDOS_PUBLICADOS.map((c) => c.command),
      ['ligar', 'desligar', 'status', 'acessar', 'rotacionar', 'parear', 'emergencia'],
    )
    assert.equal(COMANDOS_PUBLICADOS.some((c) => c.command === 'start'), false)
  })

  it('`command` e [a-z0-9_]{1,32} e `description` entre 1 e 256 caracteres', () => {
    for (const c of COMANDOS_PUBLICADOS) {
      assert.match(c.command, /^[a-z0-9_]{1,32}$/u, `command invalida: ${c.command}`)
      assert.ok(c.description.length >= 1 && c.description.length <= 256)
    }
  })

  it('`comandoPublicado()` devolve um array com o mesmo conteudo, na ordem', () => {
    assert.deepEqual(comandoPublicado(), [...COMANDOS_PUBLICADOS])
  })
})

describe('TG-082: /ligar — 1a etapa: nonce do host + actionRow de confirmacao', () => {
  it('pede o nonce ao HOST e responde com actionRow; NENHUM intent antes do clique', async () => {
    const bancada = montarBancada()
    const comandos: ComandosDaSuperficie = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.ligar(DM)

    assert.equal(bancada.canal.intents.length, 0, 'so a confirmacao executa')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'tunnel.up')
    assert.equal(botao.label, '✅ Sim, ligar')
    assert.equal(botao.kind, 'confirm')
    assert.ok(bancada.host.foiEmitido(botao.token), 'o nonce do botao foi emitido pelo host')
    assert.match(bancada.emissor.mensagens[0]?.texto ?? '', /Ligar o túnel de acesso\?/u)
  })

  it('CTL-023 (face worker): sem nonce do host, falha FECHADO — nenhum intent', async () => {
    const bancada = montarBancada({ emitirNonce: async () => undefined })
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.ligar(DM)

    assert.equal(bancada.canal.intents.length, 0, 'nenhum spawn')
    assert.match(bancada.emissor.mensagens.at(-1)?.texto ?? '', /Não foi possível obter a confirmação/u)
  })
})

describe('TG-083: /desligar — 2 etapas, intent REDUZ sem nonce (CTL-024)', () => {
  it('nao executa de primeira: responde com actionRow de confirmacao (token LOCAL)', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.desligar(DM)

    assert.equal(bancada.canal.intents.length, 0, 'nao executa antes da confirmacao')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'tunnel.down')
    assert.equal(botao.label, '⛔ Sim, desligar')
    assert.equal(botao.kind, 'emergency')
    assert.ok(!bancada.host.foiEmitido(botao.token), 'o token e LOCAL do worker, nao do host')
  })

  it('a confirmacao envia tunnel.down SEM campo nonce e responde ao clique', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.desligar(DM)
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    await comandos.ligar.confirmarDesligar(DM, botao.token, 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'tunnel.down')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'a acao que reduz nao carrega nonce')
    assert.equal(bancada.emissor.respostas.length, 1, 'o clique foi respondido (TG-027)')
  })

  it('o token do teclado e de USO UNICO: o segundo clique nao envia nada', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.desligar(DM)
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    await comandos.ligar.confirmarDesligar(DM, botao.token, 'clique-1', 'msg-1')
    await comandos.ligar.confirmarDesligar(DM, botao.token, 'clique-2', 'msg-1')

    assert.equal(bancada.canal.intents.length, 1, 'replay do token: nenhum intent novo')
  })

  it('o token expira (TTL 60 s, relogio injetado): o clique morre com aviso', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.desligar(DM)
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)
    bancada.time.advance(TTL_TOKEN_DESLIGAR_MS + 1)

    await comandos.ligar.confirmarDesligar(DM, botao.token, 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 0)
    assert.equal(bancada.emissor.respostas.length, 1, 'o answer sempre vem (TG-027)')
    assert.match(bancada.emissor.respostas[0]?.outras?.text ?? '', /Confirmação expirada ou inválida/u)
  })

  it('token forjado (teclado alheio): descartado — nenhum intent, silencio de conteudo', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.confirmarDesligar(DM, 'TOKEN-FORJADO', 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 0, 'o botao forjado nao executa (TG-025)')
    assert.equal(bancada.emissor.respostas.length, 1)
    assert.equal(bancada.emissor.respostas[0]?.outras, undefined, 'sem oraculo para o teclado alheio')
  })

  it('TG-024: o token e ligado ao emissor — outro `userKey` do dono nao executa', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.ligar.desligar(DM)
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    // Mesmo token, mas quem clica tem outro `userKey` no mesmo chat.
    await comandos.ligar.confirmarDesligar({ userKey: '222', chatKey: DM.chatKey }, botao.token, 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 0, 'o token nao viaja entre eixos')
    assert.match(bancada.emissor.respostas.at(-1)?.outras?.text ?? '', /Confirmação expirada ou inválida/u)
  })

  it('MAX_TOKENS_DESLIGAR: o mapa nao cresce sem limite (17 teclados expulsam o 1o)', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)

    const tokens: string[] = []
    for (let i = 0; i < 17; i += 1) {
      await comandos.ligar.desligar(DM)
      const botao = bancada.emissor.botao(i)
      assert.ok(botao !== undefined)
      tokens.push(botao.token)
    }

    const antes = bancada.canal.intents.length
    const primeiro = tokens[0]
    assert.ok(primeiro !== undefined)
    await comandos.ligar.confirmarDesligar(DM, primeiro, 'clique-x', 'msg-1')
    assert.equal(bancada.canal.intents.length, antes, 'o token expulso nao executa')
    assert.equal(bancada.emissor.respostas.at(-1)?.outras, undefined, 'silencio de conteudo para o expulso')

    const ultimo = tokens.at(-1)
    assert.ok(ultimo !== undefined)
    await comandos.ligar.confirmarDesligar(DM, ultimo, 'clique-y', 'msg-1')
    assert.equal(bancada.canal.intents.length, antes + 1, 'o mais novo executa')
    await comandos.ligar.confirmarDesligar(DM, ultimo, 'clique-z', 'msg-1')
    assert.equal(bancada.canal.intents.length, antes + 1, 'replay do usado: nada')
  })
})

describe('TG-085: /acessar — session.issue sem nonce, aceite invisivel', () => {
  it('envia o intent session.issue sem nonce e nao responde no chat antes do host', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.access.acessar(DM)

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'session.issue')
    assert.equal(Object.hasOwn(intent, 'nonce'), false)
    assert.equal(bancada.emissor.mensagens.length, 0, 'o aceite e invisivel; a resposta vem por notify')
  })
})

describe('TG-086: /rotacionar — 1a etapa: nonce do host + actionRow', () => {
  it('pede confirmacao com nonce do host; nenhum intent antes do clique', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.access.rotacionar(DM)

    assert.equal(bancada.canal.intents.length, 0, 'so a confirmacao executa')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'secret.rotate')
    assert.equal(botao.label, '✅ Sim, rodar')
    assert.equal(botao.kind, 'confirm')
    assert.ok(bancada.host.foiEmitido(botao.token))
  })

  it('sem nonce do host, /rotacionar falha fechado', async () => {
    const bancada = montarBancada({ emitirNonce: async () => undefined })
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.access.rotacionar(DM)
    assert.equal(bancada.canal.intents.length, 0)
    assert.match(bancada.emissor.mensagens.at(-1)?.texto ?? '', /Não foi possível obter a confirmação/u)
  })
})

describe('TG-084: /status — leitura pura, intent tunnel.status sem nonce', () => {
  it('envia o intent tunnel.status sem nonce', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.status.status(DM)

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'tunnel.status')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'leitura pura nao estende o TTL')
  })
})

describe('TG-087: /emergencia — derruba tunel e worker, idempotente', () => {
  it('envia o intent emergency SEM nonce e responde UMA vez e derruba', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.status.emergencia(DM)

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'emergency')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'CTL-024: a acao que reduz nao exige nonce')
    assert.match(bancada.emissor.mensagens.at(-1)?.texto ?? '', /Emergência: a desligar o túnel e este bot/u)
    assert.equal(bancada.emissor.paradas, 1, 'o worker foi derrubado')
  })

  it('o segundo /emergencia e IDEMPOTENTE: nada de novo', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.status.emergencia(DM)
    const intents = bancada.canal.intents.length
    const mensagens = bancada.emissor.mensagens.length

    await comandos.status.emergencia(DM)

    assert.equal(bancada.canal.intents.length, intents, 'nenhum intent novo')
    assert.equal(bancada.emissor.mensagens.length, mensagens, 'nenhuma resposta nova')
    assert.equal(bancada.emissor.paradas, 1, 'o worker nao e derrubado duas vezes')
  })
})

describe('gerarRequestId — ULID de 26 caracteres Crockford', () => {
  it('tem 26 caracteres do alfabeto Crockford (sem I/L/O/U)', () => {
    const id = gerarRequestId(1_700_000_000_000)
    assert.equal(id.length, 26)
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/u)
  })

  it('ids diferentes para tempos diferentes', () => {
    assert.notEqual(gerarRequestId(1), gerarRequestId(2))
  })
})

describe('criarComandosDeSuperficie — a factory PLANA que o nucleus consome (SurfaceComandos)', () => {
  it('achata o aninhamento: expoe ligar/desligar/confirmarDesligar/status/acessar/rotacionar/emergencia', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)

    // O dispatch plano re-renderiza o mesmo que o aninhado.
    await comandos.desligar(DM)
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'tunnel.down')

    await comandos.confirmarDesligar(DM, botao.token, 'clique-1', 'msg-1')
    assert.equal(bancada.canal.intents.length, 1)
    assert.equal(bancada.canal.intents[0]?.intent, 'tunnel.down')
  })

  it('tem as oito assinaturas directas exigidas pelo contrato SurfaceComandos', () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    for (const nome of [
      'ligar',
      'desligar',
      'confirmarDesligar',
      'status',
      'acessar',
      'rotacionar',
      'emergencia',
    ] as const) {
      assert.equal(typeof comandos[nome], 'function', `falta ${nome} na factory plana`)
    }
  })

  it('coexiste com o aninhado `criarComandosDaSuperficie` (a Onda 4 escolhe um)' , async () => {
    const bancada = montarBancada()
    const plano = criarComandosDeSuperficie(bancada.ctx)
    const aninhado = criarComandosDaSuperficie(bancada.ctx)
    // Os dois caminhos produzem a mesma intencao para /acessar.
    await plano.acessar(DM)
    const planoIntents = bancada.canal.intents.length
    await aninhado.access.acessar(DM)
    assert.equal(bancada.canal.intents.length, planoIntents + 1)
  })
})