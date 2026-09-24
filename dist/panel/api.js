/**
 * `GET /__guard/`, `GET /__guard/api/state` e `POST /__guard/api/login`.
 *
 * DONO: T3.4 -> T5.3.
 *
 * ------------------------------------------------------------------------
 * PORQUE O ENVELOPE DE RESPOSTA VIVE AQUI
 * ------------------------------------------------------------------------
 * `PanelResponse` e as respostas constantes (404, 403, 413, 500) sao usadas por
 * `magic.ts`, por `secret.ts` e pelo despachante de `routes.ts`. Se vivessem em
 * `routes.ts` -- que e quem as escreve no socket -- o grafo de modulos ficava
 * CICLICO (`routes -> secret -> routes`), e um ciclo com valores (nao apenas
 * tipos) e uma zona morta temporal a espera de acontecer. Vivendo na folha mais
 * baixa que precisa delas, o grafo e um DAG: `csrf`/`html` -> `api` ->
 * `magic`/`secret` -> `routes`.
 *
 * O 404 SER UMA CONSTANTE PARTILHADA E O CONTROLO, E NAO ARRUMACAO. `PANEL-003`
 * e `PANEL-004` exigem que o 404 de rota inexistente e o 404 de
 * `/__guard/secret` sem `ott` sejam BYTE A BYTE iguais. Com dois literais em
 * dois ficheiros, isso e verdade no dia em que se escreve e mentira na primeira
 * vez que alguem melhora uma das mensagens. Com uma constante, e verdade por
 * construcao.
 *
 * ------------------------------------------------------------------------
 * `GET /api/state` NAO RESPONDE NADA ANTES DO LOGIN
 * ------------------------------------------------------------------------
 * O que ele vazaria e a URL DO TUNEL, que e informacao sensivel de operacao: e
 * o endereco publico da maquina do dono, valido enquanto o tunel viver, e quem
 * varre a internet a procura de quick tunnels precisa exatamente disso. A
 * politica esta na tabela de `routes.ts` (`exige-sessao`) e a projecao aqui
 * REPETE a invariante do contrato: `info` so sai em `READY`. Duas camadas para
 * a mesma promessa, porque uma delas vai ser refatorada um dia.
 *
 * ------------------------------------------------------------------------
 * PORQUE `maskAuditText` E NAO `redact` (revisao adversarial, BAIXA)
 * ------------------------------------------------------------------------
 * QUANDO ESTE FICHEIRO FOI ESCRITO, `src/logging/redact.ts` DECLARAVA no proprio
 * cabecalho o que nao cobria: o `mk` do link magico e O URL DO TUNEL. A versao
 * anterior deste ficheiro chamava a `redact()` "o cinto por cima dos
 * suspensorios" -- e era falso: um `failure.message` com o URL do tunel saia
 * INTACTO por `/__guard/api/state`.
 *
 * A costura da Onda 3 fechou essa lacuna na RAIZ (as formas subiram para
 * `SECRET_SHAPES`), mas a chamada continua a ser a `maskAuditText`, porque ela
 * traz TRES formas a mais que so fazem sentido onde o custo de um falso negativo
 * e o bot ou a credencial do dono -- e uma `failure.message` mostrada ao dono no
 * painel e reenviada por Telegram e exatamente esse sitio. Chamar em vez de
 * copiar, porque uma primitiva de mascaramento duplicada e uma primitiva que
 * diverge.
 *
 * O CAMINHO ABSOLUTO, que a revisao tambem apanhou, chegou a viver aqui numa
 * `maskAbsolutePaths` LOCAL, com a nota de que a casa duravel dela era
 * `SECRET_SHAPES`. A costura da Onda 3 promoveu-a: a forma vive agora em
 * `src/logging/redact.ts` -- ja nao ha remendo local, e `maskAuditText` sozinha
 * cobre as tres coisas (URL do tunel, `mk`, `$HOME`).
 *
 * A REGRA DO CAMINHO MUDOU COM A PROMOCAO, e a mudanca e deliberada: o remendo
 * local comia QUALQUER caminho absoluto com tres segmentos, incluindo
 * `/opt/bin/cloudflared` e `/usr/lib/...`, que sao estrutura de sistema e nao
 * identificam ninguem -- destruia a mensagem de erro para nao vazar nada. A
 * forma promovida mascara o `$HOME` e so ele. O JSDoc dela explica porque.
 */
import { maskAuditText } from "../audit/format.js";
import { NOT_FOUND_BODY, TEXT_REFUSAL_HEADERS } from "../http/responses.js";
import { runThrottledAttempt } from "../ratelimit/tracker.js";
import { assertTrustworthyOrigin, serializeSessionCookie } from "../session/cookie.js";
import { newNonce, panelHtmlHeaders, renderPanelPage } from "./html.js";
import { newUlid } from "./ulid.js";
/**
 * IMPORTADO, e nao redeclarado. `src/http/responses.ts` e dono desta lista
 * porque e o outro escritor do MESMO 404: o portao escreve-o direto no
 * `ServerResponse` (`denyNotFound`) quando `/__guard/secret` e alcancado por um
 * canal nao-local, e este ficheiro escreve-o num envelope quando o `ott` e
 * invalido. Duas declaracoes concordavam hoje e divergiam na primeira melhoria
 * de redaccao de uma delas -- foi exatamente o que aconteceu, e foi medido no
 * fio antes de ser corrigido. Ver o JSDoc de `TEXT_REFUSAL_HEADERS`.
 */
const TEXT_HEADERS = TEXT_REFUSAL_HEADERS;
const JSON_HEADERS = Object.freeze({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
});
/**
 * O 404. UM literal, para o repositorio inteiro.
 *
 * O corpo e deliberadamente anodino: sem nome de plugin, sem versao, sem
 * hostname, sem caminho de ficheiro (PANEL-010). Enumerar versao e o primeiro
 * passo de quem procura CVE, e esta e a unica superficie que um scanner anonimo
 * ve com o tunel de pe.
 */
export const NOT_FOUND_RESPONSE = Object.freeze({
    status: 404,
    headers: TEXT_HEADERS,
    // O MESMO literal que `denyNotFound` escreve. Ver `TEXT_REFUSAL_HEADERS`.
    body: NOT_FOUND_BODY,
});
/** CSRF em falta ou invalido. Nao e um oraculo de credencial: nao ha credencial. */
export const FORBIDDEN_RESPONSE = Object.freeze({
    status: 403,
    headers: TEXT_HEADERS,
    body: 'Pedido recusado.\n',
});
export const PAYLOAD_TOO_LARGE_RESPONSE = Object.freeze({
    status: 413,
    headers: TEXT_HEADERS,
    body: 'Pedido grande demais.\n',
});
/**
 * Qualquer excecao nao prevista desagua aqui.
 *
 * O corpo e fixo porque a mensagem do erro pode conter QUALQUER coisa -- e o
 * caminho de login manipula o segredo. Nenhum detalhe de erro atravessa o fio;
 * ele vai para o log, ja redigido.
 */
export const INTERNAL_ERROR_RESPONSE = Object.freeze({
    status: 500,
    headers: TEXT_HEADERS,
    body: 'Erro interno.\n',
});
/**
 * A UNICA resposta que uma credencial recusada produz -- no `login` E no `magic`.
 *
 * `02-SEGURANCA.md` 6.1: segredo errado, segredo certo sem conta provisionada,
 * corpo malformado e campo ausente TEM de ser indistinguiveis. Uma constante
 * unica torna isso verdade por construcao -- nao ha um segundo literal onde
 * introduzir a diferenca. Sem `Retry-After`, sem `429`, sem contagem: qualquer
 * um deles diria ao atacante quanto do orcamento ja gastou.
 *
 * PARTILHADA COM `magic.ts` DE PROPOSITO: `mk` expirado, `mk` ja gasto e `mk`
 * malformado tambem sao a mesma resposta, e tambem sao a mesma resposta que um
 * segredo errado. Tres razoes distintas, uma unica saida observavel.
 */
export const CREDENTIAL_DENIED_RESPONSE = Object.freeze({
    status: 401,
    headers: JSON_HEADERS,
    body: '{"ok":false}\n',
});
export const OK_JSON_RESPONSE = Object.freeze({
    status: 200,
    headers: JSON_HEADERS,
    body: '{"ok":true}\n',
});
/* ========================================================================== */
/* 2. Corpo do pedido -- entrada hostil                                       */
/* ========================================================================== */
/**
 * Teto do corpo aceite num `POST` do painel.
 *
 * Os corpos reais sao dois campos curtos (`segredo`+`csrf`, `mk`+`csrf`). 4 KiB
 * e folga generosa e ao mesmo tempo o que impede que um `POST` sem fim consuma
 * memoria do processo que hospeda o DSH inteiro.
 */
export const MAX_BODY_BYTES = 4096;
const EMPTY_FIELDS = new Map();
/** Devolve o mapa vazio partilhado -- nunca `undefined`, nunca `null`. */
export function emptyFields() {
    return EMPTY_FIELDS;
}
function contentTypeOf(req) {
    const raw = req.headers['content-type'];
    if (typeof raw !== 'string')
        return '';
    const semicolon = raw.indexOf(';');
    return (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim().toLowerCase();
}
function fieldsFromJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, reason: 'malformed' };
    }
    const fields = new Map();
    for (const [key, value] of Object.entries(parsed)) {
        // So primitivas. Um objeto aninhado nao tem forma escalar e converte-lo
        // produziria `[object Object]` como se fosse um valor legitimo.
        if (typeof value === 'string')
            fields.set(key, value);
        else if (typeof value === 'number' || typeof value === 'boolean')
            fields.set(key, String(value));
    }
    return { ok: true, fields };
}
/**
 * Le e decompoe o corpo, com teto de bytes.
 *
 * O teto e verificado A MEDIDA QUE OS PEDACOS CHEGAM, e nao no fim: verificar
 * no fim significa ter aceitado tudo primeiro, que e precisamente o que o teto
 * existe para impedir.
 */
export async function readRequestBody(req, limitBytes = MAX_BODY_BYTES) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        total += buffer.length;
        if (total > limitBytes)
            return { ok: false, reason: 'too-large' };
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const contentType = contentTypeOf(req);
    if (contentType === 'application/x-www-form-urlencoded') {
        const fields = new Map();
        // `URLSearchParams` aceita chaves repetidas; fica a PRIMEIRA. Ficar com a
        // ultima deixaria um atacante anexar `&csrf=<valido>` a um corpo alheio.
        for (const [key, value] of new URLSearchParams(text)) {
            if (!fields.has(key))
                fields.set(key, value);
        }
        return { ok: true, fields };
    }
    if (contentType === 'application/json')
        return fieldsFromJson(text);
    return { ok: false, reason: 'unsupported' };
}
/* ========================================================================== */
/* 3. Auditoria -- a torneira que a revisao adversarial encontrou aberta      */
/* ========================================================================== */
/**
 * Quanto tempo de SILENCIO fecha uma rajada.
 *
 * Nao e uma janela deslizante: enquanto as recusas continuarem a chegar, a
 * rajada e A MESMA e a contagem nao reinicia. So um intervalo inteiro sem uma
 * unica recusa abre rajada nova. A diferenca decide o limite: com janela
 * deslizante, um atacante ganha `log2(N)` linhas A CADA janela e o ficheiro
 * volta a crescer sem fim; assim, ganha `log2(N)` linhas NO TOTAL.
 */
export const AUDIT_BURST_QUIET_MS = 5 * 60 * 1000;
export function createAuditGate(deps) {
    const quietMs = deps.quietMs ?? AUDIT_BURST_QUIET_MS;
    // Estado por TIPO de evento, e nao por identidade: sob tunel toda a gente e
    // `127.0.0.1` e `Identity.ip` vem `undefined` (spike S2), logo contar por
    // identidade dava a quem ataca a chave do balde -- e um mapa sem teto.
    const rajadas = new Map();
    const escrever = (event) => {
        try {
            deps.audit.append(event);
        }
        catch (error) {
            // NUNCA PROPAGA. Ver (A) no cabecalho: a alternativa e um 500 que
            // anuncia a rota e quebra D9.
            deps.log.error(maskAuditText(`[painel] falha ao registar auditoria de ${event.evento}: ` +
                `${error instanceof Error ? error.message : String(error)}`));
        }
    };
    return {
        append: escrever,
        recordAnonymousRejection(evento) {
            const agora = deps.clock.now();
            let rajada = rajadas.get(evento);
            if (rajada === undefined || agora - rajada.ultimaEm >= quietMs) {
                rajada = { contagem: 0, ultimaEm: agora, proximoLimiar: 1 };
                rajadas.set(evento, rajada);
            }
            rajada.contagem += 1;
            rajada.ultimaEm = agora;
            if (rajada.contagem < rajada.proximoLimiar)
                return;
            // O nome leva a contagem para que a magnitude sobreviva sem um campo novo.
            escrever({ evento: `${evento}_x${rajada.contagem}`, resultado: 'negado' });
            rajada.proximoLimiar = rajada.contagem * 2;
        },
    };
}
/**
 * Emite a sessao e a linha `Set-Cookie`, ou falha FECHANDO.
 *
 * A ORIGEM E VERIFICADA ANTES DE A SESSAO NASCER. Se fosse depois, uma origem
 * que nao entrega cookie `Secure` deixava para tras uma sessao valida do lado do
 * servidor que ninguem consegue apresentar -- lixo autenticado a contar para o
 * teto de sessoes vivas.
 *
 * `regenerate` e nao `create`: ele INVALIDA o id que o cliente apresentou antes
 * de emitir o novo. Sem isso, um id plantado no navegador da vitima (por
 * subdominio, por XSS noutra aplicacao, por link) continuaria valido depois de
 * ela autenticar -- que e a definicao de session fixation. O aviso esta escrito
 * no topo de `src/session/store.ts` e e dirigido a esta sub-tarefa.
 */
export function emitSession(input) {
    try {
        assertTrustworthyOrigin(input.origin);
    }
    catch (error) {
        // A mensagem e accionavel e foi escrita para o operador (nomeia a origem,
        // que nao e segredo). Ela vai para o LOG e nunca para o fio: quem faz o
        // pedido nao precisa de saber como a instalacao esta alcancavel.
        input.log.error(maskAuditText(`[painel] recusa emitir sessao: ${error instanceof Error ? error.message : String(error)}`));
        return { ok: false };
    }
    const id = input.sessions.regenerate(input.presentedSessionId ?? undefined);
    return { ok: true, setCookie: serializeSessionCookie(id, input.origin) };
}
export function createPanelPageHandler(deps) {
    return async (exchange) => {
        if (exchange.session === null) {
            // Inalcancavel: a tabela de `routes.ts` marca esta rota `exige-sessao` e
            // o despachante ja recusou. Se chegar aqui, a tabela e o despachante
            // desalinharam -- fecha-se, nunca se serve o painel a descoberto.
            deps.log.error('[painel] GET /__guard alcancado sem sessao: politica e despacho divergiram');
            return INTERNAL_ERROR_RESPONSE;
        }
        const nonce = newNonce();
        // O vinculo do token e o HASH da sessao, nunca o id: o id e a credencial
        // portadora e ia parar dentro do HTML, ao alcance de qualquer leitura da
        // pagina. O hash correlaciona sem permitir reconstruir.
        const html = renderPanelPage({ nonce, csrfToken: exchange.csrf.issue(exchange.session.idHash) });
        return { status: 200, headers: panelHtmlHeaders(nonce), body: html };
    };
}
/**
 * Projeta o snapshot para o fio.
 *
 * `info` e `expiresAt` SO SAEM EM `READY`, e a verificacao e feita aqui e nao
 * confiada ao produtor. `src/contracts/tunnel.ts` ja diz "presente sse
 * `state === 'READY'`", mas um contrato e uma promessa e isto e uma fronteira:
 * se um dia um supervisor com defeito deixar `info` preenchida em `STARTING`, a
 * URL do tunel sai na resposta. Custa uma linha impedi-lo.
 *
 * O vocabulario que vai no payload e o INGLES de D7. Os rotulos em portugues
 * ficam em `html.ts` e nunca entram aqui.
 */
export function projectSnapshot(snapshot) {
    const payload = {
        state: snapshot.state,
        attempts: snapshot.attempts,
    };
    if (snapshot.state === 'READY' && snapshot.info !== undefined) {
        payload['info'] = {
            url: snapshot.info.url,
            startedAt: snapshot.info.startedAt,
            mode: snapshot.info.mode,
        };
        if (typeof snapshot.expiresAt === 'number')
            payload['expiresAt'] = snapshot.expiresAt;
    }
    if (snapshot.failure !== undefined) {
        const failure = {
            code: snapshot.failure.code,
            // A ASSIMETRIA QUE A REVISAO APANHOU, e agora fechada: `info` era
            // filtrada por desconfianca do produtor e `message` era ACEITE dele. O
            // contrato proibe segredo, caminho e URL la dentro -- e isto e a
            // fronteira, que nao confia na proibicao. UMA chamada chega: desde a
            // costura da Onda 3, `maskAuditText` cobre o URL do tunel, o `mk`, o
            // segredo em base32 E o `$HOME` (este ultimo via `SECRET_SHAPES`).
            message: maskAuditText(snapshot.failure.message),
            retryable: snapshot.failure.retryable,
        };
        if (snapshot.failure.probe !== undefined)
            failure['probe'] = snapshot.failure.probe;
        payload['failure'] = failure;
    }
    return payload;
}
export function createStateHandler(deps) {
    return async () => ({
        status: 200,
        headers: JSON_HEADERS,
        body: `${JSON.stringify({ ...projectSnapshot(deps.snapshot()), seq: deps.seq() })}\n`,
    });
}
/* ========================================================================== */
/* 6. `POST /__guard/api/login`                                               */
/* ========================================================================== */
/** Nome do campo que transporta o segredo. */
export const LOGIN_FIELD_NAME = 'segredo';
/**
 * A rota que T2.2 NAO entregou de proposito -- a Onda 2 era "primitivas sem
 * fiacao". Esta e a fiacao.
 *
 * TRES PROPRIEDADES QUE O TESTE TEM DE CONSEGUIR FALSIFICAR:
 *
 * 1. NENHUM ORACULO. Todo o caminho que nao termina em sessao devolve
 *    `CREDENTIAL_DENIED_RESPONSE`, a mesma constante, com os mesmos bytes. Campo
 *    ausente vira candidato vazio em vez de um ramo proprio, justamente para
 *    nao existir um ramo proprio.
 * 2. CUSTO CONSTANTE. `runThrottledAttempt` corre a comparacao mesmo quando a
 *    identidade esta banida (`recordVerifiedButDenied`), e o atraso vem da
 *    mesma escada. Responder mais depressa a um banido seria dizer-lhe que
 *    esta banido.
 * 3. ANTI-FIXATION. `emitSession` chama `regenerate` com o id APRESENTADO.
 */
export function createLoginHandler(deps) {
    return async (exchange) => {
        const candidate = exchange.fields.get(LOGIN_FIELD_NAME) ?? '';
        const outcome = await runThrottledAttempt(deps.limiter, exchange.identity, () => deps.secrets.verify(candidate), deps.wait);
        if (!outcome.granted) {
            deps.audit.append({
                evento: 'painel_login',
                resultado: 'negado',
                ...(exchange.identity.ip === undefined ? {} : { ip_normalizado: exchange.identity.ip }),
            });
            return CREDENTIAL_DENIED_RESPONSE;
        }
        const emitted = emitSession({
            sessions: deps.sessions,
            origin: exchange.origin,
            presentedSessionId: exchange.presentedSessionId,
            log: deps.log,
        });
        if (!emitted.ok)
            return INTERNAL_ERROR_RESPONSE;
        deps.audit.append({
            evento: 'painel_login',
            resultado: 'permitido',
            ...(exchange.identity.ip === undefined ? {} : { ip_normalizado: exchange.identity.ip }),
        });
        return { ...OK_JSON_RESPONSE, setCookie: emitted.setCookie };
    };
}
/* ========================================================================== */
/* 7. `POST /__guard/api/tunnel/*` -- a superficie de liga/desliga (T5.3)     */
/* ========================================================================== */
/**
 * O painel e SUPERFICIE, nunca dono do estado (`03-ONDAS.md` 10): estes tres
 * tratadores NAO falam com o supervisor de tunel -- montam um `ControlIntent`
 * (contrato congelado, `src/contracts/control.ts`) e entregam-no ao
 * `dispatch` que T5.1 fia. E o controlador, e so ele, que valida o nonce
 * (CTL-021/022/023), recusa em modo restrito (CTL-015) e mexe no processo.
 */
/** Nome do campo do corpo que transporta o nonce de confirmacao (opaco). */
export const TUNNEL_NONCE_FIELD_NAME = 'nonce';
/**
 * Estado HTTP de uma recusa do controlador.
 *
 * 409 e NAO 200-com-erro de proposito: uma recusa e um CONFLITO com o estado
 * corrente (CTL-007 `SHUTDOWN_IN_PROGRESS`, CTL-015 `MODO_RESTRITO`, CTL-011
 * `TERMINAL_SEM_RESET`, CTL-021/022 nonce) e o corpo traz o codigo de recusa
 * fechado -- o rotulo em portugues vive em `html.ts` (D7), nunca aqui.
 */
export const TUNNEL_ACTION_REFUSAL_STATUS = 409;
/** Projeta o resultado do despacho para o fio. O vocabulario e o INGLES de D7. */
function projectControlResult(resultado) {
    if (resultado.recusa === undefined) {
        return {
            status: 200,
            headers: JSON_HEADERS,
            body: `${JSON.stringify({ ok: true, estado: resultado.estado })}\n`,
        };
    }
    return {
        status: TUNNEL_ACTION_REFUSAL_STATUS,
        headers: JSON_HEADERS,
        body: `${JSON.stringify({ ok: false, recusa: resultado.recusa, estado: resultado.estado })}\n`,
    };
}
/**
 * `POST /__guard/api/tunnel/start/nonce` -- o PASSO 1 do liga em duas etapas.
 *
 * Emite um nonce de confirmacao (TTL 60 s, uso unico, server-side no host) e
 * devolve-o OPACO com a expiracao. A pagina mostra-o como confirmacao e o
 * reenvia no `POST /__guard/api/tunnel/start` final. Emitir nao e mutar: so o
 * `POST` final, com o nonce, despacha (CTL-023: sem nonce nao ha `start`).
 *
 * Nao usa a sessao para alem do gate do despachante: quem aqui chega ja tem
 * sessao valida (a rota e `exige-sessao`), e o nonce nao se vincula a ela --
 * e o `consume` do host que o valida contra a acao.
 */
export function createTunnelNonceHandler(deps) {
    return async () => {
        const nonce = deps.confirm.issue('start');
        return {
            status: 200,
            headers: JSON_HEADERS,
            body: `${JSON.stringify({ nonce: nonce.valor, expiresAt: nonce.expiresAt })}\n`,
        };
    };
}
/**
 * `POST /__guard/api/tunnel/start` -- o PASSO 2 do liga.
 *
 * Monta o `ControlIntent` e despacha. `requestedBy` e `panel:<id-hash-da-sessao>`
 * (o valor que o audit de T5.4 escreve linha a linha), `requestId` e um ULID
 * NOVO por pedido (a chave de idempotencia de D29) e `at` vem do relogio
 * injetado. O nonce do corpo atravessa OPACO ate ao controlador -- repetido,
 * o controlador RECUSA (CTL-021); o painel nao guarda memoria de nonces.
 */
export function createTunnelStartHandler(deps) {
    return async (exchange) => {
        // Inalcancavel: a tabela marca a rota `exige-sessao` e o despachante ja
        // recusou. Se chegar aqui, fechamos em vez de despachar sem origem — e
        // o log acusa, porque despachar sem origem era uma transicao anonima
        // (CTL-031).
        if (exchange.session === null) {
            deps.log.error('[painel] POST /__guard/api/tunnel/start alcancado sem sessao: politica e despacho divergiram');
            return INTERNAL_ERROR_RESPONSE;
        }
        const nonce = exchange.fields.get(TUNNEL_NONCE_FIELD_NAME) ?? '';
        const intent = {
            action: 'start',
            requestedBy: `panel:${exchange.session.idHash}`,
            requestId: newUlid(deps.clock.now()),
            nonce: nonce === '' ? undefined : nonce,
            at: deps.clock.now(),
        };
        return projectControlResult(await deps.dispatch(intent));
    };
}
/**
 * `POST /__guard/api/tunnel/stop` -- o desliga.
 *
 * A acao que REDUZ exposicao NAO exige nonce (CTL-024: em panico, tem de
 * funcionar de primeira); a confirmacao e de INTERFACE, no painel, e o token
 * anti-CSRF vem do despachante para TODOS os `POST` (NIST SP 800-63B-4 5.1.1).
 */
export function createTunnelStopHandler(deps) {
    return async (exchange) => {
        if (exchange.session === null) {
            deps.log.error('[painel] POST /__guard/api/tunnel/stop alcancado sem sessao: politica e despacho divergiram');
            return INTERNAL_ERROR_RESPONSE;
        }
        const intent = {
            action: 'stop',
            requestedBy: `panel:${exchange.session.idHash}`,
            requestId: newUlid(deps.clock.now()),
            at: deps.clock.now(),
        };
        return projectControlResult(await deps.dispatch(intent));
    };
}
//# sourceMappingURL=api.js.map