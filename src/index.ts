/**
 * Package root — the node half of the cordis plugin. The empty apply exists
 * so the plugin appears in the host cordis.yml / Loader; the browser half
 * ships the Marketplace sidebar entry + center panel through exports["./client"],
 * discovered from the package.json dsh.client declaration.
 */
/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}

export type { MarketplaceState, MarketplaceStore, MarketplaceTab } from './client/store.ts'
export type { MarketplaceKey } from './client/locales.ts'
