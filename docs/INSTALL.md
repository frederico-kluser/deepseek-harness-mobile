# INSTALL.md — instalação passo a passo

Este guia instala o plugin `dsh-guard-messenger` num DeepSeek Harness (DSH) e verifica que o portão está a funcionar. Pressupõe:

- um **DSH instalado e a correr** (o formato canónico da *awesome-list* é `dsh plugin --profile <perfil> add <pacote>`; alternativamente `add github:owner/repo`);
- **Node ≥ 24** (`engines.node: ">=24"`);
- sistema **Linux ou macOS** (`os: ["linux","darwin"]`);
- para o túnel, o binário `cloudflared` (ver `docs/TUNNEL.md`).

> **Compatibilidade:** a faixa suportada é `@deepseek-ai/dsh` `0.1.0-rc.7 .. 0.1.1-rc.1` (política N/N-1). Veja a tabela em `docs/COMPATIBILITY.md` — que é **gerado** de `dsh-compat.yml`, nunca editado à mão.

> **Compat (arquitetura de provedores):** o worker é neutro ao provedor e suporta **dois
> fornecedores: Telegram e Discord** (`config.worker.provider`, default `telegram`). Para o
> Telegram nada muda: token na variável `TELEGRAM_BOT_TOKEN` (via `dsh-guard-setup`), pareamento
> e comandos iguais. Para o Discord, ver o Passo 4b abaixo. Os comandos do bot são os **MESMOS**
> nos dois provedores (incluindo os de agentes — ver o Passo 4c). Detalhe em
> [`docs/PROVIDERS.md`](PROVIDERS.md) e [`docs/AGENTS.md`](AGENTS.md).

---

## Passo 0 — Pré-requisitos (M0)

- Máquina com o DSH instalado.
- Conta Telegram e o app no celular (só se quiseres o controlo pelo bot; o portão HTTP funciona sem isso).
- `cloudflared` **verificado por checksum** antes de qualquer uso — a release do GitHub publica o sha256 nas release notes e o próprio binário loga o seu checksum no startup. Alternativa preferida: repo apt assinado (`pkg.cloudflare.com`, chave `cloudflare-main.gpg`), que dá verificação automática (`docs/plano/08-PESQUISA-E-FONTES.md §8` fato 10).

## Passo 1 — Adicionar o plugin

```sh
dsh plugin --profile web add dsh-guard-messenger
```

> **Não copies ficheiro nenhum à mão.** A camada de *Bundle* deste pacote entra **automaticamente** com o `dsh plugin add`: o `package.json` declara `dsh.bundle.patch`, o que ativa o manifesto de Bundle (`cordis.patch.yml`) sem passo de `cp` manual. Uma cópia manual antiga teria aplicado as mesmas entradas uma segunda vez, noutra camada de precedência.

## Passo 2 — Arrancar o DSH

```sh
dsh web
```

No arranque o plugin deverá:

1. validar o **bind** (em loopback) e gritar se estiver fora da allowlist;
2. deixar o **DSH aberto no local** — em `127.0.0.1` abre direto, sem barreira
   (**acesso local = sem login**);
3. deixar o **Telegram** disponível para configurar depois ("não configurado").

## Passo 2.5 — Ligar o bot e receber o link (sem digitar senha nenhuma)

O acesso pelo túnel **não usa senha**. Depois de o bot estar pareado
(`docs/ONBOARDING-TELEGRAM.md`), o fluxo é automático:

1. corre `dsh-guard-setup` e segue os passos para criar o bot no `@BotFather`,
   colar o token e parear com `/parear <código>` (código de 6 dígitos no
   terminal);
2. no Telegram, manda **`/ligar`**: o bot sobe o túnel e, quando fica `READY`,
   **envia automaticamente** o link com a chave
   `https://<url-pública>/?key=<token>`;
3. **abre o link no celular**. O `?key=` válido é trocado por uma **sessão** e o
   navegador é redirecionado para a URL limpa (sem `?key=`), que continua
   autenticada via cookie.

> **Depois de gravar o token, reinicia o DSH** se já estiver a correr. O bot
> arranca o worker só no **boot** do DSH: se gravares o token via
> `dsh-guard-setup --pedir-token` com o DSH já a correr, ele **não reinicia
> sozinho** — o painel continua a mostrar "Passo 2 · O bot não está a correr
> agora" mesmo com o token configurado. Nesse caso, faz **Ctrl+C** e corre
> `dsh web` de novo para o worker arrancar. **Sem reiniciar, alternativa:**
> põe o token pelo **próprio painel** (Passo 1 da aba do plugin), que faz
> reload automático do worker — não precisa de reiniciar.

> **Abrir a URL raiz do túnel sem a chave dá `401`** (sem pedir login, sem
> popup). A chave é **reutilizável** até `/rotacionar` (gera chave nova e
> invalida as sessões) ou derrubar o túnel (`/desligar`, `/emergencia`). Nunca
> precisas de digitar uma senha em lugar nenhum.

## Passo 3 — Confirmar o modelo (local abre; borda sem chave bloqueia)

Com o DSH a correr em `127.0.0.1:3080`:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
200
```

**O acesso local abre direto (resultado `200`).** É o comportamento esperado: o
DSH **não é guardado no loopback** — não há login em lado nenhum. A proteção
vive na superfície do **túnel**: abrir a URL raiz do túnel **sem a chave** dá
`401` (sem pedir login, sem popup). Se o local **não** abrir, para antes de
continuar (ver `docs/TROUBLESHOOTING.md`).

## Passo 4 — Configurar o Telegram (opcional)

O controlo pelo bot é opcional; sem ele o acesso pelo túnel não tem um canal
automático de entrega do link (fica por configurar — ver `docs/ONBOARDING-TELEGRAM.md`:
BotFather → token → pareamento de 6 dígitos). **Não há senha a digitar em lugar
nenhum.**

> **O fluxo de acesso com o bot:** depois de pareado, ao correr `/ligar` e quando o
> túnel fica READY, o bot **envia automaticamente** o link com a chave
> `https://<url-pública>/?key=<token>`. Quem abre o link entra (a `?key=` válida é
> trocada por sessão) e a sessão continua no navegador via cookie. **Sem sessão e
> sem `?key=` o túnel devolve `401`.** No painel da UI
> (`/__guard-ui`), o botão do Telegram mostra o estado OFFLINE/ONLINE fiel ao runtime: ao
> clicar em OFFLINE aparecem as instruções `--pedir-token` / `--parear`, e quem as segue
> de facto coloca o bot **online**.

## Passo 4b — Configurar o Discord (opcional, no lugar do Telegram)

O Discord é o segundo provedor suportado (`config.worker.provider: 'discord'`).
O guia do usuário completo — criar a aplicação, convidar o bot para um servidor
com permissão de mensagens e parear — está em
[`docs/ONBOARDING-DISCORD.md`](ONBOARDING-DISCORD.md); aqui está o essencial do
lado da máquina:

1. **Criar o bot no Developer Portal** — https://discord.com/developers/applications →
   **New Application** (dá-lhe um nome) → aba **Bot** → **Reset Token** (mostra o
   token; guarda-o — só aparece uma vez).
2. **ATIVAR o intent de conteúdo de mensagens** — no Developer Portal, aba
   **Bot**, liga **MESSAGE CONTENT INTENT** (é um intent **privilegiado**).
   Sem ele o gateway fecha a ligação com o close **4014** ("disallowed intents")
   e o bot não responde a nada: este plugin declara `MESSAGE_CONTENT` no
   identify porque lê o texto dos comandos (`INTENTS_DO_BOT` = 37376 —
   `GUILD_MESSAGES` + `DIRECT_MESSAGES` + `MESSAGE_CONTENT`).
3. **Configurar o token** — a variável do provedor discord é
   **`DISCORD_BOT_TOKEN`** (não `TELEGRAM_BOT_TOKEN`). Grava-a com
   `dsh-guard-setup --pedir-token` (ele usa a chave do provedor ativo no
   `secrets.env` partilhado — o ficheiro guarda as duas linhas, cada provedor
   com a sua) ou diretamente no ambiente.
4. **Trocar o provedor na config** — no `config` do `cordis.patch.yml`
   (Camada 2/Home — o Bundle declara `telegram`), muda:
   ```yaml
   worker:
     token: !!js "process.env.DISCORD_BOT_TOKEN ?? ''"
     provider: discord
   ```
   O host rotula o filho com `DSH_GUARD_PROVIDER=discord` e injeta o
   `DISCORD_BOT_TOKEN` (tabela `PROVIDER_ENV` de `src/proc/env.ts`); o boot
   genérico resolve o adaptador discord. Um `DSH_GUARD_PROVIDER` desconhecido
   recusa arrancar — nunca degrada em silêncio para outro provedor.
5. **Convidar o bot para o teu servidor** com permissão de **Enviar Mensagens**
   (e ler mensagens), depois **parear**: mesmo fluxo do Telegram — código de
   6 dígitos do painel/CLI + `/parear <código>` no bot (o pareamento é do
   núcleo neutro e o dono é gravado por `pairing.owner`, igual nos dois).
6. **Reinicia o DSH** se já estiver a correr (o worker só arranca no boot).

> **Raiz da API opcional:** `DISCORD_API_ROOT` (default
> `https://discord.com/api/v10`) — só para ambientes de teste com duble.

> **Limites do canal (o núcleo corta por eles):** mensagem de texto 2000
> caracteres, teclado 5 linhas × 5 botões, `custom_id` 1..100 bytes, edição
> in-place suportada. Ver a tabela em [`docs/PROVIDERS.md`](PROVIDERS.md) §2.1.

## Passo 4c — Disparar agentes do harness (opcional)

O dispatcher de agentes (`docs/AGENTS.md` — manual completo) fica **desligado
por omissão**: sem o eixo `agents` na config, nenhum agente é disparável
(fail-closed). Para o ligar, declara a allowlist de skills e o teto de runs
concorrentes no `config` do `cordis.patch.yml` (Camada 2/Home — o Bundle não o
declara de propósito):

```yaml
config:
  # ... as tuas chaves existentes
  agents:
    skills: ['code-review', 'surf-research-agent']   # allowlist default deny
    maxRuns: 4                                       # 1..32
```

- `skills` vazio/ausente = **nenhum agente disparável**; cada nome é
  kebab-case e é validado no arranque.
- `maxRuns` é o teto de runs concorrentes (inteiro 1..32, validado no arranque);
  acima dele, `/agente` é recusado com mensagem acionável.
- No bot: `/agente <skill> <o que o agente deve fazer>` (confirmação em 2
  etapas), `/agentes` (lista os runs) e `/parar-agente <id>` (cancela). O
  agente roda com as permissões do harness e **nunca** recebe o token do bot.
- Reinicia o DSH depois de alterar a config.

## Passo 5 — Expor (opcional) e desmontar

- Para expor ao telemóvel, consulta `docs/EXPOSURE.md` (modos) e `docs/TUNNEL.md` (o túnel em si e o modelo de ameaça).
- **Desinstalar e reverter:**

```sh
dsh plugin remove dsh-guard-messenger
```

Desinstalar deixa **zero processos remanescentes** (nenhum worker nem túnel) e a UI do DSH volta ao comportamento original (sem portão) — verificado no smoke test pós-release (`docs/plano/04-TESTES.md §10` item 12).

## O que foi instalado

| Ficheiro | Camada | Papel |
| --- | --- | --- |
| `cordis.patch.yml` | **Bundle** (camada 1, mínima) | Regista o próprio plugin. Entra com `dsh plugin add`. |
| `cordis.profile.patch.example.yml` | **Profile** (camada 2, opcional) | Exemplo de endurecimento (bind, configs específicas). **Comentado** — lê antes de aplicar. |

O *bind* continua em `127.0.0.1` por omissão. Exposição à rede faz-se **sempre** por um processo autenticado (`cloudflared`) à frente do loopback — nunca alargando o bind. Um patch de camada superior (`$DSH_HOME/cordis.patch.yml`, camada 3; ou `--patch` da CLI, camada 4) **sobrepõe-se** a este pacote, inclusive ao *bind*: audita as camadas superiores como parte da instalação segura.

## Conteúdo do tarball (só se estiveres a publicar)

O tarball publicado contém `dist/`, `cordis.patch.yml`, `README.md`, `LICENSE` e `CHANGELOG.md` (decisão D13). O script de validação é o `scripts/check-tarball.mjs`. O install normal descrito acima não exige publicar nada.
