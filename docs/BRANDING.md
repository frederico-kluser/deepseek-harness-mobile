# BRANDING — dsh-guard-messenger

> Identidade do pacote/produto. Documento vivo: o nome, o que o produto faz, os
> valores e o **prompt de geração do logo** (reutilizável para favicon).

## Nome

| Campo | Valor |
| --- | --- |
| Nome npm / pacote | `dsh-guard-messenger` |
| Nome curto (produto) | **guard-messenger** |
| `id` da entrada em `cordis.patch.yml` | `guard-messenger` |
| `name` do plugin (exportado) | `dsh-guard-messenger` |
| Binário CLI (inalterado) | `dsh-guard-setup` |
| Variável de provedor (inalterada) | `DSH_GUARD_PROVIDER` |
| Nome histórico (anterior) | `dsh-guarded-bot-orchestrator` (só em registos históricos) |

> O **repositório git** (`frederico-kluser/deepseek-harness-mobile`) e a **rede de
> rotas HTTP** (`/__guard`, `/__guard-ui`) são contratos estáveis e **mantêm os
> seus nomes** — apenas o pacote/produto muda de identidade.

## O que o produto faz

O **dsh-guard-messenger** é um plugin Cordis para o DeepSeek Harness (DSH) que
abre um **portão seguro** para a Web UI do teu próprio harness a partir do
celular, **sem nunca alargar o bind para fora do loopback** (o túnel termina em
`127.0.0.1`; o acesso local abre direto e o acesso remoto só entra com a chave
no link `?key=` ou numa sessão). É hoje um **gateway de mensageria
multi-provedor**: o **Telegram é o provedor ativo hoje**, e a arquitetura de
adaptadores (`worker/providers/<id>/**`) está pronta para **WhatsApp, Discord,
Matrix, Signal, Slack e outros** — o provedor ativo é escolhido por
`DSH_GUARD_PROVIDER` (default `telegram`), e o núcleo de pareamento/comandos é
neutro ao canal.

## Valores

- **Sem login.** Não há `WWW-Authenticate`, formulário nem conta de acesso ao
  portão; a verificação local abre direto.
- **O segredo mora no link.** A proteção do túnel é a **chave no URL** (`?key=`)
  que o bot envia; sem chave a resposta é `401` texto puro, sem desafio.
- **Controle via bot.** Ligar, desligar, ver sessões e rotacionar a chave
  acontecem por comandos do provedor de mensageria (ex.: `/parear`,
  `/rotacionar`).
- **Privacidade e postura fail-closed.** Bind travado em loopback, veto de
  elevações de permissão, exposição revogável em um comando, e recusa silenciosa
  de qualquer config inválida (nada de "explodir" no arranque).

---

## Prompt do logo

Prompt **pronto para colar** num gerador de imagem (ideogram, Midjourney, DALL·E,
Flux, firefly, etc.):

> **flat icon, rounded square, deep blue gradient background, a stylized shield
> merging with a chat bubble, small paper-plane/send glyph, plus small generic
> channel dots (telegram/whatsapp/discord) around the shield to signal
> multi-provider; minimalist, modern, no text, high contrast, vector style**

### Versão longa (recomendada para máxima fidelidade)

> A flat, vector-style app icon inside a **rounded square**. Background: smooth
> **deep blue gradient** (from `#0b3d91` at top to `#7a1fa2` / `#4f46e5` at
> bottom, with a subtle diagonal light sweep). Foreground: a bold **stylized
> shield** whose lower half blends into a **chat bubble** (the bubble tail points
> lower-right, suggesting "sends a message"). Center-left of the bubble, a small
> paper-plane / **send glyph**. Around the shield, three small **generic channel
> dots** (one teal `#34d399`, one WhatsApp-green `#25D366`, one indigo/Discord
> `#5865F2`) arranged in a tight arc or orbit, signalling **multi-provider**
> messaging. Palette sparing and high-contrast: white/very-light surface glyphs on
> the blue gradient. **No text, no letters, no mascot, no 3D gloss, no photo
> texture.** Clean geometric shapes, thick enough silhouettes to read at 16 px,
> generous negative space, modern minimalist.

### Reuso para favicon

O mesmo prompt serve de **favicon** ajustando duas coisas: (1) **composição mais
fechada** — só o escudo+balão fundidos no centro, sem os dots em volta (que somem
em 16×16 px); (2) **silhuetas mais grossas e maior contraste** para legibilidade
em uma única cor (`#4f46e5` sobre branco ou vice-versa). Idealmente gere o
favicon em **256×256 px** e escale via `<link rel="icon">`.

### O que NÃO incluir

- **Nenhum texto/nome** (nem "DSH", nem "guard", nem "messenger") — iconografia,
  não logótipo tipográfico.
- **Nenhuma fotografia nem render 3D com brilho** — vetor plano e limpo.
- **Nenhum pássaro do Telegram nem fontes oficiais de marcas terceiras** — os
  "dots" são **genéricos** (bolinhas coloridas), nunca os logótipos das apps, para
  o logo vender a ideia *multichannel* sem colar em nenhuma marca.
- **Nenhuma borda vazada complexa, sombra projetada ou gradiente com muitas
  paradas** — precisa ser recortável para favicon e tema escuro/claro.