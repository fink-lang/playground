// Decoder for fink's native sourcemap, the format produced by
// `wasm::fmt::fmt_fragment_with_sm` and `cps::fmt::fmt_with_mapped_native`.
//
// Wire format (sent from the Rust side as JSON): an array of
//   { out: number, srcStart: number, srcEnd: number }
// where `out` is a byte offset into the generated text and `srcStart..srcEnd`
// is a byte range in the original source text.
//
// This module turns the byte-based wire format into the line/col-based
// `Mapping` shape the panels work with, and provides bidirectional lookup
// helpers (source pos → generated pos, generated pos → source pos).

export interface RawMapping {
  out: number
  srcStart: number
  srcEnd: number
}

export interface Mapping {
  /// 0-based line in the generated text (CPS / WAT).
  genLine: number
  /// 0-based column in the generated text.
  genCol: number
  /// 0-based line in the source text.
  srcLine: number
  /// 0-based column in the source text.
  srcCol: number
  /// Byte length of the source span. Useful when callers want to highlight
  /// the original source token directly.
  srcLen: number
}

// Build a sorted array of newline byte offsets so byte → line/col is O(log n).
class LineMap {
  private newlines: number[]
  private text: string

  constructor(text: string) {
    this.text = text
    const newlines: number[] = []
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) newlines.push(i)
    }
    this.newlines = newlines
  }

  /// Convert a byte offset to a 0-based (line, col) pair.
  toLineCol(byteOffset: number): { line: number; col: number } {
    // Binary search for the largest newline index < byteOffset.
    let lo = 0
    let hi = this.newlines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.newlines[mid] < byteOffset) lo = mid + 1
      else hi = mid
    }
    // `lo` is the count of newlines strictly before byteOffset, which is
    // also the 0-based line number. Column = byteOffset - (last newline + 1).
    const line = lo
    const lineStart = lo === 0 ? 0 : this.newlines[lo - 1] + 1
    const col = byteOffset - lineStart
    return { line, col }
  }

  /// Get the column-equivalent of the end of `line` (i.e. the line's length
  /// in bytes). Used as a fallback when no `next` mapping is available.
  lineLen(line: number): number {
    if (line < 0 || line > this.newlines.length) return 0
    const start = line === 0 ? 0 : this.newlines[line - 1] + 1
    const end = line < this.newlines.length ? this.newlines[line] : this.text.length
    return end - start
  }
}

export function decodeNativeSourcemap(
  raw: RawMapping[],
  generatedText: string,
  sourceText: string,
): Mapping[] {
  const genLines = new LineMap(generatedText)
  const srcLines = new LineMap(sourceText)
  const out: Mapping[] = []
  for (const m of raw) {
    const { line: genLine, col: genCol } = genLines.toLineCol(m.out)
    const { line: srcLine, col: srcCol } = srcLines.toLineCol(m.srcStart)
    out.push({
      genLine,
      genCol,
      srcLine,
      srcCol,
      srcLen: m.srcEnd - m.srcStart,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Lookup tables built from mappings
// ---------------------------------------------------------------------------

export interface Lookup {
  // First mapping with this exact source position — key = srcLine * 100000 + srcCol.
  srcToFirst: Map<number, Mapping>
  // All mappings on a given source line, sorted by srcCol — for nearest-col fallback.
  byLine: Map<number, Mapping[]>
  // For each generated line, sorted list of generated columns with mappings —
  // used by the WAT panel to find the start of the next mapping on the same line.
  byGenLine: Map<number, number[]>
  // The full mapping list in original order — used for generated → source lookups
  // (we want the *last* mapping at-or-before a generated cursor position).
  all: Mapping[]
}

export function buildLookup(mappings: Mapping[]): Lookup {
  const srcToFirst = new Map<number, Mapping>()
  const byLine = new Map<number, Mapping[]>()
  const byGenLine = new Map<number, number[]>()
  for (const m of mappings) {
    const key = m.srcLine * 100000 + m.srcCol
    if (!srcToFirst.has(key)) srcToFirst.set(key, m)
    if (!byLine.has(m.srcLine)) byLine.set(m.srcLine, [])
    byLine.get(m.srcLine)!.push(m)
    if (!byGenLine.has(m.genLine)) byGenLine.set(m.genLine, [])
    byGenLine.get(m.genLine)!.push(m.genCol)
  }
  for (const arr of byLine.values()) arr.sort((a, b) => a.srcCol - b.srcCol)
  for (const arr of byGenLine.values()) arr.sort((a, b) => a - b)
  return { srcToFirst, byLine, byGenLine, all: mappings }
}

/// Source (line, col) → first generated mapping for that position.
/// Falls back to nearest col on the same line, then nearest line.
export function lookupSrcToGen(lookup: Lookup, srcLine: number, srcCol: number): Mapping | null {
  const exact = lookup.srcToFirst.get(srcLine * 100000 + srcCol)
  if (exact) return exact

  const lineArr = lookup.byLine.get(srcLine)
  if (lineArr && lineArr.length > 0) {
    let best = lineArr[0]
    for (const m of lineArr) {
      if (m.srcCol <= srcCol) best = m
      else break
    }
    return best
  }

  let bestLine: number | null = null
  for (const line of lookup.byLine.keys()) {
    if (bestLine === null || Math.abs(line - srcLine) < Math.abs(bestLine - srcLine)) bestLine = line
  }
  if (bestLine === null) return null
  return lookup.byLine.get(bestLine)![0]
}

/// Generated (line, col) → last mapping at-or-before that position.
export function lookupGenToSrc(lookup: Lookup, genLine: number, genCol: number): Mapping | null {
  let best: Mapping | null = null
  for (const m of lookup.all) {
    if (m.genLine > genLine) break
    if (m.genLine < genLine || m.genCol <= genCol) best = m
  }
  return best
}

/// Start col of the next mapping on the same generated line after `genCol`,
/// or null if there is none. Used by the WAT panel to bound a highlight.
export function nextGenCol(lookup: Lookup, genLine: number, genCol: number): number | null {
  const cols = lookup.byGenLine.get(genLine)
  if (!cols) return null
  for (const c of cols) {
    if (c > genCol) return c
  }
  return null
}
