/**
 * Sidebar entry injection — package-specific wiring over the vendored core.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into
 * (`sidebar.workspaces` / `sidebar.settings` are single-occupant and already
 * taken), so the entry row is injected between the shell's New Session
 * button and the workspace browser, alongside the sibling family block
 * (task-board, ssh, 技能中心). The row is plain DOM (no React tree); the
 * marketplace panel it toggles is a separate React root mounted in the
 * center column (see panel-mount.ts). `position: 'after'` places it
 * directly below 技能中心, matching the requested layout.
 */
import type { MarketplaceController } from './MarketplaceController.ts'
import type { MarketplaceKey } from './locales.ts'
import styles from './styles.module.css'
import { mountSidebarEntry, MARKETPLACE_FAMILY_SELECTORS } from './sidebar-entry-core.ts'

/** Stable data attribute identifying the injected entry row. */
export const ENTRY_SELECTOR = '[data-dsh-marketplace-entry]'

/** Inline icon — a storefront/grid glyph matching the shell's 16px nav look. */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5h11l-1-2.5H3.5L2.5 5Z"/><path d="M2.5 5v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5"/><path d="M6 8v3M10 8v3"/></svg>'

/**
 * Mount the 应用市场 sidebar entry, waiting for the shell to render and
 * self-healing on later React re-renders.
 * @param controller - the panel controller the entry toggles.
 * @param t - localized label accessor (bound to the marketplace namespace).
 * @returns disposer removing the entry and its observers.
 */
export function mountMarketplaceEntry(controller: MarketplaceController, t: (key: MarketplaceKey) => string): () => void {
  return mountSidebarEntry({
    rowAttribute: 'data-dsh-marketplace-entry',
    rowSelector: ENTRY_SELECTOR,
    plugin: 'marketplace',
    icon: ICON,
    css: {
      entry: styles['entry'] ?? '',
      entryIcon: styles['entryIcon'] ?? '',
      entryLabel: styles['entryLabel'] ?? '',
    },
    label: () => t('nav'),
    onToggle: () => { controller.togglePanel() },
    position: 'after',
    familySelectors: [...MARKETPLACE_FAMILY_SELECTORS],
    active: {
      subscribe: (listener) => controller.subscribe(listener),
      isOpen: () => controller.getSnapshot().panelOpen,
    },
  })
}
