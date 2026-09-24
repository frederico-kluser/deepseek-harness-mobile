# INSTALL.md — instalação passo a passo

Este guia instala o plugin `dsh-guard-messenger` num DeepSeek Harness (DSH) e verifica que o portão está a funcionar. Pressupõe:

- um **DSH instalado e a correr** (o formato canónico da *awesome-list* é `dsh plugin --profile <perfil> add <pacote>`; alternativamente `add github:owner/repo`);
- **Node ≥ 24** (`engines.node: ">=24"`);
- sistema **Linux ou macOS** (`os: ["linux","darwin"]`);
- para o túnel, o binário `cloudflared` (ver `docs/TUNNEL.md`).

> **Compatibilidade:** a faixa suportada é `@deepseek-ai/dsh` `0.1.0-rc.7 .. 0.1.1-rc.1` (política N/N-1). Veja a tabela em `docs/COMPATIBILITY.md` — que é **gerado** de `dsh-compat.yml`, nunca editado à mão.

> **Compat (arquitetura de provedores):** o worker é neutro ao provedor e suporta **um
> fornecedor: Telegram** (`config.worker.provider`, default `telegram`). Token na
> variável `TELEGRAM_BOT_TOKEN` (via `dsh-guard-setup`), pareamento
> e comandos (incluindo os de agentes — ver o Passo 4b). Detalhe em
> [`docs/PROVIDERS.md`](PROVIDERS.md) e [`docs/AGENTS.md`](AGENTS.md).

> **SECURITY: exige ação do utilizador (migração):** quem tem `worker.provider`
> apontado para o provedor removido (herdado de uma versão antiga — hoje o único
> valor aceite é `'telegram'`) tem de **remover a linha ou mudá-la para
> `'telegram'`** antes do arranque. Sem essa alteração o plugin não arranca: o
> boot falha alto com `config.worker.provider = '<valor>' nao e um provedor
> conhecido (telegram)` — fail-loud por decisão (nunca degrada em silêncio). A
> mensagem literal, com o nome do provedor removido, está registada no
> `CHANGELOG.md`. Quem já usa só o Telegram nada muda.

---

## Passo 0 — Pré-requisitos (M0)

- Máquina com o DSH instalado.
- Conta Telegram e o app no celular (só se quiseres o controlo pelo bot; o portão HTTP funciona sem isso).
- `cloudflared` **verificado por checksum** antes de qualquer uso — a release do GitHub publica o sha256 nas release notes e o próprio binário loga o seu checksum no startup. Alternativa preferida: repo apt assinado (`pkg.cloudflare.com`, chave `cloudflare-main.gpg`), que dá verificação automática (`docs/plano/08-PESQUISA-E-FONTES.md §8` fato 10).

## Passo 1 — Adicionar o plugin

```sh
dsh plugin --profile web add dsh-guard-messenger
```

Ou **pelo link do repositório**:

```sh
dsh plugin add github:frederico-kluser/dsh-guard-messenger
```

O install-by-link funciona **sem `allowBuilds` e sem build no install**: os
artefactos compilados (`dist/`, `lib/`) vêm commitados no git e os hooks
`prepare`/`prepack` foram removidos de propósito — o pnpm 11 bloqueia build de
dependências git (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`).

> **Nota de release:** o comando por link só funciona depois de o ramo com este
> fix estar **pushado no GitHub**; enquanto o repositório servir a árvore antiga
> (a que ainda tinha `prepare`), o `pnpm add github:…` falha com
> `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`.

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

## Passo 4b — Disparar agentes do harness (opcional)

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

O tarball publicado contém `dist/`, `lib/`, `logo.png`, `cordis.patch.yml`,
`README.md`, `LICENSE` e `CHANGELOG.md` (lista `files` do `package.json`,
decisão D13). Os artefactos compilados `dist/`+`lib/` são **commitados no git**
(sem `prepare`/`prepack` de propósito — ver o Passo 1) e a validação corre em
`package:check`: `scripts/check-tarball.mjs` (conteúdo do tarball) e
`scripts/check-git-install.mjs` (install-by-link de ponta a ponta). O install
normal descrito acima não exige publicar nada.
