/**
 * A SUPERFICIE Telegram do controlador: mapeia `IpcIntentMessage` (o canal
 * host <-> worker de T4.3, `src/ipc/channel.ts`) para `ControlIntent` e
 * devolve a resposta `IpcMessageToWorker` que o canal exige.
 *
 * DONO: T5.1 (a fiacao do canal IPC do host e desta sub-tarefa).
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTA CAMADA EXISTE — S6, D29 E O "ACK SEMPRE"
 * ---------------------------------------------------------------------------
 * - S6 (`src/contracts/ipc.ts`): a allowlist de identidade vive no worker; o
 *   host VOLTA a verificar contra o pareamento persistido, porque uma
 *   verificacao no processo que fala com a internet e a primeira a cair se
 *   esse processo for comprometido. A recusa e `NOT_PAIRED` e e CONTADA no
 *   audit (CTL-029).
 * - `EXPOSURE_DISABLED`: com `exposure.mode !== 'tunnel'` nao ha controlador
 *   (a fiacao so o cria com config de tunel) e a superficie recusa o pedido
 *   com o codigo cujo texto diz qual chave mudar.
 * - D29: `tunnel.up` em `STOPPING` e respondido `rejected` com
 *   `SHUTDOWN_IN_PROGRESS` — decidido de forma SINCRONA, nunca enfileirado.
 * - O `ack` e SEMPRE emitido: trabalho lento (`start` a partir de `STOPPED`,
 *   onde o probe corre) responde `accepted` JA e o resultado vem pelas
 *   difusoes de estado — o padrao do contrato IPC ("trabalho lento responde
 *   accepted ja e difunde o resto depois por send").
 * - `/emergencia` REDUZ exposicao e NAO exige nonce (CTL-024). Ele derruba o
 *   tunel PRIMEIRO (despacho `stop`) e so depois invalida as sessoes
 *   (`aposEmergencia`): "ordem tunel primeiro, sempre" (02-SEGURANCA L8).
 *
 * A COSTURA (item 5) fia `session.issue` e `secret.rotate`: o /acessar (e o
 * auto-link do /ligar) emite a CHAVE NO LINK (`LinkTokenSurface.emitir`) e
 * notifica o dono com `https://<url>?key=<token>` por `notify` (TG-085) — quem
 * abre entra DIRETO, sem senha (modelo expose-port da Onda 1); o /rotacionar
 * consome o nonce no HOST, regenera o segredo (SECRET-008: sessoes invalidadas)
 * e revoga a chave no link, notificando SEM enviar a senha pelo chat. Sem a
 * chave/rotacao fiadas, os dois respondem `INTERNAL` — fail-closed.
 *
 * EMENDA ONDA-3-HOST-TAREFAS: `chat.new`/`worktree.create` deixaram de ser STUB
 * e passam a DISPATCH REAL — idempotencia por `requestId`, nonce `'reset'`
 * consumido no host, revalidacao S6 da forma, efeitos no registry
 * (`src/agents/registry.ts` — criar chat/worktree) e difusao `agent.report`
 * apos o efeito. Sem `tarefas`/`confirm` fiados, as duas respondem `INTERNAL`
 * (fail-closed — o mesmo padrao de `agent.dispatch`).
 */
import type { AuditSink, SecretStore } from '../contracts/auth.ts';
import type { ControlAction, ControlRecusa, ControlResultado } from '../contracts/control.ts';
import type { ConfirmServiceComVeredito } from './confirm.ts';
import type { LinkTokenSurface } from '../contracts/link-token.ts';
import type { AgentRegistry, TarefasHost } from '../agents/registry.ts';
import type { MagicStore } from '../session/magic.ts';
import type { IpcAckMessage, IpcIntentMessage, IpcMessageToWorker, IpcNonceRequestMessage } from '../contracts/ipc.ts';
import type { GuardLogger } from '../logging/logger.ts';
import type { TunnelController } from './controller.ts';
/** Vocabulario de auditoria desta superficie. O fechado e de T5.4. */
export declare const EVENTO_NAO_PAREADO = "tunel_intent_nao_pareado";
export interface RespondedorIpcDeps {
    /**
     * O controlador. `undefined` quando nao ha config de tunel
     * (`exposure.mode !== 'tunnel'`): a superficie recusa com
     * `EXPOSURE_DISABLED` — nunca despacha para um controlador inexistente.
     */
    readonly controller: TunnelController | undefined;
    /** `exposure.mode === 'tunnel'` (derivado da config pela fiacao). */
    readonly modoTunel: boolean;
    /**
     * Re-verificacao de identidade contra o pareamento persistido (S6).
     * NUNCA lanca: a falha de leitura responde `false` (fail-closed).
     * `from`/`chat` sao STRING (envelope IPC V2 — EMENDA ONDA-1-IPC-ENVELOPE-STRING).
     */
    readonly pareado: (from: string, chat: string) => boolean;
    /** Onde as recusas de identidade sao contadas (CTL-029). */
    readonly audit: Pick<AuditSink, 'append'>;
    readonly log: GuardLogger;
    /** Relogio injetado, para o campo `at` do `ControlIntent`. */
    readonly agora: () => number;
    /**
     * Reenvia o estado corrente pelo canal (resposta a `/status` e a
     * reconexoes — CTL-027: o worker recebe o estado COMPLETO, nao um delta).
     */
    readonly reemitirEstado: () => void;
    /**
     * Efeitos do `/emergencia` DEPOIS de o tunel cair: invalidar TODAS as
     * sessoes e auditar. Recebe a intent para a origem da linha.
     */
    readonly aposEmergencia: (intent: IpcIntentMessage) => void;
    /**
     * O ConfirmService do HOST (T5.1, partilhado com o controlador). Usado pelo
     * `secret.rotate` para consumir o nonce com a acao 'reset' (o worker pediu-o
     * pela ponte EMENDA-COSTURA-5). AUSENTE: `secret.rotate` responde INTERNAL.
     */
    readonly confirm?: Pick<ConfirmServiceComVeredito, 'consumirComVeredito'> | undefined;
    /**
     * O MagicStore (T2.2) do link magico. Usado pelo `session.issue` (/acessar).
     * AUSENTE: `session.issue` responde INTERNAL (o estado de antes da costura).
     *
     * >>> ONDA 2: com o modelo expose-port o accesso pelo tunel entra por
     * SESSAO ou pela CHAVE NO LINK (`?key=<token>`, `src/session/link-token.ts`).
     * O link do bot compoe `?key=<token>` via `emitir()` — NUNCA mais o `#mk=`
     * nem a senha permanente. `magic` continua no contrato por compatibilidade,
     * mas o `session.issue` usa `linkToken` quando presente. <<<
     */
    readonly magic?: MagicStore | undefined;
    /**
     * O STORE da CHAVE NO LINK (onda 1, `src/contracts/link-token.ts`). Usado
     * pelo `session.issue` (/acessar e auto-link) para compor `https://<url>?key=<token>`.
     * A chave viaja UMA vez, no retorno de `emitir()`, e dali so para a URL que o
     * dono recebe por `notify`. AUSENTE: `session.issue` responde INTERNAL.
     */
    readonly linkToken?: LinkTokenSurface | undefined;
    /** `SecretStore.rotate` — o /rotacionar regenera o segredo e invalida sessoes. */
    readonly secretos?: Pick<SecretStore, 'rotate'> | undefined;
    /** Envia um `notify` ao dono (o link magico / a instrucao local da rotacao). */
    readonly notificarDono?: ((texto: string) => void) | undefined;
    /**
     * EMENDA ONDA-4-AGENTS-HOST: o REGISTRY DE AGENTES (o dispatcher da Onda 4).
     * AUSENTE, as tres intents `agent.*` respondem `error INTERNAL` — fail-closed
     * (o mesmo padrao de `session.issue`/`secret.rotate` sem fiacao).
     */
    readonly agentes?: AgentRegistry | undefined;
    /**
     * EMENDA ONDA-3-HOST-TAREFAS: a PORTA das tarefas novas (`chat.new` e
     * `worktree.create`) — a face `TarefasHost` do MESMO registry de
     * `agentes` (interface propria para o contrato de `AgentRegistry` nao
     * mexer). AUSENTE, as duas intents respondem `error INTERNAL` — fail-closed
     * (o mesmo padrao de `agent.dispatch` sem registry fiado).
     */
    readonly tarefas?: TarefasHost | undefined;
    /**
     * Difunde `agent.report` ao worker (resposta a `agent.status`). Composto
     * pela FIACAO (`src/index.ts`): lê `agentes.estado()`, monta a mensagem e
     * envia pelo canal. AUSENTE: `agent.status` responde INTERNAL (sem relatorio
     * nao ha resposta util a um pedido de lista).
     */
    readonly relatorioDeAgentes?: (() => void) | undefined;
}
/** O tratador que a fiacao entrega a `createWorkerSupervisor({ onIntent })`. */
export type RespondedorIpc = (intent: IpcIntentMessage) => IpcMessageToWorker;
/**
 * Mapeia uma recusa do controlador para o vocabulario FECHADO do IPC.
 *
 * Uma entrada do vocabulario nao tem correspondente (`SEM_SEGREDO_FORTE`):
 * nao ha codigo IPC para "segredo nao provisionado". Responde-se `INTERNAL`
 * — o codigo catch-all cuja mensagem "nao denuncia topologia" — e o motivo
 * fica no audit, que e a fonte da verdade.
 */
export declare function codigoIpcDe(recusa: ControlRecusa): IpcAckMessage['code'];
/**
 * Deriva o `result` do ack a partir do resultado do despacho.
 *
 * `ControlResultado` nao carrega "accepted vs noop" — so o estado apos o
 * despacho e a recusa. A derivacao e a tabela de 01-ARQUITETURA 9.2:
 *
 *   - `start` -> `STARTING`/`DEGRADED`: accepted (a subida esta em curso);
 *     `READY`: noop (ja estava online; a URL vigente vem na difusao);
 *     `FAILED` sem recusa: rejected `PROBE_FAILED` (CTL-013);
 *   - `stop` -> `STOPPING`: accepted; `STOPPED`/`FAILED`: noop;
 *   - `reset` -> `STOPPED`: accepted; resto: noop.
 */
export declare function resultadoDoAck(action: ControlAction, resultado: ControlResultado): {
    readonly result: 'accepted' | 'noop' | 'rejected';
    readonly code?: IpcAckMessage['code'];
};
export declare function criarRespondedorIpc(deps: RespondedorIpcDeps): RespondedorIpc;
/**
 * O lado HOST do transporte do nonce (EMENDA-COSTURA-5, `src/contracts/ipc.ts`):
 * responde a `nonce.request` do worker com `nonce.issued` emitido pelo
 * `ConfirmService` de T5.1 (via controlador). O nonce viaja SÓ pelo pipe
 * host <-> worker; NUNCA e logado (S3) — so o prazo e a acao podem ir ao log.
 *
 * SEM CONTROLADOR (modo loopback), responde `EXPOSURE_DISABLED` — fail-closed:
 * um nonce que nao chega ao worker nao autoriza nada (CTL-023).
 */
export interface RespondedorNonceDeps {
    /** O controlador (fonte do `ConfirmService`). `undefined` em modo loopback. */
    readonly controller: TunnelController | undefined;
    readonly log: GuardLogger;
}
export type RespondedorNonce = (request: IpcNonceRequestMessage) => IpcMessageToWorker;
export declare function criarRespondedorDeNonce(deps: RespondedorNonceDeps): RespondedorNonce;
//# sourceMappingURL=surface-ipc.d.ts.map