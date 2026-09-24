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
import type { StateStore } from '../contracts/state.ts';
import type { TunnelMode } from '../contracts/tunnel.ts';
import { type TreeKillDeps } from '../proc/tree-kill.ts';
import { type TtlEffects, type TtlLogger } from './ttl.ts';
/**
 * Reexportadas de `src/proc/introspect.ts`, onde vivem: sao leituras genericas de
 * `/proc`, nao politica de tunel. Ficam visiveis daqui porque e este o modulo que
 * as consome e e por ele que T3.3 entra.
 */
export { readProcessCmdline, readProcessStartMs, START_TIME_TOLERANCE_MS } from '../proc/introspect.ts';
/** O que se guarda de um tunel vivo. Espelha `PersistedState['tunnel']`. */
export interface TunnelProcessRecord {
    readonly pid: number;
    readonly startedAt: number;
    readonly mode: TunnelMode;
}
/** Escreve o registo. Chamado logo apos o `spawn`, no gancho `onSpawned`. */
export declare function recordTunnelProcess(store: StateStore, record: TunnelProcessRecord): void;
/**
 * Apaga o registo. Chamado quando o tunel e derrubado DE FORMA LIMPA.
 *
 * PORQUE IMPORTA APAGAR: um registo que sobra depois de uma paragem limpa faz o
 * boot seguinte varrer um pid que ja nao e nosso — e o caso de reutilizacao de
 * pid deixa de ser teorico. O registo existe para descrever um tunel VIVO.
 */
export declare function clearTunnelProcess(store: StateStore): void;
export declare function readTunnelProcess(store: StateStore): TunnelProcessRecord | undefined;
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
export declare function looksLikeCloudflared(cmdline: string, expectedCommand?: string): boolean;
/** Resultado da varredura. Cada valor descreve uma decisao diferente. */
export type OrphanSweepOutcome = 
/** Nao havia registo nenhum: arranque limpo. */
'none'
/** Havia registo, mas o processo ja nao existe. So se limpou o registo. */
 | 'gone'
/** O pid existe e NAO e o nosso tunel (pid reutilizado). Nao se matou nada. */
 | 'foreign'
/** O orfao foi derrubado. */
 | 'killed';
export interface OrphanSweepResult {
    readonly outcome: OrphanSweepOutcome;
    readonly record: TunnelProcessRecord | undefined;
}
export interface OrphanSweepDeps extends TreeKillDeps {
    readonly store: StateStore;
    /** `process.kill(pid, 0)` — existencia, sem entregar sinal. */
    readonly isAlive: (pid: number) => boolean;
    /** Identificacao do processo. `null` = nao ha como saber. */
    readonly identify: (pid: number) => string | null;
    /** Instante de arranque do pid, em epoch ms. `null` = nao ha como saber. */
    readonly startedAtOf: (pid: number) => number | null;
    /**
     * `tunnel.binaryPath` configurado. Sem ele, um binario com nome versionado
     * escapa a regra generica e a varredura falha para ABERTO. Ver
     * {@link looksLikeCloudflared}.
     */
    readonly expectedCommand?: string | undefined;
    readonly log: {
        info(message: string): void;
        warn(message: string): void;
    };
}
/** Dependencias reais da varredura, no processo corrente. */
export declare function defaultOrphanSweepDeps(store: StateStore, log: OrphanSweepDeps['log'], expectedCommand?: string): OrphanSweepDeps;
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
export declare function sweepOrphanTunnel(deps: OrphanSweepDeps): OrphanSweepResult;
/** Nome do evento de auditoria. O vocabulario fechado e de T5.4. */
export declare const EVENTO_ORFAO = "tunel_orfao_derrubado";
/** Aviso ao dono. Sem a URL: ela e efemera e ja nao existe. */
export declare function ownerOrphanMessage(): string;
export interface BootRecoveryDeps {
    readonly sweep: OrphanSweepDeps;
    /** `tunnel.ttlMinutes` ja validado por `assertValidTtlMinutes`. */
    readonly ttlMinutes: number;
    readonly now: () => number;
    readonly effects: TtlEffects;
    readonly log: TtlLogger;
}
export interface BootRecovery {
    readonly sweep: OrphanSweepResult;
    /** `'expirado'` sse o `startedAt` persistido ja tinha passado do prazo. */
    readonly ttl: 'sem-registo' | 'dentro-do-prazo' | 'expirado';
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
export declare function recoverTunnelAtBoot(deps: BootRecoveryDeps): BootRecovery;
//# sourceMappingURL=pidfile.d.ts.map