/**
 * PROVA DE CONCEITO (SPIKE) — client half de UI para o DeepSeek Harness,
 * contribuído por um plugin EXTERNO (fora do monorepo).
 *
 * OBJETIVO EMPÍRICO (handoff da Onda 1):
 *   (a) contribuir um `dsh.client` (bundle JS servido por `/plugins/<id>/client.js`)
 *       que o harness monta e executa como plugin Cordis no browser;
 *   (b) registar slots de UI: `sidebar.footer.action` (botão junto ao settings)
 *       e `settings.section` (aba nova no modal de settings);
 *   (c) abrir o modal de settings JÁ na aba nova quando o botão for clicado.
 *
 * ESTE FICHEIRO É A FONTE. É compilado para `lib/client.js` (formato
 * closure-factory CJS do harness: `window.__ModuleLoader__.load({id, factory})`),
 * com `react` e `@deepseek-ai/cordis` como EXTERNOS (palavras seed do module
 * table — o harness resolve-os por `require` injetado no factory).
 *
 * REGRA DE COMPOSIÇÃO (pkg `@deepseek-ai/dsh-client-ui-slots`): um plugin
 * compõe UI SÓ através de `ctx.slots.register({name, ...}, Component)`. Não há
 * call de definição de slot à parte: os slots `sidebar.footer.action` e
 * `settings.section` já estão DECLARADOS pelo ui-sidebar / ui-settings-general
 * (o shell). Nós apenas CONTRIBUIMOS entradas para eles. `ctx.slots.inject` amarra
 * o registro ao ciclo de vida da declaração do slot (espera a declaração
 * existir), eliminando qualquer problema de ordem de ativação entre pacotes.
 *
 * O CLIQUE NO BOTÃO E O MODAL: o open do modal de settings é ESTADO LOCAL do
 * `SettingsRoot` (ui-settings-general) SEM handle global — `settings.section`
 * só recebe `close`; `settings.onboarding` é quem recebe `openSection(id)`.
 * O caminho escolhido (ver FAQ/README do spike) é o DOM affordance:
 *   (1) clicar no botão trigger de settings
 *       (`button[aria-haspopup="dialog"]` — o SettingsRoot toca esse atributo);
 *   (2) clicar no item do RAIL de navegação cujo id == o da nossa section
 *       (`button[aria-current]` dentro de `.navList` do SettingsPanel).
 * Isso abre o modal na aba nova SEM mudança no harness. Fallback documentado no
 * handoff: overlay próprio via slot `shell.overlay` (caso o rail não exponha o item).
 *
 * NOTA DE SEGURANÇA: nenhuma lógica de negócio/servidor aqui. O client half é
 * apenas UI e comunicação com o backend half (`ctx` do plugin, rotas `/api`).
 * O token/segredo NUNCA entra neste bundle.
 *
 * @module dsh-guarded-bot-orchestrator/client
 */

// `react` é palavra seed — o factory `(require) =>` injetado resolve-o.
// Nada mais é importado em runtime: `ctx.slots` chega via injeção de serviço
// do Cordis (`exports.inject = ['slots']`), não por import.
import * as React from 'react'

/** Serviços Cordis que o `apply` deste plugin exige no `ctx`. */
export const inject = ['slots']

/**
 * O botão que vai para `sidebar.footer.action` (junto ao botão de settings).
 *
 * Props de dono do slot (ui-sidebar/contract/slots.ts): `{ wide: boolean }` —
 * `false` = rail 56px (só ícone); `true` = largura completa (ícone + label).
 */
function GuardBotSidebarAction(props: { wide: boolean }): React.ReactNode {
  const { wide } = props
  // Ícone inline (sem dependência de pacote de ícones): um "telegram" simples.
  const icon = React.createElement(
    'span',
    { 'aria-hidden': true, style: { fontSize: 16, lineHeight: 1 } },
    '✈️',
  )
  return React.createElement(
    'button',
    {
      type: 'button',
      title: 'Telegram Guard — abrir configurações',
      'data-guard-bot-trigger': '',
      // Mesmo estilo do trigger de settings do shell (linha de base; o harness
      // usa tokens --var e CSS modules internos — ver handoff look-and-feel).
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'transparent',
        border: 'none',
        color: 'var(--dsh-fg-60, #646464)',
        cursor: 'pointer',
        padding: wide ? '6px 4px' : '6px',
        width: '100%',
        justifyContent: wide ? 'flex-start' : 'center',
      },
      onClick: () => {
        openSettingsOnSection('telegram-guard')
      },
    },
    icon,
    wide ? React.createElement('span', { style: { fontSize: 12 } }, 'Telegram') : null,
  )
}

/**
 * O conteúdo da aba nova no modal de settings (slot `settings.section`).
 *
 * Props de dono do slot (ui-settings/contract/slots.ts): `{ close: () => void }`
 * — o único affordance que o shell dá a uma section.
 */
function TelegramGuardSection(props: { close: () => void }): React.ReactNode {
  const { close } = props
  return React.createElement(
    'div',
    { style: { padding: 16 } },
    React.createElement('p', { style: { fontWeight: 600, margin: '0 0 8px' } }, 'Telegram Guard'),
    React.createElement('p', { style: { margin: '0 0 12px', color: 'var(--dsh-fg-70, #555)' } },
      'Aba contribuída por um plugin externo (dsh.client). Funciona.'),
    React.createElement(
      'button',
      { type: 'button', onClick: close, style: { padding: '4px 12px', cursor: 'pointer' } },
      'Fechar',
    ),
  )
}

/**
 * Abrir o modal de settings já na aba `sectionId`.
 *
 * O open do modal é estado local do `SettingsRoot` (sem handle global exposto
 * a footer actions). O caminho empírico escolhido é DOM-affordance:
 *   1. achar e clicar o trigger de settings — o SettingsRoot renderiza
 *      `button[aria-haspopup="dialog"]` com `aria-expanded`, DENTRO do assento
 *      `settingsArea`/`footArea` do rodapé da sidebar (escopo endurecido: não
 *      casa o primeiro `aria-haspopup` da página — só o do settings, e só se
 *      visível);
 *   2. achar o item do rail de navegação do `[role="dialog"]` cujo texto é o
 *      label da nossa section ('Telegram Guard') e clicá-lo.
 * Os dois passos são idempotentes quanto à presença do modal.
 */
function openSettingsOnSection(_sectionId: string): void {
  // Abre o modal se ainda estiver fechado.
  //
  // TRIGGER ENDUREÇIDO: NÃO casar o primeiro `button[aria-haspopup="dialog"]`
  // da página — outro modal/trigger pode anteceder o de settings no DOM. O
  // trigger de settings vive no RODAPÉ DA SIDEBAR, dentro do assento renderizado
  // pelo ui-settings-general (SettingsRoot), encaixado no `settingsArea` →
  // `footArea` do rodapé (classes CSS Modules hasheadas, ex. `hQ5OyW_settingsArea`).
  // Procuramos dentro desse assento e escolhemos o primeiro `aria-haspopup="dialog"`
  // VISÍVEL. Fallbacks: `footArea`, depois a coluna da sidebar, depois global.
  const findSettingsTrigger = (): HTMLButtonElement | null => {
    const scopes = [
      [...document.querySelectorAll<HTMLElement>('[class*="_settingsArea"]')],
      [...document.querySelectorAll<HTMLElement>('[class*="_footArea"]')],
      [...document.querySelectorAll<HTMLElement>('[class*="_sidebarCol"], [class*="_sidebarContainer"]')],
    ]
    const visible = (el: HTMLElement): boolean =>
      el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const firstVisible = (root: ParentNode): HTMLButtonElement | null => {
      const buttons = root.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')
      return Array.from(buttons).find(b => visible(b)) ?? null
    }
    for (const group of scopes) {
      for (const el of group) {
        const found = firstVisible(el)
        if (found !== null) return found
      }
    }
    return Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'))
      .find(b => visible(b)) ?? null
  }

  const trigger = findSettingsTrigger()
  if (trigger === null) return
  const wasOpen = trigger.getAttribute('aria-expanded') === 'true'
  if (!wasOpen) trigger.click()

  // No rail de navegação do modal de settings, TODAS as sections (ativas ou
  // não) são botões, cada um com o label da sua section como texto. O item da
  // NOSSA section é o botão do `[role="dialog"]` cujo texto é o label completo
  // 'Telegram Guard'. Clicá-lo chama `onSelect('telegram-guard')` no
  // SettingsRoot, o que fecha o modal com `activeId = 'telegram-guard'` (e
  // renderiza o nosso conteúdo).
  //
  // ESCOPO RIGOROSO: o rail vive DENTRO do `[role="dialog"]` do settings.
  // NÃO casar com `_nav` genérico (a sidebar/layout têm navs próprios) nem com
  // o nosso próprio botão do rodapé (texto "✈️Telegram" — só contém
  // "telegram", não o label completo). Por isso: procuramos apenas dentro do
  // dialog e casamos com 'Telegram Guard', não com 'telegram'.
  const findNavItem = (): HTMLButtonElement | null => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    if (dialog === null) return null
    const cells = dialog.querySelectorAll<HTMLButtonElement>('button')
    return Array.from(cells).find((cell: HTMLButtonElement) =>
      cell.textContent?.includes('Telegram Guard')) ?? null
  }

  // O clique no trigger é assíncrono (React commita o panel/rail na frame,
  // não no mesmo tick). Por isso ainda pode não haver rail no momento do
  // clique; tenta umas poucas frames (o modal abre em poucas) e para quando
  // achar. NOTA: `findNavItem` devolve null enquanto o dialog não existir,
  // então o polling é seguro do primeiro frame em diante.
  let attempts = 0
  const tryClick = (): void => {
    const cell = findNavItem()
    if (cell !== null) {
      cell.click()
      return
    }
    if (attempts < 12) {
      attempts += 1
      window.requestAnimationFrame(tryClick)
    }
  }
  tryClick()
}

/**
 * Corpo do plugin client. Regista as duas contribuições de slot.
 * @param ctx - contexto raiz Cordis do browser (injeta `slots`).
 */
export function apply(ctx: {
  slots: {
    inject(key: string, cb: () => unknown): unknown
    register(options: unknown, component: unknown): unknown
  }
}): void {
  // Botão no rodapé da sidebar (slot declarado pelo ui-sidebar).
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'guard-bot-button',
        order: 0,
        registrant: 'dsh-guarded-bot-orchestrator',
      },
      GuardBotSidebarAction,
    ),
  )
  // Aba nova no modal de settings (slot declarado pelo ui-settings).
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'telegram-guard',
        order: 99,
        label: 'Telegram Guard',
        registrant: 'dsh-guarded-bot-orchestrator',
      },
      TelegramGuardSection,
    ),
  )
}