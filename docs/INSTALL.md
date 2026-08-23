# INSTALL.md — instalação passo a passo

Este guia instala o plugin `dsh-guarded-bot-orchestrator` num DeepSeek Harness (DSH) e verifica que o portão está a funcionar. Pressupõe:

- um **DSH instalado e a correr** (o formato canónico da *awesome-list* é `dsh plugin --profile <perfil> add <pacote>`; alternativamente `add github:owner/repo`);
- **Node ≥ 24** (`engines.node: ">=24"`);
- sistema **Linux ou macOS** (`os: ["linux","darwin"]`);
- para o túnel, o binário `cloudflared` (ver `docs/TUNNEL.md`).

> **Compatibilidade:** a faixa suportada é `@deepseek-ai/dsh` `0.1.0-rc.7 .. 0.1.1-rc.1` (política N/N-1). Veja a tabela em `docs/COMPATIBILITY.md` — que é **gerado** de `dsh-compat.yml`, nunca editado à mão.

---

## Passo 0 — Pré-requisitos (M0)

- Máquina com o DSH instalado.
- Conta Telegram e o app no celular (só se quiseres o controlo pelo bot; o portão HTTP funciona sem isso).
- `cloudflared` **verificado por checksum** antes de qualquer uso — a release do GitHub publica o sha256 nas release notes e o próprio binário loga o seu checksum no startup. Alternativa preferida: repo apt assinado (`pkg.cloudflare.com`, chave `cloudflare-main.gpg`), que dá verificação automática (`docs/plano/08-PESQUISA-E-FONTES.md §8` fato 10).

## Passo 1 — Adicionar o plugin

```sh
dsh plugin --profile web add dsh-guarded-bot-orchestrator
```

> **Não copies ficheiro nenhum à mão.** A camada de *Bundle* deste pacote entra **automaticamente** com o `dsh plugin add`: o `package.json` declara `dsh.bundle.patch`, o que ativa o manifesto de Bundle (`cordis.patch.yml`) sem passo de `cp` manual. Uma cópia manual antiga teria aplicado as mesmas entradas uma segunda vez, noutra camada de precedência.

## Passo 2 — Arrancar o DSH

```sh
dsh web
```

No arranque o plugin deverá:

1. validar o **bind** (em loopback) e gritar se estiver fora da allowlist;
2. subir o **portão** — sem credencial, `/api` e a UI respondem `401`;
3. deixar o **Telegram** disponível para configurar depois ("não configurado").

## Passo 2.5 — Obter a senha do portão (uma única vez)

A senha do portão **não depende do Telegram** e é mostrada pelo CLI de
onboarding, não pelo boot:

```sh
dsh-guard-setup
```

Na primeira execução ele gera a **senha** (CSPRNG, 256 bits) e mostra-a **uma
única vez**, em texto agrupado e em QR ASCII — mesmo que ainda não haja bot do
Telegram configurado (o estado do Telegram é o passo seguinte, não um
pré-requisito da senha). Correr outra vez não regenera nada (`hasSecret` guard).

Exemplo de saída:

```console
$ dsh-guard-setup
Esta é a sua senha de acesso. Ela aparece UMA única vez e não fica em lado
nenhum em claro — em disco guarda-se apenas uma impressão digital dela.
Aponte a câmara ao quadrado para a levar para o telemóvel.

MJDN-2GVY-KP7S-<...>-4TZP

█▀▀▀▀▀█ █ ... (QR ASCII)
...
Falta criar o bot no Telegram.
Ainda não há nenhum bot do Telegram ligado a esta máquina. ...
```

> A senha é mostrada no **terminal local**. Se a perderes, não há reposição pela rede: a entrega é local (`docs/ONBOARDING-TELEGRAM.md`) e a rotação (`/rotacionar` no bot ou o painel) gera outra e fecha as sessões abertas. A **senha permanente nunca viaja pelo Telegram** — o que pode viajar é apenas o **link de acesso de uso único** (`mk`), que o bot envia no `/ligar`.

## Passo 3 — Verificar que o portão está ativo

Com o DSH a correr em `127.0.0.1:3080`:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/commands/execute
401
```

**Sem credencial o resultado tem de ser `401`.** Se devolver `200`, o portão não está a proteger `/api` — para antes de continuar (ver `docs/TROUBLESHOOTING.md`).

## Passo 4 — Configurar o Telegram (opcional)

O controlo pelo bot é opcional; o portão HTTP funciona só com a senha. Para ligar o bot, segue `docs/ONBOARDING-TELEGRAM.md` (BotFather → token → pareamento de 6 dígitos). A **senha permanente** nunca é enviada pelo Telegram.

> **O fluxo de acesso com o bot:** depois de pareado, ao correr `/ligar` e quando o
> túnel fica READY, o bot **envia automaticamente** o link autenticado
> `https://<url-pública>/__guard/magic#mk=<token-de-uso-único>` — de **uso único** e com
> TTL. Quem abre o link entra **sem digitar senha** e a sessão continua no navegador via
> cookie. **Sem o link (ou a senha) o portão continua a devolver `401`.** No painel da UI
> (`/__guard-ui`), o botão do Telegram mostra o estado OFFLINE/ONLINE fiel ao runtime: ao
> clicar em OFFLINE aparecem as instruções `--pedir-token` / `--parear`, e quem as segue
> de facto coloca o bot **online**.

## Passo 5 — Expor (opcional) e desmontar

- Para expor ao telemóvel, consulta `docs/EXPOSURE.md` (modos) e `docs/TUNNEL.md` (o túnel em si e o modelo de ameaça).
- **Desinstalar e reverter:**

```sh
dsh plugin remove dsh-guarded-bot-orchestrator
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
