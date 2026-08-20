/**
 * Probe de `getMe` contra a Bot API REAL (`https://api.telegram.org`).
 *
 * Fecha a deteccao de estado de T4.1 (`SEM_TOKEN` / `TOKEN_INVALIDO` / `TOKEN_OK_SEM_DONO`).
 *
 * A-8 (`05-QUALIDADE-CODIGO.md`): o token entra SO por variavel de ambiente.
 * NUNCA por `argv` — `/proc/<pid>/cmdline` e legivel por qualquer processo local.
 *
 * Sem `TELEGRAM_BOT_TOKEN` definido, o script ainda mede algo real: o formato
 * exato do erro que a Bot API devolve a um token invalido. Isso nao exige conta
 * de Telegram nem bot registado.
 *
 * Uso:
 *   node scripts/spike/telegram/probe-getme.mjs                 # so os probes negativos
 *   TELEGRAM_BOT_TOKEN=... node scripts/spike/telegram/probe-getme.mjs
 *
 * O script NUNCA imprime o token — nem inteiro, nem mascarado.
 */

const API_ROOT = process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';

/** Token com a FORMA de um token, mas sem conta associada. Nao e segredo de ninguem. */
const TOKEN_INEXISTENTE = ['000000000', 'A'.repeat(35)].join(':');
/** Token que nem sequer tem a forma `<id>:<segredo>`. */
const TOKEN_MALFORMADO = 'INVALID';

async function call(token, method, params = {}) {
  const url = new URL(`${API_ROOT}/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const started = Date.now();
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { __naoJson: text.slice(0, 200) }; }
  return { status: res.status, ms: Date.now() - started, json };
}

function report(rotulo, r) {
  process.stdout.write(`--- ${rotulo}\n`);
  process.stdout.write(`    HTTP ${r.status}  (${r.ms} ms)\n`);
  process.stdout.write(`    ${JSON.stringify(r.json)}\n`);
}

process.stdout.write(`apiRoot = ${API_ROOT}\n\n`);

report('getMe com token BEM-FORMADO mas inexistente', await call(TOKEN_INEXISTENTE, 'getMe'));
report('getMe com token MALFORMADO (sem ":")', await call(TOKEN_MALFORMADO, 'getMe'));
report('getUpdates(offset=-1, timeout=0) com token inexistente', await call(TOKEN_INEXISTENTE, 'getUpdates', { offset: -1, timeout: 0 }));

const real = process.env.TELEGRAM_BOT_TOKEN;
if (real === undefined || real === '') {
  process.stdout.write('\nTELEGRAM_BOT_TOKEN nao definido: o caminho feliz de getMe NAO foi medido.\n');
  process.stdout.write('Para medi-lo e preciso um humano com conta Telegram (ver docs/spikes/telegram.md).\n');
  process.exit(0);
}

const ok = await call(real, 'getMe');
process.stdout.write('\n');
report('getMe com o token real do ambiente', ok);
if (ok.json?.ok === true) {
  const u = ok.json.result;
  process.stdout.write(`    bot.id=${u.id}  username=@${u.username}  is_bot=${u.is_bot}\n`);
}
