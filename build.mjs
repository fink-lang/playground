// Build script for the Fink playground.
//
// Outputs to build/ (self-contained static bundle).
//
// Steps:
//   1. Bundle node_modules Monaco worker → editor.worker.js  (iife)
//   2. Bundle src/main.ts → playground.js  (esm)
//   3. Copy Monaco CSS + codicon font (fix relative font path)
//   4. Copy TM grammar assets (onig.wasm + fink.tmLanguage.json)
//      Grammar is sourced from src/fink.tmLanguage.json and transformed:
//        - Remove top-level include of source.jsx.fink (no JSX support needed)
//        - Replace all "include": "source.fink" self-references with "$self"
//          (avoids re-entrant grammar loads in vscode-textmate)
//        - Strip meta.scope-example.* rules (grammar documentation scaffolding
//          with empty begin/while patterns that cause infinite recursion)
//   5. Copy analysis WASM files from lib/ (fink_wasm.js + fink_wasm_bg.wasm)
//   6. Copy src/index.html

import * as esbuild from 'esbuild'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const OUT = 'build'

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync('lib', { recursive: true })

// ---------------------------------------------------------------------------
// 0. Build Rust WASM crate → lib/
// ---------------------------------------------------------------------------

execSync('wasm-pack build --target web', { cwd: 'crate', stdio: 'inherit' })
for (const file of ['fink_playground_wasm.js', 'fink_playground_wasm_bg.wasm', 'fink_playground_wasm.d.ts']) {
  fs.copyFileSync(`crate/pkg/${file}`, `lib/${file}`)
}
console.log('  built crate → lib/')

// ---------------------------------------------------------------------------
// 1. Monaco editor worker (iife — workers don't use ES modules by default)
// ---------------------------------------------------------------------------

await esbuild.build({
  entryPoints: ['node_modules/monaco-editor/esm/vs/editor/editor.worker.js'],
  bundle: true,
  format: 'iife',
  outfile: `${OUT}/editor.worker.js`,
  minify: true,
})
console.log('  bundled editor.worker.js')

// ---------------------------------------------------------------------------
// 2. Main playground bundle (esm — keeps import.meta.url for asset URLs)
// ---------------------------------------------------------------------------

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  outfile: `${OUT}/playground.js`,
  loader: {
    '.ttf': 'file',
  },
  // monaco-textmate uses Node's 'path' only for a debug basename call.
  alias: { path: './src/path-stub.js' },
  minify: false, // keep readable during development
})
console.log('  bundled playground.js')

// ---------------------------------------------------------------------------
// 3. Monaco CSS + codicon font
// ---------------------------------------------------------------------------

const monacoDir = path.dirname(require.resolve('monaco-editor/package.json'))
const cssPath = path.join(monacoDir, 'min/vs/editor/editor.main.css')
const codiconPath = path.join(
  monacoDir,
  'min/vs/base/browser/ui/codicons/codicon/codicon.ttf',
)

let css = fs.readFileSync(cssPath, 'utf8')

if (fs.existsSync(codiconPath)) {
  fs.copyFileSync(codiconPath, `${OUT}/codicon.ttf`)
  // Rewrite the relative font URL in the CSS to a flat same-directory path.
  css = css.replace(/url\([^)]*codicon\.ttf[^)]*\)/g, 'url(./codicon.ttf)')
  console.log('  copied codicon.ttf')
}

fs.writeFileSync(`${OUT}/monaco.css`, css)
console.log('  copied monaco.css')

// ---------------------------------------------------------------------------
// 4. TM grammar assets (onig.wasm + fink.tmLanguage.json)
// ---------------------------------------------------------------------------

const onigWasmSrc = path.join(
  path.dirname(require.resolve('vscode-oniguruma/package.json')),
  'release/onig.wasm',
)
fs.copyFileSync(onigWasmSrc, `${OUT}/onig.wasm`)
console.log('  copied onig.wasm')

{
  const grammarSrc = path.resolve('src', 'fink.tmLanguage.json')
  const grammar = JSON.parse(fs.readFileSync(grammarSrc, 'utf8'))

  // 1. Remove top-level source.jsx.fink include
  if (grammar.patterns) {
    grammar.patterns = grammar.patterns.filter(
      p => p.include !== 'source.jsx.fink',
    )
  }

  // 2. Walk the entire grammar tree and apply transforms to every node
  function transformNode(node) {
    if (Array.isArray(node)) {
      return node
        .filter(item => {
          // Strip meta.scope-example.* rules
          const name = item.name ?? item.scopeName
          return !name?.startsWith('meta.scope-example.')
        })
        .map(transformNode)
    }
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) {
        if (k === 'include' && v === 'source.fink') {
          out[k] = '$self'
        } else if (k === 'patterns' || k === 'repository' || k === 'captures' || k === 'beginCaptures' || k === 'endCaptures') {
          out[k] = transformNode(v)
        } else {
          out[k] = (v && typeof v === 'object') ? transformNode(v) : v
        }
      }
      return out
    }
    return node
  }

  const transformed = transformNode(grammar)
  fs.writeFileSync(`${OUT}/fink.tmLanguage.json`, JSON.stringify(transformed))
  console.log('  transformed + wrote fink.tmLanguage.json')
}

// ---------------------------------------------------------------------------
// 5. Analysis WASM (fink_wasm.js + fink_wasm_bg.wasm)
//    Served as plain static files; loaded at runtime via fetch + dynamic import.
// ---------------------------------------------------------------------------

for (const file of ['fink_playground_wasm.js', 'fink_playground_wasm_bg.wasm']) {
  const src = path.join('lib', file)
  if (!fs.existsSync(src)) {
    console.warn(`  WARNING: ${src} not found — semantic tokens will be disabled`)
    continue
  }
  fs.copyFileSync(src, `${OUT}/${file}`)
  console.log(`  copied lib/${file}`)
}

// ---------------------------------------------------------------------------
// 6. index.html
// ---------------------------------------------------------------------------

fs.copyFileSync('src/index.html', `${OUT}/index.html`)
console.log('  copied src/index.html')

console.log(`\nPlayground → ${OUT}/`)
