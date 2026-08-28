# ONBOARDING-DISCORD — ligar o telemóvel ao DSH via Discord

Guia para conectar o Discord ao DSH guardado por este plugin e parear o teu
chat como dono. Todo o comando de controlo (ligar/desligar o túnel, estado,
agentes) só é aceite de um chat pareado — igual ao Telegram.

> **Os comandos são os MESMOS do Telegram** (`/menu`, `/parear`, `/ajuda`,
> `/ligar`, `/desligar`, `/acessar`, `/rotacionar`, `/status`, `/emergencia`,
> `/agente`, `/agentes`, `/parar-agente`): quem decide o que cada um faz é o
> núcleo neutro do worker, e o adaptador do Discord só traduz mensagem/clique
> na forma do canal. A diferença está **no lado do provedor** (criar o bot,
> convidar, intents) — é disto que este guia trata.
>
> **Uma diferença de descoberta:** o adaptador do Discord **não registra slash
> commands** (o `publishCommands` é no-op documentado — registrá-los exigiria o
> id da aplicação, que o token sozinho não dá, e mudaria o modelo do núcleo,
> que entende texto livre). Por isso o bot não tem menu de comandos no Discord:
> **digitas os comandos como mensagens de texto** (`/menu`, `/ligar`, …) no
> chat onde ele está.
>
> Os **textos EXATOS** do bot (boas-vindas, menu, telas de confirmação com o
> botão `✕ Não`, respostas de pareamento) estão em
> [`docs/ux/01-CONTRATO-BOT.md`](ux/01-CONTRATO-BOT.md) e o padrão de microcopy
> em [`docs/ux/03-MICROCOPY.md`](ux/03-MICROCOPY.md) — aqui resume-se o uso.

> **Não há senha a digitar em lugar nenhum.** O acesso pelo túnel entra por
> **sessão** ou pela **chave no link** `?key=`. O bot é o canal de entrega: o
> `/ligar` (e o `/acessar`) **envia automaticamente** o link com a chave
> `https://<url-pública>/?key=<token>`. A chave pode aparecer no chat — **é o
> mecanismo** (é a chave do link, não uma "senha permanente"). Ela é
> **reutilizável** até `/rotacionar` (gera chave nova e invalida sessões) ou
> derrubar o túnel.
>
> Aviso honesto de canal: a conversa com o bot é *cloud chat* — não é
> ponta-a-ponta, o histórico fica nos servidores do Discord. Como a chave viaja
> por aí, quem ler o chat lê a chave; foi por isso que a revogação existe.
> Outros segredos que **não** são a chave do link (token do bot, segredos
> internos) nunca devem aparecer no chat.

---

## Passo 1 — Criar o bot no Developer Portal

1. Abre **https://discord.com/developers/applications** e toca em
   **New Application** (dá um nome — ex.: `DSH Messenger`). Cria a aplicação.
2. Na aba **Bot**, toca em **Add Bot** (e confirma). O bot nasce.
3. Ainda na aba **Bot**, toca em **Reset Token** e **copia o token** (tem o
   formato `MTE...` — aparece **uma única vez**; se o perderes, reset de novo,
   o que revoga o anterior). Este é o `DISCORD_BOT_TOKEN`.
4. **ATIVA O INTENT PRIVILEGIADO (obrigatório):** na mesma aba **Bot**, liga
   **MESSAGE CONTENT INTENT**. Este plugin lê o texto dos comandos, e o
   identify do gateway declara `MESSAGE_CONTENT` (intents 37376 =
   `GUILD_MESSAGES` + `DIRECT_MESSAGES` + `MESSAGE_CONTENT`). **Sem o intent, o
   gateway fecha a ligação com o close `4014`** ("disallowed intents") e o bot
   não responde a nada. É o erro nº 1 do "bot não responde" — ver
   [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) §8.

> **No painel Remote Access:** o Passo 1 da trilha guia o mesmo fluxo e aceita
> o token com o CTA `Salvar bot`. O token fica guardado de forma segura nesta
> máquina e **nunca** sai do backend para o painel.

## Passo 2 — Convidar o bot para o teu servidor

O bot lê mensagens em **DMs diretos** e em **canais de servidor**
(`DIRECT_MESSAGES` + `GUILD_MESSAGES`). O caminho mais simples é convidá-lo para
um servidor que controles:

1. No Developer Portal, aba **OAuth2 → URL Generator**.
2. Em **Scopes**, marca **`bot`**.
3. Em **Bot Permissions**, marca **`Send Messages`** (e, para o bot ver as
   mensagens do canal, `View Channels` / `Read Messages` — a permissão de
   leitura do canal onde vais comandar).
4. Abre a URL gerada, escolhe o servidor e confirma o convite.

> Para o **DM direto**: depois de o bot estar num servidor que controles, abre
> o **perfil dele** na lista de membros e toca em **Message** — a DM começa aí
> (o bot declara `DIRECT_MESSAGES` e lê o texto da DM). O DM tem a vantagem de
> o `chatKey` ser o canal da DM — um eixo estável, sem depender de permissões
> de canal — e é onde o Passo 3 recomenda parear.

## Passo 3 — Gravar o token e parear o teu chat (código de 6 dígitos)

1. **Configura o provedor como `discord`** na config (Camada 2/Home do
   `cordis.patch.yml`): `worker.provider: discord` e o token vindo de
   `DISCORD_BOT_TOKEN` — ver [`docs/INSTALL.md` Passo 4b](INSTALL.md).
   O `dsh-guard-setup` usa a chave do provedor ativo no `secrets.env`
   partilhado (cada provedor com a sua linha: `TELEGRAM_BOT_TOKEN` /
   `DISCORD_BOT_TOKEN`).
2. **Reinicia o DSH** se já estiver a correr (o worker só arranca no boot).
3. Na **trilha do painel** (ou na CLI `dsh-guard-setup --parear`), gera o
   **código de 6 dígitos** (TTL de 5 min) e manda no bot:
   **`/parear <código>`**. O pareamento é o do núcleo neutro — **idêntico ao
   Telegram**: `✓ Pareado com sucesso! Agora: /menu e /status.` O dono é
   gravado no `state.json` pelo host via `pairing.owner`, que liberta a
   allowlist no ato — sem reiniciar.
   - `/parear` sem valor faz o bot **pedir o código** na conversa (`Envia-me o
     código de 6 dígitos que aparece no painel.`) e usa a próxima mensagem de
     texto como resposta.
   - Código errado/expirado: `Código errado ou expirado. Confere no painel e
     tenta de novo.` (sempre a mesma frase — PAIR-003, sem oráculo).
   - `/start` (se o escreveres) são boas-vindas inócuas, iguais para toda a
     gente, e **não pareiam ninguém** (PAIR-006).

> **Pareia por DM.** A allowlist é de dois eixos (`userKey` + `chatKey`): num
> servidor, `chatKey` é o **canal** e `userKey` o membro — se pareares num
> canal, só esse canal comanda. Para um dono de um eixo estável, pareia na
> **DM com o bot**.

## Passo 4 — Usar (por onde começar)

Pós-pareamento, o controlo fica no **cartão de controle do bot** (`/menu`,
título **`🎛 Remote Access`**): estado do túnel (`✅ Ligado` / `⬜ Desligado`) e
os botões — no Discord o teclado suporta **até 5 por linha** (o Telegram é
coluna única; o núcleo renderiza dentro dos limites de cada canal):
`🟢 Ligar`, `🔴 Desligar`, `📶 Status`, `🤖 Agentes`, `🔗 Link de acesso`,
`⇄ Nova chave`, `🚨 Emergência`.

Ações que **aumentam a exposição** (ligar, rotacionar) e as **destrutivas**
(desligar, emergência) pedem **confirmação em duas etapas**, com o botão
positivo `[✅ …]` e o de cancelamento `[✕ Não]` (responde `Ok, cancelado.` sem
executar nada). O mesmo vale para `/agente`: o dispatch **executa código na tua
máquina** — o bot mostra o prompt que vai correr e pede `✅ Sim, disparar`.

Comandos de controlo (iguais aos do Telegram):

| Comando | O que faz |
| --- | --- |
| `/ligar` | Sobe o túnel e, quando fica READY, **envia automaticamente** o link com a chave `?key=` |
| `/desligar` | Derruba o túnel (e revoga a chave) |
| `/acessar` | (Re)envia o link com a chave |
| `/rotacionar` | Gera chave nova, invalida as sessões e encerra as conexões ativas |
| `/status` · `/emergencia` | estado · kill switch |
| `/agente <skill> <prompt>` | Dispara um agente do harness (confirmação em 2 etapas) — manual em [`docs/AGENTS.md`](AGENTS.md) |
| `/agentes` | Lista os runs de agentes (`• <id> — <skill> — <estado> <há quanto>`) |
| `/parar-agente <id>` | Cancela um run |

> **Estranhos são descartados em silêncio** (TG-089): num servidor público, um
> não-dono que mande `/status` não recebe resposta — a allowlist de dois eixos
> nega e a auditoria conta. Nada vaza estado a quem não é dono.

---

## O que fica em disco

```
~/.dsh/guarded-bot/secrets.env   # 0600, guarda TELEGRAM_BOT_TOKEN e DISCORD_BOT_TOKEN
~/.dsh/guarded-bot/state.json    # 0600, guarda o pareamento (e o provedor ativo)
```

O caminho usa `$DSH_HOME` se estiver definido, senão `~/.dsh`, sempre sob
`guarded-bot/`. Tudo `0600`, diretório `0700`, fora do workspace e do git. O
token entra por **ambiente (allowlist do worker)**, nunca em `argv` — um
argumento seria visível em `/proc/<pid>/cmdline` para qualquer processo local.
