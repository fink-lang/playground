use std::collections::HashSet;
use wasm_bindgen::prelude::*;

use fink::ast::{self, Node, NodeKind};
use fink::lexer::{self, TokenKind};
use fink::parser;
use fink::passes::closure_lifting::lift_all;
use fink::passes::cps::fmt as cps_fmt;
use fink::passes::cps::ir::CpsId;
use fink::passes::cps::transform::lower_expr;
use fink::passes::name_res::{self, Resolution};

// ---------------------------------------------------------------------------
// String literal sub-parsing: split StrText into text + escape segments
// ---------------------------------------------------------------------------

/// A segment of a StrText token — either plain text or an escape sequence.
#[derive(Debug, PartialEq)]
struct StrSegment<'a> {
    kind: &'static str, // "StrText" or "StrEscape"
    src: &'a str,
    col_offset: u32, // offset from the start of the StrText token
}

fn is_hex(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F')
}

fn is_bin(b: u8) -> bool {
    matches!(b, b'0' | b'1')
}

/// Split a StrText token's raw source into StrText and StrEscape segments.
///
/// Recognised escape sequences:
///   \n \r \v \t \b \f \\ \' \$  — single-char escapes
///   \bNN                         — binary literal (exactly 2 binary digits)
///   \xNN                         — hex byte (exactly 2 hex digits)
///   \uNNNNNN                     — unicode codepoint (1–6 hex digits, _ separators)
///   \u{N..N}                     — unicode codepoint, braced (hex digits + _ separators)
///
/// Note: \b is ambiguous — \b followed by exactly 2 binary digits (0/1) is
/// treated as a binary escape; otherwise \b alone is a backspace escape.
fn split_str_escapes(src: &str) -> Vec<StrSegment<'_>> {
    let bytes = src.as_bytes();
    let mut segments: Vec<StrSegment<'_>> = Vec::new();
    let mut i = 0;
    let mut text_start = 0;

    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            i += 1;
            continue;
        }

        // Found a backslash — flush preceding text
        if i > text_start {
            segments.push(StrSegment {
                kind: "StrText",
                src: &src[text_start..i],
                col_offset: text_start as u32,
            });
        }

        let esc_start = i;
        i += 1; // skip backslash
        match bytes[i] {
            b'x' => {
                // \xNN — exactly 2 hex digits
                if i + 2 < bytes.len() && is_hex(bytes[i + 1]) && is_hex(bytes[i + 2]) {
                    i += 3;
                } else {
                    i += 1;
                }
            }
            b'u' => {
                // \u{...} or \uNNNNNN
                if i + 1 < bytes.len() && bytes[i + 1] == b'{' {
                    // Braced form: consume until closing }
                    let mut j = i + 2;
                    while j < bytes.len() && bytes[j] != b'}' {
                        j += 1;
                    }
                    if j < bytes.len() {
                        j += 1; // include the }
                    }
                    i = j;
                } else {
                    // Bare form: 1–6 hex digits with _ separators
                    let mut j = i + 1;
                    let mut digits = 0;
                    while j < bytes.len() && digits < 6 {
                        if bytes[j] == b'_' {
                            j += 1;
                        } else if is_hex(bytes[j]) {
                            digits += 1;
                            j += 1;
                        } else {
                            break;
                        }
                    }
                    if digits > 0 {
                        i = j;
                    } else {
                        i += 1;
                    }
                }
            }
            b'b' => {
                // \bNN (binary) if followed by exactly 2 binary digits,
                // otherwise \b (backspace)
                if i + 2 < bytes.len() && is_bin(bytes[i + 1]) && is_bin(bytes[i + 2]) {
                    i += 3;
                } else {
                    i += 1;
                }
            }
            // Single-char escapes: n r v t f \ ' $
            b'n' | b'r' | b'v' | b't' | b'f' | b'\\' | b'\'' | b'$' => {
                i += 1;
            }
            // Unknown escape — just the backslash + next char
            _ => {
                i += 1;
            }
        }

        segments.push(StrSegment {
            kind: "StrEscape",
            src: &src[esc_start..i],
            col_offset: esc_start as u32,
        });
        text_start = i;
    }

    // Trailing text
    if text_start < bytes.len() {
        segments.push(StrSegment {
            kind: "StrText",
            src: &src[text_start..],
            col_offset: text_start as u32,
        });
    }

    segments
}

// ---------------------------------------------------------------------------
// Numeric literal sub-parsing: split prefix (0x, 0b, 0o) and exponent (e, d)
// ---------------------------------------------------------------------------

/// A segment of a numeric token — either digits or a prefix/exponent marker.
#[derive(Debug, PartialEq)]
struct NumSegment<'a> {
    kind: &'static str, // "NumDigits" or "NumMarker"
    src: &'a str,
    col_offset: u32,
}

/// Split a numeric literal's raw source into digit and marker segments.
///
/// Markers highlighted separately:
///   0x, 0b, 0o          — base prefix (Int tokens)
///   e, e+, e-            — float exponent
///   d, d+, d-            — decimal suffix/exponent
fn split_num_parts<'a>(src: &'a str, kind: &str) -> Vec<NumSegment<'a>> {
    let bytes = src.as_bytes();

    // Base prefixes: 0x, 0b, 0o — only the letter is the marker, not the leading 0
    if kind == "Int" && bytes.len() >= 2 && bytes[0] == b'0' {
        match bytes[1] {
            b'x' | b'b' | b'o' => {
                let mut segs = vec![
                    NumSegment {
                        kind: "NumDigits",
                        src: &src[..1],
                        col_offset: 0,
                    },
                    NumSegment {
                        kind: "NumMarker",
                        src: &src[1..2],
                        col_offset: 1,
                    },
                ];
                if src.len() > 2 {
                    segs.push(NumSegment {
                        kind: "NumDigits",
                        src: &src[2..],
                        col_offset: 2,
                    });
                }
                return segs;
            }
            _ => {}
        }
    }

    // Float exponent: find 'e' not at start — only 'e' is the marker
    if kind == "Float" {
        if let Some(pos) = bytes.iter().position(|&b| b == b'e') {
            if pos > 0 {
                let mut segs = vec![NumSegment {
                    kind: "NumDigits",
                    src: &src[..pos],
                    col_offset: 0,
                }];
                segs.push(NumSegment {
                    kind: "NumMarker",
                    src: &src[pos..pos + 1],
                    col_offset: pos as u32,
                });
                if pos + 1 < bytes.len() {
                    segs.push(NumSegment {
                        kind: "NumDigits",
                        src: &src[pos + 1..],
                        col_offset: (pos + 1) as u32,
                    });
                }
                return segs;
            }
        }
    }

    // Decimal suffix: find 'd' not at start — only 'd' is the marker
    if kind == "Decimal" {
        if let Some(pos) = bytes.iter().position(|&b| b == b'd') {
            if pos > 0 {
                let mut segs = vec![NumSegment {
                    kind: "NumDigits",
                    src: &src[..pos],
                    col_offset: 0,
                }];
                segs.push(NumSegment {
                    kind: "NumMarker",
                    src: &src[pos..pos + 1],
                    col_offset: pos as u32,
                });
                if pos + 1 < bytes.len() {
                    segs.push(NumSegment {
                        kind: "NumDigits",
                        src: &src[pos + 1..],
                        col_offset: (pos + 1) as u32,
                    });
                }
                return segs;
            }
        }
    }

    // No markers — return the whole thing as digits
    vec![NumSegment {
        kind: "NumDigits",
        src,
        col_offset: 0,
    }]
}

// Token type indices (must match TypeScript legend)
const TOKEN_FUNCTION: u32 = 0;
const TOKEN_VARIABLE: u32 = 1;
const TOKEN_PROPERTY: u32 = 2;
const TOKEN_BLOCK_NAME: u32 = 3;
const TOKEN_TAG_LEFT: u32 = 4;
const TOKEN_TAG_RIGHT: u32 = 5;

// Token modifier bits
const MOD_READONLY: u32 = 1; // bit 0

struct RawToken {
    line: u32,   // 0-based
    col: u32,    // 0-based
    length: u32,
    token_type: u32,
    modifiers: u32,
}

/// Resolve the callee of a function application.
/// Follows Member.rhs chain to find the actual callee node.
fn resolve_callee<'a>(node: &'a Node<'a>) -> &'a Node<'a> {
    match &node.kind {
        NodeKind::Member { rhs, .. } => resolve_callee(rhs),
        _ => node,
    }
}

fn emit_token(tokens: &mut Vec<RawToken>, node: &Node, token_type: u32, modifiers: u32) {
    let loc = &node.loc;
    // Rust parser uses 1-based lines, VSCode uses 0-based
    let line = loc.start.line.saturating_sub(1);
    let col = loc.start.col;
    let length = if loc.start.line == loc.end.line {
        loc.end.col - loc.start.col
    } else {
        // For multi-line tokens, just use the first line extent.
        // Identifiers are always single-line so this is a safety fallback.
        1
    };
    tokens.push(RawToken { line, col, length, token_type, modifiers });
}


fn collect_tokens<'src>(node: &'src Node<'src>, tokens: &mut Vec<RawToken>) {
    match &node.kind {
        NodeKind::Apply { func, args } => {
            let callee = resolve_callee(func);
            match &callee.kind {
                NodeKind::Ident(_) => {
                    // Tagged literal: callee adjacent to first arg
                    // Prefix: foo'bar' (callee end == arg start) → tag.left
                    // Postfix: 123foo (arg end == callee start) → tag.right
                    let tag_kind = args.items.first().and_then(|first_arg| {
                        if callee.loc.end.idx == first_arg.loc.start.idx {
                            Some(TOKEN_TAG_LEFT)
                        } else if first_arg.loc.end.idx == callee.loc.start.idx {
                            Some(TOKEN_TAG_RIGHT)
                        } else {
                            None
                        }
                    });
                    if let Some(tag_token) = tag_kind {
                        emit_token(tokens, callee, tag_token, 0);
                    } else {
                        emit_token(tokens, callee, TOKEN_FUNCTION, 0);
                    }
                }
                NodeKind::Group { .. } => {
                    // Emit function token at open and close paren positions
                    let loc = &callee.loc;
                    let open_line = loc.start.line.saturating_sub(1);
                    let close_line = loc.end.line.saturating_sub(1);
                    tokens.push(RawToken {
                        line: open_line,
                        col: loc.start.col,
                        length: 1,
                        token_type: TOKEN_FUNCTION,
                        modifiers: 0,
                    });
                    tokens.push(RawToken {
                        line: close_line,
                        col: loc.end.col.saturating_sub(1),
                        length: 1,
                        token_type: TOKEN_FUNCTION,
                        modifiers: 0,
                    });
                }
                _ => {}
            }
            // Recurse into func and args
            collect_tokens(func, tokens);
            for arg in &args.items {
                collect_tokens(arg, tokens);
            }
        }

        NodeKind::Pipe(children) => {
            for child in &children.items {
                if matches!(&child.kind, NodeKind::Ident(_)) {
                    emit_token(tokens, child, TOKEN_FUNCTION, 0);
                }
                collect_tokens(child, tokens);
            }
        }

        NodeKind::LitRec { items: children, .. } => {
            for child in &children.items {
                if let NodeKind::Arm { lhs, body, .. } = &child.kind {
                    if matches!(&lhs.kind, NodeKind::Ident(_)) {
                        if body.items.is_empty() {
                            emit_token(tokens, lhs, TOKEN_VARIABLE, MOD_READONLY);
                        } else {
                            emit_token(tokens, lhs, TOKEN_PROPERTY, 0);
                        }
                    }
                    // Recurse into arm body
                    for expr in body.items.iter() {
                        collect_tokens(expr, tokens);
                    }
                } else {
                    collect_tokens(child, tokens);
                }
            }
        }

        // --- recurse into all other container nodes ---

        NodeKind::LitSeq { items: children, .. }
        | NodeKind::Module(children)
        | NodeKind::Patterns(children) => {
            for child in &children.items {
                collect_tokens(child, tokens);
            }
        }

        NodeKind::StrTempl { children, .. }
        | NodeKind::StrRawTempl { children, .. } => {
            for child in children {
                collect_tokens(child, tokens);
            }
        }

        NodeKind::InfixOp { lhs, rhs, .. } => {
            collect_tokens(lhs, tokens);
            collect_tokens(rhs, tokens);
        }

        NodeKind::Bind { lhs, rhs, .. }
        | NodeKind::BindRight { lhs, rhs, .. }
        | NodeKind::Member { lhs, rhs, .. } => {
            collect_tokens(lhs, tokens);
            collect_tokens(rhs, tokens);
        }

        NodeKind::UnaryOp { operand, .. } => {
            collect_tokens(operand, tokens);
        }

        NodeKind::Group { inner, .. }
        | NodeKind::Try(inner)
        | NodeKind::Yield(inner) => {
            collect_tokens(inner, tokens);
        }

        NodeKind::Spread { inner: Some(inner), .. } => {
            collect_tokens(inner, tokens);
        }

        NodeKind::Fn { params, body, .. } => {
            collect_tokens(params, tokens);
            for expr in &body.items {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::Match { subjects, arms, .. } => {
            for subject in &subjects.items {
                collect_tokens(subject, tokens);
            }
            for arm in &arms.items {
                collect_tokens(arm, tokens);
            }
        }

        NodeKind::Arm { lhs, body, .. } => {
            // Arms not inside LitRec — just recurse
            collect_tokens(lhs, tokens);
            for expr in &body.items {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::Block { name, params, body, .. } => {
            // Emit namespace token for the block name
            if matches!(&name.kind, NodeKind::Ident(_)) {
                emit_token(tokens, name, TOKEN_BLOCK_NAME, 0);
            }
            collect_tokens(name, tokens);
            collect_tokens(params, tokens);
            for expr in &body.items {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::ChainedCmp(parts) => {
            for part in parts {
                if let fink::ast::CmpPart::Operand(node) = part {
                    collect_tokens(node, tokens);
                }
            }
        }

        // Leaf nodes — no children to recurse into
        NodeKind::Ident(_)
        | NodeKind::LitBool(_)
        | NodeKind::LitInt(_)
        | NodeKind::LitFloat(_)
        | NodeKind::LitDecimal(_)
        | NodeKind::LitStr { .. }
        | NodeKind::Partial
        | NodeKind::Wildcard
        | NodeKind::Spread { inner: None, .. } => {}
    }
}

fn delta_encode(mut tokens: Vec<RawToken>) -> Vec<u32> {
    tokens.sort_by(|a, b| a.line.cmp(&b.line).then(a.col.cmp(&b.col)));

    let mut result = Vec::with_capacity(tokens.len() * 5);
    let mut prev_line: u32 = 0;
    let mut prev_col: u32 = 0;

    for token in &tokens {
        let delta_line = token.line - prev_line;
        let delta_col = if delta_line > 0 { token.col } else { token.col - prev_col };

        result.push(delta_line);
        result.push(delta_col);
        result.push(token.length);
        result.push(token.token_type);
        result.push(token.modifiers);

        prev_line = token.line;
        prev_col = token.col;
    }

    result
}

/// Extract the bind CpsId from a Resolution variant.
fn resolution_bind_id(res: &Option<Resolution>) -> Option<CpsId> {
    match res {
        Some(Resolution::Local(id))
        | Some(Resolution::Captured { bind: id, .. })
        | Some(Resolution::Recursive(id)) => Some(*id),
        _ => None,
    }
}

// --- Pre-computed location data for cursor lookups ---

/// 0-based source location, owned (no borrows).
#[derive(Clone, Copy)]
struct Loc {
    line: u32,
    col: u32,
    end_line: u32,
    end_col: u32,
}

/// An identifier node mapped to its CPS node, for cursor hit-testing.
/// Sorted by (line, col) for binary search.
struct IdentEntry {
    loc: Loc,
    cps_idx: u32,
}

// ---------------------------------------------------------------------------
// AST serialization
// ---------------------------------------------------------------------------

/// Serialize a single AST node (and its subtree) to a JSON object string.
/// Format: {id, kind, label, line, col, endLine, endCol, children:[...]}
/// line/col are 0-based (loc.start.line is 1-based in the AST, so we subtract 1).
fn serialize_node(node: &ast::Node) -> String {
    let id = node.id.0;
    let line = node.loc.start.line.saturating_sub(1);
    let col = node.loc.start.col;
    let end_line = node.loc.end.line.saturating_sub(1);
    let end_col = node.loc.end.col;

    let (kind, label) = node_kind_label(node);
    let label_escaped = label
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");

    let children = serialize_children(node);
    format!(
        r#"{{"id":{id},"kind":"{kind}","label":"{label_escaped}","line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"children":[{children}]}}"#
    )
}

/// Returns `(kind_str, label_str)` for a node — the discriminant name and a
/// concise inline annotation (op token, literal value, identifier name, etc.).
fn node_kind_label<'a>(node: &'a ast::Node<'a>) -> (&'static str, String) {
    use ast::NodeKind::*;
    match &node.kind {
        LitBool(v)      => ("LitBool",    if *v { "true".into() } else { "false".into() }),
        LitInt(s)       => ("LitInt",     s.to_string()),
        LitFloat(s)     => ("LitFloat",   s.to_string()),
        LitDecimal(s)   => ("LitDecimal", s.to_string()),
        LitStr { content, .. } => {
            let preview: String = content.chars().take(20).collect();
            let suffix = if content.len() > 20 { "…" } else { "" };
            ("LitStr", format!("'{preview}{suffix}'"))
        }
        LitSeq { open, close, .. } => ("LitSeq", format!("{}…{}", open.src, close.src)),
        LitRec { open, close, .. } => ("LitRec", format!("{}…{}", open.src, close.src)),
        StrTempl { .. }    => ("StrTempl",    String::new()),
        StrRawTempl { .. } => ("StrRawTempl", String::new()),
        Ident(s)           => ("Ident",       s.to_string()),
        UnaryOp { op, .. } => ("UnaryOp",     op.src.to_string()),
        InfixOp { op, .. } => ("InfixOp",     op.src.to_string()),
        ChainedCmp(_)      => ("ChainedCmp",  String::new()),
        Spread { op, .. }  => ("Spread",      op.src.to_string()),
        Member { op, .. }  => ("Member",      op.src.to_string()),
        Group { .. }       => ("Group",       String::new()),
        Partial            => ("Partial",     String::new()),
        Wildcard           => ("Wildcard",    String::new()),
        Bind { op, .. }    => ("Bind",        op.src.to_string()),
        BindRight { op, .. } => ("BindRight", op.src.to_string()),
        Apply { .. }       => ("Apply",       String::new()),
        Pipe(_)            => ("Pipe",        String::new()),
        Fn { sep, .. }     => ("Fn",          sep.src.to_string()),
        Patterns(_)        => ("Patterns",    String::new()),
        Match { sep, .. }  => ("Match",       sep.src.to_string()),
        Arm { sep, .. }    => ("Arm",         sep.src.to_string()),
        Try(_)             => ("Try",         String::new()),
        Yield(_)           => ("Yield",       String::new()),
        Block { sep, .. }  => ("Block",       sep.src.to_string()),
        Module(_)          => ("Module",      String::new()),
    }
}

/// Serialize the direct children of a node as a comma-joined JSON array body.
fn serialize_children(node: &ast::Node) -> String {
    use ast::{CmpPart, NodeKind::*};
    let mut parts: Vec<String> = Vec::new();

    match &node.kind {
        LitBool(_) | LitInt(_) | LitFloat(_) | LitDecimal(_) | LitStr { .. }
        | Ident(_) | Partial | Wildcard => {}

        LitSeq { items, .. } | LitRec { items, .. } | Pipe(items) | Patterns(items)
        | Module(items) => {
            for child in &items.items { parts.push(serialize_node(child)); }
        }
        StrTempl { children, .. } | StrRawTempl { children, .. } => {
            for child in children { parts.push(serialize_node(child)); }
        }
        UnaryOp { operand, .. } | Try(operand) | Yield(operand) => {
            parts.push(serialize_node(operand));
        }
        InfixOp { lhs, rhs, .. }
        | Bind { lhs, rhs, .. }
        | BindRight { lhs, rhs, .. }
        | Member { lhs, rhs, .. } => {
            parts.push(serialize_node(lhs));
            parts.push(serialize_node(rhs));
        }
        ChainedCmp(cmp_parts) => {
            for p in cmp_parts {
                if let CmpPart::Operand(n) = p { parts.push(serialize_node(n)); }
            }
        }
        Spread { inner, .. } => {
            if let Some(n) = inner { parts.push(serialize_node(n)); }
        }
        Group { inner, .. } => { parts.push(serialize_node(inner)); }
        Apply { func, args } => {
            parts.push(serialize_node(func));
            for arg in &args.items { parts.push(serialize_node(arg)); }
        }
        Fn { params, body, .. } => {
            parts.push(serialize_node(params));
            for stmt in &body.items { parts.push(serialize_node(stmt)); }
        }
        Match { subjects, arms, .. } => {
            for subject in &subjects.items { parts.push(serialize_node(subject)); }
            for arm in &arms.items { parts.push(serialize_node(arm)); }
        }
        Arm { lhs, body, .. } => {
            parts.push(serialize_node(lhs));
            for stmt in &body.items { parts.push(serialize_node(stmt)); }
        }
        Block { name, params, body, .. } => {
            parts.push(serialize_node(name));
            parts.push(serialize_node(params));
            for stmt in &body.items { parts.push(serialize_node(stmt)); }
        }
    }

    parts.join(",")
}

// ---------------------------------------------------------------------------
// Compiler: Fink source → WASM binary
// ---------------------------------------------------------------------------

/// Compile Fink source to a WASM binary.
/// Returns the raw bytes on success, or throws a JS error on failure.
#[wasm_bindgen]
pub fn compile(src: &str) -> Result<Vec<u8>, JsValue> {
    use fink::ast::build_index;
    use fink::parser::parse;
    use fink::passes::closure_lifting::lift_all;
    use fink::passes::cps::transform::lower_expr;
    use fink::passes::wasm::codegen::codegen;

    let r = parse(src).map_err(|e| JsValue::from_str(&e.message))?;
    let ast_index = build_index(&r);
    let cps = lower_expr(&r.root);
    let (lifted, resolved) = lift_all(cps, &ast_index);
    let result = codegen(&lifted, &resolved, &ast_index);
    Ok(result.wasm)
}

// ---------------------------------------------------------------------------

/// Stateful parsed document - parse once, query many times.
/// Stores only owned data: no borrows, no lifetimes.
#[wasm_bindgen]
pub struct ParsedDocument {
    /// Original source text — used to re-run passes on demand (e.g. get_cps).
    src: String,

    /// Delta-encoded semantic tokens, ready to return to VS Code.
    semantic_tokens: Vec<u32>,

    /// JSON diagnostics string, ready to return to VS Code.
    diagnostics: String,

    /// JSON lexer tokens string — raw token list from the lexer.
    /// Each token: {kind, src, line, col, endLine, endCol}
    /// line/col are 0-based. Available even when parsing fails.
    lexer_tokens: String,

    /// JSON highlight tokens string — sub-parsed for syntax highlighting.
    /// StrText split into StrText/StrEscape; numbers split into NumDigits/NumMarker.
    highlight_tokens: String,

    /// Source location for each CPS node (indexed by CpsId.0).
    /// None if the CPS node has no AST origin or origin has no location.
    node_locs: Vec<Option<Loc>>,

    /// For each CPS node, the binding CpsId it resolves to.
    /// If the node IS a binding site, points to itself.
    /// None if unresolved or not an identifier.
    bind_ids: Vec<Option<u32>>,

    /// Identifier nodes sorted by position, for cursor hit-testing.
    idents: Vec<IdentEntry>,
}

#[wasm_bindgen]
impl ParsedDocument {
    /// Parse source code and pre-compute all provider data.
    #[wasm_bindgen(constructor)]
    pub fn new(src: &str) -> ParsedDocument {
        // --- Lex: collect all tokens + diagnostics in one pass ---
        let mut diag_entries: Vec<String> = Vec::new();
        let mut raw_token_entries: Vec<String> = Vec::new();
        let mut highlight_token_entries: Vec<String> = Vec::new();
        let lexer = lexer::tokenize_with_seps(src, &[
            b"+", b"-", b"*", b"/", b"//", b"**", b"%", b"%%", b"/%",
            b"==", b"!=", b"<", b"<=", b">", b">=", b"><",
            b"&", b"^", b"~", b">>", b"<<", b">>>", b"<<<",
            b".", b"|", b"|=", b"=", b"..", b"...",
        ]);
        for tok in lexer {
            let line = tok.loc.start.line.saturating_sub(1);
            let col = tok.loc.start.col;
            let end_line = tok.loc.end.line.saturating_sub(1);
            let end_col = tok.loc.end.col;
            let src_escaped = tok.src.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t");
            let kind = format!("{:?}", tok.kind);

            // Raw token — always emitted as-is
            raw_token_entries.push(format!(
                r#"{{"kind":"{kind}","src":"{src_escaped}","line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col}}}"#
            ));

            // Highlight tokens — sub-parsed for syntax highlighting
            if tok.kind == TokenKind::StrText {
                let segments = split_str_escapes(tok.src);
                for seg in &segments {
                    let seg_col = col + seg.col_offset;
                    let seg_end_col = seg_col + seg.src.len() as u32;
                    let seg_src_escaped = seg.src.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t");
                    highlight_token_entries.push(format!(
                        r#"{{"kind":"{kind}","src":"{seg_src_escaped}","line":{line},"col":{seg_col},"endLine":{end_line},"endCol":{seg_end_col}}}"#,
                        kind = seg.kind,
                    ));
                }
            } else if matches!(tok.kind, TokenKind::Int | TokenKind::Float | TokenKind::Decimal) {
                let segments = split_num_parts(tok.src, &kind);
                if segments.len() > 1 {
                    for seg in &segments {
                        let seg_col = col + seg.col_offset;
                        let seg_end_col = seg_col + seg.src.len() as u32;
                        highlight_token_entries.push(format!(
                            r#"{{"kind":"{kind}","src":"{src}","line":{line},"col":{seg_col},"endLine":{end_line},"endCol":{seg_end_col}}}"#,
                            kind = seg.kind,
                            src = seg.src,
                        ));
                    }
                } else {
                    highlight_token_entries.push(format!(
                        r#"{{"kind":"{kind}","src":"{src_escaped}","line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col}}}"#
                    ));
                }
            } else {
                highlight_token_entries.push(format!(
                    r#"{{"kind":"{kind}","src":"{src_escaped}","line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col}}}"#
                ));
            }

            if tok.kind == TokenKind::Err {
                diag_entries.push(format!(
                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{src_escaped}","source":"lexer","severity":"error"}}"#
                ));
            }
        }
        let lexer_tokens = format!("[{}]", raw_token_entries.join(","));
        let highlight_tokens = format!("[{}]", highlight_token_entries.join(","));

        // --- Parse ---
        let parse_result = match parser::parse(src) {
            Ok(r) => r,
            Err(e) => {
                // Parser failed — return diagnostics only, empty provider data
                let line = e.loc.start.line.saturating_sub(1);
                let col = e.loc.start.col;
                let end_line = e.loc.end.line.saturating_sub(1);
                let end_col = e.loc.end.col;
                let msg = e.message.replace('\\', "\\\\").replace('"', "\\\"");
                diag_entries.push(format!(
                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"parser","severity":"error"}}"#
                ));
                return ParsedDocument {
                    src: src.to_string(),
                    semantic_tokens: vec![],
                    diagnostics: format!("[{}]", diag_entries.join(",")),
                    lexer_tokens,
                    highlight_tokens,
                    node_locs: vec![],
                    bind_ids: vec![],
                    idents: vec![],
                };
            }
        };

        // --- Semantic tokens ---
        let mut raw_tokens = Vec::new();
        collect_tokens(&parse_result.root, &mut raw_tokens);
        let semantic_tokens = delta_encode(raw_tokens);

        ParsedDocument {
            src: src.to_string(),
            semantic_tokens,
            diagnostics: format!("[{}]", diag_entries.join(",")),
            lexer_tokens,
            highlight_tokens,
            node_locs: vec![],
            bind_ids: vec![],
            idents: vec![],
        }
    }

    /// Run CPS transform + name resolution.
    /// Called separately from new() so that a panic (wasm trap) in the CPS
    /// pass doesn't take down lexing, parsing, or semantic tokens.
    /// On success, updates diagnostics with name-resolution warnings/errors.
    pub fn run_analysis(&mut self) {
        let parse_result = match parser::parse(&self.src) {
            Ok(r) => r,
            Err(_) => return,
        };

        let ast_index = ast::build_index(&parse_result);
        let cps = lower_expr(&parse_result.root);
        let node_count = cps.origin.len();
        let resolved = name_res::resolve(&cps.root, &cps.origin, &ast_index, node_count, &cps.synth_alias);

        let mut node_locs: Vec<Option<Loc>> = Vec::with_capacity(node_count);
        let mut bind_ids: Vec<Option<u32>> = Vec::with_capacity(node_count);
        let mut idents: Vec<IdentEntry> = Vec::new();
        let mut diag_entries: Vec<String> = Vec::new();

        let root_scope_id = cps.root.id;
        let mut bind_sites: Vec<u32> = Vec::new();
        let mut used_binds: HashSet<u32> = HashSet::new();

        for i in 0..node_count {
            let cps_id = CpsId(i as u32);

            let loc = cps.origin.get(cps_id)
                .and_then(|ast_id| *ast_index.get(ast_id))
                .map(|node| Loc {
                    line: node.loc.start.line.saturating_sub(1),
                    col: node.loc.start.col,
                    end_line: node.loc.end.line.saturating_sub(1),
                    end_col: node.loc.end.col,
                });
            node_locs.push(loc);

            let bind_id = if let Some(id) = resolution_bind_id(resolved.resolution.get(cps_id)) {
                used_binds.insert(id.0);
                Some(id.0)
            } else if resolved.bind_scope.get(cps_id).is_some() {
                bind_sites.push(i as u32);
                Some(i as u32)
            } else {
                None
            };
            bind_ids.push(bind_id);

            if let Some(loc) = loc {
                if let Some(ast_id) = *cps.origin.get(cps_id) {
                    if let Some(node) = *ast_index.get(ast_id) {
                        if matches!(&node.kind, NodeKind::Ident(_)) {
                            idents.push(IdentEntry { loc, cps_idx: i as u32 });
                        }
                    }
                }
            }

            if let Some(Resolution::Unresolved) = resolved.resolution.get(cps_id) {
                if let Some(ast_id) = *cps.origin.get(cps_id) {
                    if let Some(node) = *ast_index.get(ast_id) {
                        let line = node.loc.start.line.saturating_sub(1);
                        let col = node.loc.start.col;
                        let end_line = node.loc.end.line.saturating_sub(1);
                        let end_col = node.loc.end.col;
                        let name = match &node.kind {
                            NodeKind::Ident(s) => s.replace('\\', "\\\\").replace('"', "\\\""),
                            _ => "?".to_string(),
                        };
                        diag_entries.push(format!(
                            r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unresolved name '{name}'","source":"name_res","severity":"error"}}"#
                        ));
                    }
                }
            }
        }

        let is_multi_expr = matches!(&parse_result.root.kind,
            NodeKind::Module(exprs) if exprs.items.len() > 1);

        for bind_idx in bind_sites {
            if used_binds.contains(&bind_idx) { continue; }
            let cps_id = CpsId(bind_idx);

            // Skip non-Ident bind sites (synthetic CPS nodes from lambdas,
            // pattern matching, etc.)
            let is_ident = cps.origin.get(cps_id)
                .and_then(|ast_id| *ast_index.get(ast_id))
                .is_some_and(|node| matches!(&node.kind, NodeKind::Ident(_)));
            if !is_ident { continue; }

            // Skip module-level bindings (they are exports).
            // Single-expr module: bindings are directly in root scope.
            // Multi-expr module: bindings are in the synthetic module fn
            // scope, whose parent_scope is root.
            if let Some(scope) = resolved.bind_scope.get(cps_id) {
                if *scope == root_scope_id { continue; }
                if is_multi_expr {
                    let parent_is_root = resolved.parent_scope.try_get(*scope)
                        .and_then(|p| *p)
                        .is_some_and(|parent| parent == root_scope_id);
                    if parent_is_root { continue; }
                }
            }

            if let Some(ast_id) = *cps.origin.get(cps_id) {
                if let Some(node) = *ast_index.get(ast_id) {
                    let line = node.loc.start.line.saturating_sub(1);
                    let col = node.loc.start.col;
                    let end_line = node.loc.end.line.saturating_sub(1);
                    let end_col = node.loc.end.col;
                    let name = match &node.kind {
                        NodeKind::Ident(s) => s.replace('\\', "\\\\").replace('"', "\\\""),
                        _ => continue,
                    };
                    diag_entries.push(format!(
                        r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unused binding '{name}'","source":"name_res","severity":"warning"}}"#
                    ));
                }
            }
        }

        idents.sort_by(|a, b| a.loc.line.cmp(&b.loc.line).then(a.loc.col.cmp(&b.loc.col)));

        self.node_locs = node_locs;
        self.bind_ids = bind_ids;
        self.idents = idents;

        // Merge analysis diagnostics into existing diagnostics
        if !diag_entries.is_empty() {
            let existing = &self.diagnostics;
            if existing == "[]" {
                self.diagnostics = format!("[{}]", diag_entries.join(","));
            } else {
                // Insert before closing ']'
                let base = &existing[..existing.len() - 1];
                self.diagnostics = format!("{},{}]", base, diag_entries.join(","));
            }
        }
    }

    /// Return raw lexer tokens as a JSON string.
    /// Each token: {kind, src, line, col, endLine, endCol} — line/col are 0-based.
    /// Available even when parsing fails.
    pub fn get_tokens(&self) -> String {
        self.lexer_tokens.clone()
    }

    /// Return sub-parsed tokens for syntax highlighting as a JSON string.
    /// StrText split into StrText/StrEscape; numbers split into NumDigits/NumMarker.
    pub fn get_highlight_tokens(&self) -> String {
        self.highlight_tokens.clone()
    }

    /// Return delta-encoded semantic tokens.
    pub fn get_semantic_tokens(&self) -> Vec<u32> {
        self.semantic_tokens.clone()
    }

    /// Return JSON diagnostics string.
    pub fn get_diagnostics(&self) -> String {
        self.diagnostics.clone()
    }

    /// Look up the definition site for the identifier at (line, col).
    /// Returns [def_line, def_col, def_end_line, def_end_col] or empty.
    pub fn get_definition(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_idx) = self.find_bind_at(line, col) else { return vec![] };
        let Some(loc) = self.node_locs[bind_idx as usize] else { return vec![] };
        vec![loc.line, loc.col, loc.end_line, loc.end_col]
    }

    /// Find all references to the identifier at (line, col), including the binding site.
    /// Returns [line, col, end_line, end_col, ...] (4 u32s per location) or empty.
    /// First entry is always the binding site.
    pub fn get_references(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_idx) = self.find_bind_at(line, col) else { return vec![] };

        let mut locs = Vec::new();

        // Binding site first
        if let Some(loc) = self.node_locs[bind_idx as usize] {
            locs.push(loc.line);
            locs.push(loc.col);
            locs.push(loc.end_line);
            locs.push(loc.end_col);
        }

        // All references that resolve to this binding
        for (i, bind_id) in self.bind_ids.iter().enumerate() {
            if let Some(id) = bind_id {
                if *id == bind_idx && i as u32 != bind_idx {
                    if let Some(loc) = self.node_locs[i] {
                        locs.push(loc.line);
                        locs.push(loc.col);
                        locs.push(loc.end_line);
                        locs.push(loc.end_col);
                    }
                }
            }
        }

        locs
    }

    /// Return the AST as a nested JSON tree.
    /// Each node: {id, kind, label, line, col, endLine, endCol, children:[...]}.
    /// line/col are 0-based, matching get_tokens().
    /// Returns `null` if the source fails to parse.
    pub fn get_ast(&self) -> String {
        let r = match parser::parse(&self.src) {
            Ok(r) => r,
            Err(_) => return "null".to_string(),
        };
        serialize_node(&r.root)
    }

    /// Return CPS output as JSON: `{"code": "...", "map": "..."}`.
    /// `code` is the CPS-transformed source formatted as valid Fink.
    /// `map` is a Source Map v3 JSON string mapping CPS output positions back
    /// to original source locations via CpsId → AstId → ast_node.loc.
    /// Returns `{"code":"","map":""}` if the source fails to parse.
    pub fn get_cps(&self) -> String {
        let r = match parser::parse(&self.src) {
            Ok(r) => r,
            Err(_) => return r#"{"code":"","map":""}"#.to_string(),
        };
        let ast_index = ast::build_index(&r);
        let cps = lower_expr(&r.root);
        let ctx = cps_fmt::Ctx { origin: &cps.origin, ast_index: &ast_index, captures: None };
        let (code, map) = cps_fmt::fmt_with_mapped(&cps.root, &ctx, "input.fnk");
        let map_json = map.to_json();
        let code_escaped = code.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t");
        let map_escaped = map_json.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t");
        format!(r#"{{"code":"{code_escaped}","map":"{map_escaped}"}}"#)
    }

    /// Return lifted CPS output as JSON: `{"code": "...", "map": "..."}`.
    /// Runs the full pipeline: parse → CPS → cont_lifting + closure_lifting (lift_all)
    /// → format with sourcemap.
    /// Returns `{"code":"","map":""}` if the source fails to parse.
    pub fn get_cps_lifted(&self) -> String {
        let r = match parser::parse(&self.src) {
            Ok(r) => r,
            Err(_) => return r#"{"code":"","map":""}"#.to_string(),
        };
        let ast_index = ast::build_index(&r);
        let cps = lower_expr(&r.root);
        let (lifted, _) = lift_all(cps, &ast_index);
        let ctx = cps_fmt::Ctx { origin: &lifted.origin, ast_index: &ast_index, captures: None };
        let (code, map) = cps_fmt::fmt_with_mapped(&lifted.root, &ctx, "input.fnk");
        let map_json = map.to_json();
        let code_escaped = code.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t");
        let map_escaped = map_json.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t");
        format!(r#"{{"code":"{code_escaped}","map":"{map_escaped}"}}"#)
    }
}

impl ParsedDocument {
    /// Find the binding CpsId for the identifier at (line, col).
    /// Returns None if no identifier found or it doesn't resolve.
    fn find_bind_at(&self, line: u32, col: u32) -> Option<u32> {
        // Linear scan through idents (typically small, sorted by position)
        for entry in &self.idents {
            if entry.loc.line == line && entry.loc.col <= col && col < entry.loc.end_col {
                return self.bind_ids[entry.cps_idx as usize];
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_escapes() {
        let segs = split_str_escapes("hello world");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrText", src: "hello world", col_offset: 0 },
        ]);
    }

    #[test]
    fn empty_string() {
        let segs = split_str_escapes("");
        assert_eq!(segs, vec![]);
    }

    #[test]
    fn single_char_escapes() {
        // \n \r \v \t \f \\ \' \$
        for (input, esc) in [
            (r"\n", r"\n"), (r"\r", r"\r"), (r"\v", r"\v"),
            (r"\t", r"\t"), (r"\f", r"\f"),
            (r"\\", r"\\"), (r"\'", r"\'"), (r"\$", r"\$"),
        ] {
            let segs = split_str_escapes(input);
            assert_eq!(segs, vec![
                StrSegment { kind: "StrEscape", src: esc, col_offset: 0 },
            ], "failed for input: {input}");
        }
    }

    #[test]
    fn backspace_escape() {
        // \b alone is backspace
        let segs = split_str_escapes(r"\b");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\b", col_offset: 0 },
        ]);
    }

    #[test]
    fn binary_escape() {
        // \b followed by 2 binary digits is a binary escape
        let segs = split_str_escapes(r"\b01");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\b01", col_offset: 0 },
        ]);
        let segs = split_str_escapes(r"\b10");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\b10", col_offset: 0 },
        ]);
    }

    #[test]
    fn binary_vs_backspace() {
        // \b followed by non-binary digit: backspace only
        let segs = split_str_escapes(r"\b2");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\b", col_offset: 0 },
            StrSegment { kind: "StrText", src: "2", col_offset: 2 },
        ]);
        // \b followed by only 1 binary digit: backspace only
        let segs = split_str_escapes(r"\b0x");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\b", col_offset: 0 },
            StrSegment { kind: "StrText", src: "0x", col_offset: 2 },
        ]);
    }

    #[test]
    fn hex_escape() {
        let segs = split_str_escapes(r"\x0f");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\x0f", col_offset: 0 },
        ]);
        let segs = split_str_escapes(r"\xFF");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\xFF", col_offset: 0 },
        ]);
    }

    #[test]
    fn hex_escape_incomplete() {
        // Only 1 hex digit — not a valid hex escape, still an escape though
        let segs = split_str_escapes(r"\x1");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\x", col_offset: 0 },
            StrSegment { kind: "StrText", src: "1", col_offset: 2 },
        ]);
    }

    #[test]
    fn unicode_bare() {
        let segs = split_str_escapes(r"\u0041");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\u0041", col_offset: 0 },
        ]);
    }

    #[test]
    fn unicode_bare_with_separators() {
        let segs = split_str_escapes(r"\u00_41");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\u00_41", col_offset: 0 },
        ]);
    }

    #[test]
    fn unicode_bare_max_digits() {
        let segs = split_str_escapes(r"\u10FFFF");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\u10FFFF", col_offset: 0 },
        ]);
    }

    #[test]
    fn unicode_bare_with_trailing() {
        // 6 hex digits consumed, rest is text
        let segs = split_str_escapes(r"\u10FFFFhello");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\u10FFFF", col_offset: 0 },
            StrSegment { kind: "StrText", src: "hello", col_offset: 8 },
        ]);
    }

    #[test]
    fn unicode_braced() {
        let segs = split_str_escapes(r"\u{0041}");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\u{0041}", col_offset: 0 },
        ]);
    }

    #[test]
    fn unicode_braced_with_separators() {
        let segs = split_str_escapes(r"\u{10_ff_ff}");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\u{10_ff_ff}", col_offset: 0 },
        ]);
    }

    #[test]
    fn mixed_text_and_escapes() {
        let segs = split_str_escapes(r"hello\nworld\x0f!");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrText", src: "hello", col_offset: 0 },
            StrSegment { kind: "StrEscape", src: r"\n", col_offset: 5 },
            StrSegment { kind: "StrText", src: "world", col_offset: 7 },
            StrSegment { kind: "StrEscape", src: r"\x0f", col_offset: 12 },
            StrSegment { kind: "StrText", src: "!", col_offset: 16 },
        ]);
    }

    #[test]
    fn consecutive_escapes() {
        let segs = split_str_escapes(r"\n\t\\");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\n", col_offset: 0 },
            StrSegment { kind: "StrEscape", src: r"\t", col_offset: 2 },
            StrSegment { kind: "StrEscape", src: r"\\", col_offset: 4 },
        ]);
    }

    #[test]
    fn trailing_backslash() {
        // Lone trailing backslash — treated as unknown escape (no next char)
        let segs = split_str_escapes("hello\\");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrText", src: "hello\\", col_offset: 0 },
        ]);
    }

    // --- Numeric literal sub-parsing ---

    #[test]
    fn num_plain_int() {
        let segs = split_num_parts("123", "Int");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "123", col_offset: 0 },
        ]);
    }

    #[test]
    fn num_hex_prefix() {
        let segs = split_num_parts("0xFF", "Int");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "0", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "x", col_offset: 1 },
            NumSegment { kind: "NumDigits", src: "FF", col_offset: 2 },
        ]);
    }

    #[test]
    fn num_bin_prefix() {
        let segs = split_num_parts("0b1010", "Int");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "0", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "b", col_offset: 1 },
            NumSegment { kind: "NumDigits", src: "1010", col_offset: 2 },
        ]);
    }

    #[test]
    fn num_oct_prefix() {
        let segs = split_num_parts("0o77", "Int");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "0", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "o", col_offset: 1 },
            NumSegment { kind: "NumDigits", src: "77", col_offset: 2 },
        ]);
    }

    #[test]
    fn num_float_exponent() {
        let segs = split_num_parts("1.2e10", "Float");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "1.2", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "e", col_offset: 3 },
            NumSegment { kind: "NumDigits", src: "10", col_offset: 4 },
        ]);
    }

    #[test]
    fn num_float_exponent_signed() {
        let segs = split_num_parts("1.2e+10", "Float");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "1.2", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "e", col_offset: 3 },
            NumSegment { kind: "NumDigits", src: "+10", col_offset: 4 },
        ]);
        let segs = split_num_parts("1.2e-3", "Float");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "1.2", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "e", col_offset: 3 },
            NumSegment { kind: "NumDigits", src: "-3", col_offset: 4 },
        ]);
    }

    #[test]
    fn num_plain_float() {
        // No exponent — just digits
        let segs = split_num_parts("3.14", "Float");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "3.14", col_offset: 0 },
        ]);
    }

    #[test]
    fn num_decimal_suffix() {
        let segs = split_num_parts("123d", "Decimal");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "123", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "d", col_offset: 3 },
        ]);
    }

    #[test]
    fn num_decimal_exponent() {
        let segs = split_num_parts("1.2d+10", "Decimal");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "1.2", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "d", col_offset: 3 },
            NumSegment { kind: "NumDigits", src: "+10", col_offset: 4 },
        ]);
        let segs = split_num_parts("1.2d-3", "Decimal");
        assert_eq!(segs, vec![
            NumSegment { kind: "NumDigits", src: "1.2", col_offset: 0 },
            NumSegment { kind: "NumMarker", src: "d", col_offset: 3 },
            NumSegment { kind: "NumDigits", src: "-3", col_offset: 4 },
        ]);
    }
}
