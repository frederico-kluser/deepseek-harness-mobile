/**
 * `src/agents/chats.ts` — a costura (a): criar SESSAO real + submeter o prompt.
 *
 * Preso aqui, com o harness em DUBLE (nunca uma sessao real):
 *
 *   - `sessions.create(undefined, { meta: { cwd } })` com cwd ABSOLUTO (o
 *     store do harness LANCA com relativo);
 *   - a submissao em processo pela face `sessionController.prompt(request,
 *     signal)` — `requestId` cunhado, `mode: 'queue'`, `content` em blocos
 *     `PromptContentPart` (o `SessionPromptRequest` do harness);
 *   - `/novo-chat-wt`: cwd = o caminho do worktree INDICADO (que tem de
 *     existir — o chat nunca cria worktrees);
 *   - a LACUNA honesta: sem `sessionController`, a sessao nasce e o erro
 *     `CHAT_SUBMISSAO_INDISPONIVEL` leva o `sessionId` (continuar na Web UI);
 *   - erros `CHAT_*` com mensagens S3-seguras (sem caminhos — o texto cru do
 *     harness, que os pode conter, nunca sobe).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ChatError,
  criarServicoDeChats,
  LIMITE_PROMPT_CHARS,
  promptDeChatValido,
  textoDeRecusaDeSubmissao,
  type ChatService,
} from '../../../src/agents/chats.ts'
import type {
  HarnessAgentAtivo,
  HarnessSession,
  HarnessSessionController,
  HarnessSessionEvent,
  HarnessSessionPromptRequest,
  HarnessSessionsService,
} from '../../../src/agents/harness.ts'
import type { WorktreeService } from '../../../src/agents/worktrees.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

/* ========================================================================== */
/* Os dubles do harness                                                       */
/* ========================================================================== */

interface CreateRegisto {
  readonly id: string | undefined
  readonly meta: { readonly cwd?: string | undefined } | undefined
}

interface SessoesFake extends HarnessSessionsService {
  readonly creates: CreateRegisto[]
  readonly sessao: HarnessSession
  createQueLanca: Error | undefined
  /** Os eventos que `snapshotEvents` devolve (para o `ultimaResposta`). */
  eventos: HarnessSessionEvent[]
}

function fazerSessoes(): SessoesFake {
  const creates: CreateRegisto[] = []
  const fake: SessoesFake = {
    creates,
    createQueLanca: undefined,
    eventos: [],
    sessao: {
      id: 'session-1',
      snapshotEvents: () => fake.eventos,
    },
    create(id, options) {
      creates.push({ id, meta: options?.meta })
      if (fake.createQueLanca !== undefined) throw fake.createQueLanca
      return fake.sessao
    },
    get(id) {
      return id === fake.sessao.id ? fake.sessao : undefined
    },
  }
  return fake
}

interface ControladorFake extends HarnessSessionController {
  readonly pedidos: HarnessSessionPromptRequest[]
  readonly sinais: Array<AbortSignal | undefined>
  readonly cancels: string[]
  promptQueRejeita: unknown | undefined
  readonly quiescencias: { contagem: number }
  agente: HarnessAgentAtivo
  resolveAgentDevolve: 'agente' | 'erro' | 'lanca'
}

function fazerControlador(): ControladorFake {
  const fake: ControladorFake = {
    pedidos: [],
    sinais: [],
    cancels: [],
    promptQueRejeita: undefined,
    quiescencias: { contagem: 0 },
    resolveAgentDevolve: 'agente',
    agente: {
      whenIdle: async () => {
        fake.quiescencias.contagem += 1
      },
    },
    async prompt(request, signal) {
      fake.pedidos.push(request)
      fake.sinais.push(signal)
      if (fake.promptQueRejeita !== undefined) throw fake.promptQueRejeita
      return { accepted: true }
    },
    cancel(request) {
      fake.cancels.push(request.sessionId)
      return { accepted: true }
    },
    async resolveAgent() {
      if (fake.resolveAgentDevolve === 'lanca') throw new Error('resolve rebentou')
      return fake.resolveAgentDevolve === 'erro'
        ? { error: { code: 'session/not-found', message: 'sessao "/home/u/proj" perdida' } }
        : { agent: fake.agente }
    },
  }
  return fake
}

type WorktreesPick = Pick<WorktreeService, 'caminhoDe' | 'existe'>

interface Bancada {
  servico: ChatService
  sessoes: SessoesFake
  controlador: ControladorFake
  worktrees: WorktreesPick & { existentes: Set<string> }
  baseDir: string
}

function fazerBancada(opcoes: {
  semSessoes?: boolean
  semControlador?: boolean
  semWorktrees?: boolean
} = {}): Bancada {
  const sessoes = fazerSessoes()
  const controlador = fazerControlador()
  const existentes = new Set<string>(['pronto'])
  const worktrees: Bancada['worktrees'] = {
    existentes,
    caminhoDe: (nome) => `/home/u/Proj/repo-worktrees/${nome}`,
    existe: (nome) => existentes.has(nome),
  }
  const baseDir = '/home/u/Proj/repo'
  const log = createFakeLogger()
  const servico = criarServicoDeChats({
    sessoes: () => (opcoes.semSessoes === true ? undefined : sessoes),
    controlador: () => (opcoes.semControlador === true ? undefined : controlador),
    worktrees: () => (opcoes.semWorktrees === true ? undefined : worktrees),
    baseDir: () => baseDir,
    log: log('chats'),
    now: () => 1_000,
  })
  return { servico, sessoes, controlador, worktrees, baseDir }
}

async function erroDe(promessa: Promise<unknown>): Promise<ChatError> {
  try {
    await promessa
  } catch (error) {
    assert.ok(error instanceof ChatError, `esperava ChatError, veio: ${String(error)}`)
    return error
  }
  throw new Error('esperava uma rejeicao e recebi um valor')
}

/* ========================================================================== */
/* A validacao (S6 host)                                                      */
/* ========================================================================== */

describe('promptDeChatValido — "texto limpo <= 4096" na semantica do codec', () => {
  it('aceita texto simples dentro do teto e recusa controlo/vazio/grosso', () => {
    assert.equal(promptDeChatValido('ola mundo'), true)
    assert.equal(promptDeChatValido('a'.repeat(LIMITE_PROMPT_CHARS)), true)
    assert.equal(promptDeChatValido(''), false)
    assert.equal(promptDeChatValido('a'.repeat(LIMITE_PROMPT_CHARS + 1)), false)
    // A semantica do codec (`isCleanText`, src/ipc/channel.ts) recusa TODO o
    // controlo — o `\n` incluido.
    assert.equal(promptDeChatValido('linha1\nlinha2'), false)
    assert.equal(promptDeChatValido('tab\taqui'), false)
    assert.equal(promptDeChatValido(42), false)
    assert.equal(promptDeChatValido(undefined), false)
  })
})

/* ========================================================================== */
/* criar() — a costura                                                        */
/* ========================================================================== */

describe('criar() — sessao real + submissao pela face do session-controller', () => {
  it('cria a sessao com cwd ABSOLUTO e submete o prompt como primeiro turno (queue)', async () => {
    const h = fazerBancada()

    const criado = await h.servico.criar({ prompt: 'faz a tarefa', origem: 'telegram:123' })

    assert.equal(criado.sessionId, 'session-1')
    assert.ok(criado.requestId.length > 0, 'o requestId e cunhado pelo host (client-minted)')

    assert.equal(h.sessoes.creates.length, 1)
    assert.deepEqual(h.sessoes.creates[0]?.meta, { cwd: h.baseDir })
    assert.equal(h.sessoes.creates[0]?.id, undefined, 'o store cunha o id (`session-<n>`)')

    assert.equal(h.controlador.pedidos.length, 1)
    const pedido = h.controlador.pedidos[0]
    assert.ok(pedido)
    assert.equal(pedido.sessionId, 'session-1')
    assert.equal(pedido.mode, 'queue')
    assert.equal(pedido.requestId, criado.requestId)
    assert.deepEqual(pedido.content, [{ type: 'text', text: 'faz a tarefa' }])
  })

  it('com worktree: o cwd da sessao e o CAMINHO DA WORKTREE (absoluto)', async () => {
    const h = fazerBancada()

    await h.servico.criar({ prompt: 'neste worktree', worktree: 'pronto', origem: 'telegram:123' })

    assert.deepEqual(h.sessoes.creates[0]?.meta, { cwd: '/home/u/Proj/repo-worktrees/pronto' })
  })

  it('worktree INEXISTENTE e recusado — o chat nunca cria worktrees', async () => {
    const h = fazerBancada()

    const erro = await erroDe(
      h.servico.criar({ prompt: 'ola', worktree: 'nada', origem: 'telegram:123' }),
    )

    assert.equal(erro.code, 'CHAT_WORKTREE_INEXISTENTE')
    assert.equal(h.sessoes.creates.length, 0)
    assert.equal(h.controlador.pedidos.length, 0)
  })

  it('prompt invalido e recusado ANTES de tocar no harness', async () => {
    const h = fazerBancada()

    const erro = await erroDe(h.servico.criar({ prompt: 'duas\nlinhas', origem: 'telegram:123' }))

    assert.equal(erro.code, 'CHAT_PROMPT_INVALIDO')
    assert.equal(h.sessoes.creates.length, 0)
  })

  it('sem sessoes/harness: CHAT_HARNESS_AUSENTE (fail-closed)', async () => {
    const h = fazerBancada({ semSessoes: true })

    const erro = await erroDe(h.servico.criar({ prompt: 'ola', origem: 'telegram:123' }))
    assert.equal(erro.code, 'CHAT_HARNESS_AUSENTE')
  })

  it('`sessions.create` a lancar e CHAT_SESSAO_FALHOU (o bruto vai no detail)', async () => {
    const h = fazerBancada()
    h.sessoes.createQueLanca = new Error('meta.cwd relativo LANCA')

    const erro = await erroDe(h.servico.criar({ prompt: 'ola', origem: 'telegram:123' }))

    assert.equal(erro.code, 'CHAT_SESSAO_FALHOU')
    assert.ok(erro.detail?.includes('meta.cwd relativo'))
  })

  it('worktree com nome FORA da gramatica e CHAT_WORKTREE_INVALIDO (nao "indisponivel")', async () => {
    const h = fazerBancada()

    const erro = await erroDe(
      h.servico.criar({ prompt: 'ola', worktree: 'Fe At', origem: 'telegram:123' }),
    )

    assert.equal(erro.code, 'CHAT_WORKTREE_INVALIDO')
    assert.equal(h.sessoes.creates.length, 0)
  })

  it('LACUNA: sem face de submissao, a sessao nasce e o id viaja para a Web UI', async () => {
    const h = fazerBancada({ semControlador: true })

    const erro = await erroDe(h.servico.criar({ prompt: 'ola', origem: 'telegram:123' }))

    assert.equal(erro.code, 'CHAT_SUBMISSAO_INDISPONIVEL')
    assert.equal(erro.sessionId, 'session-1', 'o id da sessao criada acompanha o erro')
    assert.ok(erro.message.includes('session-1'))
    assert.ok(erro.message.includes('Web UI'))
    assert.equal(h.sessoes.creates.length, 1, 'a sessao FOI criada (a lacuna nao desfaz a criacao)')
  })

  it('recusa do harness vira CHAT_SUBMISSAO_RECUSADA com texto MAPEADO (S3)', async () => {
    const h = fazerBancada()
    h.controlador.promptQueRejeita = Object.assign(
      new Error('resume failed for session "s": Error: ENOENT /home/u/segredo/x'),
      { code: 'gateway/internal' },
    )

    const erro = await erroDe(h.servico.criar({ prompt: 'ola', origem: 'telegram:123' }))

    assert.equal(erro.code, 'CHAT_SUBMISSAO_RECUSADA')
    // O texto SOBE mapeado; o bruto (com caminhos) fica no detail/log.
    assert.equal(erro.message.includes('/home/u/'), false)
    assert.ok(erro.detail?.includes('/home/u/segredo/x'))
  })

  it('codigos conhecidos ganham texto accionavel (model-unavailable)', async () => {
    const h = fazerBancada()
    h.controlador.promptQueRejeita = Object.assign(new Error('x'), { code: 'session/model-unavailable' })

    const erro = await erroDe(h.servico.criar({ prompt: 'ola', origem: 'telegram:123' }))

    assert.equal(erro.code, 'CHAT_SUBMISSAO_RECUSADA')
    assert.ok(erro.message.includes('modelo'))
    assert.equal(textoDeRecusaDeSubmissao({ code: 'desconhecido' }).includes('log'), true)
  })

  it('falha sem `code` e CHAT_SUBMISSAO_FALHOU', async () => {
    const h = fazerBancada()
    h.controlador.promptQueRejeita = new Error('algo partiu')

    const erro = await erroDe(h.servico.criar({ prompt: 'ola', origem: 'telegram:123' }))
    assert.equal(erro.code, 'CHAT_SUBMISSAO_FALHOU')
  })
})

/* ========================================================================== */
/* O ciclo de vida da tarefa de chat                                          */
/* ========================================================================== */

describe('aguardarQuiete/cancelar/ultimaResposta', () => {
  it('aguardarQuiete espera o `whenIdle` do agente da sessao', async () => {
    const h = fazerBancada()

    await h.servico.aguardarQuiete('session-1')
    assert.equal(h.controlador.quiescencias.contagem, 1)

    h.controlador.resolveAgentDevolve = 'erro'
    const erro = await erroDe(h.servico.aguardarQuiete('session-1'))
    assert.equal(erro.code, 'CHAT_AGENTE_INDISPONIVEL')
    // O texto do harness NAO sobe (o fake tem um caminho la dentro).
    assert.equal(erro.message.includes('/home/u/'), false)

    h.controlador.resolveAgentDevolve = 'lanca'
    const erro2 = await erroDe(h.servico.aguardarQuiete('session-1'))
    assert.equal(erro2.code, 'CHAT_AGENTE_INDISPONIVEL')
  })

  it('cancelar dispara o cancel do turno e NUNCA lanca', () => {
    const h = fazerBancada()
    h.servico.cancelar('session-1')
    assert.deepEqual(h.controlador.cancels, ['session-1'])

    const sem = fazerBancada({ semControlador: true })
    assert.doesNotThrow(() => sem.servico.cancelar('session-1'))
  })

  it('ultimaResposta le o ULTIMO assistant/message com texto', () => {
    const h = fazerBancada()
    h.sessoes.eventos = [
      { type: 'user/message', data: { whatever: 1 } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: 'primeira resposta' }] },
        },
      },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 2,
          message: { content: [{ type: 'text', text: 'resposta final' }] },
        },
      },
    ]

    assert.equal(h.servico.ultimaResposta('session-1'), 'resposta final')

    h.sessoes.eventos = [{ type: 'turn/end', data: {} }]
    assert.equal(h.servico.ultimaResposta('session-1'), undefined)
    assert.equal(h.servico.ultimaResposta('sessao-desconhecida'), undefined)
  })
})
