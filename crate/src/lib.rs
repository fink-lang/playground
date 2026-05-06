use std::collections::HashSet;
use wasm_bindgen::prelude::*;

use fink::ast::{self, Ast, AstId, NodeKind};
use fink::lexer::{self, TokenKind};
use fink::parser;
use fink::passes::cps::fmt as cps_fmt;
use fink::passes::scopes::{self, BindId, BindOrigin, RefKind, ScopeEvent, ScopeKind};
use fink::sourcemap::native::SourceMap as NativeSourceMap;

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

        if i > text_start {
            segments.push(StrSegment {
                kind: "StrText",
                src: &src[text_start..i],
                col_offset: text_start as u32,
            });
        }

        let esc_start = i;
        i += 1;
        match bytes[i] {
            b'x' => {
                if i + 2 < bytes.len() && is_hex(bytes[i + 1]) && is_hex(bytes[i + 2]) {
                    i += 3;
                } else {
                    i += 1;
                }
            }
            b'u' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'{' {
                    let mut j = i + 2;
                    while j < bytes.len() && bytes[j] != b'}' {
                        j += 1;
                    }
                    if j < bytes.len() {
                        j += 1;
                    }
                    i = j;
                } else {
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
                if i + 2 < bytes.len() && is_bin(bytes[i + 1]) && is_bin(bytes[i + 2]) {
                    i += 3;
                } else {
                    i += 1;
                }
            }
            b'n' | b'r' | b'v' | b't' | b'f' | b'\\' | b'\'' | b'$' => {
                i += 1;
            }
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
// Numeric literal sub-parsing
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct NumSegment<'a> {
    kind: &'static str,
    src: &'a str,
    col_offset: u32,
}

fn split_num_parts<'a>(src: &'a str, kind: &str) -> Vec<NumSegment<'a>> {
    let bytes = src.as_bytes();

    if kind == "Int" && bytes.len() >= 2 && bytes[0] == b'0' {
        match bytes[1] {
            b'x' | b'b' | b'o' => {
                let mut segs = vec![
                    NumSegment { kind: "NumDigits", src: &src[..1], col_offset: 0 },
                    NumSegment { kind: "NumMarker", src: &src[1..2], col_offset: 1 },
                ];
                if src.len() > 2 {
                    segs.push(NumSegment { kind: "NumDigits", src: &src[2..], col_offset: 2 });
                }
                return segs;
            }
            _ => {}
        }
    }

    if kind == "Float" {
        if let Some(pos) = bytes.iter().position(|&b| b == b'e') {
            if pos > 0 {
                let mut segs = vec![NumSegment { kind: "NumDigits", src: &src[..pos], col_offset: 0 }];
                segs.push(NumSegment { kind: "NumMarker", src: &src[pos..pos + 1], col_offset: pos as u32 });
                if pos + 1 < bytes.len() {
                    segs.push(NumSegment { kind: "NumDigits", src: &src[pos + 1..], col_offset: (pos + 1) as u32 });
                }
                return segs;
            }
        }
    }

    if kind == "Decimal" {
        if let Some(pos) = bytes.iter().position(|&b| b == b'd') {
            if pos > 0 {
                let mut segs = vec![NumSegment { kind: "NumDigits", src: &src[..pos], col_offset: 0 }];
                segs.push(NumSegment { kind: "NumMarker", src: &src[pos..pos + 1], col_offset: pos as u32 });
                if pos + 1 < bytes.len() {
                    segs.push(NumSegment { kind: "NumDigits", src: &src[pos + 1..], col_offset: (pos + 1) as u32 });
                }
                return segs;
            }
        }
    }

    vec![NumSegment { kind: "NumDigits", src, col_offset: 0 }]
}

// ---------------------------------------------------------------------------
// Semantic tokens
// ---------------------------------------------------------------------------

const TOKEN_FUNCTION: u32 = 0;
const TOKEN_VARIABLE: u32 = 1;
const TOKEN_PROPERTY: u32 = 2;
const TOKEN_BLOCK_NAME: u32 = 3;
const TOKEN_TAG_LEFT: u32 = 4;
const TOKEN_TAG_RIGHT: u32 = 5;

const MOD_READONLY: u32 = 1;

struct RawToken {
    line: u32,
    col: u32,
    length: u32,
    token_type: u32,
    modifiers: u32,
}

/// Resolve the callee of a function application by following Member.rhs.
fn resolve_callee(ast: &Ast<'_>, id: AstId) -> AstId {
    match &ast.nodes.get(id).kind {
        NodeKind::Member { rhs, .. } => resolve_callee(ast, *rhs),
        _ => id,
    }
}

fn emit_token(tokens: &mut Vec<RawToken>, ast: &Ast<'_>, id: AstId, token_type: u32, modifiers: u32) {
    let loc = &ast.nodes.get(id).loc;
    let line = loc.start.line.saturating_sub(1);
    let col = loc.start.col;
    let length = if loc.start.line == loc.end.line {
        loc.end.col - loc.start.col
    } else {
        1
    };
    tokens.push(RawToken { line, col, length, token_type, modifiers });
}

fn collect_tokens(ast: &Ast<'_>, id: AstId, tokens: &mut Vec<RawToken>) {
    let node = ast.nodes.get(id);
    match &node.kind {
        NodeKind::Apply { func, args } => {
            let callee_id = resolve_callee(ast, *func);
            let callee = ast.nodes.get(callee_id);
            match &callee.kind {
                NodeKind::Ident(_) => {
                    let tag_kind = args.items.first().and_then(|first_arg_id| {
                        let first_arg = ast.nodes.get(*first_arg_id);
                        if callee.loc.end.idx == first_arg.loc.start.idx {
                            Some(TOKEN_TAG_LEFT)
                        } else if first_arg.loc.end.idx == callee.loc.start.idx {
                            Some(TOKEN_TAG_RIGHT)
                        } else {
                            None
                        }
                    });
                    if let Some(tag_token) = tag_kind {
                        emit_token(tokens, ast, callee_id, tag_token, 0);
                    } else {
                        emit_token(tokens, ast, callee_id, TOKEN_FUNCTION, 0);
                    }
                }
                NodeKind::Group { .. } => {
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
            collect_tokens(ast, *func, tokens);
            for arg_id in args.items.iter() {
                collect_tokens(ast, *arg_id, tokens);
            }
        }

        NodeKind::Pipe(children) => {
            for child_id in children.items.iter() {
                if matches!(&ast.nodes.get(*child_id).kind, NodeKind::Ident(_)) {
                    emit_token(tokens, ast, *child_id, TOKEN_FUNCTION, 0);
                }
                collect_tokens(ast, *child_id, tokens);
            }
        }

        NodeKind::LitRec { items, .. } => {
            for child_id in items.items.iter() {
                let child = ast.nodes.get(*child_id);
                if let NodeKind::Arm { lhs, body, .. } = &child.kind {
                    let lhs_node = ast.nodes.get(*lhs);
                    if matches!(&lhs_node.kind, NodeKind::Ident(_)) {
                        if body.items.is_empty() {
                            emit_token(tokens, ast, *lhs, TOKEN_VARIABLE, MOD_READONLY);
                        } else {
                            emit_token(tokens, ast, *lhs, TOKEN_PROPERTY, 0);
                        }
                    }
                    for stmt_id in body.items.iter() {
                        collect_tokens(ast, *stmt_id, tokens);
                    }
                } else {
                    collect_tokens(ast, *child_id, tokens);
                }
            }
        }

        NodeKind::Module { exprs, .. } => {
            for child_id in exprs.items.iter() {
                collect_tokens(ast, *child_id, tokens);
            }
        }

        NodeKind::LitSeq { items, .. } | NodeKind::Patterns(items) => {
            for child_id in items.items.iter() {
                collect_tokens(ast, *child_id, tokens);
            }
        }

        NodeKind::StrTempl { children, .. } | NodeKind::StrRawTempl { children, .. } => {
            for child_id in children.iter() {
                collect_tokens(ast, *child_id, tokens);
            }
        }

        NodeKind::InfixOp { lhs, rhs, .. }
        | NodeKind::Bind { lhs, rhs, .. }
        | NodeKind::BindRight { lhs, rhs, .. }
        | NodeKind::Member { lhs, rhs, .. } => {
            collect_tokens(ast, *lhs, tokens);
            collect_tokens(ast, *rhs, tokens);
        }

        NodeKind::UnaryOp { operand, .. } | NodeKind::Try(operand) => {
            collect_tokens(ast, *operand, tokens);
        }

        NodeKind::PostfixOp { lhs, .. } => {
            collect_tokens(ast, *lhs, tokens);
        }

        NodeKind::Group { inner, .. } => {
            collect_tokens(ast, *inner, tokens);
        }

        NodeKind::Spread { inner: Some(inner), .. } => {
            collect_tokens(ast, *inner, tokens);
        }

        NodeKind::Fn { params, body, .. } => {
            collect_tokens(ast, *params, tokens);
            for stmt_id in body.items.iter() {
                collect_tokens(ast, *stmt_id, tokens);
            }
        }

        NodeKind::Match { subjects, arms, .. } => {
            for sid in subjects.items.iter() {
                collect_tokens(ast, *sid, tokens);
            }
            for aid in arms.items.iter() {
                collect_tokens(ast, *aid, tokens);
            }
        }

        NodeKind::Arm { lhs, body, .. } => {
            collect_tokens(ast, *lhs, tokens);
            for stmt_id in body.items.iter() {
                collect_tokens(ast, *stmt_id, tokens);
            }
        }

        NodeKind::Block { name, params, body, .. } => {
            if matches!(&ast.nodes.get(*name).kind, NodeKind::Ident(_)) {
                emit_token(tokens, ast, *name, TOKEN_BLOCK_NAME, 0);
            }
            collect_tokens(ast, *name, tokens);
            collect_tokens(ast, *params, tokens);
            for stmt_id in body.items.iter() {
                collect_tokens(ast, *stmt_id, tokens);
            }
        }

        NodeKind::ChainedCmp(parts) => {
            for part in parts.iter() {
                if let ast::CmpPart::Operand(child_id) = part {
                    collect_tokens(ast, *child_id, tokens);
                }
            }
        }

        // Leaves
        NodeKind::Ident(_)
        | NodeKind::LitBool(_)
        | NodeKind::LitInt(_)
        | NodeKind::LitFloat(_)
        | NodeKind::LitDecimal(_)
        | NodeKind::LitStr { .. }
        | NodeKind::Partial
        | NodeKind::Wildcard
        | NodeKind::SynthIdent(_)
        | NodeKind::Token(_)
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

// ---------------------------------------------------------------------------
// Pre-computed location data for cursor lookups
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Loc {
    line: u32,
    col: u32,
    end_line: u32,
    end_col: u32,
}

struct IdentEntry {
    loc: Loc,
    /// AstId.0 of this ident node — index into bind_ids / node_locs.
    ast_idx: u32,
}

// ---------------------------------------------------------------------------
// AST serialization
// ---------------------------------------------------------------------------

fn serialize_node(ast: &Ast<'_>, id: AstId) -> String {
    let node = ast.nodes.get(id);
    let nid = node.id.0;
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

    let children = serialize_children(ast, id);
    format!(
        r#"{{"id":{nid},"kind":"{kind}","label":"{label_escaped}","line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"children":[{children}]}}"#
    )
}

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
        PostfixOp { op, .. } => ("PostfixOp", op.src.to_string()),
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
        Block { sep, .. }  => ("Block",       sep.src.to_string()),
        Module { .. }      => ("Module",      String::new()),
        SynthIdent(n)      => ("SynthIdent",  format!("·$_{n}")),
        Token(s)           => ("Token",       s.to_string()),
    }
}

fn serialize_children(ast: &Ast<'_>, id: AstId) -> String {
    use ast::{CmpPart, NodeKind::*};
    let node = ast.nodes.get(id);
    let mut parts: Vec<String> = Vec::new();

    match &node.kind {
        LitBool(_) | LitInt(_) | LitFloat(_) | LitDecimal(_) | LitStr { .. }
        | Ident(_) | Partial | Wildcard | SynthIdent(_) | Token(_) => {}

        Module { exprs: items, .. } => {
            for child_id in items.items.iter() { parts.push(serialize_node(ast, *child_id)); }
        }
        LitSeq { items, .. } | LitRec { items, .. } | Pipe(items) | Patterns(items) => {
            for child_id in items.items.iter() { parts.push(serialize_node(ast, *child_id)); }
        }
        StrTempl { children, .. } | StrRawTempl { children, .. } => {
            for child_id in children.iter() { parts.push(serialize_node(ast, *child_id)); }
        }
        UnaryOp { operand, .. } | Try(operand) => {
            parts.push(serialize_node(ast, *operand));
        }
        PostfixOp { lhs, .. } => {
            parts.push(serialize_node(ast, *lhs));
        }
        InfixOp { lhs, rhs, .. }
        | Bind { lhs, rhs, .. }
        | BindRight { lhs, rhs, .. }
        | Member { lhs, rhs, .. } => {
            parts.push(serialize_node(ast, *lhs));
            parts.push(serialize_node(ast, *rhs));
        }
        ChainedCmp(cmp_parts) => {
            for p in cmp_parts.iter() {
                if let CmpPart::Operand(child_id) = p { parts.push(serialize_node(ast, *child_id)); }
            }
        }
        Spread { inner, .. } => {
            if let Some(child_id) = inner { parts.push(serialize_node(ast, *child_id)); }
        }
        Group { inner, .. } => { parts.push(serialize_node(ast, *inner)); }
        Apply { func, args } => {
            parts.push(serialize_node(ast, *func));
            for arg_id in args.items.iter() { parts.push(serialize_node(ast, *arg_id)); }
        }
        Fn { params, body, .. } => {
            parts.push(serialize_node(ast, *params));
            for stmt_id in body.items.iter() { parts.push(serialize_node(ast, *stmt_id)); }
        }
        Match { subjects, arms, .. } => {
            for sid in subjects.items.iter() { parts.push(serialize_node(ast, *sid)); }
            for aid in arms.items.iter() { parts.push(serialize_node(ast, *aid)); }
        }
        Arm { lhs, body, .. } => {
            parts.push(serialize_node(ast, *lhs));
            for stmt_id in body.items.iter() { parts.push(serialize_node(ast, *stmt_id)); }
        }
        Block { name, params, body, .. } => {
            parts.push(serialize_node(ast, *name));
            parts.push(serialize_node(ast, *params));
            for stmt_id in body.items.iter() { parts.push(serialize_node(ast, *stmt_id)); }
        }
    }

    parts.join(",")
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
     .replace('"', "\\\"")
     .replace('\n', "\\n")
     .replace('\r', "\\r")
     .replace('\t', "\\t")
}

/// Convert fink's native sourcemap to a flat JSON array of mapping records.
/// Each entry: `{"out":<wat-byte-offset>, "srcStart":<src-byte-offset>, "srcEnd":<src-byte-offset>}`.
/// Entries with no source origin (synthetic tokens) are omitted.
fn native_sourcemap_to_json(sm: &NativeSourceMap) -> String {
    let mut entries: Vec<String> = Vec::with_capacity(sm.mappings.len());
    for m in &sm.mappings {
        if let Some(src) = m.src {
            entries.push(format!(
                r#"{{"out":{},"srcStart":{},"srcEnd":{}}}"#,
                m.out, src.start, src.end
            ));
        }
    }
    format!("[{}]", entries.join(","))
}

// ---------------------------------------------------------------------------
// Compiler entry points
// ---------------------------------------------------------------------------

/// Compile Fink source → WASM binary bytes.
/// Throws a JS error with the diagnostic message on compilation failure.
#[wasm_bindgen]
pub fn compile(src: &str) -> Result<Vec<u8>, JsValue> {
    let wasm = fink::to_wasm_for(src, "playground.fnk", fink::passes::wasm::emit::Interop::Js)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(wasm.binary)
}

/// Compile Fink source → WAT text + sourcemap.
/// Returns JSON: `{"code": "...", "map": [...]}` where `code` is the WAT text
/// (no trailing sourcemap comment) and `map` is a flat array of native
/// sourcemap entries: `{out, srcStart, srcEnd}` (byte offsets).
/// Throws a JS error on compilation failure.
#[wasm_bindgen]
pub fn compile_wat(src: &str) -> Result<String, JsValue> {
    use fink::passes::modules::InMemorySourceLoader;
    use fink::passes::wasm::{compile_package, fmt as wasm_fmt};

    let path = std::path::Path::new("playground.fnk");
    let mut loader = InMemorySourceLoader::single("playground.fnk", src);
    let pkg = compile_package::compile_package(path, &mut loader)
        .map_err(|e| JsValue::from_str(&e))?;

    let (wat, srcmap) = wasm_fmt::fmt_fragment_with_sm(&pkg.fragment);
    let map_json = native_sourcemap_to_json(&srcmap);
    let code_escaped = escape_json(wat.trim_end());
    Ok(format!(r#"{{"code":"{code_escaped}","map":{map_json}}}"#))
}

// ---------------------------------------------------------------------------
// ParsedDocument — stateful parsed doc, parse once / query many
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct ParsedDocument {
    src: String,
    semantic_tokens: Vec<u32>,
    diagnostics: String,
    lexer_tokens: String,
    highlight_tokens: String,

    /// Source location for each AST node (indexed by AstId.0).
    node_locs: Vec<Option<Loc>>,

    /// For each AST node, the AstId of the binding it resolves to (or itself
    /// if it IS a binding site). None if unresolved or not an identifier.
    bind_ids: Vec<Option<u32>>,

    /// Identifier nodes sorted by position, for cursor hit-testing.
    idents: Vec<IdentEntry>,
}

#[wasm_bindgen]
impl ParsedDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(src: &str) -> ParsedDocument {
        let mut diag_entries: Vec<String> = Vec::new();
        let mut raw_token_entries: Vec<String> = Vec::new();
        let mut highlight_token_entries: Vec<String> = Vec::new();

        // --- Lex ---
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
            let src_escaped = escape_json(tok.src);
            let kind = format!("{:?}", tok.kind);

            raw_token_entries.push(format!(
                r#"{{"kind":"{kind}","src":"{src_escaped}","line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col}}}"#
            ));

            if tok.kind == TokenKind::StrText {
                let segments = split_str_escapes(tok.src);
                for seg in &segments {
                    let seg_col = col + seg.col_offset;
                    let seg_end_col = seg_col + seg.src.len() as u32;
                    let seg_src_escaped = escape_json(seg.src);
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
        let ast = match parser::parse(src, "playground.fnk") {
            Ok(a) => a,
            Err(e) => {
                let line = e.loc.start.line.saturating_sub(1);
                let col = e.loc.start.col;
                let end_line = e.loc.end.line.saturating_sub(1);
                let end_col = e.loc.end.col;
                let msg = escape_json(&e.message);
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
        collect_tokens(&ast, ast.root, &mut raw_tokens);
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

    /// Run desugar + scope analysis. Populates definition/reference data.
    /// Called separately so a panic in analysis doesn't take down the
    /// already-computed lexer/parser/highlight results.
    pub fn run_analysis(&mut self) {
        let parsed = match parser::parse(&self.src, "playground.fnk") {
            Ok(a) => a,
            Err(_) => return,
        };

        let ast = match fink::passes::partial::apply(parsed) {
            Ok(a) => a,
            Err(_) => return,
        };
        let scope_result = scopes::analyse(&ast, &[]);

        let node_count = ast.nodes.len();
        let mut node_locs: Vec<Option<Loc>> = vec![None; node_count];
        let mut bind_ids: Vec<Option<u32>> = vec![None; node_count];
        let mut idents: Vec<IdentEntry> = Vec::new();
        let mut diag_entries: Vec<String> = Vec::new();

        // Build node_locs for all AST nodes.
        for i in 0..node_count {
            let node = ast.nodes.get(AstId(i as u32));
            node_locs[i] = Some(Loc {
                line: node.loc.start.line.saturating_sub(1),
                col: node.loc.start.col,
                end_line: node.loc.end.line.saturating_sub(1),
                end_col: node.loc.end.col,
            });
        }

        let mut used_binds: HashSet<u32> = HashSet::new();

        // Walk scope events for refs (resolved + unresolved) and binding sites.
        for scope_idx in 0..scope_result.scopes.len() {
            let scope_id = scopes::ScopeId(scope_idx as u32);
            for event in scope_result.scope_events.get(scope_id) {
                match event {
                    ScopeEvent::Ref(ref_info) => {
                        let ref_ast_id = ref_info.ast_id;

                        if ref_info.kind == RefKind::Unresolved {
                            let node = ast.nodes.get(ref_ast_id);
                            let line = node.loc.start.line.saturating_sub(1);
                            let col = node.loc.start.col;
                            let end_line = node.loc.end.line.saturating_sub(1);
                            let end_col = node.loc.end.col;
                            let name = match &node.kind {
                                NodeKind::Ident(s) => escape_json(s),
                                _ => "?".to_string(),
                            };
                            diag_entries.push(format!(
                                r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unresolved name '{name}'","source":"scopes","severity":"error"}}"#
                            ));
                        } else {
                            let bind_info = scope_result.binds.get(ref_info.bind_id);
                            if let BindOrigin::Ast(bind_ast_id) = bind_info.origin {
                                bind_ids[ref_ast_id.0 as usize] = Some(bind_ast_id.0);
                                used_binds.insert(ref_info.bind_id.0);
                                bind_ids[bind_ast_id.0 as usize] = Some(bind_ast_id.0);
                            }
                        }

                        if let Some(loc) = node_locs[ref_ast_id.0 as usize] {
                            idents.push(IdentEntry { loc, ast_idx: ref_ast_id.0 });
                        }
                    }
                    ScopeEvent::Bind(bind_id) => {
                        let bind_info = scope_result.binds.get(*bind_id);
                        if let BindOrigin::Ast(bind_ast_id) = bind_info.origin {
                            bind_ids[bind_ast_id.0 as usize] = Some(bind_ast_id.0);
                            if let Some(loc) = node_locs[bind_ast_id.0 as usize] {
                                idents.push(IdentEntry { loc, ast_idx: bind_ast_id.0 });
                            }
                        }
                    }
                    ScopeEvent::ChildScope(_) => {}
                }
            }
        }

        // Unused-binding warnings — skip module-level (exports) and builtins.
        for bind_idx in 0..scope_result.binds.len() {
            let bind_id = BindId(bind_idx as u32);
            if used_binds.contains(&(bind_idx as u32)) { continue; }

            let bind_info = scope_result.binds.get(bind_id);

            let bind_ast_id = match bind_info.origin {
                BindOrigin::Ast(ast_id) => ast_id,
                BindOrigin::Builtin(_) => continue,
            };

            let node = ast.nodes.get(bind_ast_id);
            if !matches!(&node.kind, NodeKind::Ident(_)) { continue; }

            let scope_info = scope_result.scopes.get(bind_info.scope);
            if scope_info.kind == ScopeKind::Module { continue; }

            let line = node.loc.start.line.saturating_sub(1);
            let col = node.loc.start.col;
            let end_line = node.loc.end.line.saturating_sub(1);
            let end_col = node.loc.end.col;
            let name = match &node.kind {
                NodeKind::Ident(s) => escape_json(s),
                _ => continue,
            };
            diag_entries.push(format!(
                r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unused binding '{name}'","source":"scopes","severity":"warning"}}"#
            ));
        }

        idents.sort_by(|a, b| a.loc.line.cmp(&b.loc.line).then(a.loc.col.cmp(&b.loc.col)));

        self.node_locs = node_locs;
        self.bind_ids = bind_ids;
        self.idents = idents;

        if !diag_entries.is_empty() {
            let existing = &self.diagnostics;
            if existing == "[]" {
                self.diagnostics = format!("[{}]", diag_entries.join(","));
            } else {
                let base = &existing[..existing.len() - 1];
                self.diagnostics = format!("{},{}]", base, diag_entries.join(","));
            }
        }
    }

    pub fn get_tokens(&self) -> String { self.lexer_tokens.clone() }
    pub fn get_highlight_tokens(&self) -> String { self.highlight_tokens.clone() }
    pub fn get_semantic_tokens(&self) -> Vec<u32> { self.semantic_tokens.clone() }
    pub fn get_diagnostics(&self) -> String { self.diagnostics.clone() }

    pub fn get_definition(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_idx) = self.find_bind_at(line, col) else { return vec![] };
        let Some(loc) = self.node_locs[bind_idx as usize] else { return vec![] };
        vec![loc.line, loc.col, loc.end_line, loc.end_col]
    }

    pub fn get_references(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_idx) = self.find_bind_at(line, col) else { return vec![] };

        let mut locs = Vec::new();

        if let Some(loc) = self.node_locs[bind_idx as usize] {
            locs.push(loc.line);
            locs.push(loc.col);
            locs.push(loc.end_line);
            locs.push(loc.end_col);
        }

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
    /// Returns `null` if the source fails to parse.
    pub fn get_ast(&self) -> String {
        let ast = match parser::parse(&self.src, "playground.fnk") {
            Ok(a) => a,
            Err(_) => return "null".to_string(),
        };
        serialize_node(&ast, ast.root)
    }

    /// CPS pretty-printed source + native sourcemap.
    /// Returns `{"code": "...", "map": [...]}` — `map` is a flat array of
    /// `{out, srcStart, srcEnd}` byte-range entries.
    pub fn get_cps(&self) -> String {
        let (cps, desugared) = match fink::to_cps(&self.src, "playground.fnk") {
            Ok(r) => r,
            Err(_) => return r#"{"code":"","map":[]}"#.to_string(),
        };
        let ctx = cps_fmt::Ctx {
            origin: &cps.result.origin,
            ast: &desugared.ast,
            captures: None,
            param_info: Some(&cps.result.param_info),
            bind_kinds: None,
        };
        let (code, map) = cps_fmt::fmt_with_mapped_native(&cps.result.root, &ctx);
        let code_escaped = escape_json(&code);
        let map_json = native_sourcemap_to_json(&map);
        format!(r#"{{"code":"{code_escaped}","map":{map_json}}}"#)
    }

    /// Lifted CPS pretty-printed in flat form (one assignment per statement)
    /// + native sourcemap. Same envelope shape as get_cps.
    pub fn get_cps_lifted(&self) -> String {
        let (lifted, desugared) = match fink::to_lifted(&self.src, "playground.fnk") {
            Ok(r) => r,
            Err(_) => return r#"{"code":"","map":[]}"#.to_string(),
        };
        let ctx = cps_fmt::Ctx {
            origin: &lifted.result.origin,
            ast: &desugared.ast,
            captures: None,
            param_info: Some(&lifted.result.param_info),
            bind_kinds: None,
        };
        let (code, map) = fink::passes::lifting::fmt::fmt_flat_mapped_native(&lifted.result.root, &ctx);
        let code_escaped = escape_json(&code);
        let map_json = native_sourcemap_to_json(&map);
        format!(r#"{{"code":"{code_escaped}","map":{map_json}}}"#)
    }
}

impl ParsedDocument {
    fn find_bind_at(&self, line: u32, col: u32) -> Option<u32> {
        for entry in &self.idents {
            if entry.loc.line == line && entry.loc.col <= col && col < entry.loc.end_col {
                return self.bind_ids[entry.ast_idx as usize];
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
        let segs = split_str_escapes(r"\b");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\b", col_offset: 0 },
        ]);
    }

    #[test]
    fn binary_escape() {
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
        let segs = split_str_escapes(r"\b2");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\b", col_offset: 0 },
            StrSegment { kind: "StrText", src: "2", col_offset: 2 },
        ]);
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
        let segs = split_str_escapes(r"\x1");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: r"\x", col_offset: 0 },
            StrSegment { kind: "StrText", src: "1", col_offset: 2 },
        ]);
    }

    #[test]
    fn unicode_bare() {
        let segs = split_str_escapes("\\u0041");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: "\\u0041", col_offset: 0 },
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
        let segs = split_str_escapes("\\u10FFFF");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: "\\u10FFFF", col_offset: 0 },
        ]);
    }

    #[test]
    fn unicode_bare_with_trailing() {
        let segs = split_str_escapes("\\u10FFFFhello");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrEscape", src: "\\u10FFFF", col_offset: 0 },
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
        let segs = split_str_escapes("hello\\");
        assert_eq!(segs, vec![
            StrSegment { kind: "StrText", src: "hello\\", col_offset: 0 },
        ]);
    }

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
