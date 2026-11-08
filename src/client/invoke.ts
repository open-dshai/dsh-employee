/**
 * Invocation bridge — turns a 召唤 / 试一试 click into a conversation
 * gesture: close the panel, focus the composer textarea, prefill a
 * routing prefix, and show a badge identifying the active target.
 *
 * Expert → `召唤专家「{name}」：` (role-play directive, no trigger char)
 * Skill  → `/{slug} ` (dsh `/`-skill syntax)
 *
 * Connector fill → inserts a connector-derived snippet into the composer
 * without a preset prefix (the snippet is the full content).
 *
 * In addition, the bridge injects a single anchor button next to the
 * composer textarea — a 🔌 chip with a green dot when at least one
 * connector is connected. Clicking the chip opens a popover (anchored
 * upward from the composer) that lists every connected connector with an
 * enable toggle, plus a "管理连接器" link that deep-links straight to the
 * marketplace's connector tab. The popover is pure DOM — it never touches
 * the host React tree, so it survives composer re-renders.
 */

import type { MarketplaceController } from './MarketplaceController.ts'
import type { MarketplaceStore } from './store.ts'
import { getConnectorConfigStatus } from './store.ts'
import type { RecentExpert, RecentSkill } from './store.ts'
import type { en } from './locales.ts'
// CSS Modules hash every class name at build time (`dshConnectorAnchor` →
// `N4Ngma_dshConnectorAnchor`). The anchor/popover are built with raw DOM
// APIs, so they MUST read the hashed names off the module map — writing the
// literal class name leaves the chip completely unstyled and, worse, breaks
// the `[data-open='true'] .dshConnectorPopover` visibility rule.
import styles from './styles.module.css'

// The host composer may be a classic <textarea> or a contenteditable
// <div> (the current dsh web build uses a contenteditable card). Match both.
const COMPOSER_SELECTOR = `[data-pane="conversation"] textarea, [class*="centerCol"] textarea, textarea[data-phase], [data-pane="conversation"] [contenteditable="true"], [class*="centerCol"] [contenteditable="true"], [contenteditable="true"]`
const BADGE_ATTR = 'data-dsh-invocation-badge'
const CONNECTOR_ANCHOR_ATTR = 'data-dsh-connector-anchor'
const CONNECTOR_POPOVER_ATTR = 'data-dsh-connector-popover'
/** Attribute on the persistent summoned-expert chip in the composer action row. */
const EXPERT_CHIP_ATTR = 'data-dsh-expert-chip'

/** Hero toolbar row hosting the workspace / PTC controls (new-chat state
 *  only — the host unmounts it inside an active conversation). */
const HERO_ROW_SELECTOR = '[class*="heroWorkspaceRow"]'
/** Right-aligned spacer at the end of the hero row; pickers go before it. */
const HERO_OPTIONS_SELECTOR = '[class*="heroOptions"]'
/** How many recently downloaded entries each hero picker shows. */
const PICKER_RECENT_LIMIT = 5

/** Localised helper — the bridge only needs a handful of strings. */
type T = (key: keyof typeof en) => string

export interface InvocationTarget {
  readonly kind: 'expert' | 'skill'
  readonly name: string
  readonly slug?: string | undefined
}

/** Find the conversation composer element (textarea or contenteditable). */
function findComposer(): HTMLElement | undefined {
  const el = document.querySelector<HTMLElement>(COMPOSER_SELECTOR)
  return el ?? undefined
}

function isTextArea(el: HTMLElement): el is HTMLTextAreaElement {
  return el.tagName === 'TEXTAREA'
}

/** Read the current composer value across both element kinds. */
function getComposerValue(el: HTMLElement): string {
  return isTextArea(el) ? el.value : (el.textContent ?? '')
}

/**
 * Set a controlled React textarea's value by going through the native
 * prototype setter (bypassing React's value tracker) and dispatching a
 * synthetic `input` event so React's `onChange` fires synchronously.
 */
function setNativeValue(ta: HTMLTextAreaElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  if (desc !== undefined && typeof desc.set === 'function') {
    desc.set.call(ta, value)
  } else {
    ta.value = value
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Write into a contenteditable element. The dsh composer is a Lexical editor,
 * which owns its own EditorState and rolls back bare DOM mutations
 * (textContent assignments are reverted on the next reconciliation), so every
 * change has to ride the editing events Lexical itself listens for:
 *  - insert: select-all + execCommand('insertText') replaces the content and
 *    fires the beforeinput/input pair Lexical tracks. A follow-up manual
 *    textContent write MUST NOT be added: Lexical reconciles asynchronously,
 *    so a synchronous consistency check misreads the not-yet-updated DOM as
 *    a failure and double-writes the prefix.
 *  - clear: with the whole content selected, dispatch the same
 *    beforeinput/input pair a real cut fires (deleteByCut). No textContent
 *    assignment either — it is the mutation Lexical rolls back, which used
 *    to leave the old prefix in place.
 */
function setEditableValue(el: HTMLElement, value: string): void {
  el.focus()
  const selectAll = (): void => {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  const clearSelection = (): void => {
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteByCut' }))
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByCut' }))
  }
  selectAll()
  if (value.length === 0) {
    clearSelection()
    return
  }
  // When the editor already holds text, a second execCommand('insertText')
  // right after the first write is silently dropped: Lexical's internal
  // selection has not caught up with the DOM selection yet, so the native
  // replace never reaches its state. Clearing through the event pair first
  // resets Lexical's state, then re-selecting and inserting lands reliably
  // (verified across repeated skill -> connector fill sequences).
  if ((el.textContent ?? '').length > 0) {
    clearSelection()
    selectAll()
  }
  document.execCommand('insertText', false, value)
}

/** Unified setter for either composer element kind. */
function setComposerValue(el: HTMLElement, value: string): void {
  if (isTextArea(el)) setNativeValue(el, value)
  else setEditableValue(el, value)
}

/** Run `fn` against the composer once it is available (immediate or ASAP). */
function runWhenComposer(fn: (el: HTMLElement) => void): void {
  const el = findComposer()
  if (el !== undefined) { fn(el); return }
  const obs = new MutationObserver(() => {
    const found = findComposer()
    if (found !== undefined) {
      obs.disconnect()
      fn(found)
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
  setTimeout(() => obs.disconnect(), 3000)
}

/** Pick the leading character of an avatar/label, CJK-aware. */
function avatarFallback(name: string): string {
  const t = name.trim()
  if (t.length === 0) return '?'
  return Array.from(t)[0]?.toUpperCase() ?? '?'
}

/**
 * The invocation bridge. Construct once from the plugin entry; listens
 * for the three window events and owns the badge element's lifecycle.
 *
 * `store` is needed for the connector anchor popover (which lists every
 * connected connector with an enable toggle and an "管理连接器" deep
 * link). It also forwards `dsh:connector-fill` snippets to the composer.
 */
export class InvocationBridge {
  private readonly panel: MarketplaceController
  private readonly store: MarketplaceStore
  private readonly t: T
  private badge: HTMLDivElement | undefined
  private domObserver: MutationObserver | undefined
  private sizeObserver: ResizeObserver | undefined
  private scrollHandler: (() => void) | undefined
  private resizeHandler: (() => void) | undefined
  private rafHandle: number | undefined
  private anchor: HTMLButtonElement | undefined
  private anchorPopover: HTMLDivElement | undefined
  private anchorSizeObserver: ResizeObserver | undefined
  private anchorDomObserver: MutationObserver | undefined
  private storeUnsubscribe: (() => void) | undefined
  /** The currently summoned expert (drives the persistent composer chip). */
  private activeExpert: { name: string; slug: string; avatarUrl: string } | undefined
  /** Persistent chip rendered next to the composer's view-mode control. */
  private expertChip: HTMLDivElement | undefined
  /** Host node with the two hero-toolbar quick pickers (专家 / 技能). */
  private pickerHost: HTMLDivElement | undefined
  /** Which picker popover is currently open (only one at a time). */
  private openPicker: 'experts' | 'skills' | undefined
  /** Capture-phase document click handler that closes the open popover. */
  private pickerDocClick: ((e: MouseEvent) => void) | undefined

  constructor(panel: MarketplaceController, store: MarketplaceStore, t: T) {
    this.panel = panel
    this.store = store
    this.t = t
    window.addEventListener('dsh:invoke-expert', this.onExpert as EventListener)
    window.addEventListener('dsh:invoke-skill', this.onSkill as EventListener)
    window.addEventListener('dsh:connector-fill', this.onConnectorFill as EventListener)
    window.addEventListener('dsh:open-marketplace-connectors', this.onManageConnectors as EventListener)
    window.addEventListener('dsh:connector-toggle', this.onConnectorToggle as EventListener)
    if (typeof MutationObserver !== 'undefined') this.waitForComposerThenMountAnchor()
    // The chip's green dot mirrors "at least one connector connected".
    // Connector rows only land in the store after `loadConnectors()`, which
    // normally happens when the marketplace's connector tab mounts — the
    // composer chip cannot wait for that, so it subscribes and self-loads.
    this.storeUnsubscribe = this.store.store.subscribe(() => {
      this.refreshAnchorConnectedDot()
      if (this.anchor?.dataset.open === 'true') this.renderConnectorPopover()
      // Keep an open hero picker in sync when an install/uninstall lands
      // while the panel is open (the panel shares the same store).
      if (this.openPicker !== undefined) this.refreshOpenPicker()
    })
    void this.ensureConnectorsLoaded()
    void this.ensureCatalogLoaded()
  }

  /** Kick a connector catalog load if nothing has fetched it yet. */
  private async ensureConnectorsLoaded(): Promise<void> {
    const status = this.store.store.getSnapshot().connectors.status
    if (status === 'idle') await this.store.loadConnectors()
  }

  /** Preload the expert/skill catalogs so the hero picker can backfill
   *  installed entries that predate the recent-list storage. */
  private async ensureCatalogLoaded(): Promise<void> {
    const snap = this.store.store.getSnapshot()
    if (snap.experts.status === 'idle') void this.store.loadExperts()
    if (snap.skills.status === 'idle') void this.store.loadSkills()
  }

  /** Enable/disable toggles are persisted by the store; keep the chip in sync. */
  private readonly onConnectorToggle = (): void => {
    this.refreshAnchorConnectedDot()
    if (this.anchor?.dataset.open === 'true') this.renderConnectorPopover()
  }

  // ── Expert invocation ─────────────────────────────────────────────

  private readonly onExpert = (event: Event): void => {
    const detail = (event as CustomEvent).detail as
      | { id?: number; name?: string; slug?: string; intro?: string; avatarUrl?: string }
      | undefined
    const name = detail?.name ?? '专家'
    const slug = detail?.slug ?? ''
    const avatarUrl = typeof detail?.avatarUrl === 'string' ? detail.avatarUrl : ''
    // Refresh the hero picker's recent list even for experts that were
    // installed before the recent-list feature shipped (their summon skips
    // installExpert, so the list would otherwise stay empty forever).
    if (typeof detail?.id === 'number') {
      this.store.touchRecentExpert({ id: detail.id, name, slug, avatarUrl })
    }
    // 1. Hand the center column back to the conversation.
    this.panel.closePanel()
    // 2. Prefill the composer with a role-play directive — this prefix is
    //    what makes the next send actually invoke the expert.
    const prefix = this.expertPrefix(name)
    this.runWhenComposerReady(prefix)
    // 3. Persist + render the chip in the composer action row. It stays
    //    (unlike the old 30s badge) until the user dismisses it.
    this.activeExpert = { name, slug, avatarUrl }
    runWhenComposer(() => this.mountExpertChip())
  }

  /** Build the role-play directive prefixed into the composer. */
  private expertPrefix(name: string): string {
    return `召唤专家「${name}」：`
  }

  // ── Skill invocation ──────────────────────────────────────────────

  private readonly onSkill = (event: Event): void => {
    const detail = (event as CustomEvent).detail as
      | { slug?: string; displayName?: string; version?: string }
      | undefined
    const slug = detail?.slug ?? ''
    const name = detail?.displayName ?? slug ?? '技能'
    if (slug.length > 0) this.store.touchRecentSkill({ slug, displayName: name })
    this.panel.closePanel()
    const prefix = slug.length > 0 ? `/${slug} ` : ''
    this.runWhenComposerReady(prefix)
    this.showBadge({ kind: 'skill', name, slug })
  }

  // ── Connector fill ────────────────────────────────────────────────

  private readonly onConnectorFill = (event: Event): void => {
    const detail = (event as CustomEvent).detail as
      | { id?: string; name?: string; snippet?: string }
      | undefined
    const snippet = typeof detail?.snippet === 'string' ? detail.snippet : ''
    if (snippet.length === 0) return
    // The connector flow goes through the connector tab; close the panel
    // (deep-link target) and write the snippet into the textarea.
    this.panel.closePanel()
    this.runWhenComposerReady(snippet)
  }

  // ── Marketplace deep-link (called by connector anchor manage button) ─

  private readonly onManageConnectors = (): void => {
    if (typeof this.panel.openPanel === 'function') {
      // Re-open the marketplace panel with the connector tab prefocused.
      this.panel.openPanel('connectors')
    }
    // The panel stays mounted across open/close, so `openPanel`'s stored
    // default tab alone will not move an already-mounted panel. Fire the
    // live tab-switch event the panel listens for.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dsh:marketplace-set-tab', { detail: { tab: 'connectors' } }))
    }
  }

  // ── Composer prefill ──────────────────────────────────────────────

  /** Focus the composer textarea and prefill the routing prefix. */
  private runWhenComposerReady(prefix: string): void {
    runWhenComposer((el) => {
      if (prefix.length > 0 && getComposerValue(el) !== prefix) {
        setComposerValue(el, prefix)
        if (isTextArea(el)) {
          try { el.setSelectionRange(prefix.length, prefix.length) } catch { /* not all inputs support selection */ }
        }
      }
      el.focus()
    })
  }

  // ── Badge management ──────────────────────────────────────────────

  /** Inject (or replace) the active-target badge above the composer. */
  private showBadge(target: InvocationTarget): void {
    this.clearBadge()
    const badge = document.createElement('div')
    badge.setAttribute(BADGE_ATTR, '')
    badge.setAttribute('data-kind', target.kind)
    const icon = target.kind === 'expert' ? '🎯' : '🧩'
    const label = target.kind === 'expert' ? '当前专家' : '当前技能'
    badge.textContent = `${icon} ${label}：${target.name}`
    Object.assign(badge.style, {
      position: 'fixed',
      zIndex: '9999',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      padding: '5px 8px 5px 12px',
      borderRadius: '8px',
      background: 'var(--dsw-color-accent, #1677ff)',
      color: '#fff',
      fontSize: '12px',
      fontWeight: '500',
      lineHeight: '1.2',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
      cursor: 'default',
      userSelect: 'none',
      maxWidth: 'min(360px, 60vw)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      pointerEvents: 'auto',
      transition: 'opacity 120ms ease-out',
    } as Partial<CSSStyleDeclaration>)
    const close = document.createElement('button')
    close.type = 'button'
    close.setAttribute('aria-label', '清除')
    close.textContent = '×'
    Object.assign(close.style, {
      appearance: 'none',
      border: 'none',
      background: 'rgba(255,255,255,0.25)',
      color: '#fff',
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      cursor: 'pointer',
      fontSize: '12px',
      lineHeight: '1',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
      padding: '0',
    } as Partial<CSSStyleDeclaration>)
    close.addEventListener('click', () => this.clearBadge())
    badge.appendChild(close)
    document.body.appendChild(badge)
    this.badge = badge
    this.domObserver = new MutationObserver(() => {
      if (this.badge !== undefined && !document.body.contains(this.badge)) {
        this.unbindFollowers()
        this.badge = undefined
      }
    })
    this.domObserver.observe(document.body, { childList: true, subtree: true })
    this.bindFollowers()
    this.scheduleReposition()
    setTimeout(() => this.clearBadge(), 30000)
  }

  private bindFollowers(): void {
    const ta = findComposer()
    if (ta !== undefined && typeof ResizeObserver !== 'undefined') {
      this.sizeObserver = new ResizeObserver(() => this.scheduleReposition())
      this.sizeObserver.observe(ta)
    }
    this.scrollHandler = () => this.scheduleReposition()
    this.resizeHandler = () => this.scheduleReposition()
    window.addEventListener('scroll', this.scrollHandler, true)
    window.addEventListener('resize', this.resizeHandler)
  }

  private unbindFollowers(): void {
    this.sizeObserver?.disconnect()
    this.sizeObserver = undefined
    if (this.scrollHandler !== undefined) {
      window.removeEventListener('scroll', this.scrollHandler, true)
      this.scrollHandler = undefined
    }
    if (this.resizeHandler !== undefined) {
      window.removeEventListener('resize', this.resizeHandler)
      this.resizeHandler = undefined
    }
    if (this.rafHandle !== undefined) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = undefined
    }
  }

  private scheduleReposition(): void {
    if (this.rafHandle !== undefined) return
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = undefined
      this.repositionBadge()
    })
  }

  private repositionBadge(): void {
    const badge = this.badge
    const ta = findComposer()
    if (badge === undefined) return
    if (ta === undefined) { badge.style.opacity = '0'; return }
    const rect = ta.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) { badge.style.opacity = '0'; return }
    const badgeRect = badge.getBoundingClientRect()
    const badgeH = badgeRect.height > 0 ? badgeRect.height : 28
    const gap = 8
    const desiredTop = rect.top - badgeH - gap
    const top = Math.max(desiredTop, 4)
    const left = Math.max(rect.left, 4)
    badge.style.opacity = '1'
    badge.style.left = `${left}px`
    badge.style.top = `${top}px`
    badge.style.transform = 'none'
    badge.style.bottom = 'auto'
    badge.style.right = 'auto'
  }

  private clearBadge(): void {
    this.unbindFollowers()
    this.domObserver?.disconnect()
    this.domObserver = undefined
    this.badge?.remove()
    this.badge = undefined
  }

  /**
   * Locate the composer card — the deepest ancestor containing the textarea
   * AND at least one `<button>` (i.e. the bottom action row lives there too).
   * Returns undefined if no such ancestor exists, in which case the caller
   * should fall back to `document.body`.
   */
  private locateComposerCard(ta: HTMLElement): HTMLElement | undefined {
    let el: HTMLElement | null = ta.parentElement
    while (el !== null && el !== document.body) {
      if (el.querySelectorAll('button').length > 0) return el
      el = el.parentElement
    }
    return undefined
  }

  /**
   * Locate the bottom action row inside the composer card: a direct child
   * of the card that holds buttons AND does not contain the textarea.
   * (The card's other direct children include the textarea wrapper and a
   * few decoration layers that don't qualify as a "row".)
   */
  private locateButtonRow(card: HTMLElement, ta: HTMLElement): HTMLElement | undefined {
    for (const child of Array.from(card.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (child.contains(ta)) continue
      if (child.querySelectorAll('button, [role="button"]').length > 0) return child
    }
    return undefined
  }

  /**
   * Walk up from `ta` to find the deepest ancestor whose `parentElement`
   * is exactly `card`. That ancestor is the right `insertBefore` reference
   * — it IS a direct child of the card (so DOM operations are valid), and
   * it CONTAINS the textarea (so inserting before it pushes the textarea
   * wrapper down inside the card without breaking its scroll context).
   */
  private locateCardDirectChildAncestor(ta: HTMLElement, card: HTMLElement): HTMLElement | undefined {
    let cur: HTMLElement | null = ta.parentElement
    while (cur !== null && cur !== document.body) {
      if (cur.parentElement === card) return cur
      cur = cur.parentElement
    }
    return undefined
  }

  // ── Composer connector anchor (🔌 chip + inline panel) ───────────────
  //
  // The anchor is now a regular-flow DOM element inside the composer's own
  // action row (the same row that hosts +, Workspace Write, model selector,
  // send). Clicking it toggles the connector panel inline — a sibling of
  // the textarea wrapper, INSIDE the composer card — so it can never be
  // occluded by sibling dropdowns (Workspace Write, model picker) the way
  // a `position: fixed` floating overlay used to be.

  private waitForComposerThenMountAnchor(): void {
    const tryMount = (): void => {
      const ta = findComposer()
      if (ta !== undefined) {
        this.mountConnectorAnchor()
        this.mountHeroPickers()
        return
      }
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      tryMount()
    } else {
      document.addEventListener('DOMContentLoaded', tryMount, { once: true })
    }
    // Watchdog: the host re-creates the conversation pane on route changes,
    // which drops our injected nodes. Keep a dedicated MutationObserver
    // (NOT the ResizeObserver slot — overwriting that killed the watchdog
    // after the first mount) so the chip is re-injected every time.
    this.anchorDomObserver = new MutationObserver(() => {
      if (this.anchor === undefined || !document.body.contains(this.anchor)) {
        if (findComposer() !== undefined) this.mountConnectorAnchor()
      }
      if (this.activeExpert !== undefined
        && (this.expertChip === undefined || !document.body.contains(this.expertChip))) {
        if (findComposer() !== undefined) this.mountExpertChip()
      }
      // The hero row exists only on the new-chat screen; mounting bails
      // quietly in conversation state and re-runs when a new chat opens.
      if (this.pickerHost === undefined || !document.body.contains(this.pickerHost)) {
        this.mountHeroPickers()
      }
    })
    this.anchorDomObserver.observe(document.body, { childList: true, subtree: true })
  }

  private mountConnectorAnchor(): void {
    if (this.anchor !== undefined && document.body.contains(this.anchor)) return
    this.unmountConnectorAnchor()
    const ta = findComposer()
    if (ta === undefined) return

    // Build the chip as a real DOM child of the composer's action row. No
    // `position: fixed`, no z-index hack — it sits where it's appended and
    // inherits the row's flex layout (display:inline-flex puts it beside
    // its siblings naturally).
    const anchor = document.createElement('button')
    anchor.type = 'button'
    anchor.setAttribute(CONNECTOR_ANCHOR_ATTR, '')
    anchor.className = styles.dshConnectorAnchor ?? 'dshConnectorAnchor'
    anchor.style.cursor = 'pointer'
    const icon = document.createElement('span')
    icon.textContent = '🔌'
    icon.style.fontSize = '16px'
    icon.style.lineHeight = '1'
    anchor.appendChild(icon)

    // Build the panel as a sibling of the textarea wrapper — inserted just
    // BEFORE it inside the composer card — so when open it pushes the
    // textarea down inside the card and stays inside the card's stacking
    // context, immune to Workspace Write / model picker's z-index tricks.
    const popover = document.createElement('div')
    popover.setAttribute(CONNECTOR_POPOVER_ATTR, '')
    popover.className = styles.dshConnectorPopover ?? 'dshConnectorPopover'
    popover.addEventListener('click', (event) => { event.stopPropagation() })

    // Find the composer card so we can place the panel above the textarea
    // wrapper but still INSIDE the card. Fall back to the textarea's parent
    // if the heuristic fails.
    const card = this.locateComposerCard(ta)
    const buttonRow = card !== undefined ? this.locateButtonRow(card, ta) : undefined
    const taWrapper = ta.parentElement
    const taContainer = taWrapper?.parentElement ?? null
    // Popover insertion: prefer the composer card (where the panel sits
    // BETWEEN the textarea and its scroll wrapper). Fall back to the
    // textarea's immediate container — direct sibling of the wrapper.
    let popoverParent: HTMLElement | null = null
    let popoverReference: HTMLElement | null = null
    if (card !== undefined) {
      const ref = this.locateCardDirectChildAncestor(ta, card)
      if (ref !== undefined) { popoverParent = card; popoverReference = ref }
    }
    if (popoverParent === null && taContainer !== null && taWrapper !== null) {
      popoverParent = taContainer
      popoverReference = taWrapper
    }
    if (popoverParent !== null && popoverReference !== null) {
      popoverParent.insertBefore(popover, popoverReference)
    } else {
      document.body.appendChild(popover)
    }
    // Chip: append to the bottom action row if found, else to the card,
    // else to the composer card's last child. We append rather than
    // prepend to avoid disturbing the host's existing layout order
    // (the existing button order is what users have muscle memory for).
    const anchorParent = buttonRow ?? card ?? taContainer ?? document.body
    anchorParent.appendChild(anchor)

    this.anchor = anchor
    this.anchorPopover = popover
    anchor.dataset.open = 'false'
    popover.dataset.open = 'false'
    popover.style.display = 'none'

    const setOpen = (open: boolean): void => {
      anchor.dataset.open = open ? 'true' : 'false'
      popover.dataset.open = open ? 'true' : 'false'
      popover.style.display = open ? 'block' : 'none'
    }
    const toggleOpen = (event: MouseEvent): void => {
      event.stopPropagation()
      const wasOpen = anchor.dataset.open === 'true'
      if (wasOpen) {
        setOpen(false)
      } else {
        // Lazily populate the catalog the first time the chip is opened.
        void this.ensureConnectorsLoaded()
        this.renderConnectorPopover()
        setOpen(true)
      }
    }
    anchor.addEventListener('click', toggleOpen)
    // Outside click closes. The anchor and popover are NO LONGER parent/
    // child, so check both.
    const onDocClick = (e: MouseEvent): void => {
      if (anchor.dataset.open !== 'true') return
      const tgt = e.target as Node | null
      if (tgt === null) return
      if (anchor.contains(tgt) || popover.contains(tgt)) return
      setOpen(false)
    }
    document.addEventListener('click', onDocClick, true)
    ;(anchor as unknown as { __onDocClick?: (e: MouseEvent) => void }).__onDocClick = onDocClick
    // No need for scroll/resize reposition — the chip and panel now live
    // inside the composer's own flex column and participate in normal
    // layout, so the browser handles reflow automatically.
    // Initial render of the chip content (connected dot).
    this.refreshAnchorConnectedDot()
  }

  private readonly onAnchorViewportChange = (): void => { this.scheduleAnchorReposition() }

  private unmountConnectorAnchor(): void {
    if (this.anchor !== undefined) {
      const handler = (this.anchor as unknown as { __onDocClick?: (e: MouseEvent) => void }).__onDocClick
      if (handler !== undefined) document.removeEventListener('click', handler, true)
      this.anchor.remove()
    }
    this.anchor = undefined
    this.anchorPopover = undefined
    this.anchorSizeObserver?.disconnect()
    this.anchorSizeObserver = undefined
    window.removeEventListener('scroll', this.onAnchorViewportChange, true)
    window.removeEventListener('resize', this.onAnchorViewportChange)
  }

  // ── Summoned-expert chip (persistent, inside the composer action row) ──
  //
  // Mirrors the connector anchor's survival strategy: a real-flow node in
  // the host's own bottom action row, re-injected by anchorDomObserver
  // whenever the host re-creates the conversation pane.

  /**
   * Find the permission-mode control in the composer's bottom action row.
   * The current host renders it as a `[class*="modes"]` div labelled
   * 工作区内修改; older builds used a 仅可查看 / 允许完全访问 button.
   * The expert chip is inserted immediately after this element.
   */
  private locateViewModeControl(row: HTMLElement): HTMLElement | undefined {
    // Primary path: the host's hashed class keeps the stable `modes` stem.
    const byClass = row.querySelector<HTMLElement>('[class*="modes"]')
    if (byClass !== null) return byClass
    // Text fallback for hosts without that class. Iterating in document
    // order and keeping the LAST match prefers the deepest, most specific
    // element over a wrapper that only contains the label text.
    let best: HTMLElement | undefined
    const candidates = row.querySelectorAll('button, [role="button"], div, span')
    for (const el of Array.from(candidates)) {
      const text = (el.textContent ?? '').replace(/\s+/g, '')
      if (text.includes('工作区') || text.includes('修改') || text.includes('查看') || text.includes('访问') || /read|write/i.test(text)) {
        best = el as HTMLElement
      }
    }
    return best
  }

  private mountExpertChip(): void {
    const expert = this.activeExpert
    if (expert === undefined) return
    this.unmountExpertChip()
    const ta = findComposer()
    if (ta === undefined) return
    const card = this.locateComposerCard(ta)
    const row = card !== undefined ? this.locateButtonRow(card, ta) : undefined
    if (row === undefined) return

    const chip = document.createElement('div')
    chip.setAttribute(EXPERT_CHIP_ATTR, '')
    chip.className = styles.dshExpertChip ?? 'dshExpertChip'

    const avatar = document.createElement('span')
    avatar.className = styles.dshExpertChipAvatar ?? 'dshExpertChipAvatar'
    if (expert.avatarUrl.length > 0) {
      const img = document.createElement('img')
      img.src = expert.avatarUrl
      img.alt = ''
      img.addEventListener('error', () => { img.remove() ; avatar.textContent = avatarFallback(expert.name) })
      avatar.appendChild(img)
    } else {
      avatar.textContent = avatarFallback(expert.name)
    }
    chip.appendChild(avatar)

    const nameEl = document.createElement('span')
    nameEl.className = styles.dshExpertChipName ?? 'dshExpertChipName'
    nameEl.textContent = expert.name
    chip.appendChild(nameEl)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = styles.dshExpertChipClose ?? 'dshExpertChipClose'
    close.setAttribute('aria-label', this.t('close'))
    close.textContent = '×'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      this.dismissExpertChip()
    })
    chip.appendChild(close)

    // Insert immediately after the permission-mode control (工作区内修改 /
    // 仅可查看). It sits inside the row's left "tools" container rather
    // than being a direct child of the row, so insert relative to the
    // element itself instead of climbing to a row-level wrapper.
    const modeEl = this.locateViewModeControl(row)
    if (modeEl !== undefined && modeEl.parentElement !== null) {
      modeEl.parentElement.insertBefore(chip, modeEl.nextSibling)
    } else {
      row.insertBefore(chip, row.firstChild)
    }
    this.expertChip = chip
  }

  /** Remove the chip and strip the expert prefix from the composer. */
  private dismissExpertChip(): void {
    const expert = this.activeExpert
    this.unmountExpertChip()
    this.activeExpert = undefined
    if (expert !== undefined) {
      const el = findComposer()
      if (el !== undefined) {
        const prefix = this.expertPrefix(expert.name)
        const current = getComposerValue(el)
        if (current.startsWith(prefix)) setComposerValue(el, current.slice(prefix.length))
      }
    }
  }

  private unmountExpertChip(): void {
    this.expertChip?.remove()
    this.expertChip = undefined
  }

  // ── Hero toolbar quick pickers (最近下载的专家 / 技能) ────────────────
  //
  // Two dropdown chips appended to the host's hero workspace row (the row
  // with the workspace and PTC controls), immediately after PTC. Each
  // lists up to PICKER_RECENT_LIMIT recently downloaded entries from the
  // store; clicking an item reuses the existing dsh:invoke-* event chain.
  // Pure DOM, like the connector anchor — the observer re-injects the
  // nodes whenever the host rebuilds the new-chat screen.

  private mountHeroPickers(): void {
    if (this.pickerHost !== undefined && document.body.contains(this.pickerHost)) return
    this.unmountHeroPickers()
    const row = document.querySelector<HTMLElement>(HERO_ROW_SELECTOR)
    if (row === null) return
    const host = document.createElement('div')
    host.setAttribute('data-dsh-picker-host', '')
    host.className = styles.dshPickerHost ?? 'dshPickerHost'
    host.appendChild(this.buildPicker('experts'))
    host.appendChild(this.buildPicker('skills'))
    // The row ends with a right-aligned spacer (heroOptions, large
    // margin-left). Insert before it so the pickers sit right after PTC;
    // append only when the spacer is absent.
    const spacer = row.querySelector(HERO_OPTIONS_SELECTOR)
    if (spacer !== null) row.insertBefore(host, spacer)
    else row.appendChild(host)
    this.pickerHost = host

    this.pickerDocClick = (e: MouseEvent): void => {
      if (this.openPicker === undefined) return
      const tgt = e.target as Node | null
      if (tgt !== null && host.contains(tgt)) return
      this.closePickers()
    }
    document.addEventListener('click', this.pickerDocClick, true)
  }

  private unmountHeroPickers(): void {
    if (this.pickerDocClick !== undefined) {
      document.removeEventListener('click', this.pickerDocClick, true)
      this.pickerDocClick = undefined
    }
    this.pickerHost?.remove()
    this.pickerHost = undefined
    this.openPicker = undefined
  }

  /** Build one trigger button + its (hidden until opened) popover. */
  private buildPicker(kind: 'experts' | 'skills'): HTMLDivElement {
    const wrap = document.createElement('div')
    wrap.className = styles.dshPicker ?? 'dshPicker'
    wrap.setAttribute('data-dsh-picker', kind)

    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = styles.dshPickerTrigger ?? 'dshPickerTrigger'
    trigger.setAttribute('data-dsh-picker-trigger', kind)
    trigger.dataset.open = 'false'
    const icon = document.createElement('span')
    icon.className = styles.dshPickerIcon ?? 'dshPickerIcon'
    icon.textContent = kind === 'experts' ? '🎯' : '🧩'
    const label = document.createElement('span')
    label.className = styles.dshPickerLabel ?? 'dshPickerLabel'
    label.textContent = kind === 'experts' ? this.t('pickerExperts') : this.t('pickerSkills')
    const caret = document.createElement('span')
    caret.className = styles.dshPickerCaret ?? 'dshPickerCaret'
    caret.textContent = '▾'
    trigger.append(icon, label, caret)
    trigger.addEventListener('click', (event) => {
      event.stopPropagation()
      this.togglePicker(kind)
    })

    const popover = document.createElement('div')
    popover.className = styles.dshPickerPopover ?? 'dshPickerPopover'
    popover.setAttribute('data-dsh-picker-popover', kind)
    popover.dataset.open = 'false'
    popover.addEventListener('click', (event) => event.stopPropagation())

    wrap.append(trigger, popover)
    return wrap
  }

  /** Open the requested picker (closing the other), or close if already open. */
  private togglePicker(kind: 'experts' | 'skills'): void {
    if (this.pickerHost === undefined) return
    if (this.openPicker === kind) {
      this.closePickers()
      return
    }
    this.closePickers()
    const trigger = this.pickerHost.querySelector<HTMLElement>(`[data-dsh-picker-trigger="${kind}"]`)
    const popover = this.pickerHost.querySelector<HTMLElement>(`[data-dsh-picker-popover="${kind}"]`)
    if (trigger === null || popover === null) return
    this.renderPickerPopover(kind, popover)
    trigger.dataset.open = 'true'
    popover.dataset.open = 'true'
    this.openPicker = kind
  }

  private closePickers(): void {
    if (this.pickerHost !== undefined) {
      this.pickerHost
        .querySelectorAll<HTMLElement>('[data-dsh-picker-trigger], [data-dsh-picker-popover]')
        .forEach((el) => { el.dataset.open = 'false' })
    }
    this.openPicker = undefined
  }

  /** Re-render the currently open popover after a store snapshot change. */
  private refreshOpenPicker(): void {
    if (this.openPicker === undefined || this.pickerHost === undefined) return
    const popover = this.pickerHost.querySelector<HTMLElement>(`[data-dsh-picker-popover="${this.openPicker}"]`)
    if (popover !== null) this.renderPickerPopover(this.openPicker, popover)
  }

  /** Fill a picker popover with the five most recent downloaded entries. */
  private renderPickerPopover(kind: 'experts' | 'skills', popover: HTMLElement): void {
    popover.innerHTML = ''
    const snap = this.store.store.getSnapshot()
    const list = document.createElement('div')
    list.className = styles.dshPickerList ?? 'dshPickerList'
    if (kind === 'experts') {
      // Intersect with the install set so a stale storage entry can never
      // surface an expert that is no longer downloaded.
      const recent = snap.recentExperts.filter((r) => snap.install.installedExperts.has(r.id))
      // Backfill: experts installed before the recent-list storage existed
      // have no recent entry. Pull their name/avatar from the catalog so
      // the picker still lists every downloaded expert.
      const knownIds = new Set(recent.map((r) => r.id))
      const backfill: RecentExpert[] = snap.experts.items
        .filter((r) => snap.install.installedExperts.has(r.id) && !knownIds.has(r.id))
        .map((r) => ({ id: r.id, name: r.name, slug: r.slug, avatarUrl: r.avatarUrl, ts: 0 }))
      const items = [...recent, ...backfill].slice(0, PICKER_RECENT_LIMIT)
      if (items.length === 0) {
        list.appendChild(this.buildPickerEmpty(this.t('pickerExpertEmpty')))
      } else {
        for (const row of items) list.appendChild(this.buildExpertPickerItem(row))
      }
    } else {
      const recent = snap.recentSkills.filter((r) => snap.install.installedSkills.has(r.slug))
      const knownSlugs = new Set(recent.map((r) => r.slug))
      const backfill: RecentSkill[] = snap.skills.items
        .filter((r) => snap.install.installedSkills.has(r.slug) && !knownSlugs.has(r.slug))
        .map((r) => ({ slug: r.slug, displayName: r.displayName, ts: 0 }))
      const items = [...recent, ...backfill].slice(0, PICKER_RECENT_LIMIT)
      if (items.length === 0) {
        list.appendChild(this.buildPickerEmpty(this.t('pickerSkillEmpty')))
      } else {
        for (const row of items) list.appendChild(this.buildSkillPickerItem(row))
      }
    }
    popover.appendChild(list)

    const more = document.createElement('div')
    more.className = styles.dshPickerMore ?? 'dshPickerMore'
    more.textContent = kind === 'experts' ? this.t('pickerMoreExperts') : this.t('pickerMoreSkills')
    more.addEventListener('click', (event) => {
      event.stopPropagation()
      this.closePickers()
      if (typeof this.panel.openPanel === 'function') this.panel.openPanel(kind)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dsh:marketplace-set-tab', { detail: { tab: kind } }))
      }
    })
    popover.appendChild(more)
  }

  private buildPickerEmpty(text: string): HTMLElement {
    const empty = document.createElement('div')
    empty.className = styles.dshPickerEmpty ?? 'dshPickerEmpty'
    empty.textContent = text
    return empty
  }

  private buildExpertPickerItem(row: RecentExpert): HTMLElement {
    const item = document.createElement('div')
    item.className = styles.dshPickerItem ?? 'dshPickerItem'
    const avatar = document.createElement('span')
    avatar.className = styles.dshPickerAvatar ?? 'dshPickerAvatar'
    if (row.avatarUrl.length > 0) {
      const img = document.createElement('img')
      img.src = row.avatarUrl
      img.alt = ''
      img.loading = 'lazy'
      img.addEventListener('error', () => { img.remove(); avatar.textContent = avatarFallback(row.name) })
      avatar.appendChild(img)
    } else {
      avatar.textContent = avatarFallback(row.name)
    }
    const name = document.createElement('span')
    name.className = styles.dshPickerName ?? 'dshPickerName'
    name.textContent = row.name
    item.append(avatar, name)
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      this.closePickers()
      if (typeof window !== 'undefined') {
        // Reuse the exact event chain the marketplace 召唤 button fires:
        // InvocationBridge.onExpert prefills the composer and mounts the chip.
        window.dispatchEvent(new CustomEvent('dsh:invoke-expert', {
          detail: { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatarUrl },
        }))
      }
    })
    return item
  }

  private buildSkillPickerItem(row: RecentSkill): HTMLElement {
    const item = document.createElement('div')
    item.className = styles.dshPickerItem ?? 'dshPickerItem'
    const avatar = document.createElement('span')
    avatar.className = `${styles.dshPickerAvatar ?? 'dshPickerAvatar'} ${styles.dshPickerAvatarSkill ?? 'dshPickerAvatarSkill'}`
    avatar.textContent = avatarFallback(row.displayName)
    const name = document.createElement('span')
    name.className = styles.dshPickerName ?? 'dshPickerName'
    name.textContent = row.displayName
    item.append(avatar, name)
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      this.closePickers()
      if (typeof window !== 'undefined') {
        // InvocationBridge.onSkill turns this into the `/<slug> ` prefix.
        window.dispatchEvent(new CustomEvent('dsh:invoke-skill', {
          detail: { slug: row.slug, displayName: row.displayName },
        }))
      }
    })
    return item
  }

  private anchorRepositionFrame: number | undefined
  private scheduleAnchorReposition(): void {
    if (this.anchorRepositionFrame !== undefined) return
    this.anchorRepositionFrame = requestAnimationFrame(() => {
      this.anchorRepositionFrame = undefined
      const ta = findComposer()
      const a = this.anchor
      if (a === undefined || ta === undefined) return
      const rect = ta.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      // Anchor sits centered above the textarea, just under the badge level.
      const aH = a.getBoundingClientRect().height || 32
      const gap = 12
      const top = Math.max(rect.top - aH - gap, 4)
      const left = Math.max(rect.left + (rect.width - 32) / 2, 4)
      a.style.left = `${left}px`
      a.style.top = `${top}px`
      a.style.transform = 'none'
    })
  }

  private refreshAnchorConnectedDot(): void {
    if (this.anchor === undefined) return
    const snap = this.store.store.getSnapshot().connectors.items
    const hasConnected = snap.some((c) => c.connected)
    this.anchor.dataset.hasConnected = hasConnected ? 'true' : 'false'
  }

  private renderConnectorPopover(): void {
    const pop = this.anchorPopover
    if (pop === undefined) return
    pop.innerHTML = ''
    const snap = this.store.store.getSnapshot().connectors.items
    // The popover lists every *connected* connector (matching image 3's
    // UX: a disabled switch is still shown, just not callable). Disabled
    // connectors are hidden from the connectors *page* instead — the
    // dedicated ▶ "已禁用" collapse below the main grid carries that
    // filter, while this popover keeps the toggle row visible so the user
    // can re-enable without leaving the conversation.
    const connected = snap.filter((c) => c.connected)
    if (connected.length === 0) {
      const empty = document.createElement('div')
      empty.style.padding = '14px 16px'
      empty.style.fontSize = '12px'
      empty.style.color = 'var(--dsw-color-text-tertiary, #999)'
      empty.textContent = this.t('connectorNotConnected')
      pop.appendChild(empty)
    } else {
      for (const row of connected) {
        const item = document.createElement('div')
        item.className = styles.dshConnectorPopoverItem ?? 'dshConnectorPopoverItem'
        const avatar = document.createElement('div')
        avatar.className = styles.dshConnectorPopoverAvatar ?? 'dshConnectorPopoverAvatar'
        if (row.iconUrl.length > 0) {
          const img = document.createElement('img')
          img.src = row.iconUrl
          img.alt = ''
          img.addEventListener('error', () => { img.style.display = 'none'; avatar.textContent = avatarFallback(row.name) })
          avatar.appendChild(img)
        } else {
          avatar.textContent = avatarFallback(row.name)
        }
        item.appendChild(avatar)
        const body = document.createElement('div')
        body.className = styles.dshConnectorPopoverBody ?? 'dshConnectorPopoverBody'
        const name = document.createElement('span')
        name.className = styles.dshConnectorPopoverName ?? 'dshConnectorPopoverName'
        name.textContent = row.name
        body.appendChild(name)
        // Row state has THREE independent axes: `connected` (OAuth granted),
        // `enabled` (user opted in for this conversation) and `configured`
        // (the connector's required params are filled). The popover
        // collapses the three into a single meta line:
        //   • disabled → 已关闭 · 本次对话不调用
        //   • enabled but not configured → ⚠ 未配置：<参数>
        //   • enabled + configured → 已启用 · 已授权
        const computeMeta = (): string => {
          const on = this.store.isConnectorEnabled(row.id)
          if (!on) return this.t('composerChipConnectorOff')
          const status = getConnectorConfigStatus(row.id, this.store.getConnectorParams(row.id))
          if (!status.configured && status.missingRequired.length > 0) {
            return this.t('connectorPopoverNeedParams').replace('{keys}', status.missingRequired.join(', '))
          }
          return this.t('composerChipConnectorOn')
        }
        const enabled = this.store.isConnectorEnabled(row.id)
        const meta = document.createElement('span')
        meta.className = styles.dshConnectorPopoverMeta ?? 'dshConnectorPopoverMeta'
        meta.textContent = computeMeta()
        body.appendChild(meta)
        item.appendChild(body)
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = styles.dshConnectorPopoverToggle ?? 'dshConnectorPopoverToggle'
        toggle.dataset.on = enabled ? 'true' : 'false'
        toggle.title = enabled ? this.t('composerChipConnectorOn') : this.t('composerChipConnectorOff')
        item.dataset.enabled = enabled ? 'true' : 'false'
        toggle.addEventListener('click', (event) => {
          event.stopPropagation()
          const next = !this.store.isConnectorEnabled(row.id)
          this.store.setConnectorEnabled(row.id, next)
          // The store update triggers renderConnectorPopover, so the
          // updated state below is overwritten within a tick. We still
          // patch in place to avoid a single-frame flicker between the
          // click and the re-render.
          toggle.dataset.on = next ? 'true' : 'false'
          toggle.title = next ? this.t('composerChipConnectorOn') : this.t('composerChipConnectorOff')
          item.dataset.enabled = next ? 'true' : 'false'
          meta.textContent = computeMeta()
        })
        item.appendChild(toggle)
        // Clicking the row body (not toggle) pulls the connector's content
        // into the composer. A connector the user switched off must NOT be
        // callable — that is the whole point of the switch.
        item.addEventListener('click', (event) => {
          if (event.target === toggle || toggle.contains(event.target as Node)) return
          if (!this.store.isConnectorEnabled(row.id)) {
            // Nudge instead of silently doing nothing.
            meta.textContent = this.t('composerChipConnectorOff')
            item.dataset.rejected = 'true'
            setTimeout(() => { item.removeAttribute('data-rejected') }, 900)
            return
          }
          if (this.anchor !== undefined) this.anchor.dataset.open = 'false'
          void (async () => {
            const snippet = await this.store.fetchConnectorSnippet(row.id)
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('dsh:connector-fill', {
                detail: { id: row.id, name: row.name, snippet },
              }))
            }
          })()
        })
        pop.appendChild(item)
      }
    }
    const manage = document.createElement('div')
    manage.className = styles.dshConnectorPopoverManage ?? 'dshConnectorPopoverManage'
    manage.textContent = `↗ ${this.t('composerManage')}`
    manage.addEventListener('click', () => {
      if (this.anchor !== undefined) this.anchor.dataset.open = 'false'
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dsh:open-marketplace-connectors', { detail: { tab: 'connectors' } }))
      }
    })
    pop.appendChild(manage)
  }

  dispose(): void {
    window.removeEventListener('dsh:invoke-expert', this.onExpert as EventListener)
    window.removeEventListener('dsh:invoke-skill', this.onSkill as EventListener)
    window.removeEventListener('dsh:connector-fill', this.onConnectorFill as EventListener)
    window.removeEventListener('dsh:open-marketplace-connectors', this.onManageConnectors as EventListener)
    window.removeEventListener('dsh:connector-toggle', this.onConnectorToggle as EventListener)
    this.storeUnsubscribe?.()
    this.storeUnsubscribe = undefined
    this.anchorDomObserver?.disconnect()
    this.anchorDomObserver = undefined
    this.unmountConnectorAnchor()
    this.unmountExpertChip()
    this.unmountHeroPickers()
    this.activeExpert = undefined
    this.clearBadge()
  }
}
