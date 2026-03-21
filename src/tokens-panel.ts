// Tokens panel — renders lexer tokens as inline pill badges in the right pane.
//
// Each pill shows the token kind as the main label and the source text small.
// Bidirectional cursor sync: clicking a pill moves the editor cursor;
// moving the editor cursor highlights the corresponding pill.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { kindToScope, type LexToken } from './tokenizer.js'

// Map Monaco scope → CSS variable name for coloring pills.
const scopeToCssVar: Record<string, string> = {
  'variable.other.constant':      '--fink-editor-color-ident',
  'constant.numeric':             '--fink-editor-color-number',
  'constant.character.escape':    '--fink-editor-color-escape',
  'constant.character.escape.fink': '--fink-editor-color-number',
  'comment':                      '--fink-editor-color-comment',
  'string':                       '--fink-editor-color-string',
  'keyword.control':              '--fink-editor-color-control',
  'fink-operator':                '--fink-editor-color-operator',
  'fink-bracket':                 '--fink-editor-color-fn',
  'invalid':                      '--fink-editor-color-invalid',
  'punctuation':                  '--fink-editor-color-operator',
  'punctuation.section.embedded': '--fink-editor-color-keyword',
}

function cssVarForScope(scope: string | null): string {
  if (!scope) return 'var(--fink-editor-fg, #ccc)'
  const v = scopeToCssVar[scope]
  return v ? `var(${v})` : 'var(--fink-editor-fg, #ccc)'
}

// EOF is never interesting — skip it.
const SKIP_KINDS = new Set(['EOF'])

export class TokensPanel {
  private container: HTMLElement
  private editor: monaco.editor.IStandaloneCodeEditor
  private tokens: LexToken[] = []
  private pills: HTMLElement[] = []
  private activePill: HTMLElement | null = null
  private decorations: monaco.editor.IEditorDecorationsCollection

  constructor(container: HTMLElement, editor: monaco.editor.IStandaloneCodeEditor) {
    this.container = container
    this.editor = editor
    this.decorations = editor.createDecorationsCollection()
  }

  update(tokens: LexToken[]): void {
    this.tokens = tokens
    this.activePill = null

    const frag = document.createDocumentFragment()
    this.pills = []

    for (const tok of tokens) {
      if (SKIP_KINDS.has(tok.kind)) continue

      const scope = kindToScope(tok.kind, tok.src)
      const color = cssVarForScope(scope)

      const pill = document.createElement('span')
      pill.className = 'fink-token-pill'
      pill.dataset.line = String(tok.line)
      pill.dataset.col = String(tok.col)
      pill.dataset.endLine = String(tok.endLine)
      pill.dataset.endCol = String(tok.endCol)
      pill.style.borderColor = color

      const kindEl = document.createElement('span')
      kindEl.className = 'fink-token-kind'
      kindEl.textContent = tok.kind
      kindEl.style.color = color

      const srcEl = document.createElement('span')
      srcEl.className = 'fink-token-src'
      srcEl.textContent = tok.src

      pill.appendChild(kindEl)
      if (tok.src.trim()) {
        pill.appendChild(srcEl)
      }

      pill.addEventListener('click', () => {
        const range = new monaco.Range(
          tok.line + 1, tok.col + 1,
          tok.endLine + 1, tok.endCol + 1,
        )
        this.editor.revealRangeInCenter(range)
        this.editor.setPosition({ lineNumber: tok.line + 1, column: tok.col + 1 })
      })

      frag.appendChild(pill)
      this.pills.push(pill)
    }

    this.container.innerHTML = ''
    this.container.appendChild(frag)

    // Sync with current cursor position
    const pos = this.editor.getPosition()
    if (pos) {
      this.highlightAtPosition(pos.lineNumber - 1, pos.column - 1)
    }
  }

  clearEditorHighlight(): void {
    this.decorations.set([])
  }

  highlightAtPosition(line: number, col: number): void {
    if (this.activePill) {
      this.activePill.classList.remove('fink-token-active')
      this.activePill = null
    }

    // Find the visible token whose range contains (line, col).
    let pillIdx = 0
    for (const tok of this.tokens) {
      if (SKIP_KINDS.has(tok.kind)) continue

      const inRange =
        (tok.line < line || (tok.line === line && tok.col <= col)) &&
        (tok.endLine > line || (tok.endLine === line && tok.endCol > col))

      if (inRange) {
        const pill = this.pills[pillIdx]
        pill.classList.add('fink-token-active')
        pill.scrollIntoView({ block: 'nearest' })
        // Nudge scroll so the pill isn't flush against the edge
        const parent = this.container
        const pillRect = pill.getBoundingClientRect()
        const parentRect = parent.getBoundingClientRect()
        const pad = 60
        if (pillRect.top - parentRect.top < pad) {
          parent.scrollTop -= pad - (pillRect.top - parentRect.top)
        } else if (parentRect.bottom - pillRect.bottom < pad) {
          parent.scrollTop += pad - (parentRect.bottom - pillRect.bottom)
        }
        this.activePill = pill
        this.decorations.set([{
          range: new monaco.Range(tok.line + 1, tok.col + 1, tok.endLine + 1, tok.endCol + 1),
          options: { className: 'fink-token-highlight', isWholeLine: false },
        }])
        return
      }
      pillIdx++
    }
  }
}
