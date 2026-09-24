/**
 * INTERNO do adaptador telegram (`worker/providers/telegram/**`).
 *
 * Port fiel dos pequenos auxiliares que os ficheiros de referencia
 * (`worker/lib/*`) fornecem ao PROCESSO orientado por telegram. A regra da
 * fronteira D4 (§0 do contrato) proibe o adaptador de IMPORTAR de
 * `worker/lib/*` ou `worker/auth/*` — esses ficheiros sao donos de outras
 * ondas e o adaptador PORTEIA deles, nao os consume. Para naos depender de
 * uma politica de import por-aviso, os auxiliares estruturais de que todo o
 * diretorio precisa (relogio, espera, logger, mascaramento, erro tipado e
 * codigos de saida) vivem AQUI, uma unica vez.
 *
 * ===========================================================================
 * PORQUE RELOGIO E LOGGER SAO TIPOS E NAO IMPORTS
 * ===========================================================================
 * `worker/lib/clock.ts` e `worker/lib/log.ts` satisfazem estes tipos
 * estruturais sem cast: `WorkerClock`/`Sleeper`/<string>TimeSource` e
 * `WorkerLogger`.
 * ===========================================================================
 */
export const systemTime = {
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise((resolve) => {
        if (!(ms > 0) || signal?.aborted === true) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort);
    }),
};
/**
 * Logger que acumula em memoria — usado apenas nos testes do adaptador e no
 * arranque quando o boot ainda nao tem o logger de producao.
 */
export function criarLoggerMemoria(sink = (line) => process.stderr.write(line)) {
    function registrar(level) {
        return (message, fields) => {
            const extra = fields === undefined
                ? ''
                : Object.entries(fields)
                    .filter(([, value]) => value !== undefined)
                    .map(([key, value]) => ` ${key}=${String(value)}`)
                    .join('');
            sink(`${level.toUpperCase()} ${message}${extra}`);
        };
    }
    return {
        debug: registrar('debug'),
        info: registrar('info'),
        warn: registrar('warn'),
        error: registrar('error'),
    };
}
/* ========================================================================== */
/* MASCARAMENTO (port de `worker/lib/redact.ts`)                              */
/* ========================================================================== */
/** Substituto visivel: um log com isto diz ao operador que houve corte. */
export const REDACTED = '[REDACTED]';
const MIN_LITERAL_LENGTH = 8;
const SECRET_SHAPES = [
    { pattern: /((?<!\d)\d{6,12}:)([A-Za-z0-9_-]{20,})/gu, keep: '$1' },
    { pattern: /((?:proxy-)?authorization\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
    { pattern: /((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/giu, keep: '$1' },
    { pattern: /(?<![\w.~-])\/(?:(?:home|Users)\/[^/\s"'<>)\];,:]+|root)(?![\w-])/gu, keep: '' },
];
function escapeForRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
/**
 * Devolve `text` com os segredos mascarados (literais conhecidos + formas).
 */
export function redact(text, knownSecrets = []) {
    let result = text;
    for (const secret of knownSecrets) {
        if (typeof secret !== 'string' || secret.length < MIN_LITERAL_LENGTH)
            continue;
        result = result.replace(new RegExp(escapeForRegExp(secret), 'gu'), REDACTED);
    }
    for (const { pattern, keep } of SECRET_SHAPES) {
        result = result.replace(new RegExp(pattern.source, pattern.flags), `${keep}${REDACTED}`);
    }
    return result;
}
/**
 * Descricao segura de um valor arbitrario para log. PASSA SEMPRE por
 * `redact` — e por aqui que a mensagem do transporte, com a URL (e o token)
 * dentro da causa, tentaria sair.
 */
export function describeForLog(value, knownSecrets = []) {
    if (value instanceof Error) {
        const cause = value.cause === undefined ? '' : ` <- ${describeForLog(value.cause, knownSecrets)}`;
        return redact(`${value.name}: ${value.message}${cause}`, knownSecrets);
    }
    if (typeof value === 'string')
        return redact(value, knownSecrets);
    if (value === null || value === undefined || typeof value !== 'object') {
        return redact(String(value), knownSecrets);
    }
    try {
        return redact(JSON.stringify(value), knownSecrets);
    }
    catch (error) {
        return redact(`[nao serializavel: ${error instanceof Error ? error.name : 'desconhecido'}]`);
    }
}
/**
 * A classe de erro e os codigos de saida do CONTRATO COMUM (Onda 3-fix):
 * `ProviderError` com o `code` NUMERICO `WorkerExitCode` (10..14) — o boot
 * generico classifica por `code`, nao por `instanceof`; `WORKER_EXIT` e o
 * vocabulario fechado dos codigos de saida; `exitCodeFor` mapeia as causas
 * legiveis (o vocabulario acima) para o codigo de saida.
 */
export { ProviderError, WORKER_EXIT, exitCodeFor, isWorkerExitCode } from "../../lib/errors.js";
//# sourceMappingURL=interno.js.map