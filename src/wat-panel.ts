// WAT panel — read-only Monaco editor showing the WAT disassembly of compiled Fink source.
//
// No cursor sync for now — sourcemap integration is deferred.
// Updated live on every reparse via update(wat).
//
// Syntax highlighting: hand-written Monarch tokenizer (no onigasm / TextMate deps).
// Covers the WAT subset emitted by fink codegen plus the full WAT MVP spec.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'

// Register language + tokenizer once.
monaco.languages.register({ id: 'wat' })

monaco.languages.setMonarchTokensProvider('wat', {
  // WAT structural / type keywords
  keywords: [
    'module', 'func', 'type', 'import', 'export', 'param', 'result',
    'local', 'global', 'memory', 'table', 'elem', 'data', 'start',
    'block', 'loop', 'if', 'else', 'end', 'then',
    'offset', 'align', 'declare',
    'mut', 'sub', 'rec', 'final', 'field',
    // value types
    'i32', 'i64', 'f32', 'f64', 'v128',
    'funcref', 'externref', 'anyref', 'eqref', 'i31ref', 'nullref',
    'ref', 'null',
    // GC types
    'struct', 'array',
    // instructions (common subset emitted by fink codegen)
    'unreachable', 'nop', 'return', 'call', 'call_indirect', 'call_ref',
    'return_call', 'return_call_indirect', 'return_call_ref',
    'drop', 'select',
    'local.get', 'local.set', 'local.tee',
    'global.get', 'global.set',
    'table.get', 'table.set', 'table.size', 'table.grow', 'table.fill', 'table.copy', 'table.init',
    'memory.size', 'memory.grow', 'memory.fill', 'memory.copy', 'memory.init',
    'ref.null', 'ref.is_null', 'ref.func', 'ref.as_non_null',
    'ref.eq', 'ref.test', 'ref.cast',
    'struct.new', 'struct.get', 'struct.set', 'struct.new_default',
    'array.new', 'array.get', 'array.set', 'array.len', 'array.new_fixed', 'array.new_default',
    'i31.new', 'i31.get_s', 'i31.get_u',
    // numeric
    'i32.const', 'i64.const', 'f32.const', 'f64.const',
    'i32.clz', 'i32.ctz', 'i32.popcnt',
    'i32.add', 'i32.sub', 'i32.mul', 'i32.div_s', 'i32.div_u',
    'i32.rem_s', 'i32.rem_u', 'i32.and', 'i32.or', 'i32.xor',
    'i32.shl', 'i32.shr_s', 'i32.shr_u', 'i32.rotl', 'i32.rotr',
    'i32.eqz', 'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u',
    'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u',
    'i32.wrap_i64', 'i32.trunc_f32_s', 'i32.trunc_f32_u', 'i32.trunc_f64_s', 'i32.trunc_f64_u',
    'i32.reinterpret_f32', 'i32.extend8_s', 'i32.extend16_s',
    'i64.clz', 'i64.ctz', 'i64.popcnt',
    'i64.add', 'i64.sub', 'i64.mul', 'i64.div_s', 'i64.div_u',
    'i64.rem_s', 'i64.rem_u', 'i64.and', 'i64.or', 'i64.xor',
    'i64.shl', 'i64.shr_s', 'i64.shr_u', 'i64.rotl', 'i64.rotr',
    'i64.eqz', 'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u',
    'i64.gt_s', 'i64.gt_u', 'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u',
    'i64.extend_i32_s', 'i64.extend_i32_u', 'i64.trunc_f32_s', 'i64.trunc_f32_u',
    'i64.trunc_f64_s', 'i64.trunc_f64_u', 'i64.reinterpret_f64',
    'f32.const', 'f32.abs', 'f32.neg', 'f32.ceil', 'f32.floor', 'f32.trunc', 'f32.nearest',
    'f32.sqrt', 'f32.add', 'f32.sub', 'f32.mul', 'f32.div', 'f32.min', 'f32.max',
    'f32.copysign', 'f32.eq', 'f32.ne', 'f32.lt', 'f32.gt', 'f32.le', 'f32.ge',
    'f32.convert_i32_s', 'f32.convert_i32_u', 'f32.convert_i64_s', 'f32.convert_i64_u',
    'f32.demote_f64', 'f32.reinterpret_i32',
    'f64.const', 'f64.abs', 'f64.neg', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest',
    'f64.sqrt', 'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.min', 'f64.max',
    'f64.copysign', 'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
    'f64.convert_i32_s', 'f64.convert_i32_u', 'f64.convert_i64_s', 'f64.convert_i64_u',
    'f64.promote_f32', 'f64.reinterpret_i64',
    // memory load/store
    'i32.load', 'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
    'i32.store', 'i32.store8', 'i32.store16',
    'i64.load', 'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u',
    'i64.load32_s', 'i64.load32_u', 'i64.store', 'i64.store8', 'i64.store16', 'i64.store32',
    'f32.load', 'f32.store', 'f64.load', 'f64.store',
  ],

  tokenizer: {
    root: [
      // line comment  ;; ...
      [/;;.*$/, 'comment'],
      // block comment  (; ... ;)
      [/\(;/, 'comment', '@blockComment'],
      // string
      [/"/, 'string', '@string'],
      // hex number (0x...) or float with exponent
      [/[+-]?0x[0-9a-fA-F][0-9a-fA-F_]*(?:\.[0-9a-fA-F_]*)?(?:[pP][+-]?\d+)?/, 'number.hex'],
      // decimal / float
      [/[+-]?(?:\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/, 'number'],
      // special float literals
      [/[+-]?(?:inf|nan(?::0x[0-9a-fA-F]+)?)/, 'number'],
      // identifiers / keywords: $name or plain word
      [/\$[A-Za-z0-9_.!#$%&'*+\-/:<=>?@\\^`|~]*/, 'variable'],
      [/[A-Za-z][A-Za-z0-9_.!#$%&'*+\-/:<=>?@\\^`|~]*/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],
      // parens
      [/[()]/, 'delimiter'],
      // index annotations (;= ... ;)  — produced by wasmprinter for readability
      [/\(;[^;]*;\)/, 'comment.doc'],
    ],

    blockComment: [
      [/[^(;]+/, 'comment'],
      [/\(;/, 'comment', '@push'],
      [/;\)/, 'comment', '@pop'],
      [/[();]/, 'comment'],
    ],

    string: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
  },
})

monaco.languages.setLanguageConfiguration('wat', {
  comments: { lineComment: ';;', blockComment: ['(;', ';)'] },
  brackets: [['(', ')']],
  autoClosingPairs: [{ open: '(', close: ')' }, { open: '"', close: '"' }],
})

export class WatPanel {
  private editor: monaco.editor.IStandaloneCodeEditor

  constructor(container: HTMLElement) {
    this.editor = monaco.editor.create(container, {
      value: '',
      language: 'wat',
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
  }

  update(wat: string): void {
    this.editor.getModel()?.setValue(wat)
  }

  layout(): void {
    this.editor.layout()
  }
}
