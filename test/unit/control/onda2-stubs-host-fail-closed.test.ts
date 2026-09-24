/**
 * `src/control/surface-ipc.ts` — o DISPATCH REAL de `chat.new`/`worktree.create`
 * (EMENDA ONDA-3-HOST-TAREFAS).
 *
 * >>> SUBSTITUI O GUARD INTERINO DA ONDA 2 (`onda2-stubs-host-fail-closed`):
 * aquele ficheiro prendia o STUB ("chat.new/worktree.create -> error INTERNAL
 * 'Este comando ainda nao esta disponivel nesta instalacao.'"). O dispatch real
 * chegou; ESTE ficheiro prende o comportamento REAL e cobre os dois caminhos
 * do surface-ipc (a revisao da onda 3 cobra essa cobertura). <<<
 *
 * Preso aqui (surface em duble — o efeito real vive em
 * `test/unit/agents/tarefas.test.ts`):
 *
 *   - validacao S6: os DOIS EIXOS (`from`/`chat`) + pareamento persistido —
 *     identidade nao pareada e `NOT_PAIRED` (o check comum a todas as intents);
 *   - nonce de 2 etapas com a acao `'reset'` consumido NO HOST: sem nonce /
 *     replay / expirado = `rejected NONCE_INVALID` e NADA executado;
 *   - IDEMPOTENCIA por `requestId`: replay de uma intent ja despachada = `noop`
 *     (nunca um segundo chat/worktree, nunca um segundo nonce);
 *   - revalidacao S6 da FORMA no host (prompt "texto limpo <= 4096", nome
 *     `[a-z0-9-]{1,40}`, base com higiene de ref) = `rejected INTERNAL`;
 *   - ack coerente: `accepted` (efeito lancado), `noop` (ja existia / replay),
 *     `rejected` + `IpcErrorCode`; recusa de politica = `error INTERNAL` com
 *     mensagem accionavel (o padrao de `agent.dispatch`);
 *   - sem `tarefas`/`confirm` fiados = `error INTERNAL` (fail-closed).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { IpcIntentMessage, IpcMessageToWorker } from '../../../src/contracts/ipc.ts'
import { createConfirmService } from '../../../src/control/confirm.ts'
import { criarRespondedorIpc } from '../../../src/control/surface-ipc.ts'
import type { PedidoDeChat } from '../../../src/agents/chats.ts'
import type {
  PedidoDeTarefaWorktree,
  TarefasHost,
  VereditoDeTarefa,
} from '../../../src/agents/registry.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

/* ========================================================================== */
/* O `TarefasHost` falso — a FORMA que a superficie usa                        */
/* ========================================================================== */

interface TarefasFake extends TarefasHost {
  readonly chats: PedidoDeChat[]
  readonly worktrees: PedidoDeTarefaWorktree[]
  vereditoChat: VereditoDeTarefa
  vereditoWorktree: VereditoDeTarefa
}

function fazerTarefas(): TarefasFake {
  const fake: TarefasFake = {
    chats: [],
    worktrees: [],
    vereditoChat: { ok: true },
    vereditoWorktree: { ok: true },
    novoChat(pedido) {
      fake.chats.push(pedido)
      return fake.vereditoChat
    },
    novoWorktree(pedido) {
      fake.worktrees.push(pedido)
      return fake.vereditoWorktree
    },
  }
  return fake
}

interface Bancada {
  responder: ReturnType<typeof criarRespondedorIpc>
  tarefas: TarefasFake
  confirm: ReturnType<typeof createConfirmService>
  emitirNonce(): string
  pareado: { valor: boolean }
}

function fazerBancada(opcoes: {
  semTarefas?: boolean
  semConfirm?: boolean
} = {}): Bancada {
  const clock = new FakeClock(1_000)
  const auditoria: AuditEvent[] = []
  const tarefas = fazerTarefas()
  const confirm = createConfirmService({ now: () => clock.now() })
  const pareado = { valor: true }

  const responder = criarRespondedorIpc({
    controller: undefined, // modo loopback: as tarefas nao dependem do tunel
    modoTunel: false,
    pareado: () => pareado.valor,
    audit: { append: (evento) => auditoria.push(evento) },
    log: createFakeLogger()('ctl'),
    agora: () => clock.now(),
    reemitirEstado: (): void => {},
    aposEmergencia: (): void => {},
    ...(opcoes.semConfirm === true ? {} : { confirm }),
    ...(opcoes.semTarefas === true ? {} : { tarefas }),
  })

  return {
    responder,
    tarefas,
    confirm,
    pareado,
    emitirNonce: () => confirm.issue('reset').valor,
  }
}

function intent(
  intent: 'chat.new' | 'worktree.create',
  params: Record<string, unknown> | undefined,
  opts: { requestId?: string; nonce?: string | undefined; from?: string; chat?: string } = {},
): IpcIntentMessage {
  return {
    v: 2,
    type: 'intent',
    intent,
    requestId: opts.requestId ?? 'req-1',
    from: opts.from ?? '123',
    chat: opts.chat ?? '123',
    ...(opts.nonce === undefined ? {} : { nonce: opts.nonce }),
    ...(params === undefined ? {} : { params: params as never }),
  }
}

function codigoDe(resposta: IpcMessageToWorker): string | undefined {
  return 'code' in resposta ? resposta.code : undefined
}

function tipoDe(resposta: IpcMessageToWorker): string {
  return resposta.type
}

/* ========================================================================== */
/* A identidade (S6) e o nonce ('reset')                                      */
/* ========================================================================== */

describe('chat.new/worktree.create — identidade S6 e nonce de 2 etapas', () => {
  it('identidade nao pareada e NOT_PAIRED e NADA executa (os dois eixos)', () => {
    const h = fazerBancada()
    h.pareado.valor = false

    const resposta = h.responder(intent('chat.new', { prompt: 'ola' }, { nonce: h.emitirNonce() }))

    assert.equal(tipoDe(resposta), 'error')
    assert.equal(codigoDe(resposta), 'NOT_PAIRED')
    assert.deepEqual(h.tarefas.chats, [])
    assert.deepEqual(h.tarefas.worktrees, [])
  })

  it('sem nonce = rejected NONCE_INVALID, sem efeito', () => {
    const h = fazerBancada()

    const resposta = h.responder(intent('chat.new', { prompt: 'ola' }))

    assert.deepEqual([tipoDe(resposta), codigoDe(resposta)], ['ack', 'NONCE_INVALID'])
    assert.equal('result' in resposta && resposta.result, 'rejected')
    assert.deepEqual(h.tarefas.chats, [])
  })

  it('nonce de UMA via: o replay do nonce (outro requestId) ja nao autoriza', () => {
    const h = fazerBancada()
    const nonce = h.emitirNonce()

    const primeiro = h.responder(intent('chat.new', { prompt: 'ola' }, { requestId: 'req-1', nonce }))
    assert.equal('result' in primeiro && primeiro.result, 'accepted')

    const segundo = h.responder(intent('chat.new', { prompt: 'ola' }, { requestId: 'req-2', nonce }))
    assert.deepEqual([tipoDe(segundo), codigoDe(segundo)], ['ack', 'NONCE_INVALID'])
    assert.equal(h.tarefas.chats.length, 1, 'o segundo nunca executa')
  })

  it('a rejeicao de nonce NAO marca idempotencia (retry com nonce novo EXECUTA)', () => {
    // PROVA POR MUTACAO: acrescentar `marcarProcessada(intent.requestId)` no
    // ramo NONCE_INVALID mata este teste (o passo 2 passaria a `noop`) — e e
    // exatamente isso que a regra impede: uma recusa de nonce NADA executa e
    // NADA marca, para o clique tardio poder repetir com um nonce novo.
    const h = fazerBancada()

    // 1. mesmo requestId SEM nonce -> rejected NONCE_INVALID, nada executado.
    const primeiro = h.responder(intent('chat.new', { prompt: 'ola' }, { requestId: 'req-x' }))
    assert.deepEqual([tipoDe(primeiro), codigoDe(primeiro)], ['ack', 'NONCE_INVALID'])
    assert.deepEqual(h.tarefas.chats, [])

    // 2. RETRY com o MESMO requestId e um nonce novo -> tem de EXECUTAR.
    const segundo = h.responder(
      intent('chat.new', { prompt: 'ola' }, { requestId: 'req-x', nonce: h.emitirNonce() }),
    )
    assert.equal('result' in segundo && segundo.result, 'accepted')
    assert.equal(h.tarefas.chats.length, 1, 'o retry com nonce novo executa exatamente uma vez')
  })

  it('ambas pedem o nonce com a ACAO `reset` (universo unico)', () => {
    const h = fazerBancada()
    // Um nonce emitido para `start` NAO autoriza `reset` (a acao faz parte da
    // autorizacao — CTL: `consume(nonce, 'start')` nao autoriza `reset`).
    const nonceDeStart = h.confirm.issue('start').valor

    const resposta = h.responder(intent('worktree.create', { nome: 'feat' }, { nonce: nonceDeStart }))

    assert.deepEqual([tipoDe(resposta), codigoDe(resposta)], ['ack', 'NONCE_INVALID'])
    assert.deepEqual(h.tarefas.worktrees, [])
  })
})

/* ========================================================================== */
/* A revalidacao S6 da forma + o dispatch real                                */
/* ========================================================================== */

describe('chat.new — o dispatch real', () => {
  it('com nonce valido executa com `{ prompt, worktree? }` e responde accepted', () => {
    const h = fazerBancada()

    const resposta = h.responder(
      intent('chat.new', { prompt: 'faz a tarefa', worktree: 'feat-x' }, { nonce: h.emitirNonce() }),
    )

    assert.equal('result' in resposta && resposta.result, 'accepted')
    assert.deepEqual(h.tarefas.chats, [
      { prompt: 'faz a tarefa', worktree: 'feat-x', origem: 'telegram:123' },
    ])
  })

  it('REPLAY do requestId = noop (nunca um segundo chat)', () => {
    const h = fazerBancada()
    const nonce = h.emitirNonce()

    const primeiro = h.responder(intent('chat.new', { prompt: 'ola' }, { requestId: 'req-1', nonce }))
    assert.equal('result' in primeiro && primeiro.result, 'accepted')
    const replay = h.responder(intent('chat.new', { prompt: 'ola' }, { requestId: 'req-1', nonce }))

    assert.equal('result' in replay && replay.result, 'noop')
    assert.equal(h.tarefas.chats.length, 1)
  })

  it('prompt/nome fora do contrato no host = rejected INTERNAL, sem efeito', () => {
    const h = fazerBancada()

    const promptTorto = h.responder(
      intent('chat.new', { prompt: 'duas\nlinhas' }, { requestId: 'r-prompt', nonce: h.emitirNonce() }),
    )
    assert.deepEqual([tipoDe(promptTorto), codigoDe(promptTorto)], ['ack', 'INTERNAL'])
    assert.equal('result' in promptTorto && promptTorto.result, 'rejected')

    const worktreeTorto = h.responder(
      intent('chat.new', { prompt: 'ola', worktree: 'Fe At' }, { requestId: 'r-wt', nonce: h.emitirNonce() }),
    )
    assert.equal('result' in worktreeTorto && worktreeTorto.result, 'rejected')

    const nomeTorto = h.responder(
      // NOTA: `--mal` e VALIDO na gramatica congelada `[a-z0-9-]{1,40}` (o
      // hifen inicial passa — e e seguro: o nome vira `guard/<nome>` e um
      // segmento de path, nunca uma opcao de argv). O invalido e o maiusculo.
      intent('worktree.create', { nome: 'Fe At' }, { requestId: 'r-nome', nonce: h.emitirNonce() }),
    )
    assert.equal('result' in nomeTorto && nomeTorto.result, 'rejected')

    const baseTorta = h.responder(
      intent('worktree.create', { nome: 'feat', base: '--upload-pack=x' }, { requestId: 'r-base', nonce: h.emitirNonce() }),
    )
    assert.equal('result' in baseTorta && baseTorta.result, 'rejected')

    assert.deepEqual(h.tarefas.chats, [])
    assert.deepEqual(h.tarefas.worktrees, [])
  })

  it('recusa de politica do registry = `error INTERNAL` com mensagem accionavel', () => {
    const h = fazerBancada()
    h.tarefas.vereditoChat = { ok: false, motivo: 'teto-atingido' }

    const resposta = h.responder(intent('chat.new', { prompt: 'ola' }, { nonce: h.emitirNonce() }))

    assert.equal(tipoDe(resposta), 'error')
    assert.equal(codigoDe(resposta), 'INTERNAL')
    assert.ok('message' in resposta && resposta.message.includes('agents.maxRuns'))
  })

  it('sem `tarefas` fiados = error INTERNAL (fail-closed) — o caminho do STUB antigo', () => {
    const h = fazerBancada({ semTarefas: true })

    for (const pedido of [
      intent('chat.new', { prompt: 'ola' }, { nonce: h.emitirNonce() }),
      intent('worktree.create', { nome: 'feat' }, { nonce: h.emitirNonce() }),
    ]) {
      const resposta = h.responder(pedido)
      assert.equal(tipoDe(resposta), 'error')
      assert.equal(codigoDe(resposta), 'INTERNAL')
    }
    assert.deepEqual(h.tarefas.chats, [])
    assert.deepEqual(h.tarefas.worktrees, [])
  })
})

describe('worktree.create — o dispatch real', () => {
  it('aceite executa `{ nome, base? }` e responde accepted', () => {
    const h = fazerBancada()

    const resposta = h.responder(
      intent('worktree.create', { nome: 'feat-x', base: 'main' }, { nonce: h.emitirNonce() }),
    )

    assert.equal('result' in resposta && resposta.result, 'accepted')
    assert.deepEqual(h.tarefas.worktrees, [
      { nome: 'feat-x', base: 'main', origem: 'telegram:123' },
    ])
  })

  it('JA EXISTE = noop honesto (e nunca um erro — nada foi destruido)', () => {
    const h = fazerBancada()
    h.tarefas.vereditoWorktree = { ok: true, jaExistia: true }

    const resposta = h.responder(
      intent('worktree.create', { nome: 'feat-x' }, { nonce: h.emitirNonce() }),
    )

    assert.equal('result' in resposta && resposta.result, 'noop')
    assert.deepEqual(h.tarefas.worktrees, [
      { nome: 'feat-x', origem: 'telegram:123' },
    ])
  })

  it('replay do requestId = noop', () => {
    const h = fazerBancada()
    const nonce = h.emitirNonce()

    h.responder(intent('worktree.create', { nome: 'feat' }, { requestId: 'req-1', nonce }))
    const replay = h.responder(intent('worktree.create', { nome: 'feat' }, { requestId: 'req-1', nonce }))

    assert.equal('result' in replay && replay.result, 'noop')
    assert.equal(h.tarefas.worktrees.length, 1)
  })
})
