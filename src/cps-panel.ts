// CPS panel — read-only Monaco editor showing CPS-transformed Fink source.
//
// Bidirectional cursor sync via the native sourcemap emitted by get_cps():
//   source editor position → sourcemap lookup → CPS editor position
//   CPS editor position    → sourcemap lookup → source editor position
//
// The sourcemap is a flat array of { out, srcStart, srcEnd } byte-offset
// triples (see ./native-sourcemap.ts). It is decoded once per reparse into
// a `Lookup` that supports lookups in either direction.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import { FinkTokenizer, type LexToken } from './tokenizer.js'
import {
  buildLookup, decodeNativeSourcemap, lookupGenToSrc, lookupSrcToGen,
  type Lookup, type RawMapping,
} from './native-sourcemap.js'

// Find the token that contains (line, col) — cursor can be anywhere inside it.
function tokenAtPos(tokens: LexToken[], line: number, col: number): LexToken | null {
  for (const t of tokens) {
    if (t.line > line) break
    if (t.line === line && t.col <= col && col < t.endCol) return t
  }
  return null
}

// ---------------------------------------------------------------------------
// CPS panel
// ---------------------------------------------------------------------------

// Each CpsPanel gets its own language ID and FinkTokenizer instance so their
// token caches don't collide when both panels update in the same reparse cycle.
let cpsPanelCount = 0

const TOKEN_TYPES = ['function', 'variable', 'property', 'block-name', 'tag-left', 'tag-right']
const TOKEN_MODIFIERS = ['readonly']

export class CpsPanel {
  private cpsEditor: monaco.editor.IStandaloneCodeEditor
  private tokenizer: FinkTokenizer
  private lookup: Lookup | null = null
  private syncingFromCps = false
  private syncingFromSrc = false
  private highlightDeco: monaco.editor.IEditorDecorationsCollection
  private srcHighlightDeco: monaco.editor.IEditorDecorationsCollection
  onWillHighlightSrc: (() => void) | null = null
  onActivate: (() => void) | null = null
  private lastSemanticTokens: Uint32Array = new Uint32Array(0)
  private cpsTokens: LexToken[] = []
  private srcTokens: LexToken[] = []

  constructor(
    container: HTMLElement,
    private srcEditor: monaco.editor.IStandaloneCodeEditor,
  ) {
    const langId = `fink-cps-${cpsPanelCount++}`
    monaco.languages.register({ id: langId, extensions: [] })
    this.tokenizer = new FinkTokenizer()
    this.tokenizer.register(langId)

    // Semantic tokens provider — returns the last tokens computed in update().
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    monaco.languages.registerDocumentSemanticTokensProvider(langId, {
      getLegend() { return { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS } },
      provideDocumentSemanticTokens() {
        return { data: self.lastSemanticTokens, resultId: undefined }
      },
      releaseDocumentSemanticTokens() {},
    })

    this.cpsEditor = monaco.editor.create(container, {
      value: '',
      language: langId,
      theme: 'fink',
      readOnly: true,
      fontSize: 14,
      fontFamily: '"Hack", "Consolas", "Menlo", monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 16, bottom: 16 },
      lineNumbers: 'on',
      accessibilitySupport: 'off',
      automaticLayout: true,
    })

    this.highlightDeco = this.cpsEditor.createDecorationsCollection([])
    this.srcHighlightDeco = this.srcEditor.createDecorationsCollection([])

    // CPS cursor → highlight source
    this.cpsEditor.onDidChangeCursorPosition(e => {
      if (this.syncingFromSrc) return
      this.highlightDeco.set([])
      this.onActivate?.()
      if (!this.lookup) return
      const cpsLine = e.position.lineNumber - 1
      const cpsCol  = e.position.column - 1
      const cpsTok  = tokenAtPos(this.cpsTokens, cpsLine, cpsCol)
      const m = lookupGenToSrc(this.lookup, cpsLine, cpsTok ? cpsTok.col : cpsCol)
      if (!m) { this.srcHighlightDeco.set([]); return }
      this.onWillHighlightSrc?.()
      this.syncingFromCps = true
      const srcTok = tokenAtPos(this.srcTokens, m.srcLine, m.srcCol)
      const srcEnd = srcTok ? srcTok.endCol : m.srcCol + 1
      this.srcHighlightDeco.set([{
        range: new monaco.Range(m.srcLine + 1, m.srcCol + 1, m.srcLine + 1, srcEnd + 1),
        options: { className: 'fink-token-highlight', isWholeLine: false },
      }])
      this.srcEditor.revealPositionInCenterIfOutsideViewport({ lineNumber: m.srcLine + 1, column: m.srcCol + 1 })
      this.syncingFromCps = false
    })
  }

  // Called from main.ts on source editor cursor change.
  syncFromSource(srcLine: number, srcCol: number): void {
    if (this.syncingFromCps) return
    this.highlightDeco.set([])
    if (!this.lookup) return
    const srcTok = tokenAtPos(this.srcTokens, srcLine, srcCol)
    const m = lookupSrcToGen(this.lookup, srcLine, srcTok ? srcTok.col : srcCol)
    if (!m) { this.highlightDeco.set([]); return }
    this.syncingFromSrc = true
    const cpsTok = tokenAtPos(this.cpsTokens, m.genLine, m.genCol)
    const cpsEnd = cpsTok ? cpsTok.endCol : m.genCol + 1
    this.highlightDeco.set([{
      range: new monaco.Range(m.genLine + 1, m.genCol + 1, m.genLine + 1, cpsEnd + 1),
      options: { className: 'fink-token-highlight', isWholeLine: false },
    }])
    this.cpsEditor.revealPositionInCenterIfOutsideViewport({ lineNumber: m.genLine + 1, column: m.genCol + 1 })
    this.syncingFromSrc = false
  }

  // Called from main.ts after each reparse with the get_cps() JSON result, the
  // source text (for sourcemap line/col conversion), and the ParsedDocument
  // constructor (to lex the CPS code for highlighting).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(cpsJson: string, src: string, ParsedDocument: any): void {
    let code = ''
    if (!cpsJson) {
      // CPS transform crashed — show error in the editor
      code = '---\nOops! You found a bug in the CPS transform.\nThe ƒink compiler is still in early stages of development — this will be fixed soon.\nFeel free to open a ticket: github.com/fink-lang/fink/issues\n---'
      this.lookup = null
    } else try {
      const parsed = JSON.parse(cpsJson) as { code: string; map: RawMapping[] }
      code = parsed.code
      const mappings = decodeNativeSourcemap(parsed.map, code, src)
      this.lookup = buildLookup(mappings)

    } catch {
      this.lookup = null
    }

    const model = this.cpsEditor.getModel()
    if (model) {
      if (ParsedDocument && code) {
        const cpsDoc = new ParsedDocument(code)
        const highlightJson = cpsDoc.get_highlight_tokens()
        this.lastSemanticTokens = cpsDoc.get_semantic_tokens()
        cpsDoc.free()
        const tokens: LexToken[] = JSON.parse(highlightJson)
        this.cpsTokens = tokens
        // Update the tokenizer cache before setValue so Monaco's re-tokenize
        // pass sees the new tokens immediately, not on the next edit.
        this.tokenizer.update(tokens, -1, code)
      } else {
        this.lastSemanticTokens = new Uint32Array(0)
        this.cpsTokens = []
        this.tokenizer.update([], -1, '')
      }
      model.setValue(code)
    }
    this.highlightDeco.set([])
    this.srcHighlightDeco.set([])
  }

  clearSrcHighlight(): void {
    this.srcHighlightDeco.set([])
  }

  clearAll(): void {
    this.highlightDeco.set([])
    this.srcHighlightDeco.set([])
  }

  // Called from main.ts after each reparse with the source highlight tokens,
  // so the CPS→source highlight can span the full source token.
  updateSrcTokens(tokens: LexToken[]): void {
    this.srcTokens = tokens
  }

  // Show/hide — called when tab is activated/deactivated.
  layout(): void {
    this.cpsEditor.layout()
  }
}
