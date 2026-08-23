/**
 * A maquina de estados UNICA do tunel — T5.1. DONO: T5.1.
 *
 * Contrato congelado no COMMIT PREP 5 (`src/contracts/control.ts`): a tabela de
 * transicoes legais, `ControlIntent` e a regra D29. Este ficheiro implementa o
 * que o PREP 5 transcree e nada mais.
 *
 * ---------------------------------------------------------------------------
 * O QUE ESTE FICHEIRO E
 * ---------------------------------------------------------------------------
 * O UNICO dono do estado do tunel (`docs/control-machine.md`, "Decisao
 * estruturante"): Telegram, painel e UI nativa sao SUPERFICIES e nenhuma chama
 * o supervisor de tunel directamente — toda superficie emite um
 * `ControlIntent` contra este controlador. E o que torna T5.2/T5.3/T5.5
 * paralelizaveis com risco zero de estado divergente.
 *
 * O supervisor de T3.1 (`src/tunnel/supervisor.ts`) e a fonte do PROCESSO:
 * `close`/`error`/morte externa convergem o estado AQUI pela reconciliacao
 * (ver {@link reconciliar}) — nunca se deixa o estado mentir `READY`.
 *
 * ---------------------------------------------------------------------------
 * DESPACHO SERIALIZADO, IDEMPOTENCIA, D29 (01-ARQUITETURA 9.2/9.3)
 * ---------------------------------------------------------------------------
 * - A fila e serializada: uma transicao em curso nao e interrompida; o comando
 *   novo e avaliado contra o estado que a transicao VAI produzir. O caso
 *   concreto de 9.3 — `up` do bot e `down` da UI a 5 ms — e: o `up` entra na
 *   fila, o `down` serializa atras dele e e avaliado contra o `STARTING` que o
 *   `up` vai produzir (`STARTING -> STOPPING`), nunca contra o `STOPPED` que o
 *   `down` encontrou.
 * - A CHAVE DE IDEMPOTENCIA e o `requestId` (ULID da superficie), com janela
 *   dos ultimos processados: repetido devolve o resultado da primeira execucao
 *   e NUNCA re-executa (CTL-020). O nonce autoriza; nao deduplica (D29).
 * - `start` em `STOPPING` e REJEITADO com `SHUTDOWN_IN_PROGRESS` — na chegada,
 *   sem fila e sem reconciliacao posterior (D29/CTL-007): enfileirar
 *   transformaria o kill switch numa operacao de resultado incerto.
 *
 * ---------------------------------------------------------------------------
 * DECISAO SINCRONA vs DESPACHO ASSINCRONO
 * ---------------------------------------------------------------------------
 * O canal IPC exige que `onIntent` responda NO MESMO TICK (`src/ipc/channel.ts`:
 * "SINCRONO e obrigatorio"). Quase tudo aqui e decidivel de forma sincrona —
 * recusas, noops e as transicoes `stop`/`reset`, que nao esperam pelo processo.
 * A UNICA excecao e `start` a partir de `STOPPED`: o probe fail-closed e
 * pre-condicao da transicao (CTL-013 — nunca se ve `STARTING` de um probe
 * reprovado), e o probe corre dentro de `supervisor.start()`, que e assincrono.
 * Por isso `decidirSincrono` devolve `null` nesse caso e o despacho corre na
 * fila: a superficie responde `accepted` ja e o resultado vem pelas difusoes
 * de estado (o padrao "trabalho lento responde accepted ja" do contrato IPC).
 *
 * O NONCE DE UM START A PARTIR DE `STOPPED` E CONSUMIDO NA EXECUCAO, nunca na
 * decisao: a intent espera na fila (o probe anterior pode demorar) e um nonce
 * queimado na entrada rejeitaria a intent com o proprio nonce. A presenca e
 * verificada na decisao (CTL-023: ausente e recusado, o spawn nao acontece);
 * o consumo corre em {@link executarStart}, no instante do uso.
 *
 * ---------------------------------------------------------------------------
 * RECONCILIACAO COM O PROCESSO REAL
 * ---------------------------------------------------------------------------
 * O supervisor nao expoe eventos (superficie T3.1: start/stop/dispose/
 * snapshot). O controlador observa-o por um repasse periodico INJETADO
 * (`scheduler`): le `snapshot()` e converge. A janela do repasse e o que da
 * espessura a `STOPPING` (o supervisor derruba de forma sincrona; o estado
 * `STOPPING` e do controlador e permanece ate o repasse confirmar `STOPPED`).
 * A PROMOCAO `STARTING -> READY` so acontece quando o estado corrente ainda e
 * `STARTING` — a verificacao de que o `seq` da transicao que a originou ainda
 * e o corrente (o padrao "re-verifica disposed antes de agendar" do supervisor
 * T3.1): uma resolucao tardia nao ressuscita um estado ja revogado.
 *
 * O repasse so corre enquanto ha o que observar: desarma em `STOPPED`/`FAILED`
 * (terminal) e arma ao sair deles — nenhum temporizador permanente.
 *
 * ---------------------------------------------------------------------------
 * FAILED E TERMINAL (CTL-011/012)
 * ---------------------------------------------------------------------------
 * `FAILED` so sai por `reset()` explicito do dono — o sistema nunca se
 * auto-cura em loop. O supervisor em `FAILED` fica para tras ate um `start`
 * pos-reset; a reconciliacao IGNORA o `FAILED` velho do supervisor quando o
 * controlador ja esta em `STOPPED` — o reset humano vence.
 */

import { comporEventoReset, comporEventoToggle, type TunelToggleEvent } from '../audit/events.ts'
import { comporTextoTunelToggle, enviarNotificacao } from '../audit/notify.ts'
import type { AuditSink } from '../contracts/auth.ts'
import type { ControlAction, ControlIntent, ControlRecusa, ControlResultado, Nonce } from '../contracts/control.ts'
import type { TunnelSnapshot, TunnelState } from '../contracts/tunnel.ts'
import type { GuardLogger } from '../logging/logger.ts'
import type { Scheduler, TimerHandle } from '../proc/scheduler.ts'
import type { TunnelSupervisor } from '../tunnel/supervisor.ts'
import type { HostIpcChannel } from '../ipc/channel.ts'
import type { ConfirmServiceComVeredito } from './confirm.ts'

/** Intervalo do repasse de reconciliacao. Ver o cabecalho. */
export const CONTROL_REPASSE_MS = 200

/** Janela de `requestId` processados. Ver o cabecalho (CTL-020). */
export const MAX_JANELA_IDEMPOTENCIA = 128

/**
 * A ORIGEM do arranque automatico (01-ARQUITETURA 6, CTL-033/034).
 *
 * E a UNICA origem que o controlador trata sem a etapa de confirmacao de 2
 * passos: nao ha humano ao telefone para um nonce no arranque, e o nonce
 * existe para confirmar acoes de SUPERFICIE — a intencao persistida
 * (`desiredState: 'READY'`) JA foi confirmada pelo humano que a gravou.
 * `boot` nunca e uma superficie: so a raiz de composicao (`src/index.ts`)
 * o emite, ao reconciliar a intencao persistida com `exposure.autoStart`.
 */
export const ORIGEM_BOOT = 'boot'

/** Vocabulario de auditoria deste controlador. O fechado e de T5.4. */
export const EVENTO_LIGAR = 'tunel_ligar'
export const EVENTO_DESLIGAR = 'tunel_desligar'
export const EVENTO_RESET = 'tunel_reset'

/** Difusao de estado para o broadcast. `url`/`expiresAt` so em `READY`. */
export interface DifusaoEstado {
  readonly estado: TunnelState
  readonly seq: number
  readonly url?: string | undefined
  readonly expiresAt?: number | undefined
}

export interface ControladorDeps {
  readonly log: GuardLogger
  /** O processo real (T3.1). So ESTE ficheiro o chama. */
  readonly supervisor: TunnelSupervisor
  /** Nonce de confirmacao (T5.1, `./confirm.ts`). */
  readonly confirm: ConfirmServiceComVeredito
  /** Relogio injetado (04-TESTES.md 8.1). Nunca `Date.now` direto. */
  readonly agora: () => number
  /** Agendador injetado: o repasse de reconciliacao. */
  readonly scheduler: Scheduler
  /**
   * Modo restrito ATIVO no `state.json` (CTL-015): enquanto ativo, `start` e
   * recusado por QUALQUER superficie, nenhum spawn. A falha de leitura
   * responde `true` (fail-closed).
   */
  readonly restritoAtivo: () => boolean
  /** Segredo forte configurado (CTL-009/TENSAO-002). Falha de leitura: `false`. */
  readonly segredoForte: () => boolean
  /** `control.requireConfirmation`: se a etapa de 2 passos existe. */
  readonly requerConfirmacao: boolean
  /**
   * Onde os eventos de auditoria sao escritos. A escrita e BEST-EFFORT aqui:
   * a subida ja e fail-closed pelo probe do supervisor (sem registo do probe
   * nao ha tunel) e a paragem nao pode ser bloqueada por um disco cheio —
   * a falha vai ao log do operador.
   */
  readonly audit: Pick<AuditSink, 'append'>
  /**
   * O canal da notificacao proativa (T5.4, Frente 2 da Onda 6): a mensagem
   * `notify` do IPC host -> worker, onde o texto + os botoes chegam ao dono.
   * Todo toggle PERMITIDO do tunel notifica DEPOIS do append (a regra de ouro:
   * o log e a fonte da verdade; a notificacao e best-effort e nunca trava o
   * toggle). O envio e `enviarNotificacao`: canal morto/hostil vira aviso, o
   * toggle segue. AUSENTE: sem notificacao de toggle (a fiacao ainda nao tem
   * worker — modo loopback).
   */
  readonly canalNotificacao?: Pick<HostIpcChannel, 'send'> | undefined
  /** Difunde uma mudanca de estado com `seq` monotonico (CTL-010). */
  readonly broadcast: (difusao: DifusaoEstado) => void
  /**
   * Persiste a INTENCAO (`desiredState`: so `READY` ou `STOPPED`). Chamado a
   * cada transicao por intent. Best-effort: a falha vai ao log.
   */
  readonly persistirIntencao?: ((alvo: 'READY' | 'STOPPED') => void) | undefined
  /** So se muda em teste; o valor de producao e {@link CONTROL_REPASSE_MS}. */
  readonly intervaloReconciliacaoMs?: number | undefined
}

/** A projecao publica: `TunnelSnapshot` (do contrato) + `seq` da difusao. */
export interface ControladorSnapshot extends TunnelSnapshot {
  readonly seq: number
}

export interface TunnelController {
  /**
   * Decisao SINCRONA para superficies que respondem no proprio tick (o canal
   * IPC): recusas, noops e as transicoes sem `await` (`stop`/`reset`) sao
   * decididas e APLICADAS aqui. Devolve `null` quando a intent tem de correr
   * na fila serializada — `start` a partir de `STOPPED`, ou qualquer intent
   * enquanto um `start` esta pendente.
   */
  decidirSincrono(intent: ControlIntent): ControlResultado | null
  /**
   * Despacho ASSINCRONO: decide como {@link decidirSincrono} e, quando a
   * decisao exige a fila, serializa. NUNCA rejeita.
   */
  despachar(intent: ControlIntent): Promise<ControlResultado>
  /** Emite um nonce de confirmacao (pass-through ao `ConfirmService`). */
  emitirNonce(action: ControlAction): Nonce
  /** Projecao do estado corrente, com o `seq` da ultima difusao. */
  snapshot(): ControladorSnapshot
  /** Q-2: SINCRONO e idempotente. Derruba o supervisor e desarma o repasse. */
  dispose(): void
}

function eventoDe(action: ControlAction): string {
  switch (action) {
    case 'start':
      return EVENTO_LIGAR
    case 'stop':
      return EVENTO_DESLIGAR
    case 'reset':
      return EVENTO_RESET
  }
}

export function createTunnelController(deps: ControladorDeps): TunnelController {
  const { log, supervisor } = deps
  const intervalo = deps.intervaloReconciliacaoMs ?? CONTROL_REPASSE_MS

  let estado: TunnelState = 'STOPPED'
  let seq = 0
  let disposed = false
  /** Ultimo snapshot observado do supervisor (a verdade do processo). */
  let observado: TunnelSnapshot = { state: 'STOPPED', attempts: 0 }

  const janela = new Map<string, ControlResultado>()
  /** Fila serializada: cada intent espera a conclusao da anterior. */
  let cadeia: Promise<void> = Promise.resolve()
  /**
   * Quantos STARTS estao pendentes (na fila ou em voo). E com ELE que o `stop`
   * que chega durante o probe decide ENTRAR NA FILA em vez de avaliar contra o
   * `STOPPED` que o `start` ainda nao abandonou (9.3). So os starts contam:
   * um stop enfileirado atras de um start nao pode bloquear-se a si proprio
   * quando chegar a vez dele.
   */
  let startsPendentes = 0
  let timer: TimerHandle | undefined

  /* ------------------------------------------------------------------ */
  /* Auditoria e broadcast                                               */
  /* ------------------------------------------------------------------ */

  const auditar = (action: ControlAction, requestedBy: string, resultado: 'permitido' | 'negado'): void => {
    // O VOCABULARIO de T5.4 compoe o NOME e RECUSA origem vazia (A5): um
    // `tunel_ligar:` nao designa ninguem e nao entra no log — o defeito de
    // fiacao falha alto em vez de virar linha de auditoria e texto de
    // notificacao. A composicao e a fonte unica da forma (paridade presa por
    // teste em test/unit/audit/events.test.ts).
    let nome: string
    try {
      nome =
        action === 'reset'
          ? comporEventoReset(requestedBy)
          : comporEventoToggle(action === 'start' ? 'ligar' : 'desligar', requestedBy)
    } catch (error) {
      log.error(
        `auditoria de ${eventoDe(action)} RECUSADA (origem vazia): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    try {
      deps.audit.append({ evento: nome, resultado })
    } catch (error) {
      // BEST-EFFORT, ver o cabecalho: a falha do sink nao pode travar o toggle.
      log.error(
        `falha ao registar auditoria de ${eventoDe(action)} (${requestedBy}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      // REGRA DE OURO (T5.4): sem registo, sem notificacao. O append falhou
      // (disco cheio, fail-closed) — a notificacao NAO sai.
      return
    }
    // O append correu: a notificacao de toggle pode sair (T5.4 fiada na Onda 6).
    notificarToggle(action, nome, resultado)
  }

  /**
   * T5.4 fiada (Onda 6, Frente 2): todo toggle PERMITIDO do tunel e notificado
   * DEPOIS do append — "notifica em todo toggle do tunel" (03-ONDAS T5.4, §10).
   *
   * O texto e composto com `comporTextoTunelToggle` (marcador
   * `alerta:tunel-ligado|desligado` + origem do sufixo; a URL entra so em
   * LIGAR quando ha) e sai pelo canal IPC como `notify` — e o worker quem
   * renderiza os botoes pela gramatica do marcador (T5.2). Best-effort: um
   * canal morto ou hostil nunca trava o toggle — o registo ja esta no
   * AuditSink. Recusas (negado) NAO notificam: o texto diria "Tunel ligado"
   * para uma acao que nao aconteceu. O reset NAO notifica: nao ha composicao
   * de reset neste modulo (declarado no cabecalho de notify.ts).
   */
  const notificarToggle = (action: ControlAction, nome: string, resultado: 'permitido' | 'negado'): void => {
    if (action === 'reset' || resultado !== 'permitido') return
    if (deps.canalNotificacao === undefined) return
    try {
      // O nome ja passou a barreira do compositor acima (origem nao vazia); o
      // try e a rede do best-effort: compor ou enviar nunca lanca para o
      // chamador (05-QUALIDADE 6.3 — o chamador e o proprio toggle). O guard
      // acima (`action !== 'reset'`) ja excluiu o reset, cuja forma e
      // `tunel_reset:<origem>`; para start/stop o nome vem de
      // comporEventoToggle e a forma e exatamente a de TunelToggleEvent — o
      // cast documenta esse facto ao tipo.
      const evento: TunelToggleEvent = { evento: nome as TunelToggleEvent['evento'], resultado: 'permitido' }
      const texto = comporTextoTunelToggle(evento, deps.agora(), observado.info?.url)
      enviarNotificacao(deps.canalNotificacao, log, texto)
    } catch (error) {
      log.error(
        `notificacao de ${eventoDe(action)} falhou (best-effort; o audit ja foi escrito): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const difundir = (): void => {
    deps.broadcast({
      estado,
      seq,
      ...(estado === 'READY' && observado.info !== undefined && observado.expiresAt !== undefined
        ? { url: observado.info.url, expiresAt: observado.expiresAt }
        : {}),
    })
  }

  /* ------------------------------------------------------------------ */
  /* O repasse de reconciliacao                                          */
  /* ------------------------------------------------------------------ */

  const armarRepasse = (): void => {
    if (disposed || timer !== undefined) return
    timer = deps.scheduler.setTimeout(tick, intervalo)
  }

  const desarmarRepasse = (): void => {
    if (timer === undefined) return
    deps.scheduler.clearTimeout(timer)
    timer = undefined
  }

  const tick = (): void => {
    timer = undefined
    if (disposed) return
    reconciliar()
    // Terminal nao observa: nada pode mudar debaixo de STOPPED/FAILED.
    if (estado === 'STOPPED' || estado === 'FAILED') return
    armarRepasse()
  }

  /**
   * Aplicar uma transicao observada: `seq` estritamente crescente (CTL-010) e
   * difusao. O alvo `READY` exige que `observado` ja traga `info`/`expiresAt`
   * (os chamadores garantem — ver `reconciliar` e `executarStart`).
   */
  const transicionar = (alvo: TunnelState): void => {
    estado = alvo
    seq += 1
    difundir()
  }

  /**
   * Le o processo real e converge o estado para a verdade dele — nunca o
   * contrario: o supervisor e a fonte do PROCESSO (morte externa, TTL, close)
   * e o controlador e a fonte da INTENCAO (`STOPPING` e dele). As convergencias
   * podem saltar estados intermédios que o supervisor nunca expoe (o teardown
   * dele e sincrono); onde a tabela legal tem uma sequencia canonica, ela e
   * sintetizada (`READY -> STOPPING -> STOPPED`, CTL-014) para que nenhuma
   * borda fora da tabela seja emitida. Se uma borda ausente acontecer na
   * pratica, reporta-se (03-ONDAS 13.2) e o PREP 6 corrige.
   */
  const reconciliar = (): void => {
    const snap = supervisor.snapshot()
    observado = snap
    if (snap.state === estado) return

    switch (snap.state) {
      case 'STARTING':
        // Rede de seguranca: so o despacho entra em STARTING; se um dia um
        // repasse o vir primeiro, converge-se para a verdade do processo.
        if (estado === 'STOPPED') transicionar('STARTING')
        break

      case 'READY':
        // PROMOCAO COM GUARDA DE SEQ: so promove quem ainda esta em STARTING
        // (com a sequencia canonica DEGRADED -> STARTING -> READY) — uma
        // promocao tardia nao ressuscita um estado revogado por um `stop`.
        if (estado === 'STARTING' || estado === 'DEGRADED') {
          if (estado === 'DEGRADED') transicionar('STARTING')
          transicionar('READY')
        }
        break

      case 'DEGRADED':
        // Morte externa / warmup falho com orcamento: converge (CTL-025/026).
        if (estado === 'STARTING' || estado === 'READY') transicionar('DEGRADED')
        break

      case 'FAILED':
        if (estado === 'STARTING' || estado === 'READY' || estado === 'DEGRADED') {
          transicionar('FAILED')
          deps.persistirIntencao?.('STOPPED')
        }
        // estado === 'STOPPED': pos-reset — o reset humano vence a falha
        // velha do supervisor (o supervisor so volta a mover-se num start).
        break

      case 'STOPPED':
        if (estado === 'STARTING' || estado === 'READY' || estado === 'DEGRADED') {
          // Caiu sem intent (TTL expirado, morte externa sem orcamento):
          // sintetiza a janela STOPPING — CTL-014 quer a sequencia canonica.
          transicionar('STOPPING')
          transicionar('STOPPED')
          deps.persistirIntencao?.('STOPPED')
        } else if (estado === 'STOPPING') {
          // Processo confirmado morto: a paragem concluiu.
          transicionar('STOPPED')
        }
        break

      case 'STOPPING':
        // O supervisor nunca expoe STOPPING (teardown sincrono). Se um dia
        // expuser, espera-se pelo STOPPED — sem acao.
        break
    }
  }

  /* ------------------------------------------------------------------ */
  /* Janela de idempotencia (CTL-020)                                    */
  /* ------------------------------------------------------------------ */

  const registrarJanela = (requestId: string, resultado: ControlResultado): void => {
    janela.set(requestId, resultado)
    if (janela.size > MAX_JANELA_IDEMPOTENCIA) {
      const maisAntigo = janela.keys().next().value
      if (maisAntigo !== undefined) janela.delete(maisAntigo)
    }
  }

  /* ------------------------------------------------------------------ */
  /* A avaliacao das intents                                             */
  /* ------------------------------------------------------------------ */

  const recusar = (recusa: ControlRecusa, intent: ControlIntent): ControlResultado => {
    auditar(intent.action, intent.requestedBy, 'negado')
    return { estado, idempotente: false, recusa }
  }

  /**
   * Resultado de NO-OP (estado inalterado): a acao foi permitida e auditada
   * com a origem — "toda acao de liga/desliga no audit" (aceite da Onda 5).
   */
  const noop = (alvo: TunnelState, intent: ControlIntent, url?: string): ControlResultado => {
    auditar(intent.action, intent.requestedBy, 'permitido')
    return url === undefined ? { estado: alvo, idempotente: false } : { estado: alvo, url, idempotente: false }
  }


  /**
   * Consome o nonce e devolve a recusa quando ele nao autoriza a acao. O nonce
   * autoriza a ACAO (start/reset), nunca deduplica (D29). Ausente com
   * confirmacao exigida -> NONCE_AUSENTE (CTL-023); expirado -> NONCE_EXPIRADO
   * (CTL-022); desconhecido/ja consumido/acao errada -> NONCE_INVALIDO
   * (CTL-021). Com `requerConfirmacao: false` a etapa nao existe.
   */
  /**
   * A etapa de confirmacao EXISTE para esta intent? A origem `boot` esta
   * dispensada: e a propria maquina a honrar a intencao persistida (ver
   * {@link ORIGEM_BOOT}). Vale para o start de superficie (CTL-023) e para o
   * start de boot (CTL-033/034) — um `reset` nunca vem do boot (so a raiz de
   * composicao emite `boot`, e so para `start`).
   */
  const confirmacaoExigida = (intent: ControlIntent): boolean =>
    deps.requerConfirmacao && intent.requestedBy !== ORIGEM_BOOT

  const verificarNonce = (intent: ControlIntent, action: ControlAction): ControlResultado | null => {
    if (!confirmacaoExigida(intent)) return null
    if (intent.nonce === undefined || intent.nonce.length === 0) return recusar('NONCE_AUSENTE', intent)
    switch (deps.confirm.consumirComVeredito(intent.nonce, action)) {
      case 'ok':
        return null
      case 'expirado':
        return recusar('NONCE_EXPIRADO', intent)
      case 'desconhecido':
        return recusar('NONCE_INVALIDO', intent)
    }
  }

  const avaliarStart = (intent: ControlIntent): ControlResultado | null => {
    // Pre-condicoes da tabela (a mais fechada primeiro).
    if (deps.restritoAtivo()) return recusar('MODO_RESTRITO', intent) // CTL-015
    if (!deps.segredoForte()) return recusar('SEM_SEGREDO_FORTE', intent) // CTL-009

    switch (estado) {
      case 'STOPPED': {
        // Ausencia recusada JA (CTL-023: o spawn nao acontece); o CONSUMO
        // corre na execucao (`executarStart`), para a espera na fila nao
        // queimar o nonce da propria intent. A origem `boot` (CTL-033/034)
        // esta dispensada: a intencao persistida ja foi confirmada pelo
        // humano que a gravou.
        if (confirmacaoExigida(intent) && (intent.nonce === undefined || intent.nonce.length === 0)) {
          return recusar('NONCE_AUSENTE', intent)
        }
        // O probe e pre-condicao de STOPPED -> STARTING (CTL-013): corre na
        // fila, onde `supervisor.start()` faz o probe antes de spawnar.
        return null
      }
      case 'STOPPING':
        // D29 domina: a paragem em curso nao e interrompida por um start —
        // nem o nonce dele e queimado por uma rejeicao de estado.
        return recusar('SHUTDOWN_IN_PROGRESS', intent)
      case 'FAILED':
        // CTL-011: terminal e terminal; so reset() sai.
        return recusar('TERMINAL_SEM_RESET', intent)
      case 'STARTING':
      case 'READY':
      case 'DEGRADED': {
        // Decisoes sincronas: o nonce e consumido aqui, com o estado sabido.
        const nonce = verificarNonce(intent, 'start')
        if (nonce !== null) return nonce
        switch (estado) {
          case 'STARTING':
            // CTL-002: no-op idempotente — nunca nasce um segundo cloudflared.
            return noop('STARTING', intent)
          case 'READY':
            // CTL-003: no-op que repete a URL vigente.
            return noop('READY', intent, observado.info?.url)
          case 'DEGRADED':
            // 01-ARQ 9.2: accepted sem nova transicao — o supervisor ja
            // re-tenta com backoff e um segundo up nao acelera nada.
            return noop('DEGRADED', intent)
          default:
            return null // inalcancavel: os outros estados ja foram tratados
        }
      }
    }
  }

  const avaliarStop = (intent: ControlIntent, aguardarStart: boolean): ControlResultado | null => {
    // Com um start pendente, o stop TEM de serializar: avaliado agora contra o
    // STOPPED que o start ainda nao abandonou, ele seria um no-op e o tunel
    // subiria apesar da ordem de paragem (9.3). Na fila, e avaliado contra o
    // estado que o start VAI produzir -> STOPPING.
    //
    // `aguardarStart` distingue os dois pontos de entrada: a decisao SINCRONA
    // aguarda (ha starts na fila OU em voo); a avaliacao DENTRO da fila nunca
    // encontra um start em voo (a fila e serializada) e nao pode bloquear-se
    // em starts que chegaram DEPOIS dela.
    if (aguardarStart && startsPendentes > 0) return null

    switch (estado) {
      case 'STOPPED':
        return noop('STOPPED', intent) // CTL-004
      case 'FAILED':
        // 9.2: noop — nao ha o que derrubar; o reset e outro comando.
        return noop('FAILED', intent)
      case 'STOPPING':
        // 9.2: accepted sem nova transicao — a paragem ja esta em curso.
        return noop('STOPPING', intent)
      case 'STARTING':
      case 'READY':
      case 'DEGRADED': {
        // CTL-005/006: para tudo o que esta de pe. A auditoria corre ANTES da
        // difusao (CTL-039: o registo primeiro, a notificacao depois).
        auditar('stop', intent.requestedBy, 'permitido')
        transicionar('STOPPING')
        supervisor.stop()
        observado = supervisor.snapshot()
        deps.persistirIntencao?.('STOPPED')
        return { estado: 'STOPPING', idempotente: false }
      }
    }
  }

  const avaliarReset = (intent: ControlIntent): ControlResultado | null => {
    if (estado !== 'FAILED') {
      // Nada a repor: o reset so diz respeito ao estado terminal.
      return noop(estado, intent)
    }

    const nonce = verificarNonce(intent, 'reset')
    if (nonce !== null) return nonce

    // CTL-012: o UNICO caminho de saida do FAILED.
    auditar('reset', intent.requestedBy, 'permitido')
    // Alinha o supervisor (que ficou em FAILED): sem processo, sem registo em
    // disco e sem nome publico na allowlist.
    supervisor.stop()
    observado = supervisor.snapshot()
    transicionar('STOPPED')
    deps.persistirIntencao?.('STOPPED')
    return { estado: 'STOPPED', idempotente: false }
  }

  const decidir = (intent: ControlIntent, aguardarStart: boolean): ControlResultado | null => {
    switch (intent.action) {
      case 'start':
        return avaliarStart(intent)
      case 'stop':
        return avaliarStop(intent, aguardarStart)
      case 'reset':
        return avaliarReset(intent)
    }
  }

  /* ------------------------------------------------------------------ */
  /* O start assincrono (probe + spawn)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * A conclusao do spawn — num escopo PROPRIO de proposito: o `await` de
   * `supervisor.start()` e um ponto de suspensao, e entre o inicio do probe e
   * esta linha a Fiber pode ter sido descartada. A RE-VERIFICACAO de `disposed`
   * aqui (o padrao "re-verifica antes de agendar" do supervisor T3.1) e o que
   * impede uma resolucao tardia de promover um estado ja revogado — e a
   * verificacao que o CFA do TypeScript marcaria como "sempre falsa" se
   * vivesse na mesma funcao do primeiro check (ele nao sabe que o `await`
   * suspendeu o controlo).
   */
  const concluirStart = (intent: ControlIntent, snap: TunnelSnapshot): ControlResultado => {
    observado = snap
    if (disposed) return { estado: 'STOPPED', idempotente: false }

    if (snap.state === 'FAILED') {
      // CTL-013: probe reprovado — STOPPED -> FAILED SEM passar por STARTING.
      // A auditoria do probe (fail-closed) ja correu no supervisor.
      auditar('start', intent.requestedBy, 'negado')
      transicionar('FAILED')
      deps.persistirIntencao?.('STOPPED')
      return { estado: 'FAILED', idempotente: false }
    }

    // snap.state === 'STARTING': o spawn aconteceu; o warmup segue em paralelo
    // e a promocao a READY vem pela reconciliacao.
    auditar('start', intent.requestedBy, 'permitido')
    transicionar('STARTING')
    deps.persistirIntencao?.('READY')
    armarRepasse()
    return { estado: 'STARTING', idempotente: false }
  }

  const executarStart = async (intent: ControlIntent): Promise<ControlResultado> => {
    try {
      // RE-VERIFICACAO IMEDIATAMENTE ANTES DE AGENDAR (o padrao do supervisor
      // T3.1): entre a decisao e este ponto a Fiber pode ter sido descartada.
      if (disposed) return { estado: 'STOPPED', idempotente: false }

      // O nonce e CONSUMIDO aqui, no instante do uso (ver o cabecalho): a
      // intent esperou na fila e o nonce dela nao podia ser queimado na
      // entrada. Um nonce que morreu na espera (TTL, replay) e recusado.
      // A origem `boot` nao tem nonce para consumir (CTL-033/034).
      if (confirmacaoExigida(intent)) {
        switch (deps.confirm.consumirComVeredito(intent.nonce ?? '', 'start')) {
          case 'ok':
            break
          case 'expirado':
            return recusar('NONCE_EXPIRADO', intent)
          case 'desconhecido':
            return recusar('NONCE_INVALIDO', intent)
        }
      }

      // Re-avalia contra o estado corrente: a intent esperou na fila e as
      // pre-condicoes podem ter mudado (restrito, segredo, estado).
      const imediato = decidir(intent, false)
      if (imediato !== null) return imediato
      // Aqui: estado === 'STOPPED' e pre-condicoes passaram.

      // `supervisor.start()` corre o probe fail-closed e so depois spawna;
      // nunca rejeita (uma recusa e um snapshot em FAILED).
      return concluirStart(intent, await supervisor.start())
    } catch (error) {
      // `supervisor.start()` nunca rejeita, mas um defeito nao pode derrubar
      // a fila nem ficar em silencio.
      log.error(`falha inesperada ao subir o tunel: ${error instanceof Error ? error.message : String(error)}`)
      auditar('start', intent.requestedBy, 'negado')
      if (estado === 'STOPPED') {
        transicionar('FAILED')
        deps.persistirIntencao?.('STOPPED')
      }
      return { estado, idempotente: false }
    }
  }

  const processarFila = async (intent: ControlIntent): Promise<ControlResultado> => {
    try {
      // A intent anterior com o MESMO requestId pode ter concluido enquanto
      // esta esperava: devolve o resultado dela, sem re-executar (CTL-020).
      const anterior = janela.get(intent.requestId)
      if (anterior !== undefined) return { ...anterior, idempotente: true }

      // Na fila, `aguardarStart` e false: um stop que chegou atras de um start
      // avalia contra o estado que o start produziu (9.3) e nunca contra si.
      const decidido = decidir(intent, false)
      const resultado = decidido !== null ? decidido : await executarStart(intent)

      // A janela de idempotencia (CTL-020): o resultado da PRIMEIRA execucao
      // fica registado — o mesmo requestId repetido devolve-o sem re-executar.
      registrarJanela(intent.requestId, resultado)
      return resultado
    } finally {
      if (intent.action === 'start') startsPendentes -= 1
    }
  }

  /* ------------------------------------------------------------------ */
  /* Superficie publica                                                  */
  /* ------------------------------------------------------------------ */

  const decidirSincrono = (intent: ControlIntent): ControlResultado | null => {
    if (disposed) {
      log.warn('intent recebida com o controlador ja disposto; sem efeito.')
      return { estado: 'STOPPED', idempotente: false }
    }
    const anterior = janela.get(intent.requestId)
    if (anterior !== undefined) return { ...anterior, idempotente: true }
    // D29: rejeicao NA CHEGADA, nunca enfileirada (CTL-007). Registada na
    // janela como QUALQUER outro veredito: repetida, devolve o mesmo resultado
    // sem re-auditar (CTL-020).
    if (intent.action === 'start' && estado === 'STOPPING') {
      const resultado = recusar('SHUTDOWN_IN_PROGRESS', intent)
      registrarJanela(intent.requestId, resultado)
      return resultado
    }
    // A JANELA REGISTA TAMBEM AQUI — o caminho SINCRONO e a superficie real
    // do canal IPC (o responder chama decidirSincrono no proprio tick). Sem o
    // registo, um requestId repetido re-executava e re-auditava: a primeira
    // execucao nao existia para a janela (CTL-020).
    const decidido = decidir(intent, true)
    if (decidido !== null) registrarJanela(intent.requestId, decidido)
    return decidido
  }

  const despachar = (intent: ControlIntent): Promise<ControlResultado> => {
    if (disposed) {
      log.warn('intent recebida com o controlador ja disposto; sem efeito.')
      return Promise.resolve({ estado: 'STOPPED', idempotente: false })
    }

    const anterior = janela.get(intent.requestId)
    if (anterior !== undefined) return Promise.resolve({ ...anterior, idempotente: true })

    if (intent.action === 'start' && estado === 'STOPPING') {
      const resultado = recusar('SHUTDOWN_IN_PROGRESS', intent)
      registrarJanela(intent.requestId, resultado)
      return Promise.resolve(resultado)
    }

    const decidido = decidir(intent, true)
    if (decidido !== null) {
      registrarJanela(intent.requestId, decidido)
      return Promise.resolve(decidido)
    }

    // Entra na fila serializada. `startsPendentes` cobre tambem o periodo em
    // que a intent esta PENDENTE (antes de comecar a processar): e nele que um
    // stop sincrono decidiria errado. So os starts incrementam — ver o
    // cabecalho da variavel.
    if (intent.action === 'start') startsPendentes += 1
    const promessa = cadeia.then(() => processarFila(intent))
    // A cadeia nunca quebra: `processarFila` nao rejeita, mas um defeito aqui
    // nao pode deixar a fila presa.
    cadeia = promessa.then(
      () => undefined,
      () => undefined,
    )
    return promessa
  }

  return {
    decidirSincrono,
    despachar,
    emitirNonce: (action: ControlAction): Nonce => deps.confirm.issue(action),
    snapshot: (): ControladorSnapshot => ({
      state: estado,
      info: estado === 'READY' ? observado.info : undefined,
      failure: estado === 'DEGRADED' || estado === 'FAILED' ? observado.failure : undefined,
      attempts: observado.attempts,
      expiresAt: estado === 'READY' ? observado.expiresAt : undefined,
      seq,
    }),
    dispose: (): void => {
      if (disposed) return
      disposed = true
      desarmarRepasse()
      supervisor.dispose()
    },
  }
}
