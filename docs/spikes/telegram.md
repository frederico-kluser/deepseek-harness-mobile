# Spike T0.3 — Telegram / BotFather / grammY

Fecha **S5**, **S7** e **S8**. Produtor declarado no mapa `S* → T*` de `03-ONDAS.md` §2.

## 0. Ambiente da medição e o que ele limita

```
$ echo "TELEGRAM_BOT_TOKEN=[${TELEGRAM_BOT_TOKEN:-UNSET}]"; node --version; pnpm --version
TELEGRAM_BOT_TOKEN=[UNSET]      v24.15.0      11.7.0
```

Data: 2026-08-19. Bot API na doc lida: **10.2 (14/jul/2026)**. grammY **1.45.1**,
`@grammyjs/types` **4.0.0** (dependência exata do `package.json` do tarball).
**Não há token nem bot registado nesta máquina.** O fluxo BotFather ao vivo exige um humano
com conta Telegram. O que depende de tráfego autenticado sai com **ausência de evidência
declarada** e vai para o roteiro da §11; o resto foi medido, com a saída bruta colada.

**Nenhum token real aparece neste documento.** Onde um token ilustra uma URL, escreve-se
`<TOKEN>`; os scripts constroem tokens sintéticos por concatenação em tempo de execução, para
que nenhum literal com forma de token exista em ficheiro.
Fontes primárias, todas lidas em raw e parseadas localmente: `core.telegram.org/bots/api`
(836 670 bytes, HTTP 200 — forma dos métodos e dos tipos), `.../bots/api-changelog` (em que
versão cada campo entrou), `.../bots/features` (BotFather, token, comandos), `.../bots/faq`
(`offset`, bots não veem bots), `telegram.org/faq` (criptografia, "bots são estranhos"),
`github.com/tdlib/telegram-bot-api` — `Client.cpp`, `Client.h`, `ClientManager.cpp` (servidor
oficial: 409, 401, clamps) e os tarballs `grammy@1.45.1` / `@grammyjs/types@4.0.0`, obtidos
com `npm pack`, lidos e **não** instalados no projeto.

## 1. Os três vereditos

VEREDITO S5: CONFIRMADO — o grammY aceita `apiRoot` e redireciona mesmo as chamadas; o caminho da opção é `new Bot(token, { client: { apiRoot } })`.
  evidência: medição real contra servidor HTTP local, `scripts/spike/telegram/s5-s8-grammy-contra-fake.mjs` (saída na §3); tipo em `grammy-1.45.1/out/core/client.d.ts:60-66` (`interface ApiClientOptions { apiRoot?: string; ... }`), consumido em `out/core/client.js:65` (`const apiRoot = options.apiRoot ?? "https://api.telegram.org";`) e ligado ao construtor por `out/bot.d.ts:61-68` (`interface BotConfig<C> { ... client?: ApiClientOptions; }`).
  ausência declarada: nenhuma — este spike não precisa de token e foi medido de ponta a ponta.

VEREDITO S7: CONFIRMADO — `InlineKeyboardButton.style` existe na Bot API 10.2, com exatamente os valores "danger", "success" e "primary"; entrou na Bot API 9.4 (09/fev/2026).
  evidência: `https://core.telegram.org/bots/api#inlinekeyboardbutton`, linha da tabela do tipo — `style` / `String` / *"Optional. Style of the button. Must be one of “danger” (red), “success” (green) or “primary” (blue). If omitted, then an app-specific style is used."*; o parágrafo do tipo diz `Exactly one of the fields other than text, icon_custom_emoji_id, and style must be used to specify the type of the button.`; changelog em `https://core.telegram.org/bots/api-changelog` — `[Bot API 9.4] Added the field style to the classes KeyboardButton and InlineKeyboardButton, allowing bots to change the color of buttons.`; tipos em `@grammyjs/types@4.0.0/markup.d.ts:14-15` — `/** Style of the button. Must be one of “danger” (red), “success” (green) or “primary” (blue). If omitted, then an app-specific style is used. */` seguido de `style?: "danger" | "success" | "primary";`; construtor em `grammy-1.45.1/out/convenience/keyboard.d.ts:753-786` (`.style()`, `.danger()`, `.success()`, `.primary()`); serialização medida no fio na §4.
  ausência declarada: o envio a um chat real não foi executado (sem token nesta máquina), portanto o **render** do botão colorido num cliente Telegram não foi observado. A existência do campo na especificação e nos tipos está provada.

VEREDITO S8: NAO CONFIRMADO — `drop_pending_updates` não é parâmetro de `getUpdates`. É parâmetro de `setWebhook` e de `deleteWebhook`, e o `bot.start({ drop_pending_updates })` do grammY traduz-se numa chamada a `deleteWebhook`.
  evidência: `https://core.telegram.org/bots/api#getupdates` lista quatro parâmetros e `drop_pending_updates` não está entre eles — `offset` (Integer, Optional), `limit` (Integer, Optional), `timeout` (Integer, Optional) e `allowed_updates` (Array of String, Optional); `#setwebhook` e `#deletewebhook` listam `drop_pending_updates` (Boolean, Optional) — *"Pass True to drop all pending updates"*; o mesmo recorte aparece em `@grammyjs/types@4.0.0/methods.d.ts` — `getUpdates` (linhas 22-34) sem o campo, `setWebhook` com ele na linha 62 e `deleteWebhook` na linha 69; no grammY, `out/bot.d.ts:36-38` põe `drop_pending_updates` em `PollingOptions` e `out/bot.js:295-298` gasta-o em `await this.api.deleteWebhook({ drop_pending_updates: options?.drop_pending_updates }, ...)`; medição no fio na §5.
  ausência declarada: nenhuma — este spike não precisa de token e foi medido de ponta a ponta.

**Consequência para T4.2:** a superfície existe e é `bot.start({ drop_pending_updates: true })`.
O plano B do `03-ONDAS.md` (`getUpdates` inicial com `offset: -1`) **não é necessário** e não
entra no código; a §7 regista o que ele realmente faz, para quem operar sem `deleteWebhook`.

## 2. O fluxo BotFather, passo a passo

| # | Passo | Como se executa | Estado nesta medição |
| --- | --- | --- | --- |
| 1 | `/newbot` no `t.me/BotFather` | app de Telegram, conta humana | **PENDENTE HUMANO** (§11) |
| 2 | nome de exibição e username | 5–32 chars, `[A-Za-z0-9_]`, **tem de terminar em `bot`**, **imutável** | **PENDENTE HUMANO** — regra confirmada em `bots/features`: *"Usernames are 5-32 characters long and not case sensitive – but may only include Latin characters, numbers, and underscores. Your bot's username must end in 'bot’"* e *"Unlike the bot’s name, the username cannot be changed later"* |
| 3 | BotFather devolve o token, forma `<bot_user_id>:<segredo>` | mensagem no chat | **PENDENTE HUMANO** |
| 4 | `getMe` valida o token | `GET https://api.telegram.org/bot<TOKEN>/getMe` | **caminho de erro MEDIDO** (§2.1); caminho feliz pendente |
| 5 | o dono manda `/start` — bot não inicia conversa | app de Telegram | **PENDENTE HUMANO**. `/start` responde boas-vindas inócuo e **não pareia ninguém** (D8) |
| 6 | `getUpdates` traz `from.id` **e** `chat.id` | transporte de `/parear <código>` | **estrutura e semântica MEDIDAS** (§6, §7); tráfego real pendente |
| 7 | `setMyCommands` publica a lista fechada | ver §8 | **forma MEDIDA** contra servidor local (§8) |

### 2.1 `getMe` — os caminhos de erro, medidos agora

`scripts/spike/telegram/probe-getme.mjs`, saída bruta:

```
apiRoot = https://api.telegram.org
--- getMe com token BEM-FORMADO mas inexistente          HTTP 401  (986 ms)
    {"ok":false,"error_code":401,"description":"Unauthorized: invalid token specified"}
--- getMe com token MALFORMADO (sem ":")                 HTTP 404  (957 ms)
    {"ok":false,"error_code":404,"description":"Not Found"}
--- getUpdates(offset=-1, timeout=0) com token inexistente   HTTP 401  (227 ms)
    {"ok":false,"error_code":401,"description":"Unauthorized: invalid token specified"}
TELEGRAM_BOT_TOKEN nao definido: o caminho feliz de getMe NAO foi medido.
```

Dois formatos distintos, e T4.1 tem de tratar os dois para classificar `TOKEN_INVALIDO`: um
token com a forma certa mas sem conta dá **401** com `description` estável; um token sem `:`
cai fora da rota e dá **404 `Not Found`**, sem `description` útil. O 401 medido bate
literalmente com o servidor oficial — `ClientManager.cpp:76` e `:84`:
`return fail_query(401, "Unauthorized: invalid token specified", std::move(query));`. A forma
da resposta é a de `#making-requests`: *"In case of an unsuccessful request, 'ok' equals False
and the error is explained in the 'description'. An Integer 'error_code' field is also
returned ... Some errors may also have an optional field 'parameters' of the type
ResponseParameters"*.

## 3. S5 — `apiRoot` contra servidor local real

`scripts/spike/telegram/s5-s8-grammy-contra-fake.mjs`, saída bruta:

```
===== S5 — apiRoot aponta mesmo para servidor local? =====
  fake Bot API em http://127.0.0.1:43783
  bot.api.getMe() devolveu:
    {"id":1000000001,"is_bot":true,"first_name":"DSH Spike Bot","username":"dsh_spike_bot","can_join_groups":true,...}
  chamadas que chegaram ao servidor LOCAL:  {"method":"getme","payload":{}}
  RESULTADO: as chamadas foram REDIRECIONADAS para o apiRoot local
  apiRoot com barra final -> Remove the trailing '/' from the 'apiRoot' option (use 'http://127.0.0.1:43783' instead of 'http://127.0.0.1:43783/')
```

Foi um servidor HTTP local de verdade, não um mock de rede: o `getMe` devolveu o
`FAKE_BOT_USER` do dublê e a chamada foi contada do lado do servidor.
**Três detalhes que T6.2 precisa de saber:** (1) barra final é erro duro, não normalização
silenciosa (`out/core/client.js:86-87`); (2) existe um segundo ponto de extensão, mais
poderoso, que este spike também exerceu — `buildUrl?: (root, token, method, env) => string | URL`
(`out/core/client.d.ts:83-91`), que `reproduzir-409.mjs` usa para marcar cada instância no
query string; (3) `http:` é aceite — `out/platform.node.js:27-38` escolhe o agente por prefixo,
`https:` → `https.Agent` e `http:` → `http.Agent`, portanto não é preciso TLS no dublê.

**O plano B de `03-ONDAS.md` T6.2 (transporte falso na camada de rede) fica arquivado.**

## 4. S7 — `style` existe, e a asserção do plano estava invertida

Este é o achado que contradiz o plano. `01-ARQUITETURA.md` §7.2, `08-PESQUISA-E-FONTES.md`
fato #15 e lacuna L19 tratam `InlineKeyboardButton.style` como não confirmado, e `03-ONDAS.md`
T5.2 proíbe entregá-lo. **A doc oficial tem o campo.** Ele não existia quando o material de
origem foi escrito: entrou na Bot API **9.4, de 09/fev/2026**. Serialização medida no fio:

```
===== S7 — o grammY serializa InlineKeyboardButton.style no fio? =====
  objeto construido: [[{"text":"Ligar","callback_data":"srv:on:v1","style":"success"},{"text":"Desligar","callback_data":"srv:off:v1","style":"danger"}]]
  payload que saiu no fio:
    {"chat_id":777000123,"text":"estado","reply_markup":{"inline_keyboard":[[{"text":"Ligar","callback_data":"srv:on:v1","style":"success"},{"text":"Desligar","callback_data":"srv:off:v1","style":"danger"}]]}}
```

O construtor usado foi `new InlineKeyboard().text('Ligar','srv:on:v1').success().text('Desligar','srv:off:v1').danger()`.
**O que muda, e o que não muda.** `style` é `Optional` — *"If omitted, then an app-specific
style is used."* O rótulo textual com emoji (`🟢 Ligar` / `🔴 Desligar`) continua portador da
semântica: funciona em cliente antigo e em qualquer versão da Bot API, e cor sozinha não é
acessível. `style` passa de proibido a **enfeite opcional**, como `01-ARQUITETURA.md` §7.2
previu para o caso de confirmação; o que **não** se pode é depender dele para o utilizador
distinguir ligar de desligar.

**Defeito de numeração a corrigir:** `01-ARQUITETURA.md` §7.2 e §14 chamam a este spike **S10**;
`03-ONDAS.md` §2 define **S7** = `style` e **S10** = o cookie `__Host-`. O canónico é **S7**.

## 5. S8 — onde vive `drop_pending_updates`

Sequência exata de chamadas que o `bot.start({ drop_pending_updates: true, allowed_updates:
["message","callback_query"], timeout: 1 })` produziu no servidor local:

```
===== S8 — em que chamada de rede o grammY traduz drop_pending_updates? =====
  sequencia EXATA de chamadas observada no servidor local (total: 5):
    {"method":"getme","payload":{}}
    {"method":"deletewebhook","payload":{"drop_pending_updates":true}}
    {"method":"getupdates","payload":{"offset":1,"timeout":1,"allowed_updates":["message","callback_query"]}}
    {"method":"getupdates","payload":{"offset":1,"timeout":1}}
    {"method":"getupdates","payload":{"offset":1,"limit":1}}
  drop_pending_updates chegou em deleteWebhook? true    em getUpdates? false
```

Duas coisas que T4.2 herda desta saída:
1. O boot é `getMe` → `deleteWebhook{drop_pending_updates}` → `getUpdates`. O `deleteWebhook`
   limpa a fila **e** garante que nenhum webhook residual está registado — obrigatório, porque
   `getUpdates` com webhook ativo dá 409 (§6). O `getMe` é o `bot.init()`; T4.1 não precisa de
   o repetir se o worker já arrancou.
2. `allowed_updates` viaja **só no primeiro** `getUpdates`. A doc explica porquê: *"If not
   specified, the previous setting will be used."* O valor é **estado no servidor**. E
   `bot.stop()` faz um `getUpdates` final para **confirmar** o último `update_id`
   (`out/bot.d.ts`, doc de `stop()`): encerramento limpo não deixa a fila por confirmar.

## 6. O 409 de polling duplicado — reproduzido, não citado

O 409 real exige duas ligações autenticadas com o mesmo token. Sem token, o conflito foi
reproduzido contra um servidor que implementa a **mesma máquina de estados** do oficial,
transcrita de `tdlib/telegram-bot-api/telegram-bot-api/Client.cpp`:

```cpp
// Client.cpp:17511, em do_get_updates — o pedido NOVO mata o pendente
if (timeout != 0 && updates.size() == 0) { abort_long_poll(false); long_poll_query_ = std::move(query); ... }
// Client.cpp:17349-17359, abort_long_poll — a mensagem, conforme a origem do conflito
message = from_set_webhook ? "Conflict: terminated by setWebhook request"
  : "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running";
fail_query_conflict(message, std::move(long_poll_query_));
// Client.cpp:17362-17368, fail_query_conflict — throttle: 409 imediato 1x a cada 3 s, os restantes dormem 3 s
if (now >= next_get_updates_conflict_time_) { fail_query(409, message, ...); next_get_updates_conflict_time_ = now + 3.0; }
else { /* SleepActor 3 s, depois fail_query(409, ...) */ }
```

Duas instâncias reais de grammY contra esse servidor (`reproduzir-409.mjs`), saída bruta:

```
servidor com semantica de conflito em http://127.0.0.1:45879
--- linha do tempo no servidor ---
  +    0 ms  getUpdates recebido de=instancia-A
  +  599 ms  getUpdates recebido de=instancia-B
  +  599 ms  abort_long_poll do pendente vitima=instancia-A
  +  599 ms  409 enviado para=instancia-A
--- quem morreu ---
  instancia-A: GrammyError error_code=409 method=getUpdates   instanceof GrammyError: true
     description: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running
  A ainda a correr? false    B ainda a correr? true
CONCLUSAO: o 409 mata a instancia que JA estava pendurada (a primeira), nao a que chegou.
```

**Formato exato do 409 no fio:** HTTP 409, corpo `{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}`.
Duas variantes irmãs, do mesmo fonte: `"Conflict: terminated by setWebhook request"` (`Client.cpp:17353`)
e `"Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"` (`Client.cpp:16783-16785`).

**O que T4.2 tem de honrar:** o grammY levanta `GrammyError` com `method: "getUpdates"`, **para
o polling**, e `isRunning()` passa a `false`. `out/bot.js:447-448` —
`// rethrow upon unauthorized or conflict` / `if (error.error_code === 401 || error.error_code === 409)`:
o grammY **não** faz retry em 409 nem em 401, o erro sobe. Um supervisor que reinicie cegamente
produz o flapping infinito de `02-SEGURANCA.md` §7.4 — o processo tem de sair com diagnóstico.
**O 429, esse, sobrevive intacto até ao erro** (`instanceof GrammyError: true`,
`error_code=429`, `parameters={"retry_after":5}`), o que sustenta o plugin de auto-retry.

**Clamps confirmados no fonte:** `Client.h:1704` — `static constexpr int32 LONG_POLL_MAX_TIMEOUT = 50;`,
consumido em `Client.cpp:16790` — `int32 timeout = get_integer_arg(query.get(), "timeout", 0, 0, LONG_POLL_MAX_TIMEOUT);`;
`limit` é clampado a 1–100 na mesma função. `Client.cpp:16794-16799` acrescenta um anti-martelo
ausente da doc pública: repetir o **mesmo** `offset` dentro de 3 s força `timeout = 3`, e dentro
de 0,5 s força `limit = 1` — o que explica o `{"offset":1,"limit":1}` observado na §5.

## 7. `getUpdates` com `offset` confirma **e apaga** — e o que isso custa ao onboarding

`offset-confirma-e-apaga.mjs`, saída bruta:

```
fila inicial no servidor: 10, 11, 12
1) CONSUMIDOR A faz getUpdates(offset=0) — le tudo, confirma nada
   recebeu update_id: 10, 11, 12   |   fila no servidor: 10, 11, 12
2) CONSUMIDOR A confirma ate ao 11: getUpdates(offset=12)
   recebeu update_id: 12           |   fila no servidor: 12
   -> 10 e 11 sumiram do servidor. Um CONSUMIDOR B nunca mais os vera.
3) CONSUMIDOR B chega agora e faz getUpdates(offset=0)
   recebeu update_id: 12
   -> B perdeu /ligar e /status. Foram confirmados por A.
4) DESCARTE DA FILA no boot sem deleteWebhook: getUpdates(offset=-1)
   fila represada: 20, 21, 22
   getUpdates(offset=-1) devolveu: 22   |   fila apos: 22
   -> offset negativo mantem os -offset ultimos e ESQUECE todos os anteriores.
   -> ainda e preciso confirmar o ultimo (offset = update_id + 1) para a fila ficar vazia.
   apos getUpdates(offset=23): fila = (vazia)
```

A semântica reproduzida vem de três fontes primárias que concordam. `#getupdates`, parâmetro
`offset`: *"An update is considered confirmed as soon as getUpdates is called with an offset
higher than its update_id. The negative offset can be specified to retrieve updates starting
from -offset update from the end of the updates queue. All previous updates will be
forgotten."* `bots/faq`: *"The getUpdates method returns the earliest 100 unconfirmed updates.
To confirm an update, use the offset parameter ... All updates with update_id less than or
equal to offset will be marked as confirmed on the server and will no longer be returned."*
E `Client.cpp:17450-17452` — `if (offset < 0) { auto deleted_events = tqueue->clear(tqueue_id_, -offset); ... }`.

**Consequência declarada para T4.1, e é dura:** o CLI de onboarding **não pode** fazer o seu
próprio `getUpdates` enquanto o worker de polling corre. Cada update chega a exatamente um
deles, o que um confirmar desaparece para o outro, e se os dois pendurarem long polls o mais
antigo leva **409** (§6) — o `/parear <código>` do dono cai num dos dois ao acaso. As duas
saídas coerentes: (a) o CLI não faz polling e recebe o update **pelo worker**, pelo IPC de
T4.3; ou (b) o worker não corre durante o onboarding, e isso é pré-condição verificada, não
presumida. `03-ONDAS.md` T4.1 já aponta para (a) ao dizer que `getUpdates` é "apenas o
transporte"; esta medição é a razão técnica.

Prazo de validade da fila (`#getting-updates`): *"Incoming updates are stored on the server
until the bot receives them either way, but they will not be kept longer than 24 hours."* É o
que justifica o `drop_pending_updates` no boot.

## 8. `setMyCommands` e a lista canónica de sete comandos

Forma do método (`#setmycommands`): `commands` (**Yes**, *"A JSON-serialized list of bot
commands to be set as the list of the bot's commands. At most 100 commands can be
specified."*), `scope` (Optional, default `BotCommandScopeDefault`), `language_code`
(Optional). Devolve `True`. A restrição de `BotCommand` (`#botcommand`) **muda a forma do
comando de pareamento**: `command` é *"Text of the command; 1-32 characters. Can contain only
lowercase English letters, digits and underscores."* e `description` é *"Description of the
command; 1-256 characters"*. Sem barra inicial, sem acento, sem espaço, sem maiúscula.
`scripts/spike/telegram/comandos-e-callback-data.mjs`:

```
===== (a) setMyCommands =====
  OK "ligar"(5) | OK "desligar"(8) | OK "status"(6) | OK "acessar"(7)
  OK "rotacionar"(10) | OK "parear"(6) | OK "emergencia"(10)   [description de 21 a 53 chars]
  todos passam em /^[a-z0-9_]{1,32}$/ ? true
  Contra-exemplos que a Bot API recusa (por isso o nome nao leva argumento nem acento):
    RECUSADO "/ligar" | RECUSADO "parear <codigo>" | RECUSADO "emergência" | RECUSADO "Ligar"
  POST setMyCommands -> HTTP 200 {"ok":true,"result":true}
  payload exato que saiu no fio:
    {"commands":[{"command":"ligar","description":"Liga a exposicao (confirmacao em 2 etapas)"},{"command":"desligar","description":"Desliga a exposicao imediatamente"},{"command":"status","description":"Mostra o estado atual"},{"command":"acessar","description":"Emite um link de acesso de uso unico"},{"command":"rotacionar","description":"Rotaciona a credencial (confirmacao em 2 etapas)"},{"command":"parear","description":"Pareia o dono: /parear seguido do codigo de 6 digitos"},{"command":"emergencia","description":"Corta tudo agora, sem confirmacao"}]}
```

A lista canónica de `03-ONDAS.md` T5.2 é `/ligar`, `/desligar`, `/status`, `/acessar`,
`/rotacionar`, `/parear <código>`, `/emergencia`, nesta ordem, e **`/start` não aparece**
(D5, D8). Os sete passam. Duas notas de forma para T5.2: **`/parear <código>` regista-se como
`parear`** — o argumento vive na `description`, nunca no nome, porque `parear <codigo>` é
recusado pela regra de caracteres; e **`emergencia` sem acento**, porque `emergência` é
recusado (o acento pode ir na `description`, que aceita 1–256 caracteres livres). O que o cliente faz com a lista, de `bots/features`: *"Suggest a list of supported
commands with descriptions when the user enters a / (for this to work, you need to have
provided a list of commands to @BotFather or via the appropriate API method)."*

## 9. Os seis fatos de segurança, cada um com fonte primária

| # | Fato | Fonte primária e citação literal |
| --- | --- | --- |
| 1 | Chat com bot é *cloud chat*, sem E2E; a Telegram guarda o histórico; Secret Chat não existe para bots | `https://telegram.org/faq` — *"Server-client encryption is used in Cloud Chats (private and group chats), Secret Chats use an additional layer of client-client encryption."* e *"secret chats are not part of the Telegram cloud and can only be accessed on their devices of origin"*. `Chat.type` em `#chat` só admite *"“private”, “group”, “supergroup” or “channel”"* — não há tipo de secret chat na Bot API, e nenhum método a cria. **O FAQ oficial diz literalmente:** *"any bot should be treated as a stranger — don't give them your passwords, Telegram codes or bank account numbers, even if they ask nicely."* |
| 2 | Não existe autodestruição para bots | `message_auto_delete_time` aparece em `ChatFullInfo` (*"Optional. The time after which all messages sent to the chat will be automatically deleted"*) e em `MessageAutoDeleteTimerChanged` (*"New auto-delete time for messages in the chat; in seconds"*) — **é somente-leitura nos dois**. A string `setChatMessageAutoDeleteTime` **não ocorre** na página inteira de `bots/api` (grep sobre os 836 670 bytes: zero ocorrências); nenhum método com `AutoDelete` no nome existe. `#deletemessage`: *"A message can only be deleted if it was sent less than 48 hours ago."* `has_protected_content` só impede encaminhar: *"True, if the message can't be forwarded"* |
| 3 | `callback_data` é fornecido pelo cliente, 1–64 **bytes** | `#inlinekeyboardbutton` — `callback_data` / `String` / *"Optional. Data to be sent in a callback query to the bot when the button is pressed, 1-64 bytes"*. Medição do limite em bytes na §10 |
| 4 | O token do bot é senha de controlo total | `bots/features#botfather` — *"Keep your token secure and store it safely, it can be used by anyone to control your bot."* Rotação: *"If your existing token is compromised or you lost it for some reason, use the /token command to generate a new one."* Transferência: *"Transferring ownership will give full control of the bot to another user – they will be able to access the bot’s messages and even delete it. The transfer is permanent"*. Roubo da fila: §7 deste relatório — `getUpdates` confirmado **apaga** do servidor. Sequestro: `#setwebhook` |
| 5 | "Quem tem o token contorna a allowlist" é **falso neste desenho** | Medição **não contradiz** o plano, e reforça-o. Em long polling não há endpoint do bot onde POSTar um update forjado — `#getting-updates`: *"There are two mutually exclusive ways of receiving updates"*, e a via escolhida é pull. E o laço interno está fechado por `bots/faq`: *"we decided that bots will not be able to see messages from other bots regardless of mode"* — o `sendMessage` do atacante não volta como update. O resíduo é o deputado confuso: um teclado enviado **como o bot** cujo `callback_data` é destrutivo, se **o dono clicar**. Mitigado pelo nonce de 2 etapas emitido no host (T5.1), não eliminado |
| 6 | Pareamento por código; allowlist valida `from.id` **E** `chat.id`, por id numérico; `message.from` ausente é negação | `#message` — `from` / `User` / *"Optional. Sender of the message; may be empty for messages sent to channels."* **É `Optional` na especificação**, portanto ausência tem de ser negação. `#chat` — `id` / `Integer` / *"... it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe"*. E `bots/features` põe a responsabilidade no backend, com todas as letras: *"Keep in mind that Bot API updates will not contain any information about the scope of a command sent by the user – in fact, they may contain commands that don’t exist at all in your bot. Your backend should always verify that received commands are valid and that the user was authorized to use them regardless of scope."* Alternativa oficial de UI para o utilizador informar ids: `#usersshared` (`UsersShared` via `KeyboardButtonRequestUsers`) |

**Dois defeitos de citação no material do plano, que este spike corrige.** (1) `03-ONDAS.md` §9
regra 1 e `08-PESQUISA-E-FONTES.md` §2.1 atribuem *"any bot should be treated as a stranger"* a
`core.telegram.org/bots/faq`; ela **não está lá** (grep: zero ocorrências de `stranger` nessa
página) e sim em `telegram.org/faq`, na pergunta *"Are bots safe?"* — a frase é real, a URL está trocada. (2) `08-PESQUISA-E-FONTES.md` §2.2 e `02-SEGURANCA.md` §7.3 citam
*"Only one consumer receives each update"* como sendo de `core.telegram.org/bots/webhooks`;
essa página foi descarregada (HTTP 200, 37 031 caracteres) e a palavra `consumer` **não
ocorre** nela; a substância continua verdadeira pela citação de `bots/faq` da §7, é a fonte
que precisa de trocar.

## 10. `from.id` e `chat.id`, e o limite em bytes do `callback_data`

```
===== from.id E chat.id — os dois ids que a allowlist de T4.4 tem de validar =====
  message.from.id = 777000123 (o USUARIO)   message.chat.id = 777000123 (a CONVERSA)
  em chat privado coincidem por construcao — e por isso que validar so um passa despercebido.
```

Em DM os dois números são iguais, o que torna **invisível em teste manual** o defeito A-12. O
caso que separa os dois é o grupo: `callback_query.from` é de quem carregou no botão e
`callback_query.message.chat.id` é do grupo — qualquer membro pode carregar. O dublê traz
`fakeChannelPostUpdate()` para o caso de `message.from` ausente.

```
===== (b) callback_data: 64 BYTES, nao 64 caracteres =====
  cabe   chars=  9 bytes=  9  "srv:on:v1"          |  cabe   chars= 18 bytes= 18  "srv:on:Zm9vYmFyMDE"
  cabe   chars= 64 bytes= 64  "aaaa..."             |  ESTOURA chars= 65 bytes= 65  "aaaa..."
  cabe   chars= 14 bytes= 15  "emergência:sim"      |  cabe   chars= 32 bytes= 64  "éééé..."
  ESTOURA chars= 33 bytes= 66  "éééé..."
```

As duas últimas linhas são a armadilha: 33 caracteres acentuados são 66 bytes — validação por
`.length` passa e o Telegram recusa. Medir com `Buffer.byteLength(s, 'utf8')`. Com o formato
`${acaoCurta}:${nonce}` de `02-SEGURANCA.md` §7.3 sobra folga larga: o caso medido gastou 18
bytes dos 64. `answerCallbackQuery` é obrigatório e o `text` tem limite próprio
(`#answercallbackquery`): *"Text of the notification. If not specified, nothing will be shown
to the user, 0-200 characters."*

## 11. O que exige um humano com conta Telegram

Roteiro acionável, insumo direto do roteiro manual **M1** de `04-TESTES.md` e da sub-tarefa
**T4.1**. Cada linha diz a ação exata e o que a pessoa tem de colar de volta.

| # | O que a pessoa faz | O que ela cola de volta | Fecha |
| --- | --- | --- | --- |
| H1 | Abre `t.me/BotFather`, envia `/newbot`, dá um nome de exibição e um username terminado em `bot` | a mensagem do BotFather **com o token removido e substituído por `<TOKEN>`**, e o `@username` escolhido | M1 passos 1–2 |
| H2 | Exporta o token **só no ambiente**, nunca em `argv` (A-8): `read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN` | nada — o token não sai da máquina | M1 passo 3 |
| H3 | `node scripts/spike/telegram/probe-getme.mjs` | a linha `getMe com o token real do ambiente` e a linha `bot.id=… username=@… is_bot=…` | fecha o caminho feliz de `getMe` que ficou em aberto na §2.1 |
| H4 | Abre o chat com o próprio bot e envia `/start` | a resposta do bot, e a confirmação de que **ninguém foi pareado** | M1 passo 6, D8 |
| H5 | `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates?offset=-1&timeout=0" \| python3 -m json.tool` | o JSON **com `first_name`, `last_name` e `username` redigidos**, mantendo `update_id`, `message.from.id`, `message.chat.id` e `message.chat.type` | prova que `from.id` e `chat.id` chegam ambos, com valores reais |
| H6 | Repete o `curl` de H5 **sem** `offset`, duas vezes seguidas | os dois JSON, para se ver que o mesmo `update_id` volta enquanto não for confirmado | confirma a §7 com tráfego real |
| H7 | Numa segunda janela, corre o `curl` de H5 com `timeout=30`; na primeira, corre outro igual | o corpo **HTTP 409** que a janela mais antiga recebeu | eleva a §6 de reprodução fiel para observação direta |
| H8 | Envia um teclado com `style` a si próprio: `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -H 'content-type: application/json' -d '{"chat_id":<CHAT_ID>,"text":"teste","reply_markup":{"inline_keyboard":[[{"text":"🟢 Ligar","callback_data":"srv:on:v1","style":"success"},{"text":"🔴 Desligar","callback_data":"srv:off:v1","style":"danger"}]]}}'` | a resposta JSON completa **e uma captura de ecrã do botão** | fecha o render de S7, que a §4 deixou em aberto |
| H9 | Envia `/parear 000000` (código errado) e depois o código certo | as duas respostas do bot | M1 passos 7–8 |
| H10 | Envia `/parear` outra vez, e pede a outra conta que envie `/parear <código>` | as duas recusas | M1 passo 9 |

Regra para todas as linhas: **nada do que a pessoa cola pode conter o token**, nem inteiro nem
mascarado; nomes e usernames reais entram redigidos, e `chat.id`/`from.id`, se colados, ficam
num ficheiro que não é público.

## 12. Scripts entregues

Node puro, ESM, **sem dependência nova instalada no projeto** (D23: `grammy` só entra em
T4.2). Insumo direto de `test/support/telegram-server.ts`, congelado no COMMIT PREP 2.
Todos em `scripts/spike/telegram/`:

| Ficheiro | O que faz | Precisa de quê |
| --- | --- | --- |
| `fake-bot-api.mjs` | servidor Bot API falso: rota `/bot<token>/<method>`, long polling que segura a resposta como o servidor real, fila de erros programável, `CANONICAL_ERRORS` copiados de `Client.cpp`, builders de update com e sem `message.from` | nada |
| `probe-getme.mjs` | probe do `getMe` real; sem token mede os formatos de erro, com token mede o caminho feliz. Token só por env (A-8), nunca impresso | rede |
| `offset-confirma-e-apaga.mjs` | confirmação/apagamento por `offset` e descarte por `offset: -1` | nada |
| `comandos-e-callback-data.mjs` | valida os sete comandos contra `BotCommand.command` e mede `callback_data` em bytes | nada |
| `s5-s8-grammy-contra-fake.mjs` | S5, S8, 409, 429 e serialização de `style`, com grammY real | `SPIKE_GRAMMY_PATH` |
| `reproduzir-409.mjs` | duas instâncias reais de grammY contra servidor com a semântica de conflito de `Client.cpp` | `SPIKE_GRAMMY_PATH` |

Os dois últimos precisam do grammY resolvível. Ele **não** é dependência deste repositório
nesta onda; instala-se num diretório descartável:

```
mkdir -p /tmp/spike-grammy && cd /tmp/spike-grammy && npm init -y >/dev/null \
  && npm pkg set type=module && npm i grammy@1.45.1
SPIKE_GRAMMY_PATH=/tmp/spike-grammy/node_modules/grammy/out/mod.js node scripts/spike/telegram/s5-s8-grammy-contra-fake.mjs
```

Sem a variável, os scripts saem com status 2 e a instrução acima. Nunca fingem ter medido.

## 13. Respostas às perguntas falsificáveis de `03-ONDAS.md` §5

1. **`message.chat.id` ou `message.from.id`?** Dos dois, e ambos obrigatórios. `message.from`
   é `Optional` e ausência tem de ser negação; em DM os dois ids coincidem, o que esconde o
   defeito (§10).
2. **O 409 foi reproduzido ou só citado?** Reproduzido, com duas instâncias reais de grammY,
   incluindo quem morre e quem sobrevive; a string exata vem do fonte do servidor (§6).
3. **`offset` confirma e apaga — testado, com a consequência declarada?** Testado, em quatro
   cenários; a consequência para T4.1 está escrita como restrição de desenho (§7).
4. **`apiRoot` testado contra servidor local real, ou lido na doc?** Testado contra servidor
   HTTP local real, com a chamada contada do lado do servidor; o `.d.ts` e o `.js` são
   confirmação adicional, não a evidência principal (§3).
5. **Algum token real aparece no relatório, mesmo parcialmente mascarado?** Não — nenhum token
   real existe nesta máquina, e os sintéticos dos scripts são construídos por concatenação em
   tempo de execução, sem literal em ficheiro.
