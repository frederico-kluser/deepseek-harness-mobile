/**
 * `createWorkerSupervisor` -- o worker de long-polling do Telegram, expresso como
 * UMA INSTANCIACAO de `createProcessSupervisor`.
 *
 * O QUE ESTE FICHEIRO NAO TEM, e essa e a prova de que a generalizacao e real:
 * nada de ciclo de vida. Backoff com jitter, orcamento em janela deslizante,
 * `AbortController` unico, tree-kill do grupo, disposer sincrono LIFO e evento
 * terminal unico vivem em `./supervisor.ts` e sao partilhados com o supervisor
 * do `cloudflared`. Aqui esta SO o que distingue o worker de qualquer outro
 * processo longo: o `argv`, o `cwd`, o `stdio`, o ambiente -- e, desde a Onda 4,
 * o CANAL.
 *
 * O ficheiro cresceu nesta onda (de ~90 para ~225 linhas) e a razao esta toda
 * numa frase: o worker passou a ser o unico processo do repositorio com um
 * PROTOCOLO. `stdin` passou de `'ignore'` a `'pipe'`, e com isso vieram o
 * sentido host -> worker (`send`), o decisor de intencoes e o dead-man's switch.
 * O `cloudflared` nao tem nada disto e continua a nao ter -- pelo que a
 * alternativa (empurrar o canal para a superficie generica) tornaria a
 * generalizacao MENOS real, nao mais.
 *
 * `src/proc/supervisor.ts` reexporta este simbolo, e nao ao contrario: quem
 * importava `createWorkerSupervisor` de la (`src/index.ts`) continua a compilar
 * sem tocar em nada.
 */
import { type Config } from '../config/schema.ts';
import { type IpcIntentMessage, type IpcMessageToWorker } from '../contracts/ipc.ts';
import type { Context } from '../dsh/adapter.ts';
import type { IpcNonceRequestMessage, IpcPairingSuccessMessage } from '../contracts/ipc.ts';
import { type ProviderId } from './env.ts';
import { type ProcessSupervisor, type SupervisorDeps } from './supervisor.ts';
/**
 * Superficie publica do supervisor do worker.
 *
 * Continua a ser um tipo proprio (e nao um alias nu de `ProcessSupervisor`)
 * porque a Onda 4 lhe acrescentou o que o IPC precisa -- {@link send} -- sem
 * alargar a superficie generica, que e partilhada com o tunel.
 */
export interface WorkerSupervisor extends ProcessSupervisor {
    /**
     * Difunde uma mensagem host -> worker pelo canal JSONL.
     *
     * `false` quando ela nao saiu: nao ha filho vivo, o canal esta saturado
     * (backpressure) ou a mensagem viola o contrato. NUNCA lanca e NUNCA bloqueia
     * -- um `write` que bloqueasse num pipe cheio congelava o DSH inteiro.
     */
    send(message: IpcMessageToWorker): boolean;
    /**
     * ATUALIZA o token do bot em runtime, ANTES de um `restart`.
     *
     * O `buildSpec` captura o token no instante do spawn; sem este setter, um
     * `restart()` apos a rota POST /__guard-ui/api/token gravar um token novo em
     * `secrets.env` relancaria o worker com o token ANTIGO. O `definirToken` e o
     * que liga o novo valor ao proximo spawn (e a nova mascara de logs -- a
     * `secrets()` partilha o MESMO holder). Aditivo: espelha o token atual, nao
     * muda `provider` nem `config`.
     */
    definirToken(token: string): void;
}
/** O que distingue este supervisor do generico, alem do `argv`. */
export interface WorkerSupervisorOptions {
    /**
     * O TOKEN do bot, RESOLVIDO pela costura (`config.worker.token` ou o
     * `secrets.env` gravado pelo CLI). AUSENTE, o supervisor usa `config.worker.token`.
     *
     * PORQUE EXISTE: o botao da UI e o spawn do worker tem de PARTILHAR a MESMA
     * resolucao do token, ou o botao acenderia com um token que nunca chega ao
     * worker (`config.worker.token` vazio mas `secrets.env` preenchido). A costura
     * em `src/index.ts` resolve uma vez e passa-o para as duas pontas.
     */
    readonly token?: string | undefined;
    /**
     * O PROVEDOR de mensageria ATIVO (desacoplamento do bot, D1).
     *
     * AUSENTE = o default fechado `telegram` (mesmo valor que `config.worker.provider`
     * ausente). O supervisor rotula o worker no PONTO DE SPAWN, injetando
     * `DSH_GUARD_PROVIDER=<provider>` no env do filho via `buildWorkerEnv` — a
     * variavel que o worker le para escolher o PROVEDOR (e o `tokenVar` de destino).
     * A costura em `src/index.ts` resolve `config.worker.provider ?? DEFAULT_PROVIDER`
     * e passa-o para aqui, de modo a que o rotulo do filho e o token resolvido venham
     * da MESMA fonte.
     */
    readonly provider?: ProviderId | undefined;
    /**
     * Decide UMA intencao vinda do worker e devolve a resposta.
     *
     * SINCRONO e TOTAL (devolve sempre uma mensagem), porque o contrato diz que o
     * `ack` e "sempre emitido -- inclusive nos caminhos de erro": sem resposta, o
     * cliente do Telegram fica com a barra de progresso eterna e o dono nao sabe
     * se o comando chegou. Trabalho lento responde `accepted` JA e difunde o resto
     * depois, por {@link WorkerSupervisor.send}.
     *
     * AUSENTE, o canal responde `INTERNAL` a tudo -- ver
     * {@link rejeitarSemControlador}. E fail-closed e e visivel no log; nao ha
     * caminho em que uma intencao seja ignorada em silencio.
     */
    readonly onIntent?: ((intent: IpcIntentMessage) => IpcMessageToWorker) | undefined;
    /**
     * Decide UM pedido de nonce (EMENDA-COSTURA-5) e devolve a resposta.
     *
     * AUSENTE, o canal responde `error INTERNAL` ao pedido (fail-closed: um
     * nonce que nao chega nao autoriza nada — CTL-023). Em producao a fiacao
     * liga-o ao `ConfirmService` de T5.1 via `criarRespondedorDeNonce`.
     */
    readonly onNonceRequest?: ((request: IpcNonceRequestMessage) => IpcMessageToWorker) | undefined;
    /**
     * Decide UM `pairing.success` (EMENDA ONDA-1-PAREAR-VIA-PAINEL) e devolve a
     * resposta — tipicamente `pairing.owner`, que fecha o handshake e liberta a
     * allowlist; a costura em `src/index.ts` tambem persiste o dono no `state.json`.
     *
     * AUSENTE, o canal responde `error INTERNAL` ao aviso — o pareamento fica
     * valido no worker mas o host nao aprende o dono (fail-closed).
     */
    readonly onPairingSuccess?: ((msg: IpcPairingSuccessMessage) => IpcMessageToWorker) | undefined;
}
/** Cria o supervisor do processo filho do worker do Telegram. */
export declare function createWorkerSupervisor(ctx: Context, config: Config, deps?: SupervisorDeps, options?: WorkerSupervisorOptions): WorkerSupervisor;
//# sourceMappingURL=worker.d.ts.map