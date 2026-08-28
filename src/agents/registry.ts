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
import type { AgentRunStatus, AgentRunReport } from '../contracts/ipc.ts'
import {
  comporEventoAgenteCancelar,
  comporEventoAgenteDespacho,
  comporEventoAgenteFim,
} from '../audit/events.ts'
import { MAX_RUNS_PER_REPORT } from '../ipc/channel.ts'
import type { GuardLogger } from '../logging/logger.ts'
import { createUlidFactory } from '../ulid.ts'
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

export function createAgentRegistry(deps: AgentRegistryDeps): AgentRegistry {
  const { log } = deps
  /** Ids curtos: ULID completo, so a parte ALEATORIA (os 8 ultimos chars). */
  const ulid = createUlidFactory(deps.now)
  const runs: RunInterno[] = []

  const permitida = (skill: string): boolean => deps.skillsPermitidas.includes(skill)

  const contando = (runsAtivos: number): boolean => runsAtivos >= deps.maxRuns

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
   */
  const relatorio = (): AgentRunReport[] =>
    runs.slice(-MAX_RUNS_PER_REPORT).map((run) => ({
      id: run.id,
      skill: run.skill,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.summary === undefined ? {} : { summary: run.summary }),
    }))

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
