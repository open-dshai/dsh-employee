/**
 * Standalone dsh-css plugin for tsdown/rolldown.
 *
 * Intercepts .css/.module.css imports via resolveId+load hooks
 * and converts them to virtual JS modules that inject <style> tags.
 * This replicates the monorepo's internal `dsh-css` transform.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import crypto from 'node:crypto'

function hash6(str: string): string {
  return crypto.createHash('sha256').update(str).digest('base64url').slice(0, 6)
}

const pseudoClasses = new Set([
  'hover', 'focus', 'active', 'visited', 'link', 'disabled', 'enabled',
  'focus-visible', 'focus-within', 'checked', 'indeterminate', 'default',
  'valid', 'invalid', 'in-range', 'out-of-range', 'required', 'optional',
  'read-only', 'read-write', 'placeholder-shown', 'empty', 'target',
  'first-child', 'last-child', 'only-child', 'nth-child', 'nth-last-child',
  'first-of-type', 'last-of-type', 'only-of-type', 'nth-of-type', 'nth-last-of-type',
  'not', 'is', 'where', 'has', 'before', 'after', 'first-line', 'first-letter',
  'selection', 'placeholder', 'root', 'lang', 'dir', 'fullscreen', 'modal',
  'picture-in-picture', 'autofill',
])

function scopeCssModule(css: string, scopePath: string): { css: string; classMap: Record<string, string> } {
  const classMap: Record<string, string> = {}
  const usedHashes = new Map<string, string>()
  const classRegex = /(?<![-\w])\.([a-zA-Z_][\w-]*)(?![\w-])/g

  const scoped = css.replace(classRegex, (_m, name: string) => {
    if (pseudoClasses.has(name)) return _m
    if (!usedHashes.has(name)) {
      // A CSS ident cannot start with a digit — otherwise the generated
      // `.hash_name` selector is invalid and the whole rule is silently
      // dropped by the browser. base64url hashes can begin with 0-9, so
      // swap a leading digit for a letter to keep every class name legal.
      let hash = hash6(scopePath + name)
      if (hash[0] >= '0' && hash[0] <= '9') hash = `c${hash.slice(1)}`
      const scopedName = `${hash}_${name}`
      usedHashes.set(name, scopedName)
      classMap[name] = scopedName
    }
    return `.${usedHashes.get(name)!}`
  })

  return { css: scoped, classMap }
}

const VIRTUAL_PREFIX = '\0dsh-css:'
// Append .mjs to virtual IDs so rolldown treats them as JS, not CSS
// (rolldown v1 drops CSS bundling and errors on *.css IDs regardless of load() output)
const VIRTUAL_SUFFIX = '.mjs'

export function dshCssPlugin(packageName: string) {
  return {
    name: 'dsh-css',
    resolveId(source: string, importer: string | undefined): string | null {
      if (!importer) return null
      if (importer.includes('node_modules')) return null
      if (source.endsWith('.module.css') || source.endsWith('.css')) {
        const absPath = resolve(dirname(importer), source)
        return VIRTUAL_PREFIX + absPath + VIRTUAL_SUFFIX
      }
      return null
    },
    load(id: string): { code: string; map: null } | null {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null
      const filePath = id.slice(VIRTUAL_PREFIX.length, -VIRTUAL_SUFFIX.length)
      const raw = readFileSync(filePath, 'utf-8')
      const isModule = filePath.endsWith('.module.css')
      const cssFileName = basename(filePath)
      const tagId = `${packageName}/${cssFileName}`

      if (isModule) {
        const { css: scopedCss, classMap } = scopeCssModule(raw, `${packageName}:${filePath}`)
        const lines: string[] = [
          `const __css = ${JSON.stringify(scopedCss)};`,
          `const __tagId = ${JSON.stringify(tagId)};`,
          `if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css=' + JSON.stringify(__tagId) + ']') === null) {`,
          `  const __tag = document.createElement("style");`,
          `  __tag.dataset.plugin = ${JSON.stringify(packageName)};`,
          `  __tag.dataset.pluginCss = __tagId;`,
          `  __tag.textContent = __css;`,
          `  document.head.appendChild(__tag);`,
          `}`,
          `var __default = ${JSON.stringify(classMap)};`,
          `export default __default;`,
        ]
        return { code: lines.join('\n'), map: null }
      } else {
        const lines = [
          `const __css = ${JSON.stringify(raw)};`,
          `const __tagId = ${JSON.stringify(tagId)};`,
          `if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css=' + JSON.stringify(__tagId) + ']') === null) {`,
          `  const __tag = document.createElement("style");`,
          `  __tag.dataset.plugin = ${JSON.stringify(packageName)};`,
          `  __tag.dataset.pluginCss = __tagId;`,
          `  __tag.textContent = __css;`,
          `  document.head.appendChild(__tag);`,
          `}`,
        ]
        return { code: lines.join('\n'), map: null }
      }
    },
  }
}
