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
//   5. Copy analysis WASM files from crate/pkg/ (fink_wasm.js + fink_wasm_bg.wasm)
//   6. Copy src/index.html

import * as esbuild from 'esbuild'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const prod = process.env.NODE_ENV === 'production'

const require = createRequire(import.meta.url)
const OUT = 'build'

fs.mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// 0. Build Rust WASM crate → crate/pkg/
// ---------------------------------------------------------------------------

execSync('wasm-pack build --target web', { cwd: 'crate', stdio: 'inherit' })
console.log('  built crate → crate/pkg/')

// ---------------------------------------------------------------------------
// 0a. Vendor fink.js host shim from the linked fink source.
//     Resolves the fink package's manifest path via `cargo metadata` and
//     copies src/runtime/interop/js/fink.js next to src/main.ts so esbuild
//     can bundle it. Always pulls from the version pinned by Cargo.toml,
//     no risk of vendored drift.
// ---------------------------------------------------------------------------

{
  const meta = JSON.parse(execSync('cargo metadata --format-version 1', {
    cwd: 'crate',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString())
  const finkPkg = meta.packages.find((p) => p.name === 'fink')
  if (!finkPkg) throw new Error('cargo metadata: fink package not found')
  const finkRoot = path.dirname(finkPkg.manifest_path)
  const finkJsSrc = path.join(finkRoot, 'src/runtime/interop/js/fink.js')
  if (!fs.existsSync(finkJsSrc)) throw new Error(`fink.js not found at ${finkJsSrc}`)
  fs.copyFileSync(finkJsSrc, 'src/fink.js')
  console.log(`  vendored fink.js from ${finkRoot}`)
}

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
  minify: prod,
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
// 4. Analysis WASM (fink_playground_wasm.js + fink_playground_wasm_bg.wasm)
//    Served as plain static files; loaded at runtime via fetch + dynamic import.
// ---------------------------------------------------------------------------

for (const file of ['fink_playground_wasm.js', 'fink_playground_wasm_bg.wasm']) {
  const src = path.join('crate/pkg', file)
  if (!fs.existsSync(src)) {
    console.warn(`  WARNING: ${src} not found — semantic tokens will be disabled`)
    continue
  }
  fs.copyFileSync(src, `${OUT}/${file}`)
  console.log(`  copied crate/pkg/${file}`)
}

// ---------------------------------------------------------------------------
// 6. fragment.html (embeddable artifact) + index.html (dev wrapper)
// ---------------------------------------------------------------------------

fs.copyFileSync('src/fragment.html', `${OUT}/fragment.html`)
console.log('  copied src/fragment.html')

fs.copyFileSync('src/index.html', `${OUT}/index.html`)
console.log('  copied src/index.html')

console.log(`\nPlayground → ${OUT}/`)
