/**
 * O ADAPTADOR TELEGRAM: `createTelegramProvider(deps) -> ProviderAdapter`.
 * Consome SO o contrato neutro `worker/surface/contract.ts` (e, como
 * referencia de consumo, `worker/surface/core.ts`); o grammY vive
 * EXCLUSIVAMENTE neste diretorio.
 *
 * ===========================================================================
 * A DIVISAO (D4)
 * ===========================================================================
 * ENTRADA: o adaptador e DONO do SEU proprio loop de consumo (long polling) e
 * EMPURRA {@link SurfaceEvent} para o handler que o nucleo lhe passa em
 * `start(handleEvent)`. SAIDA: `sender()` fornece o {@link SurfaceSender}
 * neutro com que o nucleo envia/edita/responde. O nucleo NAO conhece o polling
 * nem o grammY.
 *
 * O adaptador NORMALIZA NUMERICO NA FRONTEIRA (D4): `chatKey`/`userKey` sao
 * STRINGS neutras e o sender entrega-as AS MESMAS ao grammY — a Bot API aceita
 * `chat_id` como string (`@username` ou numerico) e o id do update ja nasceu
 * string no parse. O antigo `Number(chatKey)` da fronteira de saida (heranca
 * do envelope IPC V1) foi removido na EMENDA ONDA-1-IPC-ENVELOPE-STRING: o
 * `Number(...)` so resta onde a API exige inteiro (`message_id`), que e uma
 * conversao de EDGE, nao de envelope.
 *
 * ===========================================================================
 * LIMITES — o que o nucleo usa para cortar e renderizar
 * ===========================================================================
 * maxTextLength 4096 (mensagem), maxActionRows 1 e maxActionPerRow 1 (os
 * teclados deste bot sao UMA linha de UM botao em cada confirmacao),
 * maxActionDataBytes 64 (o `callback_data` do Telegram, EM BYTES),
 * supportsEditing true (`editMessageText` existe).
 */
import { createTelegramBot } from "./cliente.js";
import { describeForLog, ProviderError, systemTime, WORKER_EXIT } from "./interno.js";
import { criarParse } from "./parse.js";
import { ALLOWED_UPDATES, LONG_POLL_MAX_TIMEOUT, runPolling } from "./polling.js";
import { answerCallbackAlways, editMessageTextInPlace, renderActionRowLayout } from "./teclado.js";
/** Limites do provedor telegram (D4). O nucleo corta/renderiza por aqui. */
export const TELEGRAM_LIMITS = Object.freeze({
    maxTextLength: 4096,
    maxActionRows: 1,
    maxActionPerRow: 1,
    maxActionDataBytes: 64,
    supportsEditing: true,
});
/**
 * Cria o PROVIDER telegram — a superficie completa que o boot da Onda 4 consome.
 *
 * @throws {Error} `TOKEN_MISSING` quando o token e vazio (o boot deve VALIDAR
 *   com `lerTokenDoAmbiente` e `assertTokenNotInArgv` de `./token.ts` ANTES).
 */
export function createTelegramProvider(deps) {
    const time = deps.time ?? systemTime;
    const log = deps.log;
    const token = deps.token.trim();
    if (token === '') {
        // O erro do `create` carrega o `code` NUMERICO do CONTRATO COMUM (10 =
        // CONFIG): o boot classifica por `code` e sem ele este erro cairia em
        // «falha nao classificada» (13). Espelha o `TOKEN_MISSING` do
        // `createTelegramBot`/`lerTokenDoAmbiente`.
        throw new ProviderError(WORKER_EXIT.CONFIG, 'TOKEN_MISSING', 'token vazio: nao ha bot para construir (valide antes com lerTokenDoAmbiente)');
    }
    const secretsOf = () => [token];
    // Estado vivo do loop — criado no `start()`, encerrado no `stop()`.
    let bot;
    let tarefaPolling;
    let handleEvent;
    const parse = criarParse();
    /** O middleware do grammY: update cru -> SurfaceEvent -> handleEvent. */
    function instalarHandlers(novoBot) {
        const tratar = async (ctx) => {
            const evento = parse.mapear(ctx.update);
            if (evento === undefined)
                return;
            if (handleEvent === undefined)
                return;
            try {
                await handleEvent(evento);
            }
            catch (error) {
                // S4: uma falha de entrega nao pode matar o polling. Registar e seguir.
                // S3: o texto de terceiros passa SEMPRE por `describeForLog` — este
                // `detail` era a UNICA saida de log do adaptador sem mascaramento, e um
                // erro cuja mensagem interpolasse o token (ou o nonce opaco, S5) sairia
                // cru para o log do host.
                log.error('falha ao entregar evento da superficie ao nucleo', {
                    kind: evento.kind,
                    detail: describeForLog(error, secretsOf()),
                });
            }
        };
        novoBot.on('message', tratar);
        novoBot.on('callback_query', tratar);
    }
    /** Constrói e configura o bot do grammY (client + transformers + catch). */
    function criarBot() {
        const options = {
            token,
            log,
            time,
            ...(deps.apiRoot === undefined ? {} : { apiRoot: deps.apiRoot }),
        };
        // `createTelegramBot` ja instala transporte+auto-retry e o `bot.catch` com
        // a ordem certa; aqui nao se volta a mexer (nao duplicar transformers).
        return createTelegramBot(options);
    }
    /** Constrói o {@link SurfaceSender} NEUTRO sobre a `ApiDoBot`. */
    function criarSender() {
        function botAtual() {
            const b = bot;
            if (b === undefined)
                throw new Error('sender usado antes do start() — o bot ainda nao existe');
            return b;
        }
        function markupPara(opcoes) {
            const saida = {};
            if (opcoes?.actionRows !== undefined) {
                const markup = renderActionRowLayout(opcoes.actionRows, log);
                if (markup !== undefined)
                    saida.reply_markup = markup;
            }
            if (opcoes?.disableWebPagePreview === true)
                saida.disable_web_page_preview = true;
            return saida;
        }
        return {
            async send(chatKey, texto, opcoes) {
                const api = botAtual().api;
                const extra = { ...markupPara(opcoes) };
                // `chatKey` ja e string (D4 + V2): sem `Number(...)` — a Bot API aceita
                // o id numerico em formato string, e um provedor futuro nao-numerico
                // nao pode ser truncado aqui.
                const r = await api.sendMessage(chatKey, texto, extra);
                // `sendMessage` devolve `message_id`; resolve com o id STRING (D4).
                return String(r.message_id);
            },
            async edit(chatKey, messageId, texto, opcoes) {
                const api = botAtual().api;
                // `chatKey` em string (V2); `messageId` e o id da MENSAGEM (nao e eixo
                // de identidade): a Bot API exige inteiro, logo o `Number(...)` fica —
                // e conversao de EDGE para o formato da API, como o `String(...)` do
                // parse na entrada.
                const alvo = { chatId: chatKey, messageId: Number(messageId) };
                // CONTRATO §4 Regra 2 / §5 Regra 5: editar sem `actionRows` DESTROI o
                // teclado (anti duplo-toque; o resultado apos a accao fica sem botoes).
                // O Telegram PRESERVA o reply_markup se nao for passado, por isso um
                // vazio explicito (`inline_keyboard: []`) e o unico modo fiel.
                const markup = opcoes?.actionRows === undefined
                    ? { inline_keyboard: [] }
                    : renderActionRowLayout(opcoes.actionRows, log);
                const outcome = await editMessageTextInPlace(api, alvo, texto, log, markup === undefined ? undefined : markup);
                return outcome;
            },
            async answer(answerTarget, outras) {
                const api = botAtual().api;
                return answerCallbackAlways(api, answerTarget, log, outras);
            },
        };
    }
    const sender = criarSender();
    return {
        id: 'telegram',
        limits: TELEGRAM_LIMITS,
        async start(handler) {
            handleEvent = handler;
            const novoBot = criarBot();
            bot = novoBot;
            instalarHandlers(novoBot);
            const tasksPromise = runPolling({
                bot: novoBot,
                log,
                options: {
                    timeout: LONG_POLL_MAX_TIMEOUT,
                    allowed_updates: ALLOWED_UPDATES,
                    drop_pending_updates: true,
                    limit: 100,
                    onStart: async () => undefined,
                },
                secrets: secretsOf,
            });
            tarefaPolling = tasksPromise;
            // `runPolling` corre `bot.start()` (getMe -> deleteWebhook -> getUpdates).
            // O outcome `stopped` chega quando `bot.start()` resolve (o arranque
            // terminou — onStart do grammY); `fatal` quando `bot.start()` rejeita.
            //
            // Por que AWAIT do outcome e nao um `boot` resolvido no onStart:
            // o onStart do grammY fire ANTES do primeiro `getUpdates` — nos casos
            // 409/401 enfileirados em `getUpdates`, `bot.start()` REJEITA DEPOIS de o
            // onStart ja ter rodado. Um `start()` que confiasse numa promessa resolvida
            // no onStart devolveria "boot concluido" e o processo ficaria pendurado a
            // ver o polling morrer. Aguardar o outcome FATAL do `runPolling` (que e o
            // `bot.start()` rejeitado, ja classificado) faz `start()` rejeitar e o
            // host termina com 11/12 — o e2e 409/401 depende disto.
            const resultado = await tasksPromise;
            if (resultado.kind === 'fatal')
                throw resultado.error;
        },
        async stop() {
            handleEvent = undefined;
            const atual = bot;
            bot = undefined;
            if (atual !== undefined)
                await atual.stop();
            if (tarefaPolling !== undefined)
                await tarefaPolling.catch(() => undefined);
        },
        async publishCommands(comandos) {
            const atual = bot;
            if (atual === undefined) {
                log.warn('publishCommands antes do start: sem bot para publicar');
                return undefined;
            }
            // CONTRATO §2: scopes de `setMyCommands`. A descoberta segura para toda a
            // gente (default = grupos e privado) e so `/ajuda` (e `/start`, que nao sai
            // no menu — PAIR-006); as acoes de mantenimento do tunel vivem SO como
            // botões do cartao (`/menu`). ONDA-1-NOME-E-BOTOES (Tarefa 3): `status` e
            // `emergencia` saem do menu; `/menu` e `/parear` vao ao PRIVATE (so DM).
            const scopeDefault = ['ajuda'];
            const scopePrivate = ['menu', 'parear', 'ajuda'];
            const conhecidas = new Set([...scopeDefault, ...scopePrivate]);
            const total = comandos.map((c) => ({ command: c.command, description: c.description }));
            // Se alguem passar uma lista fora do mapa de scopes (ex.: testes com
            // comandos a custume), publicar TUDO num unico `setMyCommands` sem escopo —
            // nunca cair em silencio (caso real: 78 comandos quebram em silencio).
            if (!comandos.every((c) => conhecidas.has(c.command))) {
                return atual.api.setMyCommands(total);
            }
            const porNome = (nomes) => comandos.filter((c) => nomes.includes(c.command)).map((c) => ({ command: c.command, description: c.description }));
            const defaultCmds = porNome(scopeDefault);
            const privateCmds = porNome(scopePrivate);
            if (defaultCmds.length > 0) {
                await atual.api.setMyCommands(defaultCmds, { scope: { type: 'default' } });
            }
            if (privateCmds.length > 0) {
                await atual.api.setMyCommands(privateCmds, { scope: { type: 'all_private_chats' } });
            }
            return undefined;
        },
        sender: () => sender,
        descartados: () => parse.descartados(),
    };
}
//# sourceMappingURL=adapter.js.map