# PANEL-TELEGRAM — o painel "Remote Access" do DSH

Status: **IMPLANTADO**. O painel fica na aba **"Remote Access"** (slot
`settings.section`) do modal de settings do harness, com `look-and-feel` herdado
do shell (tokens `--dsw-*`). É o caminho "tudo pela interface" para criar o bot,
parear e comandar o acesso ao teu Harness pelo Telegram.

> **Onda 1 — nome e botões:** o nome VISÍVEL do painel passou de "Telegram Guard"
> para **"Remote Access"**. O `id` da secção `telegram-guard`, o `registrant` e o
> pacote `dsh-guard-messenger` **NÃO mudaram** — só o rótulo exibido.

> **Este é o MANUAL de uso.** Os textos EXATOS (rótulos, CTAs, erros) e a lógica
> de decisão por estado estão em **`docs/ux/02-CONTRATO-PAINEL.md`** (e o texto
> do bot, em `docs/ux/01-CONTRATO-BOT.md`). Aqui resume-se o fluxo e aponta-se o
> contrato — não se repete o inventário.

---

## O painel é uma trilha de 3 passos

Não é um wizard modal: é uma **trilha vertical de checkpoints na mesma tela**.
O passo concluído fica `✓` e **colapsado**; **só o passo atual fica aberto**; os
passos futuros ficam diminuídos para a atenção ir ao único passo acionável.

```
✓   Passo 1 · Criar o bot    (só quando ainda não há token)
◉   Passo 2 · Parear          (quando tem token e ainda NÃO pareou)
◉   Passo 3 · Usar            (quando pareado)
```

---

## Passo 1 — Criar o bot

Quando **ainda não há token** (`configurado === false`), o painel abre neste
passo. Uma instrução curta — `Cole o token que o @BotFather te entregou ao criar
o bot. Fica guardado seguro nesta máquina.` — seguida de:

- um campo **Token do bot (@BotFather)** (`password` + toggle `👁`/`🙈`);
- **um CTA primário: `Salvar bot`** (loading honesto: `A conectar ao Telegram…`);
- **(se precisares criar o bot do zero)** um `<details>` "Como criar o bot do
  zero" com os passos numerados do **@BotFather** (`/newbot` → nome → `@username`
  que termina em `bot` → copiar o token no formato `<número>:<segredo>`).

O cartão colapsado (depois) mostra `Bot @handle conectado` + text-link `Trocar`.
Erros seguem o contrato do painel (§1 de `02-CONTRATO-PAINEL.md`) e **guiam** a
correção (ex.: `Formato errado. O token vem assim: 123456:aaaa…` + botão
`Revisar token`).

> **Conexão com o bundle:** este passo corresponde ao `POST /token` com CSRF da
> superfície; a fonte do token nunca sai do backend nem vai para o bundle — o
> painel só devolve `handle`/`ok`/`erro`.

---

## Passo 2 — Parear

Quando **configurado e ainda NÃO pareado** (`configurado === true && !pareado`).
O botão **`Gerar código`** pede ao host um código de **6 dígitos** (TTL de 5
min), que é renderizado **só aqui**:

1. o painel mostra o código em **caixa monospace ESPAÇADA** (`1 2 3 4 5 6`) e um
   botão **`Copiar`**;
2. um **countdown** visível (`expira em 4:53`) e **`Gerar novo`** (se expirar,
   `Este código expirou. Gera um novo.`);
3. a **instrução única** (modo híbrido):
   **`No Telegram, envia: /parear 123456 no @handle — ou só /parear e o bot pede o código`**
   (o código **nunca** é enviado pelo painel — és tu que o ditas ao bot; se
   enviares só o `/parear`, o bot pergunta o código na conversa e usa a tua
   próxima mensagem de texto como resposta — ver `docs/ux/04-CONVERSA-INTELIGENTE.md`);
4. um **status ao vivo** que troca de **`Aguardando…`** → **`✓ Pareado`** quando
   o worker conclui o handshake.

Quando `✓ Pareado`: `Pareado! Este painel agora controla o bot. Vai ao Passo 3
para começar.`

> **Segurança:** o código de 6 dígitos **só existe no host e neste painel** —
> nunca em log, nunca na auditoria, nunca no Telegram (só o **digest sha256**
> viaja por `pairing.challenge`). O `POST /pair` é protegido pela barreira de
> loopback/túnel autenticado + CSRF. Uma **segunda parelha é recusada**
> (PAIR-005): para trocar de dono é preciso reset na máquina.

---

## Passo 3 — Usar (pareado)

Quando pareado. Comandos essenciais, 1 linha cada:

- `/menu` — abrir o painel de controlo do bot
- `/status` — ver o estado do túnel
- `/emergencia` — derrubar tudo de imediato

(os demais — `/ligar /desligar /acessar /rotacionar` — ficam nos **botões do
cartão `/menu`** do bot, não repetidos aqui; reduz a lista e o ruído.)

Dois `<details>`:
- **Avançado ▸** — `Trocar o token` (volta ao Passo 1 com confirmação),
  `Desfazer parear` (confirmação destrutiva) e `Ver todos os comandos`.
- **E minha conversa? ▸** — uma linha de risco + o que o design garante:
  `As tuas conversas com o bot ficam neste aparelho e no Telegram, com
  privacidade por omissão: nenhum comando de estranho funciona e quem não pareou
  não recebe resposta.`

A confirmação de `Desfazer parear` ganhou a linha **"O painel vai re-verificar
o estado do bot."**; ao confirmar (tanto `Trocar o token` quanto `Desfazer
parear`), o painel dispara refresh completo do estado + checagem AO VIVO de
descoberta (`getMe` forçado). O `desfazer` continua **sem rota no painel** —
re-parear exige `--reset-pairing` na máquina (o texto guia, não força).

O bloco **"Uso recente"** (KPIs `Conexões ativas`/`Sessões vivas`, lista de
sessões e botão `Atualizar`) foi **removido**: o painel não consulta mais
`GET /access` (a rota continua no backend, mas o client não a usa).

---

## O menu novo do bot (5 comandos, escopos)

A lista publicada (`setMyCommands`) mudou para **5 comandos**, e divide-se em
dois escopos (v. `docs/ux/01-CONTRATO-BOT.md §2`):

| Escopo | Comandos | Descrição |
|---|---|---|
| `default` (grupos e privado) | `/start` e `/ajuda` (o `/start` na aparece no menu — boas-vindas inócuas, PAIR-006) | descoberta segura, não vaza estado |
| **privado** (só DM) | `/menu`, `/status`, `/parear`, `/emergencia` | ações/estado |

O `setMyCommands` é publicado **duas vezes**: `default` (start/ajuda) e
`all_private_chats` (menu/status/parear/emergencia). Em grupos qualquer comando
é barrado pelo guard — por isso a descoberta de ações fica restrita ao privado.

> Textos EXATOS dos comandos e dos botões do bot (cartão `/menu`, telas de
> confirmação com botão `✕ Não`, toasts): ver `docs/ux/01-CONTRATO-BOT.md` §4/§5.

---

## Estado do bot e contexto rápido

- **Chip do cabeçalho** (ao lado do título "Remote Access") = estado AO VIVO do
  bot via `GET /telegram`: a carregar → neutro `verificando…`; token NÃO
  configurado → `Não configurado` (ou `Env manda` quando `TELEGRAM_BOT_TOKEN`
  está no ambiente); configurado + online → verde `Online` (detalhe `@handle`,
  ou a fonte do token sem handle); configurado + offline → aviso `Offline` com
  o `motivo` da rota (`sem-chave` / `sem-pareamento`).
- **Refresh automático a cada ~5 s** enquanto a aba estiver aberta, mais
  re-busca no mount e em `window.focus`/`visibilitychange`; o ticker de 1 s só
  re-renderiza o countdown do código de pareamento.
- O token de ambiente `TELEGRAM_BOT_TOKEN` tem **precedência**: estando definido,
  o painel responde **`token-por-env`** e avisa que um token gravado no
  `secrets.env` não mudaria o bot até a variável sair do ambiente.

---

## Fora de escopo e notas de build

- O smoke headless da aba é o teste commitado `test/unit/client/index.test.ts`
  (regista só `settings.section`, cobre o CSRF novo `x-dsh-csrf`).
- O CSS é plain com prefixo `guard-` embebido no `lib/client.js` pelo
  `scripts/build-client.mjs` (text-loader); cores vêm de tokens `--dsw-*`.