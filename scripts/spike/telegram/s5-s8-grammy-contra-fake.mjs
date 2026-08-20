/**
 * MEDICAO REAL de S5 e S8 — o grammY 1.45.1 apontado para o servidor Bot API FALSO
 * de `fake-bot-api.mjs`, sem token valido, sem rede externa.
 *
 *   S5 — `apiRoot` redireciona MESMO as chamadas para um servidor local?
 *   S8 — para que chamada de rede o grammY traduz `bot.start({ drop_pending_updates })`?
 *
 * O grammY NAO e dependencia deste repositorio nesta onda (D23: entra so em T4.2).
 * Para correr este script, instale-o num diretorio DESCARTAVEL e aponte o caminho:
 *
 *   mkdir -p /tmp/spike-grammy && cd /tmp/spike-grammy \
 *     && npm init -y >/dev/null && npm pkg set type=module \
 *     && npm i grammy@1.45.1
 *   SPIKE_GRAMMY_PATH=/tmp/spike-grammy/node_modules/grammy/out/mod.js \
 *     node scripts/spike/telegram/s5-s8-grammy-contra-fake.mjs
 *
 * Sem `SPIKE_GRAMMY_PATH` o script tenta o especificador nu `grammy` e, se falhar,
 * sai com a instrucao acima e status 2 — nunca finge ter medido.
 */

import { startFakeBotApi, CANONICAL_ERRORS, fakeMessageUpdate } from './fake-bot-api.mjs';

const especificador = process.env.SPIKE_GRAMMY_PATH ?? 'grammy';
let grammy;
try {
  grammy = await import(especificador);
} catch (erro) {
  process.stderr.write(`grammY nao resolvivel a partir de ${especificador}\n`);
  process.stderr.write(String(erro instanceof Error ? erro.message : erro) + '\n');
  process.stderr.write('Ver o cabecalho deste ficheiro: instale grammy@1.45.1 num diretorio descartavel\n');
  process.stderr.write('e exporte SPIKE_GRAMMY_PATH. NAO adicione grammy ao package.json nesta onda (D23).\n');
  process.exit(2);
}
const { Bot, GrammyError, InlineKeyboard } = grammy;

/** Token de FORMA valida, sem conta associada. Nao casa com o regex de token do aceite. */
const TOKEN_FALSO = ['123456789', 'X'.repeat(35)].join(':');

const linha = (t) => process.stdout.write(`${t}\n`);
const jsonl = (r) => linha(`    ${JSON.stringify(r)}`);

// ---------------------------------------------------------------- S5
linha('===== S5 — apiRoot aponta mesmo para servidor local? =====');
{
  const srv = await startFakeBotApi();
  linha(`  fake Bot API em ${srv.apiRoot}`);
  const bot = new Bot(TOKEN_FALSO, { client: { apiRoot: srv.apiRoot } });
  const me = await bot.api.getMe();
  linha('  bot.api.getMe() devolveu:');
  jsonl(me);
  linha('  chamadas que chegaram ao servidor LOCAL:');
  for (const c of srv.calls) jsonl({ method: c.method, payload: c.payload });
  linha(`  RESULTADO: ${srv.calls.length > 0 ? 'as chamadas foram REDIRECIONADAS para o apiRoot local' : 'NADA chegou ao servidor local'}`);

  // Barra final e rejeitada — comportamento explicito de out/core/client.js:86-87.
  let erroBarra = null;
  try { new Bot(TOKEN_FALSO, { client: { apiRoot: `${srv.apiRoot}/` } }); }
  catch (e) { erroBarra = e instanceof Error ? e.message : String(e); }
  linha(`  apiRoot com barra final -> ${erroBarra ?? '(sem erro)'}`);
  await srv.close();
}

// ---------------------------------------------------------------- S8
linha('');
linha('===== S8 — em que chamada de rede o grammY traduz drop_pending_updates? =====');
{
  const srv = await startFakeBotApi();
  const bot = new Bot(TOKEN_FALSO, { client: { apiRoot: srv.apiRoot } });
  bot.on('message', () => {});
  // `bot.start()` nunca resolve (long polling). Deixa-lo correr e parar depois.
  void bot.start({ drop_pending_updates: true, allowed_updates: ['message', 'callback_query'], timeout: 1 })
    .catch((e) => linha(`  bot.start rejeitou: ${e instanceof Error ? e.message : String(e)}`));
  await new Promise((r) => setTimeout(r, 1200));
  await bot.stop();
  linha('  sequencia EXATA de chamadas observada no servidor local (primeiras 6):');
  for (const c of srv.calls.slice(0, 6)) jsonl({ method: c.method, payload: c.payload });
  linha(`  (total de chamadas: ${srv.calls.length})`);
  const temNoDeleteWebhook = srv.calls.some((c) => c.method === 'deletewebhook' && String(c.payload.drop_pending_updates) === 'true');
  const temNoGetUpdates = srv.calls.some((c) => c.method === 'getupdates' && 'drop_pending_updates' in c.payload);
  linha(`  drop_pending_updates chegou em deleteWebhook? ${temNoDeleteWebhook}`);
  linha(`  drop_pending_updates chegou em getUpdates?    ${temNoGetUpdates}`);
  await srv.close();
}

// ---------------------------------------------------------------- 409
linha('');
linha('===== 409 de polling duplicado — reacao do CLIENTE ao corpo canonico =====');
{
  const srv = await startFakeBotApi();
  srv.queueError('getUpdates', CANONICAL_ERRORS.conflictOtherGetUpdates);
  const bot = new Bot(TOKEN_FALSO, { client: { apiRoot: srv.apiRoot } });
  bot.on('message', () => {});
  let capturado = null;
  await bot.start({ timeout: 1 }).catch((e) => { capturado = e; });
  linha(`  classe do erro: ${capturado?.constructor?.name}`);
  linha(`  instanceof GrammyError: ${capturado instanceof GrammyError}`);
  linha(`  error_code: ${capturado?.error_code}`);
  linha(`  description: ${capturado?.description}`);
  linha(`  method: ${capturado?.method}`);
  linha(`  bot.isRunning() apos o 409: ${bot.isRunning()}`);
  await srv.close();
}

// ---------------------------------------------------------------- 429
linha('');
linha('===== 429 com retry_after — o parametro sobrevive ate ao GrammyError? =====');
{
  const srv = await startFakeBotApi();
  srv.queueError('sendMessage', CANONICAL_ERRORS.tooManyRequests);
  const bot = new Bot(TOKEN_FALSO, { client: { apiRoot: srv.apiRoot } });
  try {
    await bot.api.sendMessage(777000123, 'oi');
  } catch (e) {
    linha(`  instanceof GrammyError: ${e instanceof GrammyError}`);
    linha(`  error_code=${e.error_code}  parameters=${JSON.stringify(e.parameters)}`);
  }
  await srv.close();
}

// ---------------------------------------------------------------- S7
linha('');
linha('===== S7 — o grammY serializa InlineKeyboardButton.style no fio? =====');
{
  const srv = await startFakeBotApi();
  const bot = new Bot(TOKEN_FALSO, { client: { apiRoot: srv.apiRoot } });
  const teclado = new InlineKeyboard()
    .text('Ligar', 'srv:on:v1').success()
    .text('Desligar', 'srv:off:v1').danger();
  linha(`  objeto construido: ${JSON.stringify(teclado.inline_keyboard)}`);
  await bot.api.sendMessage(777000123, 'estado', { reply_markup: teclado });
  const enviada = srv.calls.find((c) => c.method === 'sendmessage');
  linha('  payload que saiu no fio:');
  jsonl(enviada?.payload);
  await srv.close();
}

// ---------------------------------------------------------------- from.id vs chat.id
linha('');
linha('===== from.id E chat.id — os dois ids que a allowlist de T4.4 tem de validar =====');
{
  const u = fakeMessageUpdate({ updateId: 1, fromId: 777000123, chatId: 777000123, text: '/parear 123456' });
  linha(`  message.from.id = ${u.message.from.id}   (o USUARIO)`);
  linha(`  message.chat.id = ${u.message.chat.id}   (a CONVERSA)`);
  linha('  em chat privado coincidem por construcao — e por isso que validar so um passa despercebido.');
}
