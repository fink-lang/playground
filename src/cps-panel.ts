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

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
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

// ---------------------------------------------------------------------------
// CPS panel
// ---------------------------------------------------------------------------

// Register a separate language for the CPS editor so it has its own tokenizer
// instance, independent of the source editor's 'fink' tokenizer.
monaco.languages.register({ id: 'fink-cps', extensions: [] })
const cpsTokenizer = new FinkTokenizer()
cpsTokenizer.register('fink-cps')

export class CpsPanel {
  private cpsEditor: monaco.editor.IStandaloneCodeEditor
  private lookup: PosMap | null = null
  private syncingFromCps = false
  private syncingFromSrc = false
  private highlightDeco: monaco.editor.IEditorDecorationsCollection
  private srcHighlightDeco: monaco.editor.IEditorDecorationsCollection
  private pendingTokens: { tokens: LexToken[]; code: string } | null = null

  constructor(
    container: HTMLElement,
    private srcEditor: monaco.editor.IStandaloneCodeEditor,
  ) {
    this.cpsEditor = monaco.editor.create(container, {
      value: '',
      language: 'fink-cps',
      theme: 'fink-dark',
      readOnly: true,
      fontSize: 14,
      fontFamily: '"Hack", "Consolas", "Menlo", monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 16, bottom: 16 },
      lineNumbers: 'on',
      accessibilitySupport: 'off',
      automaticLayout: true,
      'semanticHighlighting.enabled': false,
    })

    this.highlightDeco = this.cpsEditor.createDecorationsCollection([])
    this.srcHighlightDeco = this.srcEditor.createDecorationsCollection([])

    // After setValue() fires, push pending tokens into the tokenizer.
    // Pass -1 to force unconditional update; the version change in the state
    // already causes Monaco to re-tokenize all lines from scratch.
    this.cpsEditor.getModel()!.onDidChangeContent(() => {
      if (!this.pendingTokens) return
      const model = this.cpsEditor.getModel()!
      cpsTokenizer.update(this.pendingTokens.tokens, -1, this.pendingTokens.code)
      this.pendingTokens = null
    })

    // CPS cursor → highlight source
    this.cpsEditor.onDidChangeCursorPosition(e => {
      if (this.syncingFromSrc) return
      if (!this.lookup) return
      const m = lookupCpsToSrc(this.lookup, e.position.lineNumber - 1, e.position.column - 1)
      if (!m) return
      this.syncingFromCps = true
      this.srcHighlightDeco.set([{
        range: new monaco.Range(m.srcLine + 1, m.srcCol + 1, m.srcLine + 1, m.srcCol + 2),
        options: { className: 'fink-token-highlight', isWholeLine: false },
      }])
      this.srcEditor.revealPositionInCenterIfOutsideViewport({ lineNumber: m.srcLine + 1, column: m.srcCol + 1 })
      this.syncingFromCps = false
    })
  }

  // Called from main.ts on source editor cursor change.
  syncFromSource(srcLine: number, srcCol: number): void {
    if (this.syncingFromCps) return
    if (!this.lookup) { console.log('[cps] syncFromSource: no lookup'); return }
    const m = lookupSrcToCps(this.lookup, srcLine, srcCol)
    console.log('[cps] syncFromSource', srcLine, srcCol, '->', m)
    if (!m) return
    this.syncingFromSrc = true
    this.highlightDeco.set([{
      range: new monaco.Range(m.cpsLine + 1, m.cpsCol + 1, m.cpsLine + 1, m.cpsCol + 2),
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
      console.log('[cps] mappings decoded:', mappings.length, JSON.stringify(mappings.slice(0, 6)))
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
        cpsDoc.free()
        this.pendingTokens = { tokens: JSON.parse(highlightJson), code }
      } else {
        this.pendingTokens = null
      }
      model.setValue(code)
    }
    this.highlightDeco.set([])
    this.srcHighlightDeco.set([])
  }

  // Show/hide — called when tab is activated/deactivated.
  layout(): void {
    this.cpsEditor.layout()
  }
}
