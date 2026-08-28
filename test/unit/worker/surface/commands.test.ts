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
  TTL_CONFIRMACAO_DESPACHO_MS,
  TTL_TOKEN_DESLIGAR_MS,
  type ComandosDaSuperficie,
} from '../../../../worker/surface/commands.ts'
import { gerarRequestId } from '../../../../worker/surface/tokens.ts'

const DM: SurfaceIdentity = OWNER

describe('TG-080: a lista canonica neutra, publicada pelo adaptador', () => {
  it('tem EXATAMENTE tres comandos, na ordem de D5, e /start /status /emergencia NAO estao (PAIR-006; Tarefa 3)', () => {
    assert.equal(COMANDOS_PUBLICADOS.length, 3)
    assert.deepEqual(
      COMANDOS_PUBLICADOS.map((c) => c.command),
      ['menu', 'parear', 'ajuda'],
    )
    assert.equal(COMANDOS_PUBLICADOS.some((c) => c.command === 'start'), false)
    // Tarefa 3: status/emergencia saem do menu (ficam SO como botoes do cartao).
    assert.equal(COMANDOS_PUBLICADOS.some((c) => c.command === 'status'), false)
    assert.equal(COMANDOS_PUBLICADOS.some((c) => c.command === 'emergencia'), false)
  })

  it('descricoes imperativas, 1-4 palavras, sem ponto (CONTRATO §2)', () => {
    assert.deepEqual(
      COMANDOS_PUBLICADOS.map((c) => c.description),
      [
        'Abrir o painel de controlo',
        'Parear com um código',
        'Ver como usar',
      ],
    )
    for (const c of COMANDOS_PUBLICADOS) {
      assert.ok(!c.description.endsWith('.'), `descricao com ponto: ${c.description}`)
    }
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
    assert.match(bancada.emissor.mensagens[0]?.texto ?? '', /Ligar o túnel agora\?/u)
    // Onda 5 — CONTRATO §4 Regra 4: o botao positivo vem acompanhado do
    // CANCELAMENTO (`✕ Não`, navegacao local `cancel`), na mesma actionRow.
    const linha = bancada.emissor.mensagens[0]?.opcoes?.actionRows?.[0]
    assert.equal(linha?.map((b) => b.action).join(','), 'tunnel.up,cancel')
    assert.equal(linha?.map((b) => b.label).join(','), '✅ Sim, ligar,✕ Não')
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
    assert.equal(botao.label, '✅ Sim, desligar')
    assert.equal(botao.kind, 'emergency')
    assert.ok(!bancada.host.foiEmitido(botao.token), 'o token e LOCAL do worker, nao do host')
    const linha = bancada.emissor.mensagens[0]?.opcoes?.actionRows?.[0]
    assert.equal(linha?.map((b) => b.label).join(','), '✅ Sim, desligar,✕ Não', 'cancelamento ao lado do positivo')
    assert.equal(linha?.map((b) => b.action).join(','), 'tunnel.down,cancel')
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

describe('TG-085: /acessar — session.issue sem nonce, aceite acusado no chat', () => {
  it('envia o intent session.issue sem nonce e acusa o pedido no chat', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDaSuperficie(bancada.ctx)
    await comandos.access.acessar(DM)

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'session.issue')
    assert.equal(Object.hasOwn(intent, 'nonce'), false)
    // CONTRATO §5: o botoes/clique nao parece morto — acusa antes de o host
    // notificar o link real por notify (TG-085 preservado).
    assert.match(bancada.emissor.mensagens.at(-1)?.texto ?? '', /A enviar-te o link de acesso/u)
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
    assert.equal(botao.label, '✅ Sim, gerar')
    assert.equal(botao.kind, 'confirm')
    assert.ok(bancada.host.foiEmitido(botao.token))
    const linha = bancada.emissor.mensagens[0]?.opcoes?.actionRows?.[0]
    assert.equal(linha?.map((b) => b.label).join(','), '✅ Sim, gerar,✕ Não', 'cancelamento ao lado do positivo')
    assert.equal(linha?.map((b) => b.action).join(','), 'secret.rotate,cancel')
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
    assert.match(bancada.emissor.mensagens.at(-1)?.texto ?? '', /Emergência disparada\. Túnel a desligar/u)
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

/* ========================================================================== */
/* Onda 5 — OS COMANDOS DE AGENTES: /agente, /agentes, /parar-agente          */
/* ========================================================================== */

describe('Onda 5: /agente — 1a etapa: forma + nonce do host + confirmacao', () => {
  it('sem argumentos mostra a instrucao de uso — NAO lista skills (a allowlist vive no host)', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, '')

    assert.equal(bancada.canal.intents.length, 0, 'sem skill nao ha o que disparar')
    assert.equal(
      bancada.emissor.ultimaMensagem()?.texto,
      'Uso: /agente <skill> <o que o agente deve fazer>',
    )
  })

  it('skill fora da grammar kebab-case: recusada ANTES de pedir nonce', async () => {
    let pedidosDeNonce = 0
    const bancada = montarBancada({
      emitirNonce: async () => {
        pedidosDeNonce += 1
        return 'NONCE'
      },
    })
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'MinhaSkill faz isto')

    assert.equal(bancada.canal.intents.length, 0)
    assert.equal(pedidosDeNonce, 0, 'a forma invalida nao gasta confirmacao')
    assert.match(bancada.emissor.ultimaMensagem()?.texto ?? '', /Skill inválida \(kebab-case\)/u)
  })

  it('skill valida sem prompt: instrucao de uso', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco')

    assert.equal(bancada.canal.intents.length, 0)
    assert.match(bancada.emissor.ultimaMensagem()?.texto ?? '', /Falta o prompt/u)
  })

  it('pede o nonce ao HOST com a acao agent.dispatch e mostra a confirmacao em 2 etapas', async () => {
    const pedidos: string[] = []
    const bancada = montarBancada({
      emitirNonce: async (acao) => {
        pedidos.push(acao)
        return 'NONCE-1'
      },
    })
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco diz oi')

    assert.deepEqual(pedidos, ['agent.dispatch'], 'o dispatch pede o nonce (o host consome com reset)')
    assert.equal(bancada.canal.intents.length, 0, 'so a confirmacao executa')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)
    assert.equal(botao.action, 'agent.dispatch')
    assert.equal(botao.label, '✅ Sim, disparar')
    assert.equal(botao.kind, 'confirm')
    assert.equal(botao.token, 'NONCE-1', 'o nonce do host viaja opaco no botao (S5)')
    const linha = bancada.emissor.mensagens[0]?.opcoes?.actionRows?.[0]
    assert.ok(linha !== undefined, 'a confirmacao tem a linha de acoes')
    assert.equal(linha.map((b) => b.label).join(','), '✅ Sim, disparar,✕ Não', 'cancelamento ao lado do positivo')
    assert.equal(linha.map((b) => b.action).join(','), 'agent.dispatch,cancel')
    const texto = bancada.emissor.mensagens[0]?.texto ?? ''
    assert.match(texto, /Disparar o agente "eco"\?/u)
    assert.match(texto, /"diz oi"/u, 'o prompt que VAI aparece na confirmacao')
  })

  it('CTL-023 (face worker): sem nonce do host, /agente falha FECHADO — nenhum intent', async () => {
    const bancada = montarBancada({ emitirNonce: async () => undefined })
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco diz oi')

    assert.equal(bancada.canal.intents.length, 0)
    assert.match(bancada.emissor.ultimaMensagem()?.texto ?? '', /Não foi possível obter a confirmação/u)
  })

  it('o prompt acima do teto (4096) e cortado ANTES do intent (TG-048)', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    const promptGigante = 'a'.repeat(5_000)
    await comandos.agente(DM, `eco ${promptGigante}`)
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    await comandos.confirmarDispatch(DM, botao.token, 'clique-1', 'msg-1')

    const prompt = bancada.canal.intents[0]?.params?.prompt
    assert.ok(prompt !== undefined)
    assert.ok(prompt.length <= 4096, `prompt com ${String(prompt.length)} caracteres`)
    assert.match(prompt, /…$/u, 'cortado com o marcador')
  })

  it('o prompt com quebra de linha e sanado para UMA linha (o codec recusa controlos)', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco primeira\nsegunda')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    await comandos.confirmarDispatch(DM, botao.token, 'clique-1', 'msg-1')

    const prompt = bancada.canal.intents[0]?.params?.prompt
    assert.equal(prompt, 'primeira segunda', 'o \n virou espaco antes do intent')
  })
})

describe('Onda 5: confirmarDispatch — o clique no botao da confirmacao', () => {
  it('envia agent.dispatch com nonce + params {skill, prompt} e responde ao clique', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco diz oi')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    await comandos.confirmarDispatch(DM, botao.token, 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.dispatch')
    assert.equal(intent.nonce, botao.token, 'o nonce (o token do botao) viaja OPACO (S5)')
    assert.deepEqual(intent.params, { skill: 'eco', prompt: 'diz oi' })
    assert.equal(bancada.emissor.respostas.length, 1, 'o clique foi respondido (TG-027)')
  })

  it('o token e de USO UNICO: o segundo clique nao envia nada', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco diz oi')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    await comandos.confirmarDispatch(DM, botao.token, 'clique-1', 'msg-1')
    await comandos.confirmarDispatch(DM, botao.token, 'clique-2', 'msg-1')

    assert.equal(bancada.canal.intents.length, 1, 'replay do token: nenhum intent novo')
  })

  it('o token expira (TTL 60 s, relogio injetado): o clique morre com aviso', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco diz oi')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)
    bancada.time.advance(TTL_CONFIRMACAO_DESPACHO_MS + 1)

    await comandos.confirmarDispatch(DM, botao.token, 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 0)
    assert.equal(bancada.emissor.respostas.length, 1, 'o answer sempre vem (TG-027)')
    assert.match(bancada.emissor.respostas[0]?.outras?.text ?? '', /Confirmação expirada ou inválida/u)
  })

  it('token forjado (teclado alheio): descartado — nenhum intent, silencio de conteudo', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.confirmarDispatch(DM, 'TOKEN-FORJADO', 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 0, 'o botao forjado nao executa (TG-025)')
    assert.equal(bancada.emissor.respostas.length, 1)
    assert.equal(bancada.emissor.respostas[0]?.outras, undefined, 'sem oraculo para o teclado alheio')
  })

  it('TG-024: o despacho e ligado ao emissor — outro `userKey` nao executa', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agente(DM, 'eco diz oi')
    const botao = bancada.emissor.botao(0)
    assert.ok(botao !== undefined)

    await comandos.confirmarDispatch({ userKey: '222', chatKey: DM.chatKey }, botao.token, 'clique-1', 'msg-1')

    assert.equal(bancada.canal.intents.length, 0, 'o token nao viaja entre eixos')
    assert.match(bancada.emissor.respostas.at(-1)?.outras?.text ?? '', /Confirmação expirada ou inválida/u)
  })
})

describe('Onda 5: /agentes — leitura pura, sem nonce nem params', () => {
  it('envia o intent agent.status e a resposta e o agent.report (nada renderizado aqui)', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.agentes(DM)

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.status')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'leitura pura nao exige nonce')
    assert.equal(intent.params, undefined, 'agent.status nao transporta params')
  })
})

describe('Onda 5: /parar-agente — valida a forma (8 chars) e cancela', () => {
  it('id valido: agent.cancel com params {agentId}, SEM nonce (CTL-024)', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.pararAgente(DM, '01HZABCD')

    assert.equal(bancada.canal.intents.length, 1)
    const intent = bancada.canal.intents[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.intent, 'agent.cancel')
    assert.deepEqual(intent.params, { agentId: '01HZABCD' })
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'a acao que reduz nao carrega nonce')
  })

  it('id fora da forma (8 chars do ULID): recusado antes de ir ao host, com o uso', async () => {
    const bancada = montarBancada()
    const comandos = criarComandosDeSuperficie(bancada.ctx)
    await comandos.pararAgente(DM, 'abc')

    assert.equal(bancada.canal.intents.length, 0)
    assert.match(bancada.emissor.ultimaMensagem()?.texto ?? '', /Id inválido/u)
    assert.match(bancada.emissor.ultimaMensagem()?.texto ?? '', /\/agentes/u)
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

  it('tem as doze assinaturas directas exigidas pelo contrato SurfaceComandos', () => {
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
      // Onda 5: os comandos de agentes.
      'agente',
      'agentes',
      'pararAgente',
      'confirmarDispatch',
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