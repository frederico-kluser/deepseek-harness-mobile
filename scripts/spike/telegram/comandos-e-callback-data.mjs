/**
 * Duas verificacoes de forma que nao precisam de token e sao insumo de T5.2:
 *
 *  (a) `setMyCommands` — a forma EXATA do payload e a validacao dos sete comandos canonicos
 *      contra a restricao documentada de `BotCommand.command`:
 *        "Text of the command; 1-32 characters. Can contain only lowercase English letters,
 *         digits and underscores."  (https://core.telegram.org/bots/api#botcommand)
 *      Consequencias que o plano tem de absorver: o comando vai SEM a barra, e nao pode
 *      conter acento nem espaco — logo `/parear <codigo>` regista-se como `parear`, e o
 *      argumento vive na `description`, nunca no nome.
 *
 *  (b) `callback_data` — o limite e de 1-64 BYTES, nao caracteres
 *      (https://core.telegram.org/bots/api#inlinekeyboardbutton). Acento em UTF-8 consome 2.
 *      Ver A-13 em `05-QUALIDADE-CODIGO.md`.
 *
 * Corre sem dependencias e sem rede externa:
 *   node scripts/spike/telegram/comandos-e-callback-data.mjs
 */

import { startFakeBotApi } from './fake-bot-api.mjs';

const linha = (t) => process.stdout.write(`${t}\n`);

/**
 * Os sete comandos canonicos, nesta ordem (`03-ONDAS.md` T5.2).
 * `/start` existe como boas-vindas inocuo e NAO aparece aqui (D5, D8).
 */
const COMANDOS = [
  { command: 'ligar', description: 'Liga a exposicao (confirmacao em 2 etapas)' },
  { command: 'desligar', description: 'Desliga a exposicao imediatamente' },
  { command: 'status', description: 'Mostra o estado atual' },
  { command: 'acessar', description: 'Emite um link de acesso de uso unico' },
  { command: 'rotacionar', description: 'Rotaciona a credencial (confirmacao em 2 etapas)' },
  { command: 'parear', description: 'Pareia o dono: /parear seguido do codigo de 6 digitos' },
  { command: 'emergencia', description: 'Corta tudo agora, sem confirmacao' },
];

// (a) --------------------------------------------------------------------
linha('===== (a) setMyCommands =====');
const VALIDO = /^[a-z0-9_]{1,32}$/;
let todosValidos = true;
for (const c of COMANDOS) {
  const ok = VALIDO.test(c.command);
  const descOk = c.description.length >= 1 && c.description.length <= 256;
  if (!ok || !descOk) todosValidos = false;
  linha(`  ${ok ? 'OK  ' : 'FALHA'} command=${JSON.stringify(c.command)} (${c.command.length} chars)  description=${c.description.length} chars ${descOk ? '' : '<- fora de 1-256'}`);
}
linha(`  todos passam em /^[a-z0-9_]{1,32}$/ ? ${todosValidos}`);
linha('');
linha('  Contra-exemplos que a Bot API recusa (por isso o nome do comando nao leva argumento nem acento):');
for (const mau of ['/ligar', 'parear <codigo>', 'emergência', 'Ligar']) {
  linha(`    ${VALIDO.test(mau) ? 'passa' : 'RECUSADO'}  ${JSON.stringify(mau)}`);
}
linha('');

const srv = await startFakeBotApi();
const url = new URL(`${srv.apiRoot}/bot123456789:${'X'.repeat(35)}/setMyCommands`);
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  // `commands` e "A JSON-serialized list of bot commands" — nas libs que serializam o corpo
  // inteiro em JSON isto e um array; em x-www-form-urlencoded seria uma string JSON.
  body: JSON.stringify({ commands: COMANDOS }),
});
linha(`  POST setMyCommands -> HTTP ${res.status} ${JSON.stringify(await res.json())}`);
linha('  payload exato que saiu no fio:');
linha(`    ${JSON.stringify(srv.calls.at(-1).payload)}`);
await srv.close();

// (b) --------------------------------------------------------------------
linha('');
linha('===== (b) callback_data: 64 BYTES, nao 64 caracteres =====');
const NONCE = 'Zm9vYmFyMDE'; // ~11 chars, randomBytes(8).toString('base64url')
const casos = [
  'srv:on:v1',
  `srv:on:${NONCE}`,
  'a'.repeat(64),
  'a'.repeat(65),
  'emergência:sim', // com acento
  'é'.repeat(32), // 32 caracteres, 64 bytes
  'é'.repeat(33), // 33 caracteres, 66 bytes -> estoura
];
for (const d of casos) {
  const chars = [...d].length;
  const bytes = Buffer.byteLength(d, 'utf8');
  linha(`  ${bytes <= 64 ? 'cabe  ' : 'ESTOURA'} chars=${String(chars).padStart(3)} bytes=${String(bytes).padStart(3)}  ${JSON.stringify(d.length > 24 ? d.slice(0, 21) + '...' : d)}`);
}
linha('');
linha('  A ultima linha e a armadilha: 33 caracteres e so 33 "letras", mas 66 bytes.');
linha('  Um comprimento medido em .length passa e o Telegram recusa. Medir com Buffer.byteLength.');
