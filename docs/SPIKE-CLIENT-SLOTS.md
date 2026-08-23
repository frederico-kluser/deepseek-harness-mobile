# SPIKE — client half de UI para um plugin EXTERNO (dsh.client + slots)

Status: **PROVADO EMPIRICAMENTE** (Onda 1 · sub-agente PoC). As três metas do
handoff foram verificadas de ponta a ponta num browser headless (chromium) contra
o runtime isolado `DSH_HOME=/home/ondokai/.dsh-guardbot · profile web · :3082`:

1. (a) O plugin externo contribui um `dsh.client` que o harness SERVES e MONTA;
2. (b) os slots `sidebar.footer.action` (botão junto ao settings) e
   `settings.section` (aba nova no modal) registam e renderizam;
3. (c) clicar no botão abre o modal de settings JÁ na aba nova.

---

## VEREDITO

**SIM — um plugin externo (via `dsh plugin add` / bundle de perfil) consegue
contribuir client-half de UI e registar os dois slots, e abrir o modal na aba
nova.** A evidência final (browser headless, `:3082`):

- `window.__DSH_BOOT__.entries` passou de 42 → 43 e passou a incluir
  `dsh-guard-messenger` (`url: /plugins/dsh-guard-messenger/client.js?rev=…`).
- `GET /plugins/dsh-guard-messenger/client.js` → `200`, contendo as
  chamadas `slots.inject('sidebar.footer.action', …)` e
  `slots.inject('settings.section', …)`.
- No DOM: o botão **"✈️ Telegram"** renderiza no rodapé da sidebar (ao lado do
  trigger de settings) via `sidebar.footer.action`.
- No rail do modal de settings, a aba **"Telegram Guard"** aparece; clicar no botão
  via o affordance abre o modal com `aria-current="true"` nessa aba e renderiza o
  conteúdo da section (`«Aba contribuída por um plugin externo…»`).
- NENHUM erro/exception de console do bundle.

---

## O MECANISMO DEFINITIVO (o que funcionou)

Um plugin externo entra no `__DSH_BOOT__` quando TODAS as seguintes condições se
cumprem (sem mudar o harness):

1. **`package.json` declara**:
   ```jsonc
   "exports": {
     "./client": { "default": "./lib/client.js" },
     "./package.json": "./package.json"   // <<< OBRIGATÓRIO — ver quadro abaixo
   },
   "dsh": { "client": { "platform": "web" }, "bundle": { "patch": "./cordis.patch.yml" } }
   ```
2. **O bundle `./lib/client.js`** existe e está no formato closure-factory do
   harness:
   ```js
   window.__ModuleLoader__.load({ id: '<nome-do-pacote>', factory: (require) => {
     var module = { exports: {} }; var exports = module.exports;
     // ... CJS, externals via require() ...
     exports.apply = apply;
     exports.inject = inject;
     return module.exports;
   } });
   ```
3. **O bundle exporta `apply(ctx)` + `inject`** (forma de plugin Cordis) e, no
   `apply`, regista nos slots via `ctx.slots.inject(...) → ctx.slots.register(...)`
   (a regra de composição de `@deepseek-ai/dsh-client-ui-slots` — AGENTS.md:11).

### A PEDRA DE TOQUE: `"./package.json"` nos exports

O `ClientModuleRegistry` server-side
(`packages/client/modules/src/index.ts`, `resolveMeta`, ~L377–L404) faz
`require.resolve(\`${spec}/package.json\`)` a partir de `createRequire(ctx.baseUrl)`
(= o dir do perfil). Se o teu `exports` NÃO expõe `./package.json`, aqueste
`require.resolve` lança `ERR_PACKAGE_PATH_NOT_EXPORTED`, o `resolveMeta` faz
`catch { pkgMeta.set(name, null); return null }` e o plugin é **silenciosamente
rejeitado** — não entra no `__DSH_BOOT__`, e o client.js dá `404`.

Isto foi o bug real (medido duas vezes):

| Estado                                    | `processOne(guard)` | `__DSH_BOOT__` |
|-------------------------------------------|---------------------|----------------|
| `exports` SEM `./package.json`            | `false` (pkgMeta=null) | ausente, client.js 404 |
| `exports` COM `"./package.json": "./package.json"` | `true`            | presente, client.js 200 |

Todos os pacotes internos do harness (`@deepseek-ai/dsh-client-*`) já expõem
`./package.json` por isso funcionavam; o plugin externo não tinha — esse era o
gap. **Não é preciso tocar no harness.**

---

## EXEMPLO MÍNIMO DE CÓDIGO (para a Onda 2 copiar)

Ficheiros desta worktree (são a prova):

- `client/index.ts` — o plugin client: `export const inject = ['slots']` +
  `export function apply(ctx)` que registra os dois slots.
- `scripts/build-client.mjs` — build com **esbuild** (único devDep novo):
  `entry: client/index.ts`, `outfile: lib/client.js`, `format:'cjs'`,
  `banner/footer` com o closure-factory, externals =
  `['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-primitives']`.
  Sem toolchain do monorepo do harness.
- `package.json` — `"build:client": "node scripts/build-client.mjs"`,
  `"build:all": "pnpm build && pnpm run build:client"`.
- **Tarball sempre completo:** `lib/` está na lista `files` E o `prepack` roda
  `pnpm run build:all` (garante `lib/client.js` compilado antes de `pnpm pack`/
  publish). Sem isso, um `pack` sem `build:client` deixaria `exports["./client"]`
  a apontar para um ficheiro ausente → client.js 404. (`prepublishOnly` também roda
  `build:all` + `package:check`.)

Resumo do `apply`:
```ts
export const inject = ['slots']   // serviços Cordis que o ctx precisa

export function apply(ctx) {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'guard-bot-button', order: 0 },
      GuardBotSidebarAction))                    // componente recebe { wide }
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: 'telegram-guard', order: 99,
                         label: 'Telegram Guard' },
      TelegramGuardSection))                     // componente recebe { close }
}
```

React chega pelo `require` injetado no factory (palavra seed do module table —
`packages/client/web/src/seed.ts`): `require('react')`, usar `React.createElement`
(evita o `jsx-runtime`, mas ele também é seed).

---

## COMO ABRIR O MODAL NA ABA NOVA (caminho escolhido + prova)

O open do modal de settings é **estado local** do `SettingsRoot`
(`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`, L106–108) —
NÃO há handle global. `settings.section` só recebe `close`; `settings.onboarding`
recebe `openSection(id)`. Um `sidebar.footer.action` NÃO recebe `openSection`.

**Caminho escolhido (sem mudança no harness):** affordance DOM, idempotente:
1. Achar e clicar o trigger de settings — um `button[aria-haspopup="dialog"]`
   (o `SettingsRoot` toca `aria-haspopup="dialog"` e `aria-expanded`) **escopado**:
   procura-se primeiro dentro de `[class*="_settingsArea"]` do rodapé da sidebar
   (fallback `_footArea`, depois `_sidebarCol`, depois global) e escolhe-se o
   primeiro **VISÍVEL** (`getClientRects().length > 0`). Isso não casa o primeiro
   `aria-haspopup` da página (frágil) — só o de settings.
2. Poll (requestAnimationFrame, ~12 frames) por um botão **dentro de
   `[role="dialog"]`** cujo `textContent` inclua a string do label EXATA da nossa
   section (`'Telegram Guard'` — NÃO só `'telegram'`, que colide com o nosso próprio
   botão do rodapé "✈️ Telegram"), e `.click()` nele. Isso chama
   `onSelect('telegram-guard')` no `SettingsRoot` → `activeId` + render do conteúdo.

**Pitfalls medidos:**
- TRIGGER escopado: NÃO usar `document.querySelector('button[aria-haspopup="dialog"]')`
  (o primeiro da página). A âncora estável é o assento `settingsArea`/`footArea` do
  rodapé da sidebar (CSS module hasheados, ex. `hQ5OyW_settingsArea`); escolher o
  primeiro `aria-haspopup` VISÍVEL dentro desse escopo. Verificado em headless:
  `insideSettingsArea: true`, `pickedText: "Settings"`.
- Para o RAIL do modal, NÃO escopar por `[class*="_nav"]` genérico: a sidebar/layout
  têm navs próprios e o teu próprio botão do rodapé ("Telegram") seria a primeira
  correspondência. O rail do settings vive DENTRO de `[role="dialog"]` (CSS module
  `sL9RRa_nav`).
- O clique no trigger é assíncrono (React commita o painel na frame seguinte), por
  isso o poll em vez de um clique síncrono. `findNavItem` devolve null enquanto o
  dialog não existe, então o poll é seguro do primeiro frame.
- O rail lista TODAS as sections sempre (não só a ativa); a aba ativa tem
  `aria-current="true"`. Não dependa de `aria-current` para achar a nossa (no boot a
  General ativa). Casa pelo texto do label.

**Fallback documentado** (se no futuro o rail não expuser o item): overlay próprio
via slot `shell.overlay`, replicando o look com os tokens `--dsw-*` do settings.

---

## LOOK-AND-FEEL (tokens/classes observadas em ui-settings-general)

O `SettingsRoot` usa **CSS Modules** (`*.module.css`, import `css from './X.module.css'`,
hasheado no build) e **tokens `--dsw-*`** (não `--var` solto). Para a aba da Onda 2
caso com o shell:

- Classes do shell: `.trigger`, `.trigger.rail`, `.overlay`, `.mask`, `.panel`,
  `.nav`, `.navTitle`, `.navList`, `.navCell` (`.navCell.active`), `.navIcon`,
  `.navLabel`, `.content`, `.header`, `.actions`, `.close`, `.options`,
  `.hiddenLabel`.
- Tokens principais: `--dsw-alias-label-primary` (texto),
  `--dsw-alias-bg-layer-2` (painel), `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`
  (máscara), `--dsw-shadow-lv3` (elevação), `--dsw-specific-sidebar-nav-item-hover`
  / `-active` (célula do rail), `--dsw-alias-scrollbar-*` (scroll).
- Geometria do painel: `800px` largo, `border-radius: 24px`, duas colunas
  (rail `188px` + content com header `54px` e área `.options` padded).
- Fonte do trigger: `font-size: 14px; line-height: 22px`.

O exemplo mínimo desta worktree usa estilos inline de placeholder; a Onda 2 deve
trocar por um `TelegramGuardSection.module.css` com os tokens `--dsw-*` acima.

---

## Arquivos do harness que comprovam a montagem (caminhos)

- `packages/client/ui-slots/src/index.ts` — contrato `SlotMap` + `SlotCore.register`
  (a regra de composição; slots NÃO declarados pelo nosso plugin — já são do shell).
- `packages/client/ui-sidebar/src/client/contract/slots.ts` — declara
  `sidebar.footer.action` (kind list, L46).
- `packages/client/ui-settings/src/client/contract/slots.ts` — declara
  `settings.section` (list, id=chave da aba, L53), owner = `{ close }`.
- `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` L199–203 — renderiza o
  slot `sidebar.footer.action` ("Footer actions stack above Settings").
- `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` — modal (open =
  estado local L106–108; rail `settings.section` L91 com `{ only: active }`;
  `openSection` só p/ `settings.onboarding` L165–169).
- `packages/client/modules/src/index.ts` — `ClientModuleRegistry`: varre
  `ctx.loader.entries()` SEM filtro `@deepseek-ai`, compõe `__DSH_BOOT__`, serve
  `/plugins/<id>/client.js?rev=<hash>`.
- `packages/client/modules/src/client/system.ts` + `manifest.ts` — o contrato
  closure-factory (`window.__ModuleLoader__.load({id, factory})`) e a resolução
  `seed → memoized → factory`.
- `packages/client/web/src/seed.ts` — as palavras seed do module table (`react`,
  `react/jsx-runtime`, `react-dom*`, `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`).
- `packages/client/web/src/boot.ts` — `loader.create({name})` para cada row do
  `__DSH_BOOT__`: é quem chama o `apply` do client bundle.
- `packages/client/ui-renderer/src/client/index.ts` — injeta `ctx.slots` no
  contexto raiz (`inject: ['slots','sessions']`).

---

## Estado do runtime 3082 ao fim

**Restaurado ao estado original** (isolado, NUNCA mexido no 3080):
- profile `package.json` de volta a `link:/home/ondokai/Projects/deepseek-harness-mobile`.
- symlink de `node_modules/dsh-guard-messenger` aponta ao checkout principal.
- servidor `:3082` reiniciado com o mesmo comando
  `node --import tsx/esm apps/cli/src/bin.ts --profile web --host 127.0.0.1 --port 3082 --no-open`
  (novo PID; log `/tmp/guardbot-web-3082.log`). Confirmado: boot 42 plugins
  (guard SEM client.js, como o original) e `/__guard-ui/api/state` → 200.
- `:3080` principal intocado (PID 120306 seguia a correr).

## Para o próximo agente / Onda 2

- Copiar `client/index.ts` + `scripts/build-client.mjs` + as linhas de `package.json`
  (`exports["./client"|"./package.json"]`, `dsh.client.platform`, `build:client`,
  devDep `esbuild`) desta worktree.
- Substituir o conteúdo placeholder da section por UI real com CSS Modules + tokens
  `--dsw-*` (ver secção look-and-feel). O affordance do modal (DOM) está pronto.
- Se quiser ESCAPAR do affordance DOM: a mudança mínima no harness seria expor um
  handle global de "abrir settings numa aba" (arquivo:linha: `SettingsRoot.tsx`
  L106–116 — promover `openSection` a um serviço/evento), para a Onda 2 decidir.

## Bloqueios

Nenhum. Os únicos obstáculos do caminho (faltava `./package.json` nos exports;
timing do affordance; colisão de seleção do label) foram identificados e resolvidos.