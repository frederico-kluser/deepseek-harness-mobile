/**
 * `getUpdates` com `offset` CONFIRMA (apaga) os updates anteriores no servidor.
 *
 * Consequencia direta para o onboarding de T4.1: se o CLI fizer o seu proprio `getUpdates`
 * para ler o `/parear <codigo>` enquanto o worker de polling esta a correr, os dois
 * consomem da MESMA fila e cada update chega a exatamente um deles. O update que o CLI
 * confirmar desaparece para o worker, e vice-versa. Nao e um bug de qualquer um dos dois:
 * e a semantica da fila.
 *
 * Corre contra o servidor falso — zero dependencias, zero rede externa, zero token:
 *   node scripts/spike/telegram/offset-confirma-e-apaga.mjs
 *
 * A semantica reproduzida aqui vem de duas fontes primarias que concordam:
 *
 *   doc oficial, https://core.telegram.org/bots/api#getupdates, parametro `offset`:
 *     "An update is considered confirmed as soon as getUpdates is called with an offset
 *      higher than its update_id. The negative offset can be specified to retrieve updates
 *      starting from -offset update from the end of the updates queue. All previous updates
 *      will be forgotten."
 *
 *   fonte do servidor, tdlib/telegram-bot-api, Client.cpp `do_get_updates` (linha 17450):
 *     if (offset < 0) { auto deleted_events = tqueue->clear(tqueue_id_, -offset); ... }
 */

import { startFakeBotApi, fakeMessageUpdate } from './fake-bot-api.mjs';

const linha = (t) => process.stdout.write(`${t}\n`);

const pendentes = [
  fakeMessageUpdate({ updateId: 10, text: '/ligar' }),
  fakeMessageUpdate({ updateId: 11, text: '/status' }),
  fakeMessageUpdate({ updateId: 12, text: '/parear 123456' }),
];

const srv = await startFakeBotApi({ pending: pendentes });
const chamar = async (params) => {
  const url = new URL(`${srv.apiRoot}/bot123456789:${'X'.repeat(35)}/getUpdates`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url);
  return (await r.json()).result;
};

linha(`fila inicial no servidor: ${srv.state.pending.map((u) => u.update_id).join(', ')}`);
linha('');

linha('1) CONSUMIDOR A faz getUpdates(offset=0) — le tudo, confirma nada');
let r = await chamar({ offset: 0, timeout: 0 });
linha(`   recebeu update_id: ${r.map((u) => u.update_id).join(', ')}`);
linha(`   fila no servidor:  ${srv.state.pending.map((u) => u.update_id).join(', ')}`);
linha('');

linha('2) CONSUMIDOR A confirma ate ao 11: getUpdates(offset=12)');
r = await chamar({ offset: 12, timeout: 0 });
linha(`   recebeu update_id: ${r.map((u) => u.update_id).join(', ') || '(nenhum novo alem do 12)'}`);
linha(`   fila no servidor:  ${srv.state.pending.map((u) => u.update_id).join(', ')}`);
linha('   -> 10 e 11 sumiram do servidor. Um CONSUMIDOR B nunca mais os vera.');
linha('');

linha('3) CONSUMIDOR B chega agora e faz getUpdates(offset=0)');
r = await chamar({ offset: 0, timeout: 0 });
linha(`   recebeu update_id: ${r.map((u) => u.update_id).join(', ') || '(vazio)'}`);
linha('   -> B perdeu /ligar e /status. Foram confirmados por A.');
linha('');

linha('4) DESCARTE DA FILA no boot sem deleteWebhook: getUpdates(offset=-1)');
srv.state.pending = [
  fakeMessageUpdate({ updateId: 20, text: '/ligar' }),
  fakeMessageUpdate({ updateId: 21, text: '/ligar' }),
  fakeMessageUpdate({ updateId: 22, text: '/desligar' }),
];
linha(`   fila represada: ${srv.state.pending.map((u) => u.update_id).join(', ')}`);
r = await chamar({ offset: -1, timeout: 0 });
linha(`   getUpdates(offset=-1) devolveu: ${r.map((u) => u.update_id).join(', ')}`);
linha(`   fila no servidor apos:          ${srv.state.pending.map((u) => u.update_id).join(', ')}`);
linha('   -> offset negativo mantem os -offset ultimos e ESQUECE todos os anteriores.');
linha('   -> ainda e preciso confirmar o ultimo (offset = update_id + 1) para a fila ficar vazia.');
r = await chamar({ offset: 23, timeout: 0 });
linha(`   apos getUpdates(offset=23): fila = ${srv.state.pending.map((u) => u.update_id).join(', ') || '(vazia)'}`);

await srv.close();
