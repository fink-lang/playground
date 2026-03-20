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
interface LexToken {
  kind: string
  src: string
  line: number   // 0-based
  col: number    // 0-based
  endLine: number
  endCol: number
}

// Monaco scope string for each lexer TokenKind.
// Multi-line tokens (BlockCont, BlockEnd) have no visible src — skip them.
function kindToScope(kind: string, src: string): string | null {
  switch (kind) {
    case 'Ident':
      if (src === '_') return 'keyword.control'
      if (src === 'fn' || src === 'match') return 'keyword.control'
      if (src === 'not' || src === 'and' || src === 'or' || src === 'xor' || src === 'in') return 'fink-operator'
      return 'variable.other.constant'
    case 'Int':
    case 'Float':
    case 'Decimal':      return 'constant.numeric'
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

export class FinkTokenizer {
  private cache: LineTokens[] = []
  private cacheVersion = -1

  // Call this whenever ParsedDocument changes (after every re-parse).
  update(tokensJson: string, modelVersion: number): void {
    if (modelVersion === this.cacheVersion) return
    this.cacheVersion = modelVersion

    const tokens: LexToken[] = JSON.parse(tokensJson)
    const byLine: Map<number, LineTokens> = new Map()

    for (const tok of tokens) {
      const scope = kindToScope(tok.kind, tok.src)
      if (scope === null) continue

      if (tok.line === tok.endLine) {
        // Single-line token
        if (!byLine.has(tok.line)) byLine.set(tok.line, [])
        byLine.get(tok.line)!.push({ startIndex: tok.col, scopes: scope })
      } else {
        // Multi-line token (e.g. block indent tokens, multi-line strings):
        // emit on every line it spans.
        for (let l = tok.line; l <= tok.endLine; l++) {
          if (!byLine.has(l)) byLine.set(l, [])
          // First line starts at tok.col; continuation lines start at col 0.
          byLine.get(l)!.push({ startIndex: l === tok.line ? tok.col : 0, scopes: scope })
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

  // Register this tokenizer with Monaco for the 'fink' language.
  register(): void {
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

    monaco.languages.setTokensProvider('fink', {
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
