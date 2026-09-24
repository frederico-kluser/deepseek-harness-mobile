/**
 * O EMISSOR NEUTRO: parte o texto antes de o mandar e serializa 1 mensagem/
 * segundo POR CHAT.
 *
 * DONO: onda 2 "desacoplar o bot de mensageria para arquitetura de provedores".
 * PORTE FIEL de `worker/lib/outbox.ts` contra o CONTRATO `./contract.ts`: o
 * corte usa {@link SurfaceLimits.maxTextLength} (o 4096 do Telegram declarado
 * pelo provedor) e a chave da fila e o `chatKey: string` (a `chat.id` na
 * fronteira neutra). `SendText` = `(chatKey, texto) => Promise<unknown>`.
 *
 * ===========================================================================
 * TG-048 — O CORTE E NOSSO, ANTES DO FIO
 * ===========================================================================
 * `SurfaceLimits.maxTextLength` e o teto de code points do canal (4096 para o
 * Telegram). Mandar mais e uma ida a rede desperdicada. O corte acontece AQUI,
 * nunca apos a ida. Medido em unidades UTF-16 (`String#length`) de proposito:
 * e SEMPRE conservador — nunca deixa passar uma mensagem que o canal recuse.
 *
 * ===========================================================================
 * TG-049 — 1 MENSAGEM/SEGUNDO POR CHAT
 * ===========================================================================
 * Passar do intervalo documentado rende 429. A serializacao e POR CHAT e nao
 * global: dois chats distintos nao esperam um pelo outro (uma fila unica
 * transformaria o limite por chat em limite global).
 *
 * Sem estado de modulo: as filas vivem no closure de {@link criarOutbox}. Duas
 * instancias sao independentes.
 */
/** Marcador de corte, quando o chamador escolhe truncar em vez de particionar. */
export const MARCADOR_DE_CORTE = '…';
/** Um segundo entre mensagens para o MESMO chat. */
export const INTERVALO_MINIMO_PADRAO_MS = 1_000;
/**
 * Parte `text` em pedacos que cabem em `limit`, SEM PERDER UM CARACTER: a
 * concatenacao dos pedacos e identica ao original. Preferencia de corte: ultima
 * quebra de linha, senao ultimo espaco, senao corte duro. O corte duro NUNCA
 * parte um par substituto.
 */
export function particionarTexto(text, limit) {
    if (limit < 1)
        throw new TypeError(`limite invalido: ${limit}`);
    if (text.length <= limit)
        return text === '' ? [] : [text];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        if (text.length - start <= limit) {
            chunks.push(text.slice(start));
            break;
        }
        const window = text.slice(start, start + limit);
        let end = start + limit;
        const newline = window.lastIndexOf('\n');
        const space = window.lastIndexOf(' ');
        if (newline > 0)
            end = start + newline + 1;
        else if (space > 0)
            end = start + space + 1;
        else {
            // Corte duro. Se o ultimo caracter incluido for a metade ALTA de um par
            // substituto, recua-se um — meio par e um `U+FFFD` na cara do dono.
            const last = text.charCodeAt(end - 1);
            const eSubstitutoAlto = last >= 0xd8_00 && last <= 0xdb_ff;
            if (eSubstitutoAlto && end - 1 > start)
                end -= 1;
        }
        chunks.push(text.slice(start, end));
        start = end;
    }
    return chunks;
}
/**
 * Corta `text` em `limit`, com marcador. Alternativa a particionar para texto
 * em que o fim nao interessa (um dump de erro). O marcador conta PARA DENTRO do
 * limite.
 */
export function truncarTexto(text, limit) {
    if (text.length <= limit)
        return text;
    const keep = Math.max(0, limit - MARCADOR_DE_CORTE.length);
    const head = text.slice(0, keep);
    const last = head.charCodeAt(head.length - 1);
    const trimmed = last >= 0xd8_00 && last <= 0xdb_ff ? head.slice(0, -1) : head;
    return `${trimmed}${MARCADOR_DE_CORTE}`;
}
/**
 * Constroi o emissor. `maxLength` tem como default o {@link SurfaceLimits} neutro
 * que o chamador declare; aqui o default e so a constante do Telegram para o
 * caso de o chamador nao o fornecer (o contrato exige que o adaptador declare o
 * seu, a Onda 3).
 */
export function criarOutbox(sendText, options = {}) {
    const minIntervalMs = options.minIntervalMs ?? INTERVALO_MINIMO_PADRAO_MS;
    const maxLength = options.maxLength ?? 4_096;
    const time = options.time ?? { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    const log = options.log;
    const lanes = new Map();
    const lastSentAt = new Map();
    async function pace(chatKey) {
        const last = lastSentAt.get(chatKey);
        if (last === undefined)
            return;
        const waitMs = minIntervalMs - (time.now() - last);
        if (waitMs > 0)
            await time.sleep(waitMs);
    }
    async function deliver(chatKey, chunks) {
        for (const chunk of chunks) {
            await pace(chatKey);
            await sendText(chatKey, chunk);
            lastSentAt.set(chatKey, time.now());
        }
    }
    function send(chatKey, texto) {
        const chunks = particionarTexto(texto, maxLength);
        if (chunks.length === 0) {
            return Promise.reject(new Error(`pedido de envio sem texto para o chat ${chatKey}`));
        }
        if (chunks.length > 1) {
            log?.debug('mensagem particionada antes de sair', {
                chat: chatKey,
                chunks: chunks.length,
                length: texto.length,
            });
        }
        const previous = lanes.get(chatKey) ?? Promise.resolve();
        const task = previous.then(() => deliver(chatKey, chunks));
        // A CAUDA absorve a falha; a promessa DEVOLVIDA nao. Se a cauda propagasse
        // o erro, uma falha de envio encravava o chat para sempre.
        const tail = task.catch(() => undefined);
        lanes.set(chatKey, tail);
        void tail.finally(() => {
            if (lanes.get(chatKey) === tail)
                lanes.delete(chatKey);
        });
        return task;
    }
    async function drain() {
        for (;;) {
            const snapshot = [...lanes.values()];
            if (snapshot.length === 0)
                return;
            await Promise.all(snapshot);
            const after = [...lanes.values()];
            const estavel = after.length === snapshot.length && after.every((p, i) => p === snapshot[i]);
            if (estavel)
                return;
        }
    }
    return { send, drain };
}
//# sourceMappingURL=outbox.js.map