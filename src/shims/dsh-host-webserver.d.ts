/**
 * Shim for @deepseek-ai/dsh-host-webserver — a monorepo-internal package
 * that provides webServer Context augmentation. The plugin only uses it
 * as a type-level import to carry the Context merge; at runtime the
 * host injects the actual types.
 */
declare module '@deepseek-ai/dsh-host-webserver' {
  import type { Context } from '@deepseek-ai/cordis'
  // The plugin only needs the Context merge for type-checking; the actual
  // runtime module is provided by the dsh host when the plugin loads.
  export {}
}
