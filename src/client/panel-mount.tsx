/**
 * Marketplace panel mounting — center-column takeover.
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the marketplace panel takes over the
 * center column at the DOM level: a container is appended inside the center
 * column (`[class*="centerCol"]`, the dsh AppFrame layout; `[data-pane="conversation"]`
 * on older shells) as an extra trailing child React never manages, and a
 * stylesheet rule hides the conversation content while the panel is active.
 * Toggling is a data attribute on <html> (set by MarketplaceController) — no
 * React involvement, so the conversation subtree underneath stays mounted
 * and stateful.
 *
 * Single-occupancy is coordinated with the sibling panels (task-board, ssh)
 * via the shared `dsh-panel-activate` custom event: opening one closes the
 * others. Clicking any sidebar row (session, workspace, or a sibling entry
 * like 技能中心) hands the center column back to the conversation.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { MarketplaceController } from './MarketplaceController.ts'
import type { MarketplaceStore, MarketplaceTab } from './store.ts'
import type { MarketplaceKey } from './locales.ts'
import { MarketplacePanel } from './MarketplacePanel.tsx'
import styles from './styles.module.css'

/** The injected panel container (kept in the DOM, hidden when inactive). */
export const MARKETPLACE_VIEW_SELECTOR = '[data-dsh-marketplace-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'marketplace'

/** Sidebar rows whose click hands the center column back to the conversation. */
const SIDEBAR_ROW_SELECTOR = [
  '[class*="sessionRow"]',
  '[class*="projectRow"]',
  '[class*="searchResultRow"]',
  '[class*="searchResultWorkspace"]',
  '[class*="newSession"]',
  '[data-dsh-taskboard-entry]',
  '[data-dsh-ssh-entry]',
  '[data-dsh-skill-explorer-entry]',
].join(', ')

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * Mount the marketplace React tree into the center column. Visibility is
 * driven entirely by the `data-dsh-marketplace-active` html attribute the
 * controller manages, so the root renders once and stays mounted (hidden
 * when inactive).
 *
 * @param panel - the panel open/close controller.
 * @param store - the marketplace data store (experts / skills / connectors).
 * @param t - localized label accessor.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountMarketplacePanel(
  panel: MarketplaceController,
  store: MarketplaceStore,
  t: (key: MarketplaceKey) => string,
  initialTab?: MarketplaceTab,
): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshMarketplaceView = ''
    container.dataset.dshPlugin = 'marketplace'
    container.className = styles['marketplaceView'] ?? ''
    column.appendChild(container)
    root = createRoot(container)
    root.render(
      <MarketplacePanel controller={store} t={t} onClose={() => { panel.closePanel() }} initialTab={initialTab} />,
    )
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // When a sibling panel (taskboard / ssh) activates, close this one.
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (typeof detail === 'string' && detail !== PANEL_NAME && panel.getSnapshot().panelOpen) {
      panel.closePanel()
    }
  }

  // Jump out on sidebar context clicks: clicking a session/workspace row or
  // a sibling entry (incl. 技能中心) hands the center column back to the
  // conversation. Capture phase so the panel closes before the shell processes
  // the click.
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!panel.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) panel.closePanel()
  }

  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
