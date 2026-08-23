/**
 * Marketplace panel controller: minimal subscribe/getSnapshot store
 * mirroring the sibling pattern (BoardController). Tracks whether the
 * marketplace panel is currently taking over the center column.
 *
 * Activation uses the shared `dsh-panel-activate` custom event so the
 * task-board, ssh, and marketplace panels are single-occupant: opening
 * one closes the others.
 */
type Listener = () => void

export interface MarketplaceSnapshot {
  readonly panelOpen: boolean
}

export class MarketplaceController {
  private _panelOpen = false
  private readonly _listeners = new Set<Listener>()

  getSnapshot(): MarketplaceSnapshot {
    return { panelOpen: this._panelOpen }
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener)
    return () => { this._listeners.delete(listener) }
  }

  private _notify(): void {
    for (const listener of [...this._listeners]) {
      try { listener() } catch { /* swallow listener errors */ }
    }
  }

  /** Open the panel (closing sibling panels via the cross-plugin event).
 *  Optionally jump straight to a tab — used by the composer connector
 *  popover's "管理连接器" affordance. */
  openPanel(tab?: 'experts' | 'skills' | 'connectors'): void {
    if (this._panelOpen) {
      if (tab !== undefined) this._defaultTab = tab
      return
    }
    this._panelOpen = true
    this._defaultTab = tab ?? 'experts'
    document.documentElement.setAttribute('data-dsh-marketplace-active', '')
    document.documentElement.removeAttribute('data-dsh-taskboard-active')
    document.documentElement.removeAttribute('data-dsh-ssh-active')
    document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'marketplace' }))
    this._notify()
  }

  /** Tab to show on the next `openPanel`. Read by `MarketplacePanel`. */
  private _defaultTab: 'experts' | 'skills' | 'connectors' = 'experts'
  getDefaultTab(): 'experts' | 'skills' | 'connectors' { return this._defaultTab }
  resetDefaultTab(): void { this._defaultTab = 'experts' }

  /** Close the panel. */
  closePanel(): void {
    if (!this._panelOpen) return
    this._panelOpen = false
    document.documentElement.removeAttribute('data-dsh-marketplace-active')
    this._notify()
  }

  /** Toggle the panel; closes on second click. */
  togglePanel(): void {
    if (this._panelOpen) this.closePanel()
    else this.openPanel()
  }

  /** When another panel activates, close this one. */
  onOtherPanelActivate(otherName: string): void {
    if (otherName !== 'marketplace' && this._panelOpen) {
      this.closePanel()
    }
  }

  dispose(): void {
    this._listeners.clear()
    document.documentElement.removeAttribute('data-dsh-marketplace-active')
  }
}