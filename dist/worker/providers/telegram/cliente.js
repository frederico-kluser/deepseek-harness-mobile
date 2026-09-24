/**
 * O CLIENTE GRAMMY: `apiRoot` (barra final normalizada), `sensitiveLogs: false`
 * EXPLICITO, os transformers de transporte+retry, e `bot.catch` a cobrir
 * `GrammyError` E `HttpError`. Port fiel de `worker/lib/client.ts`.
 *
 * ===========================================================================
 * `bot.catch` TEM DE COBRIR `HttpError`, E NAO SO `GrammyError`
 * ===========================================================================
 * Sao coisas diferentes:
 *   - `GrammyError` — o Telegram respondeu COM ERRO. Tem `method`, `error_code`
 *     e `description`; e diagnostico.
 *   - `HttpError`   — o pedido HTTP nem chegou a ter resposta. E QUEDA DE REDE.
 * Esquecer o `HttpError` deixa o processo morrer por queda de Wi-Fi.
 *
 * O `bot.catch` NAO apanha a rede do polling (o ciclo de `getUpdates` nao passa
 * por middleware); quem testemunha a queda e o transporte-log (`./transporte.ts`),
 * instalado como transformer. O ramo `HttpError` daqui vale para o que acontece
 * em middleware (um `ctx.reply` durante uma queda).
 */
import { Bot, GrammyError, HttpError } from 'grammy';
import { createAutoRetryTransformer, createTransportLogTransformer } from "./transporte.js";
import { systemTime, describeForLog, ProviderError, WORKER_EXIT } from "./interno.js";
/**
 * Tira a barra final do `apiRoot`.
 *
 * MEDIDO: o grammY LANCA com barra final («Remove the trailing '/' from the
 * 'apiRoot' option`) — nao normaliza. Este valor vem de uma env escrita a mao,
 * e deixar o processo morrer por causa de uma barra seria transformar um erro
 * de dactilografia numa indisponibilidade.
 */
export function normalizeApiRoot(apiRoot) {
    return apiRoot.replace(/\/+$/u, '');
}
/**
 * Traduz um erro do grammY para uma linha que um humano consegue accionar.
 */
export function describeBotError(error, secrets = []) {
    if (error instanceof GrammyError) {
        return {
            message: 'a Bot API respondeu com erro',
            fields: {
                kind: 'GrammyError',
                method: error.method,
                error_code: error.error_code,
                description: describeForLog(error.description, secrets),
                retry_after: error.parameters.retry_after ?? undefined,
            },
        };
    }
    if (error instanceof HttpError) {
        return {
            message: 'o pedido HTTP a Bot API falhou (rede) — o bot continua vivo e volta a tentar',
            fields: {
                kind: 'HttpError',
                // `error.message` ja vem sem a URL por causa de `sensitiveLogs: false`;
                // `error.error` NAO vem, e e por isso que passa por `describeForLog`.
                detail: describeForLog(error.message, secrets),
                cause: describeForLog(error.error, secrets),
            },
        };
    }
    return {
        message: 'erro nao tratado no middleware do bot',
        fields: { kind: 'Error', detail: describeForLog(error, secrets) },
    };
}
/**
 * O handler de `bot.catch`.
 *
 * NUNCA relanca e NUNCA fica calado: relancar dentro do `bot.catch` mata o
 * processo por um erro que ja foi tratado; ficar calado transforma uma falha
 * num nada observavel. Regista e segue — o polling continua.
 */
export function createErrorHandler(log, secretsOf = () => []) {
    return (botError) => {
        const secrets = secretsOf();
        const { message, fields } = describeBotError(botError.error, secrets);
        log.error(message, fields);
    };
}
/**
 * Monta o bot.
 *
 * O token e validado aqui e nao no `Bot`: o grammY aceita string vazia e so
 * falha no `getMe`, com um 404 do servidor — mensagem que nao ajuda ninguem.
 */
export function createTelegramBot(options) {
    const token = options.token.trim();
    if (token === '') {
        throw new ProviderError(WORKER_EXIT.CONFIG, 'TOKEN_MISSING', 'token vazio: nao ha bot para construir');
    }
    const time = options.time ?? systemTime;
    const secretsOf = () => [token];
    const client = {
        // Explicito, e nao herdado: com `false` a `toHttpError` NAO concatena a
        // mensagem do erro subjacente (que citaria a URL com o token dentro).
        sensitiveLogs: false,
        ...(options.apiRoot === undefined ? {} : { apiRoot: normalizeApiRoot(options.apiRoot) }),
    };
    const bot = new Bot(token, { client });
    /* A ORDEM E DELIBERADA: `use()` faz `transformers.reduce(concatTransformer,
       this.call)` — o ULTIMO instalado fica por FORA. O transporte entra
       PRIMEIRO, encostado a rede, para ver cada tentativa HTTP real; o auto-retry
       fica por fora, a decidir se ha outra tentativa. */
    bot.api.config.use(createTransportLogTransformer({ log: options.log, secrets: secretsOf }), createAutoRetryTransformer({
        time,
        log: options.log,
        ...options.autoRetry,
    }));
    bot.catch(createErrorHandler(options.log, secretsOf));
    return bot;
}
//# sourceMappingURL=cliente.js.map