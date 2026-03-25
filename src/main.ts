// Fink playground — Monaco editor + semantic tokens + WASI run pipeline.
//
// Tokenization: driven by the WASM lexer (ParsedDocument.get_tokens()) via
// FinkTokenizer, bypassing TM grammar + oniguruma entirely.
//
// Analysis (semantic tokens, diagnostics, go-to-def, references) uses the
// playground WASM crate loaded via dynamic import at runtime.
//
// Code execution: compile(src) → WASM binary via the playground crate's
// compile() export, then run in a sandboxed WASI iframe (wasi-shim.ts).

// MonacoEnvironment must be set before the editor creates its workers.
;(window as any).MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, _label: string): string {
    return new URL('./editor.worker.js', import.meta.url).href
  },
}

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
// Contributions — each registers its commands/keybindings when imported.
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js'   // move/duplicate/delete line
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js'     // word jump + select
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js'               // Cmd+F, Cmd+H, Cmd+D
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js'           // Cmd+D multi-select
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js'                   // code folding
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js'                   // Cmd+/ toggle comment
import 'monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js'           // re-indent commands
import 'monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js'           // expand/shrink selection
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js'   // bracket highlight + jump
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/highlightDecorations.js' // highlight word occurrences
import 'monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js'   // transpose chars
import 'monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js'             // cursor stack undo
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js'           // hover tooltips (diagnostics, symbols)
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js'           // go-to-definition (F12 / Cmd+click)
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js' // Ctrl/Cmd+click inline
import { compile, setCompileModule } from './compiler.js'
import { run } from './wasi-shim.js'
import { FinkTokenizer, type LexToken } from './tokenizer.js'
import { TokensPanel } from './tokens-panel.js'
import { AstPanel } from './ast-panel.js'
import { CpsPanel } from './cps-panel.js'
import { defineTheme, watchColorScheme } from './theme.js'

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
let lastParseMs = 0

// Last ParsedDocument kept alive for cursor-time queries (go-to-def, references).
// Freed and replaced on every successful re-parse.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastDoc: any = null

// Forward declaration — defined after the editor is created (needs DOM + editor).
let applyDiagnosticToggles: () => void = () => {}

let lastReparsedHash = ''

function srcHash(src: string): string {
  let h = 5381
  for (let i = 0; i < src.length; i++) h = (h * 33 ^ src.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function reparse(src: string, _modelVersion: number): void {
  if (!ParsedDocument) return
  const hash = srcHash(src)
  if (hash === lastReparsedHash) return
  lastReparsedHash = hash
  try {
    _reparse(src, _modelVersion)
  } catch (e) {
    console.error('[fink] reparse crashed:', e)
    // Reset hash so the next edit retries
    lastReparsedHash = ''
  }
}

function _reparse(src: string, _modelVersion: number): void {
  const t0 = performance.now()
  // Parse + lex (always safe).
  let doc = new ParsedDocument(src)
  const t1 = performance.now()
  lastSemanticTokens = doc.get_semantic_tokens()
  lastDiagnostics = doc.get_diagnostics()
  const rawTokensJson = doc.get_tokens()
  const highlightTokensJson = doc.get_highlight_tokens()
  const astJson = doc.get_ast()
  // CPS + name resolution — run separately so a crash doesn't lose
  // lexer tokens, AST, or semantic tokens.  A wasm trap poisons the
  // wasm-bindgen handle, so on failure we free & recreate the doc to
  // keep the handle healthy for future calls.
  let cpsJson = ''
  let cpsLiftedJson = ''
  try {
    doc.run_analysis()
    lastDiagnostics = doc.get_diagnostics()
    cpsJson = doc.get_cps()
    cpsLiftedJson = doc.get_cps_lifted()
    // Keep doc alive for cursor-time queries (go-to-def, references).
    if (lastDoc) try { lastDoc.free() } catch (_) { /* already freed */ }
    lastDoc = doc
  } catch (e) {
    console.warn('[fink] CPS analysis crashed (name resolution disabled):', e)
    try { doc.free() } catch (_) { /* handle already poisoned */ }
  }
  const t2 = performance.now()
  const highlightTokens: LexToken[] = JSON.parse(highlightTokensJson)
  tokenizer.update(highlightTokens, _modelVersion, src)
  const rawTokens: LexToken[] = JSON.parse(rawTokensJson)
  tokensPanel?.update(rawTokens)
  astPanel?.update(astJson, lastDiagnostics)
  cpsPanel?.update(cpsJson, ParsedDocument)
  cpsPanel?.updateSrcTokens(highlightTokens)
  cpsPanelLifted?.update(cpsLiftedJson, ParsedDocument)
  cpsPanelLifted?.updateSrcTokens(highlightTokens)
  const t3 = performance.now()
  lastParseMs = t1 - t0
  statusParseEl?.updateTime(lastParseMs)
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
  setCompileModule(mod)
  resolveWasmReady()
  console.log('[fink] analysis WASM ready')

  // If a URL-decoded source is waiting, inject it now that WASM is ready.
  // Setting the value here ensures reparse() runs on the first content change
  // with ParsedDocument available, so highlighting works immediately.
  if (pendingSource !== null) {
    editor.updateOptions({ readOnly: false })
    editor.setValue(pendingSource)
    pendingSource = null
  }
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
// AST panel — initialized after the editor is created (see below).
let astPanel: AstPanel | null = null
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
    const src = model.getValue()
    reparse(src, model.getVersionId())
    if (src.trim()) applyDiagnosticToggles()
    else monaco.editor.setModelMarkers(model, 'fink', [])
    return { data: lastSemanticTokens, resultId: undefined }
  },
  releaseDocumentSemanticTokens() {},
})

// Definition provider — delegates to the WASM ParsedDocument kept alive across
// re-parses. Requires run_analysis() to have succeeded (name resolution).
monaco.languages.registerDefinitionProvider('fink', {
  provideDefinition(model, position) {
    if (!lastDoc) return undefined
    // Monaco positions are 1-based; WASM API is 0-based.
    const data: Uint32Array = lastDoc.get_definition(
      position.lineNumber - 1,
      position.column - 1,
    )
    if (data.length !== 4) return undefined
    return {
      uri: model.uri,
      range: new monaco.Range(
        data[0] + 1, data[1] + 1,
        data[2] + 1, data[3] + 1,
      ),
    }
  },
})

// ---------------------------------------------------------------------------
// Theme — reads colors from CSS variables (set by embedding page or dev wrapper)
// ---------------------------------------------------------------------------

defineTheme()
watchColorScheme()

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const INITIAL_CODE = ``

const editorEl = document.getElementById('fink-editor')!
const editor = monaco.editor.create(editorEl, {
  value: INITIAL_CODE,
  language: 'fink',
  theme: 'fink',
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

// Explicitly bind Alt+Up/Down (move line) and Alt+Left/Right (word jump)
// so macOS/browser doesn't intercept them before Monaco sees them.
editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow,
  () => editor.trigger('keyboard', 'editor.action.moveLinesUpAction', null))
editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow,
  () => editor.trigger('keyboard', 'editor.action.moveLinesDownAction', null))
editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow,
  () => editor.trigger('keyboard', 'cursorWordStartLeft', null))
editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow,
  () => editor.trigger('keyboard', 'cursorWordEndRight', null))

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

const statusPosEl = document.getElementById('fink-status-pos')!
const statusParseEl = {
  el: document.getElementById('fink-status-parse')!,
  updateTime(ms: number) { this.el.textContent = `parse ${ms.toFixed(1)}ms` },
}

editor.onDidChangeCursorPosition(e => {
  statusPosEl.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`
})

// Diagnostic toggle state
let showErrors = true
let showWarnings = true

const errBtn = document.getElementById('fink-toggle-errors') as HTMLButtonElement
const warnBtn = document.getElementById('fink-toggle-warnings') as HTMLButtonElement

applyDiagnosticToggles = function(): void {
  const model = editor.getModel()
  if (!model) return
  const all = JSON.parse(lastDiagnostics) as Array<{
    line: number, col: number, endLine: number, endCol: number,
    message: string, source: string, severity: string
  }>
  const filtered = all.filter(d =>
    (d.severity === 'error' && showErrors) ||
    (d.severity === 'warning' && showWarnings) ||
    (d.severity !== 'error' && d.severity !== 'warning')
  )
  monaco.editor.setModelMarkers(model, 'fink', filtered.map(d => ({
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

  // Update button counts
  const errorCount = all.filter(d => d.severity === 'error').length
  const warnCount  = all.filter(d => d.severity === 'warning').length
  errBtn.textContent  = `${errorCount} Error${errorCount !== 1 ? 's' : ''}`
  warnBtn.textContent = `${warnCount} Warning${warnCount !== 1 ? 's' : ''}`
  errBtn.classList.toggle('active', showErrors)
  warnBtn.classList.toggle('active', showWarnings)
}

errBtn.addEventListener('click', () => {
  showErrors = !showErrors
  applyDiagnosticToggles()
})
warnBtn.addEventListener('click', () => {
  showWarnings = !showWarnings
  applyDiagnosticToggles()
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

// Tabs that participate in bidirectional cursor sync.
const SYNC_TABS = new Set(['fink-tokens', 'fink-ast', 'fink-cps', 'fink-cps-lifted'])

// Currently active tab id — used to gate cursor sync.
let activeTab = 'fink-run-panel'

function clearAllDecorations(): void {
  tokensPanel?.clearEditorHighlight()
  astPanel?.clearEditorHighlight()
  cpsPanel?.clearAll()
  cpsPanelLifted?.clearAll()
}

// Tab switching
for (const tab of document.querySelectorAll<HTMLElement>('.fink-tab')) {
  tab.addEventListener('click', () => {
    document.querySelector('.fink-tab.active')?.classList.remove('active')
    document.querySelector('.fink-tab-panel.active')?.classList.remove('active')
    tab.classList.add('active')
    document.getElementById(tab.dataset.tab!)?.classList.add('active')
    activeTab = tab.dataset.tab!
    if (activeTab === 'fink-cps') cpsPanel?.layout()
    if (activeTab === 'fink-cps-lifted') cpsPanelLifted?.layout()
    if (!SYNC_TABS.has(activeTab)) {
      // Passive tab (e.g. Output) — clear all decorations and stop syncing.
      clearAllDecorations()
    } else {
      // Sync tab activated — sync to current cursor position.
      clearAllDecorations()
      const pos = editor.getPosition()
      if (pos) {
        const line = pos.lineNumber - 1
        const col = pos.column - 1
        if (activeTab === 'fink-tokens') tokensPanel?.highlightAtPosition(line, col)
        if (activeTab === 'fink-ast') astPanel?.highlightAtPosition(line, col)
        if (activeTab === 'fink-cps') cpsPanel?.syncFromSource(line, col)
        if (activeTab === 'fink-cps-lifted') cpsPanelLifted?.syncFromSource(line, col)
      }
    }
  })
}

// Tokens panel — pill view with bidirectional cursor sync
tokensPanel = new TokensPanel(
  document.getElementById('fink-tokens')!,
  editor,
)

// AST panel — indented tree with bidirectional cursor sync
astPanel = new AstPanel(
  document.getElementById('fink-ast')!,
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
  if (!SYNC_TABS.has(activeTab)) return
  clearAllDecorations()
  const pos = editor.getPosition()!
  const line = pos.lineNumber - 1
  const col = pos.column - 1
  if (activeTab === 'fink-tokens') tokensPanel?.highlightAtPosition(line, col)
  if (activeTab === 'fink-ast') astPanel?.highlightAtPosition(line, col)
  if (activeTab === 'fink-cps') cpsPanel?.syncFromSource(line, col)
  if (activeTab === 'fink-cps-lifted') cpsPanelLifted?.syncFromSource(line, col)
})

editor.onDidChangeCursorPosition(e => {
  if (!SYNC_TABS.has(activeTab)) return
  clearAllDecorations()
  const line = e.position.lineNumber - 1
  const col = e.position.column - 1
  if (activeTab === 'fink-tokens') tokensPanel?.highlightAtPosition(line, col)
  if (activeTab === 'fink-ast') astPanel?.highlightAtPosition(line, col)
  if (activeTab === 'fink-cps') cpsPanel?.syncFromSource(line, col)
  if (activeTab === 'fink-cps-lifted') cpsPanelLifted?.syncFromSource(line, col)
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
    let wasm: Uint8Array | null
    try {
      wasm = await compile(src)
    } catch (err) {
      outputEl.textContent = `Compile error: ${err}`
      outputEl.className = 'error'
      return
    }
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
    outputEl.textContent = `Runtime error: ${err}`
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

// On load: decode URL hash but defer injection until WASM is ready so that
// syntax highlighting works on first render.
let pendingSource: string | null = null
const initialHash = location.hash.slice(1)
if (initialHash) {
  editor.updateOptions({ readOnly: true })
  decodeSource(initialHash)
    .then(src => {
      pendingSource = src
      // If WASM is already loaded, inject immediately.
      if (ParsedDocument) {
        editor.updateOptions({ readOnly: false })
        editor.setValue(pendingSource)
        pendingSource = null
      }
    })
    .catch(err => {
      console.warn('[fink] Failed to decode URL hash:', err)
      editor.updateOptions({ readOnly: false })
      editor.setValue('')
    })
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
