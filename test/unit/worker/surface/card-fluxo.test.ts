/**
 * REPRODUÇÃO DO CAMINHO REAL DO CARTAO DE CONTROLHO (CONTRATO §4) com os
 * COMANDOS REAIS fiiados (`criarComandosDeSuperficie`) no nucleo — a mesma
 * costura que o boot real faz (`worker/telegram-bot.ts`).
 *
 * O objectivo é reproduzir o bug do botão "🟢 Ligar"/"📶 Status" do cartão
 * (Diagnóstico): montar cartão -> press tunnel.up -> nonce -> edição com
 * confirm -> press confirm -> intent com nonce -> ack -> cartão actualizado.
 *
 * Usa a banca de dubles de `./apoio.ts` (sender/ipc/host/auth), mas NÃO o
 * FakeComandos: o despacho é o `criarComandosDeSuperficie` real, para o caminho
 * observado ser exactamente o de produção.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IntencaoNeutra, SurfaceActionEvent, SurfaceEvent } from '../../../../worker/surface/contract.ts'
import { criarComandosDeSuperficie } from '../../../../worker/surface/commands.ts'
import { criarNucleo } from '../../../../worker/surface/core.ts'
import {
  captureLog,
  criarHostFalso,
  FakeAuth,
  FakeIpc,
  FakeSender,
  FakeTime,
  tick,
  type HostFalso,
} from './apoio.ts'

/** Os limites do Telegram (D4): UMA linha de UM botao. */
const LIMITES = Object.freeze({
  maxTextLength: 4096,
  maxActionRows: 1,
  maxActionPerRow: 1,
  maxActionDataBytes: 64,
  supportsEditing: true,
})

const DONO = { userKey: '111', chatKey: '111' }

interface Banco {
  time: FakeTime
  sender: FakeSender
  ipc: FakeIpc
  host: HostFalso
  auth: FakeAuth
  nucleo: ReturnType<typeof criarNucleo>
  tratar(evento: SurfaceEvent): Promise<void>
  abrirCartao(): Promise<string>
}

function montarBanco(): Banco {
  const time = new FakeTime()
  const log = captureLog()
  const sender = new FakeSender()
  const ipc = new FakeIpc()
  const host = criarHostFalso()
  const auth = new FakeAuth('123456')
  auth.semearDono({ userKey: '111', chatKey: '111', pairedAt: 1_700_000_000_000 })

  const nucleo = criarNucleo({
    log: log.logger,
    time,
    ipc: {
      send: (intent) => ipc.send(intent),
      pairingSuccess: (dono) => ipc.pairingSuccess(dono),
    },
    sender: sender.sender,
    limites: LIMITES,
    emitirNonce: host.emitirNonce,
    parar: async () => undefined,
    auth,
    comandos: (ctx) => criarComandosDeSuperficie(ctx),
  })

  return {
    time,
    sender,
    ipc,
    host,
    auth,
    nucleo,
    tratar: (evento) => nucleo.tratarEvento(evento),
    abrirCartao: async (): Promise<string> => {
      await nucleo.tratarEvento({ kind: 'comando', identity: DONO, text: '/menu' })
      const cartao = sender.mensagens.at(-1)
      assert.ok(cartao !== undefined, 'o /menu manda o cartao')
      return cartao.id
    },
  }
}

function accao(
  action: SurfaceActionEvent['action'],
  token: string,
  messageTarget?: string,
): SurfaceActionEvent {
  return { kind: 'acao', identity: DONO, action, token, answerTarget: 'cq-1', messageTarget }
}

function botaoDoCartao(banco: Banco, label: string): { token: string; acao: string } | undefined {
  const cartao = banco.sender.mensagens.at(-1)
  const linhas = cartao?.opcoes?.actionRows
  const botao = linhas?.flat().find((b) => b.label === label)
  if (botao === undefined) return undefined
  return { token: botao.token, acao: botao.action }
}

describe('REPRODUÇÃO: caminho real do cartão (Ligar/Status) com comandos reais', () => {
  it('Ligar do cartão: press -> toast -> nonce -> CONFIRM -> intent com nonce -> ack -> re-render do cartão', async () => {
    const banco = montarBanco()
    const cartaoId = await banco.abrirCartao()
    const antesSend = banco.sender.mensagens.length
    const antesIntent = banco.ipc.intents.length

    // (1) press 🟢 Ligar NO CARTÃO (messageTarget == cartao): toast + nonce + EDICAO com confirm.
    const ligar = botaoDoCartao(banco, '🟢 Ligar')
    assert.ok(ligar !== undefined, 'cartao tem o botão Ligar')

    await banco.tratar(accao('tunnel.up', ligar.token, cartaoId))

    // Toast imediato (TG-027).
    const toast = banco.sender.respostas.at(-1)
    assert.equal(toast?.outras?.text, 'Ligando…', 'toast imediato no press do cartão')

    // NÃO deve enviar MENSAGEM NOVA: o confirm reutiliza o MESMO messageTarget (o cartão).
    assert.equal(banco.sender.mensagens.length, antesSend, 'o confirm edita o cartão, NAO envia mensagem nova')

    // O cartão deve ter sido EDITADO para a tela de confirmação (mesmo id).
    const edicao = banco.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined, 'o cartão foi editado para a confirmação')
    assert.equal(edicao.messageId, cartaoId, 'o confirm reutiliza o MESMO messageTarget (cartão)')
    assert.match(edicao.texto, /Ligar o túnel agora\?/u)
    const confirmBotao = edicao.opcoes?.actionRows?.[0]?.find((b) => b.action === 'tunnel.up')
    assert.ok(confirmBotao !== undefined, 'a confirmação traz o botão ✅ Sim, ligar')
    const nonce = confirmBotao.token
    assert.ok(banco.host.consumir(nonce), 'o token do botão é o nonce do host (S5)')

    // (2) press ✅ Sim, ligar (no cartão): intent tunnel.up com nonce.
    await banco.tratar(accao('tunnel.up', nonce, cartaoId))
    assert.equal(banco.ipc.intents.length, antesIntent + 1, 'um intent tunnel.up após a confirmação')
    const intent = banco.ipc.intents.at(-1) as IntencaoNeutra
    assert.equal(intent.intent, 'tunnel.up')
    assert.equal(intent.nonce, nonce, 'o intent carrega o nonce opaco (S5)')

    // (3) ack aceite: o CARTÃO é actualizado com o estado novo.
    banco.nucleo.onAck({ v: 1, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'STARTING' })
    await tick(6)
    const edicaoAposAck = banco.sender.edicoes.at(-1)
    assert.ok(edicaoAposAck !== undefined)
    assert.equal(edicaoAposAck.messageId, cartaoId, 'o ack re-renderiza o cartão (mesmo id)')
  })

  it('Status do cartão: press -> toast -> intent tunnel.status -> ack -> re-render do cartão', async () => {
    const banco = montarBanco()
    const cartaoId = await banco.abrirCartao()
    const antesIntent = banco.ipc.intents.length
    const status = botaoDoCartao(banco, '📶 Status')
    assert.ok(status !== undefined, 'cartao tem o botão Status')

    await banco.tratar(accao('tunnel.status', status.token, cartaoId))

    // TG-027: responde ao clique SEMPRE. Acao de leitura: toast proprio da
    // verificacao (a edicao mostra o estado) + re-render do cartao.
    assert.equal(banco.sender.respostas.length, 1, 'o press responde ao clique')
    assert.equal(banco.sender.respostas.at(-1)?.outras?.text, 'Verificando…', 'status acusa a verificacao')

    // Envia o intent de leitura (nao aumenta exposicao, nao leva nonce).
    assert.equal(banco.ipc.intents.length, antesIntent + 1, 'um intent tunnel.status')
    const intent = banco.ipc.intents.at(-1) as IntencaoNeutra
    assert.equal(intent.intent, 'tunnel.status')
    assert.equal(Object.hasOwn(intent, 'nonce'), false, 'status é leitura pura, sem nonce')

    // ack com estado autoritativo -> o CARTÃO re-renderiza com o estado novo.
    banco.nucleo.onAck({ v: 1, type: 'ack', requestId: intent.requestId, result: 'accepted', state: 'READY' })
    await tick(6)
    const edicao = banco.sender.edicoes.at(-1)
    assert.ok(edicao !== undefined, 'o ack renderiza uma edição')
    assert.equal(edicao.messageId, cartaoId, 'o ack re-renderiza o cartão (mesmo id)')
  })

  it('Desligar do cartão: press -> toast -> EDICAO do cartao (confirm) -> confirm -> intent tunnel.down', async () => {
    const banco = montarBanco()
    const cartaoId = await banco.abrirCartao()
    const antesIntent = banco.ipc.intents.length
    const desligar = botaoDoCartao(banco, '🔴 Desligar')
    assert.ok(desligar !== undefined)

    await banco.tratar(accao('tunnel.down', desligar.token, cartaoId))
    assert.equal(banco.sender.respostas.at(-1)?.outras?.text, 'Desligando…', 'toast do cartao')
    // Editou o cartao com a confirmacao, sem mensagem nova.
    const edicaoConfirm = banco.sender.edicoes.at(-1)
    assert.ok(edicaoConfirm !== undefined && edicaoConfirm.messageId === cartaoId, 'edita o mesmo cartao')
    const simDesligar = edicaoConfirm.opcoes?.actionRows?.[0]?.find((b) => b.action === 'tunnel.down')
    assert.ok(simDesligar !== undefined, 'confirmacao traz o botao ✅ Sim, desligar')
    assert.equal(banco.ipc.intents.length, antesIntent, 'ainda nao envia intent')

    // press ✅ Sim, desligar (no cartao) -> confirma e envia tunnel.down com messageTarget = cartao.
    await banco.tratar(accao('tunnel.down', simDesligar.token, cartaoId))
    assert.equal(banco.ipc.intents.length, antesIntent + 1, 'um intent tunnel.down apos confirmar')
    const intent = banco.ipc.intents.at(-1) as IntencaoNeutra
    assert.equal(intent.intent, 'tunnel.down')
  })

  it('Rotacionar do cartão: press -> toast -> EDICAO do cartao -> confirm -> intent secret.rotate com nonce', async () => {
    const banco = montarBanco()
    const cartaoId = await banco.abrirCartao()
    const antesIntent = banco.ipc.intents.length
    const rot = botaoDoCartao(banco, '⇄ Nova chave')
    assert.ok(rot !== undefined)

    await banco.tratar(accao('secret.rotate', rot.token, cartaoId))
    assert.equal(banco.sender.respostas.at(-1)?.outras?.text, 'Gerando chave nova…', 'toast do cartao')
    const edicaoConfirm = banco.sender.edicoes.at(-1)
    assert.ok(edicaoConfirm !== undefined && edicaoConfirm.messageId === cartaoId, 'edita o mesmo cartao')
    const sim = edicaoConfirm.opcoes?.actionRows?.[0]?.find((b) => b.action === 'secret.rotate')
    assert.ok(sim !== undefined, 'confirmacao traz o botao ✅ Sim, gerar')
    assert.ok(banco.host.consumir(sim.token), 'o token do botao é o nonce do host (S5)')
    assert.equal(banco.ipc.intents.length, antesIntent, 'ainda nao envia intent')

    await banco.tratar(accao('secret.rotate', sim.token, cartaoId))
    assert.equal(banco.ipc.intents.length, antesIntent + 1, 'um intent secret.rotate apos confirmar')
    const intent = banco.ipc.intents.at(-1) as IntencaoNeutra
    assert.equal(intent.intent, 'secret.rotate')
    assert.equal(intent.nonce, sim.token, 'o intent carrega o nonce opaco (S5)')
  })

  it('Cancelar uma confirmacao NO CARTAO restaura o MENU no mesmo cartao (sem intent)', async () => {
    const banco = montarBanco()
    const cartaoId = await banco.abrirCartao()
    const ligar = botaoDoCartao(banco, '🟢 Ligar')
    assert.ok(ligar !== undefined)

    await banco.tratar(accao('tunnel.up', ligar.token, cartaoId))
    // Cartao agora mostra a confirmacao (editado). Um clique em ✕ Não restaura o menu.
    const botaoCancel = banco.sender.edicoes.at(-1)?.opcoes?.actionRows?.[0]?.find((b) => b.action === 'cancel')
    assert.ok(botaoCancel !== undefined, 'a confirmacao traz o ✕ Não')
    const antesIntent = banco.ipc.intents.length

    await banco.tratar(accao('cancel', botaoCancel.token, cartaoId))

    assert.equal(banco.ipc.intents.length, antesIntent, 'cancelar nao envia intent')
    assert.equal(banco.sender.respostas.at(-1)?.outras?.text, 'Ok, cancelado.', 'answer do cancelamento')
    // Restaurou o MENU do cartao (mesmo id, teclado do menu, estado).
    const restaurado = banco.sender.edicoes.at(-1)
    assert.ok(restaurado !== undefined && restaurado.messageId === cartaoId, 'restaura o cartao no mesmo id')
    assert.match(restaurado.texto, /🎛 Remote Access/u, 'volta ao titulo/estado do cartao')
  })
})