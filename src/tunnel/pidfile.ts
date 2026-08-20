/**
 * =============================================================================
 * PIDFILE DO TUNEL + VARREDURA DE ORFAO NO BOOT (`02-SEGURANCA.md` 9).
 * =============================================================================
 *
 * UM TUNEL ORFAO E UMA URL PUBLICA VIVA SEM GATE POR TRAS. O `cloudflared` sobe
 * `detached: true` — que e precisamente o que faz o orfao sobreviver quando o DSH
 * morre de forma abrupta — e o dead-man's switch por pipe herdado NAO cobre o
 * caso de a maquina reiniciar: o pipe morre com o processo, e um processo que
 * nunca chegou a existir depois do reboot nao fecha pipe nenhum.
 *
 * Por isso a memoria do tunel vai para o DISCO, via `StateStore` (T2.5, o UNICO
 * writer do `state.json`). No boot seguinte, ANTES de qualquer outra
 * inicializacao, a varredura le esse registo e derruba o que ficou de pe.
 *
 * -----------------------------------------------------------------------------
 * O QUE ESTA VARREDURA *NAO* COBRE, e a correccao de uma afirmacao errada
 * -----------------------------------------------------------------------------
 * Ela so corre no BOOT SEGUINTE. Com um `SIGKILL` no processo do DSH o
 * `cloudflared` fica VIVO e reparentado, e a URL publica continua de pe ate o
 * utilizador recarregar o plugin: esta varredura FECHA a janela, nao a impede de
 * abrir. O que a impediria e um DEAD-MAN'S SWITCH, e a revisao adversarial desta
 * onda CONSTRUIU-O E MEDIU-O: um reaper `detached`, em Node puro, segurando a
 * ponta de leitura de um pipe herdado; `SIGKILL` no supervisor faz o nucleo
 * fechar a ponta de escrita, o reaper ve EOF e faz `process.kill(-pid,'SIGKILL')`
 * — tunel morto em menos de 3 s, sem addon nativo.
 *
 * >>> UMA VERSAO ANTERIOR DESTE COMENTARIO AFIRMAVA QUE ISTO "NAO E IMPLEMENTAVEL
 * >>> EM NODE PURO". A AFIRMACAO ESTA ERRADA. <<< As duas premissas continuam
 * certas (`PR_SET_PDEATHSIG` exige nativo; o `cloudflared` nao coopera), mas a
 * conclusao nao se segue: quem observa o EOF e o REAPER, nao o `cloudflared`. O
 * que e verdade e mais modesto — o dead-man's switch NAO FOI ENTREGUE NESTA ONDA,
 * e o caminho esta escrito acima. Fica para a Onda 6 (T6.4, dono de E2E-012/013).
 *
 * -----------------------------------------------------------------------------
 * PERSISTE-SE `pid` E `startedAt`. NUNCA A URL.
 * -----------------------------------------------------------------------------
 * A URL do quick tunnel e efemera: persisti-la e entregar, com confianca, um link
 * morto — ou pior, um link que entretanto pertence a outra pessoa. O `startedAt`
 * serve dois donos: a varredura de orfao (aqui) e o TTL (`./ttl.ts`).
 *
 * -----------------------------------------------------------------------------
 * O RISCO DE REUTILIZACAO DE PID, e o que se faz com ele
 * -----------------------------------------------------------------------------
 * Um `pid` guardado identifica um processo APENAS enquanto esse processo existir;
 * depois o sistema reatribui-o. Matar por pid guardado, sem mais nada, e aceitar
 * matar um processo inocente. As duas mitigacoes correm ANTES de qualquer sinal:
 * `/proc/<pid>/cmdline` responde "e outro PROGRAMA?" e `/proc/<pid>/stat` responde
 * "e outra INSTANCIA do mesmo programa?". A politica, e o compromisso de quando
 * nao se consegue saber, estao em {@link sweepOrphanTunnel}.
 */

import { basename } from 'node:path'

import type { PersistedState, StateStore } from '../contracts/state.ts'
import type { TunnelMode } from '../contracts/tunnel.ts'
import {
  isProcessAlive,
  programOf,
  readProcessCmdline,
  readProcessStartMs,
  START_TIME_TOLERANCE_MS,
} from '../proc/introspect.ts'
import { treeKill, type TreeKillDeps } from '../proc/tree-kill.ts'
import {
  applyTtlExpiry,
  decideOnResume,
  ttlDeadline,
  type TtlEffects,
  type TtlExpiryFacts,
  type TtlLogger,
} from './ttl.ts'

/**
 * Reexportadas de `src/proc/introspect.ts`, onde vivem: sao leituras genericas de
 * `/proc`, nao politica de tunel. Ficam visiveis daqui porque e este o modulo que
 * as consome e e por ele que T3.3 entra.
 */
export { readProcessCmdline, readProcessStartMs, START_TIME_TOLERANCE_MS } from '../proc/introspect.ts'

/** O que se guarda de um tunel vivo. Espelha `PersistedState['tunnel']`. */
export interface TunnelProcessRecord {
  readonly pid: number
  readonly startedAt: number
  readonly mode: TunnelMode
}

/** Escreve o registo. Chamado logo apos o `spawn`, no gancho `onSpawned`. */
export function recordTunnelProcess(store: StateStore, record: TunnelProcessRecord): void {
  store.update(
    (state: PersistedState): PersistedState => ({
      ...state,
      tunnel: { pid: record.pid, startedAt: record.startedAt, mode: record.mode },
    }),
  )
}

/**
 * Apaga o registo. Chamado quando o tunel e derrubado DE FORMA LIMPA.
 *
 * PORQUE IMPORTA APAGAR: um registo que sobra depois de uma paragem limpa faz o
 * boot seguinte varrer um pid que ja nao e nosso — e o caso de reutilizacao de
 * pid deixa de ser teorico. O registo existe para descrever um tunel VIVO.
 */
export function clearTunnelProcess(store: StateStore): void {
  store.update((state: PersistedState): PersistedState => ({ ...state, tunnel: undefined }))
}

export function readTunnelProcess(store: StateStore): TunnelProcessRecord | undefined {
  const record = store.read().tunnel
  if (record === undefined) return undefined
  return { pid: record.pid, startedAt: record.startedAt, mode: record.mode }
}

/**
 * Reconhece o nosso tunel numa linha de comando.
 *
 * DUAS REGRAS, e AMBAS ancoradas no PROGRAMA — nunca em "contem o texto".
 *
 * 1. `expectedCommand` e o `tunnel.binaryPath` CONFIGURADO. Existe porque um nome
 *    versionado (`cloudflared-2026.7.3`) escapa a regra generica, e sem ele a
 *    varredura classificava o PROPRIO tunel como "pid alheio" — deixando viva a
 *    URL publica que ela existe para derrubar (falha para ABERTO).
 *
 *    MAS A COMPARACAO E COM `argv[0]`, nao com a linha toda. A versao anterior
 *    fazia `cmdline.includes(expected)` e era MAIS FRACA do que a regra que veio
 *    reforcar: com `expectedCommand: 'cloudflared'` (nome nu, legitimo porque
 *    `binaryPath` e opcional), `vim /etc/cloudflared.yml` virava "o nosso tunel" e
 *    levava `SIGTERM` + `SIGKILL` ao GRUPO, sem graca; o `cp /tmp/dl/cloudflared
 *    /usr/bin/cloudflared` do instalador idem.
 *
 * 2. A regra generica cobre o caso normal (`/usr/bin/cloudflared tunnel ...`) e e
 *    deliberadamente ESTRITA no fim do nome, pela mesma razao.
 */
export function looksLikeCloudflared(cmdline: string, expectedCommand?: string): boolean {
  const program = programOf(cmdline)
  if (program.length === 0) return false

  const expected = expectedCommand?.trim()
  if (expected !== undefined && expected.length > 0) {
    // Caminho completo igual, ou o mesmo nome de ficheiro noutro diretorio (o
    // utilizador pode ter mudado o binario de sitio entre arranques).
    if (program === expected || basename(program) === basename(expected)) return true

    /**
     * INTERPRETADOR: com um `binaryPath` que seja um script com `#!`, o nucleo
     * poe o INTERPRETADOR em `argv[0]` e o script em `argv[1]`. Sem este ramo, a
     * varredura recusava-se a derrubar o NOSSO PROPRIO tunel nesse arranjo — de
     * novo uma falha para ABERTO.
     *
     * Aqui a comparacao e por IGUALDADE EXATA, e nao por nome de ficheiro: em
     * `argv[1]` ja nao estamos a olhar para o programa, estamos a olhar para um
     * dado. `cp /tmp/dl/cloudflared /usr/bin/cloudflared` tem `argv[1]` com o
     * mesmo NOME do binario configurado e nao e o binario nenhum.
     */
    const second = cmdline.trim().split(/\s+/u)[1]
    if (second !== undefined && second === expected) return true
  }

  return /(^|[\s/\\])cloudflared(\s|$|\.exe)/iu.test(program)
}

/** Resultado da varredura. Cada valor descreve uma decisao diferente. */
export type OrphanSweepOutcome =
  /** Nao havia registo nenhum: arranque limpo. */
  | 'none'
  /** Havia registo, mas o processo ja nao existe. So se limpou o registo. */
  | 'gone'
  /** O pid existe e NAO e o nosso tunel (pid reutilizado). Nao se matou nada. */
  | 'foreign'
  /** O orfao foi derrubado. */
  | 'killed'

export interface OrphanSweepResult {
  readonly outcome: OrphanSweepOutcome
  readonly record: TunnelProcessRecord | undefined
}

export interface OrphanSweepDeps extends TreeKillDeps {
  readonly store: StateStore
  /** `process.kill(pid, 0)` — existencia, sem entregar sinal. */
  readonly isAlive: (pid: number) => boolean
  /** Identificacao do processo. `null` = nao ha como saber. */
  readonly identify: (pid: number) => string | null
  /** Instante de arranque do pid, em epoch ms. `null` = nao ha como saber. */
  readonly startedAtOf: (pid: number) => number | null
  /**
   * `tunnel.binaryPath` configurado. Sem ele, um binario com nome versionado
   * escapa a regra generica e a varredura falha para ABERTO. Ver
   * {@link looksLikeCloudflared}.
   */
  readonly expectedCommand?: string | undefined
  readonly log: { info(message: string): void; warn(message: string): void }
}

/** Dependencias reais da varredura, no processo corrente. */
export function defaultOrphanSweepDeps(
  store: StateStore,
  log: OrphanSweepDeps['log'],
  expectedCommand?: string,
): OrphanSweepDeps {
  return {
    store,
    log,
    expectedCommand,
    platform: process.platform,
    kill: (pid: number, signal: NodeJS.Signals): void => {
      process.kill(pid, signal)
    },
    isAlive: isProcessAlive,
    identify: readProcessCmdline,
    startedAtOf: readProcessStartMs,
  }
}

/**
 * Derruba o `cloudflared` orfao registado no `state.json`.
 *
 * CORRE ANTES DE QUALQUER OUTRA INICIALIZACAO, e e sincrona de ponta a ponta por
 * isso: um passo assincrono abriria uma janela com o resto do plugin ja a correr e
 * a URL publica anterior ainda viva.
 *
 * A POLITICA, escrita em voz alta:
 *   - outro PROGRAMA, ou outra INSTANCIA (arrancou depois do registo) -> NAO mata,
 *     so limpa o registo. Matar seria derrubar um processo do utilizador.
 *   - o nosso -> mata a arvore.
 *   - identificacao INDISPONIVEL (sem `/proc`) -> mata a arvore. E o unico ponto
 *     deste ficheiro em que se aceita o risco de matar um inocente, e a escolha e
 *     deliberada: do outro lado da balanca esta uma URL publica sem autenticacao a
 *     servir o Harness, que e o dano que este plugin existe para impedir. A
 *     alternativa seria "na duvida, deixa aberto".
 */
export function sweepOrphanTunnel(deps: OrphanSweepDeps): OrphanSweepResult {
  const record = readTunnelProcess(deps.store)
  if (record === undefined) return { outcome: 'none', record: undefined }

  // Guardas que nunca podem falhar em silencio: um `pid` invalido, o pid do
  // proprio host (matar o grupo derrubaria o DSH inteiro) ou o `1` do init.
  if (!Number.isInteger(record.pid) || record.pid <= 1 || record.pid === process.pid) {
    deps.log.warn(
      `registo de tunel com pid improvavel (${String(record.pid)}); apagado sem derrubar nada.`,
    )
    clearTunnelProcess(deps.store)
    return { outcome: 'foreign', record }
  }

  if (!deps.isAlive(record.pid)) {
    deps.log.info('registo de tunel anterior encontrado, mas o processo ja nao existe; registo limpo.')
    clearTunnelProcess(deps.store)
    return { outcome: 'gone', record }
  }

  const cmdline = deps.identify(record.pid)
  if (cmdline !== null && !looksLikeCloudflared(cmdline, deps.expectedCommand)) {
    deps.log.warn(
      'o pid registado como tunel pertence agora a OUTRO programa (pid reutilizado); ' +
        'nada foi derrubado e o registo foi limpo.',
    )
    clearTunnelProcess(deps.store)
    return { outcome: 'foreign', record }
  }

  /**
   * SEGUNDA PERGUNTA, e a que o `cmdline` nao responde: mesmo sendo o mesmo
   * PROGRAMA, sera a mesma INSTANCIA? Um processo que arrancou DEPOIS de nos
   * termos gravado o registo nao pode ser o que gravamos — e um `cloudflared`
   * legitimo do utilizador que calhou herdar o pid. Derruba-lo seria fechar o
   * tunel de producao dele com `SIGKILL` ao grupo e sem graca nenhuma.
   */
  const startedAt = deps.startedAtOf(record.pid)
  if (startedAt !== null && startedAt > record.startedAt + START_TIME_TOLERANCE_MS) {
    deps.log.warn(
      'o pid registado esta ocupado por um processo que arrancou DEPOIS do registo: ' +
        'e outra instancia, nao a nossa. Nada foi derrubado e o registo foi limpo.',
    )
    clearTunnelProcess(deps.store)
    return { outcome: 'foreign', record }
  }

  deps.log.warn(
    'tunel orfao de uma execucao anterior encontrado VIVO no arranque; a derrubar ' +
      'antes de qualquer outra inicializacao — uma URL publica sem portao por tras ' +
      'e o pior estado possivel deste plugin.',
  )

  /**
   * SIGTERM ao GRUPO e, logo a seguir, SIGKILL ao GRUPO.
   *
   * NAO ha janela de graca aqui, e isso e declarado e nao esquecido: esta funcao
   * corre antes de tudo o resto e tem de ser sincrona, e esperar `graceMs` a
   * bloquear o arranque seria pior do que o que se ganha. Medido em T0.2: o
   * `cloudflared` encerra em ~13 ms com SIGTERM e nao tem estado nenhum para
   * descarregar. A graca configurada continua a governar o caminho normal
   * (`SubprocessSpawnSpec.graceMs`, no disposer); um orfao que ja sobreviveu ao
   * dono nao tem direito a mais cortesia do que o utilizador que quer a porta
   * fechada.
   */
  signalGroup(deps, record.pid, 'SIGTERM')
  treeKill({ pid: record.pid }, { platform: deps.platform, kill: deps.kill })

  clearTunnelProcess(deps.store)
  return { outcome: 'killed', record }
}

/** `-pid` alveja o GRUPO. Ver a divergencia documentada em `src/proc/tree-kill.ts`. */
function signalGroup(deps: OrphanSweepDeps, pid: number, signal: NodeJS.Signals): void {
  if (deps.platform === 'win32') return
  try {
    deps.kill(-pid, signal)
  } catch (error) {
    // ESRCH: o grupo ja nao existe. O objetivo desta chamada ja esta cumprido, e
    // o `treeKill` a seguir volta a tentar de qualquer forma.
    void error
  }
}

/* ========================================================================== */
/* Recuperacao no boot: a varredura MAIS o veredito do TTL persistido         */
/* ========================================================================== */

/** Nome do evento de auditoria. O vocabulario fechado e de T5.4. */
export const EVENTO_ORFAO = 'tunel_orfao_derrubado'

/** Aviso ao dono. Sem a URL: ela e efemera e ja nao existe. */
export function ownerOrphanMessage(): string {
  return (
    'No arranque foi encontrado um tunel de uma execucao anterior ainda vivo, sem o portao ' +
    'de autenticacao por tras. Ele foi derrubado e as sessoes abertas deixaram de valer. ' +
    'Ligue o tunel outra vez quando precisar.'
  )
}

export interface BootRecoveryDeps {
  readonly sweep: OrphanSweepDeps
  /** `tunnel.ttlMinutes` ja validado por `assertValidTtlMinutes`. */
  readonly ttlMinutes: number
  readonly now: () => number
  readonly effects: TtlEffects
  readonly log: TtlLogger
}

export interface BootRecovery {
  readonly sweep: OrphanSweepResult
  /** `'expirado'` sse o `startedAt` persistido ja tinha passado do prazo. */
  readonly ttl: 'sem-registo' | 'dentro-do-prazo' | 'expirado'
}

/**
 * O PRIMEIRO passo do arranque, antes de qualquer outra inicializacao.
 *
 * Junta os dois controlos que dependem do MESMO registo em disco, e junta-os de
 * proposito: separa-los deixava um caminho em que o orfao morre e as sessoes que
 * ele emitiu continuam a autenticar.
 *
 *   (a) varredura de orfao — derruba o `cloudflared` que sobreviveu ao dono;
 *   (b) veredito do TTL    — `startedAt` persistido comparado com o relogio. E
 *       ESTA a resposta a "o TTL sobrevive a que?": nao a um `setTimeout`, que
 *       morre com o event loop, mas a um instante gravado no disco.
 *
 * Em qualquer caso em que um tunel foi efetivamente derrubado aqui, as SESSOES
 * SAO INVALIDADAS. Nao basta matar o processo: os cookies emitidos pela janela
 * anterior sobreviveriam para a janela seguinte, e o prazo teria fechado a porta
 * deixando a chave na fechadura.
 */
export function recoverTunnelAtBoot(deps: BootRecoveryDeps): BootRecovery {
  const sweep = sweepOrphanTunnel(deps.sweep)

  if (sweep.record === undefined) return { sweep, ttl: 'sem-registo' }

  const decision = decideOnResume(sweep.record.startedAt, deps.ttlMinutes, deps.now())
  const facts: TtlExpiryFacts = {
    startedAt: sweep.record.startedAt,
    expiresAt: ttlDeadline(sweep.record.startedAt, deps.ttlMinutes),
    ttlMinutes: deps.ttlMinutes,
    detectedBy: 'boot',
  }

  if (decision.expired) {
    // O prazo cumpriu-se enquanto ninguem estava a ver. Percorre EXATAMENTE os
    // mesmos quatro passos, na mesma ordem, de uma expiracao com o plugin vivo —
    // incluindo o `stopTunnel`, que aqui e um no-op porque a varredura ja matou.
    applyTtlExpiry(deps.effects, deps.log, facts)
    return { sweep, ttl: 'expirado' }
  }

  if (sweep.outcome !== 'killed') return { sweep, ttl: 'dentro-do-prazo' }

  // Ainda dentro do prazo, mas o tunel foi derrubado na mesma: ele estava vivo
  // SEM o portao por tras (o plugin que o instala so agora esta a arrancar). As
  // sessoes que ele emitiu tem de cair com ele; o aviso e outro porque o motivo
  // e outro — dizer "expirou" seria mentir sobre o que aconteceu.
  deps.effects.revokeAllSessions()
  try {
    deps.effects.audit(facts)
  } catch (error) {
    deps.log.error(
      `orfao derrubado e sessoes invalidadas, mas o registo de auditoria FALHOU: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  try {
    deps.effects.notifyOwner(ownerOrphanMessage(), facts)
  } catch (error) {
    deps.log.error(
      `orfao derrubado, mas o aviso ao dono FALHOU: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return { sweep, ttl: 'dentro-do-prazo' }
}
