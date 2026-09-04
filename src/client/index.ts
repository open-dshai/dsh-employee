/**
 * Marketplace plugin entry — the browser half of the cordis bundle.
 *
 * The plugin surfaces three catalogs (experts / skills / connectors, fetched
 * from skill.dualpaw.com through the plugin's own CORS relay in api.ts) as a
 * sidebar entry + center-column panel, mirroring the sibling family
 * (task-board, ssh, 技能中心). The store is fully self-contained — no host
 * gateway or slot changes are required:
 *
 *  • a sidebar entry row is DOM-injected below 技能中心
 *    (sidebar-entry.ts → sidebar-entry-core.ts);
 *  • a React panel takes over the center column when the entry is toggled
 *    (panel-mount.tsx → MarketplacePanel.tsx), single-occupant with the
 *    sibling panels via the `dsh-panel-activate` event;
 *  • an invocation bridge listens for the `dsh:invoke-expert` /
 *    `dsh:invoke-skill` / `dsh:connector-fill` window events the
 *    list/detail components emit. It pre-fills the composer, shows a
 *    "当前专家 / 当前技能" badge, and injects a 🔌 chip next to the
 *    composer that pops up a per-connector toggle popover anchored above
 *    the textarea (invoke.ts).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { MarketplaceStore } from './store.ts'

/** Plugin identity — matches the `id` in cordis.patch.yml. */
export const name = 'ui-marketplace'
import { MarketplaceController } from './MarketplaceController.ts'
import { InvocationBridge } from './invoke.ts'
import { mountMarketplaceEntry } from './sidebar-entry.ts'
import { mountMarketplacePanel } from './panel-mount.tsx'
import { en, zh, type MarketplaceKey } from './locales.ts'

export type { MarketplaceState, MarketplaceStore, MarketplaceTab } from './store.ts'
export type { MarketplaceKey } from './locales.ts'
export type { MarketplaceController, MarketplaceSnapshot } from './MarketplaceController.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Marketplace panel copy. */
    'marketplace': MarketplaceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'marketplace'

/**
 * The plugin declares only the locale capability (the sidebar entry and
 * center panel are DOM-injected; no host slot is consumed).
 */
export const inject = ['locale']

/**
 * Register the marketplace sidebar entry, center-column panel, and
 * invocation bridge. Each mount returns a disposer tracked as a cordis
 * effect so the whole surface is torn down with the plugin.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-marketplace: copy dictionaries')

  const store = new MarketplaceStore()
  const panel = new MarketplaceController()
  const t = ctx.locale.bind(NS)

  ctx.effect(() => mountMarketplaceEntry(panel, t), 'ui-marketplace: sidebar entry')
  ctx.effect(() => mountMarketplacePanel(panel, store, t), 'ui-marketplace: center panel')
  ctx.effect(() => {
    const bridge = new InvocationBridge(panel, store, t)
    return () => { bridge.dispose() }
  }, 'ui-marketplace: invocation bridge')
}
