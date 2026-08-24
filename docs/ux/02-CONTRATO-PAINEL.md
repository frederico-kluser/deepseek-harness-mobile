# 02 — CONTRATO DO PAINEL (aba "Remote Access")

> **Onda 1 — nome e botões:** o nome VISÍVEL do painel passou de "Telegram Guard"
> para **"Remote Access"** (o `id` da secção `telegram-guard`, o `registrant` e o
> pacote `dsh-guard-messenger` NÃO mudaram — só o rótulo exibido).

> **Implementação de referência (Onda 4):** `client/index.ts`, `client/guard-panel.css`,
> `src/ui-contrib/routes.ts` (textos `TEXTO_ERRO_PAIR` e demais respostas),
> `src/ui-contrib/bot-state.ts`. Este documento define a **trilha por ESTADO** do
> painel, os CTAs, os rótulos e **o texto EXATO final (PT-BR)** com o mapeamento
> OLD → NEW, preservando classes `guard-*` e tokens `--dsw-*`.
>
> Padrão: **Decisão → Porquê (fonte) → Texto final exato.**

FONTES DE PESQUISA citadas:
- **Painel**: 1 CTA primário por estado; progressive disclosure (`<details>`);
  vazios que **ensinam o próximo passo**; checkpoints ✓ nos concluídos e só o
  atual aberto (trilha na mesma tela, não modal); hierarquia primário/secundário/
  texto; desabilitado com motivo (nunca clicável-silencioso); embedded-plugin
  respeita o tema do host (`--dsw-*`).
- **Pareamento (RFC 8628)**: código em caixa monospace ESPAÇADA; UMA instrução
  por passo; countdown visível (5:00); "gerar novo" sem reiniciar; status ao vivo
  "aguardando→✓"; pós-pareamento = 2 primeiras ações + aviso de segurança;
  resposta guiada a `/parear` vazio.
- **Microcopy**: imperativo com verbo, loading honesto, erro que guia à correção
  sem culpa, confirmação destrutiva específica, tom "você", painel escaneável.

---

## INVARIANTES DE SEGURANÇA DO PAINEL (o design PRESERVA)

| # | Invariante | Como o painel a respeita |
|---|---|---|
| TG-007 / TG-089 | default-DENY; estranho descartado em silêncio | O painel vive ATRÁS da barreira do harness (loopback/túnel autenticado). Nunca mostra estado de túnel a não-dono (ele não alcança a aba). |
| PAIR-010 | Código de pareamento NUNCA sai do host | O código só é devolvido pela rota `POST /pair` e renderizado NOPAINEL; nunca logado, nunca no Telegram (só o digest via `pairing.challenge`). |
| PAIR-005 | Uma única parelha | Estado "Desfazer parear" só existe no `<details>`; re-parear exige reset (o texto guia, não força). |
| PAIR-006 | `/start` igual p/ todos | (efeito no bot, ver `01` §3) — o painel não contradiz; a instrução de parear é a única menção pública. |
| — | Nenhum texto vaza token, código real, endereço, estado sensível a estranho | O painel não devolve o token; não lista sessões fora desta aba autenticada; o IP só quando `ipConfiavel`. |

**O que MUDOU no painel (UX):** de 6 blocos sempre empilhados para uma **trilha
de 3 checkpoints**; os blocos de privacidade e métricas dobram/migram para o
checkpoint 3; o CTA passa a ser **um por estado**.

---

## Visão geral da trilha

A aba deixa de empilhar os 6 cartões atuais e passa a desenhar uma **trilha
vertical de 3 checkpoints** na MESMA tela (não é wizard modal):

```
◉ Passo 1 · Criar o bot        ← só no estado SEM token
◉ Passo 2 · Parear             ← quando tem token e NÃO pareado
◉ Passo 3 · Usar               ← quando pareado
```

- **Concluído** fica com `✓` à frente e **colapsado** (só o título + resumo).
- **Só o passo atual fica aberto** com CTA(s) e texto.
- **Passos futuros** ficam traço/diminuídos (sem detalhe), para a atenção ir ao
  único passo acionável.

---

## Checkpoint 1 — Criar o bot (token)

**Estado:** sem token (`configurado === false`, fonte `nenhum`).
**Objetivo:** o usuário cole o token do @BotFather e o painel o aceite.

### Layout / Decisões

- Cartão **"Passo 1 de 3 · Criar o bot"**.
- **UMA instrução** curta ("Cole o token que o @BotFather deu").
- Um campo de token (`password` + toggle) e **um CTA primário** `Salvar bot`.
- **"Como criar o bot do zero"** num `<details>` (passos do @BotFather dobrados —
  progressive disclosure).
- Erro de token → mensagem + **ação** (`Revisar token`).

### Textos EXATOS (mapeando `client/index.ts`)

- Título do cartão: `Passo 1 de 3 · Criar o bot`
- Resumo colapsado (quando configurado): `Bot @handle conectado` + link `Trocar`
- Intró (aberto):
  - OLD: `Cole o token que o @BotFather deu ao criar o bot. Fica no secrets.env desta máquina.`
  - NEW: `Cole o token que o @BotFather te entregou ao criar o bot. Fica guardado seguro nesta máquina.`
- Campo label: `Token do bot (@BotFather)` (mantido)
- Placeholder: `1234567890:AAA…` (mantido)
- **CTA primário:** OLD `Validar e configurar` → NEW **`Salvar bot`**
  - enquanto salva (loading honesto): OLD `a validar…` → NEW **`A conectar ao Telegram…`**
- toggle mostrar/ocultar: `👁` / `🙈` (mantido)
- `<details>` "Como criar o bot do zero" — mantém os `PASSOS_BOTFATHER` numerados.
- **Erro de token:** OLD mensagens inline genéricas → NEW com ação:
  - `Formato inválido — espera-se uma chave <número>:<segredo> do @BotFather.` →
    `Formato errado. O token vem assim: 123456:aaaa… (número, dois pontos, segredo).` + **botão `Revisar token`**
  - `O Telegram rejeitou o token — confira no @BotFather (/newbot → revogue e gere de novo).` → `O Telegram não aceitou este token. Veja no @BotFather (/newbot) e tira outro.` + **botão `Revisar token`**
  - `Rede falhou — verifique a ligação e tente de novo.` → `Sem ligação ao Telegram. Verifica a rede e tenta de novo.`
- Sucesso: `Configurado ✓ @handle` (mantido).

> **Vazio que ensina o próximo passo (fonte painel):** abaixo do cartão vazio,
> um texto fraco de incentivo: `Depois disto, avanças para o Passo 2: parear.`

---

## Checkpoint 2 — Parear

**Estado:** configurado e NÃO pareado (`configurado === true && !pareado`).

### Layout / Decisões

```
◉ Passo 2 de 3 · Parear          ← passo atual (aberto)
   Bot conectado: @handle   [Trocar]     ← passo 1 colapsado (link no topo)
   [Gerar código]                        ← CTA primário
   ┌─────────────────────────┐
   │  1 2 3 4 5 6            │  ← código em caixa monospace ESPAÇADA
   └─────────────────────────┘
   [ Copiar ]
   ⏱ expira em m:ss        [ Gerar novo ]
   No Telegram, envia:  /parear 123456  no @handle
   (status ao vivo) Aguardando… → ✓ Pareado
```

### Textos EXATOS (mapeando `client/index.ts` → `CartaoParear`)

- **Passo 1 colapsado:** `Bot @handle conectado` + text-link `Trocar`
- Estado ocioso (CTA):
  - OLD: título `Parear pelo Telegram`; intró `Pareie este painel com o bot para o poder comandar a partir daqui. Gera um código de 6 dígitos que só aparece neste ecrã.`; botão `Parear pelo Telegram`
  - NEW: título **`Passo 2 de 3 · Parear`**; intró **`Este painel gera um código de 6 dígitos só para ti. Tu envias esse código para o bot.`**; CTA primário **`Gerar código`**
- Gerando (loading honesto):
  - OLD `A gerar um código de pareamento…` → NEW **`A gerar o código…`**
- Código (fase `codigo`):
  - OLD `Envie na conversa com {destino}:` / `No Telegram, escreva o comando seguido do código acima.`
  - NEW — **UMA instrução** (fonte pareamento):
    - **`No Telegram, envia:`** — e abaixo uma **linha copiável** monospace
      espaçada com o número separado (só o número em caixa, sem o `/parear`
      junto para evitar acidentes): a caixa mostra só os 6 dígitos espaçados
      `1 2 3 4 5 6` + botão **`Copiar`**.
    - a instrução clara completa: **`No Telegram, envia: /parear 123456 no @handle`** (a instrução UMA, final).
  - Countdown: `expira em 4:53` (já existe `formatarContagem`) + botão **`Gerar novo`** (não reinicia o fluxo — continua a sondar — fonte pareamento).
  - **Status ao vivo:** OLD `Aguardando pareamento… · {t}` → NEW com transição
    **`Aguardando…` → `✓ Pareado`** (chip único que troca ao detectar `pareado`).
- **Pareado (fase `pareado`):** título `✓ Pareado`; intró:
  - OLD `Este navegador passou a ser autorizado a comandar o bot. Use os comandos na conversa com o bot.`
  - NEW **`Pareado! Este painel agora controla o bot. Vai ao Passo 3 para começar.`**
- **Expirou:** `O código expirou. Gere um novo para tentar de novo.` → **`Este código expirou. Gera um novo.`** + botão `Gerar novo código`.
- **Erro:** mantém a mensagem do servidor + botão `Tentar de novo` (ver §`TEXTO_ERRO_PAIR`).

### `TEXTO_ERRO_PAIR` (src/ui-contrib/routes.ts) OLD → NEW

| chave | OLD | NEW |
|---|---|---|
| `ja-pareado` | Este bot já tem um dono. Use a máquina para trocar o dono (`--reset-pairing`). | Este bot já tem um dono. Para trocar o dono, é preciso reset na máquina onde ele roda. |
| `sem-token` | Configure a chave do bot primeiro — só depois dá para parear pelo painel. | Configura o token no Passo 1 — só depois dá para parear. |
| `worker-indisponivel` | O bot não está a correr agora. Verifique e tente de novo. | O bot não está a correr agora. Confere o painel principal e tenta de novo. |
| `interno` | Algo correu mal ao gerar o código. Tente de novo. | Algo falhou ao gerar o código. Tenta de novo. |

---

## Checkpoint 3 — Usar (pareado)

**Estado:** pareado.

### Layout / Decisões

```
◉ Passo 3 de 3 · Usar            ← passo atual (aberto)
   Bot conectado: @handle  [Trocar]        ← passo 1 colapsado
   ✓ Pareado
   Comandos essenciais (1 linha cada):
     /menu      abrir o painel de controlo no bot
     /status    ver estado do túnel
     /parear    (não é preciso — já pareado)
   [ Avançado ▸ ]  ← <details>  (não um botão destrutivo visível)
   [ E minha conversa? ▸ ]  ← <details> privacidade
   (Uso recente — métricas, só aqui, enxuto)
```

### Textos EXATOS (mapeando `client/index.ts`)

- **Comandos essenciais — 1 linha cada** (fonte: pós-pareamento = 2 primeiras
  acções): substituir a lista de 7 `COMANDOS_DE_USO` por **3 linhas**:
  - `/menu` — `abrir o painel de controlo do bot`
  - `/status` — `ver o estado do túnel`
  - `/emergencia` — `derrubar tudo de imediato`
  - (os demais — `/ligar /desligar /acessar /rotacionar` — ficam nos **botões do
    cartão `/menu`**, não repetidos aqui; reduz a lista e o ruído.)
- **`<details>` Avançado:**
  - `Trocar o token` (text-link → volta ao Passo 1 com o formulário) + confirmação
    no clique (ver §confirmações).
  - `Desfazer parear` (text-link → **confirmação** `Tens a certeza? Isto desliga o teu acesso pelo bot e pede um parear novo.` + botão `Desfazer parear` — só aqui, dobrado).
  - `Ver todos os comandos` (idem `COMANDOS_DE_USO` completo, dobrado).
- **`<details>` "E minha conversa?":** (1 linha de risco + 1 linha do que faz)
  - **`As tuas conversas com o bot ficam neste aparelho e no Telegram, com privacidade por omissão: nenhum comando de estranho funciona e quem não pareou não recebe resposta.`**
- **Uso recente** (métricas — só aqui): manter o cartão `Acesso agora` ENXUTO —
  KPIs `Conexões ativas` / `Sessões vivas` + lista, mas com título **`Uso recente`**
  e sem o aviso de "IP não confiável" a céu aberto (dobrar ou encurtar). Mantém o
  refresh ~15s e o botão `Atualizar`.

---

## Regras de UX globais do painel

1. **≤1 CTA primário por estado** (fonte painel): cada checkpoint tem UM botão
   principal; os outros são text-links ou secundários.
2. **≤2 botões visíveis por card** fora do `<details>` (menos é mais; o resto
   vira text-link dentro do `<details>`).
3. **Rótulos verbo imperativo** (`Gerar código`, `Salvar bot`, `Copiar`, `Gerar
   novo`, `Trocar`), nunca "OK".
4. **Loading honesto:** `A conectar ao Telegram…`, `A gerar o código…`, nunca um
   sem texto.
5. **Vazios que guiam o próximo passo:** cada estado diz o que falta e o que virá.
6. **Progresso por checkpoints ✓**, só o atual aberto, na mesma tela (não modal).
7. **Desabilitado com motivo** (ex.: `Gerar código` desabilitado sem token, com
   a razão no tooltip/texto) — nunca clicável-silencioso.
8. **Manter classes `guard-*` e tokens `--dsw-*`**; **logo no topo mantida**.
9. **Privacidade e métricas** mudam para o checkpoint 3 (não atravancam os 2
   primeiros estados que ensinam a configurar).

---

## Confirmações destrutivas no painel

- **Trocar token:** `Trocar o token desliga temporariamente o bot. Continuar?`
  → `[Trocar token]` `[Cancelar]`.
- **Desfazer parear:** `Desfazer o parear fecha o teu acesso pelo bot a partir
  deste painel. Não dá para desfazer sem parear de novo. Continuar?`
  → `[Desfazer parear]` `[Cancelar]`.

---

## Índice dos arquivos-alvo da Onda 4 (log)

- `client/index.ts` — reestruturar `TelegramGuardSection` em trilha de 3
  checkpoints; novos textos do §1-§3; `<details>` para BotFather/Avançado/
  Privacidade; mover métricas para o passo 3; mover o `CartaoPrivacidade` para o
  passo 3; manter `guard-*` e `--dsw-*`.
- `client/guard-panel.css` — estilo dos checkpoints (✓, colapsado/aberto),
  caixa de código espaçada, botões small; sem novos tokens fora de `--dsw-*`.
- `src/ui-contrib/routes.ts` — `TEXTO_ERRO_PAIR` (§2), e confirmar respostas de
  `POST /token` (409 aviso, 422, etc.) alinhadas ao §1.
- `src/ui-contrib/bot-state.ts` — textos de `passosDoBot` se renomeados.
- `test/unit/client/*` e testes de rotas — atualizar as asserções de string dos
  novos rótulos (Salvar bot, Gerar código, Passo N de 3).