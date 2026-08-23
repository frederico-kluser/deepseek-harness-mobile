# PAINEL-TELEGRAM — o painel completo do Telegram na UI do DSH

Status: **IMPLENTADO** (Onda 2 · sub-agente do painel). O placeholder do spike
(Onda 1) foi substituído por um painel completo na aba **"Telegram Guard"** do
modal de settings, alimentado pelos endpoints do backend half (`/__guard-ui/*`),
com look-and-feel herdado dos ui-settings do harness (mesmos tokens `--dsw-*`).

---

## O QUE O PAINEL FAZ

O botão **"✈️ Telegram"** (rodapé da sidebar, slot `sidebar.footer.action`)
abre o settings já na aba **Telegram Guard** (slot `settings.section`). Essa aba
mostra quatro blocos, todos a "falar" com o backend:

| Bloco | O que mostra | Endpoint |
|------|--------------|----------|
| **Estado "configurado?"** | Chip verde "Configurado (secrets)" / neutro "Não configurado" / laranja "Configurado via env" | `GET /token-state` + `GET /telegram` |
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

## COMO TESTAR (runtime isolado)

O mesmo runtime isolado do spike (Onda 1) serve o painel:

```bash
DSH_HOME=/home/ondokai/.dsh-guardbot  pnpm dsh cert   # se ainda não tiver
# … start do harness com o profile web e o plugin carregado (ver SPIKE-CLIENT-SLOTS.md)
```

1. Launch no harness → na sidebar, rodapé, clica em **✈️ Telegram**.
2. O modal de settings abre na aba **Telegram Guard**.
3. **Sem token**: chip "Não configurado"; "Chave do bot" aceita colar o token.
4. Cola um token inválido → erro inline **422** (confere no @BotFather).
5. Cola um token válido → ok "Configurado ✓ @handle", chip fica verde, surge o
   cartão **Instruções** com os comandos e o **marcador** do bot.
6. Com a variável `TELEGRAM_BOT_TOKEN` definida → `POST /api/token` responde
   **409** `token-por-env` e o painel mostra o aviso com a instrução exata
   (o env manda — remova a variável ou use o token dela).
7. **Acesso agora**: abre um noutro browser/incógnito e entra pelo link do
   túnel → vês as KPIs subirem e a lista de sessões vivas (device e tempos).
   Sem `trustEdgeHeaders` o IP aparece como tag **"IP não confiável"** e há um
   aviso discreto no cartão.

### Smoke headless (registo não lança)
O bundle deve ser verificado a cada mudança com: `pnpm run build:client` e um
smoke que carrega `lib/client.js` num sandbox com `window.__ModuleLoader__`
esticado, chama `apply(ctx)` com um `ctx.slots` stub e confirma que os dois
slots (`sidebar.footer.action`, `settings.section`) registam sem exceção.

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
  só devolvem `handle`/`ok`/`erro`; o client envia `x-dsh-csrf` lido do
  `<meta name="dsh-guard-ui-csrf">` (injetado pelo `tapIndex`) em todo POST.
- A lista de acesso **nunca** mostra `?key` nem o id de sessão em claro: o hash
  é truncado a 8 chars como identidade visual.

---

## FORA DE ESCOPO (next / Onda 3)
- Automatizar o **smoke headless** como um teste `test/unit/**` (hoje é um
  executável ad-hoc documentado aqui) — o backend é dono de `src/**`; o smoke
  unitário ficaria em `test/unit/client/**`.
- `pnpm build:client` re-gera `lib/client.js` (ignorado no git, `.gitignore`
  `lib/`); definir se `lib` passa a ser commitado ou construído no consumo.