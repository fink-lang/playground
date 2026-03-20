// Fink Monaco tokenizer — drives Monaco's setTokensProvider using the WASM
// lexer (ParsedDocument.get_tokens()) instead of the TM grammar + oniguruma.
//
// Monaco's tokens provider is line-based and stateful: it calls
// tokenize(line, state) per line and threads state through. Our lexer is
// whole-document, so we pre-tokenize on every model change, bucket tokens by
// line, and serve them from the cache. The "state" is just the line index —
// Monaco re-tokenizes from the first changed line, so stale lines are never
// served from an outdated cache.
//
// Token kind → Monaco scope mapping mirrors the TM grammar scopes so the
// existing fink-dark theme rules apply without changes.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'

// Raw token from get_tokens() JSON
export interface LexToken {
  kind: string
  src: string
  line: number   // 0-based
  col: number    // 0-based
  endLine: number
  endCol: number
}

// Monaco scope string for each lexer TokenKind.
// Multi-line tokens (BlockCont, BlockEnd) have no visible src — skip them.
export function kindToScope(kind: string, src: string): string | null {
  switch (kind) {
    case 'Ident':
      if (src === '_') return 'keyword.control'
      if (src === 'fn' || src === 'match') return 'keyword.control'
      if (src === 'not' || src === 'and' || src === 'or' || src === 'xor' || src === 'in') return 'fink-operator'
      return 'variable.other.constant'
    case 'Int':
    case 'Float':
    case 'Decimal':
    case 'NumDigits':    return 'constant.numeric'
    case 'NumMarker':    return 'constant.character.escape.fink'
    case 'Sep':          return (src === '|=' || src === '|') ? 'keyword.control' : 'fink-operator'
    case 'Colon':        return 'fink-operator'
    case 'Comma':        return 'punctuation'
    case 'Semicolon':    return 'keyword.control'
    case 'Partial':      return 'keyword.control'
    case 'BracketOpen':
    case 'BracketClose': return 'fink-bracket'
    case 'StrStart':
    case 'StrEnd':       return 'string'
    case 'StrText':      return 'string'
    case 'StrEscape':    return 'constant.character.escape'
    case 'StrExprStart':
    case 'StrExprEnd':   return 'punctuation.section.embedded'
    case 'Comment':      return 'comment'
    case 'CommentStart': return 'comment'
    case 'CommentText':  return 'comment'
    case 'CommentEnd':   return 'comment'
    case 'Err':          return 'invalid'
    // BlockStart/BlockCont/BlockEnd/EOF have empty or whitespace src — skip
    case 'BlockStart':
    case 'BlockCont':
    case 'BlockEnd':
    case 'EOF':          return null
    default:             return null
  }
}

// Per-line token cache. Rebuilt whenever the document changes.
// Each entry is a sorted array of {startIndex, scopes} ready for Monaco.
type LineTokens = Array<{ startIndex: number; scopes: string }>

// Build a per-line map from UTF-8 byte offset → UTF-16 code unit offset.
// Monaco startIndex is UTF-16; Rust col is UTF-8 byte offset.
// U+0000–U+007F: 1 byte / 1 unit
// U+0080–U+07FF: 2 bytes / 1 unit  (includes ·  U+00B7)
// U+0800–U+FFFF: 3 bytes / 1 unit
// U+10000+:      4 bytes / 2 units (surrogates)
function buildByteToUtf16Maps(src: string): Map<number, number>[] {
  const lines = src.split('\n')
  return lines.map(line => {
    const map = new Map<number, number>()
    let byteOff = 0
    let utf16Off = 0
    for (const ch of line) {
      map.set(byteOff, utf16Off)
      const cp = ch.codePointAt(0)!
      byteOff  += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
      utf16Off += cp < 0x10000 ? 1 : 2
    }
    map.set(byteOff, utf16Off) // one past end
    return map
  })
}

export class FinkTokenizer {
  private cache: LineTokens[] = []
  private cacheVersion = -1

  // Call this whenever ParsedDocument changes (after every re-parse).
  // src is the full source text used to convert byte offsets to UTF-16.
  // Pass modelVersion=-1 to force update unconditionally (e.g. for CPS editor).
  update(tokens: LexToken[], modelVersion: number, src: string): void {
    if (modelVersion !== -1 && modelVersion === this.cacheVersion) return
    this.cacheVersion = modelVersion

    const b2u = buildByteToUtf16Maps(src)

    // Convert a byte-offset col on a given line to a UTF-16 code unit offset.
    const toUtf16 = (line: number, byteCol: number): number => {
      const map = b2u[line]
      if (!map) return byteCol
      return map.get(byteCol) ?? byteCol
    }

    const byLine: Map<number, LineTokens> = new Map()

    for (const tok of tokens) {
      const scope = kindToScope(tok.kind, tok.src)
      if (scope === null) continue

      if (tok.line === tok.endLine) {
        // Single-line token
        if (!byLine.has(tok.line)) byLine.set(tok.line, [])
        byLine.get(tok.line)!.push({ startIndex: toUtf16(tok.line, tok.col), scopes: scope })
      } else {
        // Multi-line token (e.g. block indent tokens, multi-line strings):
        // emit on every line it spans.
        for (let l = tok.line; l <= tok.endLine; l++) {
          if (!byLine.has(l)) byLine.set(l, [])
          // First line starts at tok.col; continuation lines start at col 0.
          byLine.get(l)!.push({ startIndex: l === tok.line ? toUtf16(l, tok.col) : 0, scopes: scope })
        }
      }
    }

    // Sort each line's tokens by startIndex (lexer should already be ordered,
    // but make it explicit) and store in the cache array.
    const maxLine = byLine.size > 0 ? Math.max(...byLine.keys()) : 0
    this.cache = []
    for (let i = 0; i <= maxLine; i++) {
      const line = byLine.get(i) ?? []
      line.sort((a, b) => a.startIndex - b.startIndex)
      this.cache.push(line)
    }
  }

  // Register this tokenizer with Monaco for the given language ID (default: 'fink').
  register(langId = 'fink'): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this

    // State carries both the line index and the cache version it was built from.
    // When the cache is updated (cacheVersion changes), equals() returns false
    // for every cached state, forcing Monaco to re-tokenize all lines top-to-bottom.
    type State = { line: number; ver: number }
    const makeState = (line: number, ver: number): State & monaco.languages.IState => ({
      line,
      ver,
      clone() { return makeState(this.line, this.ver) },
      equals(o: unknown) {
        const s = o as State
        return s?.line === this.line && s?.ver === this.ver
      },
    })

    monaco.languages.setTokensProvider(langId, {
      getInitialState: () => makeState(0, self.cacheVersion),
      tokenize(_lineText: string, state: State) {
        const lineTokens = self.cache[state.line] ?? []
        return {
          tokens: lineTokens,
          endState: makeState(state.line + 1, self.cacheVersion),
        }
      },
    })
  }
}
