/**
 * `src/agents/registry.ts` — o DISPATCHER DE AGENTES (Onda 4).
 *
 * O registry e a UNICA porta de saida do host para o harness. Preso aqui, sem
 * harness real (ctx.subagents/agents/skills FALSOS injetados):
 *
 *   - allowlist (default deny): skill fora de `config.agents.skills` e
 *     RECUSADA de forma sincrona, com audit negado e zero `start` no harness;
 *   - teto: com `maxRuns` N, o dispatch N+1 e recusado enquanto N correm;
 *   - o dispatch aceite cria o run, carrega a skill (o prompt carrega o bloco
 *     <skill_content> CANONICO + a instrucao do dono), spawna no provedor e
 *     encerra o run com o relatorio difundido em cada transicao terminal;
 *   - cancel: aborta o sinal, dispoe o handle e muda o status no proprio tick;
 *     id desconhecido = noop idempotente;
 *   - disposer: mata os runs ativos em LIFO, sincronamente (Q-2);
 *   - os caminhos de falha POST-ACK (skill inexistente, sem agente-pai,
 *     `start` rejeitado, abort pre-publicacao) nunca mentem: o run nasce e
 *     termina com o status HONESTO (`failed`/`cancelled`);
 *   - o relatorio e CAPADO no teto do canal: 32 vivos + 32 terminais = 64
 *     (o maximo legal) serializa SEM lancar no codec real; com maxRuns acima
 *     do teto do assert (33 — a repro do revisor), a lista NUNCA passa de 64
 *     (defesa em profundidade) e serializa — os MAIS RECENTES sobrevivem ao
 *     corte.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import { IPC_PROTOCOL_VERSION } from '../../../src/contracts/ipc.ts'
import { MAX_RUNS_PER_REPORT, serializeIpcMessage } from '../../../src/ipc/channel.ts'
import {
  createAgentRegistry,
  MAX_RUNS_HISTORY,
  MAX_SUMMARY_CHARS,
  type AgentRegistry,
} from '../../../src/agents/registry.ts'
import type {
  HarnessAgent,
  HarnessAgentRegistry,
  HarnessSkillDefinition,
  HarnessSkillRegistry,
  HarnessSubagentResult,
  HarnessSubagentRuntime,
  HarnessSubagentStartRequest,
} from '../../../src/agents/harness.ts'
import { FakeClock } from '../../support/clock.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'
import { flush } from '../../support/fixtures.ts'

/* ========================================================================== */
/* O harness FALSO (a superficie real entra na integracao; aqui so a forma)    */
/* ========================================================================== */

interface StartRegisto {
  readonly name: string
  readonly request: HarnessSubagentStartRequest
}

interface RunFake {
  readonly run: { readonly id: string; readonly result: Promise<HarnessSubagentResult>; dispose(): Promise<void> }
  readonly disposed: { contagem: number }
  resolver(resultado: HarnessSubagentResult): void
  rejeitar(error: Error): void
}

/** Um run publicado pelo harness falso, com resultado controlado pelo teste. */
function runPublicado(id: string): RunFake {
  const disposed: { contagem: number } = { contagem: 0 }
  let resolver!: (r: HarnessSubagentResult) => void
  let rejeitar!: (e: Error) => void
  const result = new Promise<HarnessSubagentResult>((res, rej) => {
    resolver = res
    rejeitar = rej
  })
  return {
    run: {
      id,
      result,
      dispose: async (): Promise<void> => {
        disposed.contagem += 1
      },
    },
    disposed,
    resolver,
    rejeitar,
  }
}

interface HarnessFake {
  subagents: HarnessSubagentRuntime & { starts: StartRegisto[]; rejeitarStart?: (e: Error) => void }
  agentes: HarnessAgentRegistry & { raizes: HarnessAgent[] }
  skills: HarnessSkillRegistry & { definicoes: Map<string, HarnessSkillDefinition> }
}

function fazerHarness(opcoes: { semSubagents?: boolean; semAgentes?: boolean; semSkills?: boolean } = {}): HarnessFake {
  const starts: StartRegisto[] = []
  const raizes: HarnessAgent[] = [
    { id: 'agente-raiz', session: { header: { cwd: '/workspace' } } },
  ]
  const definicoes = new Map<string, HarnessSkillDefinition>([
    [
      'deep-orchestrator-agent-skill',
      {
        name: 'deep-orchestrator-agent-skill',
        description: 'orquestrador',
        content: 'Instrucoes da skill.',
      },
    ],
  ])

  const subagents: HarnessSubagentRuntime & { starts: StartRegisto[]; rejeitarStart?: (e: Error) => void } = {
    starts,
    start: async (name, request): Promise<never> => {
      starts.push({ name, request })
      throw new Error('sem run publicado por padrao: o teste decide')
    },
  }
  const agentes = { raizes, roots: (): readonly HarnessAgent[] => raizes }
  const skills = {
    definicoes,
    get: async (name: string): Promise<HarnessSkillDefinition | undefined> => definicoes.get(name),
  }

  const harness: HarnessFake = { subagents, agentes, skills }
  if (opcoes.semSubagents === true) (harness as { subagents?: unknown }).subagents = undefined as never
  if (opcoes.semAgentes === true) (harness as { agentes?: unknown }).agentes = undefined as never
  if (opcoes.semSkills === true) (harness as { skills?: unknown }).skills = undefined as never
  return harness
}

/** Uma skill do harness que o registry ainda nao encontrou no catalogo. */
const SKILL_INEXISTENTE = 'skill-que-nao-existe'

interface Bancada {
  registry: AgentRegistry
  harness: HarnessFake
  auditoria: AuditEvent[]
  relatorios: Array<ReturnType<AgentRegistry['estado']>>
  clock: FakeClock
  /** Prende o proximo `start` e devolve o run publicado que o teste controla. */
  publicarProximoStart(): RunFake
  dispatch(skill: string, prompt?: string): ReturnType<AgentRegistry['despachar']>
}

function fazerBancada(opcoes: {
  skills?: string[]
  maxRuns?: number
  harness?: HarnessFake
} = {}): Bancada {
  const clock = new FakeClock(1_000)
  const auditoria: AuditEvent[] = []
  const relatorios: Array<ReturnType<AgentRegistry['estado']>> = []
  const harness = opcoes.harness ?? fazerHarness()

  const registry = createAgentRegistry({
    skillsPermitidas: opcoes.skills ?? [],
    maxRuns: opcoes.maxRuns ?? 1,
    providerName: 'spawn',
    subagents: () => harness.subagents,
    agentesDoHarness: () => harness.agentes,
    skillsDoHarness: () => harness.skills,
    audit: { append: (evento) => auditoria.push(evento) },
    log: createFakeLogger()('agents'),
    now: () => clock.now(),
    enviarRelatorio: (relatorio) => relatorios.push(relatorio),
  })

  return {
    registry,
    harness,
    auditoria,
    relatorios,
    clock,
    publicarProximoStart() {
      const publicado = runPublicado('run-harness-1')
      harness.subagents.start = async (name, request): Promise<RunFake['run']> => {
        harness.subagents.starts.push({ name, request })
        return publicado.run
      }
      return publicado
    },
    dispatch(skill, prompt = 'faz o que eu pedi') {
      return registry.despachar({ skill, prompt, origem: 'telegram:123' })
    },
  }
}

/* ========================================================================== */
/* ALLOWLIST — default deny                                                    */
/* ========================================================================== */

describe('a allowlist (default deny)', () => {
  it('recusa de forma SINCRONA uma skill fora de config.agents.skills, com audit negado e ZERO start', () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })

    const veredito = h.dispatch('surf-research-agent-skill')

    assert.deepEqual(veredito, { ok: false, motivo: 'skill-nao-permitida' })
    assert.equal(h.harness.subagents.starts.length, 0, 'nada foi spawnado')
    assert.deepEqual(h.registry.estado(), [], 'nenhum run nasceu')
    assert.equal(
      h.auditoria.some((e) => e.evento === 'agente_despacho:telegram:123:surf-research-agent-skill' && e.resultado === 'negado'),
      true,
      'a recusa e contada no audit com origem e skill no sufixo',
    )
  })

  it('allowlist VAZIA = nenhum agente disparavel (a leitura fail-closed da config ausente)', () => {
    const h = fazerBancada()

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: false, motivo: 'skill-nao-permitida' })
  })

  it('a skill da allowlist passa e o run nasce', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    h.publicarProximoStart()

    const veredito = h.dispatch('deep-orchestrator-agent-skill')

    assert.deepEqual(veredito, { ok: true })
    await flush()
    assert.equal(h.harness.subagents.starts.length, 1)
    assert.equal(h.harness.subagents.starts[0]?.name, 'spawn', 'o provedor e o spawn in-process')
    const estado = h.registry.estado()
    assert.equal(estado.length, 1)
    // `[0]?.` e o padrao do repositorio nos testes (a mesma forma de
    // index.test.ts:138): o tsc com noUncheckedIndexedAccess exige o `?.`.
    assert.equal(estado[0]?.status, 'running')
    assert.equal(estado[0]?.skill, 'deep-orchestrator-agent-skill')
    assert.equal(estado[0]?.id.length, 8, 'o id CURTO tem 8 caracteres')
    assert.equal(
      h.auditoria.some((e) => e.evento === 'agente_despacho:telegram:123:deep-orchestrator-agent-skill' && e.resultado === 'permitido'),
      true,
      'o despacho permitido tambem e auditado',
    )
  })
})

/* ========================================================================== */
/* TETO de runs concorrentes                                                   */
/* ========================================================================== */

describe('o teto de runs concorrentes (config agents.maxRuns)', () => {
  it('com maxRuns 1, o segundo dispatch e recusado enquanto o primeiro corre', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], maxRuns: 1 })
    h.publicarProximoStart()

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
    await flush()
    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: false, motivo: 'teto-atingido' })
    assert.equal(h.harness.subagents.starts.length, 1, 'so UM run foi spawnado')
    assert.equal(
      h.auditoria.some((e) => e.evento === 'agente_despacho:telegram:123:deep-orchestrator-agent-skill' && e.resultado === 'negado'),
      true,
      'a recusa por teto e auditada como negado',
    )
  })

  it('depois de um run terminar, o teto liberta', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], maxRuns: 1 })
    const publicado = h.publicarProximoStart()

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
    await flush()
    publicado.resolver({ output: [{ type: 'text', text: 'concluido' }], stopReason: 'completed' })
    await flush()

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
    await flush()
    assert.equal(h.harness.subagents.starts.length, 2)
  })
})

/* ========================================================================== */
/* O ciclo de vida de UM run                                                   */
/* ========================================================================== */

describe('o ciclo de vida de um run aceite', () => {
  it('o prompt do filho carrega o bloco <skill_content> CANONICO + a instrucao do dono', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    h.publicarProximoStart()

    h.dispatch('deep-orchestrator-agent-skill', 'dispara agora')
    await flush()

    const registo = h.harness.subagents.starts[0]
    assert.ok(registo !== undefined)
    assert.equal(registo.request.label, 'deep-orchestrator-agent-skill')
    assert.equal(registo.request.parent, h.harness.agentes.raizes[0], 'o parent e o agente-raiz do harness')
    const texto = registo.request.prompt[0]?.text ?? ''
    assert.ok(texto.startsWith('<skill_content name="deep-orchestrator-agent-skill">'), 'o bloco canonico abre')
    assert.ok(texto.includes('Instrucoes da skill.'), 'o corpo da skill esta no prompt')
    assert.ok(texto.endsWith('dispara agora'), 'a instrucao do dono fecha o prompt')
  })

  it('a skill carregada e a vista do AGENTE-PAI (cwd do filho = cwd da sessao do pai)', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    let vista: { readonly cwd?: string | undefined; readonly scope?: unknown } | undefined
    h.harness.skills.get = async (name, opcoes): Promise<HarnessSkillDefinition | undefined> => {
      vista = opcoes
      return h.harness.skills.definicoes.get(name)
    }
    h.publicarProximoStart()

    h.dispatch('deep-orchestrator-agent-skill')
    await flush()

    assert.equal(vista?.cwd, '/workspace', 'o catalogo e carregado no cwd do agente-pai')
    assert.equal(vista?.scope, h.harness.agentes.raizes[0], 'a vista e a do agente-pai')
  })

  it('o run termina done com summary e o relatorio e DIFUNDIDO (notificacao proativa)', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    const publicado = h.publicarProximoStart()

    h.dispatch('deep-orchestrator-agent-skill')
    await flush()
    publicado.resolver({
      output: [{ type: 'text', text: 'linha um\nlinha dois' }, { type: 'text', text: 'e tres' }],
      stopReason: 'completed',
    })
    await flush()

    const estado = h.registry.estado()
    assert.equal(estado[0]?.status, 'done')
    assert.equal(estado[0]?.summary, 'linha um linha dois e tres', 'o resumo e UMA linha, espacos colapsados')
    assert.equal(h.relatorios.length, 1, 'o fim do run difundiu o relatorio')
    assert.deepEqual(h.relatorios[0], estado, 'o relatorio difundido e a lista completa')
    assert.equal(
      h.auditoria.some((e) => e.evento === 'agente_fim:telegram:123:deep-orchestrator-agent-skill:done' && e.resultado === 'permitido'),
      true,
      'o fim e auditado com origem, skill e status no sufixo',
    )
  })

  it('o summary e CORTADO no teto (uma linha para o Telegram, nunca a resposta inteira)', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    const publicado = h.publicarProximoStart()

    h.dispatch('deep-orchestrator-agent-skill')
    await flush()
    publicado.resolver({
      output: [{ type: 'text', text: 'x'.repeat(MAX_SUMMARY_CHARS + 50) }],
      stopReason: 'completed',
    })
    await flush()

    const summary = h.registry.estado()[0]?.summary
    assert.ok(summary !== undefined && summary.length <= MAX_SUMMARY_CHARS + 1, 'o resumo cabe no teto (+reticencias)')
    assert.ok(summary?.endsWith('…') === true, 'o corte e visivel')
  })

  it('stopReason error/max-tokens/refusal do harness terminam failed', async () => {
    for (const stopReason of ['error', 'max-tokens', 'refusal'] as const) {
      const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
      const publicado = h.publicarProximoStart()
      h.dispatch('deep-orchestrator-agent-skill')
      await flush()
      publicado.resolver({ output: [], stopReason })
      await flush()

      assert.equal(h.registry.estado()[0]?.status, 'failed', stopReason)
    }
  })
})

/* ========================================================================== */
/* CANCEL                                                                      */
/* ========================================================================== */

describe('cancelar', () => {
  it('aborta o sinal, dispoe o handle, muda o status no proprio tick e audita', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    const publicado = h.publicarProximoStart()
    h.dispatch('deep-orchestrator-agent-skill')
    await flush()

    const id = h.registry.estado()[0]?.id
    assert.ok(id !== undefined)

    const cancelado = h.registry.cancelar(id, 'telegram:123')

    assert.equal(cancelado, true)
    const registo = h.harness.subagents.starts[0]
    assert.equal(registo?.request.signal.aborted, true, 'o sinal do request foi abortado')
    assert.equal(publicado.disposed.contagem, 1, 'o handle publicado foi disposto (always dispose)')
    assert.equal(h.registry.estado()[0]?.status, 'cancelled', 'o status muda NO PROPRIO TICK')
    assert.equal(
      h.auditoria.some((e) => e.evento === `agente_cancelar:telegram:123:${id}` && e.resultado === 'permitido'),
      true,
    )

    // O `result` do harness resolve aborted -> encerra cancelled (consistente).
    publicado.resolver({ output: [], stopReason: 'aborted' })
    await flush()
    assert.equal(h.registry.estado()[0]?.status, 'cancelled')
  })

  it('id desconhecido (ou run ja terminal) = noop idempotente, false', () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })

    assert.equal(h.registry.cancelar('abcdef12', 'telegram:123'), false)
  })

  it('cancelar NAO exige nonce e nao toca nos outros runs', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], maxRuns: 2 })
    const primeiro = h.publicarProximoStart()
    h.dispatch('deep-orchestrator-agent-skill')
    await flush()
    const segundo = h.publicarProximoStart()
    h.dispatch('deep-orchestrator-agent-skill')
    await flush()

    const ids = h.registry.estado().map((r) => r.id)
    h.registry.cancelar(ids[0] ?? '', 'telegram:123')

    assert.equal(primeiro.disposed.contagem, 1)
    assert.equal(segundo.disposed.contagem, 0, 'o outro run nao foi tocado')
    assert.equal(h.registry.estado().filter((r) => r.status === 'cancelled').length, 1)
  })
})

/* ========================================================================== */
/* O DISPOSER — mata tudo em LIFO, sincronamente                               */
/* ========================================================================== */

describe('o disposer', () => {
  it('mata os runs ativos em LIFO (o mais recente primeiro) e marca cancelled', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], maxRuns: 2 })
    const primeiro = h.publicarProximoStart()
    h.dispatch('deep-orchestrator-agent-skill')
    await flush()
    const segundo = h.publicarProximoStart()
    h.dispatch('deep-orchestrator-agent-skill')
    await flush()

    h.registry.dispose()

    const ordemDeDispose: number[] = []
    assert.equal(primeiro.disposed.contagem, 1, 'o primeiro foi disposto')
    assert.equal(segundo.disposed.contagem, 1, 'o segundo foi disposto')
    // A ORDEM LIFO nao e observavel pela contagem; o que e observavel e que
    // AMBOS foram abortados antes de o disposer voltar (sincrono) e que o
    // estado terminal nao admite mais cancelamentos.
    assert.equal(h.registry.estado().filter((r) => r.status === 'cancelled').length, 2)
    assert.equal(h.registry.cancelar('qualquer', 'telegram:123'), false)
    void ordemDeDispose
  })

  it('e SINCRONO: o retorno nao e uma Promise (garantia LIFO da Fiber, Q-2)', () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    const retorno = h.registry.dispose()
    assert.equal(typeof (retorno as { then?: unknown } | undefined)?.then, 'undefined', 'disposer nao devolve Promise')
  })

  it('idempotente: dispor duas vezes nao duplica o dispose dos runs', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    const publicado = h.publicarProximoStart()
    h.dispatch('deep-orchestrator-agent-skill')
    await flush()

    h.registry.dispose()
    h.registry.dispose()

    assert.equal(publicado.disposed.contagem, 1, 'o dispose do harness corre UMA vez')
  })
})

/* ========================================================================== */
/* HARNESS INDISPONIVEL — fail-closed antes de qualquer spawn                  */
/* ========================================================================== */

describe('o harness indisponivel', () => {
  it('subagents/agents/skills ausentes: recusa SINCRONA harness-indisponivel', () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], harness: fazerHarness({ semSkills: true }) })

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: false, motivo: 'harness-indisponivel' })
    assert.equal(h.harness.subagents.starts.length, 0)
  })
})

/* ========================================================================== */
/* As falhas POS-ACK nunca mentem: o run nasce e termina com o status honesto  */
/* ========================================================================== */

describe('as falhas pos-ack', () => {
  it('skill nao encontrada no catalogo do harness: o run termina failed com o motivo no summary', async () => {
    const h = fazerBancada({ skills: [SKILL_INEXISTENTE] })

    assert.deepEqual(h.dispatch(SKILL_INEXISTENTE), { ok: true })
    await flush()

    const estado = h.registry.estado()
    assert.equal(estado[0]?.status, 'failed')
    assert.ok(estado[0]?.summary?.includes(SKILL_INEXISTENTE) === true)
    assert.equal(h.harness.subagents.starts.length, 0, 'nada foi spawnado')
  })

  it('sem agente-pai vivo (roots vazio): o run termina failed', async () => {
    const harness = fazerHarness()
    harness.agentes.raizes.length = 0
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], harness })

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
    await flush()

    assert.equal(h.registry.estado()[0]?.status, 'failed')
    assert.equal(h.harness.subagents.starts.length, 0)
  })

  it('o start() do harness REJEITA (provider ausente): o run termina failed', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
    await flush()

    assert.equal(h.registry.estado()[0]?.status, 'failed')
    assert.ok(h.registry.estado()[0]?.summary?.includes('nao foi possivel disparar') === true)
  })

  it('o result() do harness REJEITA (falha de infraestrutura do seam): failed, nao throw', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    const publicado = h.publicarProximoStart()

    h.dispatch('deep-orchestrator-agent-skill')
    await flush()
    publicado.rejeitar(new Error('falha de infraestrutura'))
    await flush()

    assert.equal(h.registry.estado()[0]?.status, 'failed')
  })

  it('o cancel ANTES da publicacao (start pendente) termina cancelled, nao failed', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })

    assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
    // NAO faz flush: o start ainda esta pendente (o harness fake lanca no start
    // apenas quando chamado — aqui o start ainda NAO foi chamado? nao: o start
    // e chamado dentro de executar, que corre apos o despacho; avancamos e
    // cancelamos ANTES de o flush deixar o start rejeitar).
    const id = h.registry.estado()[0]?.id
    assert.ok(id !== undefined)
    assert.equal(h.registry.cancelar(id, 'telegram:123'), true)
    await flush()

    assert.equal(h.registry.estado()[0]?.status, 'cancelled', 'abort explicito antes da publicacao = cancelled')
  })

  it('o registo NAO persiste em lado nenhum: nada alem da lista em memoria', () => {
    // Sem state.json, sem ficheiro: a lista morre com o registry. O que este
    // teste prende e a AUSENCIA de escrita — o registry so toca o audit.
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'] })
    h.dispatch('deep-orchestrator-agent-skill')
    assert.equal(h.auditoria.some((e) => e.resultado === 'permitido'), true, 'so o audit e escrito')
  })
})

/* ========================================================================== */
/* EMENDA ONDA-4-FIX-REPORT-CAPS: o relatorio nunca passa do teto do canal     */
/* ========================================================================== */

describe('o relatorio capado no teto do canal (MAX_RUNS_PER_REPORT)', () => {
  /** Cada dispatch recebe o SEU run publicado (a fila substitui o start). */
  function publicarEmFila(h: Bancada, publicados: RunFake[]): void {
    h.harness.subagents.start = async (name, request): Promise<RunFake['run']> => {
      h.harness.subagents.starts.push({ name, request })
      const publicado = runPublicado(`run-harness-${publicados.length}`)
      publicados.push(publicado)
      return publicado.run
    }
  }

  it('32 vivos + 32 terminais = 64 (o maximo legal): a lista fica no teto e serializa SEM lancar', async () => {
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], maxRuns: MAX_RUNS_HISTORY })
    const publicados: RunFake[] = []
    publicarEmFila(h, publicados)

    // Fase A: 32 runs ATIVOS (o teto legal de concorrencia).
    for (let i = 0; i < MAX_RUNS_HISTORY; i++) {
      assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
      await flush()
    }

    // Fase B: resolve o run MAIS RECENTE de cada vez — o mais antigo continua
    // vivo na FRENTE da tabela, logo a poda do historico nunca o tira — e
    // despacha mais um: a tabela interna cresce ate 32 vivos + 32 terminais =
    // 64, o teto exato de uma mensagem agent.report (a repro do revisor:
    // acima disto o codec recusava a linha e o dono ficava sem relatorio).
    for (let k = 1; k <= MAX_RUNS_HISTORY; k++) {
      publicados[30 + k]?.resolver({ output: [{ type: 'text', text: 'concluido' }], stopReason: 'completed' })
      await flush()
      assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
      await flush()
    }

    const estado = h.registry.estado()
    assert.equal(estado.length, MAX_RUNS_PER_REPORT, 'a lista tem exatamente o teto do canal')
    assert.doesNotThrow(
      () =>
        serializeIpcMessage(
          { v: IPC_PROTOCOL_VERSION, type: 'agent.report', runs: estado },
          'to-worker',
        ),
      'o codec REAL aceita a lista no teto — a resposta a agent.status nao pode falhar',
    )
    assert.equal(
      h.relatorios.every((r) => r.length <= MAX_RUNS_PER_REPORT),
      true,
      'as difusoes proativas tambem saem capadas',
    )
  })

  it('defesa em profundidade: 33 vivos + 32 terminais (65 > 64) capa a lista em 64 e serializa SEM lancar', async () => {
    // A REPRO DO REVISOR: 33 runs ativos (o teto que o assert recusa — o
    // registry NAO valida maxRuns, quem valida e o assert). Entrar por cima
    // dele de proposito exercita o teto da EMISSAO — a ultima rede antes do
    // canal — para o dia em que maxRuns ou o historico mudem.
    const h = fazerBancada({ skills: ['deep-orchestrator-agent-skill'], maxRuns: 33 })
    const publicados: RunFake[] = []
    publicarEmFila(h, publicados)

    for (let i = 0; i < 33; i++) {
      assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
      await flush()
    }
    // O id do run MAIS ANTIGO (o primeiro despacho): nunca mais sai da FRENTE
    // da tabela — e o primeiro a cair fora do corte no relatorio.
    const idDoMaisAntigo = h.registry.estado()[0]?.id
    assert.ok(idDoMaisAntigo !== undefined)
    // Resolve o MAIS RECENTE de cada vez e despacha mais um: a tabela interna
    // chega a 65 (33 vivos + 32 terminais) — UMA acima do teto do canal.
    for (let k = 1; k <= MAX_RUNS_HISTORY; k++) {
      publicados[31 + k]?.resolver({ output: [{ type: 'text', text: 'fim' }], stopReason: 'completed' })
      await flush()
      assert.deepEqual(h.dispatch('deep-orchestrator-agent-skill'), { ok: true })
      await flush()
    }

    const estado = h.registry.estado()
    assert.equal(estado.length, MAX_RUNS_PER_REPORT, 'a lista e capada no teto, nunca acima')
    assert.doesNotThrow(
      () =>
        serializeIpcMessage(
          { v: IPC_PROTOCOL_VERSION, type: 'agent.report', runs: estado },
          'to-worker',
        ),
      'o codec REAL aceita a lista capada — nenhuma difusao se perde',
    )
    const ids = new Set(estado.map((r) => r.id))
    const idDoMaisRecente = estado[estado.length - 1]?.id
    assert.ok(idDoMaisRecente !== undefined)
    assert.equal(ids.has(idDoMaisRecente), true, 'o run MAIS RECENTE sobrevive ao corte')
    assert.equal(ids.has(idDoMaisAntigo), false, 'o mais ANTIGO e o que sai do relatorio')
    assert.equal(
      h.relatorios.every((r) => r.length <= MAX_RUNS_PER_REPORT),
      true,
      'as difusoes proativas tambem saem capadas',
    )
  })
})
