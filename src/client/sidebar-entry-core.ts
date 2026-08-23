/**
 * Self-contained sidebar entry injection core for the marketplace plugin.
 *
 * Mirrors the shared helper used by sibling plugins (task-board, ssh):
 * since dsh's sidebar shell exposes no sidebar-item slot an external
 * plugin can register into, we inject a row between the shell's New
 * Session button and the workspace browser. The injection self-heals
 * across React re-renders via a MutationObserver; idempotency is
 * guaranteed by the row's stable data-attribute.
 *
 * This file is intentionally vendored into the plugin rather than
 * depending on a sibling package — the marketplace plugin must stay
 * self-contained (no modifications to any other host package).
 */

export interface SidebarEntryOptions {
  /** Full attribute name identifying the injected row (idempotency key). */
  rowAttribute: string
  /** CSS selector matching the injected row, e.g. `[data-dsh-marketplace-entry]`. */
  rowSelector: string
  /** Optional semantic plugin id emitted as `data-dsh-plugin`. */
  plugin?: string
  /** Inline icon markup (matches the shell's 16px nav-icon look). */
  icon: string
  /** CSS module class names (entry / entryIcon / entryLabel). */
  css: Record<string, string>
  /** Localized row label (aria-label + visible text). */
  label(): string
  /** Optional localized tooltip (title attribute). */
  tooltip?(): string
  /** Click action. */
  onToggle(): void
  /** Family-block position relative to sibling plugin rows. */
  position: 'before' | 'after'
  /**
   * Selectors of the sibling plugin entry rows this package orders against
   * (its own row included). Each family plugin passes the same list so the
   * rendered order stays stable across self-heals.
   */
  familySelectors: readonly string[]
  /** Optional active-state bridge. */
  active?: {
    subscribe(listener: () => void): () => void
    isOpen(): boolean
  }
}

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(options: SidebarEntryOptions): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(options.rowAttribute, '')
  if (options.plugin !== undefined) {
    entry.setAttribute('data-dsh-plugin', options.plugin)
    entry.setAttribute('data-dsh-part', 'sidebar-entry')
  }
  entry.className = options.css['entry'] ?? ''
  entry.setAttribute('aria-label', options.label())
  if (options.tooltip !== undefined) entry.setAttribute('title', options.tooltip())
  entry.innerHTML =
    '<span class="' + (options.css['entryIcon'] ?? '') + '">' + options.icon + '</span>' +
    '<span class="' + (options.css['entryLabel'] ?? '') + '">' + options.label() + '</span>'
  entry.addEventListener('click', options.onToggle)
  return entry
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement, options: SidebarEntryOptions): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(options.familySelectors.join(', ')),
    )
    const anchor = options.position === 'before'
      ? (family.length > 0 ? family[0]! : base.nextElementSibling)
      : (family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling)
    root.insertBefore(entry, anchor)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 */
export function mountSidebarEntry(options: SidebarEntryOptions): () => void {
  if (typeof document !== 'undefined' && document.querySelector(options.rowSelector) !== null) {
    return () => {}
  }
  const entry = createEntry(options)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry, options)
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      placed = placeEntry(root, entry, options)
    }
  })

  const unsubscribeActive = options.active === undefined ? undefined : (() => {
    const syncActive = (): void => {
      if (options.active!.isOpen()) entry.dataset.active = 'true'
      else delete entry.dataset.active
    }
    const unsubscribe = options.active.subscribe(syncActive)
    syncActive()
    return unsubscribe
  })()

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeActive?.()
    entry.remove()
  }
}

/**
 * The family block shared with sibling plugins: keep this list in sync if
 * new sidebar entries are added. The family includes task-board, ssh, and
 * the skill explorer (技能中心); marketplace slots in *after* the block so
 * it renders directly below 技能中心.
 */
export const MARKETPLACE_FAMILY_SELECTORS = [
  '[data-dsh-taskboard-entry]',
  '[data-dsh-ssh-entry]',
  '[data-dsh-skill-explorer-entry]',
  '[data-dsh-marketplace-entry]',
] as const