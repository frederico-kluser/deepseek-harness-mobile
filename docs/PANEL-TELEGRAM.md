# PAINEL-TELEGRAM — o painel completo do Telegram na UI do DSH

Status: **IMPLENTADO** (Onda 2 · sub-agente do painel). O placeholder do spike
(Onda 1) foi substituído por um painel completo na aba **"Telegram Guard"** do
modal de settings, alimentado pelos endpoints do backend half (`/__guard-ui/*`),
com look-and-feel herdado dos ui-settings do harness (mesmos tokens `--dsw-*`).

---

## O QUE O PAINEL FAZ

O botão **"✈️ Telegram"** (rodapé da sidebar, slot `sidebar.footer.action`) foi
**REMOVIDO** — o acesso ao painel agora é pelo **botão padrão de settings** do
shell: o modal abre e a aba **Telegram Guard** (slot `settings.section`) aparece
no rail. O client contribui SÓ com essa aba. Ela mostra cinco blocos, todos a
"falar" com o backend:

| Bloco | O que mostra | Endpoint |
|------|--------------|----------|
| **Estado "configurado?"** | Chip verde "Configurado (secrets)" / neutro "Não configurado" / laranja "Configurado via env" | `GET /token-state` + `GET /telegram` |
| **Como criar o bot** | Cartão passo-a-passo do **@BotFather** (só quando NÃO configurado) com os passos numerados para criar o token novo, + nota de revogação `/token` | — (estático, só quando `configurado === false`) |
| **Chave do bot** | Campo `type="password"` com toggle mostrar/ocultar e botão **"Validar e configurar"** (POST com CSRF, estados renderizados na própria aba) | `POST /token` |
| **Instruções + marcador do bot** | Cartão com comandos copiáveis (`/parear <código>`, `/acessar`, `/ligar`, `/status`, `/rotacionar`, `/desligar`, `/emergencia`) e badge **Bot ONLINE / OFFLINE** com o `motivo` | `GET /telegram` (marcador) |
| **Acesso agora** | KPIs **Conexões ativas** e **Sessões vivas** + lista de sessões vivas (userAgent→device, tempos relativos, `ip` quando confiável), aviso de "IP não confiável", botão **Atualizar** + refresh automático ~15s | `GET /access` |

### Atualização automática
Os dados são re-buscados:
- no **mount** da aba;
- a cada **~15 s** enquanto a aba estiver aberta (ticker);
- em **`window.focus`** e **`document.visibilitychange`** (quando o utilizador
  configura o token, fechar/janela volta a ativar → o painel reflete na hora);
- o ticker de **1 s** só anima os tempos relativos ("há quanto tempo").

### Estados de resposta do `POST /api/token` (renderizados na aba, sem `alert`)
- **200** `{ok:true, handle, fonte:'secrets'}` → mensagem **"Configurado ✓ @handle"**, limpa o campo, volta a ler o estado;
- **400** `token-vazio` / `formato-invalido` → erro inline com a causa;
- **409** `token-por-env` → **aviso destacado** com a instrução exata do campo `aviso` ("a variável do ambiente manda; remova-a ou use o token dela");
- **422** `token-invalido` → erro inline ("o Telegram rejeitou o token — confira no @BotFather");
- rede falhou → erro inline genérico, **nunca vaza nada**.

---

## COMO CRIAR O BOT (@BotFather) — fluxo no painel

Quando **não há token configurado** (`configurado === false` e fonte `nenhum`),
o painel mostra, ANTES do campo de token, um cartão **"Como criar o bot"** com
os passos numerados:

1. Abra o Telegram e converse com **@BotFather**.
2. Envie **/newbot**.
3. Dê um **nome** para o bot (ex.: "Meu dsh-messenger").
4. Dê um **username** que termine em `bot` (5–32 caracteres, `A-Za-z0-9_`, ex.:
   `meu_dsh_messenger_bot`).
5. O BotFather responde com um **token** no formato `<número>:<segredo>` —
   copie-o.
6. Cole o token no campo e clique em **"Validar e configurar"**.

Mais uma nota curta no rodapé do cartão: *"Se precisar trocar o token depois,
use `/token` no @BotFather para revogar e gerar outro."*

O cartão **desaparece** assim que o token é validado (o estado passa a
configurado) — nessa altura o painel mostra o cartão **Instruções** (comandos) e
o marcador do bot.

---

## COMO TESTAR (runtime isolado)

O mesmo runtime isolado do spike (Onda 1) serve o painel:

```bash
DSH_HOME=/home/ondokai/.dsh-guardbot  pnpm dsh cert   # se ainda não tiver
# … start do harness com o profile web e o plugin carregado (ver SPIKE-CLIENT-SLOTS.md)
```

1. Launch no harness → abre o settings pelo **botão padrão** do shell e escolhe
   a aba **Telegram Guard** no rail.
2. **Sem token**: chip "Não configurado"; antes do campo aparece o cartão
   **"Como criar o bot"** com o fluxo do @BotFather.
3. Segue os passos do @BotFather, cola o token no campo e clica
   **"Validar e configurar"**.
4. Cola um token inválido → erro inline **422** (confere no @BotFather).
5. Cola um token válido → ok "Configurado ✓ @handle", chip fica verde, o cartão
   do @BotFather some e surge o cartão **Instruções** com os comandos e o
   **marcador** do bot.
6. Com a variável `TELEGRAM_BOT_TOKEN` definida → `POST /api/token` responde
   **409** `token-por-env` e o painel mostra o aviso com a instrução exata
   (o env manda — remova a variável ou use o token dela).
7. **Acesso agora**: abre um noutro browser/incógnito e entra pelo link do
   túnel → vês as KPIs subirem e a lista de sessões vivas (device e tempos).
   Sem `trustEdgeHeaders` o IP aparece como tag **"IP não confiável"** e há um
   aviso discreto no cartão.

### Smoke headless (registo só settings.section + BotFather + CSRF novo)
O bundle deve ser verificado a cada mudança com: `pnpm run build:client` e o
teste `test/unit/client/index.test.ts` (roda em `pnpm test`). Ele carrega
`lib/client.js` num sandbox com `window.__ModuleLoader__` esticado, chama
`apply(ctx)` com um `ctx.slots` stub e confirma que regista **só**
`settings.section` (o `sidebar.footer.action` foi removido e não deve mais
aparecer) — E cobre o CSRF novo (HIGH-2): o `buscarTokenCsrf` busca
`GET /__guard-ui/api/csrf` no fetch stub, o fallback ao meta do chrome antigo
funciona, e o `apiPost` envia o token **novo** no header `x-dsh-csrf`. Um teste
de bundle verifica ainda que o cartão "Como criar o bot" (@BotFather, `/newbot`,
"Validar e configurar", nota `/token`) está presente e que o
`sidebar.footer.action`/`guard-bot-button` não estão no bundle.

### Instalação por git roda o `prepare` (HIGH-1)
`package.json` ganhou `"prepare": "pnpm run build:all"` — qualquer
`git clone` + `pnpm install` do repositório **gera `lib/client.js` e `dist/`
automaticamente** antes de o harness montar o bundle (`exports["./client"]` →
`lib/client.js`). Sem isso a ativação do client lançaria
`MissingClientBundleError` (packages/client/modules/src/index.ts). O `prepare`
não altera o lockfile (`pnpm install --frozen-lockfile` continua a passar) e os
artefatos (`lib/`, `dist/`) continuam **ignorados no git** (`.gitignore`) — são
a saída do build, não fonte. O `files` do tarball já inclui `lib` e `dist`, e o
`scripts/check-tarball.mjs` (no `package:check`) exige `lib/client.js` no pack.

---

## PAREAR PELO PAINEL

Com o token configurado e o bot ainda **sem pareamento**, o painel mostra o
cartão **"Parear pelo Telegram"** (em vez de só o badge OFFLINE). É o caminho
"tudo via interface": não é preciso abrir o terminal para parear.

**Fluxo passo a passo:**

1. **Garanta o token configurado.** Sem token, o painel mostra o cartão
   @BotFather; o botão "Parear pelo Telegram" só aparece depois de configurar a
   chave (fonte `ENV` ou `secrets.env`).
2. **Toque em "Parear pelo Telegram".** O painel pede à costura do host a rota
   `POST /__guard-ui/api/pair` (com CSRF, como qualquer escrita da superficie).
3. **O host gera um código de 6 dígitos** (a MESMA máquina do CLI:
   `criarSessaoDePareamento`, TTL 5 min, anti-reuso/dobra `PAIR-010`) e envia ao
   worker `pairing.challenge` com o **digest sha256** do código — nunca o claro.
4. **O painel mostra o código em destaque** (mono, grande) e a instrução:
   `No Telegram, envie: /parear <código> no bot @<handle>`, com contagem
   regressiva (`m:ss`) e o estado **"Aguardando pareamento…"**.
5. **O dono digita `/parear <código>` no bot** (a conversa com o bot; não é o
   host que envia — o código viajou só do host para o painel).
6. O worker valida o digest, responde no chat **e** avisa o host por
   `pairing.success` (nova mensagem IPC worker→host). O host **grava o dono no
   `state.json`** (`pairing.ownerUserId/ownerChatId/pairedAt`) e **devolve
   `pairing.owner`**, que liberta a allowlist **no ato** (`auth.semearDono`) —
   sem reiniciar.
7. O painel **sonda `GET /__guard-ui/api/pair-state` a cada ~3 s** e, quando
   `pareado:true`, troca para **"Pareado ✓"** e mostra as instruções de uso.

**Expiração e repetição.** Se a contagem chegar a `0:00` e ainda não houver
pareamento, o painel avisa **"O código expirou"** e oferece **"Gerar novo
código"**. O código expirado/descartado não deixa janela aberta (a sessão morre;
o estado é seguro).

**O que acontece com o menu do bot.** O `setMyCommands` já publicou o menu `/`
no Telegram (os 7 comandos: `/ligar /desligar /status /acessar /rotacionar
/parear /emergencia`). O pareamento pelo painel **não muda o menu** — só usa o
`/parear <código>` existente para fechar o handshake; o menu continua a aparecer
na conversa com o bot normalmente.

**Nota de segurança.** O código de 6 dígitos **só existe no host (memória) e
neste painel** — nunca em log, nunca em auditoria, nunca enviado por Telegram.
O que viaja pelo canal é apenas o **digest sha256** (`pairing.challenge`); quem
digita `/parear` é o dono, ao dedo, na conversa com o bot. A rota `POST /pair`
é protegida pela MESMA barreira de loopback/túnel autenticado e pelo CSRF da
superficie (`x-dsh-csrf`, binding `ui-contrib`).

---

## FORA DE ESCOPO (next / Onda 3)
- O smoke headless agora é o teste commitado `test/unit/client/index.test.ts`;
  um refinamento futuro seria renderizar a aba inteira num DOM (jsdom/smoke de
  UI) para cobrir o fluxo de formulário end-to-end — hoje cobre o registo dos
  slots e o CSRF novo, não a renderização React.

---

## COMO O CSS FOI EMBUTIDO (decisão de build)

`client/guard-panel.css` é **CSS plain** com prefixo `guard-` em TODAS as
classes (sem CSS Modules hashado). O `scripts/build-client.mjs` usa o loader
**`{ '.css': 'text' }`** do esbuild (built-in, zero deps novas) para virter o
ficheiro para uma STRING embebida no próprio `lib/client.js`; o `apply` injeta-a
num `<style id="dsh-guard-panel-css">` (idempotente por documento).

**Porquê text-loader e não CSS Modules (`local-css`):** o harness monta SOMENTE
`lib/client.js` (`/plugins/<id>/client.js`) — não serve side-cars de CSS. O
`local-css` do esbuild despacharia o CSS para um output irmão que ninguém
serviria, ou exigiria `write:true` com `client.css` à parte. O `text` loader
mantém tudo num ficheiro. O prefixo `guard-` dá o mesmo isolamento que o hashing
do CSS Modules, mas sem depender de classe gerada.

Todas as cores/estados vêm de tokens do tema (`var(--dsw-alias-label-primary)`,
`--dsw-alias-bg-layer-2`, `--dsw-alias-state-success-primary`, …) — o painel
herda o tema light E dark do shell. Sem literais hardcoded.

---

## NOTA DE SEGURANÇA DO TOKEN

- O token vem **pelo painel** (`POST /api/token`), não pela CLI — mas o env
  `TELEGRAM_BOT_TOKEN` tem **precedência**: estando definido, o painel responde
  **409 `token-por-env`** e avisa que um token gravado no `secrets.env` não
  mudaria o bot até a variável sair do ambiente.
- O valor do token **nunca** sai do backend nem entra no bundle: as respostas
  só devolvem `handle`/`ok`/`erro`. Todo POST envia `x-dsh-csrf`, e a fonte do
  token **não é uma só** (HIGH-2):
  - **Fonte preferida** — `GET /__guard-ui/api/csrf`, o mesmo guard da
    superficie emitindo um token stateless **fresco por POST** (barato e
    stateless, sem depender do chrome antigo). O bundle busca-o a cada
    escrita; se a GET falhar cai no fallback abaixo.
  - **Fallback (chrome antigo)** — `<meta name="dsh-guard-ui-csrf">` que o
    `tapIndex` injeta no índex (compat reversa).
  - Se **nenhuma** das duas der, o POST recusa com mensagem clara ("CSRF
    indisponível — recarregue") — nunca envia sem token.
- A lista de acesso **nunca** mostra `?key` nem o id de sessão em claro: o hash
  é truncado a 8 chars como identidade visual.