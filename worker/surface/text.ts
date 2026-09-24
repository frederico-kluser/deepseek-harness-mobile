/**
 * TEXTO DE ESTADO e formatadores NEUTROS da superficie (onda 2 — nucleo).
 *
 * Port fiel da seccao "TEXTO DE ESTADO (TG-084)" de `worker/commands/router.ts`
 * (DONO de referencia: T5.2). Nenhuma semantica muda aqui: os textos PT-BR sao
 * BYTE A BYTE iguais aos atuais (TG-084) e a maquina que produz o estado so faz
 * crescer sobre o comportamento que estes textos ja provam.
 *
 * ===========================================================================
 * PORQUE ESTE MODULO E NEUTRO
 * ===========================================================================
 * O router antigo hard-codava `MAX_TEXTO_MENSAGEM = 4_096` (o teto da Bot API).
 * A superficie neutra declara o teto por PROVEDOR em `SurfaceLimits.maxTextLength`
 * (`worker/surface/contract.ts`) — o codigo corta AQUI, nunca apos a ida a rede
 * (TG-048). {@link cortarTexto} aceita o limite por parametro; o nucleo neutro
 * passa-lhe `deps.limits.maxTextLength`. O default de modulo so existe para
 * cenario "sem limite injectado" e preserva o valor historico do Telegram.
 *
 * ===========================================================================
 * TG-084 — O TEXTO NAO EXPÕE SEGREDO NEM DIGEST
 * ===========================================================================
 * Este ficheiro NAO recebe nem produz segredo: so estado, seq, URL (sse READY),
 * tempo no ar e expiracao do TTL. O digest do codigo de pareamento (S3-b) nunca
 * chega aqui por construcao — nao ha campo para ele em {@link SurfaceProjectionState}.
 */

import type {
  AgentRunKind,
  AgentRunMetrics,
  AgentRunReport,
  AgentRunStatus,
} from '../../src/contracts/ipc.ts'
import type { SurfaceProjectionState, SurfaceTunnelState } from './contract.ts'

/* ========================================================================== */
/* 1. ROTULOS DE ESTADO                                                       */
/* ========================================================================== */

/** Rotulos em portugues — texto de UI; codigo e payload usam o enum (tunnel.ts). */
export const ROTULOS_DE_ESTADO: Readonly<Record<SurfaceTunnelState, string>> = Object.freeze({
  STOPPED: 'desligado',
  STARTING: 'ligando',
  READY: 'online',
  DEGRADED: 'instável, tentando de novo',
  STOPPING: 'desligando',
  FAILED: 'falhou — precisa de ação sua',
})

/** O conjunto fechado de estados que {@link ROTULOS_DE_ESTADO} cobre. */
export type EstadoDoTunel = SurfaceTunnelState

/**
 * Estreita o `state` da projecao neutra (que o contrato tipa como `string |
 * undefined`) para o vocabulario fechado de {@link SurfaceTunnelState}. `false` quando
 * o host ainda nao difundiu estado (`undefined`) ou um estado fora do enum
 * chegou — este ultimo nao pode acontecer (S4: o parser do canal ja o fechou),
 * mas um corte defensivo custa menos do que um `unknown` a vazar.
 */
export function estreitarEstado(state: string | undefined): SurfaceTunnelState | undefined {
  if (state === undefined) return undefined
  return (ROTULOS_DE_ESTADO as Readonly<Record<string, string>>)[state] === undefined
    ? undefined
    : (state as SurfaceTunnelState)
}

/* ========================================================================== */
/* 2. DURACAO E HORA                                                          */
/* ========================================================================== */

/** `ms` -> «menos de 1 min», «N min», «N h M min», «agora». Deterministico. */
export function formatarDuracao(ms: number): string {
  if (ms <= 0) return 'agora'
  if (ms < 60_000) return 'menos de 1 min'
  const minutos = Math.floor(ms / 60_000)
  if (minutos < 60) return `${String(minutos)} min`
  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60
  return resto === 0 ? `${String(horas)} h` : `${String(horas)} h ${String(resto)} min`
}

/** `ms` -> «HH:MM» no fuso local. */
export function formatarHora(ms: number): string {
  const data = new Date(ms)
  const h = String(data.getHours()).padStart(2, '0')
  const m = String(data.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/* ========================================================================== */
/* 3. O TEXTO DE ESTADO                                                        */
/* ========================================================================== */

/**
 * O texto de /status e das difusoes de estado. NAO expoe segredo nem digest
 * (TG-084): so estado, seq, URL (sse READY), tempo no ar e expiracao do TTL.
 *
 * `agora` e o instante actual — injectado (o nucleo passa `deps.time.now()`) para
 * ser deterministico em teste, como todo o relogio deste worker (TG-084 usa
 * `readyDesde` derivado localmente, porque a mensagem de estado nao o carrega).
 */
export function textoDeEstado(projecao: SurfaceProjectionState, agora: number): string {
  const estado = estreitarEstado(projecao.state)
  if (estado === undefined) {
    return 'Estado: desconhecido (o host ainda não enviou estado)'
  }
  const linhas: string[] = [
    `Estado: ${ROTULOS_DE_ESTADO[estado]} (${estado})`,
    `Sequência: ${String(projecao.seq)}`,
  ]
  if (estado === 'READY') {
    if (projecao.url !== undefined) linhas.push(`Túnel: ${projecao.url}`)
    if (projecao.readyDesde !== undefined) {
      linhas.push(`No ar há: ${formatarDuracao(agora - projecao.readyDesde)}`)
    }
    if (projecao.expiresAt !== undefined) {
      linhas.push(
        `Expira: em ${formatarDuracao(projecao.expiresAt - agora)} (${formatarHora(projecao.expiresAt)})`,
      )
    }
  }
  return linhas.join('\n')
}

/**
 * O texto CURTO do /status/cartão (Onda 3 — CONTRATO §5): 1-3 linhas PT-BR, sem
 * `Sequência:` nem código EN. `textoDeEstado` mantém-se para o LOG de auditoria
 * (a soma `seq`/código EN à linha de debug é responsabilidade de quem loga);
 * este mostra só o essencial que o dono lê.
 *
 * NAO expoe segredo nem digest (TG-084): só estado, URL (sse READY), tempo no
 * ar e expiração do TTL. `agora` é o instante actual — injectado para ser
 * determinístico em teste.
 */
export function textoDeEstadoCurto(projecao: SurfaceProjectionState, agora: number): string {
  const estado = estreitarEstado(projecao.state)
  switch (estado) {
    case 'READY': {
      const linhas = [`📶 Túnel *online* há ${formatarDuracao(agora - (projecao.readyDesde ?? agora))}.`]
      if (projecao.url !== undefined) linhas.push(`Link: ${projecao.url}`)
      if (projecao.expiresAt !== undefined) {
        linhas.push(`Expira daqui a ${formatarDuracao(projecao.expiresAt - agora)}.`)
      }
      return linhas.join('\n')
    }
    case 'STOPPED':
      return 'Túnel desligado. Nada ficou exposto.'
    case 'FAILED':
      return 'Túnel parado por um erro. Precisa de ação tua — vê o painel.'
    case undefined:
      return 'Estado ainda desconhecido do host. Tenta de novo em alguns segundos.'
    case 'STARTING':
      return '📶 Túnel a ligar…'
    case 'STOPPING':
      return '📶 Túnel a desligar…'
    case 'DEGRADED':
      return '📶 Túnel instável, tentando de novo.'
  }
}

/* ========================================================================== */
/* 4. CORTE DE TEXTO                                                          */
/* ========================================================================== */

/**
 * Teto historico do Telegram para `Message.text`. Usado como DEFAULT por
 * {@link cortarTexto} quando nenhum limite de provedor e fornecido; o nucleo
 * neutro passa SEMPRE o limite declarado do canal (`SurfaceLimits.maxTextLength`).
 */
export const MAX_TEXTO_MENSAGEM = 4_096

/** Corta num limite de caracteres — nunca estoura na rede (TG-048). */
export function cortarTexto(texto: string, max: number = MAX_TEXTO_MENSAGEM): string {
  return texto.length <= max ? texto : `${texto.slice(0, max - 1)}…`
}

/* ========================================================================== */
/* 5. OS AGENTES — rotulos, relatorio e a notificacao proativa (Onda 5)      */
/* ========================================================================== */

/**
 * Rotulos PT-BR do status de UM run de agente — texto de UI; o payload usa o
 * enum `AgentRunStatus` de `src/contracts/ipc.ts` (o vocabulario e FECHADO por
 * contrato: acrescentar um status e mudanca de contrato).
 *
 * O `summary` (quando presente) e texto do MODELO — nao segredo (S3): o
 * request do agente nunca recebe token nem credencial deste plugin, logo o que
 * ele devolve nao pode conter segredo nosso.
 */
export const ROTULOS_DE_STATUS_DE_AGENTE: Readonly<Record<AgentRunStatus, string>> = Object.freeze({
  running: 'rodando',
  done: 'concluído',
  failed: 'falhou',
  cancelled: 'cancelado',
})

/**
 * Teto do `prompt` do /agente — o MESMO do codec do canal (4096, o
 * `MAX_MESSAGE_CHARS` de `src/ipc/channel.ts`): um prompt acima dele faria o
 * intent ser recusado na FORMA. O corte acontece AQUI (o dono da forma), nunca
 * apos a ida ao canal (TG-048 no espirito).
 */
export const MAX_PROMPT_CHARS = MAX_TEXTO_MENSAGEM

/**
 * Teto do `base` de `worktree.create` (/worktree <nome> [base]) — HIGIENE DE
 * TRANSPORTE (contrato congelado): texto limpo, ate 256 caracteres. O valor e
 * decidido pelo host; aqui so se corta o que viaja (TG-048 no espirito).
 */
export const MAX_BASE_CHARS = 256

/**
 * Sanear para UMA linha: carateres de controlo viram espaco. O `prompt` viaja
 * no `params` do intent e o codec do canal RECUSA controlos no campo
 * (`isCleanText` — um `\n` de uma mensagem com quebras partiria a forma); aqui
 * garante-se que o que o dono confirma e o que chega ao host, sem lixo de
 * terminal no meio.
 */
export function sanearUmaLinha(texto: string): string {
  let saida = ''
  for (let i = 0; i < texto.length; i += 1) {
    const codigo = texto.charCodeAt(i)
    saida += codigo < 0x20 || codigo === 0x7f ? ' ' : texto[i]
  }
  return saida
}

/**
 * «há quanto tempo» — o mesmo relogio de {@link formatarDuracao}, com a forma
 * PT-BR do /agentes: «agora mesmo» (um run acabado de nascer/terminar nunca
 * pode ler «há agora»), «há menos de 1 min», «há 2 min», «há 1 h 30 min».
 */
export function haQuantoTempo(ms: number): string {
  if (ms <= 0) return 'agora mesmo'
  return `há ${formatarDuracao(ms)}`
}

/**
 * UMA linha de UM run no relatorio: id, skill, status PT-BR, ha quanto tempo,
 * o `kind`/`worktree` quando PRESENTES e a metrica RESUMIDA (tokens total e
 * tempo; `—` quando o host nao mediu — NUNCA se estima nem se inventa). Quando
 * o run terminou e ha texto, o resumo do modelo aparece na linha de baixo.
 * NUNCA expoe segredo (S3): o que aqui entra sao dados do dono e texto do modelo.
 */
export function linhaDeRun(run: AgentRunReport, agora: number): string {
  const base = `• ${run.id} — ${run.skill} — ${ROTULOS_DE_STATUS_DE_AGENTE[run.status]} ${haQuantoTempo(agora - run.startedAt)}`
  // A metrica resumida e um ESPACO FIXO da linha (ausencia = «—»); kind e
  // worktree so entram quando o run os traz (contrato aditivo).
  const extras: string[] = []
  if (run.kind !== undefined) extras.push(ROTULOS_DE_KIND_DE_RUN[run.kind])
  if (run.worktree !== undefined) extras.push(`wt: ${run.worktree}`)
  extras.push(`📊 ${resumoDeMetricas(run.metrics)}`)
  const linha = `${base} · ${extras.join(' · ')}`
  if (run.summary === undefined || run.summary.length === 0) return linha
  return `${linha}\n   💬 ${run.summary}`
}

/**
 * A lista COMPLETA de runs — a resposta de /agentes (o `agent.report` que o
 * host difunde). Vazia: o texto exacto «Nenhum agente rodando.». `agora` e o
 * instante actual — injectado para ser deterministico em teste.
 */
export function textoDeRelatorioDeAgentes(runs: readonly AgentRunReport[], agora: number): string {
  if (runs.length === 0) return 'Nenhum agente rodando.'
  return `🤖 Agentes:\n${runs.map((run) => linhaDeRun(run, agora)).join('\n')}`
}

/**
 * A notificacao PROATIVA quando um ou mais runs terminam (a difusao
 * `agent.report` que chega SEM `agent.status` pendente): as linhas dos runs
 * que mudaram para terminal. O titulo distingue-a da resposta a /agentes.
 */
export function textoDeFimDeRuns(runs: readonly AgentRunReport[], agora: number): string {
  return `🤖 Atualização de agentes:\n${runs.map((run) => linhaDeRun(run, agora)).join('\n')}`
}

/* ========================================================================== */
/* 6. AS METRICAS DOS RUNS E O DETALHE DE /status-tarefa (Onda 3)             */
/* ========================================================================== */

/**
 * Rotulos PT-BR do `kind` de UM run — vocabulario FECHADO (o payload usa o
 * enum `AgentRunKind` de `src/contracts/ipc.ts`; acrescentar um kind e mudanca
 * de contrato). A AUSENCIA do campo vale `'agent'` (compatibilidade), mas a
 * linha so MOSTRA o rotulo quando o run traz o campo (contrato aditivo).
 */
export const ROTULOS_DE_KIND_DE_RUN: Readonly<Record<AgentRunKind, string>> = Object.freeze({
  agent: 'agente',
  chat: 'chat',
  worktree: 'worktree',
})

/**
 * O teto de runs do `agent.report` (EMENDA ONDA-4-FIX-REPORT-CAPS: no maximo
 * 64 runs por mensagem). O filtro do `/status-tarefa <id>` corre NO WORKER
 * sobre o report COMPLETO ate este teto — um id alem dele nao designa run que
 * o report transporte.
 */
export const TETO_DE_RUNS_DO_RELATORIO = 64

/** `1234567` -> «1.234.567» — milhares com ponto (PT-BR), deterministico. */
export function formatarQuantidade(n: number): string {
  const digitos = String(Math.max(0, Math.round(n)))
  let saida = ''
  for (let i = 0; i < digitos.length; i += 1) {
    if (i > 0 && (digitos.length - i) % 3 === 0) saida += '.'
    saida += digitos[i]
  }
  return saida
}

/**
 * `ms` -> «320 ms», «4 s», «1 min 5 s» — a escala das METRICAS de um run
 * (mais fina que {@link formatarDuracao}, que e de UI). Deterministico.
 */
export function formatarTempoDeMs(ms: number): string {
  if (ms <= 0) return '0 ms'
  if (ms < 1_000) return `${String(Math.round(ms))} ms`
  if (ms < 60_000) return `${String(Math.round(ms / 1_000))} s`
  const minutos = Math.floor(ms / 60_000)
  const segundos = Math.round((ms - minutos * 60_000) / 1_000)
  return segundos === 0 ? `${String(minutos)} min` : `${String(minutos)} min ${String(segundos)} s`
}

/**
 * O TOTAL de tokens de um run: a soma dos QUATRO contadores DISJUNTOS
 * (`inputTokens` + `outputTokens` + `cacheReadTokens` + `cacheWriteTokens` —
 * `decodeTokens` e um SUBCONJUNTO do output e somaria em dobro). `undefined`
 * quando o host nao mediu NENHUM: nada se estima (a ausencia nao e zero).
 */
export function totalDeTokens(metrics: AgentRunMetrics | undefined): number | undefined {
  if (metrics === undefined) return undefined
  const contadores = [
    metrics.inputTokens,
    metrics.outputTokens,
    metrics.cacheReadTokens,
    metrics.cacheWriteTokens,
  ]
  const presentes = contadores.filter((valor): valor is number => valor !== undefined)
  if (presentes.length === 0) return undefined
  return presentes.reduce((soma, valor) => soma + valor, 0)
}

/**
 * O TEMPO de trabalho de um run (modelo + ferramentas). `undefined` quando o
 * host nao mediu nenhum dos dois — so se soma o que existe, nunca se preenche.
 */
export function tempoDeTrabalhoMs(metrics: AgentRunMetrics | undefined): number | undefined {
  if (metrics === undefined) return undefined
  const presentes = [metrics.llmMs, metrics.toolMs].filter((valor): valor is number => valor !== undefined)
  if (presentes.length === 0) return undefined
  return presentes.reduce((soma, valor) => soma + valor, 0)
}

/**
 * A METRICA RESUMIDA da linha de um run: «tokens total / tempo» (ex. «6.334
 * tokens / 4 s»). Ausente = «—» (NUNCA estimar/inventar): sem metricas, ou sem
 * nenhum dos dois componentes, o dono ve o traco e nao um numero fabricado.
 */
export function resumoDeMetricas(metrics: AgentRunMetrics | undefined): string {
  const partes: string[] = []
  const tokens = totalDeTokens(metrics)
  if (tokens !== undefined) partes.push(`${formatarQuantidade(tokens)} tokens`)
  const tempo = tempoDeTrabalhoMs(metrics)
  if (tempo !== undefined) partes.push(formatarTempoDeMs(tempo))
  return partes.length === 0 ? '—' : partes.join(' / ')
}

/** Um campo de metrica, ou «—» quando o host o nao mediu. */
function campoDeMetrica(valor: number | undefined, formatar: (n: number) => string): string {
  return valor === undefined ? '—' : formatar(valor)
}

/**
 * O DETALHE das metricas de UM run (a resposta de /status-tarefa): os doze
 * campos do {@link AgentRunMetrics} do contrato, em tres linhas. Campo ausente
 * = «—» — o vocabulario da ausencia e FECHADO e nada se estima (S3: sao
 * numeros do harness, nunca segredo).
 */
function detalheDeMetricas(metrics: AgentRunMetrics | undefined): string {
  const q = (valor: number | undefined): string => campoDeMetrica(valor, formatarQuantidade)
  const t = (valor: number | undefined): string => campoDeMetrica(valor, formatarTempoDeMs)
  return [
    `   📊 Tokens: entrada ${q(metrics?.inputTokens)} · saída ${q(metrics?.outputTokens)} · cache lido ${q(metrics?.cacheReadTokens)} · cache escrito ${q(metrics?.cacheWriteTokens)} · decodificados ${q(metrics?.decodeTokens)}`,
    `   ⏱ Tempo: modelo ${t(metrics?.llmMs)} · ferramentas ${t(metrics?.toolMs)} · primeiro token ${t(metrics?.ttftMs)} · decodificação ${t(metrics?.decodeMs)}`,
    `   🔁 Turnos ${q(metrics?.turns)} · passos ${q(metrics?.steps)} · passos com 1º token ${q(metrics?.ttftSteps)}`,
  ].join('\n')
}

/**
 * O DETALHE de UM run pedido por `/status-tarefa <id>`: a linha enriquecida do
 * run + as metricas completas. O id e filtrado AQUI, NO WORKER, sobre o
 * `agent.report` (o `/status-tarefa` reusa `agent.status` SEM params — o
 * contrato fecha o codec), com o teto de 64 runs do report. Sem correspondencia
 *: a resposta uniforme «Tarefa <id> nao encontrada (veja /agentes)».
 */
export function textoDeTarefa(runs: readonly AgentRunReport[], id: string, agora: number): string {
  const run = runs.slice(0, TETO_DE_RUNS_DO_RELATORIO).find((cada) => cada.id === id)
  if (run === undefined) return `Tarefa ${id} não encontrada (veja /agentes)`
  return [`🧩 Tarefa ${run.id}:`, linhaDeRun(run, agora), detalheDeMetricas(run.metrics)].join('\n')
}

/* ========================================================================== */
/* 7. A AJUDA CURTA (os comandos novos entram aqui — o menu publicado NAO)     */
/* ========================================================================== */

/**
 * O texto de `/ajuda` (e do botao `ℹ️ Ajuda`): a ajuda curta do §2 MAIS os
 * comandos de tarefa da Onda 3. `/start` continua de fora da lista publicada
 * (PAIR-006) e os COMANDOS_PUBLICADOS ficam intactos (TG-080) — e so o TEXTO
 * de ajuda que cresce.
 */
export const TEXTO_DE_AJUDA: string =
  'ℹ️ Este bot controla o acesso ao teu Harness pelo Telegram.\n' +
  'Usa /menu para o cartão de controlo e /status para ver o túnel.\n' +
  '\n' +
  'Tarefas:\n' +
  '/novo-chat <o que fazer> — abre um chat novo\n' +
  '/novo-chat-wt <worktree> <o que fazer> — chat novo num worktree\n' +
  '/worktree <nome> [base] — cria um worktree\n' +
  '/status-tarefa <id> — vê uma tarefa (os ids saem em /agentes)\n' +
  '/agentes — lista tarefas e agentes'
