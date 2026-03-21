// Fink playground — Monaco editor + semantic tokens + WASI run pipeline.
//
// Tokenization: driven by the WASM lexer (ParsedDocument.get_tokens()) via
// FinkTokenizer, bypassing TM grammar + oniguruma entirely.
//
// Analysis (semantic tokens, diagnostics, go-to-def, references) uses the
// playground WASM crate loaded via dynamic import at runtime.
//
// Code execution uses the WASI shim (wasi-shim.ts) running in a sandboxed
// iframe. The compiler slot is a placeholder for now (see compiler.ts).

// MonacoEnvironment must be set before the editor creates its workers.
;(window as any).MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, _label: string): string {
    return new URL('./editor.worker.js', import.meta.url).href
  },
}

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import { compile } from './compiler.js'
import { run } from './wasi-shim.js'
import { FinkTokenizer, type LexToken } from './tokenizer.js'
import { TokensPanel } from './tokens-panel.js'
import { CpsPanel } from './cps-panel.js'
import { defineTheme } from './theme.js'

// ---------------------------------------------------------------------------
// Analysis WASM (semantic tokens, diagnostics)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParsedDocument: any = null

// Resolved once the WASM is ready. The semantic token provider awaits this
// so it doesn't race with the async WASM load on first page render.
let resolveWasmReady!: () => void
const wasmReady = new Promise<void>(resolve => { resolveWasmReady = resolve })

// Last parse result — shared between the syntactic tokenizer and the semantic
// tokens / diagnostics provider. Reparsed synchronously on every content change
// so the tokenizer cache is always up-to-date before Monaco asks for tokens.
let lastSemanticTokens: Uint32Array = new Uint32Array(0)
let lastDiagnostics: string = '[]'

function reparse(src: string, modelVersion: number): void {
  if (!ParsedDocument) return
  const t0 = performance.now()
  const doc = new ParsedDocument(src)
  const t1 = performance.now()
  lastSemanticTokens = doc.get_semantic_tokens()
  lastDiagnostics = doc.get_diagnostics()
  const rawTokensJson = doc.get_tokens()
  const highlightTokensJson = doc.get_highlight_tokens()
  const cpsJson = doc.get_cps()
  const cpsLiftedJson = doc.get_cps_lifted()
  doc.free()
  const t2 = performance.now()
  const highlightTokens: LexToken[] = JSON.parse(highlightTokensJson)
  tokenizer.update(highlightTokens, modelVersion, src)
  const rawTokens: LexToken[] = JSON.parse(rawTokensJson)
  tokensPanel?.update(rawTokens)
  cpsPanel?.update(cpsJson, ParsedDocument)
  cpsPanel?.updateSrcTokens(highlightTokens)
  cpsPanelLifted?.update(cpsLiftedJson, ParsedDocument)
  cpsPanelLifted?.updateSrcTokens(highlightTokens)
  const t3 = performance.now()
  console.log(`[fink] parse=${(t1-t0).toFixed(1)}ms get_tokens=${(t2-t1).toFixed(1)}ms tokenizer.update=${(t3-t2).toFixed(1)}ms total=${(t3-t0).toFixed(1)}ms src=${src.length}chars`)
}

async function loadAnalysisWasm(): Promise<void> {
  // Derive the base URL of this module so assets are found regardless of
  // where the playground is deployed.
  const base = new URL('.', import.meta.url).href
  console.log('[fink] loading analysis WASM from', base)

  console.log('[fink] fetching wasm binary...')
  const wasmBin = await fetch(`${base}fink_playground_wasm_bg.wasm`).then(r => {
    if (!r.ok) throw new Error(`fink_playground_wasm_bg.wasm: ${r.status}`)
    return r.arrayBuffer()
  })
  console.log('[fink] wasm binary fetched, size:', wasmBin.byteLength)

  console.log('[fink] importing glue module...')
  const mod = await import(/* @vite-ignore */ `${base}fink_playground_wasm.js`)
  console.log('[fink] glue module imported, calling init...')
  await mod.default(wasmBin)
  ParsedDocument = mod.ParsedDocument
  resolveWasmReady()
  console.log('[fink] analysis WASM ready')
}

// ---------------------------------------------------------------------------
// Language registration + tokenizer
// ---------------------------------------------------------------------------

monaco.languages.register({ id: 'fink', extensions: ['.fnk'] })

// Tokenizer is populated after each WASM parse (see semantic tokens provider).
const tokenizer = new FinkTokenizer()
tokenizer.register()

// Tokens panel — initialized after the editor is created (see below).
let tokensPanel: TokensPanel | null = null
// CPS panels — initialized after the editor is created (see below).
let cpsPanel: CpsPanel | null = null
let cpsPanelLifted: CpsPanel | null = null

monaco.languages.setLanguageConfiguration('fink', {
  comments: {
    lineComment: '#',
    blockComment: ['---', '---'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: "'", close: "'", notIn: ['string'] },
    { open: '---', close: '---', notIn: ['string', 'comment'] },
  ],
  autoCloseBefore: ';:.,=}])> \n\t',
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern: /^(\s*).*:\s*$/,
    decreaseIndentPattern: /^\s*$/,
  },
  onEnterRules: [
    // Increase indent after a line ending with ':'
    {
      beforeText: /:\s*$/,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    },
  ],
  folding: {
    offSide: true,
  },
})


// Semantic token legend must match TOKEN_* constants in vscode-fink/src/lib.rs
const TOKEN_TYPES = ['function', 'variable', 'property', 'block-name', 'tag-left', 'tag-right']
const TOKEN_MODIFIERS = ['readonly']

monaco.languages.registerDocumentSemanticTokensProvider('fink', {
  getLegend() {
    return { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS }
  },
  async provideDocumentSemanticTokens(model) {
    await wasmReady
    reparse(model.getValue(), model.getVersionId())
    const parsed = JSON.parse(lastDiagnostics) as Array<{
      line: number, col: number, endLine: number, endCol: number,
      message: string, source: string, severity: string
    }>
    monaco.editor.setModelMarkers(model, 'fink', parsed.map(d => ({
      startLineNumber: d.line + 1,
      startColumn: d.col + 1,
      endLineNumber: d.endLine + 1,
      endColumn: Math.max(d.endCol + 1, d.col + 2),
      message: d.message,
      severity: d.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : d.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
      source: d.source,
    })))
    return { data: lastSemanticTokens, resultId: undefined }
  },
  releaseDocumentSemanticTokens() {},
})

// ---------------------------------------------------------------------------
// Theme — reads colors from CSS variables (set by embedding page or dev wrapper)
// ---------------------------------------------------------------------------

defineTheme()

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const INITIAL_CODE = ``

const editorEl = document.getElementById('fink-editor')!
const editor = monaco.editor.create(editorEl, {
  value: INITIAL_CODE,
  language: 'fink',
  theme: 'fink-dark',
  fontSize: 14,
  fontFamily: '"Hack", "Consolas", "Menlo", monospace',
  minimap: { enabled: false },
  bracketPairColorization: { enabled: true },
  scrollBeyondLastLine: false,
  'semanticHighlighting.enabled': true,
  padding: { top: 16, bottom: 16 },
  lineNumbers: 'on',
  accessibilitySupport: 'off',
  tabSize: 2,
  insertSpaces: true,
  detectIndentation: false,
  automaticLayout: true,
})

// Reparse synchronously on every content change so the tokenizer cache is
// updated before Monaco asks for syntactic tokens on the next frame.
editor.onDidChangeModelContent(() => {
  const model = editor.getModel()
  if (!model) return
  reparse(model.getValue(), model.getVersionId())
})

// ---------------------------------------------------------------------------
// Right pane — tabbed panel (Tokens, Output, …)
// ---------------------------------------------------------------------------

// Tab switching
for (const tab of document.querySelectorAll<HTMLElement>('.fink-tab')) {
  tab.addEventListener('click', () => {
    document.querySelector('.fink-tab.active')?.classList.remove('active')
    document.querySelector('.fink-tab-panel.active')?.classList.remove('active')
    tab.classList.add('active')
    document.getElementById(tab.dataset.tab!)?.classList.add('active')
    if (tab.dataset.tab === 'fink-cps') cpsPanel?.layout()
    if (tab.dataset.tab === 'fink-cps-lifted') cpsPanelLifted?.layout()
  })
}

// Tokens panel — pill view with bidirectional cursor sync
tokensPanel = new TokensPanel(
  document.getElementById('fink-tokens')!,
  editor,
)

// CPS panel — read-only Monaco editor with sourcemap-based cursor sync
cpsPanel = new CpsPanel(
  document.getElementById('fink-cps')!,
  editor,
)

// Lifted CPS panel — CPS after cont_lifting + closure_lifting
cpsPanelLifted = new CpsPanel(
  document.getElementById('fink-cps-lifted')!,
  editor,
)

// When a CPS panel becomes active, clear token decoration and the other CPS panel.
cpsPanel.onActivate = () => { tokensPanel.clearEditorHighlight(); cpsPanelLifted?.clearAll() }
cpsPanelLifted.onActivate = () => { tokensPanel.clearEditorHighlight(); cpsPanel?.clearAll() }
// When one CPS panel highlights into the source editor, clear the other's src highlight.
cpsPanel.onWillHighlightSrc = () => cpsPanelLifted?.clearSrcHighlight()
cpsPanelLifted.onWillHighlightSrc = () => cpsPanel?.clearSrcHighlight()

editor.onDidFocusEditorText(() => {
  tokensPanel.clearEditorHighlight()
  cpsPanel?.clearAll()
  cpsPanelLifted?.clearAll()
  cpsPanelLifted?.clearSrcHighlight()
  cpsPanel?.syncFromSource(
    editor.getPosition()!.lineNumber - 1,
    editor.getPosition()!.column - 1,
  )
  cpsPanelLifted?.syncFromSource(
    editor.getPosition()!.lineNumber - 1,
    editor.getPosition()!.column - 1,
  )
})

editor.onDidChangeCursorPosition(e => {
  tokensPanel.clearEditorHighlight()
  cpsPanel?.clearSrcHighlight()
  cpsPanelLifted?.clearSrcHighlight()
  tokensPanel.highlightAtPosition(
    e.position.lineNumber - 1,
    e.position.column - 1,
  )
  cpsPanel?.syncFromSource(
    e.position.lineNumber - 1,
    e.position.column - 1,
  )
  cpsPanelLifted?.syncFromSource(
    e.position.lineNumber - 1,
    e.position.column - 1,
  )
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const runBtn = document.getElementById('fink-run-btn') as HTMLButtonElement
const outputEl = document.getElementById('fink-output')!

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true
  outputEl.textContent = '…'
  outputEl.className = 'running'

  try {
    const src = editor.getValue()
    const wasm = await compile(src)
    if (!wasm) {
      outputEl.textContent = 'Compiler not available yet.'
      outputEl.className = 'error'
      return
    }
    const result = await run(wasm)

    const text = result.stdout + result.stderr
    outputEl.textContent = text || '(no output)'
    outputEl.className = result.exitCode === 0 ? 'ok' : 'error'
  } catch (err) {
    outputEl.textContent = `Error: ${err}`
    outputEl.className = 'error'
  } finally {
    runBtn.disabled = false
  }
})

// ---------------------------------------------------------------------------
// URL hash — shareable source links
//
// Encoding: UTF-8 → deflate-raw (CompressionStream) → base62
// Alphabet:  0-9 a-z A-Z  (URL-safe, no special chars)
// Hash format: #<base62data>  (bare, no key prefix)
// ---------------------------------------------------------------------------

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

async function encodeSource(src: string): Promise<string> {
  const bytes = new TextEncoder().encode(src)
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  writer.write(bytes)
  writer.close()
  const buf = await new Response(cs.readable).arrayBuffer()
  const u8 = new Uint8Array(buf)

  // Treat compressed bytes as big-endian integer, encode in base62.
  // Use BigInt to avoid precision loss on large payloads.
  let n = 0n
  for (const b of u8) n = (n << 8n) | BigInt(b)

  if (n === 0n) return BASE62[0]
  let out = ''
  const base = 62n
  while (n > 0n) {
    out = BASE62[Number(n % base)] + out
    n /= base
  }
  // Preserve leading zero-bytes as leading '0' digits.
  for (let i = 0; i < u8.length && u8[i] === 0; i++) out = BASE62[0] + out
  return out
}

async function decodeSource(encoded: string): Promise<string> {
  // base62 → BigInt → bytes
  let n = 0n
  const base = 62n
  for (const ch of encoded) {
    const v = BASE62.indexOf(ch)
    if (v < 0) throw new Error(`Invalid base62 char: ${ch}`)
    n = n * base + BigInt(v)
  }

  // Convert BigInt to Uint8Array (big-endian).
  const hex = n.toString(16).padStart(2, '0')
  const padded = hex.length % 2 ? '0' + hex : hex
  const bytes = new Uint8Array(padded.length / 2)
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)

  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  writer.write(bytes)
  writer.close()
  const buf = await new Response(ds.readable).arrayBuffer()
  return new TextDecoder().decode(buf)
}

// On load: restore source from hash if present.
const initialHash = location.hash.slice(1)
if (initialHash) {
  decodeSource(initialHash)
    .then(src => editor.setValue(src))
    .catch(err => console.warn('[fink] Failed to decode URL hash:', err))
}

// Share button: encode current source → update hash → copy URL to clipboard.
const shareBtn = document.getElementById('fink-share-btn') as HTMLButtonElement
shareBtn.addEventListener('click', async () => {
  const encoded = await encodeSource(editor.getValue())
  history.replaceState(null, '', '#' + encoded)
  await navigator.clipboard.writeText(location.href)
  shareBtn.textContent = '✓ Copied'
  shareBtn.classList.add('copied')
  setTimeout(() => {
    shareBtn.textContent = 'Share'
    shareBtn.classList.remove('copied')
  }, 2000)
})

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadAnalysisWasm().catch(err => {
  console.error('Analysis WASM failed to load — semantic tokens disabled:', err)
})
