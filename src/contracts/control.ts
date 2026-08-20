/**
 * Contrato do CONTROLADOR UNICO — COMMIT PREP 5. CONGELADO.
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA na Onda 5 (03-ONDAS.md 16: protocolo de
 * violacao — uma sub-tarefa que precise alterar isto PARA e reporta).
 *
 * O que este ficheiro congela:
 *
 *   1. As TRANSICOES LEGAIS da maquina de estados, na forma de uma TABELA
 *      (fonte normativa: 01-ARQUITETURA 6 — ver a nota de discrepancia de
 *      diagrama mais abaixo). O VOCABULARIO dos estados vive em
 *      `src/contracts/tunnel.ts` (PREP 3) e NAO e duplicado aqui — duas
 *      fontes da verdade divergiriam na primeira correcao.
 *
 *   2. `ControlIntent` e o resultado do despacho, com a TRANSCRICAO de D29
 *      (09-DECISOES-CANONICAS.md D29): `start` recebido em `STOPPING` e
 *      REJEITADO com `SHUTDOWN_IN_PROGRESS`, sem fila e sem reconciliacao
 *      posterior. O PREP 5 nao decide nada: transcreve.
 *
 *   3. O contrato do NONCE DE CONFIRMACAO (`src/control/confirm.ts`, T5.1):
 *      server-side no HOST, TTL 60 s, uso unico. O worker so transporta o
 *      valor opaco (S5/S6 de src/contracts/ipc.ts).
 *
 * A implementacao (serializacao de intents em fila de um, idempotencia por
 * `requestId`, reconciliacao com o processo real, broadcast com `seq`
 * monotonico) e de T5.1 (`src/control/controller.ts`), que tambem e dona da
 * fiacao em `src/index.ts`.
 */

import type { TunnelInfo, TunnelState } from './tunnel.ts'

export type { TunnelInfo, TunnelState }

// ---------------------------------------------------------------------------
// 1. A TABELA DE TRANSICOES LEGAIS
// ---------------------------------------------------------------------------

export interface Transition {
  readonly de: TunnelState
  readonly para: TunnelState
  /** Gatilho e pre-condicoes, em prosa curta — a tabela e a fonte, nao a prosa. */
  readonly gatilho: string
}

/**
 * Fonte normativa: 01-ARQUITETURA 6 ("Transicoes, gatilhos e efeitos").
 *
 * DISCREPANCIA DE DIAGRAMA, RESOLVIDA AQUI. O diagrama de 03-ONDAS 10 desenha
 * `STOPPING --falha--> FAILED`; a tabela de 01-ARQUITETURA 6 NAO o lista.
 * Vale a tabela: `STOPPING` so sai para `STOPPED`. Se a morte do processo
 * falhar, o supervisor (T3.1) tem SIGTERM -> janela de graca -> SIGKILL e o
 * estado PERMANECE `STOPPING` ate o processo morrer — fail-closed: nunca se
 * declara STOPPED um tunel que pode estar vivo. O diagrama tambem desenha
 * `DEGRADED --backoff esgotou sem sucesso--> STOPPED`; a tabela nao o lista e
 * tampouco vale — a saida do DEGRADED e FAILED (terminal) ou STARTING
 * (re-tentativa). Se a implementacao medir que uma borda ausente acontece na
 * pratica, reporta (03 13.2) e o PREP 6 corrige.
 */
export const TRANSICOES_LEGAIS: readonly Transition[] = [
  { de: 'STOPPED', para: 'STARTING', gatilho: 'start() por bot|UI. Pre: exposure.mode tunnel, segredo forte valido, probe L1 fail-closed passou' },
  { de: 'STARTING', para: 'READY', gatilho: 'URL obtida em /quicktunnel E probe local responde' },
  { de: 'STARTING', para: 'DEGRADED', gatilho: 'falha: timeout de readiness (>=30 s) ou close do processo' },
  { de: 'READY', para: 'DEGRADED', gatilho: 'close/error do cloudflared' },
  { de: 'DEGRADED', para: 'STARTING', gatilho: 're-tentativa automatica com backoff (orcamento nao esgotado)' },
  { de: 'DEGRADED', para: 'FAILED', gatilho: 'orcamento esgotado' },
  { de: 'STOPPED', para: 'FAILED', gatilho: 'erro nao-retryable (ENOENT, EACCES, config invalida) — CTL-013: sem passar por STARTING' },
  { de: 'STARTING', para: 'FAILED', gatilho: 'erro nao-retryable (ENOENT, EACCES, config invalida)' },
  { de: 'DEGRADED', para: 'FAILED', gatilho: 'erro nao-retryable (ENOENT, EACCES, config invalida)' },
  { de: 'READY', para: 'STOPPING', gatilho: 'stop() por bot|UI|disposer OU TTL expirado' },
  { de: 'STARTING', para: 'STOPPING', gatilho: 'stop() por bot|UI|disposer' },
  { de: 'DEGRADED', para: 'STOPPING', gatilho: 'stop() por bot|UI|disposer' },
  { de: 'STOPPING', para: 'STOPPED', gatilho: 'processo confirmado morto' },
  { de: 'FAILED', para: 'STOPPED', gatilho: 'reset() explicito do dono — UNICO caminho de saida' },
]

/**
 * Transicoes de INTENT (idempotencia e recusa) que NAO entram na tabela acima
 * porque nao mudam de estado:
 *
 *   - `start` em `STARTING` ou `READY`: no-op idempotente (CTL-002/003). A
 *     resposta repete a URL vigente; NUNCA nasce um segundo cloudflared.
 *   - `stop` em `STOPPED`: no-op idempotente (CTL-004).
 *   - `start` em `STOPPING`: REJEITADO com `SHUTDOWN_IN_PROGRESS`, sem fila
 *     (D29/CTL-007). Quem quiser subir de novo manda /ligar outra vez depois
 *     de o estado chegar a `STOPPED`.
 *   - `start` em `FAILED`: recusado com motivo (CTL-011) — terminal e terminal.
 *   - `start` com modo restrito ativo: recusado, nenhum spawn (CTL-015).
 *   - `start` sem segredo forte configurado: recusado (CTL-009).
 *
 * CHAVE DE IDEMPOTENCIA: o `requestId` gerado pela superficie e propagado no
 * `ControlIntent` (D29). `requestId` repetido devolve o resultado da primeira
 * execucao; nonce repetido e RECUSADO. O nonce autoriza; nao deduplica.
 */

// ---------------------------------------------------------------------------
// 2. INTENT E RESULTADO
// ---------------------------------------------------------------------------

/** As acoes que o controlador despacha. Vocabulario fechado. */
export type ControlAction = 'start' | 'stop' | 'reset'

/**
 * Uma intencao vinda de UMA superficie (bot, painel, UI nativa do DSH).
 *
 * `requestedBy` e uma string PRE-FORMATADA de origem, ex. `telegram:123456`
 * ou `panel:<id-hash-da-sessao>` — e o valor que o audit escreve linha a linha
 * (aceite da Onda 5, item 7: toda acao com origem identificada).
 *
 * `at` e epoch ms do relogio INJETADO (nunca `Date.now` direto).
 */
export interface ControlIntent {
  readonly action: ControlAction
  readonly requestedBy: string
  /** ULID gerado pela superficie. CHAVE DE IDEMPOTENCIA (D29). */
  readonly requestId: string
  /** Nonce de confirmacao, quando a acao o EXIGE (start/reset; ver CTL-023/024). */
  readonly nonce?: string | undefined
  readonly at: number
}

/** Motivos de recusa, fechados. Cada um tem um caso CTL-0xx que o prende. */
export type ControlRecusa =
  | 'SHUTDOWN_IN_PROGRESS' // D29/CTL-007
  | 'MODO_RESTRITO' // CTL-015
  | 'SEM_SEGREDO_FORTE' // CTL-009
  | 'TERMINAL_SEM_RESET' // CTL-011
  | 'NONCE_AUSENTE' // CTL-023
  | 'NONCE_INVALIDO' // CTL-021
  | 'NONCE_EXPIRADO' // CTL-022

export interface ControlResultado {
  /** O estado APOS o despacho (inalterado quando `recusa`). */
  readonly estado: TunnelState
  /** Presente quando a acao resultou (ou confirmou) um tunel pronto. */
  readonly url?: string | undefined
  /** `true` quando o `requestId` era repetido e o resultado e o da primeira execucao (CTL-020). */
  readonly idempotente: boolean
  readonly recusa?: ControlRecusa | undefined
}

// ---------------------------------------------------------------------------
// 3. O CONTRATO DO NONCE DE CONFIRMACAO (T5.1 implementa em src/control/confirm.ts)
// ---------------------------------------------------------------------------

export const NONCE_TTL_MS = 60_000

/** O nonce e OPACO para quem o transporta (o worker nao o le nem o valida — S5). */
export interface Nonce {
  /** 128 bits em hex, CSPRNG. */
  readonly valor: string
  /** Epoch ms em que expira (relogio injetado do HOST). */
  readonly expiresAt: number
}

/**
 * O servico de confirmacao de 2 etapas. SERVER-SIDE NO HOST, SEM EXCECAO:
 * um nonce validado no processo que fala com a internet nao e um controlo,
 * e uma variavel (S5 de src/contracts/ipc.ts).
 *
 * `consume` e USO UNICO: replay devolve `false` (CTL-021) e expiracao
 * devolve `false` (CTL-022). As acoes que REDUZEM exposicao (stop /
 * emergencia) NAO exigem nonce (CTL-024): em panico, o botao tem de
 * funcionar de primeira.
 */
export interface ConfirmService {
  issue(action: ControlAction): Nonce
  consume(nonce: string, action: ControlAction): boolean
}
