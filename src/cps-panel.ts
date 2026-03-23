// CPS panel — read-only Monaco editor showing CPS-transformed Fink source.
//
// Bidirectional cursor sync via the Source Map v3 emitted by get_cps():
//   source editor position → sourcemap lookup → CPS editor position
//   CPS editor position    → sourcemap lookup → source editor position
//
// The sourcemap maps CPS output positions back to original source positions.
// We decode the VLQ mappings once per reparse and build two lookup tables:
//   cpsToSrc[cps_line][cps_col] → { srcLine, srcCol }
//   srcToFirst[src_line][src_col] → { cpsLine, cpsCol }  (first mapping for each src pos)

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import { FinkTokenizer, type LexToken } from './tokenizer.js'

// ---------------------------------------------------------------------------
// VLQ / Source Map v3 decoder
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function vlqDecode(str: string): number[] {
  const values: number[] = []
  let i = 0
  while (i < str.length) {
    let shift = 0, value = 0, cont = true
    while (cont) {
      const digit = B64.indexOf(str[i++])
      cont = (digit & 0x20) !== 0
      value |= (digit & 0x1f) << shift
      shift += 5
    }
    values.push(value & 1 ? -(value >> 1) : value >> 1)
  }
  return values
}

interface Mapping {
  cpsLine: number
  cpsCol: number
  srcLine: number
  srcCol: number
}

function decodeMappings(mappingsStr: string): Mapping[] {
  const result: Mapping[] = []
  let prevSrcLine = 0, prevSrcCol = 0
  const lines = mappingsStr.split(';')
  for (let cpsLine = 0; cpsLine < lines.length; cpsLine++) {
    const line = lines[cpsLine]
    if (!line) continue
    let prevCpsCol = 0
    for (const seg of line.split(',')) {
      if (!seg) continue
      const fields = vlqDecode(seg)
      if (fields.length < 4) continue
      prevCpsCol += fields[0]
      // fields[1] = source index delta (always 0)
      prevSrcLine += fields[2]
      prevSrcCol  += fields[3]
      result.push({ cpsLine, cpsCol: prevCpsCol, srcLine: prevSrcLine, srcCol: prevSrcCol })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Lookup tables built from mappings
// ---------------------------------------------------------------------------

interface PosMap {
  // cpsToSrc: for a given CPS (line, col), the nearest src position
  cpsToSrc: Mapping[]
  // srcToFirst: for a given src (line, col), the first CPS position
  srcToFirst: Map<number, Mapping>  // key = srcLine * 100000 + srcCol
}

function buildLookup(mappings: Mapping[]): PosMap {
  const srcToFirst = new Map<number, Mapping>()
  for (const m of mappings) {
    const key = m.srcLine * 100000 + m.srcCol
    if (!srcToFirst.has(key)) srcToFirst.set(key, m)
  }
  return { cpsToSrc: mappings, srcToFirst }
}

// Find the CPS mapping closest to (cpsLine, cpsCol) — last mapping on or before the position.
function lookupCpsToSrc(lookup: PosMap, cpsLine: number, cpsCol: number): Mapping | null {
  let best: Mapping | null = null
  for (const m of lookup.cpsToSrc) {
    if (m.cpsLine > cpsLine) break
    if (m.cpsLine < cpsLine || m.cpsCol <= cpsCol) best = m
  }
  return best
}

// Find the first CPS position that maps from (srcLine, srcCol).
function lookupSrcToCps(lookup: PosMap, srcLine: number, srcCol: number): Mapping | null {
  return lookup.srcToFirst.get(srcLine * 100000 + srcCol) ?? null
}

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
  private lookup: PosMap | null = null
  private syncingFromCps = false
  private syncingFromSrc = false
  private highlightDeco: monaco.editor.IEditorDecorationsCollection
  private srcHighlightDeco: monaco.editor.IEditorDecorationsCollection
  onWillHighlightSrc: (() => void) | null = null
  onActivate: (() => void) | null = null
  private pendingTokens: { tokens: LexToken[]; code: string } | null = null
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

    // After setValue() fires, push pending tokens into the tokenizer.
    // Pass -1 to force unconditional update; the version change in the state
    // already causes Monaco to re-tokenize all lines from scratch.
    this.cpsEditor.getModel()!.onDidChangeContent(() => {
      if (!this.pendingTokens) return
      const model = this.cpsEditor.getModel()!
      this.tokenizer.update(this.pendingTokens.tokens, -1, this.pendingTokens.code)
      this.pendingTokens = null
    })

    // CPS cursor → highlight source
    this.cpsEditor.onDidChangeCursorPosition(e => {
      if (this.syncingFromSrc) return
      this.onActivate?.()
      if (!this.lookup) return
      const cpsLine = e.position.lineNumber - 1
      const cpsCol  = e.position.column - 1
      const cpsTok  = tokenAtPos(this.cpsTokens, cpsLine, cpsCol)
      const m = lookupCpsToSrc(this.lookup, cpsLine, cpsTok ? cpsTok.col : cpsCol)
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
    const m = lookupSrcToCps(this.lookup, srcLine, srcTok ? srcTok.col : srcCol)
    if (!m) { this.highlightDeco.set([]); return }
    this.syncingFromSrc = true
    const cpsTok = tokenAtPos(this.cpsTokens, m.cpsLine, m.cpsCol)
    const cpsEnd = cpsTok ? cpsTok.endCol : m.cpsCol + 1
    this.highlightDeco.set([{
      range: new monaco.Range(m.cpsLine + 1, m.cpsCol + 1, m.cpsLine + 1, cpsEnd + 1),
      options: { className: 'fink-token-highlight', isWholeLine: false },
    }])
    this.cpsEditor.revealPositionInCenterIfOutsideViewport({ lineNumber: m.cpsLine + 1, column: m.cpsCol + 1 })
    this.syncingFromSrc = false
  }

  // Called from main.ts after each reparse with the get_cps() JSON result and
  // the ParsedDocument constructor (to lex the CPS code for highlighting).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(cpsJson: string, ParsedDocument: any): void {
    let code = ''
    try {
      const parsed = JSON.parse(cpsJson) as { code: string; map: string }
      code = parsed.code
      const mapObj = JSON.parse(parsed.map) as { mappings: string }
      const mappings = decodeMappings(mapObj.mappings)
      this.lookup = buildLookup(mappings)

    } catch {
      this.lookup = null
    }

    const model = this.cpsEditor.getModel()
    if (model) {
      // Lex the CPS code and stash the tokens — the model's onDidChangeContent
      // handler (set up in the constructor) will push them into the tokenizer
      // with the correct post-setValue version number.
      if (ParsedDocument && code) {
        const cpsDoc = new ParsedDocument(code)
        const highlightJson = cpsDoc.get_highlight_tokens()
        this.lastSemanticTokens = cpsDoc.get_semantic_tokens()
        cpsDoc.free()
        const tokens: LexToken[] = JSON.parse(highlightJson)
        this.cpsTokens = tokens
        this.pendingTokens = { tokens, code }
      } else {
        this.pendingTokens = null
        this.lastSemanticTokens = new Uint32Array(0)
        this.cpsTokens = []
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
