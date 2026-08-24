# ONBOARDING-TELEGRAM — ligar o telemóvel ao DSH via bot

Guia para conectar o Telegram ao DSH guardado por este plugin e parear o teu
chat como dono. Todo o comando de controlo (ligar/desligar o túnel, estado) só é
aceite de um chat pareado.

> **Dois caminhos para configurar:** (a) o **painel "Telegram Guard"** (aba do
> settings) faz tudo pela interface — ver [`docs/PANEL-TELEGRAM.md`](PANEL-TELEGRAM.md);
> (b) a CLI `dsh-guard-setup` também guia o fluxo. O pareamento do chat é o mesmo
> nos dois. Os **textos EXATOS** do bot (boas-vindas, menu, telas de confirmação
> com botão `✕ Não`, respostas de pareamento) estão em
> [`docs/ux/01-CONTRATO-BOT.md`](ux/01-CONTRATO-BOT.md) e o padrão de microcopy em
> [`docs/ux/03-MICROCOPY.md`](ux/03-MICROCOPY.md) — aqui resume-se o uso.

> **Não há senha a digitar em lugar nenhum.** O acesso pelo túnel entra por
> **sessão** ou pela **chave no link** `?key=`. O bot é o canal de entrega: o
> `/ligar` (e o `/acessar`) **envia automaticamente** o link com a chave
> `https://<url-pública>/?key=<token>`. A chave pode aparecer no chat — **é o
> mecanismo** (é a chave do link, não uma "senha permanente"). Ela é
> **reutilizável** até `/rotacionar` (gera chave nova e invalida sessões) ou
> derrubar o túnel.
>
> Aviso honesto de canal: a conversa com o bot é *cloud chat* — não é
> ponta-a-ponta, o histórico fica nos servidores da Telegram. Como a chave viaja
> por aí, quem ler o chat lê a chave; foi por isso que a revogação existe. Outros
> segredos que **não** são a chave do link (token do bot, segredos internos)
> nunca devem aparecer no chat.

---

## Passo 1 — Criar o bot

No Telegram, conversa com **@BotFather** e corre `/newbot`. Dá um nome e um
`@username` **que termine em `bot`**. O BotFather devolve um **token** no formato
`<número>:<segredo>`. Guarda-o.

Se estiveres no **painel Telegram Guard**, o Passo 1 da trilha explica o mesmo
passo a passo (`<details>` "Como criar o bot do zero") e aceita o token com o
CTA `Salvar bot` (loading: `A conectar ao Telegram…`). O token fica guardado de
forma segura nesta máquina e **nunca** sai do backend para o painel.

---

## Passo 2 — Parear o teu chat (código de 6 dígitos)

1. Na **trilha do painel**, no Passo 2, toca **`Gerar código`**. O painel mostra
   um **código de 6 dígitos** (TTL de 5 min) em caixa espaçada, um botão
   **`Copiar`**, um **countdown** (`expira em 4:53`) e a instrução única:
   `No Telegram, envia: /parear 123456 no @handle`.
2. No bot, digita **`/start`** (opcional, antes de parear): o bot responde uma
   **boas-vindas inócuas — iguais para toda a gente** (PAIR-006) e **não pareia
   ninguém**. Segue o `/start` com o botão `🔘 Abrir menu`:
   - `👋 Olá. Este bot controla o acesso ao teu Harness pelo Telegram.\n\n Antes
     de mais nada, pareie-o: gere um código no painel e envie:  /parear 123456\n\n
     Depois, abra o menu para ligar e desligar o túnel.`
3. Manda **`/parear <código>`** com o código certo. O bot responde:
   `✓ Pareado com sucesso! Agora: /menu e /status.` (2 primeiras ações + aviso de
   segurança).
   - **Ou, no menu do bot, toca no comando `/parear`** (que envia `/parear` sem
     valor): o bot **PEDE o código** na conversa — `Envia-me o código de 6 dígitos
     que aparece no painel.` — e usa a **próxima mensagem de texto** que enviares
     como resposta (o código certo pareia; um `cancelar`/`não` cancela).
   - Um valor sem 6 dígitos re-pede: `Não entendi o código — 6 dígitos, ex.:
     `123456`.` (sem ecoar o que digitaste).
4. Se o código estiver **errado/expirado**, o bot responde **sempre a mesma
   frase**: `Código errado ou expirado. Confere no painel e tenta de novo.`
   (sem revelar se o código existe — PAIR-003) e conta a tentativa (tetos).
5. Já pareado e mandas `/parear` outra vez? Só o dono vê a explicação:
   `Este bate-papo já é o dono deste bot. Para trocar o dono, reset na máquina.`
   (PAIR-005). Um estranho é **silêncio**. A pergunta de código (Passo 3) expira
   sozinha em **5 min**: `O código expirou. Use /parear de novo.`

O pareamento é de **um dono só**: quem valida é o digest do código (nunca o
claro), e o dono é gravado no `state.json` pelo host (`pairing.owner`), que
liberta a allowlist no ato — sem reiniciar.

---

## Passo 3 — Usar (por onde começar)

Pós-pareamento, o controlo fica no **cartão de controle do bot** (`/menu`):
uma mensagem edit-in-place com o estado do túnel (`✅ Ligado` / `⬜ Desligado`) e
os botões `🟢 Ligar`, `🔴 Desligar`, `📶 Status`, `🔗 Link de acesso`,
`⇄ Nova chave`, `🚨 Emergência`, `🏠 Início`.

Ações que **aumentam a exposição** (ligar, rotacionar) e as **destrutivas**
(desligar, emergência) pedem **confirmação em duas etapas**, com um botão
positivo `[✅ …]` e agora **um botão de cancelamento `[✕ Não]`** — ao tocar
`✕ Não`, o bot responde `Ok, cancelado.` e edita a mensagem para
`Cancelado. Nada foi alterado.` (teclado destruído), **sem executar nada**.

O menu publicado do bot é **curto (5 comandos)** e escopado (v.
`docs/ux/01-CONTRATO-BOT.md §2`):

| Comando | Escopo | O que faz |
| --- | --- | --- |
| `/menu` | privado (só DM) | abrir o painel de controlo do bot |
| `/status` | privado | ver o estado do túnel |
| `/parear` | privado | parear com um código |
| `/emergencia` | privado | derrubar tudo de imediato |
| `/ajuda` | default (grupos e privado) | ver como usar |

> `/start` não aparece no menu (são boas-vindas inócuas, PAIR-006), mas a sua
> descoberta segura (junto com `/ajuda`) vai ao escopo `default`. As ações/estado
> ficam no escopo **privado** (só DM) — em grupos qualquer comando é barrado pelo
> guard, então restringir a descoberta reduz o "porquê não funciona" em grupo.

---

## Se usas o painel / outra superfície

O painel Telegram Guard (Passo 3 · Usar) mostra os comandos essenciais e `Uso
recente` (métricas). Ligar/desligar também está em superfícies de UI próprias;
todas mostram o mesmo estado e o mesmo `seq` (paridade por contrato, CTL-040). O
worker de long-polling **conflita com uma segunda instância** do bot no mesmo
token (`409` — nunca corras duas instâncias no mesmo token).

---

## O que fica em disco

```
~/.dsh/guarded-bot/secrets.env   # 0600, guarda TELEGRAM_BOT_TOKEN
~/.dsh/guarded-bot/state.json    # 0600, guarda o pareamento
```

O caminho usa `$DSH_HOME` se estiver definido, senão `~/.dsh`, sempre sob
`guarded-bot/`. Tudo `0600`, diretório `0700`, fora do workspace e do git. O
token entra por **ambiente (allowlist do worker)**, nunca em `argv` — um
argumento seria visível em `/proc/<pid>/cmdline` para qualquer processo local.