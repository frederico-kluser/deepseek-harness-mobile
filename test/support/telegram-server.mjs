/**
 * Servidor Bot API falso. PREP-OWNED: leitura livre, escrita proibida (PREP 2).
 *
 * PROVENIENCIA: copiado de `scripts/spike/telegram/fake-bot-api.mjs`, construido e
 * medido na Onda 0 (T0.3) contra o grammY real apontado por `apiRoot`. Implementa
 * long polling que SEGURA a resposta, `queueError()` para 409/429, os
 * `CANONICAL_ERRORS` copiados verbatim de `Client.cpp` do tdlib/telegram-bot-api,
 * e builders de update COM e SEM `message.from` (o caso de channel post, que a
 * allowlist de T4.4 tem de tratar como negacao).
 *
 * MEDIDO: o 409 mata a instancia ANTIGA, nao a que chega — quem chega por ultimo
 * ganha. Um supervisor que reinicie cegamente entra em flapping infinito.
 */
/**
 * Servidor Bot API FALSO, minimo — insumo direto de `test/support/telegram-server.ts` (T6.2).
 *
 * Porque existe: fechar S5 (`apiRoot` do grammY) e exercitar caminhos de erro
 * (409 de polling duplicado, 429 com `retry_after`) sem token, sem rede externa
 * e sem tocar em `api.telegram.org`.
 *
 * Contrato replicado da Bot API real (core.telegram.org/bots/api, "Making requests"):
 *   - caminho: `/bot<token>/<METHOD_NAME>` (metodos sao case-insensitive);
 *   - sucesso: `{"ok":true,"result":<...>}` com HTTP 200;
 *   - erro:    `{"ok":false,"error_code":<n>,"description":"<...>"}` com HTTP == error_code,
 *              e `parameters` opcional (ResponseParameters, ex.: `retry_after`).
 *
 * Node puro, ESM, zero dependencias.
 *
 * Uso programatico:
 *   const srv = await startFakeBotApi();
 *   srv.apiRoot   // -> "http://127.0.0.1:<porta>"  (sem barra final: o grammY rejeita)
 *   srv.calls     // -> [{ token, method, payload }, ...] na ordem em que chegaram
 *   srv.queueError('getUpdates', { error_code: 409, description: '...' })
 *   await srv.close();
 *
 * Uso standalone:
 *   node scripts/spike/telegram/fake-bot-api.mjs           # porta efemera
 *   FAKE_BOT_API_PORT=8081 node scripts/spike/telegram/fake-bot-api.mjs
 */

import { createServer } from 'node:http';
import { once } from 'node:events';

/** Resposta canonica de `getMe` — `User` com `is_bot: true` (UserFromGetMe). */
export const FAKE_BOT_USER = Object.freeze({
  id: 1000000001,
  is_bot: true,
  first_name: 'DSH Spike Bot',
  username: 'dsh_spike_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
});

/**
 * Update de exemplo com AMBOS os ids que a allowlist de T4.4 tem de validar:
 * `message.from.id` (o usuario) e `message.chat.id` (a conversa). Em chat privado
 * eles coincidem por construcao — o que e exatamente a armadilha que faz alguem
 * validar so um dos dois. Ver A-12 em `05-QUALIDADE-CODIGO.md`.
 */
export function fakeMessageUpdate({ updateId = 1, fromId = 777000123, chatId = 777000123, text = '/start' } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_800_000_000,
      from: { id: fromId, is_bot: false, first_name: 'Dono', username: 'dono_mutavel' },
      chat: { id: chatId, type: 'private', first_name: 'Dono', username: 'dono_mutavel' },
      text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [],
    },
  };
}

/**
 * Update de channel_post: `message.from` AUSENTE. Tem de ser NEGACAO na allowlist
 * (`03-ONDAS.md` T4.4). A doc oficial marca `Message.from` como
 * "Optional. Sender of the message; may be empty for messages sent to channels."
 */
export function fakeChannelPostUpdate({ updateId = 2, chatId = -1001234567890 } = {}) {
  return {
    update_id: updateId,
    channel_post: {
      message_id: updateId,
      date: 1_800_000_000,
      chat: { id: chatId, type: 'channel', title: 'Canal' },
      text: '/ligar',
    },
  };
}

/** Respostas felizes por metodo (chave em minusculas — a Bot API e case-insensitive). */
function defaultResult(method, payload, state) {
  switch (method) {
    case 'getme':
      return FAKE_BOT_USER;
    case 'deletewebhook':
    case 'setwebhook':
    case 'setmycommands':
    case 'deletemycommands':
      return true;
    case 'getupdates': {
      // `offset` positivo CONFIRMA (apaga) os updates anteriores no servidor;
      // `offset` negativo descarta a fila e mantem apenas os `-offset` ultimos.
      // Espelha `do_get_updates` de tdlib/telegram-bot-api/Client.cpp.
      const offset = Number(payload?.offset ?? 0);
      if (offset < 0) {
        state.pending = state.pending.slice(-Math.abs(offset));
      } else if (offset > 0) {
        state.pending = state.pending.filter((u) => u.update_id >= offset);
      }
      const batch = state.pending.slice(0, Number(payload?.limit ?? 100));
      return batch;
    }
    case 'sendmessage':
    case 'editmessagetext':
      return {
        message_id: ++state.messageId,
        date: 1_800_000_000,
        chat: { id: Number(payload?.chat_id ?? 0), type: 'private' },
        from: FAKE_BOT_USER,
        text: String(payload?.text ?? ''),
        ...(payload?.reply_markup ? { reply_markup: payload.reply_markup } : {}),
      };
    case 'answercallbackquery':
      return true;
    default:
      return true;
  }
}

/** Le o corpo e normaliza os quatro formatos de payload aceites pela Bot API. */
async function readPayload(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  if (raw === '') return {};
  if (type.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { __unparsed: raw }; }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { __raw: raw, __contentType: type };
}

export async function startFakeBotApi({ port = Number(process.env.FAKE_BOT_API_PORT ?? 0), pending = [] } = {}) {
  const calls = [];
  const errorQueue = new Map(); // metodo (minusculas) -> fila de erros a devolver
  const state = { messageId: 100, pending: [...pending] };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // `/bot<token>/<method>` — o token e o 1o segmento apos o prefixo "bot".
      const m = /^\/bot([^/]+)\/([A-Za-z_]+)$/.exec(url.pathname);
      if (m === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
        return;
      }
      const token = m[1];
      const method = m[2].toLowerCase();
      const body = await readPayload(req);
      const payload = { ...Object.fromEntries(url.searchParams), ...body };
      calls.push({ token, method, payload });

      const queued = errorQueue.get(method);
      if (queued !== undefined && queued.length > 0) {
        const err = queued.shift();
        const out = { ok: false, error_code: err.error_code, description: err.description };
        if (err.parameters !== undefined) out.parameters = err.parameters;
        res.writeHead(err.error_code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }

      const result = defaultResult(method, payload, state);

      // Long polling de verdade: `getUpdates` com `timeout > 0` e fila vazia SEGURA a
      // resposta ate ao prazo, como faz o servidor real (Client.cpp, do_get_updates:
      // `if (timeout != 0 && updates.size() == 0) { ... long_poll_query_ = ...; return; }`).
      // Sem isto o cliente entra em busy loop e o log fica ilegivel.
      const segundos = Number(payload?.timeout ?? 0);
      if (method === 'getupdates' && segundos > 0 && Array.isArray(result) && result.length === 0) {
        const t = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: [] }));
        }, Math.min(segundos, 50) * 1000);
        res.on('close', () => clearTimeout(t));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    })();
  });

  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;

  return {
    server,
    port: boundPort,
    // SEM barra final: o grammY lanca `Error: Remove the trailing '/' from the
    // 'apiRoot' option` (grammy 1.45.1, out/core/client.js:86-87).
    apiRoot: `http://127.0.0.1:${boundPort}`,
    calls,
    state,
    /** Enfileira UM erro para a proxima chamada do metodo indicado. */
    queueError(method, err) {
      const key = method.toLowerCase();
      if (!errorQueue.has(key)) errorQueue.set(key, []);
      errorQueue.get(key).push(err);
      return this;
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

/** Erros canonicos, copiados VERBATIM de tdlib/telegram-bot-api (Client.cpp). */
export const CANONICAL_ERRORS = Object.freeze({
  // Client.cpp:17356 + fail_query(409, ...) em Client.cpp:17365
  conflictOtherGetUpdates: {
    error_code: 409,
    description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
  },
  // Client.cpp:17353
  conflictSetWebhook: { error_code: 409, description: 'Conflict: terminated by setWebhook request' },
  // Client.cpp:16783-16785
  conflictWebhookActive: {
    error_code: 409,
    description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
  },
  // ClientManager.cpp:76 e :84 — identico ao medido contra api.telegram.org.
  unauthorized: { error_code: 401, description: 'Unauthorized: invalid token specified' },
  tooManyRequests: {
    error_code: 429,
    description: 'Too Many Requests: retry after 5',
    parameters: { retry_after: 5 },
  },
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const srv = await startFakeBotApi();
  process.stdout.write(`fake Bot API a escutar em ${srv.apiRoot}\n`);
  process.on('SIGINT', () => { void srv.close().then(() => process.exit(0)); });
}
