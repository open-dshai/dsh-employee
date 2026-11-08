import { defineConfig } from 'tsdown'
import { dshCssPlugin } from './tsdown.css-plugin.ts'
import { dshClientModulePlugin } from './tsdown.client-plugin.ts'

const PKG = '@deepseek-ai/dsh-employee-marketplace'

export default defineConfig([
  // Node entry (host-side): registers install/uninstall routes. ESM format.
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    target: 'es2022',
    outDir: 'lib',
    dts: true,
    sourcemap: true,
    plugins: [dshCssPlugin(PKG)],
    external: [
      /^@deepseek-ai\//,
      /^node:/,
      'react',
      'react-dom',
      'react/jsx-runtime',
    ],
  },
  // Client entry (browser): loaded by dsh web's __ModuleLoader__.
  // Must be CJS wrapped in window.__ModuleLoader__.load({ id, factory: (require) => {...} }),
  // matching the format used by all official dsh client plugins.
  {
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    target: 'es2022',
    outDir: 'lib',
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    sourcemap: false,
    plugins: [dshCssPlugin(PKG), dshClientModulePlugin(PKG)],
    external: [
      /^@deepseek-ai\//,
      'react',
      'react-dom',
      'react/jsx-runtime',
    ],
  },
])
