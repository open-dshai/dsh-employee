/**
 * Rolldown plugin that wraps the client entry CJS bundle into the dsh
 * __ModuleLoader__ format expected by the dsh web host.
 *
 * When the client bundle is built as CJS (format: 'cjs'), rolldown already
 * converts `import` → `require` and `export` → `module.exports`. All we need
 * to do is wrap the output in:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<pkg>",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       // ... CJS bundle code ...
 *       return module.exports;
 *     }
 *   });
 */
export function dshClientModulePlugin(packageName: string) {
  return {
    name: 'dsh-client-module',
    renderChunk(code: string, chunk: { isEntry: boolean; name: string }) {
      if (!chunk.isEntry || chunk.name !== 'client') return null

      // Indent every line by two tabs for the factory function body
      const indented = code
        .split('\n')
        .map(line => '\t\t' + line)
        .join('\n')

      const wrapped = [
        `window.__ModuleLoader__.load({`,
        `\tid: ${JSON.stringify(packageName)},`,
        `\tfactory: (require) => {`,
        `\t\tvar module = { exports: {} };`,
        `\t\tvar exports = module.exports;`,
        `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
        indented,
        `\t\treturn module.exports;`,
        `\t}`,
        `});`,
      ].join('\n')

      return { code: wrapped, map: null }
    },
  }
}
