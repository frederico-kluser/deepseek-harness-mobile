/**
 * As rotas HTTP da superficie de UI nativa e os seus handlers.
 *
 * O PREFIXO E IRMAO DE `/__guard`, NAO FILHO: `/__guard` e do painel (D5,
 * T3.4 -> T5.3), que o registara como rota `prefix` — um caminho como
 * `/__guard/ui/...` seria engolido pelo despachante do painel e responderia
 * 404 por tabela. `/__guard-ui` e um SEGMENTO distinto: o `match` do host so
 * casa `p` e `p/<algo>` (medido no spike S4), logo nao colide — e a barreira
 * de autenticacao (L3) guarda-o por omissao, sem isencao nenhuma.
 *
 * A COSTURA da Onda 5 acrescentou o RESET (W3: FAILED so sai por reset
 * humano, CTL-012) com o MESMO padrao de 2 etapas com nonce do LIGAR:
 * `POST /__guard-ui/api/reset` (passo 1, emite o nonce) e
 * `POST /__guard-ui/api/reset/confirm` (passo 2, emite o intent reset).
 * As quatro originais:
 *
 *   GET  /__guard-ui/api/state         — a PROJECCAO: seq + estado + URL (so
 *                                        READY) + expiracao + falha + nota de
 *                                        TTL. E o que o bundle da aba
 *                                        settings poe no DOM por
 *                                        `textContent`.
 *   POST /__guard-ui/api/start         — passo 1 do LIGAR: pede o nonce ao
 *                                        HOST (T5.1) e devolve-o opaco.
 *   POST /__guard-ui/api/start/confirm — passo 2: emite o `ControlIntent`
 *                                        `start` com o nonce transportado
 *                                        opaco; quem valida e o host (S5).
 *   POST /__guard-ui/api/stop          — DESLIGAR: emite `stop` SEM nonce
 *                                        (CTL-024: acao que reduz exposicao).
 *
 * DUAS rotas do Telegram (OFELINE/ONLINE), acrescidas para o botao da UI:
 *   GET  /__guard-ui/api/telegram      — o estado do bot: `online`+`provider`
 *                                        +`motivo` (offline) ou `online`
 *                                        +`provider`+`handle` (online). O
 *                                        disco e lido pela costura a cada
 *                                        pedido; o token NUNCA sai.
 *   POST /__guard-ui/api/telegram/click — o clique no botao: devolve o TEXTO
 *                                        das instrucoes (conectar se offline,
 *                                        uso se online). Exige CSRF, como todo
 *                                        POST desta superficie.
 *   GET  /__guard-ui/api/csrf       — um token anti-CSRF FRESCO para o bundle
 *                                        (HIGH-2): a UNICA fonte de CSRF da
 *                                        superficie, que o painel da aba
 *                                        settings usa em cada POST.
 *
 * DUAS rotas dos AGENTES (Onda 6 — o painel espelha /agentes e /parar-agente):
 *   GET  /__guard-ui/api/agents     — a lista de runs do dispatcher (id, skill,
 *                                        status, startedAt, summary). A fonte e
 *                                        o REGISTRY do HOST em memoria (a MESMA
 *                                        do `agent.report`), fiado pela costura
 *                                        via `agentsOps` — esta superficie NUNCA
 *                                        toca no canal IPC.
 *   POST /__guard-ui/api/agents/:id/cancel — cancela um run pelo id CURTO (8
 *                                        chars). REDUZ exposicao (CTL-024, o
 *                                        mesmo do STOP): CSRF basta, NAO exige
 *                                        nonce. Id desconhecido/ja terminal =
 *                                        noop idempotente (o mesmo do
 *                                        `agent.cancel` do IPC). Regista como
 *                                        rota PREFIXO no MESMO caminho da lista
 *                                        (o id vive no segmento do caminho); o
 *                                        despacho do host so consulta prefixos
 *                                        depois de falhar a tabela exact, logo
 *                                        o GET da lista nunca cai aqui.
 *
 * Toda rota POST exige o token anti-CSRF desta superficie (cabecalho
 * `x-dsh-csrf` ou campo `csrf` do corpo) — doutrina NIST SP 800-63B-4 5.1.1.
 * O metodo errado responde 405 (o despacho do host e por caminho, nao por
 * metodo; quem responde ao pedido e este handler).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlAction, ControlIntent, ControlResultado, Nonce } from '../contracts/control.ts';
import type { AgentRunReport } from '../contracts/ipc.ts';
import type { TunnelSnapshot } from '../contracts/tunnel.ts';
import { type CsrfGuard } from './csrf.ts';
import { type BotEstado } from './bot-state.ts';
export declare const UI_PREFIX = "/__guard-ui";
export declare const UI_PATH_STATE = "/__guard-ui/api/state";
export declare const UI_PATH_START = "/__guard-ui/api/start";
export declare const UI_PATH_CONFIRM = "/__guard-ui/api/start/confirm";
export declare const UI_PATH_STOP = "/__guard-ui/api/stop";
export declare const UI_PATH_RESET = "/__guard-ui/api/reset";
export declare const UI_PATH_RESET_CONFIRM = "/__guard-ui/api/reset/confirm";
/** O estado Telegram OFFLINE/ONLINE — GET, so le. NUNCA carrega o token. */
export declare const UI_PATH_TELEGRAM = "/__guard-ui/api/telegram";
/** O clique no botao Telegram — POST, CSRF como as demais escritas. */
export declare const UI_PATH_TELEGRAM_CLICK = "/__guard-ui/api/telegram/click";
/** O token do bot, configurado VIA INTERFACE — POST, CSRF como as demais. */
export declare const UI_PATH_TOKEN = "/__guard-ui/api/token";
/** O estado do token (configurado/handle/fonte), SEM o valor — GET. */
export declare const UI_PATH_TOKEN_STATE = "/__guard-ui/api/token-state";
/**
 * A privacidade do bot AO VIVO (GET): o `getMe` real decide se o bot tem
 * `@username` (encontrável na busca) ou não. GET sem CSRF, como as demais
 * leituras. NUNCA transporta o token.
 */
export declare const UI_PATH_PRIVACIDADE = "/__guard-ui/api/privacidade";
/** Quem/quanto esta a acessar (sessoes e conexoes do proxy) — GET. */
export declare const UI_PATH_ACCESS = "/__guard-ui/api/access";
/**
 * O token anti-CSRF FRESCO para o bundle — GET, so le. Nao exige CSRF (e uma
 * leitura, como as demais GETs) e NUNCA transporta credencial: o valor emitido
 * e o mesmo token stateless do guard da superficie que os POSTs verificam
 * (`core.csrf.verify(token, UI_CSRF_BINDING)`).
 */
export declare const UI_PATH_CSRF = "/__guard-ui/api/csrf";
/** Inicia o pareamento pelo painel — POST, CSRF como as demais escritas. */
export declare const UI_PATH_PAIR = "/__guard-ui/api/pair";
/** O estado do pareamento (pareado? handle? código ativo) — GET, só leitura. */
export declare const UI_PATH_PAIR_STATE = "/__guard-ui/api/pair-state";
/**
 * O bloco de AGENTES (Onda 6): a MESMA string serve as DUAS rotas —
 * `GET /__guard-ui/api/agents` (exact, a lista) e
 * `POST /__guard-ui/api/agents/<id>/cancel` (PREFIXO no mesmo caminho: o id
 * curto do run vive no segmento; o despacho do host so consulta prefixos
 * depois de falhar a tabela exact, logo a lista nunca cai no cancelamento).
 */
export declare const UI_PATH_AGENTS = "/__guard-ui/api/agents";
/** O vinculo do token anti-CSRF: a superficie inteira. */
export declare const UI_CSRF_BINDING = "ui-contrib";
export declare const NOTA_TTL_EXPIRADO = "TTL expirado";
export type UiContribRequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export interface UiContribRoute {
    /**
     * O MESMO union do host (`WebRouteKind`): `exact` casa o caminho verbatim;
     * `prefix` casa `p` e `p/<algo>` (usado pelo cancelamento de agentes, cujo
     * id curto vive no segmento do caminho).
     */
    readonly kind: 'exact' | 'prefix';
    readonly path: string;
    readonly handler: UiContribRequestHandler;
}
/**
 * O provedor de mensageria ATIVO — o MESMO union de `src/proc/env.ts`
 * (`ProviderId`), mantido aqui porque a superficie NAO importa `src/proc/**`
 * (regra de isolamento do mapa de importacoes). A costura em `src/index.ts`
 * passa o `ProviderId` real — estruturalmente identico.
 */
export type ProviderDoBot = 'telegram';
/**
 * O nucleo da superficie: tudo o que os handlers precisam, injetado por
 * `createNativeUiSurface` (que por sua vez recebe de quem fia a superficie em
 * `src/index.ts`). Os handlers nunca tocam na API do DSH nem no supervisor.
 */
export interface UiContribCore {
    /** A ultima projecao que o broadcast entregou; `undefined` antes da 1.ª. */
    readonly projection: () => TunnelSnapshot | undefined;
    /** O ultimo `seq` visto (difusoes fora de ordem sao descartadas antes). */
    readonly seq: () => number;
    /** A ultima expiracao READY vista — a base da nota de TTL. */
    readonly lastReady: () => {
        readonly expiresAt: number;
    } | undefined;
    /**
     * O estado do BOT OFFLINE/ONLINE, lido do disco a cada pedido pela costura
     * em `src/index.ts` (config.worker.token/secrets.env + state.json pairing).
     * So boleanos e motivos; o token NUNCA passa por aqui.
     */
    readonly botState: () => BotEstado;
    /**
     * O PROVEDOR de mensageria ATIVO, fiado pela costura em `src/index.ts`
     * (`config.worker.provider ?? DEFAULT_PROVIDER`). Sai no corpo do
     * GET /__guard-ui/api/telegram para o painel rotular o onboarding por
     * provedor — o cliente cai no default 'telegram' sem este campo.
     */
    readonly provider: ProviderDoBot;
    /**
     * Operacoes do panel de token, fiadas pela costura em `src/index.ts`. So
     * chegam aqui como servico injetado (validar/sondar/gravar/estado) — este
     * modulo nao importa `src/telegram/**` nem `bin/**`, e o token NUNCA e
     * logado nem ecoado por este modulo.
     */
    readonly tokenOps: UiTokenOps;
    /**
     * Operacoes do pareamento VIA PAINEL, fiadas pela costura em `src/index.ts`.
     * O codigo de 6 digitos NUNCA chega a log por este modulo — a costura o gera
     * com `criarSessaoDePareamento` e so o devolve na resposta de `gerar()`.
     */
    readonly pairOps: UiPairOps;
    /**
     * Projecao de acesso, fiada pela costura: a contagem de sockets ativos do
     * proxy do tunel e a lista de sessoes vivas, ja com os metadados de acesso.
     */
    readonly acesso: () => UiAcessoBruto;
    /**
     * Operacoes dos AGENTES (o dispatcher da Onda 4), fiadas pela costura em
     * `src/index.ts`. A fonte e o REGISTRY do HOST em memoria — a MESMA do
     * `agent.report` do IPC; este modulo nunca toca no canal. O `cancelar`
     * REDUZ exposicao (mata um run), por isso a rota dispensa nonce (CSRF so).
     */
    readonly agentsOps: UiAgentOps;
    readonly csrf: CsrfGuard;
    readonly now: () => number;
    readonly requestedBy: string;
    readonly requestId: () => string;
    readonly issueNonce: (action: ControlAction) => Nonce;
    readonly emit: (intent: ControlIntent) => Promise<ControlResultado>;
}
/**
 * Onde vive o token do bot, para o `token-state` — SEM o valor. `env` = o
 * `config.worker.token` (o host injeta-o por ambiente); `secrets` = o
 * `secrets.env` gravado pelo CLI ou por esta rota.
 */
export type FonteDoToken = 'env' | 'secrets' | 'nenhum';
/** O estado do token que a interface mostra — nunca o valor. */
export interface EstadoDoToken {
    readonly configurado: boolean;
    /** O `@handle`, quando o `getMe` o confirmou. Ausente = `null`. */
    readonly handle?: string | null | undefined;
    readonly fonte: FonteDoToken;
}
/**
 * A checagem AO VIVO de descoberta (cartão "Privacidade"). `ok:true` com
 * `handle` = o bot TEM `@username` (encontrável na busca); `ok:true` com
 * `handle === null` = o `getMe` REAL confirmou que o bot NÃO tem `@username`
 * (genuinamente não encontrável). `ok:false` = o `getMe` falhou (rede/token
 * revogado) — NUNCA inventa estado. O valor do token nunca sai no corpo.
 */
export type UiPrivacidade = {
    readonly ok: true;
    readonly handle: string | null;
    readonly fonte: FonteDoToken;
} | {
    readonly ok: false;
    readonly erro: 'indisponivel';
};
/**
 * O servico de configuracao do token fiado a superficie. Cada operacao e
 * executada pela costura em `src/index.ts` (que detem `config`, `statePaths` e
 * o supervisor do worker); este modulo so orquestra o HTTP.
 */
export interface UiTokenOps {
    /** Formato `<id numerico>:<segredo>` SEM rede (reusa `validarFormatoDoToken`). */
    readonly validarFormato: (bruto: string) => boolean;
    /**
     * A FONTE EFETIVA do token configurado no momento. `'env'` significa que o
     * `config.worker.token` (variavel TELEGRAM_BOT_TOKEN do ambiente) tem
     * PRECEDENCIA sobre o `secrets.env` — neste estado, gravar em `secrets.env`
     * nao muda o bot ate o env mudar. `'secrets'` = o ficheiro e a fonte vigente.
     *
     * O handler usa isto ANTES de sondar/gravar: com a fonte `'env'`, a rota
     * recusa (409 `token-por-env`) em vez de escrever um token que o env vai
     * continuar a sombrear — transparencia, nao mentira.
     */
    readonly fonte: () => FonteDoToken;
    /**
     * `getMe` na rede. `ok:true` traz o `@handle`. O token NUNCA volta nesta
     * resposta; `erro` e uma causa acionavel, nunca o token. NAO tem efeito
     * lateral no estado do token (o handle so e "committed" em `gravar`).
     */
    readonly sondar: (token: string) => Promise<{
        readonly ok: true;
        readonly handle: string;
    } | {
        readonly ok: false;
        readonly erro: string;
    }>;
    /**
     * Grava em `secrets.env` (0600, atomico), reinicia o worker com o token novo
     * e grava o `handle` lembrado pelo token-state — SO SOB SUCESSO. Na falha
     * (excecao), NADA muda: nem a escrita, nem o handle lembrado.
     */
    readonly gravar: (token: string, handle: string) => void;
    /** Estado do token (fonte+handle) para o `token-state`; le o disco a cada chamada. */
    readonly estado: () => EstadoDoToken;
    /**
     * Checagem AO VIVO de descoberta (cartão "Privacidade"): resolve o token
     * EFETIVO (env → secrets.env) e faz `getMe` na rede para saber se o bot tem
     * `@username`. `handle` `null` = o bot NÃO tem `@username`; `ok:false` = o
     * `getMe` falhou. Com `forcar` (do botão "Verificar de novo"), contorna o
     * cache curto; sem ele, serve um resultado cacheado de ~30s para não bater
     * `getMe` a cada poll do painel. O token nunca é logado nem devolvido.
     */
    readonly privacidade: (forcar?: boolean) => Promise<UiPrivacidade>;
}
/**
 * O servico de PAREAMENTO VIA PAINEL fiado a superficie. Cada operacao e
 * executada pela costura em `src/index.ts` (que detem `config`, `statePaths`,
 * o supervisor do worker e a sessao de pareamento em memoria); este modulo so
 * orquestra o HTTP. O CODIGO DE 6 DIGITOS NUNCA e logado nem viaja para o
 * Telegram — so existe no host (memoria) e na resposta a `gerar()`.
 */
export interface UiPairOps {
    /**
     * O estado do pareamento para o `pair-state`: `pareado` + o `@handle` do bot
     * (lido do token-state). Enquanto houver uma sessao de pareamento VIVA em
     * memoria, devolve o `codigo` (por re-exibicao no refresh) e o `expiraEm`.
     */
    readonly estado: () => {
        readonly pareado: boolean;
        readonly handle?: string | undefined;
        readonly codigo?: string | undefined;
        readonly expiraEm?: number | undefined;
    };
    /**
     * Gera UM codigo de pareamento novo e envia o `pairing.challenge` ao worker.
     * Devolve `{ok:true,codigo,expiraEm}` (o unico sitio onde o claro existe fora
     * do host) ou `{ok:false,erro}` com uma CAUSA acionavel, NUNCA o codigo.
     */
    readonly gerar: () => Promise<{
        readonly ok: true;
        readonly codigo: string;
        readonly expiraEm: number;
    } | {
        readonly ok: false;
        readonly erro: 'ja-pareado' | 'sem-token' | 'worker-indisponivel' | 'interno';
    }>;
}
/**
 * O servico de AGENTES fiado a superficie. Cada operacao e executada pela
 * costura em `src/index.ts` (que detem o `AgentRegistry` do host — o mesmo
 * dispatcher que alimenta o `agent.report`); este modulo so orquestra o HTTP.
 * O run e EFEMERO por desenho (vive em memoria; um reinicio do DSH derruba-o),
 * e o `summary` e texto do MODELO — nunca segredo (S3: o request do agente nao
 * recebe token nem credencial, logo o que ele devolve nao pode conter segredo).
 */
export interface UiAgentOps {
    /**
     * A lista COMPLETA dos runs em memoria (vivos + terminais) — a MESMA fonte
     * do `agent.report` do IPC. O registry ja capou o historico e o `summary`;
     * esta superficie apenas a reexpede, sem tocar em nada.
     */
    readonly listar: () => readonly AgentRunReport[];
    /**
     * Cancela um run pelo id CURTO (8 caracteres). `false` = id desconhecido ou
     * run ja terminal — noop idempotente, nunca um erro (o mesmo do
     * `agent.cancel` do IPC: `accepted`/`noop`, nunca um `error`).
     */
    readonly cancelar: (agentId: string) => boolean;
}
/** Uma sessao viva, ja redigida, com os metadados de acesso capturados. */
export interface RegistroAcessoBruto {
    readonly hash: string;
    readonly criadaEm: number;
    readonly ultimoUsoEm: number;
    readonly userAgent?: string | undefined;
    readonly ip?: string | undefined;
}
/** A fonte de dados do `/api/access`, montada pela costura. */
export interface UiAcessoBruto {
    /** Sockets ativos do lado cliente do proxy do tunel (a fonte de `totalConexoes`). */
    readonly conexoesAtivas: number;
    /** Sessoes vivas no `SessionStore`. */
    readonly totalSessoes: number;
    /** As sessoes vivas, redigidas. */
    readonly sessoes: ReadonlyArray<RegistroAcessoBruto>;
    /** `true` sse o IP da borda e confiavel agora (`exposure.trustEdgeHeaders`). */
    readonly ipConfiavel: boolean;
}
export interface EstadoProjetado {
    readonly seq: number;
    /** O estado em ingles, vocabulario do contrato; o rotulo PT e do cliente. */
    readonly estado: TunnelSnapshot['state'];
    readonly tentativas: number;
    /** Presente sse `estado === 'READY'`. */
    readonly url?: string | undefined;
    /** Epoch ms em que o TTL expira. Presente sse `estado === 'READY'`. */
    readonly expiraEm?: number | undefined;
    readonly falha: {
        readonly codigo: string;
        readonly mensagem: string;
    } | null;
    /** A nota de TTL expirado, quando a projecao a pode afirmar. */
    readonly nota: string | null;
}
/**
 * Projeta o estado para o corpo da rota. Funcao PURA e exportada: e o coracao
 * da pergunta falsificavel "a URL aparece antes de READY?" — aqui ela nunca
 * sai, mesmo que o snapshot a traga por defeito do supervisor.
 */
export declare function projetarEstado(input: {
    readonly seq: number;
    readonly snapshot: TunnelSnapshot;
    readonly lastReady: {
        readonly expiresAt: number;
    } | undefined;
    readonly now: number;
}): EstadoProjetado;
export declare function createStateHandler(core: UiContribCore): UiContribRequestHandler;
export declare function createStartHandler(core: UiContribCore): UiContribRequestHandler;
export declare function createConfirmHandler(core: UiContribCore): UiContribRequestHandler;
export declare function createStopHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Passo 1 do RESET: emite o nonce para a acao 'reset' no HOST e devolve-o
 * opaco (S5) — o mesmo padrao do LIGAR. A rota so faz sentido em FAILED; em
 * qualquer outro estado o controlador responde noop no passo 2.
 */
export declare function createResetHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Passo 2 do RESET: emite o `ControlIntent` reset com o nonce transportado
 * opaco. Quem valida e o HOST (S5); em FAILED com nonce valido, o controlador
 * transita FAILED -> STOPPED e difunde (CTL-036).
 */
export declare function createResetConfirmHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Projeta o estado do bot para a rota GET. FUNCAO PURA e exportada: e o
 * coracao da pergunta falsificavel "o token sai nesta resposta?" — o corpo so
 * tem `online`+`provider`+`motivo` (offline) ou `online`+`provider`+`handle`
 * (online); o valor do token e injetado na costura e nunca chega ate aqui.
 */
export declare function projetarEstadoTelegrama(estado: BotEstado, provider: ProviderDoBot): Record<string, unknown>;
/**
 * GET /__guard-ui/api/telegram — o estado OFFLINE/ONLINE. SO LE: o motivo
 * aproximado ("sem pareamento" / "sem chave do bot") quando offline, o estado
 * online quando pronto. O disco e lido pela costura a cada pedido.
 */
export declare function createTelegramHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * POST /__guard-ui/api/telegram/click — o CLIQUE no botao Telegram. E uma
 * ESCRITA (abre o painel de instrucoes), por isso exige o token anti-CSRF da
 * superficie como qualquer outro POST (NIST SP 800-63B-4 5.1.1). Devolve o
 * TEXTO de instrucoes — a rota de conectar (offline) ou dicas de uso (online).
 * O texto nunca traz a chave do bot nem o codigo de pareamento real.
 */
export declare function createTelegramClickHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Projeta o estado do token para a rota GET. FUNCAO PURA e exportada: e o
 * coracao da pergunta falsificavel "o token sai nesta resposta?" — o corpo
 * so tem `configurado`+`handle`+`fonte`; o valor do token nunca entra aqui.
 */
export declare function projetarEstadoToken(estado: EstadoDoToken): Record<string, unknown>;
/**
 * GET /__guard-ui/api/token-state — o estado do token SEM o valor. SO LE; o
 * disco e lido pela costura a cada pedido (`tokenOps.estado`).
 */
export declare function createTokenStateHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Projeta o resultado da checagem de privacidade para a rota GET. FUNCAO PURA
 * e exportada: e o coracao das perguntas falsificaveis "o token sai nesta
 * resposta?" e "o `ok:false` nao vira verde?" — o corpo so tem
 * `ok`+`handle`+`fonte`; o valor do token nunca entra aqui.
 */
export declare function projetarPrivacidade(resultado: UiPrivacidade): Record<string, unknown>;
/**
 * GET /__guard-ui/api/privacidade — a privacidade do bot AO VIVO. SO LE (GET
 * sem CSRF, como as demais): a costura resolve o token efetivo e faz `getMe`
 * para decidir se o bot tem `@username`. `handle:null` = bot SEM username
 * (não encontrável); `ok:false` = getMe falhou (nunca inventa estado). O
 * `forcar:true` na query contorna o cache curto da costura (botão "Verificar
 * de novo"). NUNCA devolve nem loga o token.
 */
export declare function createPrivacidadeHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * POST /__guard-ui/api/token — configura o token do bot VIA INTERFACE.
 *
 * Fluxo (a ordem e contrato — TG-061: FORMATO antes de rede, e a fonte antes
 * de TUDO quando o env manda):
 *   - corpo vazio/token em branco -> 400 `{ok:false,erro:'token-vazio'}`;
 *   - a fonte EFETIVA e `'env'` (variavel TELEGRAM_BOT_TOKEN a mandar) -> 409
 *     `{ok:false,erro:'token-por-env', aviso}`, SEM sondar nem gravar: um token
 *     gravado em `secrets.env` nao mudaria o bot enquanto o env o sombrear;
 *   - formato `<id>:<segredo>` invalido (SEM rede) -> 400
 *     `{ok:false,erro:'formato-invalido'}`;
 *   - `getMe` na rede recusa o token -> 422 `{ok:false,erro:'token-invalido'}`;
 *   - token aceito -> grava em `secrets.env` (0600, atomico), reinicia o
 *     worker com ele e devolve 200 `{ok:true,handle,fonte:'secrets'}`.
 *
 * A FONTE da resposta 200 casa SEMPRE com a que o `/token-state` reporta
 * depois: quando e `'env'` nao se chega a gravar (409), logo so responde 200
 * com `fonte:'secrets'`.
 *
 * NUNCA ecoa o token nem o loga: o corpo so devolve `ok`+`handle`. Exige o
 * token anti-CSRF como qualquer POST da superficie (NIST SP 800-63B-4 5.1.1).
 */
export declare function createTokenHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Projeta a lista de sessoes para a rota GET. FUNCAO PURA e exportada: e o
 * coracao das perguntas falsificaveis "o ?key ou o id em claro saem aqui?" e
 * "o ip vaza quando nao e confiavel?" — o corpo so tem hashes e metadados.
 */
export declare function projetarAcesso(bruto: UiAcessoBruto): Record<string, unknown>;
/**
 * GET /__guard-ui/api/access — quem/quanto esta a acessar. SO LE. Aglutina a
 * contagem de sockets ativos do PROXY do tunel (a fonte de `totalConexoes`/
 * `conexoesAtivas`) e a projecao das sessoes vivas do `SessionStore`. Um
 * endpoint de METADADOS de quem acessa: atras da MESMA barreira (loopback/tunel
 * autenticado) e sem nunca expor a `?key`-nem o id de sessao em claro.
 */
export declare function createAccessHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * GET /__guard-ui/api/pair-state — o estado do pareamento. SO LE: corpo com
 * `pareado` + `handle?` (lido do token-state), e `codigo`/`expiraEm` enquanto
 * houver sessao viva em memoria (re-exibicao no refresh). NUNCA vaza o token.
 */
export declare function createPairStateHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * POST /__guard-ui/api/pair — inicia o pareamento pelo painel.
 *
 * Exige CSRF como qualquer POST desta superficie (NIST SP 800-63B-4 5.1.1).
 * A costura (`core.pairOps.gerar`) gera o codigo com `criarSessaoDePareamento`,
 * envia o digest (`pairing.challenge`) ao worker e guarda a sessao em memoria.
 * Sucesso -> 200 `{codigo, expiraEm}`; ja-pareado/sem-token/worker-indisponivel
 * -> 409 `{erro}` (mensagem amigavel PT-BR); o resto -> 500 `{erro:'interno'}`.
 * O CODIGO NUNCA sai para log: so nesta resposta.
 */
export declare function createPairHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Projeta a lista de runs para o corpo da rota. FUNCAO PURA e exportada: e o
 * coracao da pergunta falsificavel "o corpo da rota e EXATAMENTE o estado do
 * registry do host?" — cada campo do `AgentRunReport` passa tal qual (o
 * registry ja capou o `summary` em 300 chars e o historico em 32 runs), o
 * vazio e `runs: []` (o painel mostra «Nenhum agente rodando.»), e nenhum
 * campo a mais entra no corpo.
 */
export declare function projetarAgentes(runs: readonly AgentRunReport[]): Record<string, unknown>;
/**
 * GET /__guard-ui/api/agents — a lista de runs do dispatcher. SO LE (GET sem
 * CSRF, como as demais leituras): a costura le o registry do HOST em memoria
 * (`agentsOps.listar`) — a MESMA fonte do `agent.report`, nunca o canal IPC.
 */
export declare function createAgentsHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * Extrai o id curto de `POST /__guard-ui/api/agents/<id>/cancel`. FUNCAO PURA
 * e exportada: e o coracao da pergunta falsificavel "o prefixo so conhece a
 * forma /<id>/cancel" — um segmento nao-vazio basta (o id e OPACO para esta
 * superficie; quem o valida e o registry, com noop idempotente). `undefined`
 * = o caminho nao e desta rota (404, nao 405: o prefixo engoliu um pedido que
 * nao e nosso).
 */
export declare function extrairIdDeCancelamentoDeAgente(caminho: string): string | undefined;
/**
 * POST /__guard-ui/api/agents/:id/cancel — cancela um run pelo id CURTO.
 *
 * REDUZ exposicao (mata a execucao) -> dispensa nonce (CTL-024, o mesmo do
 * STOP: em panico, o botao funciona de primeira). Exige o token anti-CSRF da
 * superficie como qualquer POST (NIST SP 800-63B-4 5.1.1). O corpo devolve
 * `{ok}`: `true` = cancelado; `false` = id desconhecido/ja terminal (noop
 * idempotente — o mesmo do `agent.cancel` do IPC, nunca um erro). A rota e
 * PREFIXO no caminho da lista: o id vive no segmento do caminho, e o
 * despacho do host so consulta prefixos depois de falhar a tabela exact.
 */
export declare function createAgentsCancelHandler(core: UiContribCore): UiContribRequestHandler;
/**
 * GET /__guard-ui/api/csrf — emite um token anti-CSRF NOVO para o VINCULO da
 * superficie e devolve-o. E A UNICA fonte de CSRF da superficie (HIGH-2): o
 * painel da aba settings faz um GET barato e stateless a cada escrita, sem
 * nenhum meta de indice envolvido (o chrome injetado na home, que embutia o
 * token num `<meta>`, foi removido).
 *
 * ATRAS DA MESMA BARREIRA (loopback/tunel autenticado) e SEM exigir CSRF — e
 * uma LEITURA, como as outras GETs desta superficie; o token nao e credencial
 * (quem alcanca o servidor consegue emitir um para si), e a extracao por
 * leitura de resposta e exactamente o que o `SameSite`/CORS fecha para o
 * navegador da vitima. O token devolvido e verificavel com o MESMO
 * `core.csrf.verify(token, UI_CSRF_BINDING)` dos POSTs.
 */
export declare function createCsrfHandler(core: UiContribCore): UiContribRequestHandler;
//# sourceMappingURL=routes.d.ts.map