// AST panel — renders the parsed AST as an indented collapsible tree.
//
// Each row shows the node kind and an inline label (operator, literal value,
// identifier name). Bidirectional cursor sync:
//   - Moving the editor cursor highlights the deepest AST node whose source
//     span contains the cursor (among visible rows), and scrolls it into view.
//   - Clicking an AST row moves the editor cursor and highlights the source
//     span of that node.
//
// Collapse/expand:
//   - Nodes with children show a chevron (▶/▼) on the left.
//   - Clicking the chevron toggles the subtree; clicking the rest of the row
//     does source sync only.
//   - Collapsed state is keyed by AstNode.id and survives update() calls.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'

export interface AstNode {
  id: number
  kind: string
  label: string
  line: number
  col: number
  endLine: number
  endCol: number
  children: AstNode[]
}

// Nodes whose kind color uses a specific CSS variable; everything else gets
// the default foreground. Mirrors the semantic token type groupings.
const KIND_COLORS: Record<string, string> = {
  Ident:       '--fink-editor-color-ident',
  LitInt:      '--fink-editor-color-number',
  LitFloat:    '--fink-editor-color-number',
  LitDecimal:  '--fink-editor-color-number',
  LitBool:     '--fink-editor-color-number',
  LitStr:      '--fink-editor-color-string',
  StrTempl:    '--fink-editor-color-string',
  StrRawTempl: '--fink-editor-color-string',
  Fn:          '--fink-editor-color-fn',
  Match:       '--fink-editor-color-control',
  Arm:         '--fink-editor-color-control',
  Block:       '--fink-editor-color-keyword',
  Bind:        '--fink-editor-color-operator',
  BindRight:   '--fink-editor-color-operator',
  InfixOp:     '--fink-editor-color-operator',
  UnaryOp:     '--fink-editor-color-operator',
  Pipe:        '--fink-editor-color-operator',
}

function colorForKind(kind: string): string {
  const v = KIND_COLORS[kind]
  return v ? `var(${v})` : 'var(--fink-editor-fg, #ccc)'
}

// Flat list of visible rows — rebuilt after every expand/collapse toggle.
interface FlatEntry {
  node: AstNode
  el: HTMLElement  // the .fink-ast-row element
}

export class AstPanel {
  private container: HTMLElement
  private editor: monaco.editor.IStandaloneCodeEditor
  // Visible flat entries — rebuilt by rebuildFlat() after each toggle or update.
  private flat: FlatEntry[] = []
  private activeEl: HTMLElement | null = null
  private decorations: monaco.editor.IEditorDecorationsCollection
  // Collapsed node ids — preserved across update() calls.
  private collapsed: Set<number> = new Set()
  // id → AstNode, populated on each update() for O(1) lookup in rebuildFlat().
  private nodeMap: Map<number, AstNode> = new Map()

  constructor(container: HTMLElement, editor: monaco.editor.IStandaloneCodeEditor) {
    this.container = container
    this.editor = editor
    this.decorations = editor.createDecorationsCollection()
  }

  update(astJson: string, diagnosticsJson: string): void {
    this.activeEl = null
    this.nodeMap.clear()

    const root: AstNode | null = JSON.parse(astJson)

    this.container.innerHTML = ''

    if (!root) {
      const diags: Array<{ message: string, source: string }> = JSON.parse(diagnosticsJson)
      const errors = diags.filter(d => (d as any).severity === 'error')
      const msg = document.createElement('div')
      msg.className = 'fink-ast-empty'
      if (errors.length > 0) {
        msg.textContent = errors.map(e => `${e.source}: ${e.message}`).join('\n')
      } else {
        msg.textContent = '(parse error — no AST)'
      }
      this.container.appendChild(msg)
      this.flat = []
      return
    }

    // Populate nodeMap before rendering so rebuildFlat() can look up nodes.
    walkNodes(root, n => this.nodeMap.set(n.id, n))

    this.renderNode(root, this.container, 0)
    this.rebuildFlat()

    // Sync with current cursor position after update
    const pos = this.editor.getPosition()
    if (pos) {
      this.highlightAtPosition(pos.lineNumber - 1, pos.column - 1)
    }
  }

  // Render one node as a group (row + children wrapper) and recurse.
  private renderNode(node: AstNode, parent: HTMLElement, depth: number): void {
    const hasChildren = node.children.length > 0
    const isCollapsed = this.collapsed.has(node.id)

    // Group wrapper — contains the row + children div.
    const group = document.createElement('div')
    group.className = 'fink-ast-group'

    // Row
    const row = document.createElement('div')
    row.className = 'fink-ast-row'
    row.style.paddingLeft = `${8 + depth * 16}px`
    row.dataset.id = String(node.id)

    // Children wrapper (created here so the chevron listener can reference it)
    const childrenEl = document.createElement('div')
    childrenEl.className = 'fink-ast-children'
    if (isCollapsed) childrenEl.style.display = 'none'

    // Chevron (only for nodes with children)
    const chevron = document.createElement('span')
    chevron.className = 'fink-ast-chevron'
    if (hasChildren) {
      chevron.textContent = isCollapsed ? '▶' : '▼'
      chevron.addEventListener('click', (e) => {
        e.stopPropagation()
        this.toggle(node.id, chevron, childrenEl)
      })
    }
    row.appendChild(chevron)

    const color = colorForKind(node.kind)

    const kindEl = document.createElement('span')
    kindEl.className = 'fink-ast-kind'
    kindEl.textContent = node.kind
    kindEl.style.color = color
    row.appendChild(kindEl)

    if (node.label) {
      const labelEl = document.createElement('span')
      labelEl.className = 'fink-ast-label'
      labelEl.textContent = node.label
        .replace(/\n/g, '↵')
        .replace(/\r/g, '↵')
        .replace(/\t/g, '→')
      row.appendChild(labelEl)
    }

    const locEl = document.createElement('span')
    locEl.className = 'fink-ast-loc'
    const startLoc = `${node.line}:${node.col}`
    const endLoc = `${node.endLine}:${node.endCol}`
    locEl.textContent = startLoc === endLoc ? startLoc : `${startLoc}–${endLoc}`
    row.appendChild(locEl)

    row.addEventListener('click', () => {
      const range = new monaco.Range(
        node.line + 1, node.col + 1,
        node.endLine + 1, node.endCol + 1,
      )
      this.decorations.set([{
        range,
        options: { className: 'fink-token-highlight', isWholeLine: false },
      }])
      this.editor.revealRangeInCenter(range)
      this.editor.setPosition({ lineNumber: node.line + 1, column: node.col + 1 })
    })

    group.appendChild(row)

    for (const child of node.children) {
      this.renderNode(child, childrenEl, depth + 1)
    }

    group.appendChild(childrenEl)
    parent.appendChild(group)
  }

  // Toggle collapsed state for a node.
  private toggle(id: number, chevron: HTMLElement, childrenEl: HTMLElement): void {
    if (this.collapsed.has(id)) {
      this.collapsed.delete(id)
      chevron.textContent = '▼'
      childrenEl.style.display = ''
    } else {
      this.collapsed.add(id)
      chevron.textContent = '▶'
      childrenEl.style.display = 'none'
    }
    this.rebuildFlat()
    // Re-sync the active highlight to visible rows.
    if (this.activeEl) {
      this.activeEl.classList.remove('fink-ast-active')
      this.activeEl = null
    }
    const pos = this.editor.getPosition()
    if (pos) this.highlightAtPosition(pos.lineNumber - 1, pos.column - 1)
  }

  // Walk all .fink-ast-row elements that are not inside a hidden subtree.
  private rebuildFlat(): void {
    this.flat = []
    for (const row of this.container.querySelectorAll<HTMLElement>('.fink-ast-row')) {
      if (!isHiddenRow(row)) {
        const node = this.nodeMap.get(Number(row.dataset.id))
        if (node) this.flat.push({ node, el: row })
      }
    }
  }

  clearEditorHighlight(): void {
    this.decorations.set([])
  }

  // Highlight the deepest visible AST node whose span contains (line, col).
  // "Deepest" = last match in pre-order flat list (parents precede children).
  highlightAtPosition(line: number, col: number): void {
    if (this.activeEl) {
      this.activeEl.classList.remove('fink-ast-active')
      this.activeEl = null
    }

    let best: FlatEntry | null = null
    for (const entry of this.flat) {
      const { node } = entry
      const afterStart =
        node.line < line || (node.line === line && node.col <= col)
      const beforeEnd =
        node.endLine > line || (node.endLine === line && node.endCol > col)
      if (afterStart && beforeEnd) best = entry
    }

    if (!best) return

    best.el.classList.add('fink-ast-active')
    this.activeEl = best.el

    // Scroll into view with padding
    const pad = 48
    const parent = this.container
    const rect = best.el.getBoundingClientRect()
    const pRect = parent.getBoundingClientRect()
    if (rect.top - pRect.top < pad) {
      parent.scrollTop -= pad - (rect.top - pRect.top)
    } else if (pRect.bottom - rect.bottom < pad) {
      parent.scrollTop += pad - (pRect.bottom - rect.bottom)
    }

    this.decorations.set([{
      range: new monaco.Range(
        best.node.line + 1, best.node.col + 1,
        best.node.endLine + 1, best.node.endCol + 1,
      ),
      options: { className: 'fink-token-highlight', isWholeLine: false },
    }])
  }
}

// Returns true if the row has a hidden .fink-ast-children ancestor within the panel.
function isHiddenRow(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el.parentElement
  while (cur && !cur.classList.contains('fink-ast-panel')) {
    if (cur.classList.contains('fink-ast-children') && cur.style.display === 'none') return true
    cur = cur.parentElement
  }
  return false
}

function walkNodes(node: AstNode, fn: (n: AstNode) => void): void {
  fn(node)
  for (const child of node.children) walkNodes(child, fn)
}
