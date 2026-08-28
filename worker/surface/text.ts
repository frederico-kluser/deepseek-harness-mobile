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

import type { AgentRunReport, AgentRunStatus } from '../../src/contracts/ipc.ts'
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
 * UMA linha de UM run no relatorio: id, skill, status PT-BR, ha quanto tempo e
 * o resumo do modelo (1 linha, quando o run terminou e ha texto). NUNCA expoe
 * segredo (S3): o que aqui entra sao dados do dono e texto do modelo.
 */
export function linhaDeRun(run: AgentRunReport, agora: number): string {
  const base = `• ${run.id} — ${run.skill} — ${ROTULOS_DE_STATUS_DE_AGENTE[run.status]} ${haQuantoTempo(agora - run.startedAt)}`
  if (run.summary === undefined || run.summary.length === 0) return base
  return `${base}\n   💬 ${run.summary}`
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
