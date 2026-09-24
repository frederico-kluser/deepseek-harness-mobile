/**
 * =============================================================================
 * O REGISTRY DE AGENTES — o DISPATCHER da Onda 4.
 * =============================================================================
 *
 * O dono (atraves do bot, Onda 5) dispara um agente do DeepSeek Harness
 * escolhendo uma skill. Este modulo e a UNICA porta de saida: o dispatch
 * passa por allowlist (default deny), teto de runs concorrentes, audit de
 * cada accao, e o disposer mata tudo em LIFO.
 *
 * EFEMERO POR DESENHO: os runs vivem SÓ em memoria — nada disto persiste em
 * `state.json`. Um reinicio do DSH derruba os runs em curso (o disposer
 * cancela-os) e a lista recomeca vazia. Persistir runs exigiria persistir
 * também o que eles estao a fazer, e isso e um contrato novo — nao esta
 * nesta onda.
 *
 * O QUE NAO ESTA AQUI: a superficie (comandos do bot) e da Onda 5; o
 * transporte IPC (intents `agent.*`, mensagem `agent.report`) esta em
 * `src/contracts/ipc.ts`; a fiacao (ctx.subagents/agents/skills) esta em
 * `src/index.ts`. Este modulo recebe GETTERS lazy dos servicos do harness —
 * os mesmos que `authStack()` usa para a pilha de autenticacao: os servicos
 * podem aparecer depois do `apply()`, e uma captura no arranque seria uma
 * corrida. Ausentes no momento do despacho, o despacho e RECUSADO
 * (fail-closed).
 *
 * O PARENT DO RUN: `SubagentStartRequest.parent` e OBRIGATORIO no harness
 * ("The spawning agent. In-process providers derive workspace, lineage, and
 * delegation depth from its durable session state"). O plugin corre no
 * contexto do HOST, fora de qualquer agente — a unica fonte honesta de um
 * agente vivo de topo e `ctx.agents.roots()`. Resolve-se NO MOMENTO do
 * despacho (nunca no arranque): e o agente-racaiz do harness, e o cwd da
 * sessao dele e o workspace em que o filho nasce. Sem agente vivo, o
 * despacho e recusado — nao se inventa um pai.
 *
 * A SKILL ENTRA NO REQUEST COMO CONTEUDO DO PROMPT: `ctx.skills.get(nome,
 * { cwd, signal, scope: parent })` carrega a definicao (o corpo markdown) e
 * `renderHarnessSkill` produz o bloco `<skill_content>` CANONICO — o mesmo
 * que o harness injeta num agente que invoca a skill pelo caminho normal —
 * seguido da instrucao do dono. O `request` NUNCA recebe token de nada: o
 * filho roda com as permissoes do HARNESS, e o unico conteudo nosso e texto
 * (S3: nada de segredos neste pipeline).
 * =============================================================================
 */

import type { AuditSink } from '../contracts/auth.ts'
import type { AgentRunKind, AgentRunMetrics, AgentRunStatus, AgentRunReport } from '../contracts/ipc.ts'
import {
  comporEventoAgenteCancelar,
  comporEventoAgenteDespacho,
  comporEventoAgenteFim,
} from '../audit/events.ts'
import { MAX_RUNS_PER_REPORT } from '../ipc/channel.ts'
import type { GuardLogger } from '../logging/logger.ts'
import { createUlidFactory } from '../ulid.ts'
import { ChatError, promptDeChatValido, type ChatService, type PedidoDeChat } from './chats.ts'
import type { ColetorDeMetricas } from './metrics.ts'
import {
  WorktreeError,
  nomeDeWorktreeValido,
  type PedidoDeWorktree,
  type WorktreeService,
} from './worktrees.ts'
import type {
  HarnessAgentRegistry,
  HarnessSkillRegistry,
  HarnessSubagentResult,
  HarnessSubagentRun,
  HarnessSubagentRuntime,
} from './harness.ts'
import { renderHarnessSkill } from './harness.ts'

/** O nome do provedor in-process do harness (config `providerName` do spawn). */
export const DEFAULT_PROVIDER_NAME = 'spawn'

/**
 * Teto do historico em memoria. A lista e efemera e pequena; o teto existe
 * para o relatorio nao crescer sem fim num uso prolongado — o run terminal
 * MAIS ANTIGO sai quando o teto e atingido.
 *
 * E METADE de `MAX_RUNS_PER_REPORT` (o teto do canal, 64) DE PROPOSITO: com o
 * teto de `agents.maxRuns` tambem em 32 (assert), a tabela inteira — 32 vivos
 * + 32 terminais — cabe numa unica mensagem `agent.report`.
 */
export const MAX_RUNS_HISTORY = 32

/**
 * Teto do resumo enviado ao dono. O `summary` vem do texto do MODELO (nunca
 * segredo — S3) e e mostrado no Telegram; o teto e o mesmo espirito do
 * `notify`: uma mensagem curta, nao a resposta inteira.
 */
export const MAX_SUMMARY_CHARS = 300

/** Status terminal derivado de cada `stopReason` do harness (fechado). */
function statusDe(reason: HarnessSubagentResult['stopReason']): Exclude<AgentRunStatus, 'running'> {
  switch (reason) {
    case 'completed':
      return 'done'
    case 'aborted':
      return 'cancelled'
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return 'failed'
  }
}

/** O que sobra da resposta do modelo para o `summary` (1 linha, cortado). */
function resumoDe(resultado: HarnessSubagentResult): string | undefined {
  const texto = resultado.output
    .map((bloco) => bloco.text)
    .join(' ')
    .trim()
  if (texto.length === 0) return undefined
  const semControlo = texto
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0)
    .join(' ')
  const cortado = semControlo.slice(0, MAX_SUMMARY_CHARS)
  return semControlo.length > MAX_SUMMARY_CHARS ? `${cortado}…` : cortado
}

/** Motivo da RECUSA SINCRONA de um despacho (a resposta do IPC usa-o). */
export type MotivoDeRecusa =
  /** A skill nao esta na allowlist (`config.agents.skills`) — default deny. */
  | 'skill-nao-permitida'
  /** O teto de runs concorrentes (`config.agents.maxRuns`) foi atingido. */
  | 'teto-atingido'
  /** Harness indisponivel (subagents/agents/skills ausentes) no momento. */
  | 'harness-indisponivel'

export type VereditoDeDespacho = { readonly ok: true } | { readonly ok: false; readonly motivo: MotivoDeRecusa }

/** O pedido de dispatch, montado pela superficie (surface-ipc). */
export interface PedidoDeDespacho {
  /** A skill a disparar (kebab-case; a allowlist decide). */
  readonly skill: string
  /** A instrucao do dono para o agente. */
  readonly prompt: string
  /** A origem pre-formatada (`telegram:<id>`) — o que o audit grava. */
  readonly origem: string
}

/** Um run vivo na tabela interna (nao e o `AgentRunReport` — tem handles). */
interface RunInterno {
  /** Id CURTO (8 caracteres da parte aleatoria do ULID) — o que `cancel` usa. */
  readonly id: string
  readonly skill: string
  readonly origem: string
  readonly startedAt: number
  status: AgentRunStatus
  summary?: string | undefined
  /** O cancelamento deste run: aborta o sinal do harness E o dispose. */
  readonly abortar: AbortController
  /** O handle publicado (presente a partir do `start()` resolver). */
  run: HarnessSubagentRun | undefined
  /**
   * EMENDA ONDA-3-HOST-TAREFAS: a NATUREZA do run. Ausente = `agent` (o
   * dispatch de sempre — e o contrato manda EMITIR ausente nesse caso).
   */
  kind?: AgentRunKind | undefined
  /** O worktree ligado ao run (`chat.new` com worktree, ou o nome de um `worktree.create`). */
  worktree?: string | undefined
  /**
   * A SESSAO do harness ligada a este run: a sessao do chat criado, ou — para
   * runs de subagente — o `id` do handle (`SubagentRun.id` e "the published
   * child session id", `packages/subagent/subagent/src/types.ts:308-314`). E o
   * que liga o run as metricas REAIS (`src/agents/metrics.ts`).
   */
  sessao?: string | undefined
}

/* ========================================================================== */
/* EMENDA ONDA-3-HOST-TAREFAS — as TAREFAS de chat e de worktree               */
/* ========================================================================== */

/**
 * O rotulo de `skill` de uma tarefa de chat no `AgentRunReport`.
 *
 * PORQUE `'novo-chat'` e nao a intent: o codec do report valida `skill` com a
 * gramatica kebab-case de skill (`buildAgentRun` -> `isSkillName`, a gramatica
 * PUBLICA do harness `^[a-z0-9]+(?:-[a-z0-9]+)*$` em `src/ipc/channel.ts`) —
 * `'chat.new'` tem ponto e rejeitaria a LINHA INTEIRA do report. O rotulo usa
 * o nome do COMANDO que o dono conhece (`/novo-chat`); a NATUREZA do run viaja
 * no campo `kind` (contrato congelado).
 */
export const ROTULO_TAREFA_CHAT = 'novo-chat'

/** O rotulo de `skill` de uma tarefa de worktree (`/worktree`) — ver {@link ROTULO_TAREFA_CHAT}. */
export const ROTULO_TAREFA_WORKTREE = 'worktree'

/** O pedido de uma tarefa de worktree (o `worktree.create` + a origem do audit). */
export interface PedidoDeTarefaWorktree extends PedidoDeWorktree {
  /** A origem pre-formatada (`telegram:<id>`) — o que o audit grava. */
  readonly origem: string
}

/** Motivo de RECUSA SINCRONA de uma tarefa (a resposta do IPC usa-a). */
export type MotivoDeRecusaDeTarefa =
  /** O teto de runs concorrentes (`config.agents.maxRuns`) foi atingido. */
  | 'teto-atingido'
  /** Harness indisponivel (chats/worktrees ausentes) ou pedido invalido no host. */
  | 'tarefa-indisponivel'

/**
 * O veredito de uma tarefa. `jaExistia` e o NOOP honesto do `worktree.create`:
 * o worktree pedido ja esta la ("ja estava no estado pedido" — e nada foi
 * destruido, a regra eterna).
 */
export type VereditoDeTarefa =
  | { readonly ok: true; readonly jaExistia?: boolean }
  | { readonly ok: false; readonly motivo: MotivoDeRecusaDeTarefa }

/**
 * A porta de SAIDA das tarefas novas (chat/worktree) — a mesma disciplina do
 * `AgentRegistry` (veredito sincrono, efeito assincrono, relatorio honesto),
 * numa interface PROPRIA para o contrato de `AgentRegistry` nao mexer: quem
 * so conhece dispatch de subagentes continua a compilar intocado.
 */
export interface TarefasHost {
  /** `chat.new`: cria a sessao e submete o prompt (o efeito corre depois do ack). */
  novoChat(pedido: PedidoDeChat): VereditoDeTarefa
  /** `worktree.create`: cria a worktree git (o efeito corre depois do ack). */
  novoWorktree(pedido: PedidoDeTarefaWorktree): VereditoDeTarefa
}

export interface AgentRegistryDeps {
  /** A allowlist de skills disparaveis (config `agents.skills`). VAZIA = nada. */
  readonly skillsPermitidas: readonly string[]
  /** Teto de runs CONCORRENTES (config `agents.maxRuns`; o assert impoe 1..32). */
  readonly maxRuns: number
  /** O provedor do harness (`'spawn'` — in-process, sessao fresca). */
  readonly providerName: string
  /** GETTERS LAZY dos servicos — nunca capturados no arranque (ver o cabecalho). */
  readonly subagents: () => HarnessSubagentRuntime | undefined
  readonly agentesDoHarness: () => HarnessAgentRegistry | undefined
  readonly skillsDoHarness: () => HarnessSkillRegistry | undefined
  /** Onde cada despacho/cancelamento/fim e contado. */
  readonly audit: Pick<AuditSink, 'append'>
  readonly log: GuardLogger
  /** Relogio injetado (04-TESTES.md 8.1): nunca `Date.now` direto. */
  readonly now: () => number
  /**
   * Difusao do relatorio ao worker (best-effort — o canal pode estar em
   * baixo). Chamado em CADA transicao terminal: `agent.report` proativo.
   */
  readonly enviarRelatorio?: ((relatorio: AgentRunReport[]) => void) | undefined
  /**
   * EMENDA ONDA-3-HOST-TAREFAS: o servico de CHATS (a costura de
   * `src/agents/chats.ts`). AUSENTE, `novoChat` recusa (fail-closed).
   */
  readonly chats?: (() => ChatService | undefined) | undefined
  /** O servico de WORKTRETS (`src/agents/worktrees.ts`). AUSENTE, `novoWorktree` recusa. */
  readonly worktrees?: (() => WorktreeService | undefined) | undefined
  /**
   * O coletor de METRICAS REAIS (`src/agents/metrics.ts`). AUSENTE, o campo
   * `metrics` do report e OMITIDO — nunca estimado.
   */
  readonly metricas?: (() => ColetorDeMetricas | undefined) | undefined
}

export interface AgentRegistry {
  /**
   * Decide o despacho de forma SINCRONA e arranca o run em segundo plano.
   *
   * As recusas de POLITICA (allowlist, teto, harness ausente) sao sincronas —
   * a superficie responde-as no proprio tick. O que e assincrono (carregar a
   * skill, o `start()` do harness) corre depois do ack: uma falha ai nao
   * desfaz o ack — o run nasce e termina `failed` com o motivo no `summary`,
   * e o relatorio (difusao) diz a verdade ao dono.
   */
  despachar(pedido: PedidoDeDespacho): VereditoDeDespacho
  /** A lista COMPLETA para o `agent.report` (vivos + terminais em memoria). */
  estado(): AgentRunReport[]
  /**
   * Cancela um run pelo id CURTO. `false` = id desconhecido (noop idempotente
   * — o mesmo espirito de um `stop` em `STOPPED`).
   */
  cancelar(agentId: string, origem: string): boolean
  /**
   * Mata TUDO em LIFO (o mais recente primeiro), marca `cancelled` e liberta
   * os handles. SINCRONO: o cancelamento do harness e fire-and-forget (o
   * disposer nao pode devolver Promise — garantia LIFO da Fiber, Q-2).
   */
  dispose(): void
}

export function createAgentRegistry(deps: AgentRegistryDeps): AgentRegistry & TarefasHost {
  const { log } = deps
  /** Ids curtos: ULID completo, so a parte ALEATORIA (os 8 ultimos chars). */
  const ulid = createUlidFactory(deps.now)
  const runs: RunInterno[] = []

  const permitida = (skill: string): boolean => deps.skillsPermitidas.includes(skill)

  const contando = (runsAtivos: number): boolean => runsAtivos >= deps.maxRuns

  /**
   * EMENDA ONDA-3-HOST-TAREFAS: as metricas REAIS de UM run, lidas AGORA (o
   * `agent.report` e sincrono). A sessao-alvo: a do chat criado; ou, para um
   * run de subagente, o `id` do handle — que e "the published child session
   * id" (`packages/subagent/subagent/src/types.ts:308-314`). Sem sessao (ou
   * sem coletor) = `undefined` -> o campo `metrics` e OMITIDO (nunca estimado).
   */
  const metricasDe = (run: RunInterno): AgentRunMetrics | undefined => {
    const coletor = deps.metricas?.()
    return coletor?.daSessao(run.sessao ?? run.run?.id)
  }

  /**
   * A lista COMPLETA (vivos + terminais em memoria) — o corpo do relatorio.
   *
   * CAPADA POR CONSTRUCAO a `MAX_RUNS_PER_REPORT` (EMENDA
   * ONDA-4-FIX-REPORT-CAPS): `slice(-MAX_RUNS_PER_REPORT)` mantem os runs
   * MAIS RECENTES e nunca ultrapassa o teto do codec, que RECUSA listas
   * maiores com `IPC_MESSAGE_INVALID` — um `agent.status` sem relatorio e
   * difusoes perdidas nao podem acontecer, mesmo que `maxRuns` ou o teto do
   * historico mudem no futuro. A poda de historico (`podarHistorico`) e a
   * outra rede; esta e a da EMISSAO, a ultima antes do canal.
   *
   * EMENDA ONDA-2 (campos ADITIVOS) na leitura da EMENDA ONDA-3: `kind` so
   * viaja quando != 'agent' (contrato: "ausente = agent" — o run antigo emite
   * EXATAMENTE a linha de sempre), `worktree` so quando ligado, `metrics` so
   * quando REALMENTE medido. Os runs de subagente continuam a serializar como
   * sempre quando nao ha nada medido.
   */
  const relatorio = (): AgentRunReport[] =>
    runs.slice(-MAX_RUNS_PER_REPORT).map((run) => {
      const metricas = metricasDe(run)
      return {
        id: run.id,
        skill: run.skill,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.kind === undefined ? {} : { kind: run.kind }),
        ...(run.worktree === undefined ? {} : { worktree: run.worktree }),
        ...(metricas === undefined ? {} : { metrics: metricas }),
        ...(run.summary === undefined ? {} : { summary: run.summary }),
      }
    })

  const difundir = (): void => {
    try {
      deps.enviarRelatorio?.(relatorio())
    } catch (error) {
      // Best-effort (o padrao de notify.ts): uma difusao avariada nao pode
      // derrubar o run que a originou.
      log.error(
        `difusao de agent.report falhou: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Marca o run terminal, audita e difunde. UNICO ponto de saida de um run —
   * o `summary` e o relatorio nascem aqui, e so aqui.
   */
  const encerrar = (run: RunInterno, status: Exclude<AgentRunStatus, 'running'>, summary?: string): void => {
    run.status = status
    if (summary !== undefined) run.summary = summary
    try {
      deps.audit.append({
        evento: comporEventoAgenteFim(run.origem, run.skill, status),
        resultado: status === 'done' ? 'permitido' : 'negado',
      })
    } catch (error) {
      log.error(`falha ao auditar o fim do agente: ${error instanceof Error ? error.message : String(error)}`)
    }
    difundir()
  }

  /**
   * A parte ASSINCRONA do dispatch: carrega a skill, spawna no harness,
   * vigia o resultado e encerra o run. Corre DEPOIS do ack (o padrao do IPC:
   * trabalho lento responde `accepted` ja e difunde o resto depois).
   */
  const executar = async (run: RunInterno, skill: string, prompt: string): Promise<void> => {
    try {
      const subagents = deps.subagents()
      const agentes = deps.agentesDoHarness()
      const skills = deps.skillsDoHarness()
      if (subagents === undefined || agentes === undefined || skills === undefined) {
        encerrar(run, 'failed', 'O harness nao esta disponivel para disparar agentes.')
        return
      }

      // O PARENT: o agente-racaiz vivo do harness, no momento do despacho. O
      // cwd da sessao dele e o workspace do filho (spawn in-process).
      const parent = agentes.roots()[0]
      if (parent === undefined) {
        encerrar(run, 'failed', 'Nenhum agente do harness esta vivo para disparar.')
        return
      }

      // A SKILL: carregada no catalogo DO AGENTE-PAI (a mesma vista que ele
      // teria). Allowlist ja passou (sincrono); aqui a skill pode nao existir
      // na instalacao — o run termina failed, nunca inventa.
      const definicao = await skills.get(skill, {
        cwd: parent.session.header.cwd,
        signal: run.abortar.signal,
        scope: parent,
      })
      if (definicao === undefined) {
        encerrar(run, 'failed', `A skill "${skill}" nao existe nesta instalacao do harness.`)
        return
      }

      // O PROMPT: o bloco <skill_content> CANONICO + a instrucao do dono. O
      // request nunca recebe token nem credencial (S3) — so texto.
      const corpo = renderHarnessSkill(definicao)
      const handle = await subagents.start(deps.providerName, {
        label: skill,
        prompt: [{ type: 'text', text: `${corpo}\n\n${prompt}` }],
        parent,
        signal: run.abortar.signal,
      })
      run.run = handle

      let resultado: HarnessSubagentResult
      try {
        resultado = await handle.result
      } catch (error) {
        // O `result` NAO rejeita em falha de nivel do filho (resolve com
        // stopReason) — rejeitar e falha de INFRAESTRUTURA do seam.
        encerrar(
          run,
          'failed',
          `falha de infraestrutura do harness: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      encerrar(run, statusDe(resultado.stopReason), resumoDe(resultado))
    } catch (error) {
      // `start()` REJEITA em falha de ARRANQUE (sem run publicado): provider
      // ausente, cancelado antes da publicacao, harness a falhar. Um abort
      // EXPLICITO (cancel ou disposer) antes da publicacao nao e falha — e
      // 'cancelled', a leitura honesta de "o dono cancelou antes de nascer".
      if (run.abortar.signal.aborted) {
        encerrar(run, 'cancelled')
        return
      }
      const motivo = error instanceof Error ? error.message : String(error)
      encerrar(run, 'failed', `nao foi possivel disparar o agente: ${motivo}`)
    }
  }

  /** Um run terminal pode sair do historico para o teto caber. */
  const podarHistorico = (): void => {
    while (runs.length > MAX_RUNS_HISTORY) {
      const maisAntigo = runs[0]
      if (maisAntigo === undefined || maisAntigo.status === 'running') break
      runs.shift()
    }
  }

  /**
   * EMENDA ONDA-3-HOST-TAREFAS: a parte ASSINCRONA de `chat.new` — criar a
   * sessao, submeter o prompt, e so terminar o run quando o turno atinge a
   * quiescencia (o `whenIdle` do harness). O run e a TAREFA ("correr este
   * prompt como chat"); a SESSAO vive depois dele — a conversa continua na Web
   * UI, e o `summary` diz onde.
   *
   * Como em `executar`, uma falha depois de o veredito estar decidido nao
   * desfaz o ack: o run nasce e termina com o status HONESTO, e o `agent.report`
   * (difusao) conta a historia ao dono. (A criacao da sessao corre no prefixo
   * sincrono do veredito — ver `registarTarefa`.)
   */
  const executarChat = async (run: RunInterno, pedido: PedidoDeChat): Promise<void> => {
    const chats = deps.chats?.()
    if (chats === undefined) {
      encerrar(run, 'failed', 'O harness nao esta disponivel para criar chats.')
      return
    }
    let sessionId: string | undefined
    try {
      const criado = await chats.criar(pedido, { signal: run.abortar.signal })
      sessionId = criado.sessionId
      run.sessao = sessionId
      // DIFUSAO APOS O EFEITO de criacao: o dono passa a ver a tarefa ligada a
      // sessao (e as metricas reais que ja existirem).
      difundir()
      await chats.aguardarQuiete(sessionId)
      // Cancelado durante a espera: o `cancelar` ja escreveu o estado — aqui
      // so se fecha o audit/fim (o mesmo padrao do `result` do subagente).
      const terminal = run.status === 'running' ? 'done' : 'cancelled'
      const resposta = chats.ultimaResposta(sessionId)
      encerrar(
        run,
        terminal,
        terminal === 'done'
          ? resposta
            ?? `sem resposta do modelo; continua o chat na Web UI (sessao ${sessionId}).`
          : undefined,
      )
    } catch (error) {
      if (run.status !== 'running') return
      if (run.abortar.signal.aborted) {
        encerrar(run, 'cancelled')
        return
      }
      if (error instanceof ChatError) {
        // A mensagem do ChatError ja e S3-segura (composta pelo host); o
        // diagnostico bruto vai para o log.
        if (error.detail !== undefined && error.detail.length > 0) {
          log.warn(`tarefa de chat ${run.id}: ${error.code}: ${error.detail}`)
        }
        encerrar(run, 'failed', error.message)
        return
      }
      log.error(
        `tarefa de chat ${run.id} falhou: ${error instanceof Error ? error.message : String(error)}`,
      )
      encerrar(run, 'failed', 'Nao foi possivel criar o chat (detalhe no log do plugin).')
    }
  }

  /**
   * EMENDA ONDA-3-HOST-TAREFAS: a parte ASSINCRONA de `worktree.create` — o
   * `git worktree add` por child process. O run termina quando o git termina;
   * o `summary` e S3-seguro (o caminho NUNCA viaja para o Telegram — a worktree
   * e referenciada pelo NOME, que ja e o campo `worktree` do report).
   */
  const executarWorktree = async (run: RunInterno, pedido: PedidoDeTarefaWorktree): Promise<void> => {
    const worktrees = deps.worktrees?.()
    if (worktrees === undefined) {
      encerrar(run, 'failed', 'O harness nao esta disponivel para criar worktrees.')
      return
    }
    try {
      const criada = await worktrees.criar(
        { nome: pedido.nome, ...(pedido.base === undefined ? {} : { base: pedido.base }) },
        { signal: run.abortar.signal },
      )
      encerrar(
        run,
        'done',
        `worktree "${criada.nome}" criada (branch ${criada.branch}, a partir de ${criada.base}).`,
      )
    } catch (error) {
      if (run.status !== 'running') return
      if (error instanceof WorktreeError) {
        if (error.code === 'WORKTREE_CANCELLED') {
          encerrar(run, 'cancelled')
          return
        }
        if (error.detail !== undefined && error.detail.length > 0) {
          log.warn(`tarefa de worktree ${run.id}: ${error.code}: ${error.detail}`)
        }
        encerrar(run, 'failed', error.message)
        return
      }
      if (run.abortar.signal.aborted) {
        encerrar(run, 'cancelled')
        return
      }
      log.error(
        `tarefa de worktree ${run.id} falhou: ${error instanceof Error ? error.message : String(error)}`,
      )
      encerrar(run, 'failed', 'Nao foi possivel criar o worktree (detalhe no log do plugin).')
    }
  }

  /**
   * Cria o run de uma tarefa (chat ou worktree) e LANCA o efeito.
   *
   * ORDEM REAL (emenda de honestidade apos revisao): o efeito COMECA no
   * PREFIXO SINCRONO do veredito — `chats.criar` cria a sessao e
   * `worktrees.criar` faz o spawn do `git` antes de o `novo*` retornar, logo
   * antes de o ack sair para o worker. O que e assincrono (a submissao do
   * prompt, o `whenIdle`, o exit do git) continua depois do ack, e e a
   * transicao terminal que dispara o `agent.report`. Um teste prende esta
   * ordem (`test/unit/agents/tarefas.test.ts` — "o efeito COMECA no prefixo
   * sincrono do veredito").
   */
  const registarTarefa = (
    skill: string,
    kind: AgentRunKind,
    origem: string,
    worktree: string | undefined,
    executar: (run: RunInterno) => Promise<void>,
  ): void => {
    const run: RunInterno = {
      id: ulid().slice(-8),
      skill,
      origem,
      startedAt: deps.now(),
      status: 'running',
      abortar: new AbortController(),
      run: undefined,
      kind,
      ...(worktree === undefined ? {} : { worktree }),
    }
    runs.push(run)
    podarHistorico()
    try {
      deps.audit.append({
        evento: comporEventoAgenteDespacho(origem, skill),
        resultado: 'permitido',
      })
    } catch (error) {
      log.error(`falha ao auditar a tarefa: ${error instanceof Error ? error.message : String(error)}`)
    }
    void executar(run)
  }

  return {
    despachar(pedido) {
      // 1. ALLOWLIST — default deny. A comparacao e por inclusao na lista
      //    configurada; o codec ja exigiu a grammar kebab-case no transporte.
      if (!permitida(pedido.skill)) {
        try {
          deps.audit.append({
            evento: comporEventoAgenteDespacho(pedido.origem, pedido.skill),
            resultado: 'negado',
          })
        } catch (error) {
          log.error(`falha ao auditar a recusa do agente: ${error instanceof Error ? error.message : String(error)}`)
        }
        log.warn(
          `despacho de agente RECUSADO: a skill '${pedido.skill}' nao esta na allowlist ` +
            `(config agents.skills; vazio = nenhum agente disparavel).`,
        )
        return { ok: false, motivo: 'skill-nao-permitida' }
      }

      // 2. TETO de runs CONCORRENTES. O que conta sao os vivos; um run que
      //    ainda nao publicou (a executar) ja conta — o teto protege o harness.
      const ativos = runs.filter((run) => run.status === 'running').length
      if (contando(ativos)) {
        try {
          deps.audit.append({
            evento: comporEventoAgenteDespacho(pedido.origem, pedido.skill),
            resultado: 'negado',
          })
        } catch (error) {
          log.error(`falha ao auditar o teto de agentes: ${error instanceof Error ? error.message : String(error)}`)
        }
        log.warn(
          `despacho de agente RECUSADO: ${String(ativos)} runs ativos atingem o teto ` +
            `config agents.maxRuns (${String(deps.maxRuns)}).`,
        )
        return { ok: false, motivo: 'teto-atingido' }
      }

      // 3. HARNESS AUSENTE — fail-closed antes de qualquer spawn. (A checagem
      //    fina corre em `executar`, apos o ack; aqui so a presenca dos
      //    servicos, que e a unica condicao SINCRONA.)
      if (deps.subagents() === undefined || deps.agentesDoHarness() === undefined || deps.skillsDoHarness() === undefined) {
        log.warn(
          'despacho de agente RECUSADO: os servicos do harness (subagents/agents/skills) ' +
            'nao estao todos disponiveis.',
        )
        return { ok: false, motivo: 'harness-indisponivel' }
      }

      // 4. ACEITE: cria o run e arranca a parte assincrona. O ack ja pode
      //    sair — o resultado chega por `agent.report` (difusao).
      const run: RunInterno = {
        id: ulid().slice(-8),
        skill: pedido.skill,
        origem: pedido.origem,
        startedAt: deps.now(),
        status: 'running',
        abortar: new AbortController(),
        run: undefined,
      }
      runs.push(run)
      podarHistorico()
      try {
        deps.audit.append({
          evento: comporEventoAgenteDespacho(pedido.origem, pedido.skill),
          resultado: 'permitido',
        })
      } catch (error) {
        log.error(`falha ao auditar o despacho do agente: ${error instanceof Error ? error.message : String(error)}`)
      }
      void executar(run, pedido.skill, pedido.prompt)
      return { ok: true }
    },

    /* --- EMENDA ONDA-3-HOST-TAREFAS: as tarefas de chat e de worktree ---- */

    novoChat(pedido) {
      // 1. HARNESS AUSENTE — fail-closed antes de qualquer efeito.
      const chats = deps.chats?.()
      if (chats === undefined) {
        log.warn('tarefa de chat RECUSADA: o servico de chats do harness nao esta disponivel.')
        return { ok: false, motivo: 'tarefa-indisponivel' }
      }
      // 2. REVALIDACAO S6 (defesa em profundidade: o worker e o codec ja
      //    recusaram; aqui so um prompt "texto limpo <= 4096" chega ao efeito).
      if (!promptDeChatValido(pedido.prompt)) {
        log.warn('tarefa de chat RECUSADA: prompt fora do contrato (texto limpo, 1..4096).')
        return { ok: false, motivo: 'tarefa-indisponivel' }
      }
      // 3. TETO de runs CONCORRENTES (a mesma conta dos subagentes: as tarefas
      //    tambem consomem o harness — a leitura fechada e a correta).
      const ativos = runs.filter((run) => run.status === 'running').length
      if (contando(ativos)) {
        try {
          deps.audit.append({
            evento: comporEventoAgenteDespacho(pedido.origem, ROTULO_TAREFA_CHAT),
            resultado: 'negado',
          })
        } catch (error) {
          log.error(`falha ao auditar o teto de tarefas: ${error instanceof Error ? error.message : String(error)}`)
        }
        log.warn(
          `tarefa de chat RECUSADA: ${String(ativos)} runs ativos atingem o teto ` +
            `config agents.maxRuns (${String(deps.maxRuns)}).`,
        )
        return { ok: false, motivo: 'teto-atingido' }
      }
      // 4. ACEITE: o run nasce e o efeito COMECA neste proprio tick (a sessao e
      //    criada em sincrono; o resto segue depois do ack). `chat.new` SEM
      //    worktree emite `worktree` ausente (contrato).
      registarTarefa(ROTULO_TAREFA_CHAT, 'chat', pedido.origem, pedido.worktree, (run) =>
        executarChat(run, pedido),
      )
      return { ok: true }
    },

    novoWorktree(pedido) {
      // 1. HARNESS AUSENTE — fail-closed.
      const worktrees = deps.worktrees?.()
      if (worktrees === undefined) {
        log.warn('tarefa de worktree RECUSADA: o servico de worktrees nao esta disponivel.')
        return { ok: false, motivo: 'tarefa-indisponivel' }
      }
      // 2. REVALIDACAO S6 da gramatica do nome (`/^[a-z0-9-]{1,40}$/`).
      if (!nomeDeWorktreeValido(pedido.nome)) {
        log.warn('tarefa de worktree RECUSADA: nome fora da gramatica [a-z0-9-]{1,40}.')
        return { ok: false, motivo: 'tarefa-indisponivel' }
      }
      // 3. JA EXISTE = NOOP honesto ("ja estava no estado pedido") — e
      //    NUNCA destruir: o caminho ocupado nunca e removido nem recriado.
      try {
        if (worktrees.existe(pedido.nome)) {
          return { ok: true, jaExistia: true }
        }
      } catch (error) {
        log.warn(
          `tarefa de worktree RECUSADA: nao foi possivel inspecionar o caminho: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
        return { ok: false, motivo: 'tarefa-indisponivel' }
      }
      // 4. TETO de runs CONCORRENTES.
      const ativos = runs.filter((run) => run.status === 'running').length
      if (contando(ativos)) {
        try {
          deps.audit.append({
            evento: comporEventoAgenteDespacho(pedido.origem, ROTULO_TAREFA_WORKTREE),
            resultado: 'negado',
          })
        } catch (error) {
          log.error(`falha ao auditar o teto de tarefas: ${error instanceof Error ? error.message : String(error)}`)
        }
        log.warn(
          `tarefa de worktree RECUSADA: ${String(ativos)} runs ativos atingem o teto ` +
            `config agents.maxRuns (${String(deps.maxRuns)}).`,
        )
        return { ok: false, motivo: 'teto-atingido' }
      }
      // 5. ACEITE: run `kind: 'worktree'` com o NOME no campo `worktree`.
      registarTarefa(ROTULO_TAREFA_WORKTREE, 'worktree', pedido.origem, pedido.nome, (run) =>
        executarWorktree(run, pedido),
      )
      return { ok: true }
    },

    estado(): AgentRunReport[] {
      return relatorio()
    },

    cancelar(agentId, origem) {
      const alvo = runs.find((run) => run.id === agentId)
      if (alvo === undefined || alvo.status !== 'running') {
        // Id desconhecido OU run ja terminal: noop idempotente (o contrato
        // responde `noop`, nunca um erro — o mesmo de `stop` em `STOPPED`).
        return false
      }
      // O cancelamento e DUPLO: o sinal aborta o turno em curso no harness e
      // o `dispose()` liberta o handle publicado ("always dispose"). O status
      // terminal vem por `result` (stopReason 'aborted' -> 'cancelled'); se o
      // result demorar, o relatorio ja difunde o estado novo aqui.
      alvo.abortar.abort('cancelado pelo dono')
      // EMENDA ONDA-3: uma tarefa de chat cancela tambem o TURNO da sessao
      // (`SessionController.cancel` — "Cancel one active Agent turn without
      // dropping its pending inbox"); o abort do sinal so mata a nossa espera.
      if (alvo.sessao !== undefined) deps.chats?.()?.cancelar(alvo.sessao)
      // O status muda JA: o relatorio reflete o cancelamento no proprio tick
      // (o `result` do harness pode demorar um instante a assentar, e o dono
      // nao pode ver 'running' para um run que acabou de cancelar).
      alvo.status = 'cancelled'
      if (alvo.run !== undefined) {
        void alvo.run.dispose().catch((error) => {
          log.error(`falha ao dispor o run cancelado: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      difundir()
      try {
        deps.audit.append({
          evento: comporEventoAgenteCancelar(origem, agentId),
          resultado: 'permitido',
        })
      } catch (error) {
        log.error(`falha ao auditar o cancelamento do agente: ${error instanceof Error ? error.message : String(error)}`)
      }
      // O `result` do harness resolve com 'aborted' -> `encerrar` corre e
      // difunde; o estado entre o abort e o result continua `running` mas o
      // turno ja nao trabalha (o abort e o controlo real).
      return true
    },

    dispose(): void {
      // LIFO: o mais recente primeiro (a mesma garantia da Fiber). O abort
      // SINCRONO para o turno; o dispose do harness e fire-and-forget — o
      // disposer deste registry tem de ser sincrono (Q-2).
      for (const run of runs.toReversed()) {
        if (run.status !== 'running') continue
        run.abortar.abort('desligamento do plugin')
        // EMENDA ONDA-3: turnos de chat tambem se calam no desligamento (o
        // turno nao pode sobreviver ao plugin que o abriu).
        if (run.sessao !== undefined) deps.chats?.()?.cancelar(run.sessao)
        if (run.run !== undefined) {
          void run.run.dispose().catch(() => {
            // O plugin esta a desligar; nao ha para onde registar.
          })
        }
        run.status = 'cancelled'
      }
    },
  }
}
