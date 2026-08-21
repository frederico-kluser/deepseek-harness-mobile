# ONBOARDING-TELEGRAM.md — ligar o telemóvel ao DSH via bot

Guia para conectar o Telegram ao DSH guardado por este plugin e parear o teu chat como
dono. Todo o comando de controlo (ligar/desligar o túnel, estado) só é aceite de um chat pareado.

> **A senha de acesso nunca é enviada por nenhum canal remoto — inclusive este.** Conversa
> com bot é *cloud chat*: não é ponta-a-ponta, o histórico fica nos servidores da Telegram
> e não existe autodestruição para bots. A senha aparece no terminal local, e só lá.
> O que pode chegar pelo Telegram é o **link mágico** de sessão (uso único, com TTL).

## Ponto de partida

A ferramenta de onboarding é a CLI `dsh-guard-setup`, que vem no próprio pacote
(`bin` em `package.json` → `dist/bin/dsh-guard-setup.js`). Correr sem opções
mostra **só o passo que falta** fazer, na ordem. É pensada para quem nunca viu o
projeto: quem a corre do zero e segue cada passo sem perguntar nada ao autor cumpriu o
critério de usabilidade (roteiro M1, `docs/plano/04-TESTES.md §9`).

## Passo 1 — criar o bot no BotFather

1. No Telegram, conversa com `@BotFather` e corre `/newbot`.
2. Dá um nome e um username **que termine em `bot`** (5–32 caracteres,
   `[A-Za-z0-9_]`, imutável).
3. O BotFather devolve um token no formato `<id>:<segredo>`. Guarda-o por
   agora; vai ser pedido no passo seguinte.

O texto exato a digitar é mostrado pela própria CLI quando corres `dsh-guard-setup`,
sem jargão.

## Passo 2 — colar o token

Corre a CLI na máquina onde o DSH roda:

```sh
dsh-guard-setup
```

Quando pedido, cola o token. A leitura é **sem eco** (não aparece no terminal) e o valor
é gravado com modo `0600`. A CLI valida com `getMe` e mostra o `@username` do
bot para conferência. Se colares um token errado, tens um erro claro, sem stack trace,
com a instrução de `/token` no BotFather.

> A CLI **recusa** qualquer forma de token no *argv* (`--token=...` ou valor solto) —
> um argumento é visível em `/proc/<pid>/cmdline` para qualquer processo local
> (`src/telegram/onboarding.ts:423-434`).

O token fica numa **allowlist de ambiente** do worker, nunca em `argv`. O worker de
long-polling não herda `process.env` inteiro: o plugin monta um ambiente mínimo a
partir de uma allowlist mais o token (`src/proc/env.ts`).

## Passo 3 — parear o teu chat (código de 6 dígitos)

1. A CLI mostra um **código de pareamento de 6 dígitos**, só no terminal, com TTL de 5
   minutos e a instrução `/parear <código>` no bot.
2. Manda `/start` ao bot **antes** de parear, se quiseres: o bot responde uma
   boas-vindas inócua e **não pareia** ninguém. Por desenho, `/start` não pareia
   (`docs/plano/02-SEGURANCA.md` D8).
3. Manda `/parear <código>` com o código certo. A CLI confirma o `@username` e o
   `chat` pareado e **fecha** o pareamento.
4. Se o código estiver errado, o bot responde uma recusa genérica e conta a tentativa
   (teto de 5 errados). Se voltar a tentar `/parear` (ou de outra conta), é
   **recusado**; reabrir exige `--reset-pairing` na máquina. O pareamento é de um
   dono só (`worker/auth/allowlist.ts`).

## Passo 4 — conferir o que ficou em disco

```
~/.dsh/guarded-bot/secrets.env   # 0600, guarda TELEGRAM_BOT_TOKEN
~/.dsh/guarded-bot/state.json    # 0600, guarda o pareamento
```

O caminho usa `$DSH_HOME` se estiver definido, senão `~/.dsh`, sempre sob
`guarded-bot/` (`src/state/paths.ts`). Tudo `0600`, diretório `0700`,
fora do workspace e fora do git.

## Passo 5 — ler os 5 avisos de exposição

A CLI imprime (no terminal) os cinco avisos que tens de ter lido antes de expor:

1. `trustedRemotes` fica **inerte** como controlo de rede sob o túnel;
2. o túnel **fura a firewall** (qualquer porto de saída 443);
3. o **TLS termina na borda da Cloudflare** — o texto claro passa por um terceiro;
4. o endereço do túnel **não é segredo**;
5. `trycloudflare.com` tem reputação de malware em alguns filtros.

## Comandos do bot (depois de pareado)

| Comando | O que faz |
| --- | --- |
| `/ligar` | Sobe o túnel e devolve o link (pede confirmação) |
| `/desligar` | Derruba o túnel (pede confirmação) |
| `/status` | Estado atual e a URL vigente |
| `/emergencia` | Derruba o túnel e revoga as sessões (kill switch) |

Ações que **aumentam a exposição** (subir o túnel) exigem confirmação em duas etapas com
um nonce do host. O botão de confirmar é identificado pelo **texto** (o estilo de botão é
não confirmado pela referência — não dependemos dele).

## Se usas o painel / outra superfície

Ligar/desligar também está no painel local e numa superfície de UI própria; ambas as
superfícies mostram o mesmo estado e o mesmo `seq` (paridade por contrato,
CTL-040). O worker de long-polling conflita com uma segunda instância do bot no mesmo
token (`409 terminated by other getUpdates request`) — nunca corras duas instâncias no mesmo token.
