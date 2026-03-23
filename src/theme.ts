// Fink Monaco theme — reads colors from CSS variables so the embedding page
// (e.g. fink-lang.org) can theme the editor by setting --fink-editor-* vars.
//
// The embedding page may use light-dark() in its CSS variables. Since custom
// properties return raw token sequences from getComputedStyle, we resolve them
// by pushing each variable through a temporary element's `color` property,
// which the browser resolves to a concrete rgb() value.
//
// Variable reference:
//   --fink-editor-bg              editor background
//   --fink-editor-fg              default text
//   --fink-editor-color-fn        functions
//   --fink-editor-color-ident     identifiers / variables
//   --fink-editor-color-rec-key   record keys
//   --fink-editor-color-tag       tags (prefix/postfix/numeric)
//   --fink-editor-color-block     block names
//   --fink-editor-color-keyword   keywords (if/else/fn/match/…)
//   --fink-editor-color-control   control flow (|, ;, ?, _)
//   --fink-editor-color-operator  arithmetic/comparison operators
//   --fink-editor-color-number    numeric literals
//   --fink-editor-color-string    string literals
//   --fink-editor-color-escape    escape sequences
//   --fink-editor-color-comment   comments
//   --fink-editor-color-invalid   errors / invalid tokens
//   --fink-editor-color-bracket   bracket pair color 1
//   --fink-editor-color-bracket2  bracket pair color 2
//   --fink-editor-color-bracket3  bracket pair color 3
//   --fink-editor-highlight-bg      active/selected item background
//   --fink-editor-highlight-border  active/selected item border

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'

// Hidden element used to resolve CSS color values (including light-dark()).
// Appended to documentElement so it inherits the same color-scheme context.
const probe = document.createElement('div')
probe.style.display = 'none'
document.documentElement.appendChild(probe)

// Resolve a CSS variable to a 6-digit uppercase hex string (without '#').
// Sets the probe's color to var(--name), reads the computed rgb(), converts.
function cssVar(name: string): string {
  probe.style.color = `var(${name})`
  const resolved = getComputedStyle(probe).color
  // getComputedStyle returns "rgb(r, g, b)" or "rgba(r, g, b, a)"
  const m = resolved.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/)
  if (m) {
    const hex = (i: number) => parseInt(m[i]).toString(16).padStart(2, '0')
    return (hex(1) + hex(2) + hex(3)).toUpperCase()
  }
  // Fallback: try to use the raw custom property value (plain hex)
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw.replace(/^#/, '').toUpperCase()
}

// Detect whether the current color scheme is dark.
function isDark(): boolean {
  const cs = getComputedStyle(document.documentElement).colorScheme
  if (cs.includes('dark')) return true
  if (cs.includes('light')) return false
  return matchMedia('(prefers-color-scheme: dark)').matches
}

export function defineTheme(): void {
  const fn       = cssVar('--fink-editor-color-fn')
  const ident    = cssVar('--fink-editor-color-ident')
  const recKey   = cssVar('--fink-editor-color-rec-key')
  const tag      = cssVar('--fink-editor-color-tag')
  const block    = cssVar('--fink-editor-color-block')
  const keyword  = cssVar('--fink-editor-color-keyword')
  const control  = cssVar('--fink-editor-color-control')
  const operator = cssVar('--fink-editor-color-operator')
  const number   = cssVar('--fink-editor-color-number')
  const string   = cssVar('--fink-editor-color-string')
  const escape   = cssVar('--fink-editor-color-escape')
  const comment  = cssVar('--fink-editor-color-comment')
  const invalid  = cssVar('--fink-editor-color-invalid')
  const bg       = cssVar('--fink-editor-bg')
  const bracket1 = '#' + cssVar('--fink-editor-color-bracket')
  const bracket2 = '#' + cssVar('--fink-editor-color-bracket2')
  const bracket3 = '#' + cssVar('--fink-editor-color-bracket3')

  monaco.editor.defineTheme('fink', {
    base: isDark() ? 'vs-dark' : 'vs',
    inherit: true,
    semanticHighlighting: true,
    rules: [
      // Semantic token types (from WASM provider)
      { token: 'function',               foreground: fn },
      { token: 'variable',               foreground: recKey },
      { token: 'variable.readonly',      foreground: ident },
      { token: 'property',               foreground: recKey },
      { token: 'block-name',             foreground: block },
      { token: 'tag-left',               foreground: tag },
      { token: 'tag-right',              foreground: tag },

      // Lexer token scopes (from FinkTokenizer)
      { token: 'variable.other.constant',      foreground: ident },
      { token: 'constant.numeric',             foreground: number },
      { token: 'constant.character.escape',      foreground: escape },
      { token: 'constant.character.escape.fink', foreground: 'D7BA7D' },
      { token: 'comment',                      foreground: comment },
      { token: 'string',                       foreground: string },
      { token: 'punctuation.section.embedded', foreground: keyword },
      { token: 'keyword',                      foreground: keyword },
      { token: 'keyword.control',              foreground: control },
      { token: 'fink-operator',                foreground: operator },
      { token: 'fink-bracket',                 foreground: fn },
      { token: 'invalid',                      foreground: invalid },
    ],
    colors: {
      'editor.background': '#' + bg,
      'editorBracketHighlight.foreground1': bracket1,
      'editorBracketHighlight.foreground2': bracket2,
      'editorBracketHighlight.foreground3': bracket3,
      'editorBracketHighlight.foreground4': bracket1,
      'editorBracketHighlight.foreground5': bracket2,
      'editorBracketHighlight.foreground6': bracket3,
      'editorBracketHighlight.unexpectedBracket.foreground': '#FF000066',
    },
  })

  monaco.editor.setTheme('fink')
}

// Re-apply the Monaco theme when the host page's color scheme changes.
// Covers both OS-level preference flips and pages that toggle color-scheme
// via inline style or class on <html>.
export function watchColorScheme(): void {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    defineTheme()
  })

  new MutationObserver(() => {
    defineTheme()
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  })
}
