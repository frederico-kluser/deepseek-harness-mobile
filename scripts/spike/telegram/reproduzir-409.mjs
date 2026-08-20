/**
 * REPRODUZ o 409 de polling duplicado — nao o cita.
 *
 * Um token real nao esta disponivel nesta maquina, entao o conflito e reproduzido contra
 * um servidor que implementa a MESMA maquina de estados do servidor oficial, transcrita de
 * `tdlib/telegram-bot-api/telegram-bot-api/Client.cpp`:
 *
 *   Client.cpp `do_get_updates` (linha 17511):
 *       if (timeout != 0 && updates.size() == 0) { abort_long_poll(false); long_poll_query_ = ...; }
 *   Client.cpp `abort_long_poll` (linha 17349-17359):
 *       message = "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"
 *       fail_query_conflict(message, std::move(long_poll_query_));
 *   Client.cpp `fail_query_conflict` (linha 17362-17376):
 *       fail_query(409, message, ...) imediato SO 1x a cada 3 s; as restantes esperam 3 s.
 *
 * Consequencia que so fica visivel reproduzindo: o 409 vai para o long poll ANTIGO (o que ja
 * estava pendurado), NAO para o pedido novo. Quem chega por ultimo ganha; quem estava
 * primeiro morre. Num supervisor que reinicia, isso e flapping infinito entre duas instancias.
 *
 * Uso: ver o cabecalho de `s5-s8-grammy-contra-fake.mjs` (precisa de SPIKE_GRAMMY_PATH).
 */

import { createServer } from 'node:http';
import { once } from 'node:events';

const CONFLITO = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';

const linha = (t) => process.stdout.write(`${t}\n`);

/** Servidor com a semantica de conflito do servidor oficial. */
async function servidorComConflito() {
  let longPollPendente = null; // { res, marca }
  let proximoConflitoImediato = 0; // espelha `next_get_updates_conflict_time_`
  const eventos = [];

  function falharComConflito(pendente) {
    const agora = Date.now();
    const corpo = JSON.stringify({ ok: false, error_code: 409, description: CONFLITO });
    const enviar = () => {
      eventos.push({ t: Date.now(), evento: '409 enviado', para: pendente.marca });
      pendente.res.writeHead(409, { 'content-type': 'application/json' });
      pendente.res.end(corpo);
    };
    if (agora >= proximoConflitoImediato) {
      proximoConflitoImediato = agora + 3000;
      enviar();
    } else {
      setTimeout(enviar, 3000); // throttle de 3 s do servidor oficial
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/bot([^/]+)\/([A-Za-z_]+)$/.exec(url.pathname);
    if (m === null) { res.writeHead(404).end('{"ok":false,"error_code":404,"description":"Not Found"}'); return; }
    const metodo = m[2].toLowerCase();
    const marca = url.searchParams.get('marca') ?? req.headers['x-marca'] ?? '?';

    if (metodo === 'getme') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { id: 1000000001, is_bot: true, first_name: 'Fake', username: 'fake_bot' } }));
      return;
    }
    if (metodo === 'deletewebhook' || metodo === 'setmycommands') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"result":true}');
      return;
    }
    if (metodo === 'getupdates') {
      eventos.push({ t: Date.now(), evento: 'getUpdates recebido', de: marca });
      // fila sempre vazia => o pedido fica pendurado, exatamente como do_get_updates.
      if (longPollPendente !== null) {
        eventos.push({ t: Date.now(), evento: 'abort_long_poll do pendente', vitima: longPollPendente.marca });
        falharComConflito(longPollPendente);
        longPollPendente = null;
      }
      longPollPendente = { res, marca };
      res.on('close', () => { if (longPollPendente?.res === res) longPollPendente = null; });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"result":true}');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { apiRoot: `http://127.0.0.1:${port}`, eventos, close: async () => { server.close(); } };
}

const especificador = process.env.SPIKE_GRAMMY_PATH ?? 'grammy';
let grammy;
try { grammy = await import(especificador); }
catch (e) {
  process.stderr.write(`grammY nao resolvivel (${especificador}). Ver s5-s8-grammy-contra-fake.mjs.\n`);
  process.exit(2);
}
const { Bot, GrammyError } = grammy;

const TOKEN_FALSO = ['123456789', 'X'.repeat(35)].join(':');
const srv = await servidorComConflito();
linha(`servidor com semantica de conflito em ${srv.apiRoot}`);

/** Marca cada instancia no query string para se ver QUEM levou o 409. */
function fazBot(marca) {
  return new Bot(TOKEN_FALSO, {
    client: {
      apiRoot: srv.apiRoot,
      buildUrl: (raiz, token, metodo) => `${raiz}/bot${token}/${metodo}?marca=${marca}`,
    },
  });
}

const primeira = fazBot('instancia-A');
const segunda = fazBot('instancia-B');
primeira.on('message', () => {});
segunda.on('message', () => {});

const erros = {};
const p1 = primeira.start({ timeout: 30 }).catch((e) => { erros.A = e; });
await new Promise((r) => setTimeout(r, 600)); // deixa A pendurar o long poll
const p2 = segunda.start({ timeout: 30 }).catch((e) => { erros.B = e; });

await Promise.race([Promise.all([p1, p2]), new Promise((r) => setTimeout(r, 6000))]);

linha('');
linha('--- linha do tempo no servidor ---');
const t0 = srv.eventos[0]?.t ?? Date.now();
for (const e of srv.eventos) linha(`  +${String(e.t - t0).padStart(5)} ms  ${e.evento}${e.de ? ` de=${e.de}` : ''}${e.vitima ? ` vitima=${e.vitima}` : ''}${e.para ? ` para=${e.para}` : ''}`);

linha('');
linha('--- quem morreu ---');
for (const [nome, err] of Object.entries(erros)) {
  linha(`  instancia-${nome}: ${err?.constructor?.name} error_code=${err?.error_code} method=${err?.method}`);
  linha(`     description: ${err?.description}`);
  linha(`     instanceof GrammyError: ${err instanceof GrammyError}`);
}
linha(`  A ainda a correr? ${primeira.isRunning()}    B ainda a correr? ${segunda.isRunning()}`);
linha('');
linha('CONCLUSAO: o 409 mata a instancia que JA estava pendurada (a primeira), nao a que chegou.');

await primeira.stop().catch(() => {});
await segunda.stop().catch(() => {});
await srv.close();
process.exit(0);
