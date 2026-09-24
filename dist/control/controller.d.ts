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
import type { AuditSink } from '../contracts/auth.ts';
import type { ControlAction, ControlIntent, ControlResultado, Nonce } from '../contracts/control.ts';
import type { TunnelSnapshot, TunnelState } from '../contracts/tunnel.ts';
import type { GuardLogger } from '../logging/logger.ts';
import type { Scheduler } from '../proc/scheduler.ts';
import type { TunnelSupervisor } from '../tunnel/supervisor.ts';
import type { HostIpcChannel } from '../ipc/channel.ts';
import type { ConfirmServiceComVeredito } from './confirm.ts';
/** Intervalo do repasse de reconciliacao. Ver o cabecalho. */
export declare const CONTROL_REPASSE_MS = 200;
/** Janela de `requestId` processados. Ver o cabecalho (CTL-020). */
export declare const MAX_JANELA_IDEMPOTENCIA = 128;
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
export declare const ORIGEM_BOOT = "boot";
/** Vocabulario de auditoria deste controlador. O fechado e de T5.4. */
export declare const EVENTO_LIGAR = "tunel_ligar";
export declare const EVENTO_DESLIGAR = "tunel_desligar";
export declare const EVENTO_RESET = "tunel_reset";
/** Difusao de estado para o broadcast. `url`/`expiresAt` so em `READY`. */
export interface DifusaoEstado {
    readonly estado: TunnelState;
    readonly seq: number;
    readonly url?: string | undefined;
    readonly expiresAt?: number | undefined;
}
export interface ControladorDeps {
    readonly log: GuardLogger;
    /** O processo real (T3.1). So ESTE ficheiro o chama. */
    readonly supervisor: TunnelSupervisor;
    /** Nonce de confirmacao (T5.1, `./confirm.ts`). */
    readonly confirm: ConfirmServiceComVeredito;
    /** Relogio injetado (04-TESTES.md 8.1). Nunca `Date.now` direto. */
    readonly agora: () => number;
    /** Agendador injetado: o repasse de reconciliacao. */
    readonly scheduler: Scheduler;
    /**
     * Modo restrito ATIVO no `state.json` (CTL-015): enquanto ativo, `start` e
     * recusado por QUALQUER superficie, nenhum spawn. A falha de leitura
     * responde `true` (fail-closed).
     */
    readonly restritoAtivo: () => boolean;
    /** Segredo forte configurado (CTL-009/TENSAO-002). Falha de leitura: `false`. */
    readonly segredoForte: () => boolean;
    /** `control.requireConfirmation`: se a etapa de 2 passos existe. */
    readonly requerConfirmacao: boolean;
    /**
     * Onde os eventos de auditoria sao escritos. A escrita e BEST-EFFORT aqui:
     * a subida ja e fail-closed pelo probe do supervisor (sem registo do probe
     * nao ha tunel) e a paragem nao pode ser bloqueada por um disco cheio —
     * a falha vai ao log do operador.
     */
    readonly audit: Pick<AuditSink, 'append'>;
    /**
     * O canal da notificacao proativa (T5.4, Frente 2 da Onda 6): a mensagem
     * `notify` do IPC host -> worker, onde o texto + os botoes chegam ao dono.
     * Todo toggle PERMITIDO do tunel notifica DEPOIS do append (a regra de ouro:
     * o log e a fonte da verdade; a notificacao e best-effort e nunca trava o
     * toggle). O envio e `enviarNotificacao`: canal morto/hostil vira aviso, o
     * toggle segue. AUSENTE: sem notificacao de toggle (a fiacao ainda nao tem
     * worker — modo loopback).
     */
    readonly canalNotificacao?: Pick<HostIpcChannel, 'send'> | undefined;
    /** Difunde uma mudanca de estado com `seq` monotonico (CTL-010). */
    readonly broadcast: (difusao: DifusaoEstado) => void;
    /**
     * Persiste a INTENCAO (`desiredState`: so `READY` ou `STOPPED`). Chamado a
     * cada transicao por intent. Best-effort: a falha vai ao log.
     */
    readonly persistirIntencao?: ((alvo: 'READY' | 'STOPPED') => void) | undefined;
    /** So se muda em teste; o valor de producao e {@link CONTROL_REPASSE_MS}. */
    readonly intervaloReconciliacaoMs?: number | undefined;
}
/** A projecao publica: `TunnelSnapshot` (do contrato) + `seq` da difusao. */
export interface ControladorSnapshot extends TunnelSnapshot {
    readonly seq: number;
}
export interface TunnelController {
    /**
     * Decisao SINCRONA para superficies que respondem no proprio tick (o canal
     * IPC): recusas, noops e as transicoes sem `await` (`stop`/`reset`) sao
     * decididas e APLICADAS aqui. Devolve `null` quando a intent tem de correr
     * na fila serializada — `start` a partir de `STOPPED`, ou qualquer intent
     * enquanto um `start` esta pendente.
     */
    decidirSincrono(intent: ControlIntent): ControlResultado | null;
    /**
     * Despacho ASSINCRONO: decide como {@link decidirSincrono} e, quando a
     * decisao exige a fila, serializa. NUNCA rejeita.
     */
    despachar(intent: ControlIntent): Promise<ControlResultado>;
    /** Emite um nonce de confirmacao (pass-through ao `ConfirmService`). */
    emitirNonce(action: ControlAction): Nonce;
    /** Projecao do estado corrente, com o `seq` da ultima difusao. */
    snapshot(): ControladorSnapshot;
    /** Q-2: SINCRONO e idempotente. Derruba o supervisor e desarma o repasse. */
    dispose(): void;
}
export declare function createTunnelController(deps: ControladorDeps): TunnelController;
//# sourceMappingURL=controller.d.ts.map