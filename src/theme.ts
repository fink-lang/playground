// Fink Monaco theme — reads colors from CSS variables so the embedding page
// (e.g. fink-lang.org) can theme the editor by setting --fink-editor-* vars.
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

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace(/^#/, '').toUpperCase()
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

  monaco.editor.defineTheme('fink-dark', {
    base: 'vs-dark',
    inherit: true,
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
      { token: 'constant.character.escape',    foreground: escape },
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
}
