/**
 * A superficie de UI nativa do DSH — terceira superficie, ao lado do Telegram
 * (T5.2) e do painel `/__guard` (T5.3). 03-ONDAS 2.1 (desvio declarado): a
 * sub-tarefa condicional T5.5 "registra os mesmos dois botoes no ponto de
 * contribuicao do host CONSUMINDO o mesmo `ControlIntent` de T5.1 — nunca
 * chamando o supervisor direto".
 *
 * A UI vive SO na aba settings do DSH, via as rotas `/__guard-ui/api/*` que
 * este modulo registra no host: NENHUM bloco e injetado no indice servido na
 * home (o antigo `tapIndex` — o chrome visivel da home — foi removido: ele
 * criava um scroll extra na home; o token de CSRF da superficie agora tem a
 * rota `GET /__guard-ui/api/csrf` como UNICA fonte, HIGH-2).
 *
 * PROJECCAO: a superficie nao mantem estado proprio alem do ultimo `seq` que
 * viu (a mesma disciplina que `src/contracts/ipc.ts` impoe ao worker). A
 * fonte e o broadcast do controlador de T5.1, entregue por `deps.subscribe`;
 * difusoes fora de ordem (seq nao-crescente) sao DESCARTADAS, para o flapping
 * de tunel nao fazer a UI andar para tras.
 *
 * O QUE ESTE MODULO NAO FAZ, POR CONSTRUCAO:
 *   - nao importa `@deepseek-ai/*` (a fronteira com o DSH e so
 *     `src/dsh/adapter.ts`, D1) — os tipos do host ficam ESTRUTURAIS nos
 *     `deps` (registerRoute), satisfeitos por quem fia a superficie;
 *   - nao importa `src/tunnel/**` nem `src/control/**` — a unica via para o
 *     controlador e `deps.emit(ControlIntent)` (o mapa de importacoes do
 *     modulo e a prova, ver `test/unit/ui-contrib/surface.test.ts`);
 *   - nao valida nonce (S5): quem emite e quem valida e o HOST
 *     (`deps.issueNonce` / `deps.emit`); a superficie transporta o valor opaco
 *     entre o passo 1 e o passo 2 do LIGAR.
 *
 * A COSTURA (pos-onda) liga os deps em `src/index.ts` — ver o handoff: o que
 * este modulo exige do contexto do host e `ctx.webServer.register` (ja
 * exposto por `src/dsh/adapter.ts`), o despacho de T5.1 (`emit`), o
 * `ConfirmService` de T5.1 (`issueNonce`) e o broadcast do controlador
 * (`subscribe`).
 */
import type { ControlAction, ControlIntent, ControlResultado, Nonce } from '../contracts/control.ts';
import type { TunnelSnapshot } from '../contracts/tunnel.ts';
import { type UiAcessoBruto, type UiAgentOps, type UiContribRoute, type ProviderDoBot, type UiPairOps, type UiTokenOps } from './routes.ts';
import type { BotEstado } from './bot-state.ts';
/** A difusao de estado que esta superficie consome. */
export interface UiContribBroadcast {
    /** Monotonico; nao-crescente = fora de ordem, descartada. */
    readonly seq: number;
    readonly snapshot: TunnelSnapshot;
}
/**
 * Tudo o que a superficie precisa, injetado. A costura em `src/index.ts`
 * liga cada campo ao contexto real do host:
 *
 *   - `registerRoute`<- `ctx.webServer.register` (via `src/dsh/adapter.ts`; as
 *                       rotas desta superficie nascem ATRAS da barreira de
 *                       autenticacao, sem isencao nenhuma —
 *                       `unauthenticatedPrefixes` nao as nomeia e nao precisa
 *                       de nomear)
 *   - `emit`         <- o despacho de intents de T5.1 (controlador)
 *   - `issueNonce`   <- `ConfirmService.issue` de T5.1 (`src/control/confirm.ts`)
 *   - `subscribe`    <- o broadcast de T5.1; a costura DEVE invocar o
 *                       listener imediatamente com o estado corrente
 *                       ({ seq, snapshot }) e depois em cada difusao
 *   - `now`          <- relogio injetado (nunca `Date.now` direto)
 *   - `requestedBy`  <- origem pre-formatada do audit; default `ui:native`
 */
export interface UiContribDeps {
    readonly registerRoute: (route: UiContribRoute) => () => void;
    readonly emit: (intent: ControlIntent) => Promise<ControlResultado>;
    readonly issueNonce: (action: ControlAction) => Nonce;
    readonly subscribe: (listener: (broadcast: UiContribBroadcast) => void) => () => void;
    readonly now: () => number;
    /**
     * O estado do BOT OFFLINE/ONLINE, lido do disco pela costura em
     * `src/index.ts`. A superficie so o reencaminha; nao guarda estado proprio
     * para o bot (cada pedido le o disco de novo — o pareamento muda pela
     * CLI/worker, nao por esta superficie).
     */
    readonly botState: () => BotEstado;
    /**
     * O PROVEDOR de mensageria ATIVO, fiado pela costura em `src/index.ts`
     * (`config.worker.provider ?? DEFAULT_PROVIDER`) — a MESMA escolha que o
     * worker faz ao ler `DSH_GUARD_PROVIDER`. O GET /telegram emite-o no corpo
     * para o painel rotular o onboarding por provedor.
     */
    readonly provider: ProviderDoBot;
    readonly requestedBy?: string;
    /**
     * O servico de configuracao do token, fiado pela costura em `src/index.ts`
     * (detem `config`, `statePaths` e o supervisor do worker). NUNCA sai daqui
     * para a UI o valor do token.
     */
    readonly tokenOps: UiTokenOps;
    /**
     * O servico de pareamento VIA PAINEL, fiado pela costura em `src/index.ts`
     * (detem `config`, `statePaths`, a sessao de pareamento em memoria e o
     * supervisor do worker). O CODIGO NUNCA sai daqui para a UI via log — so na
     * resposta a `gerar()`.
     */
    readonly pairOps: UiPairOps;
    /**
     * A projecao de acesso, fiada pela costura: contage de sockets ativos do
     * proxy + sessoes vivas com os metadados de acesso.
     */
    readonly acesso: () => UiAcessoBruto;
    /**
     * O servico de AGENTES (o dispatcher da Onda 4), fiado pela costura em
     * `src/index.ts`. A fonte e o REGISTRY do HOST em memoria (a MESMA do
     * `agent.report`) — a superficie so lista e cancela; o `cancelar` reduz
     * exposicao e por isso dispensa nonce (so CSRF).
     */
    readonly agentsOps: UiAgentOps;
}
/** A origem que o audit log escreve para esta superficie (03-ONDAS 10, item 7). */
export declare const UI_REQUESTED_BY = "ui:native";
/**
 * Monta a superficie: as rotas (incl. o GET /api/csrf de HIGH-2) + assinatura
 * do broadcast, e devolve o disposer que reverte TUDO (rotas removidas;
 * assinatura cancelada). Disposer SINCRONO e idempotente (LIFE-003/005).
 */
export declare function createNativeUiSurface(deps: UiContribDeps): () => void;
/** Tipos fiados da superficie para a costura (que os injeta nos deps). */
export type { EstadoDoToken, FonteDoToken, RegistroAcessoBruto, UiAcessoBruto, UiAgentOps, UiPrivacidade, UiPairOps, UiTokenOps, } from './routes.ts';
//# sourceMappingURL=surface.d.ts.map