/**
 * =============================================================================
 * A SONDA — o unico I/O de rede do onboarding, agora POR PROVEDOR.
 * =============================================================================
 *
 * Duas camadas num ficheiro, e elas nao se separam:
 *
 *   1. o TRANSPORTE TELEGRAM (portado de `src/telegram/onboarding.ts`): o
 *      `criarSondaHttp` com `getMe`/`getUpdates` e a classificacao de falha
 *      MEDIDA (`docs/spikes/telegram.md`). NAO ha duplicacao: quem quiser a
 *      sonda telegram completa importa daqui (o `src/telegram/onboarding.ts`
 *      re-exporta para o CLI e os testes continuarem a encontrar a MESMA
 *      origem — o mesmo padrao da extracao de `texts.ts`);
 *   2. `criarSonda(provider, ...)`: a FABRICA provider-aware que devolve o
 *      probe comum `{ ok, botNome? }` — a superficie que o painel de T5.3
 *      consome sem saber com que provedor esta a falar.
 *
 * -----------------------------------------------------------------------------
 * PORQUE UM PROBE COMUM E NAO `criarSondaHttp` DIRETO NO PAINEL
 * -----------------------------------------------------------------------------
 * O painel pergunta "o token deste provedor vale? o bot tem nome publico?" —
 * e so isso. O `getUpdates` do Telegram (a sondagem de pareamento do CLI) e
 * especifico do canal e NAO faz parte dessa pergunta. O probe comum devolve o
 * minimo que a UI precisa: `ok`, `botNome` e um `erro` curto (nao prosa, nao
 * segredo). Quem precisar de mais (o CLI de pareamento) continua a usar a
 * sonda telegram completa — por injecao, nunca por duplicacao.
 *
 * -----------------------------------------------------------------------------
 * A RAIZ DA API E CONFIGURAVEL POR PROVEDOR (TELEGRAM_API_ROOT)
 * -----------------------------------------------------------------------------
 * O worker telegram le `TELEGRAM_API_ROOT` (`API_ROOT_ENV_VAR`) e a sonda le a
 * MESMA variavel. E a disciplina do `tokenVar`: o nome e DUPLICADO do lado do
 * worker e a paridade e um teste, nao um import — o worker so pode importar
 * `src/contracts/ipc.ts` de `src/` (`05-QUALIDADE-CODIGO.md` 5.5). Omissa,
 * cada provedor usa a raiz publica.
 */
/* ========================================================================== */
/* Transporte telegram (PORTADO de src/telegram/onboarding.ts — nao duplicar) */
/* ========================================================================== */
/** Raiz da Bot API. SEM barra final. */
export const API_ROOT_PADRAO = 'https://api.telegram.org';
/** Teto de espera de uma chamada. Curto: isto e um CLI, nao um servico. */
export const TIMEOUT_DA_SONDA_MS = 10_000;
/**
 * Quantos updates uma sondagem pede. O teto da propria Bot API e 100
 * (`Client.cpp` clampa `limit` a 1-100).
 *
 * E EXPORTADO porque e um LIMITE OBSERVAVEL, nao um detalhe: com `offset: 0` a
 * fila nunca e confirmada, logo uma resposta com exatamente
 * `LIMITE_DE_UPDATES` elementos significa "ha pelo menos mais alguns que nunca
 * veremos". Quem espera pelo `/parear` tem de reconhecer esse caso e dize-lo —
 * ver A2 no cabecalho de `bin/dsh-guard-setup.ts`.
 */
export const LIMITE_DE_UPDATES = 100;
/**
 * Classifica um par (HTTP, corpo) da Bot API.
 *
 * Os valores vem MEDIDOS, nao presumidos (`docs/spikes/telegram.md` 2.1 e 6):
 *   - `401 {"ok":false,"error_code":401,"description":"Unauthorized: invalid
 *     token specified"}` — token bem formado sem conta por tras;
 *   - `404 {"ok":false,"error_code":404,"description":"Not Found"}` — token sem
 *     `:`, que cai fora da rota `/bot<token>/<metodo>`;
 *   - `409 Conflict: terminated by other getUpdates request...` — ha outra
 *     instancia a fazer long polling com o MESMO token.
 */
export function classificarFalha(httpStatus, corpo) {
    const errorCode = numeroDe(corpo, 'error_code');
    const description = textoDe(corpo, 'description');
    const retryAfter = numeroDe(propriedade(corpo, 'parameters'), 'retry_after');
    const codigo = errorCode ?? httpStatus;
    const causa = codigo === 401
        ? 'recusado'
        : codigo === 404
            ? 'rota-inexistente'
            : codigo === 409
                ? 'conflito'
                : codigo === 429
                    ? 'limite-de-taxa'
                    : 'resposta-ininteligivel';
    return {
        causa,
        httpStatus,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(description === undefined ? {} : { description }),
        ...(retryAfter === undefined ? {} : { retryAfter }),
    };
}
/** Le um `User` de `{"ok":true,"result":{...}}`, sem confiar na forma. */
export function lerIdentidade(corpo) {
    const result = propriedade(corpo, 'result');
    const id = numeroDe(result, 'id');
    const username = textoDe(result, 'username');
    if (id === undefined || username === undefined)
        return undefined;
    return { id, username };
}
function propriedade(valor, chave) {
    if (typeof valor !== 'object' || valor === null)
        return undefined;
    return valor[chave];
}
function numeroDe(valor, chave) {
    const bruto = propriedade(valor, chave);
    return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : undefined;
}
function textoDe(valor, chave) {
    const bruto = propriedade(valor, chave);
    return typeof bruto === 'string' && bruto.length > 0 ? bruto : undefined;
}
export function criarSondaHttp(opcoes = {}) {
    const apiRoot = (opcoes.apiRoot ?? API_ROOT_PADRAO).replace(/\/+$/u, '');
    const buscar = opcoes.buscar ?? fetch;
    const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_DA_SONDA_MS;
    /**
     * Uma chamada a Bot API.
     *
     * O TOKEN VIAJA NO CAMINHO DO URL — e a forma da API (`/bot<token>/<metodo>`)
     * e nao ha alternativa. Por isso NADA do que sai daqui contem o URL: nem a
     * mensagem de erro, nem o `description`. E tambem por isso que
     * `src/logging/redact.ts` existe e tem uma forma para este token.
     */
    const chamar = async (token, metodo, corpo) => {
        try {
            const resposta = await buscar(`${apiRoot}/bot${token}/${metodo}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(corpo),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const texto = await resposta.text();
            let lido;
            try {
                lido = JSON.parse(texto);
            }
            catch (erroDeJson) {
                // NAO se engole: um corpo nao-JSON e um proxy corporativo a devolver
                // uma pagina de bloqueio, e a pessoa tem de saber que houve resposta.
                void erroDeJson;
                lido = undefined;
            }
            return { httpStatus: resposta.status, corpo: lido };
        }
        catch (erroDeRede) {
            // A mensagem de `fetch` traz o URL, e o URL traz o token. Ela e
            // DELIBERADAMENTE descartada: a causa `rede` diz tudo o que a pessoa
            // pode accionar, e nada do que ela pode vazar.
            void erroDeRede;
            return { rede: true };
        }
    };
    return {
        async getMe(token) {
            const resposta = await chamar(token, 'getMe', {});
            if ('rede' in resposta) {
                return { ok: false, falha: { causa: 'rede', httpStatus: 0 } };
            }
            const identidade = resposta.httpStatus === 200 && propriedade(resposta.corpo, 'ok') === true
                ? lerIdentidade(resposta.corpo)
                : undefined;
            if (identidade !== undefined)
                return { ok: true, bot: identidade };
            return { ok: false, falha: classificarFalha(resposta.httpStatus, resposta.corpo) };
        },
        async getUpdates(token) {
            // `offset: 0` e `timeout: 0`: ver o JSDoc da interface. Estes dois zeros
            // sao a entrega, nao um valor por omissao esquecido.
            const resposta = await chamar(token, 'getUpdates', {
                offset: 0,
                timeout: 0,
                limit: LIMITE_DE_UPDATES,
                allowed_updates: ['message'],
            });
            if ('rede' in resposta) {
                return { ok: false, falha: { causa: 'rede', httpStatus: 0 } };
            }
            const resultado = propriedade(resposta.corpo, 'result');
            if (resposta.httpStatus === 200 && Array.isArray(resultado)) {
                return { ok: true, updates: resultado };
            }
            return { ok: false, falha: classificarFalha(resposta.httpStatus, resposta.corpo) };
        },
    };
}
/* ========================================================================== */
/* O probe comum por provedor                                                  */
/* ========================================================================== */
/**
 * Variavel de ambiente da raiz da API, por provedor — o nome DUPLICADO do lado
 * do worker (`TELEGRAM_API_ROOT` em `worker/providers/telegram/token.ts`); a
 * paridade e um teste, nao um import (cone de import).
 */
const API_ROOT_VAR = {
    telegram: 'TELEGRAM_API_ROOT',
};
/**
 * Resolve a raiz da API do provedor a partir do ambiente.
 *
 * Omissa (ou vazia) = a raiz publica do provedor — o valor que o painel usa
 * quando ninguem apontou para um duplo de teste. Configuravel por
 * `TELEGRAM_API_ROOT` (telegram).
 */
export function apiRootDe(provider, ambiente = process.env) {
    const bruto = ambiente[API_ROOT_VAR[provider]]?.trim();
    return bruto === undefined || bruto === '' ? undefined : bruto;
}
/**
 * A FABRICA provider-aware: devolve o probe comum para o provedor ativo.
 *
 * O dispatcher e o `ProviderId` FECHADO de `src/proc/env.ts` — um provedor
 * novo acrescenta aqui o ramo e a sua implementacao. Nada no chamador muda.
 */
export function criarSonda(provider, opcoes = {}) {
    // Telegram: o probe comum por cima do transporte portado — o getMe decide.
    // `ok:false` com HTTP 200 = o bot EXISTE e nao tem @username (o contrato do
    // getMe colapsa o "sem username" nesse 200) — verde legitimo, sem nome.
    const sonda = criarSondaHttp(opcoes);
    return {
        async verificar(token) {
            const resposta = await sonda.getMe(token);
            if (resposta.ok)
                return { ok: true, botNome: resposta.bot.username };
            if (resposta.falha.httpStatus === 200)
                return { ok: true };
            const erro = resposta.falha.causa === 'recusado' || resposta.falha.causa === 'rota-inexistente'
                ? 'token-invalido'
                : resposta.falha.causa === 'rede'
                    ? 'rede'
                    : 'indisponivel';
            return { ok: false, erro };
        },
    };
}
//# sourceMappingURL=sonda.js.map