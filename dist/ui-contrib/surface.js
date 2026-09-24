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
import { createCsrfGuard } from "./csrf.js";
import { createAccessHandler, createAgentsCancelHandler, createAgentsHandler, createConfirmHandler, createCsrfHandler, createPrivacidadeHandler, createPairHandler, createPairStateHandler, createResetConfirmHandler, createResetHandler, createStartHandler, createStateHandler, createStopHandler, createTelegramClickHandler, createTelegramHandler, createTokenHandler, createTokenStateHandler, UI_PATH_ACCESS, UI_PATH_AGENTS, UI_PATH_CONFIRM, UI_PATH_CSRF, UI_PATH_PRIVACIDADE, UI_PATH_PAIR, UI_PATH_PAIR_STATE, UI_PATH_RESET, UI_PATH_RESET_CONFIRM, UI_PATH_START, UI_PATH_STATE, UI_PATH_STOP, UI_PATH_TELEGRAM, UI_PATH_TELEGRAM_CLICK, UI_PATH_TOKEN, UI_PATH_TOKEN_STATE, } from "./routes.js";
import { createUlidFactory } from "./ulid.js";
/** A origem que o audit log escreve para esta superficie (03-ONDAS 10, item 7). */
export const UI_REQUESTED_BY = 'ui:native';
/**
 * Monta a superficie: as rotas (incl. o GET /api/csrf de HIGH-2) + assinatura
 * do broadcast, e devolve o disposer que reverte TUDO (rotas removidas;
 * assinatura cancelada). Disposer SINCRONO e idempotente (LIFE-003/005).
 */
export function createNativeUiSurface(deps) {
    let lastSeq = -1;
    let lastSnapshot;
    let lastReady;
    const ouvir = (broadcast) => {
        if (broadcast.seq <= lastSeq)
            return; // fora de ordem: descartada
        lastSeq = broadcast.seq;
        lastSnapshot = broadcast.snapshot;
        if (broadcast.snapshot.state === 'READY' && broadcast.snapshot.expiresAt !== undefined) {
            lastReady = { expiresAt: broadcast.snapshot.expiresAt };
        }
    };
    const unsub = deps.subscribe(ouvir);
    const csrf = createCsrfGuard({ clock: { now: deps.now } });
    const requestId = createUlidFactory(deps.now);
    const requestedBy = deps.requestedBy ?? UI_REQUESTED_BY;
    const core = {
        projection: () => lastSnapshot,
        seq: () => lastSeq,
        lastReady: () => lastReady,
        botState: deps.botState,
        provider: deps.provider,
        tokenOps: deps.tokenOps,
        pairOps: deps.pairOps,
        acesso: deps.acesso,
        agentsOps: deps.agentsOps,
        csrf,
        now: deps.now,
        requestedBy,
        requestId,
        issueNonce: deps.issueNonce,
        emit: deps.emit,
    };
    const rotas = [
        { kind: 'exact', path: UI_PATH_STATE, handler: createStateHandler(core) },
        { kind: 'exact', path: UI_PATH_START, handler: createStartHandler(core) },
        { kind: 'exact', path: UI_PATH_CONFIRM, handler: createConfirmHandler(core) },
        { kind: 'exact', path: UI_PATH_STOP, handler: createStopHandler(core) },
        // W3 (revisao T5.5): FAILED so sai por reset humano (CTL-012) — a
        // terceira superficie ganha o MESMO padrao de 2 etapas com nonce.
        { kind: 'exact', path: UI_PATH_RESET, handler: createResetHandler(core) },
        { kind: 'exact', path: UI_PATH_RESET_CONFIRM, handler: createResetConfirmHandler(core) },
        // O botao Telegram: estado (GET) e clique (POST com CSRF).
        { kind: 'exact', path: UI_PATH_TELEGRAM, handler: createTelegramHandler(core) },
        { kind: 'exact', path: UI_PATH_TELEGRAM_CLICK, handler: createTelegramClickHandler(core) },
        // O painel de configuracao do token (POST com CSRF) e o estado sem valor.
        { kind: 'exact', path: UI_PATH_TOKEN, handler: createTokenHandler(core) },
        { kind: 'exact', path: UI_PATH_TOKEN_STATE, handler: createTokenStateHandler(core) },
        // A privacidade AO VIVO do bot (GET): getMe real decide se ha @username.
        { kind: 'exact', path: UI_PATH_PRIVACIDADE, handler: createPrivacidadeHandler(core) },
        // O pareamento VIA PAINEL: gerar codigo (POST com CSRF) + estado (GET).
        { kind: 'exact', path: UI_PATH_PAIR, handler: createPairHandler(core) },
        { kind: 'exact', path: UI_PATH_PAIR_STATE, handler: createPairStateHandler(core) },
        // As metricas de acesso (GET, so leitura).
        { kind: 'exact', path: UI_PATH_ACCESS, handler: createAccessHandler(core) },
        // Os AGENTES (Onda 6): a lista (GET, exact) e o cancelamento (POST com
        // CSRF — PREFIXO no MESMO caminho: o id curto do run vive no segmento, e
        // o despacho do host so consulta prefixos depois de falhar a tabela
        // exact, logo o GET da lista nunca cai no cancelamento).
        { kind: 'exact', path: UI_PATH_AGENTS, handler: createAgentsHandler(core) },
        { kind: 'prefix', path: UI_PATH_AGENTS, handler: createAgentsCancelHandler(core) },
        // O token anti-CSRF fresco para o bundle (HIGH-2) — GET, so le. Sempre
        // registado: e o que o bundle novo usa em cada POST por fora do meta antigo.
        { kind: 'exact', path: UI_PATH_CSRF, handler: createCsrfHandler(core) },
    ];
    const rotaDisposers = [];
    try {
        for (const rota of rotas)
            rotaDisposers.push(deps.registerRoute(rota));
    }
    catch (error) {
        // Registo parcial (ex.: colisao de rota): reverte o que ja entrou, em
        // LIFO, antes de propagar — nunca deixar meia contribuicao no host.
        for (let i = rotaDisposers.length - 1; i >= 0; i -= 1) {
            const disposer = rotaDisposers[i];
            if (disposer !== undefined)
                disposer();
        }
        unsub();
        throw error;
    }
    let desmontado = false;
    return () => {
        if (desmontado)
            return; // idempotente (LIFE-003)
        desmontado = true;
        for (let i = rotaDisposers.length - 1; i >= 0; i -= 1) {
            const disposer = rotaDisposers[i];
            if (disposer !== undefined)
                disposer();
        }
        unsub();
    };
}
//# sourceMappingURL=surface.js.map