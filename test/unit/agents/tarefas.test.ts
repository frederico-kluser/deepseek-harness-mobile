/**
 * `src/agents/registry.ts` — as TAREFAS de chat e de worktree (EMENDA ONDA-3).
 *
 * Preso aqui, com os servicos em DUBLE (nunca sessoes/worktrees reais):
 *
 *   - recusas sincronas honestas: servico ausente (fail-closed), prompt fora do
 *     contrato, nome fora da gramatica, teto de runs concorrentes;
 *   - o NOOP do `worktree.create` quando o caminho ja existe (NUNCA destruir);
 *   - o ciclo de vida pos-ack: o run nasce `kind:'chat'|'worktree'` e termina
 *     `done`/`failed`/`cancelled` com summary S3-SEGURO (sem caminhos);
 *   - `AgentRunReport`: `kind`/`worktree`/`metrics` aditivos — `kind` AUSENTE
 *     nos runs de subagente (contrato: "ausente = agent"), `metrics` so quando
 *     REALMENTE medido (o coletor recebe o id certo da sessao de cada run).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import {
  IPC_PROTOCOL_VERSION,
  type AgentRunMetrics,
  type AgentRunReport,
  type IpcAgentReportMessage,
} from '../../../src/contracts/ipc.ts'
import { parseIpcLine, serializeIpcMessage } from '../../../src/ipc/channel.ts'
import {
  createAgentRegistry,
  ROTULO_TAREFA_CHAT,
  ROTULO_TAREFA_WORKTREE,
  type AgentRegistry,
  type TarefasHost,
} from '../../../src/agents/registry.ts'
import { ChatError, type ChatService, type PedidoDeChat } from '../../../src/agents/chats.ts'
import { WorktreeError, type WorktreeService } from '../../../src/agents/worktrees.ts'
import type { ColetorDeMetricas } from '../../../src/agents/metrics.ts'
import type {
  HarnessAgentRegistry,
  HarnessSkillRegistry,
  HarnessSubagentResult,
  HarnessSubagentRuntime,
} from '../../../src/agents/harness.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'
import { flush } from '../../support/fixtures.ts'

/* ========================================================================== */
/* Os dubles                                                                  */
/* ========================================================================== */

interface ChatFake extends ChatService {
  readonly pedidos: PedidoDeChat[]
  readonly sessaoCriada: string
  readonly esperas: { contagem: number }
  readonly cancelamentos: string[]
  resposta: string | undefined
  criarQueLanca: ChatError | undefined
  privateSenha: (() => void) | undefined
  resolverQuiete(): void
}

function fazerChats(): ChatFake {
  const fake: ChatFake = {
    pedidos: [],
    sessaoCriada: 'session-1',
    esperas: { contagem: 0 },
    cancelamentos: [],
    resposta: 'resposta final do modelo',
    criarQueLanca: undefined,
    privateSenha: undefined,
    resolverQuiete() {
      fake.privateSenha?.()
    },
    async criar(pedido) {
      fake.pedidos.push(pedido)
      if (fake.criarQueLanca !== undefined) throw fake.criarQueLanca
      return { sessionId: fake.sessaoCriada, requestId: 'req-1' }
    },
    async aguardarQuiete(sessionId) {
      fake.esperas.contagem += 1
      assert.equal(sessionId, fake.sessaoCriada)
      await new Promise<void>((resolve) => {
        fake.privateSenha = resolve
      })
    },
    cancelar(sessionId) {
      fake.cancelamentos.push(sessionId)
    },
    ultimaResposta: () => fake.resposta,
  }
  return fake
}

interface WorktreesFake extends WorktreeService {
  readonly pedidosCriacao: Array<{ nome: string; base?: string | undefined }>
  readonly existentes: Set<string>
  criarQueLanca: WorktreeError | undefined
}

function fazerWorktrees(): WorktreesFake {
  const fake: WorktreesFake = {
    pedidosCriacao: [],
    existentes: new Set<string>(),
    criarQueLanca: undefined,
    caminhoDe: (nome) => `/home/u/Proj/repo-worktrees/${nome}`,
    existe: (nome) => fake.existentes.has(nome),
    async criar(pedido) {
      fake.pedidosCriacao.push({ nome: pedido.nome, base: pedido.base })
      if (fake.criarQueLanca !== undefined) throw fake.criarQueLanca
      return {
        nome: pedido.nome,
        branch: `guard/${pedido.nome}`,
        base: pedido.base ?? 'HEAD',
        caminho: `/home/u/Proj/repo-worktrees/${pedido.nome}`,
      }
    },
  }
  return fake
}

interface MetricasFake extends ColetorDeMetricas {
  readonly pedidos: Array<string | undefined>
  responder: Record<string, AgentRunMetrics> | undefined
}

function fazerMetricas(): MetricasFake {
  const fake: MetricasFake = {
    pedidos: [],
    responder: undefined,
    daSessao(sessionId) {
      fake.pedidos.push(sessionId)
      return fake.responder?.[sessionId ?? '']
    },
  }
  return fake
}

/** O harness falso minimo dos runs de subagente (para o `metrics` deles). */
interface SubagentFake extends HarnessSubagentRuntime {
  /** O proximo handle publicado pelo `start` (o teste decide o `id` e o `result`). */
  proximo:
    | { id: string; result: Promise<HarnessSubagentResult>; dispose(): Promise<void> }
    | undefined
}

function fazerHarnessMinimo(): {
  subagents: SubagentFake
  agentes: HarnessAgentRegistry
  skills: HarnessSkillRegistry
} {
  const fake: SubagentFake = {
    proximo: undefined,
    async start() {
      if (fake.proximo === undefined) throw new Error('sem run publicado por padrao')
      return fake.proximo
    },
  }
  return {
    subagents: fake,
    agentes: { roots: () => [{ id: 'raiz', session: { header: { cwd: '/proj' } } }] },
    skills: { get: async () => ({ name: 'profunda', description: 'd', content: 'c' }) },
  }
}

interface Bancada {
  registry: AgentRegistry & TarefasHost
  chats: ChatFake
  worktrees: WorktreesFake
  metricas: MetricasFake
  harness: ReturnType<typeof fazerHarnessMinimo>
  auditoria: AuditEvent[]
  relatorios: Array<AgentRunReport[]>
}

function fazerBancada(opcoes: {
  semChats?: boolean
  semWorktrees?: boolean
  semMetricas?: boolean
  maxRuns?: number
} = {}): Bancada {
  const clock = new FakeClock(1_000)
  const auditoria: AuditEvent[] = []
  const relatorios: Array<AgentRunReport[]> = []
  const chats = fazerChats()
  const worktrees = fazerWorktrees()
  const metricas = fazerMetricas()
  const harness = fazerHarnessMinimo()
  const log = createFakeLogger()

  const registry = createAgentRegistry({
    skillsPermitidas: ['profunda'],
    maxRuns: opcoes.maxRuns ?? 4,
    providerName: 'spawn',
    subagents: () => harness.subagents,
    agentesDoHarness: () => harness.agentes,
    skillsDoHarness: () => harness.skills,
    audit: { append: (evento) => auditoria.push(evento) },
    log: log('agents'),
    now: () => clock.now(),
    enviarRelatorio: (relatorio) => relatorios.push(relatorio),
    chats: () => (opcoes.semChats === true ? undefined : chats),
    worktrees: () => (opcoes.semWorktrees === true ? undefined : worktrees),
    metricas: () => (opcoes.semMetricas === true ? undefined : metricas),
  })
  return { registry, chats, worktrees, metricas, harness, auditoria, relatorios }
}

/* ========================================================================== */
/* chat.new                                                                   */
/* ========================================================================== */

describe('novoChat — a tarefa de chat', () => {
  it('recusa (fail-closed) sem o servico de chats e com prompt fora do contrato', () => {
    const h = fazerBancada({ semChats: true })
    assert.deepEqual(h.registry.novoChat({ prompt: 'ola', origem: 'telegram:1' }), {
      ok: false,
      motivo: 'tarefa-indisponivel',
    })

    const h2 = fazerBancada()
    assert.deepEqual(
      h2.registry.novoChat({ prompt: 'duas\nlinhas', origem: 'telegram:1' }),
      { ok: false, motivo: 'tarefa-indisponivel' },
    )
    assert.equal(h2.chats.pedidos.length, 0)
  })

  it('recusa com `teto-atingido` (e audit negado) quando os runs chegam ao teto', async () => {
    const h = fazerBancada({ maxRuns: 1 })
    assert.deepEqual(h.registry.novoChat({ prompt: 'um', origem: 'telegram:1' }), { ok: true })
    await flush()

    const veredito = h.registry.novoChat({ prompt: 'dois', origem: 'telegram:2' })
    assert.deepEqual(veredito, { ok: false, motivo: 'teto-atingido' })
    assert.ok(h.auditoria.some((e) => e.resultado === 'negado'))
  })

  it('cria o run kind:"chat" e termina `done` com a resposta REAL no summary', async () => {
    const h = fazerBancada()

    assert.deepEqual(
      h.registry.novoChat({ prompt: 'faz', worktree: 'feat-x', origem: 'telegram:123' }),
      { ok: true },
    )
    await flush()

    // O efeito ja criou a sessao e esta a espera do fim do turno.
    assert.deepEqual(h.chats.pedidos, [{ prompt: 'faz', worktree: 'feat-x', origem: 'telegram:123' }])
    const noMeio = h.registry.estado()[0]
    assert.equal(noMeio?.status, 'running')
    assert.equal(noMeio?.kind, 'chat')
    assert.equal(noMeio?.worktree, 'feat-x')
    assert.equal(noMeio?.skill, ROTULO_TAREFA_CHAT)

    h.chats.resolverQuiete()
    await flush()

    const fim = h.registry.estado()[0]
    assert.equal(fim?.status, 'done')
    assert.equal(fim?.summary, 'resposta final do modelo')
    // A difusao `agent.report` disparou apos o efeito (transicao terminal).
    assert.ok(h.relatorios.length >= 2)
  })

  it('sem worktree o campo `worktree` fica AUSENTE (contrato)', async () => {
    const h = fazerBancada()
    h.chats.resposta = undefined

    h.registry.novoChat({ prompt: 'so', origem: 'telegram:1' })
    await flush()
    h.chats.resolverQuiete()
    await flush()

    const run = h.registry.estado()[0]
    assert.equal(run?.kind, 'chat')
    assert.equal('worktree' in (run ?? {}), false)
    // Sem resposta do modelo, o summary aponta a sessao para a Web UI (S3-safe).
    assert.ok(run?.summary?.includes('Web UI'))
  })

  it('falha honesta: o ChatError vira `failed` com a mensagem SEGURA', async () => {
    const h = fazerBancada()
    h.chats.criarQueLanca = new ChatError(
      'CHAT_WORKTREE_INEXISTENTE',
      'o worktree "x" ainda nao existe; cria-o primeiro com /worktree.',
      { detail: '/home/u/Proj/repo-worktrees/x' },
    )

    h.registry.novoChat({ prompt: 'faz', worktree: 'x', origem: 'telegram:1' })
    await flush()

    const run = h.registry.estado()[0]
    assert.equal(run?.status, 'failed')
    assert.equal(run?.summary, 'o worktree "x" ainda nao existe; cria-o primeiro com /worktree.')
  })

  it('cancelar cancela o TURNO da sessao e marca `cancelled` no proprio tick', async () => {
    const h = fazerBancada()
    h.registry.novoChat({ prompt: 'faz', origem: 'telegram:1' })
    await flush()
    const id = h.registry.estado()[0]?.id
    assert.ok(id)

    assert.equal(h.registry.cancelar(id, 'telegram:1'), true)
    assert.deepEqual(h.chats.cancelamentos, ['session-1'])
    assert.equal(h.registry.estado()[0]?.status, 'cancelled')
    assert.equal(h.registry.cancelar('desconhecido', 'telegram:1'), false)
  })
})

/* ========================================================================== */
/* worktree.create                                                            */
/* ========================================================================== */

describe('novoWorktree — a tarefa de worktree', () => {
  it('recusa (fail-closed) sem servico e nome fora de [a-z0-9-]{1,40}', () => {
    const h = fazerBancada({ semWorktrees: true })
    assert.deepEqual(h.registry.novoWorktree({ nome: 'x', origem: 'telegram:1' }), {
      ok: false,
      motivo: 'tarefa-indisponivel',
    })

    const h2 = fazerBancada()
    assert.deepEqual(h2.registry.novoWorktree({ nome: 'Fe at!', origem: 'telegram:1' }), {
      ok: false,
      motivo: 'tarefa-indisponivel',
    })
    assert.equal(h2.worktrees.pedidosCriacao.length, 0)
  })

  it('JA EXISTE e um NOOP honesto — sem run novo e NADA destruido', () => {
    const h = fazerBancada()
    h.worktrees.existentes.add('feat-x')

    assert.deepEqual(h.registry.novoWorktree({ nome: 'feat-x', origem: 'telegram:1' }), {
      ok: true,
      jaExistia: true,
    })
    assert.deepEqual(h.registry.estado(), [])
  })

  it('cria o run kind:"worktree" e termina `done` com summary SEM caminhos (S3)', async () => {
    const h = fazerBancada()

    assert.deepEqual(
      h.registry.novoWorktree({ nome: 'feat-x', base: 'main', origem: 'telegram:123' }),
      { ok: true },
    )
    await flush()

    assert.deepEqual(h.worktrees.pedidosCriacao, [{ nome: 'feat-x', base: 'main' }])
    const run = h.registry.estado()[0]
    assert.equal(run?.status, 'done')
    assert.equal(run?.kind, 'worktree')
    assert.equal(run?.worktree, 'feat-x')
    assert.equal(run?.skill, ROTULO_TAREFA_WORKTREE)
    assert.ok(run?.summary?.includes('guard/feat-x'))
    // S3: o caminho absoluto da worktree NUNCA vai para o Telegram.
    assert.equal(run?.summary?.includes('/home/u/'), false)
  })

  it('o WorktreeError vira `failed` com a mensagem segura (o bruto nao sobe)', async () => {
    const h = fazerBancada()
    h.worktrees.criarQueLanca = new WorktreeError(
      'WORKTREE_GIT_FAILED',
      'o git recusou criar o worktree "feat-x" (detalhe no log do plugin).',
      "fatal: '/home/u/secret/path' ja existe",
    )

    h.registry.novoWorktree({ nome: 'feat-x', origem: 'telegram:1' })
    await flush()

    const run = h.registry.estado()[0]
    assert.equal(run?.status, 'failed')
    assert.equal(run?.summary, 'o git recusou criar o worktree "feat-x" (detalhe no log do plugin).')
  })

  it('cancelamento vira `cancelled` (WORKTREE_CANCELLED)', async () => {
    const h = fazerBancada()
    h.worktrees.criarQueLanca = new WorktreeError('WORKTREE_CANCELLED', 'cancelada')
    h.registry.novoWorktree({ nome: 'feat-x', origem: 'telegram:1' })
    await flush()
    assert.equal(h.registry.estado()[0]?.status, 'cancelled')
  })
})

/* ========================================================================== */
/* AgentRunReport.metrics — aditivo e REAL                                     */
/* ========================================================================== */

describe('o report — `metrics` so quando medido, `kind` so quando != agent', () => {
  it('as tarefas de chat recebem metricas DA SESSAO delas; worktrees ficam sem', async () => {
    const h = fazerBancada()
    h.metricas.responder = { 'session-1': { turns: 2 } }

    h.registry.novoChat({ prompt: 'faz', origem: 'telegram:1' })
    h.registry.novoWorktree({ nome: 'feat-x', origem: 'telegram:1' })
    await flush()
    h.chats.resolverQuiete()
    await flush()

    const [chat, worktree] = h.registry.estado().slice(-2)
    assert.deepEqual(chat?.metrics, { turns: 2 })
    assert.equal('metrics' in (worktree ?? {}), false, 'worktree nao tem metricas -> OMITIDO')
    // O coletor foi perguntado pela SESSAO do chat.
    assert.ok(h.metricas.pedidos.includes('session-1'))
  })

  it('runs de subagente: `kind` AUSENTE e metricas do filho (o id do handle)', async () => {
    const h = fazerBancada()
    h.metricas.responder = { 'child-sessao': { turns: 7 } }

    let resolverResultado!: (r: HarnessSubagentResult) => void
    const result = new Promise<HarnessSubagentResult>((resolve) => {
      resolverResultado = resolve
    })
    // A gramatica do harness: `SubagentRun.id` e "the published child session
    // id" (`packages/subagent/subagent/src/types.ts:308-314`) — e e por ela que
    // o coletor le as metricas do filho.
    h.harness.subagents.proximo = { id: 'child-sessao', result, dispose: async () => {} }

    assert.deepEqual(
      h.registry.despachar({ skill: 'profunda', prompt: 'vai', origem: 'telegram:1' }),
      { ok: true },
    )
    await flush()

    const corrente = h.registry.estado()[0]
    assert.equal('kind' in (corrente ?? {}), false, 'ausente = agent (contrato congelado)')
    assert.deepEqual(corrente?.metrics, { turns: 7 })

    resolverResultado({ output: [{ type: 'text', text: 'feito' }], stopReason: 'completed' })
    await flush()
    assert.equal(h.registry.estado()[0]?.status, 'done')
    assert.equal(h.registry.estado()[0]?.summary, 'feito')
  })
})

/* ========================================================================== */
/* A ORDEM REAL do efeito (pinada — emenda de honestidade apos revisao)        */
/* ========================================================================== */

describe('a ordem real do efeito', () => {
  it('o efeito COMECA no prefixo sincrono do veredito (antes de o ack sair)', () => {
    // A afirmação "o efeito corre depois do ack" era FALSA: `sessions.create`
    // (chat) e o spawn do `git` (worktree) correm no prefixo SINCRONO do
    // veredito — antes de `novoChat`/`novoWorktree` retornarem, logo antes de
    // o ack ser emitido. Este teste prende a ordem REAL; quem mudar a ordem
    // tem de o dizer aqui primeiro.
    const h = fazerBancada()
    const veredito = h.registry.novoChat({ prompt: 'faz', origem: 'telegram:1' })

    assert.deepEqual(veredito, { ok: true })
    // SINCRONO: nenhum `await` entre o veredito e estas observacoes.
    assert.equal(h.chats.pedidos.length, 1, 'a criacao do chat ja comecou quando o veredito resolve')
    assert.equal(h.registry.estado().length, 1, 'o run ja existe quando o veredito resolve')

    const h2 = fazerBancada()
    const veredito2 = h2.registry.novoWorktree({ nome: 'feat-x', origem: 'telegram:1' })

    assert.deepEqual(veredito2, { ok: true })
    assert.equal(
      h2.worktrees.pedidosCriacao.length,
      1,
      'o spawn do git ja comecou quando o veredito resolve',
    )
  })
})

/* ========================================================================== */
/* O CODEC REAL — as linhas aditivas serializam (e o worker antigo sobrevive)   */
/* ========================================================================== */

describe('agent.report com kind/worktree/metrics atravessa o codec real', () => {
  it('serializa e reconstrui uma linha de chat com metricas, e as linhas antigas continuam iguais', async () => {
    const h = fazerBancada()
    h.metricas.responder = { 'session-1': { turns: 2, inputTokens: 3 } }
    h.registry.novoChat({ prompt: 'faz', worktree: 'feat-x', origem: 'telegram:1' })
    await flush()
    h.chats.resolverQuiete()
    await flush()

    const mensagem: IpcAgentReportMessage = {
      v: IPC_PROTOCOL_VERSION,
      type: 'agent.report',
      runs: h.registry.estado(),
    }
    const linha = serializeIpcMessage(mensagem, 'to-worker')
    const lido = parseIpcLine(linha, 'to-worker')
    assert.equal(lido.ok, true, `o codec recusou a linha: ${JSON.stringify(lido)}`)
    assert.equal(lido.message.type, 'agent.report')
    const run = lido.message.type === 'agent.report' ? lido.message.runs[0] : undefined
    assert.deepEqual(run?.metrics, { turns: 2, inputTokens: 3 })
    assert.equal(run?.kind, 'chat')
    assert.equal(run?.worktree, 'feat-x')
  })
})
